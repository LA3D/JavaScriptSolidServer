import { admit, urlToStoragePath } from './admission.js';
import { captureDeclaredTypes, typeStorePath, writeProvenance } from './type-metadata.js';
import { writeTypeConsistency } from './write-consistency.js';
import { subjectTypesFromBody } from './subject-types.js';
import { conformsToTargets } from './constraint.js';
import { AUX_SUFFIX } from '../storage/filesystem.js';
import { auxSubject, AUX_SUFFIX_RE } from '../utils/url.js';
import { checkAccess as defaultCheckAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';

function refuse(instance, detail) {
  return { ok: false, problem: { status: 403, title: 'Sidecar write requires authorization', detail, instance } };
}

/**
 * Shared LWS write pipeline: name/type gate → SHACL admission → storage.write
 * → type-capture. Request-agnostic so both the HTTP handlers and the MCP
 * write tools use ONE enforcement path (the drift that let MCP bypass both
 * the gate and admission becomes impossible — review #2/#10).
 * Callers own their own reply/tool framing; this returns data only.
 */
export async function applyLwsWrite({
  storage, storagePath, resourceUrl, content, contentType, declaredTypes = [], lwsEnabled,
  agentWebId = null, internal = false, checkAccessFn = defaultCheckAccess,
}) {
  // SIDECAR AUTHZ GUARD (2026-07-21). Every write surface funnels through here, which is why
  // it is the right place: three separate surfaces (HTTP POST+Slug, MCP create_resource, MCP
  // write_resource) each reached storage.write for an `.acl` with only container Append/Write.
  // Deliberately NOT --lws-gated: an auth check that only fires under --lws is worthless, and
  // upstream's own b9b38ed is unconditional. Fails closed — no WebID and not internal = deny.
  // auxSubject() normalizes exactly as urlToPath does before classifying, so a
  // `victim.acl/` or `victim.acl%2F` argument is seen as the sidecar the storage
  // layer will actually resolve it to (Task 7a round 2). It covers all four
  // suffixes including `.acl` — unlike sidecarSubject(), which deliberately
  // omits `.acl` because HTTP resolves ACL authorization separately
  // (authorizeAclAccess, src/auth/middleware.js).
  const sc = internal ? null : auxSubject(storagePath);
  if (sc) {
    // .acl always needs Control. .meta needs Control to CREATE (the escalation: wac() falls
    // back to the parent container for non-existent targets) but only Write to UPDATE a
    // subject whose ACL you already satisfy. `.lwstypes`/`.lwsprov` are refused downstream
    // by writeTypeConsistency (405, System-Managed) and never reach a mode decision here.
    const isMeta = sc.kind === 'meta';
    const exists = await storage.exists(sc.path);
    const mode = (!isMeta || !exists) ? AccessMode.CONTROL : AccessMode.WRITE;
    if (!agentWebId) return refuse(resourceUrl, `${mode} required on ${sc.subject} (no authenticated agent)`);
    // The subject URL is rebuilt from the NORMALIZED subject path rather than by
    // stripping a suffix off resourceUrl — resourceUrl still carries the caller's
    // un-normalized argument, and the URL and the path must not disagree about
    // which resource is being authorized.
    let subjectUrl;
    try { subjectUrl = new URL(resourceUrl).origin + sc.subject; }
    catch { subjectUrl = resourceUrl.replace(AUX_SUFFIX_RE, ''); }
    const { allowed } = await checkAccessFn({
      resourceUrl: subjectUrl,
      resourcePath: sc.subject,
      isContainer: sc.isContainer,
      agentWebId,
      requiredMode: mode,
      // Secondary/guard check: this choke-point sidecar gate is a precondition
      // layered on the real write, which is authorized separately. noDebit keeps
      // a payment-conditioned Control grant from being charged here (a double
      // debit) — the authoritative debit stays on the primary path. Inert until
      // a PaymentCondition + ledger exist, but correct by construction.
      noDebit: true,
      lwsEnabled,
    });
    if (!allowed) return refuse(resourceUrl, `${mode} required on ${sc.subject}`);
  }

  // #2 (review 2026-07-12): the gate runs at THE choke point every write
  // surface shares (HTTP PUT/POST + all MCP write tools) — no surface can
  // store a name/type lie or an admission-skipped body at an RDF name.
  const c = writeTypeConsistency({ urlPath: storagePath, submittedType: contentType, lwsEnabled });
  if (!c.ok) return { ok: false, problem: { ...c.problem, instance: resourceUrl } };

  let shapeUrl = null;
  let advisories = [];
  let containerMetaPath = null;
  let decision = null;

  if (lwsEnabled) {
    const targetMetaPath = storagePath + '.meta';
    containerMetaPath = storagePath.slice(0, storagePath.lastIndexOf('/') + 1) + '.meta';
    const result = await admit({
      storage, content, contentType, resourceUrl,
      targetMetaPath, containerMetaPath, shapeUrlToPath: urlToStoragePath,
    });
    if (result.decision === 'reject') {
      return { ok: false, shapeUrl: result.shapeUrl, violations: result.violations };
    }
    decision = result.decision;
    shapeUrl = result.shapeUrl || null;
    advisories = result.advisories || [];
  }

  const wrote = await storage.write(storagePath, content);

  // Auxiliary writes (.acl/.meta/.lwstypes/.lwsprov) never get type-capture or
  // conformsTo provenance — an ACL body has its own typed acl:Authorization
  // subject, and sidecar-of-a-sidecar (x.jsonld.acl.lwstypes) is what leaked
  // into container listings (post-referent-round regression, fixed 2026-07-13).
  if (lwsEnabled && wrote && !AUX_SUFFIX.test(storagePath)) {
    // Referent identity & discovery (2026-07-13): union the body's primary
    // referent rdf:type with the client-declared (Link rel=type) types —
    // enrich, never replace (lws10-searchindex content-derivation ¶2). The
    // else->remove branch now clears the sidecar only when BOTH sets are
    // empty, so a body-only @type with no rel=type header still persists.
    const bodyTypes = await subjectTypesFromBody(content, contentType, resourceUrl);
    const enriched = [...new Set([...declaredTypes, ...bodyTypes])];
    if (enriched.length) await captureDeclaredTypes(storage, storagePath, enriched);
    else await storage.remove(typeStorePath(storagePath));

    // Earned conformsTo provenance (Task 2, 2026-07-13): "earned" means a
    // profile that actually VALIDATED this member — decision === 'admit'
    // (SHACL ran and passed), not merely != 'reject'. 'pass' (non-RDF body,
    // or a container with conformsTo but no resolvable describedby shape —
    // an opt-in miss) never ran SHACL, so it has nothing to earn. Stamp the
    // member with the profile its CONTAINER declares (dct:conformsTo on the
    // container's .meta) — System-Managed provenance, distinct from a
    // resource's own client-managed `.meta` dct:conformsTo (declared binding
    // intent). The up-walk stays the discovery contract; this is provenance
    // only, and best-effort: a read/write hiccup here must never fail a
    // write that already succeeded.
    if (decision === 'admit') {
      try {
        const containerConformsTo = await conformsToTargets(storage, containerMetaPath, resourceUrl);
        if (containerConformsTo.length) {
          await writeProvenance(storage, storagePath, { conformsTo: containerConformsTo });
        }
      } catch { /* provenance is additive; never block the write */ }
    }
  }

  return { ok: true, wrote, shapeUrl, advisories };
}

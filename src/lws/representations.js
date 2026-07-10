// src/lws/representations.js
// Reads a resource's alternate-representation declarations (DX-PROF-CONNEG
// altr: model) from its client-managed .meta. Opaque: no profile-hierarchy
// resolution (P13) — conformsTo/format are surfaced verbatim. [] when .meta
// is missing/unreadable, mirroring src/lws/constraint.js.
import { toDataset } from '../rdf/dataset.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import { urlToStoragePath } from './admission.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const HAS_DEFAULT = ALTR + 'hasDefaultRepresentation';
const HAS_REP = ALTR + 'hasRepresentation';
const DCT_FORMAT = 'http://purl.org/dc/terms/format';
const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';

function repFrom(ds, repTerm, baseIri) {
  // @id-less rep nodes are dropped upstream by jsonLdToQuads (n3 bridge, src/rdf/turtle.js); reps arrive as NamedNodes in practice — baseIri is a defensive fallback.
  const href = repTerm.termType === 'NamedNode' ? repTerm.value : baseIri;
  let format = null, profile = null;
  for (const q of ds) {
    if (q.subject.value !== repTerm.value) continue;
    if (q.predicate.value === DCT_FORMAT) format = q.object.value;
    else if (q.predicate.value === DCT_CONFORMS) profile = q.object.value;
  }
  return { href, format, profile };
}

export async function readRepresentations(storage, metaPath, baseIri) {
  const empty = { default: null, alternates: [] };
  if (!(await storage.exists(metaPath))) return empty;
  let buf;
  try { buf = await storage.read(metaPath); } catch { return empty; }
  let ds;
  try { ds = await toDataset(buf, 'application/ld+json', baseIri); } catch { return empty; }
  let def = null;
  const alternates = [];
  for (const q of ds) {
    if (q.predicate.value === HAS_DEFAULT) def = repFrom(ds, q.object, baseIri);
    else if (q.predicate.value === HAS_REP) alternates.push(repFrom(ds, q.object, baseIri));
  }
  return { default: def, alternates };
}

// No-oracle authz filter (LWS discipline — mirrors the Type Index's
// checkAccess()-then-drop in src/handlers/type-index.js /
// src/lws/authorized-resources.js): an alternate the requesting client
// can't READ must be invisible — dropped from the linkset AND from the
// set negotiateProfile searches, so Accept-Profile for it 404s the same
// way as an unknown profile (406), never revealing it exists.
//
// Off-origin alternates (href on a different scheme+host than the current
// request) are dropped outright — this pod holds no ACL for another
// origin's resource and can't vouch for it either way.
//
// Same-origin hrefs are resolved to a storage path via
// `urlToStoragePath` (src/lws/admission.js) — the same "path-mode:
// pathname === storagePath" mapping already used to resolve SHACL shape
// URLs to disk paths; not reinvented here.
//
// `public` mirrors `request.config.public` (--public server mode): that
// flag makes the blanket preHandler skip WAC for every resource — the
// deployment is declaring "no ACL enforcement, fully public pod." Running
// this filter's real checkAccess() against such a pod would deny alternates
// that were never given a resource ACL (checkAccess denies-by-default with
// none found) even though the server treats every other read as open,
// which is a false negative, not a security boundary — so `public: true`
// short-circuits to "every same-origin alternate is visible," matching how
// the rest of the server behaves in that mode. Off-origin dropping still
// applies unconditionally: it isn't about this pod's own public/private
// stance, it's "this pod holds no ACL for that origin at all."
export async function filterReadableAlternates(alternates, { origin, agentWebId, public: isPublic = false }) {
  if (!alternates.length) return alternates;
  const aclCache = new Map();
  const out = [];
  for (const rep of alternates) {
    let u;
    try { u = new URL(rep.href); } catch { continue; } // unparseable href → drop
    if (u.origin !== origin) continue; // off-origin → can't vouch for its ACLs
    if (isPublic) { out.push(rep); continue; }
    // NOTE: urlToStoragePath is path-mode only (bare URL.pathname); under --subdomains it omits the pod-name prefix (carried-forward gap shared with SHACL admission, src/lws/admission.js). This pod runs path-mode; guard/fix before enabling --subdomains with conneg.
    const resourcePath = urlToStoragePath(rep.href);
    const isContainer = resourcePath.endsWith('/');
    const { allowed } = await checkAccess({
      resourceUrl: rep.href, resourcePath, isContainer,
      agentWebId, requiredMode: AccessMode.READ, aclCache,
    });
    if (!allowed) continue;
    out.push(rep);
  }
  return out;
}

// readRepresentations + filterReadableAlternates in one call — the shape
// every advertise/negotiate site actually wants. The default (self)
// representation is NEVER filtered: the client is already reading this
// resource (they got here via the current request's own authorization),
// so its own default rep is always visible.
export async function readAuthorizedRepresentations(storage, metaPath, baseIri, { origin, agentWebId, public: isPublic = false }) {
  const reps = await readRepresentations(storage, metaPath, baseIri);
  if (!reps.alternates.length) return reps;
  return {
    default: reps.default,
    alternates: await filterReadableAlternates(reps.alternates, { origin, agentWebId, public: isPublic }),
  };
}

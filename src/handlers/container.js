import * as storage from '../storage/filesystem.js';
import { initializeQuota, checkQuota, updateQuotaUsage } from '../storage/quota.js';
import { getAllHeaders } from '../ldp/headers.js';
import { isContainer, getEffectiveUrlPath, getPodName, isBodiedWithoutContentType, missingContentTypeProblem } from '../utils/url.js';
import { generateProfile, generatePreferences, generateTypeIndex, serialize } from '../webid/profile.js';
import { generateOwnerAcl, generatePrivateAcl, generateInboxAcl, generatePublicFolderAcl, serializeAcl, relativizeOwnerWebId } from '../wac/parser.js';
import { provisionOwnerKey, assertProvisionKeysCompatible } from '../keys/provision.js';
import { createToken } from '../auth/token.js';
import { canAcceptInput, toJsonLd, RDF_TYPES } from '../rdf/conneg.js';
import { emitChange } from '../notifications/events.js';
import { constraintProblem } from '../lws/admission.js';
import { parseTypeLinks, captureDeclaredTypes, LWS_STORAGE } from '../lws/type-metadata.js';
import { applyLwsWrite } from '../lws/write.js';
import { extensionForRdfType } from '../lws/write-consistency.js';

/**
 * Get the storage path and resource URL for a request
 * In subdomain mode, storage path includes pod name, URL uses subdomain
 */
function getRequestPaths(request) {
  const urlPath = request.url.split('?')[0];
  // Storage path - includes pod name in subdomain mode
  const storagePath = getEffectiveUrlPath(request);
  // Resource URL - uses the actual request hostname (subdomain in subdomain mode)
  const resourceUrl = `${request.protocol}://${request.hostname}${urlPath}`;
  return { urlPath, storagePath, resourceUrl };
}

/**
 * Handle POST request to container (create new resource)
 */
export async function handlePost(request, reply) {
  // Read-only mode - block all writes
  if (request.config?.readOnly) {
    return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' });
  }

  const { urlPath, storagePath } = getRequestPaths(request);

  // P2 (Solid #server-content-type-missing MUST): a bodied write with no
  // Content-Type must 400, not silently fall through to canAcceptInput('').
  // (The target resource URL isn't assigned yet at POST time — the
  // container URL is the closest "instance" available.)
  if (request.lwsEnabled && isBodiedWithoutContentType(request)) {
    const containerUrl = `${request.protocol}://${request.hostname}${urlPath}`;
    return reply.code(400).type('application/problem+json')
      .send(JSON.stringify(missingContentTypeProblem(containerUrl), null, 2));
  }

  // Ensure target is a container
  if (!isContainer(urlPath)) {
    return reply.code(405).send({ error: 'POST only allowed on containers' });
  }

  const connegEnabled = request.connegEnabled || false;
  // Spec §4a: --lws mandates the negotiation surface; conneg is implied by it.
  const negotiate = connegEnabled || request.lwsEnabled;
  const contentType = request.headers['content-type'] || '';

  // Check if we can accept this input type
  if (!canAcceptInput(contentType, negotiate)) {
    const acceptValue = connegEnabled
      ? 'application/ld+json, application/json, text/turtle, text/n3'
      : 'application/ld+json, application/json';
    reply.header('Accept', acceptValue);
    reply.header('Accept-Post', acceptValue);
    return reply.code(415).send({
      error: 'Unsupported Media Type',
      message: connegEnabled
        ? 'Supported types: application/ld+json, application/json, text/turtle, text/n3'
        : 'Supported types: application/ld+json, application/json (enable conneg for Turtle/N3 support)'
    });
  }

  // Check container exists
  const stats = await storage.stat(storagePath);
  if (!stats || !stats.isDirectory) {
    // Create container if it doesn't exist
    await storage.createContainer(storagePath);
  }

  // Get slug from header or generate UUID
  const slug = request.headers.slug;
  const linkHeader = request.headers.link || '';

  // Security: validate Slug header
  if (slug) {
    // Maximum length check
    if (slug.length > 255) {
      return reply.code(400).send({ error: 'Slug header too long (max 255 characters)' });
    }
    // Character validation - allow alphanumeric, dots, dashes, underscores
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      return reply.code(400).send({ error: 'Invalid Slug format. Use only alphanumeric characters, dots, dashes, and underscores.' });
    }
  }

  // Check if creating a container (Link header contains ldp:Container or ldp:BasicContainer)
  const isCreatingContainer = linkHeader.includes('Container') || linkHeader.includes('BasicContainer');

  // Generate unique filename. #9: a slug-less RDF create derives its extension
  // from the submitted type so the server's own name never trips the write-
  // consistency gate (a name it assigned itself, extensionless, otherwise 400s).
  const defaultExt = (request.lwsEnabled && !isCreatingContainer)
    ? extensionForRdfType(contentType) : '';
  const filename = await storage.generateUniqueFilename(storagePath, slug, isCreatingContainer, defaultExt);
  const newUrlPath = urlPath + filename + (isCreatingContainer ? '/' : '');
  const newStoragePath = storagePath + filename + (isCreatingContainer ? '/' : '');
  const resourceUrl = `${request.protocol}://${request.hostname}${newUrlPath}`;

  let success;
  if (isCreatingContainer) {
    success = await storage.createContainer(newStoragePath);
  } else {
    // Get content from request body
    let content = request.body;
    if (Buffer.isBuffer(content)) {
      // Already a buffer
    } else if (typeof content === 'string') {
      content = Buffer.from(content);
    } else if (content && typeof content === 'object') {
      content = Buffer.from(JSON.stringify(content));
    } else {
      content = Buffer.from('');
    }

    // Spec §2: under --lws, store the submitted bytes verbatim; the name/type
    // gate now runs inside applyLwsWrite (review #2 — the choke point every
    // write surface shares) against storagePath, which is the FINAL resource
    // name (container path + slug) — not here.
    // --lws-off keeps the byte-identical legacy Turtle/N3→JSON-LD conversion.
    const inputType = contentType.split(';')[0].trim().toLowerCase();
    if (!request.lwsEnabled && connegEnabled && (inputType === RDF_TYPES.TURTLE || inputType === RDF_TYPES.N3)) {
      try {
        const jsonLd = await toJsonLd(content, contentType, resourceUrl, connegEnabled, { graphEnvelope: false });
        content = Buffer.from(JSON.stringify(jsonLd, null, 2));
      } catch (e) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid Turtle/N3 format: ' + e.message
        });
      }
    }

    // Check storage quota before writing (skip in public mode - no pod structure)
    const podName = request.config?.public ? null : getPodName(request);
    if (podName) {
      const { allowed, error } = await checkQuota(podName, content.length, request.defaultQuota || 0);
      if (!allowed) {
        return reply.code(507).send({ error: 'Insufficient Storage', message: error });
      }
    }

    // L3 admission + write + type-capture via the shared LWS core (--lws-gated
    // inside). New member has no own .meta yet; resolveShapeUrl falls through
    // to the container rule.
    const postContentType = (!request.lwsEnabled && connegEnabled && (inputType === RDF_TYPES.TURTLE || inputType === RDF_TYPES.N3))
      ? RDF_TYPES.JSON_LD : (request.headers['content-type'] || '');
    const declared = request.lwsEnabled ? parseTypeLinks(linkHeader) : [];
    const w = await applyLwsWrite({
      storage, storagePath: newStoragePath, resourceUrl,
      content, contentType: postContentType,
      declaredTypes: isCreatingContainer ? [] : declared,
      lwsEnabled: request.lwsEnabled,
    });
    if (!w.ok) {
      if (w.problem) {
        const reply2 = reply.code(w.problem.status || 400).type('application/problem+json');
        if (w.problem.status === 405) reply2.header('Allow', 'GET, HEAD');
        return reply2.send(JSON.stringify(w.problem, null, 2));
      }
      reply.header('content-type', 'application/problem+json');
      if (w.shapeUrl) reply.header('Link', `<${w.shapeUrl}>; rel="describedby"`);
      return reply.code(400).send(constraintProblem({
        shapeUrl: w.shapeUrl, violations: w.violations, instance: resourceUrl,
      }));
    }
    success = w.wrote;
    if (w.shapeUrl) request.__lwsShapeUrl = w.shapeUrl;
    if (w.advisories.length) request.__lwsAdvisories = w.advisories;

    // Update quota usage after successful write
    if (success && podName) {
      await updateQuotaUsage(podName, content.length);
    }
  }

  if (!success) {
    return reply.code(500).send({ error: 'Create failed' });
  }

  const origin = request.headers.origin;

  const headers = getAllHeaders({
    isContainer: isCreatingContainer,
    origin,
    connegEnabled,
    mashlibEnabled: request.mashlibEnabled
  });
  headers['Location'] = resourceUrl;

  // Append describedby Link when admission resolved a shape (--lws, success path).
  if (request.__lwsShapeUrl) {
    const shapeLink = `<${request.__lwsShapeUrl}>; rel="describedby"`;
    headers['Link'] = headers['Link'] ? `${headers['Link']}, ${shapeLink}` : shapeLink;
  }

  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  // Emit change notification for WebSocket subscribers
  if (request.notificationsEnabled) {
    emitChange(resourceUrl);
  }

  // RFC 9111 obsoletes Warning header → advisories ride the success body.
  if (request.__lwsAdvisories) {
    return reply.code(201).send({ advisories: request.__lwsAdvisories });
  }
  return reply.code(201).send();
}

/**
 * Create pod directory structure (reusable for registration)
 * @param {string} name - Pod name (username)
 * @param {string} webId - User's WebID URI
 * @param {string} podUri - Pod root URI (e.g., https://alice.example.com/ or https://example.com/alice/)
 * @param {string} issuer - OIDC issuer URI
 * @param {number} defaultQuota - Default storage quota in bytes (optional)
 * @param {object} [options]
 * @param {boolean} [options.provisionKeys=false] - When true, generate a
 *   Schnorr secp256k1 keypair and write it to `<pod>/private/privkey.jsonld`
 *   in W3C CID v1.0 Multikey format. Phase 1 of #437. The secret lands on
 *   disk in plaintext under owner-only WAC + file mode 0600 — operators
 *   should add filesystem-level protection (FDE / OS keyring) for any pod
 *   that matters.
 * @param {'public'|'private'} [options.visibility='public'] - Per-storage
 *   provisioning visibility (multi-tenant #A9). 'private' omits the
 *   `#public` Read authorization from the pod ROOT .acl only — the
 *   inbox/public/private/settings/profile children keep their existing
 *   ACLs unchanged. Default 'public' is byte-identical to prior behavior.
 * @returns {Promise<{ podPath, podUri, ownerKey?: { document, publicHex, secretHex, publicMultibase } }>}
 *   When `provisionKeys` is true, the return value includes the freshly
 *   minted key material so the caller can surface the public side in CLI
 *   output (the secret should NOT be displayed or logged).
 */
export async function createPodStructure(name, webId, podUri, issuer, defaultQuota = 0, options = {}) {
  const podPath = `/${name}/`;
  const { visibility = 'public' } = options;

  // Create pod directory structure
  // Pod settings directory
  await storage.createContainer(podPath);
  await captureDeclaredTypes(storage, podPath, [LWS_STORAGE]);   // storage-root marker (multi-tenant)
  await storage.createContainer(`${podPath}inbox/`);
  await storage.createContainer(`${podPath}public/`);
  await storage.createContainer(`${podPath}private/`);
  await storage.createContainer(`${podPath}settings/`);
  await storage.createContainer(`${podPath}profile/`);

  // Optional: provision a Schnorr secp256k1 owner key. The keypair is
  // generated in memory up-front so its VM can be injected into the
  // WebID profile that gets written last. The on-disk persistence of
  // the secret is deferred to *after* the ACL tree is in place — see
  // the ordering block further below. Strict `=== true` (not just
  // truthy) so a misconfigured caller passing `'true'` / `1` / etc.
  // doesn't silently activate; matches handleCreatePod's HTTP-side
  // check on the body field.
  const ownerKey = options.provisionKeys === true
    ? provisionOwnerKey({ webId })
    : null;

  // Profile is written last (see the ACL/privkey block below). Skip
  // the write here; we'll do it after privkey lands on disk.

  // Generate and write preferences
  const prefs = generatePreferences({ webId, podUri });
  await storage.write(`${podPath}settings/prefs.jsonld`, serialize(prefs));

  // Generate and write type indexes
  const publicTypeIndex = generateTypeIndex(`${podUri}settings/publicTypeIndex.jsonld`, { listed: true });
  await storage.write(`${podPath}settings/publicTypeIndex.jsonld`, serialize(publicTypeIndex));

  const privateTypeIndex = generateTypeIndex(`${podUri}settings/privateTypeIndex.jsonld`, { listed: false });
  await storage.write(`${podPath}settings/privateTypeIndex.jsonld`, serialize(privateTypeIndex));

  // Create default ACL files. Each .acl is written inside the container it
  // protects, so `acl:accessTo` is always './' (resolved against the .acl's
  // own URL by the parser — see #428).
  //
  // The owner WebID is also written relatively (#430), derived from the
  // absolute `webId` and the .acl's location within the pod by
  // `relativizeOwnerWebId`. This works for any profile layout (modern
  // `profile/card.jsonld#me`, legacy `profile/card#me`, custom shapes) and
  // falls back to the absolute WebID for foreign owners. Together this
  // keeps the on-disk pod portable across hostnames.
  const owner = aclBase => relativizeOwnerWebId(webId, podUri, aclBase);

  const rootAcl = generateOwnerAcl('./', owner(''), true, { publicRead: visibility !== 'private' });
  await storage.write(`${podPath}.acl`, serializeAcl(rootAcl));

  const privateAcl = generatePrivateAcl('./', owner('private/'));
  await storage.write(`${podPath}private/.acl`, serializeAcl(privateAcl));

  const settingsAcl = generatePrivateAcl('./', owner('settings/'));
  await storage.write(`${podPath}settings/.acl`, serializeAcl(settingsAcl));

  // publicTypeIndex: public read, overrides the private default inherited
  // from /settings/. This is a resource ACL (lives at .../publicTypeIndex.jsonld.acl),
  // whose base URL is /settings/ — same depth as `settings/.acl` for the
  // owner reference.
  const publicTypeIndexAcl = generateOwnerAcl('./publicTypeIndex.jsonld', owner('settings/'), false);
  await storage.write(`${podPath}settings/publicTypeIndex.jsonld.acl`, serializeAcl(publicTypeIndexAcl));

  const inboxAcl = generateInboxAcl('./', owner('inbox/'));
  await storage.write(`${podPath}inbox/.acl`, serializeAcl(inboxAcl));

  const publicAcl = generatePublicFolderAcl('./', owner('public/'));
  await storage.write(`${podPath}public/.acl`, serializeAcl(publicAcl));

  // Profile documents must be publicly readable for WebID verification
  const profileAcl = generatePublicFolderAcl('./', owner('profile/'));
  await storage.write(`${podPath}profile/.acl`, serializeAcl(profileAcl));

  // Initialize storage quota if configured
  if (defaultQuota > 0) {
    await initializeQuota(name, defaultQuota);
  }

  // Owner-key persistence + profile write (when --provision-keys is on).
  // Order is load-bearing for two distinct concerns (#444 review):
  //
  //   1. WAC vacuum: write privkey *after* the ACL tree is in place so
  //      the secret file is born under owner-only WAC. Without this,
  //      there's a window where the file exists but no /private/.acl
  //      protects it; jss's deny-by-default since #f43ecdf would
  //      mitigate to 401, but defence-in-depth beats relying on a
  //      security default holding.
  //
  //   2. Orphan-VM: write privkey *before* the profile so a crash
  //      between the two leaves an orphan secret file (easy to delete)
  //      rather than an orphan VM in a published WebID profile that
  //      forever advertises an authentication method whose secret was
  //      never persisted.
  //
  // Combined: ACLs (above) → privkey (here) → profile (next).
  if (ownerKey) {
    const ok = await storage.write(
      `${podPath}private/privkey.jsonld`,
      JSON.stringify(ownerKey.document, null, 2),
      { mode: 0o600 }
    );
    if (!ok) {
      throw new Error(
        `Failed to write owner key file at ${podPath}private/privkey.jsonld`
      );
    }
  }

  // Generate and write WebID profile at /profile/card.jsonld. When an
  // owner key was provisioned, its VM lands in the profile so the
  // existing LWS-CID verifier (src/auth/lws-cid.js) can authenticate
  // JWTs signed with the matching secret. Profile is intentionally
  // written last — see ordering rationale above.
  const profile = generateProfile({ webId, name, podUri, issuer, ownerVm: ownerKey?.vm });
  await storage.write(`${podPath}profile/card.jsonld`, serialize(profile));

  // Spread `ownerKey` only when set so the field is genuinely absent
  // (not `null`) on the no-provisioning path — matches the existing
  // test expectation that `result.ownerKey === undefined` when the
  // flag was omitted.
  return { podPath, podUri, ...(ownerKey && { ownerKey }) };
}

/**
 * Create a pod (container) for a user
 * POST /.pods with { "name": "alice" }
 * With IdP enabled: { "name": "alice", "email": "alice@example.com", "password": "secret" }
 *
 * Creates the following structure:
 *   /{name}/
 *   /{name}/profile/card.jsonld          - WebID profile
 *   /{name}/inbox/                       - Notifications
 *   /{name}/public/                      - Public files
 *   /{name}/private/                     - Private files
 *   /{name}/settings/prefs.jsonld        - Preferences
 *   /{name}/settings/publicTypeIndex.jsonld
 *   /{name}/settings/privateTypeIndex.jsonld
 */
export async function handleCreatePod(request, reply) {
  // Read-only mode - block pod creation
  if (request.config?.readOnly) {
    return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' });
  }

  const { name, email, password, provisionKeys, visibility } = request.body || {};
  const idpEnabled = request.idpEnabled;

  if (!name || typeof name !== 'string') {
    return reply.code(400).send({ error: 'Pod name required' });
  }

  // If IdP is enabled, require email and password
  if (idpEnabled) {
    if (!email || typeof email !== 'string') {
      return reply.code(400).send({ error: 'Email required for account creation' });
    }
    if (!password) {
      return reply.code(400).send({ error: 'Password required' });
    }
  }

  // Validate pod name (alphanumeric, dash, underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return reply.code(400).send({ error: 'Invalid pod name. Use alphanumeric, dash, or underscore only.' });
  }

  // Refuse provisionKeys + --public: WAC would be bypassed, exposing the
  // freshly written secret to anyone. Use the same assertion helper as
  // createServer's startup-time check so the error message stays in
  // one place — converted to a 400 here because we're in an HTTP
  // request context, not the constructor.
  if (provisionKeys === true) {
    try {
      assertProvisionKeysCompatible({
        provisionKeys: true,
        isPublic: !!request.config?.public
      });
    } catch (err) {
      return reply.code(400).send({
        error: 'provisionKeys cannot be used in --public mode',
        message: err.message
      });
    }
  }

  const podPath = `/${name}/`;

  // Check if pod already exists
  if (await storage.exists(podPath)) {
    return reply.code(409).send({ error: 'Pod already exists' });
  }

  // Build URIs. WebID is the JSON-LD profile with an #me fragment.
  const subdomainsEnabled = request.subdomainsEnabled;
  const baseDomain = request.baseDomain;

  let baseUri, podUri, webId;
  if (subdomainsEnabled && baseDomain) {
    // Subdomain mode: alice.example.com/profile/card.jsonld#me
    const podHost = `${name}.${baseDomain}`;
    baseUri = `${request.protocol}://${baseDomain}`;
    podUri = `${request.protocol}://${podHost}/`;
    webId = `${podUri}profile/card.jsonld#me`;
  } else {
    // Path mode: example.com/alice/profile/card.jsonld#me
    baseUri = `${request.protocol}://${request.hostname}`;
    podUri = `${baseUri}${podPath}`;
    webId = `${podUri}profile/card.jsonld#me`;
  }

  // Issuer needs trailing slash for CTH compatibility
  const issuer = baseUri + '/';

  let podCreation;
  try {
    // Use shared pod creation function. Coerce provisionKeys to a
    // strict boolean so a JSON `null` / missing value defaults to off.
    // visibility: 'private' opts the pod ROOT ACL out of public read
    // (multi-tenant #A9); anything else (including absent) is 'public',
    // matching prior behavior.
    podCreation = await createPodStructure(
      name, webId, podUri, issuer, 0,
      { provisionKeys: provisionKeys === true, visibility: visibility === 'private' ? 'private' : 'public' }
    );
  } catch (err) {
    console.error('Pod creation error:', err);
    // Cleanup on failure
    await storage.remove(podPath);
    return reply.code(500).send({ error: 'Failed to create pod' });
  }

  const origin = request.headers.origin;
  const headers = getAllHeaders({ isContainer: true, origin });
  headers['Location'] = podUri;

  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  // Surface a summary of any provisioned key so callers can display
  // the public side. The secret is NEVER echoed in the response —
  // it lives only on disk under the pod's owner-only ACL.
  const keyInfo = podCreation?.ownerKey
    ? {
        keyDocument: `${podUri}private/privkey.jsonld`,
        publicKeyMultibase: podCreation.ownerKey.publicMultibase
      }
    : null;

  // If IdP is enabled, create account and return token + login URL
  if (idpEnabled) {
    try {
      const { createAccount } = await import('../idp/accounts.js');
      await createAccount({ username: name, email, password, webId, podName: name });

      const token = createToken(webId);
      return reply.code(201).send({
        name,
        webId,
        podUri,
        token,
        idpIssuer: issuer,
        loginUrl: `${baseUri}/idp/auth`,
        ...(keyInfo && { ownerKey: keyInfo })
      });
    } catch (err) {
      console.error('Account creation error:', err);
      // Rollback pod creation on account failure
      await storage.remove(podPath);
      return reply.code(409).send({ error: err.message });
    }
  }

  // Generate token for the pod owner (simple auth mode)
  const token = createToken(webId);

  return reply.code(201).send({
    name,
    webId,
    podUri,
    token,
    ...(keyInfo && { ownerKey: keyInfo })
  });
}

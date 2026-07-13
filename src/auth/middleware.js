/**
 * Authorization middleware
 * Combines authentication (token verification) with WAC checking
 * Supports both simple Bearer tokens and Solid-OIDC DPoP tokens
 */

import { getWebIdFromRequestAsync } from './token.js';
import { checkAccess, getRequiredMode } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import * as storage from '../storage/filesystem.js';
import { getEffectiveUrlPath } from '../utils/url.js';
import { generateDatabrowserHtml, generateModuleDatabrowserHtml } from '../mashlib/index.js';
import { resolveReferent } from '../lws/referent-resolver.js';

/**
 * Build a resource URL for WAC checking, normalizing path-based pod access
 * to subdomain form so URLs match ACL entries.
 *
 * In subdomain mode, ACLs reference subdomain URLs (e.g. https://alice.example.com/public/).
 * Path-based access on the main domain (e.g. https://example.com/alice/public/) must be
 * normalized to match.
 *
 * @param {object} request - Fastify request
 * @param {string} urlPath - URL path (e.g. /alice/public/file.ttl)
 * @returns {string} Normalized resource URL
 */
export function buildResourceUrl(request, urlPath) {
  // Use request.headers.host (includes port) instead of request.hostname (strips port)
  const host = request.headers.host || request.hostname;
  if (request.subdomainsEnabled && request.baseDomain &&
      request.hostname === request.baseDomain && !request.podName) {
    const pathMatch = urlPath.match(/^\/([^/]+)(\/.*)?$/);
    // Treat a path segment as a pod name only if it looks like one:
    //   - not a dotfile (.well-known, .acl, .meta, ...)
    //   - no dot (pod names are DNS labels; file names have extensions)
    // This avoids rewriting /mashlib.js to https://mashlib.js.basedomain/
    // which would fail WAC against the base domain's ACL. (#307)
    if (pathMatch && !pathMatch[1].startsWith('.') && !pathMatch[1].includes('.')) {
      const podName = pathMatch[1];
      const remainder = pathMatch[2] || '/';
      return `${request.protocol}://${podName}.${request.baseDomain}${remainder}`;
    }
  }
  return `${request.protocol}://${host}${urlPath}`;
}

/**
 * Check if request is authorized
 * @param {object} request - Fastify request
 * @param {object} reply - Fastify reply
 * @param {object} options - Optional settings
 * @param {string} [options.requiredMode] - Override the required access mode
 *   (e.g., 'Write' for git push). Defaults to getRequiredMode(method).
 * @param {boolean} [options.skipParentForMissing] - When true, skip the
 *   "non-existent resource + write method → check parent container"
 *   fallback. Used by virtual endpoints (e.g. `/proxy` in #378) that have
 *   no backing storage but still want WAC checked against the URL itself.
 *   Without this flag, POST/PUT/PATCH on a missing resource is authorized
 *   against the parent (e.g. `/proxy` falls back to `/`), which is too
 *   permissive for endpoints whose ACL is meant to live at that path.
 * @returns {Promise<{
 *   authorized: boolean,
 *   webId: string|null,
 *   wacAllow: string,
 *   authError: string|null,
 *   paymentRequired?: object,
 *   paid?: number,
 *   balance?: number,
 *   currency?: string
 * }>}
 *   `paid` is the cost actually debited (number, not boolean) — see
 *   checkAccess() in src/wac/checker.js:189; callers stringify it for
 *   the X-Cost response header.
 */
export async function authorize(request, reply, options = {}) {
  const urlPath = request.url.split('?')[0];
  const method = request.method;

  // OPTIONS is always allowed (CORS preflight)
  if (method === 'OPTIONS') {
    return { authorized: true, webId: null, wacAllow: 'user="read write append control", public="read write append"', authError: null };
  }

  // Public mode - skip all WAC checks, allow unauthenticated access
  if (request.config?.public) {
    const modes = request.config?.readOnly ? 'read' : 'read write append';
    return { authorized: true, webId: null, wacAllow: `public="${modes}"`, authError: null };
  }

  // Get WebID from token (supports both simple and Solid-OIDC tokens)
  const { webId, error: authError } = await getWebIdFromRequestAsync(request);

  // ACL files require special handling - check Control permission on protected resource
  if (urlPath.endsWith('.acl')) {
    return authorizeAclAccess(request, urlPath, method, webId, authError);
  }

  // System-Managed `.lwstypes`/`.lwsprov` sidecars require special handling
  // too (C1, 2026-07-13): they leak the SUBJECT's rdf:type / validating
  // profile, so being able to see them should require READ on the subject —
  // not whatever ACL the blanket check below would resolve for the sidecar's
  // OWN path (which walks up to the container default and never binds to
  // the subject's own, possibly tighter, `.acl` — see findApplicableAcl in
  // src/wac/checker.js). Mirrors the `.acl` carve-out above, READ instead of
  // Control. --lws-gated: these sidecars can't exist with `--lws` off (the
  // write path that creates them is gated), so this is a no-op there.
  if (request.lwsEnabled && /\.(lwstypes|lwsprov)$/.test(urlPath)) {
    return authorizeSidecarAccess(request, urlPath, webId, authError);
  }

  // The client-managed `.meta` sidecar leaks the same class of thing —
  // governance metadata (dct:conformsTo, powder:describedby) plus the
  // subject's existence — through the identical hole: a live triage
  // (2026-07-13) confirmed a private member's OWN `x.meta` was anonymously
  // GETtable when the member sat in a public container but carried a
  // tighter own `.acl`, because the blanket check below resolves `.meta`'s
  // ACL by walking up from `.meta`'s OWN path (never the member's own
  // `.acl` — same findApplicableAcl gap as above) and lands on the
  // container default. Route it through the SAME authorizeSidecarAccess
  // (READ-on-stripped-subject) — but GET/HEAD ONLY: unlike `.lwstypes`/
  // `.lwsprov` (never client-writable), `.meta` IS legitimately
  // client-PUT/PATCH/DELETE-able (pod owners declare describedby/conformsTo
  // on it), and those methods must keep requiring WRITE via the unmodified
  // blanket check below — routing them through authorizeSidecarAccess too
  // would silently downgrade a `.meta` write from WRITE-gated to
  // READ-gated. authorizeSidecarAccess strips the suffix and re-derives
  // isContainer from the stripped path's trailing slash, so a CONTAINER's
  // own bare `.meta` (`/foo/.meta` → strip → `/foo/`) still checks READ on
  // the CONTAINER — preserving the public governance up-walk (a cold agent
  // reading a public container's `.meta` for its conformsTo/describedby) —
  // while a MEMBER's `.meta` (`/foo/bar.meta` → strip → `/foo/bar`) checks
  // READ on the MEMBER, closing the leak. --lws-gated to match the sibling
  // suffixes and keep this scoped to the C1 line of fixes.
  if (request.lwsEnabled && (method === 'GET' || method === 'HEAD') && urlPath.endsWith('.meta')) {
    return authorizeSidecarAccess(request, urlPath, webId, authError);
  }

  // Log auth failures for debugging
  if (authError) {
    request.log.warn({ authError, method, urlPath, hasAuth: !!request.headers.authorization }, 'Auth error');
  }

  // Get effective storage path (includes pod name in subdomain mode)
  const storagePath = getEffectiveUrlPath(request);

  // Get resource info
  const stats = await storage.stat(storagePath);
  const resourceExists = stats !== null;
  const isContainer = stats?.isDirectory || urlPath.endsWith('/');

  // Task 3 (referent identity & discovery): a minted subject-IRI name (e.g.
  // /id/{slug}) is a virtual uriSpace entry with no resource — and no
  // ACL — of its own. The blanket WAC check below would find no applicable
  // ACL walking up from it and deny by default, returning 401/403 BEFORE
  // the request ever reaches the resolver's own no-oracle check
  // (src/handlers/resource.js resolveReferentTarget), which is what's
  // actually meant to decide readability — of the RESOLVED TARGET, not the
  // name. Letting the blanket check run here would also violate no-oracle:
  // 401/403-vs-404 on the name would itself leak whether it resolves.
  // So: for GET/HEAD on a path that (a) has no resource of its own and
  // (b) actually resolves per the declared uriSpaces, defer the whole
  // access decision to the resolver, same as /.well-known/*, /types/*, /mcp
  // (server.js's static bypass list) — this is that list's dynamic-data
  // analogue, since uriSpaces are pod-config data, not a fixed path set.
  // Scoped to `!resourceExists`: a real resource later PUT directly at the
  // name's path makes `resourceExists` true and this exemption stops
  // applying — the blanket WAC check below protects it as normal.
  if (!resourceExists && (method === 'GET' || method === 'HEAD') && request.lwsEnabled && request.podConfig) {
    const cfg = await request.podConfig.get();
    if (resolveReferent(urlPath, cfg.uriSpaces || [])) {
      return { authorized: true, webId, wacAllow: 'user="", public=""', authError: null };
    }
  }

  // Build resource URL, normalizing path-based pod access to subdomain form for WAC
  const resourceUrl = buildResourceUrl(request, urlPath);

  // Get required access mode - use override if provided, otherwise derive from method
  const requiredMode = options.requiredMode || getRequiredMode(method);

  // For write operations on non-existent resources, check parent container
  let checkPath = storagePath;
  let checkUrl = resourceUrl;
  let checkIsContainer = isContainer;

  if (!resourceExists && (method === 'PUT' || method === 'POST' || method === 'PATCH') && !options.skipParentForMissing) {
    // Check write permission on parent container
    const parentPath = getParentPath(storagePath);
    checkPath = parentPath;
    // For URL, also need to get parent (normalized for subdomain WAC matching)
    const parentUrlPath = getParentPath(urlPath);
    checkUrl = buildResourceUrl(request, parentUrlPath);
    checkIsContainer = true;
  }
  // skipParentForMissing: callers with virtual endpoints (e.g. /proxy in
  // #378) want WAC checked against the URL path itself even when no
  // backing storage exists. Without this opt-out, POST /proxy on a
  // single-user pod gets authorized against /, which is too permissive.

  // Check WAC permissions
  const { allowed, wacAllow, paymentRequired, paid, balance, currency } = await checkAccess({
    resourceUrl: checkUrl,
    resourcePath: checkPath,
    isContainer: checkIsContainer,
    agentWebId: webId,
    requiredMode
  });

  return { authorized: allowed, webId, wacAllow, authError, paymentRequired, paid, balance, currency };
}

/**
 * Get parent container path
 */
function getParentPath(path) {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.substring(0, lastSlash + 1);
}

/**
 * Handle unauthorized request
 * @param {object} request - Fastify request
 * @param {object} reply - Fastify reply
 * @param {boolean} isAuthenticated - Whether user is authenticated
 * @param {string} wacAllow - WAC-Allow header value
 * @param {string|null} authError - Authentication error message (for DPoP failures)
 * @param {string|null} issuer - IdP issuer URL for WWW-Authenticate header
 */
export function handleUnauthorized(request, reply, isAuthenticated, wacAllow, authError = null, issuer = null) {
  reply.header('WAC-Allow', wacAllow);

  const statusCode = isAuthenticated ? 403 : 401;
  const realm = issuer || 'Solid';

  if (!isAuthenticated) {
    reply.header('WWW-Authenticate', `DPoP realm="${realm}", Bearer realm="${realm}"`);
  }

  // Check if browser wants HTML
  const accept = request.headers.accept || '';
  if (accept.includes('text/html')) {
    // If mashlib is enabled, serve mashlib instead of static error page
    // Mashlib has built-in login functionality via panes.runDataBrowser()
    if (request.mashlibEnabled) {
      const html = request.mashlibModule
        ? generateModuleDatabrowserHtml(request.mashlibModule)
        : generateDatabrowserHtml(request.url, request.mashlibCdn ? request.mashlibVersion : null);
      return reply.code(statusCode).type('text/html').send(html);
    }
    return reply.code(statusCode).type('text/html').send(getErrorPage(statusCode, isAuthenticated, request));
  }

  // Return JSON for API clients
  if (!isAuthenticated) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: authError || 'Authentication required'
    });
  } else {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Access denied'
    });
  }
}

/**
 * Generate a beautiful error page for browsers
 */
function getErrorPage(statusCode, isAuthenticated, request) {
  const is401 = statusCode === 401;
  const title = is401 ? 'Authentication Required' : 'Access Denied';
  const subtitle = is401
    ? "This resource is protected. You'll need to sign in to continue."
    : "You're signed in, but you don't have permission to view this resource.";

  const baseUrl = `${request.protocol}://${request.headers.host || request.hostname}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Solid Server</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
      padding: 2rem;
      color: #374151;
    }

    .container {
      max-width: 540px;
      width: 100%;
      text-align: center;
    }

    .card {
      background: white;
      border-radius: 16px;
      padding: 3rem 2.5rem;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }

    .icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 1.5rem;
      background: ${is401 ? '#fef3c7' : '#fee2e2'};
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.5rem;
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      color: #111827;
      margin-bottom: 0.75rem;
    }

    .subtitle {
      color: #6b7280;
      font-size: 1.05rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.875rem 1.5rem;
      border-radius: 10px;
      font-size: 1rem;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.2s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, #7c3aed 0%, #6366f1 100%);
      color: white;
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4);
    }

    .btn-secondary {
      background: #f3f4f6;
      color: #374151;
    }

    .btn-secondary:hover {
      background: #e5e7eb;
    }

    .divider {
      display: flex;
      align-items: center;
      margin: 2rem 0;
      color: #9ca3af;
      font-size: 0.875rem;
    }

    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }

    .divider span {
      padding: 0 1rem;
    }

    .info-box {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 10px;
      padding: 1.25rem;
      text-align: left;
    }

    .info-box h3 {
      font-size: 0.9rem;
      font-weight: 600;
      color: #166534;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .info-box p {
      font-size: 0.875rem;
      color: #15803d;
      line-height: 1.5;
    }

    .footer {
      margin-top: 2rem;
      font-size: 0.8rem;
      color: #9ca3af;
    }

    .footer a {
      color: #7c3aed;
      text-decoration: none;
    }

    .footer a:hover {
      text-decoration: underline;
    }

    .status-code {
      font-size: 0.75rem;
      color: #9ca3af;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon">${is401 ? '🔐' : '🚫'}</div>
      <h1>${title}</h1>
      <p class="subtitle">${subtitle}</p>

      <div class="actions">
        ${is401 ? `<a href="https://solidos.org/docs/browser/?uri=${encodeURIComponent(baseUrl + request.url)}" class="btn btn-primary">
          Open in Data Browser
        </a>` : ''}
        <a href="${baseUrl}/" class="btn btn-secondary">
          Go to Homepage
        </a>
      </div>

      <div class="divider"><span>What is this?</span></div>

      <div class="info-box">
        <h3>🏖️ Welcome to Solid</h3>
        <p>
          This is a <strong>Solid Pod</strong> — a personal data store where you control your own data.
          Resources can be private, shared with specific people, or public.
          ${is401 ? "The Data Browser lets you sign in with your WebID to access protected content." : 'Ask the owner to grant you access.'}
        </p>
      </div>

      <p class="status-code">HTTP ${statusCode} • ${request.url}</p>
    </div>

    <p class="footer">
      Powered by <a href="https://jss.live/">JSS</a> •
      <a href="https://jss.live/docs/">Docs</a>
    </p>
  </div>
</body>
</html>`;
}

/**
 * Authorize access to ACL files
 * ACL files require acl:Control permission on the resource they protect
 *
 * @param {object} request - Fastify request
 * @param {string} urlPath - URL path to the ACL file
 * @param {string} method - HTTP method
 * @param {string|null} webId - Authenticated user's WebID
 * @param {string|null} authError - Authentication error if any
 * @returns {Promise<{authorized: boolean, webId: string|null, wacAllow: string, authError: string|null}>}
 */
async function authorizeAclAccess(request, urlPath, method, webId, authError) {
  // Determine the protected resource URL
  // /foo/.acl protects /foo/ (container)
  // /foo/bar.acl protects /foo/bar (resource)
  const protectedPath = urlPath.replace(/\.acl$/, '');
  const isProtectedContainer = protectedPath.endsWith('/');
  const protectedUrl = buildResourceUrl(request, protectedPath);

  // Get storage path for the protected resource
  const storagePath = getEffectiveUrlPath(request).replace(/\.acl$/, '');

  // All ACL operations require Control permission on the protected resource
  // This is stricter than the Solid spec (which allows Read for reading ACLs)
  // but simpler and more secure
  const { allowed, wacAllow } = await checkAccess({
    resourceUrl: protectedUrl,
    resourcePath: storagePath,
    isContainer: isProtectedContainer,
    agentWebId: webId,
    requiredMode: AccessMode.CONTROL
  });

  // WAC-Allow must describe the REQUESTED resource (the .acl), not the
  // protected resource — control-holders may read+write the acl; everyone
  // else gets nothing (probe-#6 F1: a 401 wearing the protected resource's
  // public="read" is retry-loop bait for WAC-aware clients). If public
  // CONTROL is actually granted on the protected resource (rare), this
  // under-reports public="" for the .acl — acceptable and safe, never
  // over-grants. --lws-gated (2026-07-11 decision): the --lws-off path
  // keeps the upstream (misleading) header byte-identical.
  const aclWacAllow = request.lwsEnabled
    ? (allowed ? 'user="read write", public=""' : 'user="", public=""')
    : wacAllow;

  return { authorized: allowed, webId, wacAllow: aclWacAllow, authError };
}

/**
 * Authorize access to System-Managed `.lwstypes`/`.lwsprov` sidecars, and
 * the client-managed `.meta` sidecar.
 * `.lwstypes`/`.lwsprov` reveal the SUBJECT resource's rdf:type / validating
 * profile; `.meta` reveals the subject's governance metadata
 * (dct:conformsTo, powder:describedby) and existence — so reading any of
 * them requires acl:Read on the subject, exactly the access the subject's
 * own `.acl` already governs.
 *
 * Without this, a direct GET of e.g. `secret.jsonld.lwstypes` (or
 * `secret.jsonld.meta`) falls through the dotfile guard (`secret.jsonld.*`
 * doesn't start with `.`, so it isn't caught by the ALLOWED_DOTFILES check
 * in server.js) into the blanket WAC check, which resolves an ACL by
 * walking UP from the sidecar's own path (findApplicableAcl in
 * src/wac/checker.js) — landing on the CONTAINER default, never the
 * subject's own (possibly tighter) `.acl`. A private resource in an
 * otherwise-public container leaked its type/provenance to anonymous
 * clients even though the resource itself 403s (C1, 2026-07-13; `.meta`
 * extension same day, live-triage-confirmed).
 *
 * `.meta` is unlike `.lwstypes`/`.lwsprov` in that a CONTAINER also has its
 * own bare `.meta` (`/foo/.meta`, which DOES start with `.` and IS in
 * ALLOWED_DOTFILES, so it reaches this same authorize() pipeline via the
 * normal resource path, not the dotfile 403). Stripping the suffix from
 * `/foo/.meta` yields `/foo/` (isSubjectContainer = true via the trailing
 * slash below) — READ is then checked against the CONTAINER, which is
 * typically public-read, so the up-walk governance-discovery contract
 * (a cold agent reading a public container's `.meta` for its
 * conformsTo/describedby) keeps working. Stripping `/foo/bar.meta` yields
 * `/foo/bar` (a member, isSubjectContainer = false) — READ is checked
 * against the MEMBER, closing the leak for a private member sitting in a
 * public container.
 *
 * Callers gate `.meta` dispatch to GET/HEAD only (unlike `.lwstypes`/
 * `.lwsprov`, which are never client-writable) — PUT/PATCH/DELETE of
 * `.meta` must keep going through the unmodified blanket WAC check (WRITE
 * required), not this READ-only path.
 *
 * @param {object} request - Fastify request
 * @param {string} urlPath - URL path to the `.lwstypes`/`.lwsprov`/`.meta` sidecar
 * @param {string|null} webId - Authenticated user's WebID
 * @param {string|null} authError - Authentication error if any
 * @returns {Promise<{authorized: boolean, webId: string|null, wacAllow: string, authError: string|null}>}
 */
async function authorizeSidecarAccess(request, urlPath, webId, authError) {
  // Strip the sidecar suffix to get the subject these describe.
  // `foo.jsonld.lwstypes` describes `foo.jsonld`; `foo.jsonld.meta`
  // describes `foo.jsonld`; bare `.meta` describes the container it sits in
  // (see the isSubjectContainer derivation below — trailing slash after
  // stripping decides resource-vs-container per-request, no suffix-specific
  // branching needed).
  const subjectPath = urlPath.replace(/\.(lwstypes|lwsprov|meta)$/, '');
  const isSubjectContainer = subjectPath.endsWith('/');
  const subjectUrl = buildResourceUrl(request, subjectPath);

  const storagePath = getEffectiveUrlPath(request).replace(/\.(lwstypes|lwsprov|meta)$/, '');

  // READ on the subject — the same mode the subject's own GET requires.
  const { allowed, wacAllow } = await checkAccess({
    resourceUrl: subjectUrl,
    resourcePath: storagePath,
    isContainer: isSubjectContainer,
    agentWebId: webId,
    requiredMode: AccessMode.READ
  });

  // WAC-Allow describes the REQUESTED resource (the sidecar), which only
  // ever supports GET/HEAD — narrow the subject's mode set (which may
  // legitimately include write/append/control) down to "read", so the
  // header never over-claims modes the sidecar doesn't support.
  const readOnly = (modes) => modes.split(/\s+/).filter(m => m === 'read').join(' ');
  const sidecarWacAllow = wacAllow.replace(/user="([^"]*)"/, (_, m) => `user="${readOnly(m)}"`)
                                   .replace(/public="([^"]*)"/, (_, m) => `public="${readOnly(m)}"`);

  return { authorized: allowed, webId, wacAllow: sidecarWacAllow, authError };
}

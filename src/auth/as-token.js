/**
 * RS-side validation of `at+jwt` access tokens minted by the LWS
 * Authorization Server role (2026-07-24 AS round, task 4).
 *
 * Companion to src/idp/token-exchange.js (the mint side): that handler
 * signs `{sub, client_id, aud, iss, iat, exp, jti}` with header
 * `{alg, kid, typ: 'at+jwt'}` using this deployment's own IdP signing key.
 * This module is the Resource Server verifier for those tokens — and,
 * via the same interface, for a REMOTE deployment's AS-minted tokens too
 * (the trusted issuer is whatever `request.lwsAsUri` resolves to; it need
 * not be this deployment).
 *
 * Detection (`hasAsToken`) is header-shape only: a 3-part Bearer JWT whose
 * protected header has `typ === 'at+jwt'`. LWS-CID JWTs (verified by
 * lws-cid.js, checked earlier in the token.js dispatch chain) use `kid`
 * shaped as a URL-with-fragment into a WebID profile and `typ` left at the
 * default `'JWT'` — the two detectors never both fire for the same token
 * (see test/as-token.test.js "dispatch" cases for the proof in both
 * directions).
 *
 * Key resolution: local vs remote is decided by comparing the configured
 * issuer's origin against THIS request's own origin (`buildResourceUrl`).
 * Equal -> this deployment minted it -> read the local signing key
 * straight off disk (`jose.createLocalJWKSet(await getPublicJwks())`,
 * src/idp/keys.js) rather than round-tripping to our own `/.well-known/
 * jwks.json` over HTTP. Different -> the issuer is a separate AS
 * deployment -> resolve its `jwks_uri` from its RFC 8414 metadata
 * (`<issuer>/.well-known/lws-configuration`, memoized per issuer) and use
 * `jose.createRemoteJWKSet`, which caches fetched keys and automatically
 * refetches on an unknown `kid` — the mechanism that makes key rotation on
 * the remote AS transparent to this RS (see the rotation test).
 */
import * as jose from 'jose';
import { getPublicJwks } from '../idp/keys.js';
import { buildResourceUrl } from './middleware.js';
import { storageRootFor } from '../lws/storage-resolver.js';
import * as storage from '../storage/filesystem.js';

// RFC 8725 access-token-jwt-profile clock skew tolerance.
const CLOCK_TOLERANCE = 60;

// Remote-issuer keyset cache: issuer string -> Promise<RemoteJWKSet lookup fn>.
// One entry per distinct trusted issuer for the lifetime of the process;
// jose's own RemoteJWKSet handles fetch caching / rotation refetch beneath
// this, so we only need to memoize the *resolution* of jwks_uri itself.
const _remoteKeysets = new Map();

/**
 * Cheap header-shape detector — does this request carry an at+jwt Bearer
 * token? Doesn't verify anything; just decides which validator in the
 * token.js dispatch chain should look at this request.
 * @param {object} request
 * @returns {boolean}
 */
export function hasAsToken(request) {
  const auth = request.headers?.authorization;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (token.split('.').length !== 3) return false;
  try {
    const header = jose.decodeProtectedHeader(token);
    return header?.typ === 'at+jwt';
  } catch {
    return false;
  }
}

async function resolveRemoteKeyset(issuer) {
  if (_remoteKeysets.has(issuer)) return _remoteKeysets.get(issuer);
  const promise = (async () => {
    const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
    const metaRes = await fetch(`${base}/.well-known/lws-configuration`);
    if (!metaRes.ok) {
      throw new Error(`AS metadata fetch failed (${metaRes.status}) for issuer ${issuer}`);
    }
    const meta = await metaRes.json();
    if (!meta.jwks_uri || typeof meta.jwks_uri !== 'string') {
      throw new Error(`AS metadata for issuer ${issuer} has no jwks_uri`);
    }
    return jose.createRemoteJWKSet(new URL(meta.jwks_uri));
  })();
  // Cache the promise itself (not just the resolved value) so concurrent
  // first-callers for the same issuer share one metadata fetch instead of
  // racing duplicate requests. A failed resolution isn't cached — clear it
  // so a transient metadata-fetch error doesn't permanently poison the
  // issuer (next call gets a fresh attempt).
  _remoteKeysets.set(issuer, promise);
  promise.catch(() => _remoteKeysets.delete(issuer));
  return promise;
}

// Test-only: drop the per-issuer remote-keyset cache (mirrors
// cid-doc-fetch.js's _clearProfileCacheForTests). A fresh
// jose.createRemoteJWKSet instance's first key lookup always fetches
// unconditionally, which is what a test rotating a mock issuer's JWKS
// needs — without this, jose's own ~30s refetch cooldown on an EXISTING
// instance would make such a test flaky or slow.
export function _clearAsTokenCachesForTests() {
  _remoteKeysets.clear();
}

/**
 * Full RS validation of an at+jwt: signature (via the trusted issuer's
 * JWKS, local or remote), `typ`, `iss`, `exp`/`nbf`/`iat` (60s clock
 * tolerance), and `aud` containment — the aud claim must carry exactly one
 * value, and it must equal the canonical storage-root URL that logically
 * contains the request's target resource (spec: LWS Authorization §token
 * validation). A target not under any storage root fails closed.
 *
 * @param {object} request - Fastify request (headers, protocol, url,
 *   lwsAs, lwsAsUri all read off it)
 * @returns {Promise<{webId: string|null, error: string|null}>}
 */
export async function verifyAsToken(request) {
  if (!request.lwsAs || !request.lwsAsUri) {
    // An at+jwt was presented but this deployment has no trusted issuer
    // configured. Reject outright — never fall through to the legacy
    // Bearer path for a token this shape-detected as an at+jwt.
    return { webId: null, error: 'at+jwt presented but no trusted issuer (--lws-as) is configured' };
  }

  const auth = request.headers?.authorization;
  const token = auth.slice(7).trim();
  const issuer = request.lwsAsUri;

  let keyset;
  try {
    const selfOrigin = new URL(buildResourceUrl(request, '/')).origin;
    const issuerOrigin = new URL(issuer).origin;
    keyset = issuerOrigin === selfOrigin
      ? jose.createLocalJWKSet(await getPublicJwks())
      : await resolveRemoteKeyset(issuer);
  } catch (err) {
    return { webId: null, error: `unable to resolve issuer signing keys: ${err.message}` };
  }

  let payload, protectedHeader;
  try {
    ({ payload, protectedHeader } = await jose.jwtVerify(token, keyset, {
      issuer,
      clockTolerance: CLOCK_TOLERANCE,
    }));
  } catch (err) {
    return { webId: null, error: `at+jwt verification failed: ${err.message}` };
  }

  // jose has no `typ`-verification option (see jose's JWTVerifyOptions) —
  // check the JWT-profile header ourselves. hasAsToken already filtered on
  // this before dispatch, but verifyAsToken is independently exported /
  // testable, so it re-checks rather than trusting the caller.
  if (protectedHeader.typ !== 'at+jwt') {
    return { webId: null, error: 'not an at+jwt (typ header mismatch)' };
  }

  // jose's exp/nbf checks apply clockTolerance, but it doesn't reject a
  // future `iat` on its own — do that explicitly (RS should not accept a
  // token claiming to have been issued after "now", beyond skew).
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat === 'number' && payload.iat > now + CLOCK_TOLERANCE) {
    return { webId: null, error: 'at+jwt iat is in the future' };
  }

  // aud: RFC 8693 / LWS Authorization semantics — exactly one value.
  let aud = payload.aud;
  if (Array.isArray(aud)) {
    if (aud.length !== 1) {
      return { webId: null, error: 'at+jwt aud must contain exactly one value' };
    }
    [aud] = aud;
  }
  if (typeof aud !== 'string' || !aud) {
    return { webId: null, error: 'at+jwt missing aud' };
  }

  const urlPath = request.url.split('?')[0];
  const rootPath = await storageRootFor(storage, urlPath);
  if (!rootPath) {
    // Target isn't under any storage root at all — fail closed rather
    // than comparing against a meaningless expectation.
    return { webId: null, error: 'target resource is not under any storage root' };
  }
  const expectedAud = buildResourceUrl(request, rootPath);
  if (aud !== expectedAud) {
    return { webId: null, error: `at+jwt aud does not match the target storage root (expected ${expectedAud})` };
  }

  if (typeof payload.sub !== 'string' || !payload.sub) {
    return { webId: null, error: 'at+jwt missing sub' };
  }

  return { webId: payload.sub, error: null };
}

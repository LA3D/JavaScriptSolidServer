/**
 * RFC 8693 Token Exchange grant — LWS Authorization (2026-07-24 AS round,
 * task 2).
 *
 * A trusted-client-shaped bridge: hand this endpoint a subject token (an
 * LWS-CID JWT or an IdP-issued JWT — anything the pod already accepts as a
 * bearer credential) plus a `resource` naming a storage root on THIS
 * deployment, and it mints a short-lived `at+jwt` scoped to that resource.
 * Subject tokens are dispatched CID-vs-IdP by `kid` shape, mirroring the
 * same detection `resolveWebIdFromRequest` uses: LWS-CID kids are a
 * fragment URL into a controlled-identifier document; IdP JWTs use an
 * opaque key fingerprint.
 */
import * as jose from 'jose';
import crypto from 'node:crypto';
import { InvalidGrant, InvalidRequest, CustomOIDCProviderError } from 'oidc-provider/lib/helpers/errors.js';
import { getJwks } from './keys.js';
import { verifyLwsCidAuth } from '../auth/lws-cid.js';
import { verifyIdpJwt } from '../auth/token.js';
import { storageRootFor } from '../lws/storage-resolver.js';

export const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const PARAMS = ['subject_token', 'subject_token_type', 'resource', 'audience', 'requested_token_type'];
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

export function makeTokenExchangeHandler({ storage, issuer, ttl = 300 }) {
  return async function tokenExchange(ctx) {
    const p = ctx.oidc.params;
    if (p.subject_token_type !== JWT_TYPE) throw new InvalidRequest('unsupported subject_token_type');
    if (!p.subject_token || typeof p.subject_token !== 'string') throw new InvalidRequest('subject_token required');
    if (!p.resource) throw new CustomOIDCProviderError('invalid_target', 'resource required');

    // resource must be a storage root on THIS deployment. A malformed
    // resource URI is equally "doesn't resolve" — invalid_target, not a
    // generic 500 from the URL constructor.
    let resUrl, rootPath;
    try {
      resUrl = new URL(p.resource);
      rootPath = await storageRootFor(storage, resUrl.pathname);
    } catch {
      throw new CustomOIDCProviderError('invalid_target', 'resource is not a valid URI');
    }
    if (!rootPath || resUrl.pathname !== rootPath) {
      throw new CustomOIDCProviderError('invalid_target', 'unknown or untrusted storage');
    }

    // dispatch on kid shape: URL kid -> LWS-CID, else IdP JWT
    let kid;
    try {
      ({ kid } = jose.decodeProtectedHeader(p.subject_token));
    } catch {
      throw new InvalidRequest('subject_token is not a valid JWT');
    }
    let webId = null;
    if (typeof kid === 'string' && /^https?:\/\//.test(kid)) {
      const r = await verifyLwsCidAuth(syntheticRequest(ctx, p.subject_token));
      if (r.error) throw new InvalidGrant(`subject token rejected: ${r.error}`);
      webId = r.webId;
    } else {
      const payload = await verifyIdpJwt(p.subject_token);
      // verifyJwtFromIdp (src/auth/token.js) resolves the account webid
      // onto a `webId` (capital I/D) property — NOT `webid`.
      if (!payload?.webId) throw new InvalidGrant('subject token rejected');
      webId = payload.webId;
    }

    const key = await currentSigningKey();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new jose.SignJWT({
      sub: webId, client_id: ctx.oidc.client.clientId, aud: p.resource,
    }).setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
      .setIssuer(issuer).setIssuedAt(now).setExpirationTime(now + ttl)
      .setJti(crypto.randomUUID())
      .sign(key.privateKey);

    ctx.body = { access_token: accessToken, token_type: 'Bearer', expires_in: ttl };
  };
}

// Builds the request-shaped object verifyLwsCidAuth expects. getRequestOrigin
// (src/auth/lws-cid.js:379) reads headers['x-forwarded-proto'] / ['x-forwarded-host']
// first, falling back to request.protocol / headers.host / request.hostname.
// Since the provider is created with `provider.proxy = true` (src/idp/provider.js),
// Koa's ctx.protocol / ctx.host already resolve the forwarded values when the
// deployment sits behind a trusted reverse proxy — passing them straight
// through covers both the direct and proxied cases without duplicating the
// X-Forwarded-* headers here.
function syntheticRequest(ctx, token) {
  return {
    headers: { authorization: `Bearer ${token}`, host: ctx.host },
    protocol: ctx.protocol,
  };
}

// getJwks() (src/idp/keys.js) returns the FULL private JWKS used to
// configure oidc-provider itself — RS256 first (primary), ES256 second
// (see generateSigningKeys). We sign with the same primary key so
// /.well-known/jwks.json (public projection of the same set) already
// carries the verification key for anyone validating our at+jwt.
async function currentSigningKey() {
  const jwks = await getJwks();
  const jwk = jwks?.keys?.[0];
  if (!jwk) throw new Error('no IdP signing key available');
  const privateKey = await jose.importJWK(jwk, jwk.alg);
  return { privateKey, alg: jwk.alg, kid: jwk.kid };
}

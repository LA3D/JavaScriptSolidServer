// src/lws/as-metadata.js
// RFC 8414 Authorization Server Metadata for the --lws-as role (2026-07-24
// AS round, task 3): served at GET /.well-known/lws-configuration, --lws-as
// only. Static — built once from server config, no per-request state.
//
// `issuer` must be lwsAsUri, the SAME value src/idp/index.js hands
// token-exchange.js as the `issuer` it signs into every minted at+jwt's
// `iss` claim — a client that fetches this document can byte-compare
// `issuer` against a token's `iss` and trust the match.
//
// token_endpoint/jwks_uri are the oidc-provider's real routes (verified
// live against /.well-known/openid-configuration in
// test/as-metadata.test.js — provider.routes in src/idp/provider.js).
// They're derived from the SAME base as `issuer` rather than hardcoded
// against a request-derived origin: in the default deployment (no explicit
// --lws-as-uri) lwsAsUri already falls back to idpIssuer (src/server.js),
// so the two agree byte-for-byte.
//
// grant_types_supported / subject_token_types_supported literals mirror
// GRANT_TYPE and the JWT subject-token-type URN in
// src/idp/token-exchange.js — not imported, to avoid an lws -> idp
// layering dependency for two string constants (lws/ is the lower layer;
// idp/ already depends on it, not the reverse).
export function buildAsMetadata({ issuer }) {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  return {
    issuer,
    token_endpoint: `${base}/idp/token`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    grant_types_supported: ['urn:ietf:params:oauth:grant-type:token-exchange'],
    subject_token_types_supported: ['urn:ietf:params:oauth:token-type:jwt'],
    claims_supported: ['sub', 'iss', 'client_id', 'aud'],
  };
}

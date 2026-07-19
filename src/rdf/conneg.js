/**
 * Content Negotiation for RDF Resources
 *
 * Handles Accept header parsing and format selection.
 * OFF by default - this is a JSON-LD native implementation.
 * Enable with { conneg: true } in server options.
 */

import { turtleToJsonLd, jsonLdToTurtle } from './turtle.js';
import { safeJsonParse } from '../utils/url.js';

// RDF content types we support
export const RDF_TYPES = {
  JSON_LD: 'application/ld+json',
  TURTLE: 'text/turtle',
  N3: 'text/n3',
  NTRIPLES: 'application/n-triples',
  NQUADS: 'application/n-quads',
  RDF_XML: 'application/rdf+xml',  // Not supported, but recognized
  LWS_JSON: 'application/lws+json',
  LINKSET: 'application/linkset+json'
};

// Content types we can serve (when conneg enabled)
const SUPPORTED_OUTPUT = [RDF_TYPES.JSON_LD, RDF_TYPES.TURTLE];

// Content types we can accept for input (when conneg enabled)
const SUPPORTED_INPUT = [RDF_TYPES.JSON_LD, RDF_TYPES.TURTLE, RDF_TYPES.N3];

/**
 * Parse Accept header and select best content type
 * @param {string} acceptHeader - Accept header value
 * @param {boolean} connegEnabled - Whether content negotiation is enabled
 * @param {boolean} lwsEnabled - Whether quads formats (N-Triples/N-Quads) negotiate
 * @returns {string} Selected content type
 */
export function selectContentType(acceptHeader, connegEnabled = false, lwsEnabled = false) {
  // LWS container media type is always negotiable when explicitly requested
  // (it is JSON-LD with the lws/v1 context — no Turtle conneg required).
  if (acceptHeader && acceptHeader.toLowerCase().includes(RDF_TYPES.LWS_JSON)) {
    return RDF_TYPES.LWS_JSON;
  }

  // RFC 9264 linkset is always negotiable when explicitly requested,
  // independent of the Turtle conneg flag.
  if (acceptHeader && acceptHeader.toLowerCase().includes(RDF_TYPES.LINKSET)) {
    return RDF_TYPES.LINKSET;
  }

  // If conneg disabled, always return JSON-LD
  if (!connegEnabled) {
    return RDF_TYPES.JSON_LD;
  }

  if (!acceptHeader) {
    return RDF_TYPES.JSON_LD;
  }

  // Parse Accept header
  const accepts = parseAcceptHeader(acceptHeader);

  // Quads formats (N-Triples/N-Quads) are negotiable only on an --lws pod —
  // the --lws-off path must stay byte-identical (spec 2026-07-10 §1).
  const supported = lwsEnabled
    ? [...SUPPORTED_OUTPUT, RDF_TYPES.NTRIPLES, RDF_TYPES.NQUADS]
    : SUPPORTED_OUTPUT;

  // Find best match
  for (const { type } of accepts) {
    if (type === '*/*' || type === 'application/*') {
      return RDF_TYPES.JSON_LD;
    }
    if (supported.includes(type)) {
      return type;
    }
    // Handle text/* preference
    if (type === 'text/*') {
      return RDF_TYPES.TURTLE;
    }
  }

  // Default to JSON-LD
  return RDF_TYPES.JSON_LD;
}

// P3 (LWS media-type MUST, FOLLOWUP.md conformance-audit 2026-07-12): does
// this Accept explicitly prefer plain application/json over the ld+json/
// lws+json spellings? Label-only — selectContentType above still resolves
// the served representation to JSON-LD; this only decides which of the
// three equivalent media-type spellings stamps the Content-Type header.
// q-aware (first match by descending q wins), so an explicit
// `application/ld+json` ranked ahead of `application/json;q=0.5` correctly
// keeps the ld+json label.
export function prefersPlainJson(acceptHeader) {
  if (!acceptHeader) return false;
  for (const { type, q } of parseAcceptHeader(acceptHeader)) {
    if (q === 0) continue;
    if (type === 'application/json') return true;
    if (type === RDF_TYPES.JSON_LD || type === RDF_TYPES.LWS_JSON) return false;
  }
  return false;
}

/**
 * Parse Accept header into sorted list
 */
function parseAcceptHeader(header) {
  const types = header.split(',').map(part => {
    const [type, ...params] = part.trim().split(';');
    let q = 1;

    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q') {
        q = parseFloat(value) || 0;
      }
    }

    return { type: type.trim().toLowerCase(), q };
  });

  // Sort by q value descending
  return types.sort((a, b) => b.q - a.q);
}

// F3 (spec 2026-07-11 §3): can this Accept header be satisfied by the authored
// content type at all? Absent/empty header always satisfies (serve authored).
// q=0 is RFC 9110 §12.5.1's "explicitly not acceptable" — an entry carrying it
// must not count toward satisfiability even if its type would otherwise match.
export function acceptSatisfiable(acceptHeader, contentType) {
  if (!acceptHeader || !acceptHeader.trim()) return true;
  const main = (contentType || '').split(';')[0].trim().toLowerCase();
  const major = main.split('/')[0];
  return parseAcceptHeader(acceptHeader)
    .filter(({ q }) => q !== 0)
    .some(({ type }) => type === '*/*' || type === main || type === `${major}/*`);
}

// A2 (spec 2026-07-11 §4): does this request accept an HTML answer at all?
// Absent header = yes (curl, browsers without Accept). Only a header naming
// specific non-HTML types refuses the shadow. Same q=0 exclusion as
// acceptSatisfiable — RFC 9110 §12.5.1 (Task 2 precedent).
export function acceptsHtml(acceptHeader) {
  if (!acceptHeader || !acceptHeader.trim()) return true;
  return parseAcceptHeader(acceptHeader)
    .filter(({ q }) => q !== 0)
    .some(({ type }) => type === 'text/html' || type === 'application/xhtml+xml'
      || type === '*/*' || type === 'text/*');
}

/**
 * Parse an Accept-Profile header (DX-PROF-CONNEG cnpr:http). Values are
 * angle-bracketed profile URIs with optional ;q= weights. Returns profile
 * URIs ordered by q descending (stable for ties), brackets stripped.
 */
export function parseAcceptProfile(header) {
  if (!header) return [];
  const entries = String(header).split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = entries.map((e, i) => {
    const [ref, ...params] = e.split(';').map((s) => s.trim());
    const uri = ref.replace(/^</, '').replace(/>$/, '');
    const qParam = params.find((p) => p.toLowerCase().startsWith('q='));
    const qRaw = qParam ? parseFloat(qParam.slice(2)) : 1.0;
    // R13 (RFC 9110 robustness): clamp out-of-range weights into [0,1];
    // non-numeric falls back to 1.0. q=0 is §12.5.1 "explicitly not
    // acceptable" — discarded below, matching this file's media-type
    // consumers (acceptSatisfiable/acceptsHtml).
    const q = Number.isFinite(qRaw) ? Math.min(Math.max(qRaw, 0), 1) : 1.0;
    return { uri, q, i };
  }).filter((p) => p.uri && p.q !== 0);
  parsed.sort((a, b) => (b.q - a.q) || (a.i - b.i));
  return parsed.map((p) => p.uri);
}

/**
 * Negotiate a profile-conneg outcome (DX-PROF-CONNEG cnpr:http) against a
 * resource's declared representations (readRepresentations()'s shape:
 * { default, alternates }). EXACT match only — no profile hierarchy (P13).
 * @param {string} acceptProfileHeader
 * @param {{default: object|null, alternates: object[]}} representations
 * @returns {{outcome: 'none'|'self'|'redirect'|'notacceptable', rep: object|null}}
 */
export function negotiateProfile(acceptProfileHeader, representations) {
  const requested = parseAcceptProfile(acceptProfileHeader);
  if (!requested.length) return { outcome: 'none', rep: null };
  for (const wanted of requested) {              // preference order; EXACT match (no hierarchy — P13)
    // Outcome is decided by WHICH SLOT matched, never by href equality: an
    // alternate whose href collapses to the resource's own URL (blank-node/
    // self-authored) must not serve the default's bytes under the alternate's
    // profile (mis-stamp). Default checked first, so a duplicate profile
    // declaration resolves to 'self'.
    if (representations?.default?.profile === wanted) return { outcome: 'self', rep: representations.default };
    const rep = (representations?.alternates || []).find((r) => r.profile === wanted);
    if (rep) return { outcome: 'redirect', rep };
  }
  return { outcome: 'notacceptable', rep: null };
}

/**
 * Check if content type is RDF
 */
export function isRdfType(contentType) {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return Object.values(RDF_TYPES).includes(type) ||
         type === 'application/json'; // Treat as JSON-LD
}

/**
 * Check if we can accept this input type for RDF resources
 * Non-RDF content types are always accepted (passthrough)
 */
export function canAcceptInput(contentType, connegEnabled = false) {
  if (!contentType) return true; // No content type = accept

  const type = contentType.split(';')[0].trim().toLowerCase();

  // Always accept JSON-LD and JSON
  if (type === RDF_TYPES.JSON_LD || type === 'application/json') {
    return true;
  }

  // Check if it's an RDF type we need to handle
  const isRdf = Object.values(RDF_TYPES).includes(type);

  // Non-RDF types are accepted as-is (passthrough)
  if (!isRdf) {
    return true;
  }

  // RDF types other than JSON-LD only if conneg enabled
  if (connegEnabled) {
    return SUPPORTED_INPUT.includes(type);
  }

  // RDF type but conneg disabled - reject (should use JSON-LD)
  return false;
}

/**
 * Convert content to JSON-LD (internal storage format)
 * @param {Buffer|string} content - Input content
 * @param {string} contentType - Content-Type header
 * @param {string} baseUri - Base URI
 * @param {boolean} connegEnabled - Whether conneg is enabled
 * @param {{graphEnvelope?: boolean}} [opts] - graphEnvelope: store multi-
 *   subject Turtle/N3 as {@context,@graph} (spec 2026-07-10 §3). Default
 *   false keeps every existing caller byte-identical.
 * @returns {Promise<object>} JSON-LD document
 */
export async function toJsonLd(content, contentType, baseUri, connegEnabled = false, { graphEnvelope = false } = {}) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  const text = Buffer.isBuffer(content) ? content.toString() : content;

  // JSON-LD or JSON
  if (type === RDF_TYPES.JSON_LD || type === 'application/json' || !type) {
    return safeJsonParse(text);
  }

  // Turtle/N3 - only if conneg enabled
  if (connegEnabled && (type === RDF_TYPES.TURTLE || type === RDF_TYPES.N3)) {
    return turtleToJsonLd(text, baseUri, { graphEnvelope });
  }

  throw new Error(`Unsupported content type: ${type}`);
}

/**
 * Convert JSON-LD to requested format
 * @param {object} jsonLd - JSON-LD document
 * @param {string} targetType - Target content type
 * @param {string} baseUri - Base URI
 * @param {boolean} connegEnabled - Whether conneg is enabled
 * @returns {Promise<{content: string, contentType: string}>}
 */
export async function fromJsonLd(jsonLd, targetType, baseUri, connegEnabled = false) {
  // If conneg disabled, always output JSON-LD
  if (!connegEnabled) {
    return {
      content: JSON.stringify(jsonLd, null, 2),
      contentType: RDF_TYPES.JSON_LD
    };
  }

  // JSON-LD
  if (targetType === RDF_TYPES.JSON_LD || !targetType) {
    return {
      content: JSON.stringify(jsonLd, null, 2),
      contentType: RDF_TYPES.JSON_LD
    };
  }

  // Turtle
  if (targetType === RDF_TYPES.TURTLE) {
    const turtle = await jsonLdToTurtle(jsonLd, baseUri);
    return { content: turtle, contentType: RDF_TYPES.TURTLE };
  }

  // Fallback to JSON-LD
  return {
    content: JSON.stringify(jsonLd, null, 2),
    contentType: RDF_TYPES.JSON_LD
  };
}

/**
 * Get Vary header value for content negotiation
 *
 * Must be identical across all variants of a given URL — inconsistent Vary
 * across variants confuses browser caches and can cause the wrong variant
 * to be served on reload (see #315).
 *
 * - `Accept` — response body depends on Accept (conneg or mashlib HTML shell)
 * - `Authorization` — response body depends on the authenticated user (WAC)
 * - `Origin` — CORS headers echo the request's Origin
 */
export function getVaryHeader(connegEnabled, mashlibEnabled = false, lwsEnabled = false) {
  if (!connegEnabled && !mashlibEnabled && !lwsEnabled) {
    return 'Authorization, Origin';
  }
  // Accept-Profile only ever matters once profile conneg can engage, which
  // requires --lws. A --conneg-only pod (no --lws) never negotiates
  // profiles, so advertising the token there would breach "the --lws-off
  // path MUST be byte-identical" for no benefit.
  return lwsEnabled
    ? 'Accept, Accept-Profile, Authorization, Origin'
    : 'Accept, Authorization, Origin';
}

/**
 * Get Accept-* headers for responses.
 *
 * The explicitly listed RDF types are aligned with the formats this
 * module accepts so clients can discover support consistently:
 *   - JSON-LD (application/ld+json) and JSON (application/json alias)
 *     are advertised in all conneg modes.
 *   - Turtle (text/turtle) and N3 (text/n3) are advertised only when
 *     conneg is enabled (SUPPORTED_INPUT in this file).
 *
 * Note: a wildcard (asterisk-slash-asterisk) is included as a broad
 * interoperability hint for generic clients and proxies. It is not a
 * strict contract that every media type matching the wildcard will be
 * accepted by canAcceptInput() (e.g., application/n-triples and
 * application/rdf+xml are not accepted).
 *
 * @param {boolean} lwsEnabled - P1 (LWS update-resource MUST: JSON Merge
 *   Patch, RFC 7386): under --lws, PATCH also accepts merge-patch+json, so
 *   advertise it. The --lws-off Accept-Patch value stays byte-identical.
 */
export function getAcceptHeaders(connegEnabled, isContainer = false, lwsEnabled = false) {
  const headers = {};

  if (isContainer) {
    headers['Accept-Post'] = connegEnabled
      ? `${RDF_TYPES.JSON_LD}, application/json, ${RDF_TYPES.TURTLE}, ${RDF_TYPES.N3}, */*`
      : `${RDF_TYPES.JSON_LD}, application/json, */*`;
  }

  headers['Accept-Put'] = connegEnabled
    ? `${RDF_TYPES.JSON_LD}, application/json, ${RDF_TYPES.TURTLE}, ${RDF_TYPES.N3}, */*`
    : `${RDF_TYPES.JSON_LD}, application/json, */*`;

  headers['Accept-Patch'] = 'text/n3, application/sparql-update'
    + (lwsEnabled ? ', application/merge-patch+json' : '');

  return headers;
}

/**
 * LDP (Linked Data Platform) header utilities
 */

import { getAcceptHeaders, getVaryHeader } from '../rdf/conneg.js';
import { storageDescriptionUrl } from '../lws/storage-description.js';
import { parentContainerUrl } from '../utils/url.js';

const LDP = 'http://www.w3.org/ns/ldp#';
const LWS_STORAGE_DESC_REL = 'https://www.w3.org/ns/lws#storageDescription';
const LWS_NS = 'https://www.w3.org/ns/lws#';

/**
 * Get Link headers for a resource
 * @param {boolean} isContainer
 * @param {string} aclUrl - URL to the ACL resource
 * @returns {string}
 */
export function getLinkHeader(isContainer, aclUrl = null) {
  const links = [`<${LDP}Resource>; rel="type"`];

  if (isContainer) {
    links.push(`<${LDP}Container>; rel="type"`);
    links.push(`<${LDP}BasicContainer>; rel="type"`);
  }

  // Add acl link for auxiliary resource discovery
  if (aclUrl) {
    links.push(`<${aclUrl}>; rel="acl"`);
  }

  return links.join(', ');
}

/**
 * Get the ACL URL for a resource
 * @param {string} resourceUrl - Full URL of the resource
 * @param {boolean} isContainer - Whether the resource is a container
 * @returns {string} ACL URL
 */
export function getAclUrl(resourceUrl, isContainer) {
  if (isContainer) {
    // Container ACL: /path/.acl
    const base = resourceUrl.endsWith('/') ? resourceUrl : resourceUrl + '/';
    return base + '.acl';
  }
  // Resource ACL: /path/file.acl
  return resourceUrl + '.acl';
}

/**
 * Get standard LDP response headers
 * @param {object} options
 * @returns {object}
 */
export function getResponseHeaders({ isContainer = false, etag = null, contentType = null, resourceUrl = null, wacAllow = null, connegEnabled = false, mashlibEnabled = false, lwsEnabled = false, updatesVia = null }) {
  // Calculate ACL URL if resource URL provided
  const aclUrl = resourceUrl ? getAclUrl(resourceUrl, isContainer) : null;

  const headers = {
    'Link': getLinkHeader(isContainer, aclUrl),
    'Accept-Patch': 'text/n3, application/sparql-update',
    'Accept-Ranges': isContainer ? 'none' : 'bytes',
    'Allow': 'GET, HEAD, PUT, DELETE, PATCH, OPTIONS' + (isContainer ? ', POST' : ''),
    'Vary': getVaryHeader(connegEnabled, mashlibEnabled, lwsEnabled)
  };

  // Only set WAC-Allow if explicitly provided (otherwise the auth hook sets it)
  if (wacAllow) {
    headers['WAC-Allow'] = wacAllow;
  }

  // Add Accept-* headers (conneg-aware; lwsEnabled adds merge-patch to Accept-Patch — P1)
  const acceptHeaders = getAcceptHeaders(connegEnabled, isContainer, lwsEnabled);
  Object.assign(headers, acceptHeaders);

  // Add Updates-Via header for WebSocket notifications discovery
  if (updatesVia) {
    headers['Updates-Via'] = updatesVia;
  }

  if (etag) {
    headers['ETag'] = etag;
  }

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  return headers;
}

/**
 * Get CORS headers
 * @param {string} origin
 * @returns {object}
 */
export function getCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Accept-Profile, Authorization, Content-Type, DPoP, If-Match, If-None-Match, Link, Range, Slug, Origin',
    'Access-Control-Expose-Headers': 'Accept-Patch, Accept-Post, Accept-Ranges, Allow, Content-Length, Content-Profile, Content-Range, Content-Type, ETag, Link, Location, Updates-Via, WAC-Allow, X-Cost, X-Balance, X-Pay-Currency',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400'
  };
}

// DX-PROF-CONNEG §8.2.1 list-profiles as Link header parts: the default
// representation is rel="canonical", each alternate rel="alternate", with
// type= (media type) and formats= (profile URI — the attribute every worked
// example in DX-PROF-CONNEG and the IETF draft uses; the Figure-3 prose
// saying `profile` is the spec contradicting its own examples). Returns the
// comma-joined string, or null when there is nothing to advertise.
export function representationLinks(representations) {
  if (!representations) return null;
  const part = (r, rel) => {
    let s = `<${r.href}>; rel="${rel}"`;
    if (r.format) s += `; type="${r.format}"`;
    if (r.profile) s += `; formats="${r.profile}"`;
    return s;
  };
  const parts = [];
  if (representations.default) parts.push(part(representations.default, 'canonical'));
  for (const a of representations.alternates || []) parts.push(part(a, 'alternate'));
  return parts.length ? parts.join(', ') : null;
}

// R12 (spec 2026-07-19, DX-PROF-CONNEG R.1.2.a): an UN-negotiated response
// still identifies its representation's profile — but only when the served
// body IS the declared default representation. The guard is media equality:
// a converted variant (turtle→JSON-LD, a server-rendered nav face) must
// never carry the declared representation's profile claim.
function defaultProfileFor(representations, contentType) {
  const d = representations?.default;
  if (!d?.profile || !d.format || !contentType) return null;
  const served = contentType.split(';')[0].trim().toLowerCase();
  const declared = d.format.split(';')[0].trim().toLowerCase();
  return served === declared ? d.profile : null;
}

/**
 * Get all headers combined
 * @param {object} options
 * @param {string|null} [options.chosenProfile] - DX-PROF-CONNEG cnpr:http:
 *   when the file-GET path negotiated a 'self' outcome (Task 7), the caller
 *   passes the matched profile URI here so it gets stamped (Content-Profile
 *   + Link rel="profile") regardless of which serve branch handles the
 *   response — centralizing this in getAllHeaders means every branch that
 *   builds its headers here gets the stamp for free, instead of each branch
 *   having to remember to append it itself. Negotiated 'self' outcomes pass
 *   it explicitly; UN-negotiated responses derive the stamp instead from
 *   `representations.default` under the media-equality guard (R12, see
 *   `defaultProfileFor` above).
 * @param {object|null} [options.representations] - authz-filtered
 *   { default, alternates } set: when present, the DX-PROF-CONNEG §8.2.1
 *   list-profiles advertisement (rel="canonical"/"alternate" Link parts) is
 *   appended. Populated by the Accept-Profile negotiation blocks AND (A1,
 *   spec §4) by the bare-200 path when a .meta exists — resources with no
 *   .meta pay only a storage.exists() on the hot path. Linkset responses
 *   carry the list in their BODY too.
 * @param {string|null} [options.storageRootPath] - the owning storage's
 *   root path (e.g. '/alice/'), as resolved by `storageRootFor` (A2) in the
 *   request pipeline — getAllHeaders is sync and can't resolve it itself.
 *   `null` (default) keeps the pre-multi-tenant server-scope well-known
 *   target, unchanged for every caller that doesn't pass it.
 * @param {string[]|null} [options.storageOwners] - solid:owner URIs for the
 *   storage, resolved (server.js onRequest) ONLY when `resourceUrl` IS the
 *   storage root — `null`/empty everywhere else, so members never get the
 *   Link even when passed the same field.
 * @param {boolean} [options.syntheticView] - true when the response body is
 *   a server-rendered VIEW of the resource (e.g. the navigator's generic
 *   entity face, `?view=nav`) rather than the resource's own bytes. Profile
 *   claims (Content-Profile + Link rel="profile") bind to a declared
 *   representation; a synthetic view is not one, even when it happens to
 *   share the declared representation's media type or a negotiated
 *   Accept-Profile matched 'self'. Suppresses BOTH the explicit
 *   `chosenProfile` and the derived `defaultProfileFor` stamp — but
 *   `representationLinks` (rel="canonical"/"alternate") still gets emitted,
 *   since advertising what representations exist is still honest.
 * @returns {object}
 */
export function getAllHeaders({ isContainer = false, etag = null, contentType = null, origin = null, resourceUrl = null, wacAllow = null, connegEnabled = false, mashlibEnabled = false, lwsEnabled = false, updatesVia = null, chosenProfile = null, representations = null, storageRootPath = null, storageOwners = null, syntheticView = false }) {
  const headers = {
    ...getResponseHeaders({ isContainer, etag, contentType, resourceUrl, wacAllow, connegEnabled, mashlibEnabled, lwsEnabled, updatesVia }),
    ...getCorsHeaders(origin)
  };
  if (lwsEnabled && resourceUrl) {
    // R1/R2: up + type in the HTTP Link header, derived by the SAME helpers as
    // the linkset body (parentContainerUrl / Container-vs-DataResource) so the
    // two surfaces can never disagree.
    const parts = [
      `<${LWS_NS}${isContainer ? 'Container' : 'DataResource'}>; rel="type"`,
      `<${storageDescriptionUrl(resourceUrl, storageRootPath)}>; rel="${LWS_STORAGE_DESC_REL}"`,
      `<${resourceUrl}>; rel="linkset"; type="application/linkset+json"`
    ];
    const parent = parentContainerUrl(resourceUrl);
    if (parent) parts.unshift(`<${parent}>; rel="up"`);
    // Solid Protocol: when a server advertises the owner of a storage it MUST
    // use this Link relation on the root container. Only ever non-null on the
    // storage root itself (server.js onRequest), so members never carry it.
    if (storageOwners?.length) {
      parts.push(...storageOwners.map((o) => `<${o}>; rel="http://www.w3.org/ns/solid/terms#owner"`));
    }
    const extra = parts.join(', ');
    headers['Link'] = headers['Link'] ? `${headers['Link']}, ${extra}` : extra;
  }
  // Profile claims bind to a declared representation; a server-rendered
  // VIEW of the resource (the navigator's entity face, ?view=nav) is not
  // one — never stamp on it, neither the explicit negotiated outcome nor
  // the derived default. representationLinks below still runs regardless.
  const stampProfile = syntheticView ? null : (chosenProfile || defaultProfileFor(representations, contentType));
  if (stampProfile) {
    const profileLink = `<${stampProfile}>; rel="profile"`;
    headers['Content-Profile'] = `<${stampProfile}>`;
    headers['Link'] = headers['Link'] ? `${headers['Link']}, ${profileLink}` : profileLink;
  }
  const repLinks = representationLinks(representations);
  if (repLinks) {
    headers['Link'] = headers['Link'] ? `${headers['Link']}, ${repLinks}` : repLinks;
  }
  return headers;
}

/**
 * Get headers for 404 responses (non-existent resources)
 * These headers tell clients what methods are supported for creating the resource
 * @param {object} options
 * @returns {object}
 */
export function getNotFoundHeaders({ resourceUrl = null, origin = null, connegEnabled = false, mashlibEnabled = false, lwsEnabled = false }) {
  // Determine if this would be a container based on URL ending with /
  const isContainer = resourceUrl?.endsWith('/') || false;
  const aclUrl = resourceUrl ? getAclUrl(resourceUrl, isContainer) : null;

  // Get Accept-* headers
  const acceptHeaders = getAcceptHeaders(connegEnabled, isContainer, lwsEnabled);

  const headers = {
    ...getCorsHeaders(origin),
    'Link': aclUrl ? `<${aclUrl}>; rel="acl"` : '',
    'Accept-Patch': acceptHeaders['Accept-Patch'],   // lws-aware (adds merge-patch under --lws)
    'Accept-Put': acceptHeaders['Accept-Put'] || 'application/ld+json, */*',
    'Allow': 'GET, HEAD, PUT, PATCH, OPTIONS' + (isContainer ? ', POST' : ''),
    'Vary': getVaryHeader(connegEnabled, mashlibEnabled)
  };

  if (isContainer && acceptHeaders['Accept-Post']) {
    headers['Accept-Post'] = acceptHeaders['Accept-Post'];
  }

  return headers;
}

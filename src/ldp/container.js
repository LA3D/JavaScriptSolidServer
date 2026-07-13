/**
 * Generate container representation as JSON-LD
 */

import { getContentType } from '../utils/url.js';

const LDP = 'http://www.w3.org/ns/ldp#';

// System-Managed derived-metadata sidecars — NEVER LDP members. Deliberately
// NARROWER than storage's AUX_SUFFIX: `.acl`/`.meta` are client-managed
// per-resource auxiliaries that DO appear as members with their own mediaTypes
// (DT7, pinned by lws-items-mediatype.test.js) and are WAC-filtered per member
// by S1. `.lwstypes`/`.lwsprov` are server-derived, public-read by container
// inheritance, and were the actual leak vector — a private resource's name
// escaping into an anonymous listing via its sidecar (2026-07-13).
const SYS_SIDECAR = /\.(lwstypes|lwsprov)$/;

// Dotfiles allowed to appear in ldp:contains. Anything else starting with '.'
// is server-internal state and must not leak into container listings — even
// when direct GETs are 403'd by the routing-layer dotfile guard in server.js
// (which rejects non-allowlisted dotpaths before WAC even runs), listing the
// *name* still leaks existence and gives attackers free path-fingerprinting
// (#350).
//
// `.well-known` is allowed because JSS exposes legitimate public resources
// there (e.g. the webledger registry at /.well-known/webledgers/...). At the
// origin root — including each pod's own origin in subdomain mode — server.js
// bypasses auth for `/.well-known/*` per RFC 8615. For path-based pods at
// `/pod/.well-known/`, the bypass does *not* apply (it matches root-relative
// paths only) — that case is a regular subdirectory governed by ordinary WAC,
// and listing the name is fine. We allow `.well-known` uniformly here so the
// subdomain-pod and root-pod cases work without conditional logic on the
// container path.
//
// Internal state that JSS currently persists under `.well-known/` (token
// store, pay state) shouldn't be in a public namespace at all; tracked at
// #358.
//
// `.acl` and `.meta` are canonical Solid per-resource sidecars.
const ALLOWED_DOTFILES = new Set(['.acl', '.meta', '.well-known']);

function isHiddenEntry(name) {
  // Bare container-level sidecars (literal '.acl'/'.meta'/'.well-known') stay
  // governed by ALLOWED_DOTFILES — CONTROL-holder visibility unchanged.
  if (ALLOWED_DOTFILES.has(name)) return false;
  if (name.startsWith('.')) return true;
  // System-Managed suffix sidecars (x.jsonld.lwstypes/.lwsprov, incl.
  // sidecar-of-a-sidecar like x.jsonld.acl.lwstypes) are never members and
  // were the listing-leak vector — hide them. Client-managed x.jsonld.acl /
  // x.jsonld.meta stay listed (DT7), WAC-filtered per member by S1.
  return SYS_SIDECAR.test(name);
}

/**
 * Generate JSON-LD representation of a container
 * @param {string} containerUrl - Full URL of the container
 * @param {Array<{name: string, isDirectory: boolean}>} entries - Container contents
 * @returns {object} - JSON-LD representation
 */
export function generateContainerJsonLd(containerUrl, entries) {
  // Ensure container URL ends with /
  const baseUrl = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';

  const contains = entries.filter(entry => !isHiddenEntry(entry.name)).map(entry => {
    const childUrl = baseUrl + entry.name + (entry.isDirectory ? '/' : '');
    const item = {
      '@id': childUrl,
      '@type': entry.isDirectory ? [`${LDP}Container`, `${LDP}BasicContainer`, `${LDP}Resource`] : [`${LDP}Resource`]
    };
    if (entry.size != null) item['stat:size'] = entry.size;
    if (entry.modified) item['dcterms:modified'] = entry.modified;
    return item;
  });

  return {
    '@context': {
      'ldp': LDP,
      'stat': 'http://www.w3.org/ns/posix/stat#',
      'dcterms': 'http://purl.org/dc/terms/',
      'contains': { '@id': 'ldp:contains', '@type': '@id' }
    },
    '@id': baseUrl,
    '@type': ['ldp:Container', 'ldp:BasicContainer', 'ldp:Resource'],
    'contains': contains
  };
}

/**
 * Convert JSON-LD to string
 * @param {object} jsonLd
 * @returns {string}
 */
export function serializeJsonLd(jsonLd) {
  return JSON.stringify(jsonLd, null, 2);
}

const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

/**
 * Generate the W3C LWS container representation (application/lws+json).
 * Additive sibling of generateContainerJsonLd — items[] instead of ldp:contains.
 * Pagination deferred: emits the full membership as a single page.
 * @param {string} containerUrl
 * @param {Array<{name:string,isDirectory:boolean,size?:number,modified?:string}>} entries
 * @returns {object}
 */
export function generateLwsContainer(containerUrl, entries) {
  const baseUrl = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';
  // LWS excludes all dotfiles (including sidecars like .acl, .meta) from listing
  // Deliberately excludes all dotfiles (unlike isHiddenEntry which allows .acl/.meta/.well-known) — LWS hides sidecars
  // Also excludes System-Managed suffix sidecars (x.jsonld.lwstypes/.lwsprov)
  // that don't start with '.' — the same leak isHiddenEntry closes. Suffix
  // .acl/.meta stay (DT7, pinned by lws-items-mediatype.test.js) (2026-07-13).
  const items = entries.filter(e => !e.name.startsWith('.') && !SYS_SIDECAR.test(e.name)).map(e => {
    const id = baseUrl + e.name + (e.isDirectory ? '/' : '');
    const item = { id, type: e.isDirectory ? 'Container' : 'DataResource' };
    if (!e.isDirectory) item.mediaType = getContentType(e.name);
    if (e.size != null) item.size = e.size;
    if (e.modified) item.modified = e.modified;
    return item;
  });
  // TODO(lws-pagination): emit ContainerPage with first/next/prev/last when membership is large.
  return { '@context': LWS_CONTEXT, id: baseUrl, type: 'Container', totalItems: items.length, items };
}

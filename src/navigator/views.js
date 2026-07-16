// src/navigator/views.js
// Server-rendered navigator chrome + container view (spec 2026-07-15, Task
// 5): the typed, WAC-filtered HTML listing that replaces mashlib for
// containers once --lws is on. This module is pure rendering — no I/O, no
// authz — the caller (src/handlers/resource.js) supplies already-filtered
// items. ESM to match this repo's src/ convention (src/utils/html.js).
//
// navPage/crumbHtml are exported for reuse by the entity/resource views
// (Tasks 6-7) so every navigator page shares one chrome + breadcrumb.
import { escapeHtml as esc } from '../utils/html.js';

const CSS = `:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--muted:#666;--line:#ddd}
@media(prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#121212;--muted:#999;--line:#333}}
body{color:var(--fg);background:var(--bg);font:15px/1.5 system-ui,sans-serif;max-width:72ch;margin:2rem auto;padding:0 1rem}
a{color:hsl(210 70% 45%)}nav.crumb{font-size:.85rem;color:var(--muted)}nav.crumb a{color:inherit}
table{border-collapse:collapse;width:100%}td,th{padding:.35rem .5rem;border-bottom:1px solid var(--line);text-align:left}
.badge{display:inline-block;padding:0 .5rem;border-radius:1rem;font-size:.75rem;background:hsl(var(--h) 60% 88%);color:hsl(var(--h) 60% 25%)}
@media(prefers-color-scheme:dark){.badge{background:hsl(var(--h) 40% 25%);color:hsl(var(--h) 60% 85%)}}
.muted{color:var(--muted);font-size:.85rem}`;

const hueOf = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const localName = (t) => String(t).replace(/^.*[#/:]/, '');
const badge = (t) => `<span class="badge" style="--h:${hueOf(localName(t))}">${esc(localName(t))}</span>`;

// Leading crumb (Task A10, multi-tenant round): with a storageRootPath
// (request.storageRootPath, A2/A6), the first segment links to the OWNING
// STORAGE's own root (`/<pod>/?view=nav`) and subsequent segments are the
// path AFTER that root — every navigator page under a storage roots its
// chrome at that storage, not a single hardcoded pod. Without one (server
// scope — no storage owns this path, e.g. a bare top-level resource) the
// first segment falls back to `server` -> `/?view=nav`, the WAC-filtered
// roster of every storage the pod hosts (renderServerIndexView below).
export function crumbHtml(url, storageRootPath = null) {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  if (storageRootPath) {
    const rootSegs = storageRootPath.split('/').filter(Boolean);
    const podName = rootSegs[0] ?? storageRootPath;
    const restSegs = segs.slice(rootSegs.length);
    const parts = [`<a href="${esc(storageRootPath)}?view=nav">${esc(podName)}</a>`];
    let p = storageRootPath.replace(/\/$/, '');
    for (let i = 0; i < restSegs.length; i++) {
      p += `/${restSegs[i]}`;
      parts.push(i === restSegs.length - 1 ? esc(restSegs[i]) : `<a href="${esc(p)}/">${esc(restSegs[i])}</a>`);
    }
    return parts.join(' › ');
  }
  const parts = [`<a href="/?view=nav">server</a>`];
  let p = '';
  for (let i = 0; i < segs.length; i++) {
    p += `/${segs[i]}`;
    parts.push(i === segs.length - 1 ? esc(segs[i]) : `<a href="${esc(p)}/">${esc(segs[i])}</a>`);
  }
  return parts.join(' › ');
}

export function navPage(title, crumb, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${CSS}</style></head>` +
    `<body><nav class="crumb">${crumb}</nav>\n${body}\n</body></html>`;
}

// items: [{ id, type:'Container'|'DataResource', mediaType?, size?, modified?, rdfTypes?:[], faces?:[{href,format}] }]
// Every substrate-controlled string (member id/name, rdfTypes, face hrefs/
// formats, mediaType, conformsTo URIs) is escaped — this listing is
// server-rendered from client-supplied names and declared metadata.
export function renderContainerView({ url, items, conformsTo = [], storageRootPath = null }) {
  const base = url.endsWith('/') ? url : url + '/';
  const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '/';
  const prof = conformsTo.length
    ? `<p class="muted">profile: ${conformsTo.map((c) => `<a href="${esc(c)}">${esc(localName(c))}</a>`).join(', ')}</p>`
    : '';
  const rows = items.map((it) => {
    const relName = it.id.startsWith(base) ? it.id.slice(base.length) : it.id;
    const badges = (it.rdfTypes ?? []).map(badge).join(' ');
    // Final-review minor: filter falsy formats BEFORE mapping — a face whose
    // .meta rep node carries no dct:format (repFrom in
    // src/lws/representations.js defaults format to null) must be omitted,
    // not rendered as a literal "null"/"undefined" label.
    const faces = (it.faces ?? []).filter((f) => f.format)
      .map((f) => `<a href="${esc(f.href)}">${esc(f.format)}</a>`).join(' · ');
    const meta = [it.mediaType, it.size, it.modified].filter(Boolean).map(esc).join(' · ');
    return `<tr><td><a href="${esc(it.id)}">${esc(relName)}</a></td><td>${badges}</td><td>${faces}</td><td class="muted">${meta}</td></tr>`;
  }).join('\n');
  return navPage(name, crumbHtml(url, storageRootPath),
    `<h1>${esc(name)}/</h1>${prof}<table><tr><th>name</th><th>types</th><th>open with</th><th></th></tr>${rows}</table>` +
    `<p class="muted"><a href="${esc(url)}">machine view</a></p>`);
}

// Generic entity face (Task 6, spec 2026-07-15): the server-rendered HTML
// view for a FILE with no declared text/html alternate — replaces mashlib
// for files once --lws is on, mirroring renderContainerView's role for
// containers. Every substrate-controlled string (types, conformsTo/
// describedby URIs, provenance lines, mediaType, alternate hrefs/formats,
// the stored-bytes excerpt) is escaped — this view is server-rendered from
// client-declared/stored data (caller's job to bound the excerpt size).
export function renderEntityView({ url, types = [], conformsTo = [], describedby = [], provenance = [], reps = { alternates: [] }, mediaType = '', excerpt = '', storageRootPath = null }) {
  const name = new URL(url).pathname.split('/').pop() || url;
  const rows = [
    types.length ? `<dt>types</dt><dd>${types.map(badge).join(' ')}</dd>` : '',
    conformsTo.length ? `<dt>conformsTo</dt><dd>${conformsTo.map((c) => `<a href="${esc(c)}">${esc(c)}</a>`).join('<br>')}</dd>` : '',
    provenance.length ? `<dt>earned</dt><dd>${provenance.map((p) => esc(p)).join('<br>')}</dd>` : '',
    describedby.length ? `<dt>shapes</dt><dd>${describedby.map((d) => `<a href="${esc(d)}">${esc(d)}</a>`).join('<br>')}</dd>` : '',
    `<dt>media type</dt><dd>${esc(mediaType)}</dd>`,
    `<dt>machine views</dt><dd><a href="${esc(url)}">raw</a>${(reps.alternates ?? []).map((r) =>
      ` · <a href="${esc(r.href)}">${esc(r.format || r.href)}</a>`).join('')}</dd>`
  ].filter(Boolean).join('\n');
  const prev = excerpt ? `<h2>preview</h2><pre style="white-space:pre-wrap;border:1px solid var(--line);padding:.5rem">${esc(excerpt)}</pre>` : '';
  return navPage(name, crumbHtml(url, storageRootPath), `<h1>${esc(name)}</h1><dl class="meta">${rows}</dl>${prev}`);
}

// Root/storage view (Task 7, spec 2026-07-15; per-storage as of Task A10,
// multi-tenant round): the navigator's landing page for a SINGLE storage
// root, reached only via the explicit `/<pod>/?view=nav` escape (the seeded
// index.html shadow keeps serving plain `GET /` at the server root,
// deviation (4); src/handlers/resource.js wires the view choice). Renders
// that storage's own LWS storage description (services/capabilities/
// uriSpace prefixes — the same buildStorageDescriptionFor the per-storage
// `/<pod>/lws-storage` route serves) beside its WAC-filtered top-level
// listing, instead of the generic renderContainerView Task 5 renders for
// every other container. sd.id is this storage's own root URL (trailing
// slash) — crumbHtml derives both the pod name and the chrome's own link
// from it, so this view's breadcrumb is identical in shape to every other
// page under this storage (crumbHtml's own-root case: just the one linked
// segment, matching how the pre-multi-tenant 'pod' crumb rooted at `/`).
// Every substrate-controlled string (service types, service endpoints,
// capability types, uriSpace values, top-level member ids) is escaped — sd
// is built from pod-config + server enablement flags, items come from the
// same WAC-filtered listing the container view uses.
export function renderRootView({ origin, sd, items }) {
  const rootPath = new URL(sd.id).pathname;
  const podName = rootPath.split('/').filter(Boolean)[0] || rootPath;
  const cap = (sd.capability ?? []).map((c) => `<li>${esc(c.type ?? c.id ?? '')}${
    c.uriSpace ? ` — uriSpace: ${[].concat(c.uriSpace).map(esc).join(', ')}` : ''}</li>`).join('');
  const svc = (sd.service ?? []).map((s) => `<li><a href="${esc(s.serviceEndpoint ?? s.id ?? '#')}">${esc(s.type ?? s.id ?? s.serviceEndpoint)}</a></li>`).join('');
  const list = items.map((it) => `<li><a href="${esc(it.id)}">${esc(it.id)}</a></li>`).join('');
  return navPage(podName, crumbHtml(sd.id, rootPath),
    `<h1>${esc(origin)}${esc(rootPath)}</h1><h2>Storage</h2><ul>${svc}</ul>` +
    (cap ? `<h2>Capabilities</h2><ul>${cap}</ul>` : '') +
    `<h2>Containers</h2><ul>${list}</ul>` +
    `<p class="muted"><a href="${esc(rootPath)}lws-storage">machine view</a></p>`);
}

// Server index view (Task A10, multi-tenant round): the navigator's landing
// page for the SERVER root (`/?view=nav`) — a WAC-filtered roster of every
// storage this pod hosts (listVisibleStorageRoots, A5), one row per storage
// linking to that storage's own root view (`/<pod>/?view=nav`, renderRootView
// above). Replaces the single-storage renderRootView that used to live at
// `/?view=nav` pre-multi-tenant — that per-storage content now lives one
// level down, at each storage's own root. Pure rendering, same discipline as
// every other view here: `storages` is already WAC-filtered by the caller
// (src/handlers/resource.js), this function only escapes and lays out.
export function renderServerIndexView({ origin, storages }) {
  const rows = (storages ?? []).map((s) => {
    const name = s.root.split('/').filter(Boolean)[0] || s.root;
    return `<li><a href="${esc(origin)}${esc(s.root)}?view=nav">${esc(name)}</a></li>`;
  }).join('');
  return navPage('server', crumbHtml(`${origin}/`),
    `<h1>${esc(origin)}</h1><h2>Storages</h2><ul>${rows}</ul>` +
    `<p class="muted"><a href="/.well-known/lws-storage">machine view</a></p>`);
}

// Entity-face content-type gate (review fix, spec 2026-07-15): the default
// (no ?view=nav) entity face renders only for data types a browser can't
// already render natively — mirrors mashlib's viewable-content-type set
// (src/mashlib/index.js shouldServeMashlib) for the file case, plus
// n-quads (mashlib has no pane for it either, but the entity face has no
// panes to begin with — it's a metadata page, not a data browser) and the
// general text/* family. image/video/audio/pdf/octet-stream/etc. are
// EXCLUDED on purpose — those fall through to the pre-Task-6 raw serving
// path so the browser renders them natively (src/mashlib/index.js:380-382
// is the precedent this restores). Callers still force the entity face for
// ANY type when the request is explicit (?view=nav) — this predicate only
// gates the default.
const ENTITY_FACE_DATA_TYPES = new Set([
  'text/turtle',
  'application/ld+json',
  'application/json',
  'text/n3',
  'application/n-triples',
  'application/n-quads',
  'application/rdf+xml',
  'text/markdown',
]);

// text/html (and xhtml) are excluded from the text/* fallback: an HTML
// page IS its own human face — wrapping it in the metadata view would (a)
// hide a stored .html page behind its own facts and (b) break the Task-4
// declared-face chain (browser GET card.md → 303 → card.md.html must land
// on the face itself, not its entity wrapper). ?view=nav still shows
// their metadata on request.
const ENTITY_FACE_EXCLUDED = new Set(['text/html', 'application/xhtml+xml']);

export function entityFaceViewable(contentType) {
  const baseType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ENTITY_FACE_EXCLUDED.has(baseType)) return false;
  return ENTITY_FACE_DATA_TYPES.has(baseType) || baseType.startsWith('text/');
}

export { badge, localName, hueOf, esc };

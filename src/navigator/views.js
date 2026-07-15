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

// Root segment links `/?view=nav` — every navigator page's chrome offers a
// way back to the pod-root navigator view (Tasks 6-7 reuse this).
export function crumbHtml(url) {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  const parts = [`<a href="/?view=nav">pod</a>`];
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
export function renderContainerView({ url, items, conformsTo = [] }) {
  const base = url.endsWith('/') ? url : url + '/';
  const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '/';
  const prof = conformsTo.length
    ? `<p class="muted">profile: ${conformsTo.map((c) => `<a href="${esc(c)}">${esc(localName(c))}</a>`).join(', ')}</p>`
    : '';
  const rows = items.map((it) => {
    const relName = it.id.startsWith(base) ? it.id.slice(base.length) : it.id;
    const badges = (it.rdfTypes ?? []).map(badge).join(' ');
    const faces = (it.faces ?? []).map((f) => `<a href="${esc(f.href)}">${esc(f.format)}</a>`).join(' · ');
    const meta = [it.mediaType, it.size, it.modified].filter(Boolean).map(esc).join(' · ');
    return `<tr><td><a href="${esc(it.id)}">${esc(relName)}</a></td><td>${badges}</td><td>${faces}</td><td class="muted">${meta}</td></tr>`;
  }).join('\n');
  return navPage(name, crumbHtml(url),
    `<h1>${esc(name)}/</h1>${prof}<table><tr><th>name</th><th>types</th><th>open with</th><th></th></tr>${rows}</table>` +
    `<p class="muted"><a href="${esc(url)}">machine view</a></p>`);
}

export { badge, localName, hueOf, esc };

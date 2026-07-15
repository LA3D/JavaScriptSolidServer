// Shared HTML escaping for server-rendered views (navigator + face dispatch,
// spec 2026-07-15). ESM to match this repo's src/ module convention.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const LWS_NS = 'https://www.w3.org/ns/lws#';

export class FilterError extends Error {
  constructor(msg) { super(msg); this.name = 'FilterError'; this.status = 400; }
}

export function isAbsoluteUri(s) {
  if (typeof s !== 'string' || !s) return false;
  try { const u = new URL(s); return !!u.protocol && u.href.includes(':'); }
  catch { return false; }
}

// One OR-group from a comma list; drops empties/dupes; validates absolute URIs.
function group(values) {
  const out = [];
  for (const raw of values) {
    if (typeof raw !== 'string') throw new FilterError('type value must be a string');
    const v = raw.trim();
    if (!v) continue;                              // empty → ignored
    if (!isAbsoluteUri(v)) throw new FilterError(`type value is not an absolute URI: ${v}`);
    if (!out.includes(v)) out.push(v);             // dedupe within group
  }
  return out;
}

// GET query (URLSearchParams) OR POST body ({ type: (string|string[])[] }) → CNF string[][].
export function parseTypeFilter({ query, body } = {}) {
  const cnf = [];
  if (query) {
    for (const param of query.getAll('type')) {
      const g = group(param.split(','));
      if (g.length) cnf.push(g);                   // empty group → ignored
    }
    return cnf;
  }
  if (body && body.type !== undefined) {
    if (!Array.isArray(body.type)) throw new FilterError('body.type must be an array');
    for (const el of body.type) {
      if (typeof el === 'string') { const g = group([el]); if (g.length) cnf.push(g); }
      else if (Array.isArray(el)) { const g = group(el); if (g.length) cnf.push(g); }
      else throw new FilterError('each body.type element must be a string or array of strings');
    }
    return cnf;
  }
  return cnf;                                      // no filter → match all
}

// CNF: every group must have at least one member present in the resource's types.
export function matchesTypeFilter(types, cnf) {
  return cnf.every((g) => g.some((t) => types.includes(t)));
}

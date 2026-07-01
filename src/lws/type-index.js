export const LWS_NS = 'https://www.w3.org/ns/lws#';

export const MAX_GROUPS = 32;
export const MAX_VALUES_PER_GROUP = 64;
export const MAX_TOTAL_TERMS = 256;

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
  let total = 0;
  if (query) {
    for (const param of query.getAll('type')) {
      const values = param.split(',');
      if (values.length > MAX_VALUES_PER_GROUP) throw new FilterError('too many type values in one group');
      const g = group(values);
      if (g.length) {
        if (cnf.length >= MAX_GROUPS) throw new FilterError('too many type groups');
        total += g.length;
        if (total > MAX_TOTAL_TERMS) throw new FilterError('too many type terms');
        cnf.push(g);
      }
    }
    return cnf;
  }
  if (body && body.type !== undefined) {
    if (!Array.isArray(body.type)) throw new FilterError('body.type must be an array');
    for (const el of body.type) {
      let values;
      if (typeof el === 'string') values = [el];
      else if (Array.isArray(el)) values = el;
      else throw new FilterError('each body.type element must be a string or array of strings');

      if (values.length > MAX_VALUES_PER_GROUP) throw new FilterError('too many type values in one group');
      const g = group(values);
      if (g.length) {
        if (cnf.length >= MAX_GROUPS) throw new FilterError('too many type groups');
        total += g.length;
        if (total > MAX_TOTAL_TERMS) throw new FilterError('too many type terms');
        cnf.push(g);
      }
    }
    return cnf;
  }
  return cnf;                                      // no filter → match all
}

// CNF: every group must have at least one member present in the resource's types.
export function matchesTypeFilter(types, cnf) {
  return cnf.every((g) => g.some((t) => types.includes(t)));
}

const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

export function intrinsicType(isDirectory) {
  return LWS_NS + (isDirectory ? 'Container' : 'DataResource');
}

export function resourceTypes({ isDirectory, declared = [] }) {
  const out = [intrinsicType(isDirectory)];
  for (const t of declared) if (!out.includes(t)) out.push(t);
  return out;
}

// ContainerPage item `type` must present the intrinsic LWS class compactly
// ("Container"/"DataResource") while leaving user-defined types as full URIs.
// Filter/matching (matchesTypeFilter) still operates on full URIs — this is
// output presentation only.
const COMPACT_INTRINSIC = {
  [LWS_NS + 'Container']: 'Container',
  [LWS_NS + 'DataResource']: 'DataResource',
};

export function containerItemTypes(types) {
  return types.map((t) => COMPACT_INTRINSIC[t] ?? t);
}

export function buildTypeIndex(typeLists) {
  const seen = new Set();
  for (const list of typeLists) for (const t of list) seen.add(t);
  return {
    '@context': LWS_CONTEXT,
    type: 'TypeIndex',
    totalItems: seen.size,
    items: [...seen].map((id) => ({ id })),
  };
}

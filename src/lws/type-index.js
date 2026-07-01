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

// GET query (URLSearchParams) OR POST body → the type CNF only (back-compat).
export function parseTypeFilter(args) {
  return parseFilter(args).type;
}

// CNF: every group must have at least one member present in the resource's types.
export function matchesTypeFilter(types, cnf) {
  return cnf.every((g) => g.some((t) => types.includes(t)));
}

export const INDEXED_RELATIONS = new Set(['describedby']);
const RESERVED_QUERY_KEYS = new Set(['page']);   // pagination refs, not relation filters

// Push comma/array raw groups into `cnf`, enforcing the shared budget.
function pushGroups(cnf, rawGroups, budget) {
  for (const values of rawGroups) {
    if (values.length > MAX_VALUES_PER_GROUP) throw new FilterError('too many values in one group');
    const g = group(values);                       // trims, dedupes, validates absolute URIs
    if (!g.length) continue;                        // empty group ignored
    if (budget.groups >= MAX_GROUPS) throw new FilterError('too many groups');
    budget.groups++;
    budget.terms += g.length;
    if (budget.terms > MAX_TOTAL_TERMS) throw new FilterError('too many terms');
    cnf.push(g);
  }
}

function groupsFromQuery(query, key) {
  return query.getAll(key).map((param) => param.split(','));
}
function groupsFromBody(val, label) {
  if (!Array.isArray(val)) throw new FilterError(`body.${label} must be an array`);
  return val.map((el) => {
    if (typeof el === 'string') return [el];
    if (Array.isArray(el)) return el;
    throw new FilterError(`each body.${label} element must be a string or array of strings`);
  });
}

// Generalized filter: `type` + any indexed relation key, one shared CNF budget.
// Unknown/unindexed non-reserved keys set hasUnindexed (→ empty result, not an error).
export function parseFilter({ query, body } = {}) {
  const budget = { groups: 0, terms: 0 };
  const type = [];
  const relations = {};
  let hasUnindexed = false;

  const keys = query
    ? new Set([...query.keys()])
    : new Set(Object.keys(body || {}).filter((k) => k !== '@context'));

  for (const key of keys) {
    if (query && RESERVED_QUERY_KEYS.has(key)) continue;
    const raw = query ? groupsFromQuery(query, key) : groupsFromBody(body[key], key);
    if (key === 'type') {
      pushGroups(type, raw, budget);
    } else if (INDEXED_RELATIONS.has(key)) {
      pushGroups(relations[key] || (relations[key] = []), raw, budget);
    } else {
      hasUnindexed = true;                          // no-oracle: constraint matches nothing
    }
  }
  return { type, relations, hasUnindexed };
}

// True iff hasUnindexed is false AND the type CNF AND every relation CNF hold.
export function matchesFilter(resource, filter) {
  if (filter.hasUnindexed) return false;
  if (!matchesTypeFilter(resource.types, filter.type)) return false;
  for (const [rel, cnf] of Object.entries(filter.relations)) {
    if (!matchesTypeFilter((resource.relations && resource.relations[rel]) || [], cnf)) return false;
  }
  return true;
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

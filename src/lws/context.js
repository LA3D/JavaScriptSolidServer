// Resolvable mirror of the LWS JSON-LD context/vocab. www.w3.org/ns/lws/v1 404s
// today; until W3C mints it, the pod serves this so a cold agent can resolve
// terms (design §6). Term targets stay the CANONICAL www.w3.org/ns/lws# URIs,
// so the mirror retires cleanly when W3C publishes.
export const LWS_CONTEXT_OBJECT = {
  '@version': 1.1, '@protected': true,
  lws: 'https://www.w3.org/ns/lws#', as: 'https://www.w3.org/ns/activitystreams#',
  schema: 'https://schema.org/', xs: 'http://www.w3.org/2001/XMLSchema#',
  solid: 'http://www.w3.org/ns/solid/terms#',
  id: '@id', type: '@type',
  Container: 'lws:Container', DataResource: 'lws:DataResource', Storage: 'lws:Storage',
  owner: { '@id': 'solid:owner', '@type': '@id', '@container': '@set' },
  provider: { '@id': 'schema:provider', '@type': '@id' },
  items: 'lws:items', totalItems: 'as:totalItems', mediaType: 'as:mediaType',
  size: { '@id': 'schema:size', '@type': 'xs:long' },
  modified: { '@id': 'as:updated', '@type': 'xs:dateTime' },
};

export const LWS_VOCAB = {
  '@context': { rdfs: 'http://www.w3.org/2000/01/rdf-schema#', lws: 'https://www.w3.org/ns/lws#' },
  '@graph': [
    { '@id': 'lws:Container', 'rdfs:comment': 'A resource that contains other resources.' },
    { '@id': 'lws:DataResource', 'rdfs:comment': 'A data-bearing resource.' },
    { '@id': 'lws:items', 'rdfs:comment': 'The list of resources contained in a container.' },
    { '@id': 'lws:storageDescription', 'rdfs:comment': 'Link to the storage description resource.' },
  ],
};

export function withInlineContext(rep) {
  if (rep && rep['@context'] === 'https://www.w3.org/ns/lws/v1') {
    return { ...rep, '@context': LWS_CONTEXT_OBJECT };
  }
  return rep;
}

# MCP — pod as a tool surface for agents

JSS speaks the [Model Context Protocol](https://modelcontextprotocol.io). Once `--mcp` is enabled, any MCP-compatible client — Claude Desktop, Cursor, custom agents — can register your pod as a tool surface and read/write resources under the same WAC rules as any HTTP client.

> **Thesis**: MCP needs a backend. Solid is the backend.

> **v2 (Resource Gateway).** The MCP surface follows the Resource-Gateway pattern: **reads are MCP Resources** (addressed by the pod's real `https://` URLs, dispatched on the resource itself), **mutations and parameterized queries are Tools** (10 total). This keeps the tool count under the selection-accuracy budget (~10–15 tools), lets the client browse the read surface as resources, and routes SHACL admission failures back as teaching content the model can read and act on. This is a hard break from the earlier flat tool dump — the old read tools (`head_resource`, `read_acl`, `get_skill`, `list_skills`, `get_pod_skill`, `pod_info`, `lws_linkset`, `lws_storage_description`, `list_docs`, `read_docs`) no longer exist; their capability re-appears as Resources.

> **Model-driven read path.** MCP Resources are *application-driven* — the host stages them into context, not the model — so an autonomous agent that only gets Tools has no way to invoke `resources/read`/`resources/list` itself. `read_resource` and `list_resources` re-appear as Tools (a later round, folding in the retired `read_remote_resource`) as the model-callable twin of the Resources primitive: `read_resource({ uri })` is **one-Web** — a `uri` sharing this pod's origin dispatches through the same resolver as `resources/read`; any other origin is a federation-gated remote GET (see Federation below). Both the Resources primitive and these Tools stay live side by side.

## Quick start

```bash
jss start --idp --mcp --lws
```

The MCP endpoint is `POST /mcp` on your pod, speaking JSON-RPC 2.0 over MCP's Streamable HTTP transport (protocol version `2025-03-26`). The `initialize` result advertises both `tools` and `resources` capabilities. Note: `GET /mcp` returns **405 Method Not Allowed** with `Allow: POST` (not a 404) — the endpoint is read-only to POST.

### Smoke test

```bash
# Handshake — note capabilities.resources in the result
curl -s http://localhost:4443/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | jq '.result.capabilities'

# List the tools (10) and the resource templates
curl -s http://localhost:4443/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools[].name'
curl -s http://localhost:4443/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/templates/list"}' | jq '.result.resourceTemplates[].uriTemplate'

# Read a resource (anonymous read of a public container listing) — the real
# https:// URL, not a synthetic scheme
curl -s http://localhost:4443/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"https://localhost:4443/public/"}}' | jq
```

## Auth

The MCP endpoint reuses JSS's existing auth chain. Any token format JSS accepts on regular HTTP endpoints works here:

- **Bearer** — simple HMAC tokens from `POST /idp/credentials`
- **Solid-OIDC + DPoP** — for federated WebID identities
- **LWS-CID JWTs** — kid resolution via WebID profile
- **NIP-98** — Schnorr-signed Nostr events with `did:nostr:<pubkey>` identity

The MCP server extracts the WebID from the inbound request to `/mcp` itself. Every tool call **and every `resources/read`** is then WAC-checked against that WebID, on the resource path it touches. **There is no separate MCP auth layer** — granting an agent access to `/private/notes/` is the same operation as granting a human: edit the ACL. A Resource is not a bypass.

Anonymous requests get the same WAC treatment as any other anonymous request — public resources are reachable, private ones aren't. Reads WAC-check **before** touching storage, so a denied read is indistinguishable from not-found where existence itself is privileged (**no discovery oracle**).

`/mcp` is trust-aware rate-limited (anonymous per-IP, authenticated per-WebID), and honors the `mcpCredentialPolicy` seam (`trusted-local` by default; `audience-bound` refuses the replayable bearer, requiring LWS-CID or Solid-OIDC-DPoP).

## Resources (the read surface)

Reads are addressed by the pod's **real `https://` URLs** — there is no synthetic scheme. Fetch them with the MCP Resources methods: `resources/list` (the fixed `.well-known` resources), `resources/templates/list` (the one real-URI template), `resources/read` (`{ "uri": "https://<pod>/alice/notes/a" }`). Every read WAC-checks the target path and **sanitizes** externally-sourced content before returning it (see [Security](#security-content-sanitization)).

### Dispatch on the resource

There's no per-kind scheme to pick from — the resource's own shape decides what comes back:

| Resource | Returns | WAC |
|---|---|---|
| A container URL (trailing `/`) | `application/lws+json` container listing (`items[]`) | Read |
| `<X>.acl` | structured ACL view (agents, agentClasses, modes, isDefault) | **Control** |
| `<X>.meta` | resource metadata (size/modified) | Read |
| Any other resource | its body | Read |

Bodies preserve trust by content: JSON-LD/RDF-JSON comes back structured with its `@context` intact (leaf values sanitized, structure kept); anything else — opaque or free-text — is enveloped as untrusted data (see [Security](#security-content-sanitization)).

### Fixed resources

`resources/list` advertises these real `.well-known` URLs:

| URI | Returns |
|---|---|
| `https://<pod>/.well-known/lws-storage` | the LWS storage description (`type:Storage` + advertised services + storage root) |
| `https://<pod>/.well-known/mcp/pod-info` | pod identity + MCP capabilities + vocab/context locations + a steering hint |
| `https://<pod>/.well-known/mcp/skills` | skill index (WAC-filtered, no-oracle) |
| `https://<pod>/.well-known/lws/context` | the resolvable LWS JSON-LD `@context` mirror |
| `https://<pod>/.well-known/lws/vocab` | the LWS vocabulary |

**Templated:**

| URI template | Returns |
|---|---|
| `https://{+authority}/{+path}` | any pod resource, addressed by its real URL and dispatched per the table above |

Skills live at conventional paths the server walks: `<pod>/SKILL.md` (pod-wide), `<pod>/public/apps/<name>/SKILL.md` (per-app), `<pod>/private/bots/<name>/SKILL.md` (per-bot). Both `SKILL.md` (Anthropic markdown) and `SKILL.jsonld` (typed descriptor) are first-class via the `skill:format` declaration.

The RFC 9264 linkset is **not** a resource kind — it's returned by the `describe_resource` tool (one read: body + declared types + linkset together).

## Tools (mutations + queries + model-driven reads)

Ten tools: eight core + two convenience.

### Core

| Tool | Effect | WAC / gating |
|---|---|---|
| `write_resource` | PUT a resource (overwrites) | Write (parent fallback for new); routes through SHACL admission |
| `create_resource` | POST to a container (server mints name unless `slug`) | Append; routes through SHACL admission |
| `delete_resource` | DELETE a resource / empty container | Write |
| `write_acl` | persist a structured ACL to the resource's `.acl` | Control + anti-lockout |
| `lws_type_search` | CNF `type` (+ `describedby`) query, WAC-filtered, no-oracle | reuses the authorized-resources walk |
| `subscribe` | SSE stream of `resource_changed` events, WAC-filtered per event | Read per event |
| `read_resource` | Read any resource by its real `https://` URL — one-Web: this pod's own uri dispatches as a local read (same resolver as `resources/read`), any other origin is a federation-gated remote GET (incl. that pod's storage description). Returns two content blocks: body, then metadata `{ uri, mimeType, links }`. Local `links`: `up` (parent container), `storageDescription`, `describedby` (optional, from `.meta`). Remote `links`: `context`, `alternate`, `linkset` (from Link headers, passed through verbatim). | local: Read; remote: caller needs `acl:Write` on `<pod>/private/federation/`, depth-capped at 3 |
| `list_resources` | The model-callable twin of `resources/list` — this pod's fixed entry resources + the real-URI template. Returns metadata object with `resources` array (fixed entries like `storage-description`, `pod-info`, `skills`) and `templates` array (the real-URI template). | none (fixed, public shape) |

Writes (`write_resource`/`create_resource`, and `put_typed_resource` below) route through the shared LWS admission core (SHACL validation → write → type-capture) — the same enforcement path as HTTP PUT/POST. Pass a `types` array (the `Link: rel="type"` equivalent) to declare server-managed types.

### Convenience (composed)

| Tool | Composes |
|---|---|
| `put_typed_resource` | write body + capture `types` + optionally declare a `describedby` shape into the target `.meta`, in one call |
| `describe_resource` | one read returning body + declared types + linkset together |

### ACL editing

`write_acl` takes the structured form (bots don't hand-roll JSON-LD); read the current ACL via the resource's real `<path>.acl` URL (which returns the structured ACL view, gated on `Control`).

```json
// write_acl arguments
{
  "path": "/private/notes/",
  "authorizations": [
    { "agents": ["https://alice.example.com/profile#me"], "modes": ["Read", "Append"], "isDefault": true },
    { "agentClasses": ["acl:AuthenticatedAgent"], "modes": ["Read"] }
  ]
}
```

### Subscribe

`subscribe` switches the response to SSE (`text/event-stream`) and emits MCP notifications as resources change, WAC-filtered per event:

```bash
curl -N http://localhost:4443/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"subscribe","arguments":{"path":"/forum/channels/general/"}}}'
```

### Federation

Federation is a thin, affordance-driven read, not an RPC proxy: it's the remote arm of `read_resource({ uri })` — a `uri` on another pod's origin GETs that resource by its real URL — including that pod's `/.well-known/lws-storage` description — and returns the (deep-sanitized) representation. The agent then follows *that* pod's own typed links and `@context` to keep operating it, the same way it operates this one; there's no `{tool, arguments}` pair to forward.

Outbound calls are WAC-gated at the caller's own pod: the caller needs `acl:Write` on `<pod>/private/federation/`, and the call is depth-capped at 3 via the `MCP-Federation-Depth` header. Foreign WebIDs cannot initiate federation from this pod (no local gate path). A remote pod is the least-trusted content source, so the fetched body is deep-sanitized (`sanitizeDeep`) before it reaches the model.

## Error / teaching model

Failures come back as **structured content the model reads**, not exceptions or side-channel `data`. In particular, a SHACL **admission reject** (from `write_resource`/`create_resource`/`put_typed_resource`) returns `isError: true` with a `content[]` text that names the shape URI and each violation's `sh:message` (plus path/focusNode/value) — so an agent can read the constraint it broke and retry. This is the same teaching channel the HTTP path surfaces as a `400 + application/problem+json` body. `resources/read` failures return a JSON-RPC error whose message carries the reason (`access denied` / `unknown resource URI`).

## Security: content sanitization

All externally-sourced content — resource bodies, skill bodies, container child names, ACL agent strings — passes through a sanitizer before entering an MCP response. Hidden/control/bidi characters (including Trojan-Source isolates) are stripped, and free-text bodies are wrapped in a **nonce-fenced envelope** (`<<<BEGIN … nonce …>>>` / `<<<END … nonce …>>>`) so the model treats stored content as data, not instructions — and a hostile writer cannot forge the closing fence to break out. Server-generated JSON (linksets, storage description, metadata) is trusted and not enveloped; only the untrusted field values inside it are stripped. This closes the cross-agent "Unsanitized Resource Content" injection vector on a shared pod.

## Wiring Claude Desktop

Add an HTTP MCP server pointing at `http://localhost:4443/mcp`. For authenticated access, send `Authorization: Bearer <token>` (tokens from `POST /idp/credentials` or a compatible OIDC/DPoP flow).

## Footguns

### Use absolute WebIDs in `write_acl` agents

The `agents` array is a list of URIs. Relative paths resolve against the **.acl file's URL**, not the pod root:

```json
// Pod owner WebID: http://example.com/profile/card.jsonld#me, writing /public/forum/.acl:
{
  "agents": ["../profile/card.jsonld#me"],                 // wrong — /public/profile/...
  "agents": ["/profile/card.jsonld#me"],                   // right — absolute path
  "agents": ["http://example.com/profile/card.jsonld#me"]  // right — absolute URL, host-portable
}
```

### `write_acl` will refuse if you'd lock yourself out

If the proposed ACL doesn't grant `Control` to the caller, `write_acl` refuses. To transfer ownership: first grant Control to the new owner *in addition to* yourself, then have them `write_acl` removing you.

### Subscribe needs a keep-alive client

`subscribe` holds an SSE connection open indefinitely. Ensure your client handles SSE reconnect (raw `curl` does not).

## What's not included (yet)

- **`update_resource` (PATCH)** — SPARQL Update / N3 patches. Read-modify-write through the tools is the workaround.
- **`resources/list` child enumeration** — v1 lists fixed resources + templates only, not WAC-readable container children (deferred behind a page-bound).
- **Skills over the MCP Resources *primitive* (SEP-2640)** — skills are exposed as ordinary pod resources today (a skill file is read by its real `https://` URL); aligning to the experimental SEP is deferred until it stabilizes.
- **Authenticated federation reads** — `read_resource`'s remote arm fetches anonymously; it carries no per-call auth, so it can only see what the remote pod exposes to `foaf:Agent`/anonymous. Reading a remote agent-scoped resource is not yet supported.

## Why this exists

The agent ecosystem has no shared answer for sovereign, ACL-gated storage. Solid's pitch — user-owned data, queryable, access-controlled — is exactly what agents need; MCP is the wire. When JSS exposes `/mcp`:

- **Agent identity is a first-class WAC subject.** `acl:agent <did:nostr:...>` for a bot is the same operation as for a human.
- **The pod is the bot's world.** A bot reads its instructions from `SKILL.md`, browses the read surface as real-URL resources (following typed links + `@context`), and (with permission) writes back through the governed tools. No backend, no API key store — just the pod.
- **Bot-to-bot falls out of the protocol.** Two JSS pods can have their bots call each other's `/mcp`, gated by WAC on both ends.

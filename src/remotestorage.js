/**
 * remoteStorage plugin for JSS
 * Implements draft-dejong-remotestorage protocol on top of existing storage
 *
 * No new dependencies — reuses filesystem storage, OAuth, and WebFinger.
 * Always on — no flag needed.
 *
 * Ref: https://remotestorage.io/spec/draft-dejong-remotestorage-22
 * Related: #106, #160 (OAuth), #159 (Mastodon API)
 */

import * as storage from './storage/filesystem.js'
import { getContentType, auxSubject } from './utils/url.js'
import { getWebIdFromRequestAsync } from './auth/token.js'
import { checkAccess } from './wac/checker.js'
import { AccessMode } from './wac/parser.js'
import { checkIfMatch, checkIfNoneMatchForGet, checkIfNoneMatchForWrite } from './utils/conditional.js'

/**
 * remoteStorage Fastify plugin
 * @param {FastifyInstance} fastify
 * @param {object} options
 * @param {string} options.username - Storage owner username
 * @param {string} options.ownerWebId - WebID of the storage owner
 */
export async function remoteStoragePlugin (fastify, options = {}) {
  const username = options.username || 'me'
  const ownerWebId = options.ownerWebId || null

  /**
   * Extract the storage path from the URL
   * /storage/me/photos/vacation.jpg → /photos/vacation.jpg
   */
  function getStoragePath (request) {
    const wildcard = request.params['*'] || ''
    // Normalize double slashes (RS library appends path to href which ends with /)
    return ('/' + wildcard).replace(/\/\/+/g, '/')
  }

  /**
   * Check if the :user param matches the configured username
   */
  function checkUsername (request, reply) {
    if (request.params.user !== username) {
      reply.code(404).send({ error: 'Unknown user' })
      return false
    }
    return true
  }

  /**
   * Check if any path segment is a blocked dotfile
   */
  function hasDotfile (storagePath) {
    const segments = storagePath.split('/')
    return segments.some(s => s.startsWith('.') && s.length > 1)
  }

  /**
   * Check if request is authorized for the given method
   * Public folder is readable without auth
   */
  async function checkAuth (request, method) {
    const storagePath = getStoragePath(request)

    // Public folder: readable without auth
    if (storagePath.startsWith('/public/') && (method === 'GET' || method === 'HEAD')) {
      return { authorized: true, webId: null }
    }

    const { webId, error } = await getWebIdFromRequestAsync(request)
    if (!webId) {
      return { authorized: false, webId: null, error: error || 'Unauthorized', status: 401 }
    }

    // If ownerWebId is set, only the owner can access storage
    if (ownerWebId && webId !== ownerWebId) {
      return { authorized: false, webId, error: 'Forbidden', status: 403 }
    }

    return { authorized: true, webId }
  }

  /**
   * Sidecar authorization guard (SEC-1, 2026-07-22).
   *
   * remoteStorage reaches the SAME `./data` tree the Solid/WAC layer reads ACLs from, but
   * `checkAuth` above authorizes ANY authenticated WebID (ownerWebId is null — "single-user")
   * and never consults WAC. `hasDotfile` blocks only leading-dot segments, so a mid-name aux
   * suffix — `victim.acl` / `victim.meta` / `victim.lwstypes` / `victim.lwsprov` — sailed
   * through and PUT/DELETE/GET wrote/removed/read the sidecar directly. An authenticated
   * non-owner could therefore plant a self-granting `victim.acl`, strip a sibling's restrictive
   * one, or read any sidecar's contents — full escalation to Control of the subject.
   *
   * This is the 9th surface of the sidecar-authz class the 2026-07-21 round closed on HTTP + the
   * 4 MCP tools. It binds the sidecar op to the SUBJECT's ACL exactly as authorizeAclAccess /
   * authorizeSidecarAccess do on the main HTTP surface (src/auth/middleware.js). It authorizes
   * rather than blanket-blocks, so the owner (or any agent an ACL grants Control) keeps sidecar
   * management, while fail-closed-by-default (no applicable ACL → deny) matches a blocked pod.
   *
   * Classification runs off `auxSubject()` — the shared normalize-then-classify helper — so the
   * guard sees the node the storage layer will actually resolve, closing the percent-escape /
   * trailing-slash bypasses Task 7a round 2 found on the MCP surface.
   *
   * @returns {Promise<{authorized: boolean, status?: number, error?: string}>} authorized:true
   *   when the path is not a sidecar (the caller's checkAuth result stands) or the subject-mode
   *   WAC check passes.
   */
  async function checkSidecarAuth (request, storagePath, method, webId) {
    const sc = auxSubject(storagePath)
    if (!sc) return { authorized: true }

    const isRead = method === 'GET' || method === 'HEAD'

    // `.lwstypes`/`.lwsprov`/`.lwsowner` are server-derived and read-only to clients: a client
    // write is refused outright (mirrors writeTypeConsistency's 405 on the LWS write surfaces).
    // Reads still bind READ on the subject below.
    if ((sc.kind === 'lwstypes' || sc.kind === 'lwsprov' || sc.kind === 'lwsowner') && !isRead) {
      return { authorized: false, status: 403, error: 'System-managed resource is read-only' }
    }

    // Required mode on the SUBJECT (never the sidecar's own path — findApplicableAcl walks that
    // up to the container default, which is the escalation):
    //   .acl        → CONTROL for every method (authorizeAclAccess: all ACL ops require Control)
    //   read (any)  → READ on the subject
    //   .meta PUT   → CONTROL to CREATE, WRITE to UPDATE (the choke-point rule: WAC falls back to
    //                 the parent container for a non-existent target, so create must need Control)
    //   .meta DELETE→ WRITE on the subject
    let mode
    if (sc.kind === 'acl') {
      mode = AccessMode.CONTROL
    } else if (isRead) {
      mode = AccessMode.READ
    } else if (method === 'DELETE') {
      mode = AccessMode.WRITE
    } else {
      mode = (await storage.exists(sc.path)) ? AccessMode.WRITE : AccessMode.CONTROL
    }

    const host = request.headers.host || request.hostname
    const subjectUrl = `${request.protocol}://${host}${sc.subject}`
    const { allowed } = await checkAccess({
      resourceUrl: subjectUrl,
      resourcePath: sc.subject,
      isContainer: sc.isContainer,
      agentWebId: webId,
      requiredMode: mode
    })
    if (allowed) return { authorized: true }
    // Reads 404 (never leak sidecar existence to a caller without access — matches the dotfile
    // handling above); writes/deletes 403.
    return { authorized: false, status: isRead ? 404 : 403, error: isRead ? 'Not found' : 'Forbidden' }
  }

  // GET /storage/:user/* — read file or folder
  fastify.get('/storage/:user/*', async (request, reply) => {
    if (!checkUsername(request, reply)) return

    const storagePath = getStoragePath(request)

    // Block dotfile access
    if (hasDotfile(storagePath)) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const { authorized, webId, error, status } = await checkAuth(request, 'GET')
    if (!authorized) {
      const code = status || 401
      if (code === 401) reply.header('WWW-Authenticate', 'Bearer')
      return reply.code(code).send({ error })
    }

    const sc = await checkSidecarAuth(request, storagePath, 'GET', webId)
    if (!sc.authorized) {
      return reply.code(sc.status).send({ error: sc.error })
    }

    const info = await storage.stat(storagePath)

    // Non-existent folder → return empty listing (RS spec: clients expect 200 to start writing)
    // No ETag — forces RS clients to process the folder each sync cycle (304 would skip push logic)
    if (!info && storagePath.endsWith('/')) {
      return reply
        .header('Content-Type', 'application/ld+json')
        .header('Cache-Control', 'no-cache')
        .send({
          '@context': 'http://remotestorage.io/spec/folder-description',
          items: {}
        })
    }

    if (!info) {
      return reply.code(404).send({ error: 'Not found' })
    }

    // Conditional GET — use shared utility
    const cond = checkIfNoneMatchForGet(request.headers['if-none-match'], info.etag)
    if (!cond.ok) {
      return reply.code(304).send()
    }

    // Directory listing
    if (info.isDirectory) {
      const entries = await storage.listContainer(storagePath)
      if (!entries) {
        return reply
          .header('Content-Type', 'application/ld+json')
          .header('ETag', info.etag || '"empty"')
          .header('Cache-Control', 'no-cache')
          .send({
            '@context': 'http://remotestorage.io/spec/folder-description',
            items: {}
          })
      }

      const items = {}
      for (const entry of entries) {
        // Skip dotfiles (ACLs, metadata, etc.)
        if (entry.name.startsWith('.')) continue
        // Skip mid-name aux sidecars (`x.acl`, `x.meta`, `x.lwstypes`, `x.lwsprov`, `x.lwsowner`)
        // — reserved names, never remoteStorage content. Listing them exposed a sibling's
        // ACL/metadata existence + size to any container-lister without CONTROL/READ on the
        // subject (adversarial review 2026-07-22, F4). Case-insensitive to match auxSubject.
        if (/\.(acl|meta|lwstypes|lwsprov|lwsowner)$/i.test(entry.name)) continue

        const childPath = storagePath.endsWith('/') ? storagePath + entry.name : storagePath + '/' + entry.name
        const childStat = await storage.stat(entry.isDirectory ? childPath + '/' : childPath)

        if (entry.isDirectory) {
          items[entry.name + '/'] = {
            ETag: childStat?.etag?.replace(/"/g, '') || ''
          }
        } else {
          items[entry.name] = {
            ETag: childStat?.etag?.replace(/"/g, '') || '',
            'Content-Type': getContentType(entry.name),
            'Content-Length': childStat?.size || 0
          }
        }
      }

      return reply
        .header('Content-Type', 'application/ld+json')
        .header('ETag', info.etag)
        .header('Cache-Control', 'no-cache')
        .send({
          '@context': 'http://remotestorage.io/spec/folder-description',
          items
        })
    }

    // File — stream instead of buffering
    const result = storage.createReadStream(storagePath)
    if (!result) {
      return reply.code(404).send({ error: 'Not found' })
    }

    return reply
      .header('Content-Type', getContentType(storagePath))
      .header('Content-Length', info.size)
      .header('ETag', info.etag)
      .header('Cache-Control', 'no-cache')
      .send(result.stream)
  })

  // HEAD /storage/:user/* — metadata only
  fastify.head('/storage/:user/*', async (request, reply) => {
    if (!checkUsername(request, reply)) return

    const storagePath = getStoragePath(request)

    if (hasDotfile(storagePath)) {
      return reply.code(404).send()
    }

    const { authorized, webId, error, status } = await checkAuth(request, 'HEAD')
    if (!authorized) {
      const code = status || 401
      if (code === 401) reply.header('WWW-Authenticate', 'Bearer')
      return reply.code(code).send()
    }

    const sc = await checkSidecarAuth(request, storagePath, 'HEAD', webId)
    if (!sc.authorized) {
      return reply.code(sc.status).send()
    }

    const info = await storage.stat(storagePath)
    if (!info) {
      return reply.code(404).send()
    }

    // Conditional HEAD
    const cond = checkIfNoneMatchForGet(request.headers['if-none-match'], info.etag)
    if (!cond.ok) {
      return reply.code(304).send()
    }

    reply
      .header('Content-Type', info.isDirectory ? 'application/ld+json' : getContentType(storagePath))
      .header('ETag', info.etag)
      .header('Cache-Control', 'no-cache')

    if (!info.isDirectory) {
      reply.header('Content-Length', info.size)
    }

    return reply.code(200).send()
  })

  // PUT /storage/:user/* — write file
  fastify.put('/storage/:user/*', async (request, reply) => {
    if (!checkUsername(request, reply)) return

    // Respect readOnly mode
    if (request.config?.readOnly) {
      return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' })
    }

    const storagePath = getStoragePath(request)

    if (hasDotfile(storagePath)) {
      return reply.code(403).send({ error: 'Cannot write to dotfiles' })
    }

    const { authorized, webId, error, status } = await checkAuth(request, 'PUT')
    if (!authorized) {
      const code = status || 401
      if (code === 401) reply.header('WWW-Authenticate', 'Bearer')
      return reply.code(code).send({ error })
    }

    const sc = await checkSidecarAuth(request, storagePath, 'PUT', webId)
    if (!sc.authorized) {
      return reply.code(sc.status).send({ error: sc.error })
    }

    // Directories end with / — can't PUT to a directory
    if (storagePath.endsWith('/')) {
      return reply.code(400).send({ error: 'Cannot PUT to a folder path' })
    }

    // Conditional write — use shared utilities
    const existing = await storage.stat(storagePath)

    const ifMatchResult = checkIfMatch(request.headers['if-match'], existing?.etag || null)
    if (!ifMatchResult.ok) {
      return reply.code(ifMatchResult.status).send({ error: ifMatchResult.error })
    }

    const ifNoneMatchResult = checkIfNoneMatchForWrite(request.headers['if-none-match'], existing?.etag || null)
    if (!ifNoneMatchResult.ok) {
      return reply.code(ifNoneMatchResult.status).send({ error: ifNoneMatchResult.error })
    }

    const content = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body || '')
    const success = await storage.write(storagePath, content)
    if (!success) {
      return reply.code(500).send({ error: 'Write failed' })
    }

    const newStat = await storage.stat(storagePath)
    const statusCode = existing ? 200 : 201

    return reply
      .code(statusCode)
      .header('ETag', newStat?.etag || '')
      .send()
  })

  // DELETE /storage/:user/* — delete file
  fastify.delete('/storage/:user/*', async (request, reply) => {
    if (!checkUsername(request, reply)) return

    // Respect readOnly mode
    if (request.config?.readOnly) {
      return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' })
    }

    const storagePath = getStoragePath(request)

    if (hasDotfile(storagePath)) {
      return reply.code(403).send({ error: 'Cannot delete dotfiles' })
    }

    const { authorized, webId, error, status } = await checkAuth(request, 'DELETE')
    if (!authorized) {
      const code = status || 401
      if (code === 401) reply.header('WWW-Authenticate', 'Bearer')
      return reply.code(code).send({ error })
    }

    const sc = await checkSidecarAuth(request, storagePath, 'DELETE', webId)
    if (!sc.authorized) {
      return reply.code(sc.status).send({ error: sc.error })
    }

    const existing = await storage.stat(storagePath)
    if (!existing) {
      return reply.code(404).send({ error: 'Not found' })
    }

    // Conditional delete — use shared utility
    const ifMatchResult = checkIfMatch(request.headers['if-match'], existing.etag)
    if (!ifMatchResult.ok) {
      return reply.code(ifMatchResult.status).send({ error: ifMatchResult.error })
    }

    const success = await storage.remove(storagePath)
    if (!success) {
      return reply.code(500).send({ error: 'Delete failed' })
    }

    return reply
      .code(200)
      .header('ETag', existing.etag)
      .send()
  })

  fastify.log.info(`remoteStorage enabled for user: ${username}`)
}

export default remoteStoragePlugin

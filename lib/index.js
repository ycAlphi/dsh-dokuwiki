/**
 * dsh-dokuwiki — host half.
 *
 * Registers:
 *   - native tools for DokuWiki read/write operations;
 *   - a runtime skill that carries the operational rules;
 *   - a small HTTP API consumed by the browser half's configuration page
 *     (rendered inside DSH's Plugins page through `plugins.bundle.config`).
 *
 * Secrets never touch our own config file: the password is stored in DSH's
 * credential service under `DOKUWIKI_PASSWORD`, and the API only ever reports
 * whether it is configured.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DokuWikiClient, DokuWikiError, isDokuWikiError } from './dokuwiki.mjs'
import { createLazyDisclosure } from './lazy.mjs'
import {
  configPath,
  normalizeConfig,
  readConfig,
  writeConfig,
} from './store.mjs'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE } from './skill.mjs'

export const name = 'dsh-dokuwiki'
export const inject = ['tools', 'skills', 'webServer']

const PACKAGE_NAME = 'dsh-dokuwiki'
const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const VERSION = PACKAGE.version
const CREDENTIAL_REF = 'DOKUWIKI_PASSWORD'
const API_PREFIX = '/dsh-dokuwiki/api'
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024

const ERROR_HINTS = {
  CONFIG: '请在 侧边栏 → 插件 → dsh-dokuwiki 里完成配置（base URL、用户名、密码）。',
  AUTH: '账号或密码不正确。不要连续重试：DokuWiki 连续登录失败会锁定约 15 分钟。',
  AUTH_LOCKED: 'DokuWiki 登录已被临时锁定，请约 15 分钟后再试。',
  NETWORK: '无法访问该地址，请检查网络连接和 base URL。',
  NO_BASE: '所有配置的 base URL 都不可用，请检查地址或网络。',
}

function withHint(error) {
  if (!isDokuWikiError(error)) return error
  const hint = ERROR_HINTS[error.code]
  if (hint === undefined || error.message.includes(hint)) return error
  const wrapped = new DokuWikiError(error.code, `${error.message}\n${hint}`, { cause: error })
  if (error.details !== undefined) wrapped.details = error.details
  return wrapped
}

/** Model-facing text for the wiki_get_conventions tool result. */
function renderConventionsResult(value) {
  if (value.disabled === true) {
    return '本插件没有配置写作规范页（conventionsPage 为空），写作规范功能未启用。'
  }
  if (value.exists === true) {
    return `写作规范页：${value.pageid}\n\n${value.source ?? ''}`
  }
  const lines = [`写作规范页 ${value.pageid} 不存在或当前账号无权读取。`]
  if (typeof value.reason === 'string' && value.reason !== '') lines.push(`（${value.reason}）`)
  lines.push('写入不会被强制拦截；建议先与用户确认规范页的位置和内容，再写入页面。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

function createRuntime(ctx) {
  /** @type {DokuWikiClient | null} */
  let client = null
  let clientKey = ''
  /** @type {Map<string, {source: string, via: string, base: string, fetchedAt: number}>} */
  const pageCache = new Map()
  /** Detected account capabilities; write tools follow `edit`. */
  let capabilities = null
  let capabilityCheck = null
  const capabilityListeners = new Set()

  const invalidate = () => {
    client = null
    clientKey = ''
    pageCache.clear()
    capabilities = null
    capabilityCheck = null
  }

  // A password changed in DSH settings must reach the next operation.
  if (typeof ctx.on === 'function') {
    ctx.on('credentials/reference-updated', (ref) => {
      if (String(ref) === CREDENTIAL_REF) {
        invalidate()
        void runtime.detectCapabilities({ force: true })
      }
    })
  }

  const runtime = {
    invalidate,
    pageCache,

    capabilities() {
      return capabilities
    },

    onCapabilities(listener) {
      capabilityListeners.add(listener)
      if (capabilities !== null) {
        try {
          listener(capabilities)
        } catch {
          /* listener failures must not break detection */
        }
      }
      return () => capabilityListeners.delete(listener)
    },

    /**
     * Probe what the configured account is actually allowed to do.
     *
     * DokuWiki does not expose its ACL over the API, so this infers the
     * account's capabilities by trying the operations: read a known page,
     * and open the edit form for a probe page (the form is only served when
     * the account may edit there). Edit permission is what gates the write
     * tools; deletion follows edit permission in DokuWiki.
     */
    async detectCapabilities({ force = false } = {}) {
      if (!force && capabilities !== null && Date.now() - capabilities.checkedAt < 60_000) {
        return capabilities
      }
      if (capabilityCheck !== null) return capabilityCheck
      capabilityCheck = (async () => {
        const detected = {
          read: 'unknown',
          edit: 'unknown',
          delete: 'unknown',
          upload: 'unknown',
          probePage: null,
          uploadProbe: null,
          checkedAt: Date.now(),
          error: null,
        }
        try {
          const { client: connected } = await runtime.getClient()
          let readablePage = null
          try {
            await connected.getPage('start')
            detected.read = 'yes'
            readablePage = 'start'
          } catch (error) {
            if (!isDokuWikiError(error)) throw error
            if (['DENIED', 'AUTH', 'AUTH_LOCKED'].includes(error.code)) detected.read = 'no'
            else if (['NETWORK', 'NO_BASE', 'CONFIG'].includes(error.code)) detected.error = error.message
            else throw error
          }
          const { config } = runtime.readConfig()
          // Edit permission is tested against an EXISTING page first: an
          // account may be allowed to edit pages without being allowed to
          // create new ones (a write-only reviewer account looks exactly like
          // that), and probing only "create a new page" used to miss it.
          const probeEdit = async (candidates) => {
            for (const candidate of candidates) {
              if (typeof candidate !== 'string' || candidate === '') continue
              try {
                const probe = await connected.canEdit(candidate)
                detected.probePage = candidate
                if (probe.canEdit) return true
              } catch (error) {
                if (isDokuWikiError(error) && error.code === 'ACL') continue
                detected.error = detected.error ?? error.message
              }
            }
            return false
          }
          let editDetected = await probeEdit([readablePage])
          if (!editDetected) {
            // `start` may be read-only while the account can edit elsewhere;
            // the first readable pages are the cheapest generic fallback.
            try {
              const listing = await connected.listPages('', { depth: 1 })
              editDetected = await probeEdit(listing.pages.map((entry) => entry.id).slice(0, 3))
            } catch {
              /* listing is best effort */
            }
          }
          if (!editDetected) {
            // Last resort: the account may only be allowed to CREATE pages.
            // Opening the edit form for a new page exercises that permission.
            editDetected = await probeEdit([
              `user:${config.username}:dsh_dokuwiki_probe`,
              'dsh_dokuwiki_probe',
            ])
          }
          detected.edit = editDetected ? 'yes' : 'no'
          detected.delete = detected.edit
          // Upload permission is probed through the media manager page (it
          // only renders the upload form when the account may upload there).
          for (const namespace of [`user:${config.username}`, '']) {
            try {
              const probe = await connected.canUpload(namespace)
              detected.uploadProbe = namespace
              detected.upload = probe.canUpload ? 'yes' : 'no'
              if (probe.canUpload) break
            } catch (error) {
              if (isDokuWikiError(error) && error.code === 'ACL') {
                detected.upload = 'no'
                continue
              }
              detected.error = detected.error ?? error.message
            }
          }
        } catch (error) {
          detected.error = error.message
        }
        detected.checkedAt = Date.now()
        capabilities = detected
        capabilityCheck = null
        for (const listener of capabilityListeners) {
          try {
            listener(detected)
          } catch {
            /* isolated */
          }
        }
        ctx.logger?.debug?.(
          `[dsh-dokuwiki] capabilities: read=${detected.read} edit=${detected.edit} upload=${detected.upload}${detected.error ? ` (${detected.error})` : ''}`,
        )
        return detected
      })()
      return capabilityCheck
    },

    /**
     * Read the configured writing-conventions page, if one is configured.
     * The page is optional: a missing/unreadable page only reports that fact.
     */
    async getConventions() {
      const { config } = runtime.readConfig()
      const pageid = config.conventionsPage
      if (pageid === '') return { pageid: '', exists: false, disabled: true }
      const { client } = await runtime.getClient()
      try {
        const page = await client.getPage(pageid)
        if (page.source.trim() === '') return { pageid, exists: false, reason: '页面为空' }
        return { pageid, exists: true, source: page.source, chars: page.source.length }
      } catch (error) {
        if (!isDokuWikiError(error)) throw error
        // Not existing and not being readable are indistinguishable in web
        // mode; the feature is optional, so both only report the gap.
        if (
          ['DENIED', 'AUTH', 'AUTH_LOCKED'].includes(error.code) ||
          (error.code === 'HTTP' && /HTTP 404\b/.test(error.message))
        ) {
          return { pageid, exists: false, unreadable: true, reason: error.message }
        }
        throw error
      }
    },

    credentialService() {
      // Service lookup is optional here: during very early plugin startup the
      // credentials service may not be mounted yet, and a failed lookup must
      // not break capability detection or the configuration API.
      try {
        if (typeof ctx.get === 'function') {
          const service = ctx.get('credentials')
          if (service !== undefined && service !== null) return service
        }
      } catch {
        /* not mounted (yet) */
      }
      try {
        return ctx.credentials ?? undefined
      } catch {
        return undefined
      }
    },

    readConfig() {
      return readConfig()
    },

    saveConfig(patch) {
      const current = readConfig().config
      const merged = normalizeConfig({ ...current, ...patch })
      writeConfig(merged)
      invalidate()
      return merged
    },

    async password() {
      const service = runtime.credentialService()
      if (service === undefined) {
        throw new DokuWikiError('CONFIG', '当前部署没有 credentials 服务，无法读取 wiki 密码')
      }
      const resolved = await service.resolve(CREDENTIAL_REF)
      return resolved?.value
    },

    async credentialState() {
      const service = runtime.credentialService()
      if (service === undefined) {
        return { configured: false, writable: false, error: '当前部署没有 credentials 服务' }
      }
      try {
        const info = await service.describe(CREDENTIAL_REF)
        return {
          configured: info.configured === true,
          writable: info.writable === true,
          source: info.source ?? null,
        }
      } catch (error) {
        return { configured: false, writable: false, error: error.message }
      }
    },

    async setPassword(value) {
      const service = runtime.credentialService()
      if (service === undefined) throw new DokuWikiError('CONFIG', '当前部署没有 credentials 服务，无法保存密码')
      try {
        await service.set(CREDENTIAL_REF, value)
      } catch (error) {
        throw new DokuWikiError('CONFIG', `保存密码失败：${error?.message ?? error}`)
      }
      invalidate()
    },

    async clearPassword() {
      const service = runtime.credentialService()
      if (service === undefined) return
      try {
        await service.unset(CREDENTIAL_REF)
      } catch (error) {
        throw new DokuWikiError('CONFIG', `清除密码失败：${error?.message ?? error}`)
      }
      invalidate()
    },

    /** Resolve config + password and hand back a connected client. */
    async getClient() {
      const { config, warning } = readConfig()
      if (config.baseUrls.length === 0) {
        throw new DokuWikiError('CONFIG', '还没有配置 DokuWiki base URL（例如 http://wiki.example.com）')
      }
      if (config.username === '') {
        throw new DokuWikiError('CONFIG', '还没有配置 DokuWiki 用户名')
      }
      const password = await runtime.password()
      if (password === undefined || password === '') {
        throw new DokuWikiError('CONFIG', '还没有保存 DokuWiki 密码')
      }
      const key = JSON.stringify([config.baseUrls, config.username, password, config.timeoutMs])
      if (client === null || clientKey !== key) {
        client = new DokuWikiClient({
          baseUrls: config.baseUrls,
          username: config.username,
          password,
          timeoutMs: config.timeoutMs,
          onLog: (message) => ctx.logger?.debug?.(message),
        })
        clientKey = key
      }
      return { client, config, warning }
    },

    async testConnection() {
      const { client: connected, config } = await runtime.getClient()
      const diagnostic = await connected.testConnection()
      return { ...diagnostic, username: config.username, baseUrls: config.baseUrls }
    },
  }
  return runtime
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

function textOnly(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

function defineReadTool(register, runtime, definition) {
  return register({
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    ...definition,
  })
}

function registerReadTools(register, runtime) {
  defineReadTool(register, runtime, {
    name: 'wiki_status',
    description:
      'Check the configured DokuWiki connection: reachable base URL, access mode (XML-RPC or web form login), read access, and the account permissions detected so far (edit, delete, upload). Run this first when another wiki tool fails. Loading the `dokuwiki` skill unlocks the other wiki tools for the current session.',
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: 'Whether connectivity and login succeeded' },
          error: { type: 'string', description: 'Failure message when ok is false' },
          read: { type: 'string', description: 'yes / no / unknown — detected read permission' },
          edit: { type: 'string', description: 'yes / no / unknown — detected edit permission' },
          delete: { type: 'string', description: 'yes / no / unknown — detected delete permission' },
          upload: { type: 'string', description: 'yes / no / unknown — detected media upload permission' },
          probePage: { type: 'string', description: 'Page used for the edit-permission probe' },
          uploadProbe: { type: 'string', description: 'Namespace used for the upload-permission probe' },
        },
      },
      render: (_args, value) => textOnly(value),
    },
    async execute() {
      const detected = await runtime.detectCapabilities({ force: true })
      try {
        const { client: connected, config } = await runtime.getClient()
        const connection = await connected.connect()
        return {
          ok: detected.read !== 'no',
          base: connection.base,
          mode: connection.mode,
          version: connection.version,
          username: config.username,
          login: connection.mode === 'web' ? `ok (${config.username})` : 'ok (XML-RPC basic auth)',
          read: detected.read,
          edit: detected.edit,
          delete: detected.delete,
          upload: detected.upload,
          // Declared as strings: omit them while the probe has not produced a
          // value (the probe page/namespace stays null on unconfigured wikis or
          // failed detection). Returning null would fail DSH output validation.
          ...(typeof detected.probePage === 'string' && detected.probePage !== ''
            ? { probePage: detected.probePage }
            : {}),
          ...(typeof detected.uploadProbe === 'string' && detected.uploadProbe !== ''
            ? { uploadProbe: detected.uploadProbe }
            : {}),
          checkedAt: detected.checkedAt,
          warnings: detected.error ? [detected.error] : [],
          baseUrls: config.baseUrls,
        }
      } catch (error) {
        return {
          ok: false,
          error: withHint(error).message,
          read: detected.read,
          edit: detected.edit,
          delete: detected.delete,
          upload: detected.upload,
          ...(typeof detected.probePage === 'string' && detected.probePage !== ''
            ? { probePage: detected.probePage }
            : {}),
          ...(typeof detected.uploadProbe === 'string' && detected.uploadProbe !== ''
            ? { uploadProbe: detected.uploadProbe }
            : {}),
          warnings: detected.error ? [detected.error] : [],
        }
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_read_page',
    description:
      'Read the raw DokuWiki source of one page. Returns the wiki text (headings, tables, image captions) plus metadata. Results are cached briefly; pass fresh=true to bypass the cache.',
    parameters: {
      type: 'object',
      properties: {
        pageid: { type: 'string', description: 'DokuWiki page id, e.g. "namespace:page"' },
        fresh: { type: 'boolean', description: 'Bypass the short-lived cache and refetch from the wiki' },
      },
      required: ['pageid'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageid: { type: 'string' },
          source: { type: 'string' },
          chars: { type: 'integer' },
          cached: { type: 'boolean' },
          ageMs: { type: 'integer' },
          via: { type: 'string' },
          base: { type: 'string' },
        },
        required: ['pageid', 'source', 'chars', 'cached', 'via'],
      },
      render: (_args, value) => [{ type: 'text', text: value.source }],
      presentationMeta: (_args, value) => ({
        pageid: value.pageid,
        chars: value.chars,
        cached: value.cached,
        via: value.via,
      }),
    },
    async execute(args) {
      const pageid = String(args.pageid ?? '').trim()
      if (pageid === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
      const cached = runtime.pageCache.get(pageid)
      const now = Date.now()
      if (args.fresh !== true && cached !== undefined && now - cached.fetchedAt <= PAGE_CACHE_TTL_MS) {
        return {
          pageid,
          source: cached.source,
          chars: cached.source.length,
          cached: true,
          ageMs: now - cached.fetchedAt,
          via: cached.via,
          base: cached.base,
        }
      }
      try {
        const { client } = await runtime.getClient()
        const page = await client.getPage(pageid)
        runtime.pageCache.set(pageid, {
          source: page.source,
          via: page.via,
          base: client.baseUrl,
          fetchedAt: now,
        })
        return {
          pageid,
          source: page.source,
          chars: page.source.length,
          cached: false,
          ageMs: 0,
          via: page.via,
          base: client.baseUrl,
        }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_get_conventions',
    description:
      "Read this wiki's own page-writing conventions: where new pages go, how they are named, which template to use, required structure, media naming, and edit-summary style. Call it before creating a page or substantially rewriting one, and follow what it says. The page is configured by the user in the plugin settings; when none is configured, the tool reports that the feature is off.",
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageid: { type: 'string', description: 'Configured conventions page id (empty when disabled)' },
          exists: { type: 'boolean', description: 'Whether the conventions page was readable and non-empty' },
          source: { type: 'string', description: 'Raw DokuWiki source of the conventions page' },
          chars: { type: 'integer' },
          disabled: { type: 'boolean', description: 'No conventions page configured' },
          unreadable: { type: 'boolean', description: 'Page missing or not readable by this account' },
          reason: { type: 'string', description: 'Underlying error when the page could not be read' },
        },
        required: ['pageid', 'exists'],
      },
      render: (_args, value) => [{ type: 'text', text: renderConventionsResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      try {
        return await runtime.getConventions()
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_download_media',
    description:
      'Download one media file (an image or another file from the wiki media namespace) into the workspace and return its local path. Read permission comes from the configured account; the wiki ACL still decides access to each media file.',
    parameters: {
      type: 'object',
      properties: {
        mediaid: {
          type: 'string',
          description: 'Media id, for example "wiki:plot.png" or "user:alice:image.png"',
        },
        dest_path: {
          type: 'string',
          description: 'Workspace-relative destination path; defaults to "wiki_media/<basename>"',
        },
      },
      required: ['mediaid'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mediaid: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          url: { type: 'string' },
        },
        required: ['ok', 'mediaid', 'path', 'bytes', 'url'],
      },
      render: (_args, value) => [
        { type: 'text', text: `已下载 ${value.mediaid}（${value.bytes} 字节）→ ${value.path}` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mediaid = String(args.mediaid ?? '').trim()
      if (mediaid === '') throw new DokuWikiError('ARGUMENT', 'mediaid 不能为空')
      try {
        const { client } = await runtime.getClient()
        const media = await client.downloadMedia(mediaid)
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
        const baseName = media.mediaid.split(':').pop()
        const requested = String(args.dest_path ?? '').trim() || path.join('wiki_media', baseName)
        const target = path.resolve(cwd, requested)
        const relative = path.relative(cwd, target)
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new DokuWikiError('ARGUMENT', `dest_path 必须位于工作区内：${requested}`)
        }
        if (media.bytes.length > MAX_UPLOAD_BYTES) {
          throw new DokuWikiError('ARGUMENT', `媒体文件过大（超过 ${MAX_UPLOAD_BYTES} 字节）：${mediaid}`)
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, media.bytes)
        return {
          ok: true,
          mediaid: media.mediaid,
          path: relative.replaceAll(path.sep, '/'),
          bytes: media.bytes.length,
          url: media.url,
        }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_list_pages',
    description:
      'List pages in a DokuWiki namespace. depth=0 lists only that namespace level; depth=1 or more recurses. Returns page ids with size/rev when the account can use XML-RPC.',
    parameters: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace id, e.g. "notes:2026-07". Omit for the root namespace.' },
        depth: { type: 'integer', description: 'Recursion depth; 0 (default) lists only this level' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          namespace: { type: 'string' },
          via: { type: 'string' },
          count: { type: 'integer' },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                size: { type: 'integer' },
                rev: { type: 'integer' },
              },
              required: ['id'],
            },
          },
        },
        required: ['namespace', 'via', 'count', 'pages'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.pages.length === 0
              ? `命名空间 "${value.namespace}" 下没有页面`
              : value.pages.map((page) => page.id).join('\n'),
        },
      ],
    },
    async execute(args) {
      const namespace = String(args.namespace ?? '').replace(/:+$/, '')
      const depth = Number.isInteger(args.depth) ? Math.max(0, Math.min(10, args.depth)) : 0
      try {
        const { client } = await runtime.getClient()
        const result = await client.listPages(namespace, { depth })
        // DSH tool schemas accept one type per field, so absent metadata is
        // omitted instead of being sent as null.
        const pages = result.pages.map((page) => ({
          id: page.id,
          ...(Number.isFinite(page.size) ? { size: page.size } : {}),
          ...(Number.isFinite(page.rev) ? { rev: page.rev } : {}),
          ...(Number.isFinite(page.mtime) ? { mtime: page.mtime } : {}),
        }))
        return { namespace, via: result.via, count: pages.length, pages }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_list_media',
    description:
      'List media files (images and other uploaded files) directly inside one DokuWiki media namespace. Use it to discover media before wiki_download_media: the wiki media manager needs a login, so anonymous HTTP cannot list it, and this tool is the supported way to browse a namespace. Also returns the direct sub-namespaces.',
    parameters: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Media namespace id, e.g. "log2025:2025-03". Omit for the media root namespace.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          namespace: { type: 'string' },
          via: { type: 'string' },
          count: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            },
          },
          subNamespaces: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['namespace', 'via', 'count', 'files', 'subNamespaces'],
      },
      render: (_args, value) => {
        if (value.files.length === 0 && value.subNamespaces.length === 0) {
          return [
            {
              type: 'text',
              text: `媒体命名空间 "${value.namespace === '' ? '(root)' : value.namespace}" 下没有文件`,
            },
          ]
        }
        const lines = value.files.map((file) => file.id)
        if (value.subNamespaces.length > 0) {
          lines.push('', '子命名空间:', ...value.subNamespaces.map((ns) => `  ${ns}`))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const namespace = String(args.namespace ?? '')
        .trim()
        .replace(/:+$/, '')
      try {
        const { client } = await runtime.getClient()
        const result = await client.listMedia(namespace)
        return {
          namespace: result.namespace,
          via: 'media-manager',
          count: result.files.length,
          files: result.files.map((id) => ({ id })),
          subNamespaces: result.subNamespaces,
        }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_search',
    description:
      'Full-text search the DokuWiki. Use it to find a page id by keyword when you do not know the namespace. Falls back to the wiki search page when the account has no XML-RPC access.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, e.g. "meeting notes" or "release checklist"' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          via: { type: 'string' },
          count: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                snippet: { type: 'string' },
              },
              required: ['id'],
            },
          },
        },
        required: ['query', 'via', 'count', 'results'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.results.length === 0
              ? `没有找到包含 "${value.query}" 的页面`
              : value.results
                  .map((hit) => {
                    const title = hit.title ? ` | ${hit.title}` : ''
                    const snippet = hit.snippet ? `\n    ${hit.snippet}` : ''
                    return `${hit.id}${title}${snippet}`
                  })
                  .join('\n'),
        },
      ],
    },
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (query === '') throw new DokuWikiError('ARGUMENT', 'query 不能为空')
      try {
        const { client } = await runtime.getClient()
        const result = await client.search(query)
        return { query, via: result.via, count: result.results.length, results: result.results }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_recent_changes',
    description:
      "List the wiki's most recent changes (page edits and media files) with date, page id, user and edit summary, from the wiki's Recent changes page. Use it to see what changed lately. Optionally filter by namespace prefix and cap the number of entries.",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum number of entries to return (default 20, max 50)' },
        namespace: {
          type: 'string',
          description: 'Only return changes from this namespace (or its sub-namespaces)',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          via: { type: 'string' },
          count: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string' },
                pageid: { type: 'string' },
                user: { type: 'string' },
                summary: { type: 'string' },
                type: { type: 'string' },
              },
              required: ['date', 'pageid', 'user', 'summary', 'type'],
            },
          },
        },
        required: ['via', 'count', 'items'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.items.length === 0
              ? 'wiki 最近没有可读的改动记录'
              : value.items
                  .map((entry) => {
                    const kind = entry.type === 'mediafile' ? '[media] ' : ''
                    const summary = entry.summary !== '' ? ` — ${entry.summary}` : ''
                    return `${entry.date}  ${entry.user}  ${kind}${entry.pageid}${summary}`
                  })
                  .join('\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 20
      const namespace = String(args.namespace ?? '')
        .trim()
        .replace(/:+$/, '')
      try {
        const { client } = await runtime.getClient()
        const result = await client.recentChanges({ limit: namespace === '' ? limit : 50 })
        const items =
          namespace === ''
            ? result.items
            : result.items
                .filter((entry) => entry.pageid === namespace || entry.pageid.startsWith(`${namespace}:`))
                .slice(0, limit)
        return { via: result.via, count: items.length, items }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_page_history',
    description:
      'List the revision history of one page (version, date, user, summary). Requires XML-RPC access; a web-form-only account gets a clear error instead.',
    parameters: {
      type: 'object',
      properties: {
        pageid: { type: 'string', description: 'DokuWiki page id' },
      },
      required: ['pageid'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageid: { type: 'string' },
          count: { type: 'integer' },
          versions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                version: { type: 'integer' },
                date: { type: 'integer' },
                modified: { type: 'string' },
                user: { type: 'string' },
                summary: { type: 'string' },
                type: { type: 'string' },
                ip: { type: 'string' },
              },
            },
          },
        },
        required: ['pageid', 'count', 'versions'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.versions.length === 0
              ? `页面 ${value.pageid} 没有历史版本`
              : value.versions
                  .map((entry) => {
                    const when =
                      entry.modified !== undefined && entry.modified !== ''
                        ? entry.modified
                        : entry.date === null || entry.date === undefined
                          ? ''
                          : new Date(entry.date * 1000).toISOString()
                    return `${entry.version ?? '?'} | ${when} | ${entry.user} | ${entry.summary}`
                  })
                  .join('\n'),
        },
      ],
    },
    async execute(args) {
      const pageid = String(args.pageid ?? '').trim()
      if (pageid === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
      try {
        const { client } = await runtime.getClient()
        const versions = await client.pageVersions(pageid)
        const normalized = versions.map((entry) => ({
          ...(Number.isFinite(entry.version) ? { version: entry.version } : {}),
          ...(Number.isFinite(entry.date) ? { date: entry.date } : {}),
          ...(typeof entry.modified === 'string' && entry.modified !== '' ? { modified: entry.modified } : {}),
          user: entry.user ?? '',
          summary: entry.summary ?? '',
          ...(typeof entry.type === 'string' && entry.type !== '' ? { type: entry.type } : {}),
          ...(typeof entry.ip === 'string' && entry.ip !== '' ? { ip: entry.ip } : {}),
          ...(Number.isFinite(entry.size) ? { size: entry.size } : {}),
        }))
        return { pageid, count: normalized.length, versions: normalized }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_can_edit',
    description:
      'Probe whether the configured wiki account may edit a page. The probe opens and immediately cancels an edit session, so no lock is left behind. Use before promising to write.',
    parameters: {
      type: 'object',
      properties: {
        pageid: { type: 'string', description: 'DokuWiki page id to probe' },
      },
      required: ['pageid'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageid: { type: 'string' },
          canEdit: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['pageid', 'canEdit'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.canEdit ? `可以编辑 ${value.pageid}` : `不能编辑 ${value.pageid}${value.reason ? `：${value.reason}` : ''}`,
        },
      ],
    },
    async execute(args) {
      const pageid = String(args.pageid ?? '').trim()
      if (pageid === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
      try {
        const { client } = await runtime.getClient()
        const result = await client.canEdit(pageid)
        return { pageid, canEdit: result.canEdit, reason: result.reason }
      } catch (error) {
        throw withHint(error)
      }
    },
  })

  defineReadTool(register, runtime, {
    name: 'wiki_permissions',
    description:
      'Probe what the configured account may do inside one DokuWiki namespace: read, create, edit, delete and upload. DokuWiki has no ACL read API, so permissions are inferred from the network responses (is the edit form served? does the media manager render its upload form? is a page readable?). Delete follows edit permission in DokuWiki.',
    parameters: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Namespace id (e.g. "notes:2026"); omit for the root namespace',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          namespace: { type: 'string' },
          read: { type: 'string' },
          create: { type: 'string' },
          edit: { type: 'string' },
          delete: { type: 'string' },
          upload: { type: 'string' },
          probes: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['namespace', 'read', 'create', 'edit', 'delete', 'upload'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `命名空间 ${value.namespace === '' ? '(root)' : value.namespace}`,
            `  read=${value.read}  create=${value.create}  edit=${value.edit}  delete=${value.delete}  upload=${value.upload}`,
            ...(Array.isArray(value.warnings) && value.warnings.length > 0 ? value.warnings.map((w) => `  ! ${w}`) : []),
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      const namespace = String(args.namespace ?? '')
      try {
        const { client } = await runtime.getClient()
        return await client.probePermissions(namespace)
      } catch (error) {
        throw withHint(error)
      }
    },
  })

}

/**
 * Write tools are registered only while the account's ACL grants edit
 * permission. The capability probe decides; when the account cannot edit, the
 * tools are not offered to the model at all.
 */
function registerWriteTools(register, runtime) {
  register({
    name: 'wiki_write_page',
    description:
      'Create or edit one DokuWiki page. Requires a meaningful summary; the result is verified by reading the page back. Never deletes: empty bodies are rejected. Write access is decided by the wiki ACL for the configured account.',
    parameters: {
      type: 'object',
      properties: {
        pageid: { type: 'string', description: 'DokuWiki page id to create or replace' },
        text: { type: 'string', description: 'Complete new raw DokuWiki source of the page (non-empty)' },
        summary: { type: 'string', description: 'Edit summary shown in Recent Changes (required)' },
      },
      required: ['pageid', 'text', 'summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageid: { type: 'string' },
          saved: { type: 'boolean' },
          verified: { type: 'boolean' },
          chars: { type: 'integer' },
          base: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['pageid', 'saved', 'verified'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.saved
            ? `已保存并回读校验：${value.pageid}（${value.chars} 字符）`
            : `保存失败：${value.pageid}${value.reason ? ` — ${value.reason}` : ''}`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const { config } = runtime.readConfig()
      if (!config.enableWrite) {
        throw new DokuWikiError(
          'CONFIG',
          '本插件的写入功能已被关闭（enableWrite=false）。请在 侧边栏 → 插件 → dsh-dokuwiki 中打开。',
        )
      }
      const pageid = String(args.pageid ?? '').trim()
      if (pageid === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
      try {
        const { client } = await runtime.getClient()
        const result = await client.writePage({
          pageid,
          text: String(args.text ?? ''),
          summary: String(args.summary ?? ''),
        })
        runtime.pageCache.delete(pageid)
        if (!result.valid) {
          return { pageid, saved: false, verified: false, reason: result.reason }
        }
        return {
          pageid,
          saved: true,
          verified: result.verified === true,
          chars: result.chars ?? 0,
          base: client.baseUrl ?? '',
        }
      } catch (error) {
        throw withHint(error)
      }
    },
  })
  register({
    name: 'wiki_delete_page',
    description:
      'Delete one DokuWiki page. In DokuWiki a page is removed by saving empty text, so this is the explicit delete operation. Requires a summary; the result is verified by reading the page back.',
    parameters: {
      type: 'object',
      properties: {
        pageid: { type: 'string', description: 'DokuWiki page id to delete' },
        summary: { type: 'string', description: 'Edit summary shown in Recent Changes (required)' },
      },
      required: ['pageid', 'summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageid: { type: 'string' },
          deleted: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['pageid', 'deleted'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.deleted
            ? `已删除并回读确认：${value.pageid}`
            : `删除失败：${value.pageid}${value.reason ? ` — ${value.reason}` : ''}`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const { config } = runtime.readConfig()
      if (!config.enableWrite) {
        throw new DokuWikiError(
          'CONFIG',
          '本插件的写入/删除功能已被关闭（enableWrite=false）。请在 侧边栏 → 插件 → dsh-dokuwiki 中打开。',
        )
      }
      const pageid = String(args.pageid ?? '').trim()
      if (pageid === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
      try {
        const { client } = await runtime.getClient()
        const result = await client.deletePage({
          pageid,
          summary: String(args.summary ?? ''),
        })
        runtime.pageCache.delete(pageid)
        return { pageid, deleted: result.deleted === true, ...(result.reason ? { reason: result.reason } : {}) }
      } catch (error) {
        throw withHint(error)
      }
    },
  })
}

/** Uploads are capped well below typical wiki/PHP limits; adjust if needed. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

function mediaBasename(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/**
 * Read a workspace file for upload. Uses the DSH `fs` service when the
 * deployment provides it, so the workspace sandbox policy still applies;
 * falls back to Node's fs for minimal/test compositions.
 */
async function readWorkspaceFile(ctx, exec, requestedPath) {
  const cwd = exec?.agent?.session?.header?.cwd
  const fsService = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  if (fsService !== undefined) {
    const target = await fsService.resolve(requestedPath, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    })
    const info = await fsService.stat(target, exec?.signal)
    if (info === undefined) throw new DokuWikiError('ARGUMENT', `文件不存在：${requestedPath}`)
    if (info.type !== 'file') throw new DokuWikiError('ARGUMENT', `不是普通文件：${requestedPath}`)
    if (Number.isFinite(info.size) && info.size > MAX_UPLOAD_BYTES) {
      throw new DokuWikiError('ARGUMENT', `文件过大（超过 ${MAX_UPLOAD_BYTES} 字节）：${requestedPath}`)
    }
    const bytes = await fsService.readBytes(target, exec?.signal, MAX_UPLOAD_BYTES)
    return { bytes: Buffer.from(bytes), displayPath: target.displayPath ?? requestedPath }
  }
  const resolved = path.resolve(cwd ?? process.cwd(), requestedPath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new DokuWikiError('ARGUMENT', `不是普通文件：${requestedPath}`)
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new DokuWikiError('ARGUMENT', `文件过大（超过 ${MAX_UPLOAD_BYTES} 字节）：${requestedPath}`)
  }
  return { bytes: fs.readFileSync(resolved), displayPath: resolved }
}

/**
 * Upload tools are registered only when the capability probe confirms that the
 * account may upload media somewhere (DokuWiki ACL).
 */
function registerUploadTools(register, runtime, ctx) {
  register({
    name: 'wiki_upload_media',
      description:
        'Upload one file into a DokuWiki namespace (images and other media types the wiki allows) and verify it by downloading it back. The file is read from the workspace. Upload permission is decided by the wiki ACL for the configured account.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Workspace path of the file to upload' },
          namespace: {
            type: 'string',
            description: 'Target DokuWiki namespace; defaults to user:<username>',
          },
          filename: {
            type: 'string',
            description: 'Target filename; defaults to the local basename',
          },
          overwrite: { type: 'boolean', description: 'Overwrite an existing media file with the same name' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            mediaid: { type: 'string' },
            namespace: { type: 'string' },
            url: { type: 'string' },
            bytes: { type: 'integer' },
          },
          required: ['ok', 'mediaid', 'namespace', 'url', 'bytes'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已上传并回读校验：${value.mediaid}（${value.bytes} 字节）\n${value.url}`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { config } = runtime.readConfig()
        if (!config.enableWrite) {
          throw new DokuWikiError(
            'CONFIG',
            '本插件的写入/上传功能已被关闭（enableWrite=false）。请在 侧边栏 → 插件 → dsh-dokuwiki 中打开。',
          )
        }
        const filePath = String(args.file_path ?? '').trim()
        if (filePath === '') throw new DokuWikiError('ARGUMENT', 'file_path 不能为空')
        try {
          const file = await readWorkspaceFile(ctx, exec, filePath)
          const filename = String(args.filename ?? '').trim() || mediaBasename(file.displayPath ?? filePath)
          const namespace = String(args.namespace ?? '').trim() || `user:${config.username}`
          const { client } = await runtime.getClient()
          const result = await client.uploadMedia({
            data: file.bytes,
            filename,
            namespace,
            overwrite: args.overwrite === true,
          })
          return { ok: true, ...result }
        } catch (error) {
          throw withHint(error)
        }
      },
  })
}

const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true }

function registerSkill(ctx) {
  ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'runtime',
    content: SKILL_CONTENT,
    invocation: SKILL_INVOCATION,
  })
}

/**
 * Lazy mode: expose only `wiki_status` globally and let the skill provider
 * unlock the rest for one session when it loads the `dokuwiki` skill.
 */
function registerCoreTools(ctx, runtime) {
  registerReadTools(
    (definition) => (definition.name === 'wiki_status' ? ctx.tools.register(definition) : undefined),
    runtime,
  )
}

const SKILL_PROVIDER_NAME = 'dsh-dokuwiki'

/**
 * The lazy-mode skill provider. `get()` is the unlock hook: DSH calls it with
 * the invoking Agent in `options.scope` (for model- and user-invoked skill
 * loads alike), and the disclosure state machine registers the wiki tools in
 * that Agent's own scope.
 */
function registerSkillProvider(ctx, runtime, lazy) {
  ctx.effect(() =>
    ctx.skills.registerProvider(() => ({
      name: SKILL_PROVIDER_NAME,
      async list() {
        return [
          {
            name: SKILL_NAME,
            description: SKILL_DESCRIPTION,
            whenToUse: SKILL_WHEN_TO_USE,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'runtime',
            provider: SKILL_PROVIDER_NAME,
            rank: 100,
            locator: { kind: 'dsh-dokuwiki' },
          },
        ]
      },
      async get(_candidate, options) {
        await lazy.onSkillLoaded(options)
        return {
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse: SKILL_WHEN_TO_USE,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime',
          provider: SKILL_PROVIDER_NAME,
          content: SKILL_CONTENT,
        }
      },
    })),
  )
}

/**
 * Build a registrar that both registers a global tool and reports its
 * disposer, so capability gating can hide the write/upload tools again.
 */
function registrarWithRecord(ctx, record) {
  return (definition) => {
    const disposer = ctx.tools.register(definition)
    if (typeof record === 'function') record(disposer)
    return disposer
  }
}

/**
 * Keep the privileged tool sets in sync with the detected account
 * capabilities. DokuWiki's ACL decides whether the account may edit or upload;
 * when it may not, those tools are not offered to the model at all.
 */
function installCapabilityGating(ctx, runtime) {
  let writeToolDisposers = []
  let uploadToolDisposers = []
  const toggle = (enabled, disposers, register, enabledLog, disabledLog) => {
    if (enabled && disposers.length === 0) {
      const registered = []
      register((disposer) => {
        if (typeof disposer === 'function') registered.push(disposer)
      })
      disposers.push(...registered)
      ctx.logger?.debug?.(enabledLog)
    } else if (!enabled && disposers.length > 0) {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          /* best effort */
        }
      }
      ctx.logger?.debug?.(disabledLog)
    }
  }
  const sync = (detected) => {
    toggle(
      detected !== null && detected !== undefined && detected.edit === 'yes',
      writeToolDisposers,
      (record) => registerWriteTools(registrarWithRecord(ctx, record), runtime),
      '[dsh-dokuwiki] write tools enabled (ACL edit permission detected)',
      '[dsh-dokuwiki] write tools hidden (no edit permission detected)',
    )
    toggle(
      detected !== null && detected !== undefined && detected.upload === 'yes',
      uploadToolDisposers,
      (record) => registerUploadTools(registrarWithRecord(ctx, record), runtime, ctx),
      '[dsh-dokuwiki] media upload tool enabled (ACL upload permission detected)',
      '[dsh-dokuwiki] media upload tool hidden (no upload permission detected)',
    )
  }
  runtime.onCapabilities(sync)
  // The capability probe needs the credentials service. On a cold start the
  // service can mount after this plugin, so a first failure that mentions the
  // missing service is retried instead of leaving write tools hidden until the
  // next manual refresh.
  const runDetection = (attempt = 0) => {
    void runtime
      .detectCapabilities({ force: attempt > 0 })
      .then((detected) => {
        const startupRace =
          typeof detected?.error === 'string' && /without inject|credentials 服务/.test(detected.error)
        if (startupRace && attempt < 3) {
          const timer = setTimeout(() => runDetection(attempt + 1), 1000 * (attempt + 1))
          timer.unref?.()
          return
        }
        sync(detected)
      })
      .catch(() => sync(null))
  }
  runDetection()
}

/* ------------------------------------------------------------------ *
 * Configuration API for the browser half
 * ------------------------------------------------------------------ */

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new DokuWikiError('ARGUMENT', '请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new DokuWikiError('ARGUMENT', '请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Same trust fence the built-in plugin pages use: loopback or a trusted peer. */
function isTrustedRequest(ctx, request) {
  if (isLoopback(request)) return true
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (connection === undefined) return false
  try {
    if (typeof connection.isTrusted === 'function' && connection.isTrusted(request) === true) return true
    if (typeof connection.requestRejection === 'function') {
      const code = connection.requestRejection(request)
      return code === undefined || code === null || code === false
    }
  } catch {
    /* fail closed */
  }
  return false
}

function registerRoutes(ctx, runtime) {
  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      sendJson(response, 404, { ok: false, error: 'not found' })
      return
    }
    if (!isTrustedRequest(ctx, request)) {
      sendJson(response, 403, { ok: false, error: '不受信任的访问来源' })
      return
    }
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
    try {
      if (route === '/config' && request.method === 'GET') {
        const { config, warning } = runtime.readConfig()
        sendJson(response, 200, {
          ok: true,
          version: VERSION,
          packageName: PACKAGE_NAME,
          configPath: configPath(),
          config,
          warning: warning ?? null,
          credential: await runtime.credentialState(),
          capabilities: runtime.capabilities(),
        })
        return
      }
      if (route === '/config' && request.method === 'POST') {
        const body = await readJsonBody(request)
        const patch = {}
        if (body.baseUrls !== undefined) patch.baseUrls = body.baseUrls
        if (body.username !== undefined) patch.username = body.username
        if (body.enableWrite !== undefined) patch.enableWrite = body.enableWrite
        if (body.lazyTools !== undefined) patch.lazyTools = body.lazyTools
        if (body.timeoutMs !== undefined) patch.timeoutMs = body.timeoutMs
        if (body.conventionsPage !== undefined) patch.conventionsPage = body.conventionsPage
        const config = runtime.saveConfig(patch)
        void runtime.detectCapabilities({ force: true })
        sendJson(response, 200, {
          ok: true,
          saved: true,
          version: VERSION,
          configPath: configPath(),
          config,
          credential: await runtime.credentialState(),
          capabilities: runtime.capabilities(),
        })
        return
      }
      if (route === '/credential' && request.method === 'POST') {
        const body = await readJsonBody(request)
        if (body.clear === true) {
          await runtime.clearPassword()
        } else {
          const password = String(body.password ?? '')
          if (password === '') throw new DokuWikiError('ARGUMENT', '密码不能为空')
          await runtime.setPassword(password)
        }
        void runtime.detectCapabilities({ force: true })
        sendJson(response, 200, {
          ok: true,
          credential: await runtime.credentialState(),
          capabilities: runtime.capabilities(),
        })
        return
      }
      if (route === '/test' && request.method === 'POST') {
        try {
          const diagnostic = await runtime.testConnection()
          const capabilities = await runtime.detectCapabilities({ force: true })
          sendJson(response, 200, { ok: true, diagnostic, capabilities })
        } catch (error) {
          const wrapped = withHint(error)
          sendJson(response, 200, {
            ok: false,
            error: wrapped.message,
            code: isDokuWikiError(wrapped) ? wrapped.code : 'UNKNOWN',
            capabilities: runtime.capabilities(),
          })
        }
        return
      }
      sendJson(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error?.message ?? String(error),
        code: isDokuWikiError(error) ? error.code : 'UNKNOWN',
      })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    }),
  )
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const runtime = createRuntime(ctx)
  const { config } = runtime.readConfig()
  if (config.lazyTools) {
    // Session-scoped disclosure: only the status tool is global; the rest is
    // registered per Agent when that Agent loads the `dokuwiki` skill.
    const lazy = createLazyDisclosure({
      ctx,
      runtime,
      registerReadTools,
      registerWriteTools,
      // The upload tool needs the plugin context for its workspace file reader.
      registerUploadTools: (register, targetRuntime) => registerUploadTools(register, targetRuntime, ctx),
      log: (message) => ctx.logger?.debug?.(message),
    })
    registerCoreTools(ctx, runtime)
    registerSkillProvider(ctx, runtime, lazy)
  } else {
    registerReadTools((definition) => ctx.tools.register(definition), runtime)
    registerSkill(ctx)
    installCapabilityGating(ctx, runtime)
  }
  registerRoutes(ctx, runtime)
  ctx.logger?.debug?.(`[dsh-dokuwiki] v${VERSION} loaded (${config.lazyTools ? 'lazy tools' : 'eager tools'})`)
}

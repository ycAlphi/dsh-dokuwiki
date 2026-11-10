/**
 * Minimal, dependency-free DokuWiki client used by dsh-dokuwiki.
 *
 * DokuWiki (release 2024-02-06 "Kaos" and later) exposes two very different
 * access paths, and a usable integration needs both:
 *
 *  1. XML-RPC + HTTP Basic Auth (`/lib/exe/xmlrpc.php`) — rich read API, but
 *     only for accounts the wiki admin listed in `remoteuser`. Accounts that
 *     are not listed receive 401/403 there.
 *  2. Browser-style web form login + `do=export_raw` / `do=edit` /
 *     `do=save` — works for any account with ACL access, and is the only write
 *     path on many DokuWiki installations (their XML-RPC write methods are
 *     commonly disabled or denied to normal accounts).
 *
 * Nothing here imports a third-party package: Node's built-in `fetch`,
 * `URLSearchParams` and a tiny XML-RPC codec are enough. That keeps the
 * published plugin installable without a build step or native deps.
 */

const USER_AGENT = 'dsh-dokuwiki/0.1'
const DEFAULT_TIMEOUT_MS = 15000
const PROBE_TIMEOUT_MS = 8000
const MAX_INDEX_DEPTH = 10

export class DokuWikiError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable message
   * @param {{cause?: unknown, details?: Record<string, unknown>}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DokuWikiError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
  }
}

export function isDokuWikiError(error) {
  return error instanceof DokuWikiError
}

/* ------------------------------------------------------------------ *
 * XML-RPC codec
 * ------------------------------------------------------------------ */

function xmlEscape(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return whole
  })
}

/** Tiny XML reader sufficient for XML-RPC responses (no attributes used). */
function parseXml(input) {
  const root = { name: '#root', children: [], text: '' }
  const stack = [root]
  const current = () => stack[stack.length - 1]
  const pushText = (raw) => {
    if (raw !== '') current().text += decodeEntities(raw)
  }
  let index = 0
  while (index < input.length) {
    const lt = input.indexOf('<', index)
    if (lt === -1) {
      pushText(input.slice(index))
      break
    }
    if (lt > index) pushText(input.slice(index, lt))
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt)
      index = end === -1 ? input.length : end + 2
      continue
    }
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt)
      index = end === -1 ? input.length : end + 3
      continue
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt)
      pushText(input.slice(lt + 9, end === -1 ? input.length : end))
      index = end === -1 ? input.length : end + 3
      continue
    }
    if (input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt)
      index = end === -1 ? input.length : end + 1
      continue
    }
    const gt = input.indexOf('>', lt)
    if (gt === -1) break
    let tag = input.slice(lt + 1, gt).trim()
    const selfClosing = tag.endsWith('/')
    if (selfClosing) tag = tag.slice(0, -1).trim()
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim().toLowerCase()
      while (stack.length > 1) {
        const closed = stack.pop()
        if (closed.name === name) break
      }
    } else {
      const space = tag.search(/\s/)
      const name = (space === -1 ? tag : tag.slice(0, space)).toLowerCase()
      const node = { name, children: [], text: '' }
      current().children.push(node)
      if (!selfClosing) stack.push(node)
    }
    index = gt + 1
  }
  return root
}

function findChild(node, name) {
  return node.children.find((child) => child.name === name)
}

function findDescendant(node, name, limit = 64) {
  let visited = 0
  const queue = [...node.children]
  while (queue.length > 0 && visited < limit) {
    const child = queue.shift()
    visited += 1
    if (child.name === name) return child
    queue.push(...child.children)
  }
  return undefined
}

function nodeText(node) {
  return node === undefined ? '' : node.text.trim()
}

function xmlValueToJs(node) {
  const child = node.children.find((candidate) => !candidate.name.startsWith('#'))
  if (child === undefined) return decodeEntities(node.text).trim()
  switch (child.name) {
    case 'string':
      return child.text
    case 'int':
    case 'i4':
    case 'i8':
      return Number.parseInt(child.text.trim(), 10)
    case 'double':
      return Number.parseFloat(child.text.trim())
    case 'boolean':
      return child.text.trim() === '1'
    case 'nil':
      return null
    case 'base64':
      return child.text.trim()
    case 'dateTime.iso8601':
      return child.text.trim()
    case 'array': {
      const data = findChild(child, 'data')
      if (data === undefined) return []
      return data.children.filter((candidate) => candidate.name === 'value').map(xmlValueToJs)
    }
    case 'struct': {
      const struct = {}
      for (const member of child.children.filter((candidate) => candidate.name === 'member')) {
        const key = nodeText(findChild(member, 'name'))
        const valueNode = findChild(member, 'value')
        struct[key] = valueNode === undefined ? null : xmlValueToJs(valueNode)
      }
      return struct
    }
    default:
      return child.text
  }
}

function serializeXmlValue(value) {
  if (typeof value === 'string') return `<value><string>${xmlEscape(value)}</string></value>`
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `<value><int>${value}</int></value>`
      : `<value><double>${value}</double></value>`
  }
  if (typeof value === 'boolean') return `<value><boolean>${value ? '1' : '0'}</boolean></value>`
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(serializeXmlValue).join('')}</data></array></value>`
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .map(([key, entry]) => `<member><name>${xmlEscape(key)}</name>${serializeXmlValue(entry)}</member>`)
      .join('')
    return `<value><struct>${members}</struct></value>`
  }
  return `<value><string></string></value>`
}

function buildMethodCall(method, params) {
  const encoded = params.map((param) => `<param>${serializeXmlValue(param)}</param>`).join('')
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>${encoded}</params></methodCall>`
}

/**
 * Parse one XML-RPC response body. Returns the method result value.
 * Throws `DokuWikiError('XMLRPC_FAULT')` when the server returns a fault.
 */
export function parseXmlRpcResponse(text) {
  const root = parseXml(text)
  const response = findChild(root, 'methodresponse') ?? findDescendant(root, 'methodresponse')
  if (response === undefined) {
    throw new DokuWikiError('XMLRPC_PROTOCOL', 'XML-RPC 响应格式无法识别（可能被登录页/代理拦截）')
  }
  const fault = findChild(response, 'fault')
  if (fault !== undefined) {
    const valueNode = findChild(fault, 'value')
    const faultValue = valueNode === undefined ? {} : xmlValueToJs(valueNode)
    const code = faultValue?.faultCode ?? 'unknown'
    const message = String(faultValue?.faultString ?? 'XML-RPC fault')
    throw new DokuWikiError('XMLRPC_FAULT', `XML-RPC 调用失败 [${code}]: ${message}`, {
      details: { faultCode: code, faultString: message },
    })
  }
  const params = findChild(response, 'params')
  if (params === undefined) return null
  const firstParam = params.children.find((candidate) => candidate.name === 'param')
  if (firstParam === undefined) return null
  const valueNode = findChild(firstParam, 'value')
  if (valueNode === undefined) return null
  return xmlValueToJs(valueNode)
}

/* ------------------------------------------------------------------ *
 * HTML form helpers
 * ------------------------------------------------------------------ */

function parseHtmlInputs(html, { formId } = {}) {
  let scope = html
  if (formId !== undefined) {
    const pattern = new RegExp(`<form[^>]*id=["']${formId}["'][^>]*>([\\s\\S]*?)</form>`, 'i')
    const match = pattern.exec(html)
    if (match === null) return undefined
    scope = match[1]
  }
  const fields = {}
  for (const match of scope.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0]
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (name === undefined || name === '') continue
    const type = (/\btype\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '').toLowerCase()
    if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'file') continue
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    fields[name] = value
  }
  return fields
}

function htmlUnescape(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
}

function parseIndexBranch(html, namespace) {
  const subNamespaces = []
  const pages = []
  const prefix = namespace === '' ? '' : `${namespace}:`
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0]
    const className = /\bclass\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    if (!/\b(idx_dir|wikilink1)\b/.test(className)) continue
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (href === undefined) continue
    const decodedHref = htmlUnescape(href)
    const queryIndex = decodedHref.indexOf('?')
    if (queryIndex === -1) continue
    const params = new URLSearchParams(decodedHref.slice(queryIndex + 1))
    const rawId = params.get('idx') ?? params.get('id') ?? ''
    if (rawId === '') continue
    // A namespace prefix needs its separator; the root namespace has no prefix
    // at all, so requiring `:` there filtered out every top-level page and
    // namespace and made web-mode listing return an empty list.
    if (prefix !== '' && !rawId.startsWith(prefix)) continue
    if (className.includes('idx_dir')) {
      if (!subNamespaces.includes(rawId)) subNamespaces.push(rawId)
    } else if (!pages.includes(rawId)) {
      pages.push(rawId)
    }
  }
  return { subNamespaces: subNamespaces.sort(), pages: pages.sort() }
}

function extractSearchPageIds(html) {
  const ids = []
  for (const match of html.matchAll(/doku\.php\?id=([^"'&]+)/gi)) {
    let id = match[1]
    try {
      id = decodeURIComponent(id)
    } catch {
      /* keep raw */
    }
    id = htmlUnescape(id).replace(/#.*$/, '')
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Strip markup from one HTML fragment and collapse whitespace. */
function stripHtmlText(html) {
  return htmlUnescape(
    String(html ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' '),
  )
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse a DokuWiki "Recent changes" page (the rendered changelog list) into
 * structured entries. DokuWiki emits one `<li><div class="li">…` per change;
 * page edits carry a `diff_link`, media changes link to `do=media`, and both
 * name the page/media id in their first `wikilink` anchor.
 *
 * @param {string} html rendered recent changes page
 * @returns {{date: string, pageid: string, user: string, summary: string, type: 'page'|'mediafile'}[]}
 */
function parseRecentChanges(html) {
  const entries = []
  for (const match of html.matchAll(/<li[^>]*><div class="li">([\s\S]*?)<\/div><\/li>/gi)) {
    const chunk = match[1]
    const date = /class="date">\s*([^<]+?)\s*</.exec(chunk)?.[1] ?? ''
    const title = /class="wikilink[12]"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk)
    if (date === '' || title === null) continue
    const pageid = stripHtmlText(title[1])
    if (pageid === '') continue
    const user = stripHtmlText(/class="user"[^>]*>\s*<bdi[^>]*>([\s\S]*?)<\/bdi>/i.exec(chunk)?.[1] ?? '')
    const rawSummary = /class="sum">([\s\S]*?)<\/span>/i.exec(chunk)?.[1] ?? ''
    const summary = stripHtmlText(rawSummary).replace(/^[—–-]\s*/, '')
    const type = /class="diff_link"/i.test(chunk) || /&amp;do=diff|&do=diff/i.test(chunk) ? 'page' : 'mediafile'
    entries.push({ date, pageid, user, summary, type })
  }
  return entries
}


/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

function normalizeBaseUrl(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withScheme.replace(/\/+$/, '')
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

class CookieJar {
  #cookies = new Map()

  absorb(headers) {
    let lines = []
    if (typeof headers.getSetCookie === 'function') {
      lines = headers.getSetCookie()
    } else {
      const single = headers.get('set-cookie')
      if (single !== null) lines = [single]
    }
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';')
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      const expired = attributes.some(
        (attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/i.test(attribute),
      )
      if (expired || value === '') this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  clear() {
    this.#cookies.clear()
  }
}

export class DokuWikiClient {
  #config
  #base = null
  #mode = null
  #connection = null
  #loggedIn = false
  #cookieJar = new CookieJar()
  #sectok = null
  #onLog = null

  /**
   * @param {{baseUrls: string[], username: string, password: string,
   *          timeoutMs?: number, probeTimeoutMs?: number,
   *          onLog?: (message: string) => void}} options
   */
  constructor(options) {
    const baseUrls = (options.baseUrls ?? []).map(normalizeBaseUrl).filter((base) => base !== '')
    if (baseUrls.length === 0) throw new DokuWikiError('CONFIG', '没有配置 DokuWiki base URL')
    if (!options.username) throw new DokuWikiError('CONFIG', '没有配置 DokuWiki 用户名')
    this.#config = {
      baseUrls,
      username: options.username,
      password: options.password ?? '',
      timeoutMs: Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      probeTimeoutMs: Number(options.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
    }
    this.#onLog = typeof options.onLog === 'function' ? options.onLog : null
  }

  get baseUrl() {
    return this.#base
  }

  get mode() {
    return this.#mode
  }

  #log(message) {
    if (this.#onLog !== null) this.#onLog(message)
  }

  /* ---------------- HTTP ---------------- */

  async #request(pathOrUrl, { method = 'GET', headers = {}, body, timeoutMs, probe = false } = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.#base}${pathOrUrl}`
    const signal = AbortSignal.timeout(probe ? this.#config.probeTimeoutMs : (timeoutMs ?? this.#config.timeoutMs))
    const requestHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    }
    const cookie = this.#cookieJar.header()
    if (cookie !== '') requestHeaders.Cookie = cookie
    let response
    try {
      response = await fetch(url, { method, headers: requestHeaders, body, signal, redirect: 'follow' })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw new DokuWikiError(
        'NETWORK',
        timedOut ? `请求超时（${url}）` : `网络请求失败（${url}）：${error?.message ?? error}`,
        { cause: error },
      )
    }
    this.#cookieJar.absorb(response.headers)
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    return { status: response.status, ok: response.status >= 200 && response.status < 400, text, headers: response.headers }
  }

  /**
   * Submit a browser-style form. DokuWiki answers with 302 + Set-Cookie for a
   * successful login/save; fetch's automatic redirect would hide that cookie
   * from us, so redirects are followed manually after absorbing the cookies.
   */
  async #submitForm(pathOrUrl, { body, headers = {}, timeoutMs } = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.#base}${pathOrUrl}`
    const signal = AbortSignal.timeout(timeoutMs ?? this.#config.timeoutMs)
    const requestHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    }
    const cookie = this.#cookieJar.header()
    if (cookie !== '') requestHeaders.Cookie = cookie
    let response
    try {
      response = await fetch(url, { method: 'POST', headers: requestHeaders, body, signal, redirect: 'manual' })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw new DokuWikiError(
        'NETWORK',
        timedOut ? `请求超时（${url}）` : `网络请求失败（${url}）：${error?.message ?? error}`,
        { cause: error },
      )
    }
    this.#cookieJar.absorb(response.headers)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      try {
        await response.arrayBuffer()
      } catch {
        /* drain */
      }
      if (location !== null) {
        return this.#request(new URL(location, url).toString(), { timeoutMs })
      }
    }
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    return { status: response.status, ok: response.status >= 200 && response.status < 400, text, headers: response.headers }
  }

  /** Same as #request but returns raw bytes (media verification). */
  async #requestBytes(pathOrUrl, { timeoutMs } = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.#base}${pathOrUrl}`
    const signal = AbortSignal.timeout(timeoutMs ?? this.#config.timeoutMs)
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    }
    const cookie = this.#cookieJar.header()
    if (cookie !== '') headers.Cookie = cookie
    let response
    try {
      response = await fetch(url, { headers, signal, redirect: 'follow' })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw new DokuWikiError(
        'NETWORK',
        timedOut ? `请求超时（${url}）` : `网络请求失败（${url}）：${error?.message ?? error}`,
        { cause: error },
      )
    }
    this.#cookieJar.absorb(response.headers)
    const bytes = Buffer.from(await response.arrayBuffer())
    return { status: response.status, ok: response.status >= 200 && response.status < 400, bytes }
  }

  async #xmlrpc(method, params = []) {
    const url = `${this.#base}/lib/exe/xmlrpc.php`
    const response = await this.#request(url, {
      method: 'POST',
      headers: {
        // DokuWiki's XML-RPC endpoint only accepts the bare XML media type:
        // `text/xml; charset=utf-8` is rejected with fault -32606
        // ("XML-RPC server accepts XML requests only").
        'Content-Type': 'text/xml',
        Authorization: basicAuthHeader(this.#config.username, this.#config.password),
      },
      body: buildMethodCall(method, params),
    })
    if (response.status === 401 || response.status === 403) {
      throw new DokuWikiError('XMLRPC_DENIED', 'XML-RPC 被拒绝（账号不在 remoteuser）', {
        details: { status: response.status },
      })
    }
    if (!response.ok) {
      throw new DokuWikiError('XMLRPC_HTTP', `XML-RPC HTTP ${response.status}`)
    }
    return parseXmlRpcResponse(response.text)
  }

  /* ---------------- connection ---------------- */

  /**
   * Pick the first reachable base URL and the richest available access mode.
   * XML-RPC wins when the account may use it; otherwise web-form mode is used.
   */
  async connect() {
    if (this.#connection !== null) return this.#connection
    const failures = []
    for (const base of this.#config.baseUrls) {
      this.#base = base
      this.#cookieJar.clear()
      this.#loggedIn = false
      try {
        const version = await this.#xmlrpc('dokuwiki.getVersion')
        this.#mode = 'rpc'
        this.#connection = { base, mode: 'rpc', version: typeof version === 'string' ? version : null }
        this.#log(`[dokuwiki] ${base} 使用 XML-RPC 模式`)
        return this.#connection
      } catch (error) {
        failures.push(`${base}: ${error.message}`)
        if (!(error instanceof DokuWikiError) || !['XMLRPC_DENIED', 'NETWORK', 'XMLRPC_HTTP', 'XMLRPC_PROTOCOL', 'XMLRPC_FAULT'].includes(error.code)) {
          throw error
        }
      }
      // XML-RPC unavailable: is the wiki itself reachable through the web UI?
      try {
        const probe = await this.#request('/doku.php', { probe: true })
        if (!probe.ok) {
          failures.push(`${base}: HTTP ${probe.status}（/doku.php）`)
          continue
        }
      } catch (error) {
        failures.push(`${base}: ${error.message}`)
        continue
      }
      try {
        await this.#login()
        this.#mode = 'web'
        this.#connection = { base, mode: 'web', version: null }
        this.#log(`[dokuwiki] ${base} 使用网页表单模式（XML-RPC 不可用）`)
        return this.#connection
      } catch (error) {
        failures.push(`${base}: ${error.message}`)
      }
    }
    throw new DokuWikiError('NO_BASE', `无法连接 DokuWiki 或登录失败：\n  ${failures.join('\n  ')}`)
  }

  /* ---------------- login ---------------- */

  async #login() {
    const loginUrl = `${this.#base}/doku.php?id=start&do=login`
    const page = await this.#request(loginUrl, {
      headers: { Referer: loginUrl, Origin: this.#base },
      timeoutMs: this.#config.timeoutMs,
    })
    if (page.status === 403) {
      throw new DokuWikiError(
        'AUTH_LOCKED',
        '登录页返回 403。DokuWiki 连续登录失败会锁定约 15 分钟，请稍后再试，不要连续重试。',
      )
    }
    if (!page.ok) throw new DokuWikiError('AUTH', `无法读取登录页（HTTP ${page.status}）`)
    const fields = parseHtmlInputs(page.text) ?? {}
    fields.u = this.#config.username
    fields.p = this.#config.password
    const body = new URLSearchParams(fields).toString()
    const response = await this.#submitForm('/doku.php', {
      headers: { Origin: this.#base, Referer: loginUrl },
      body,
    })
    if (!response.text.includes('do=logout')) {
      throw new DokuWikiError(
        'AUTH',
        '登录失败：账号或密码不正确。不要连续重试 —— DokuWiki 连续失败锁定会连带 XML-RPC 一起锁约 15 分钟。',
        { details: { status: response.status } },
      )
    }
    this.#loggedIn = true
    this.#sectok = null
    this.#log(`[dokuwiki] 已登录：${this.#config.username}`)
  }

  async #ensureWebSession() {
    if (this.#connection === null) await this.connect()
    if (this.#loggedIn) return
    await this.#login()
  }

  /* ---------------- read paths ---------------- */

  /** Fetch raw wiki source for a page. */
  async getPage(pageid) {
    if (typeof pageid !== 'string' || pageid.trim() === '') {
      throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
    }
    await this.connect()
    if (this.#mode === 'rpc') {
      try {
        const value = await this.#xmlrpc('wiki.getPage', [pageid])
        if (typeof value === 'string' && value !== '') return { source: value, via: 'xmlrpc' }
        if (typeof value === 'string' && value === '') {
          // XML-RPC returns an empty string both for an empty page and for a
          // missing one; the raw export distinguishes them (missing/denied
          // answers with an HTML page).
          await this.#ensureWebSession()
          const source = await this.exportRaw(pageid)
          return { source, via: 'export_raw' }
        }
      } catch (error) {
        if (!(error instanceof DokuWikiError)) throw error
        if (error.code === 'DENIED' || error.code === 'AUTH' || error.code === 'AUTH_LOCKED') throw error
        this.#log(`[dokuwiki] XML-RPC getPage 失败（${error.message}），改用 export_raw`)
      }
    }
    await this.#ensureWebSession()
    const source = await this.exportRaw(pageid)
    return { source, via: 'export_raw' }
  }

  /** Raw export; throws DENIED for permission errors and missing pages. */
  async exportRaw(pageid) {
    const response = await this.#request(`/doku.php?do=export_raw&id=${encodeURIComponent(pageid)}`)
    if (response.status === 401 || response.status === 403) {
      throw new DokuWikiError('AUTH', `没有权限读取页面 ${pageid}（HTTP ${response.status}）`)
    }
    if (!response.ok) throw new DokuWikiError('HTTP', `读取页面失败（HTTP ${response.status}）`)
    const head = response.text.replace(/^\uFEFF/, '').trimStart().slice(0, 15).toLowerCase()
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
      throw new DokuWikiError('DENIED', `页面不存在或无权访问：${pageid}`)
    }
    return response.text
  }

  /** List pages in a namespace. `depth` 0 = this level only, >0 = recurse. */
  async listPages(namespace = '', { depth = 0 } = {}) {
    const namespaceId = String(namespace ?? '').replace(/:+$/, '')
    await this.connect()
    if (this.#mode === 'rpc') {
      try {
        const value = await this.#xmlrpc('dokuwiki.getPagelist', [namespaceId, { depth: depth > 0 ? depth : 0 }])
        if (Array.isArray(value)) {
          return {
            pages: value
              .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
              .map((entry) => ({ id: entry.id, size: entry.size ?? null, rev: entry.rev ?? null, mtime: entry.mtime ?? null })),
            via: 'xmlrpc',
          }
        }
      } catch (error) {
        if (!(error instanceof DokuWikiError)) throw error
        this.#log(`[dokuwiki] XML-RPC getPagelist 失败（${error.message}），改用 index 分支`)
      }
    }
    await this.#ensureWebSession()
    const pages = []
    await this.#walkIndex(namespaceId, depth > 0 ? depth : 0, pages, 0, new Set())
    return { pages, via: 'index' }
  }

  async #walkIndex(namespaceId, remainingDepth, out, currentDepth, seen) {
    if (currentDepth > MAX_INDEX_DEPTH) return
    const url = `/doku.php?do=index&idx=${encodeURIComponent(namespaceId)}`
    const page = await this.#request(url)
    if (!page.ok) throw new DokuWikiError('HTTP', `读取命名空间索引失败（HTTP ${page.status}）`)
    const { subNamespaces, pages } = parseIndexBranch(page.text, namespaceId)
    for (const id of pages) {
      if (!seen.has(id)) {
        seen.add(id)
        out.push({ id, size: null, rev: null, mtime: null })
      }
    }
    if (remainingDepth <= 0) return
    for (const subNamespace of subNamespaces) {
      if (remainingDepth - 1 < 0) break
      await this.#walkIndex(subNamespace, remainingDepth - 1, out, currentDepth + 1, seen)
    }
  }

  /** Full-text search. XML-RPC first; HTML search page as fallback. */
  async search(query) {
    const text = String(query ?? '').trim()
    if (text === '') throw new DokuWikiError('ARGUMENT', 'query 不能为空')
    await this.connect()
    if (this.#mode === 'rpc') {
      try {
        const value = await this.#xmlrpc('dokuwiki.search', [text, {}])
        if (Array.isArray(value)) {
          return {
            results: value
              .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
              .map((entry) => ({ id: entry.id, title: entry.title ?? '', snippet: entry.snippet ?? '' })),
            via: 'xmlrpc',
          }
        }
      } catch (error) {
        if (!(error instanceof DokuWikiError)) throw error
        this.#log(`[dokuwiki] XML-RPC search 失败（${error.message}），改用网页搜索`)
      }
    }
    await this.#ensureWebSession()
    const page = await this.#request(`/doku.php?do=search&q=${encodeURIComponent(text)}`)
    if (!page.ok) throw new DokuWikiError('HTTP', `搜索失败（HTTP ${page.status}）`)
    return { results: extractSearchPageIds(page.text).map((id) => ({ id, title: '', snippet: '' })), via: 'html' }
  }

  /**
   * The most recent changes from the wiki's authenticated Recent changes page
   * (pages and media files). The page is HTML in every access mode, so it uses
   * the web session even for XML-RPC accounts.
   *
   * @param {{limit?: number}} [options] maximum entries to return (1–50)
   */
  async recentChanges({ limit = 20 } = {}) {
    const requested = Number(limit)
    const max = Math.min(Math.max(Number.isFinite(requested) ? Math.trunc(requested) : 20, 1), 50)
    await this.connect()
    await this.#ensureWebSession()
    const url = '/doku.php?do=recent&first=0&show_changes=0'
    const fetchPage = async () => {
      const page = await this.#request(url)
      if (!page.ok) throw new DokuWikiError('HTTP', `读取最近更改失败（HTTP ${page.status}）`)
      return page.text
    }
    let html = await fetchPage()
    // An expired session serves the login form instead of the changelog.
    if (!/class="date"/.test(html) && /do=login/.test(html) && !/do=logout/.test(html)) {
      this.#loggedIn = false
      await this.#ensureWebSession()
      html = await fetchPage()
    }
    const items = parseRecentChanges(html).slice(0, max)
    return { items, via: 'recent' }
  }

  /** Page revisions. Requires XML-RPC (web form pages are not parsed). */
  async pageVersions(pageid) {
    const id = String(pageid ?? '').trim()
    if (id === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
    await this.connect()
    if (this.#mode !== 'rpc') {
      throw new DokuWikiError('UNSUPPORTED', '当前账号只能走网页表单模式，无法读取历史版本（需要 XML-RPC 权限）')
    }
    const value = await this.#xmlrpc('wiki.getPageVersions', [id, 0])
    if (!Array.isArray(value)) return []
    // DokuWiki's wiki.getPageVersions structs use: version (unix seconds),
    // user, ip, type ("C"/"E"/...), sum, modified (ISO string). Older/other
    // implementations may use summary/date instead, so accept both spellings.
    return value
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        version: Number.isFinite(entry.version) ? entry.version : null,
        date: Number.isFinite(entry.date)
          ? entry.date
          : Number.isFinite(entry.version)
            ? entry.version
            : null,
        modified: typeof entry.modified === 'string' ? entry.modified : '',
        user: entry.user ?? '',
        summary: entry.sum ?? entry.summary ?? '',
        type: entry.type ?? '',
        ip: entry.ip ?? '',
        size: Number.isFinite(entry.size) ? entry.size : null,
      }))
  }

  /* ---------------- media: upload & permission probes ---------------- */

  /**
   * Session CSRF token. DokuWiki renders it into the logout link (and into the
   * DOKU_SECTok JS variable on some templates); it is required by the AJAX
   * upload endpoint.
   */
  async #getSectok() {
    if (this.#sectok !== null) return this.#sectok
    const page = await this.#request('/doku.php?id=start')
    if (!page.ok) throw new DokuWikiError('HTTP', `无法读取 wiki 页面（HTTP ${page.status}）`)
    const patterns = [
      /do=logout(?:&amp;|&)sectok=([0-9a-f]+)/i,
      /DOKU_SECTok\s*=\s*['"]([0-9a-f]+)['"]/i,
      /name=["']sectok["']\s+value=["']([0-9a-f]+)["']/i,
    ]
    for (const pattern of patterns) {
      const match = pattern.exec(page.text)
      if (match !== null && match[1] !== '') {
        this.#sectok = match[1]
        return this.#sectok
      }
    }
    throw new DokuWikiError('AUTH', '无法从页面获取 CSRF token（sectok），无法执行上传')
  }

  /**
   * Probe media-upload permission for a namespace.
   *
   * The media manager serves its upload form only when the account has
   * AUTH_UPLOAD for that namespace, so the rendered page is a reliable
   * permission probe — DokuWiki exposes no ACL read API.
   */
  async canUpload(namespace = '') {
    const ns = String(namespace ?? '').replace(/:+$/, '')
    await this.connect()
    await this.#ensureWebSession()
    const page = await this.#request(`/lib/exe/mediamanager.php?ns=${encodeURIComponent(ns)}`)
    if (!page.ok) throw new DokuWikiError('HTTP', `读取媒体管理器失败（HTTP ${page.status}）`)
    const allowed = page.text.includes('dw__upload') && !page.text.includes('media_perm_upload')
    return { canUpload: allowed, namespace: ns }
  }

  /**
   * Download one media file through `/lib/exe/fetch.php` and return its bytes.
   *
   * Media access follows the wiki ACL of the configured account, so this always
   * uses the logged-in web session (even in XML-RPC mode).
   */
  async downloadMedia(mediaid) {
    const id = String(mediaid ?? '')
      .trim()
      .replace(/^:+/, '')
    if (id === '') throw new DokuWikiError('ARGUMENT', 'mediaid 不能为空')
    if (id.split(':').some((part) => part === '' || part === '.' || part === '..') || /[\\/]/.test(id)) {
      throw new DokuWikiError('ARGUMENT', `mediaid 不合法：${id}`)
    }
    await this.#ensureWebSession()
    const stored = await this.#requestBytes(`/lib/exe/fetch.php?media=${encodeURIComponent(id)}`)
    if (stored.status === 401 || stored.status === 403) {
      throw new DokuWikiError('DENIED', `没有权限读取媒体文件：${id}`)
    }
    if (!stored.ok) throw new DokuWikiError('HTTP', `读取媒体文件失败（HTTP ${stored.status}）：${id}`)
    if (stored.bytes.length === 0) throw new DokuWikiError('HTTP', `媒体文件为空：${id}`)
    return {
      mediaid: id,
      bytes: stored.bytes,
      url: `${this.#base}/lib/exe/fetch.php?media=${encodeURIComponent(id)}`,
    }
  }

  /**
   * Upload one media file through the media manager AJAX endpoint and verify
   * that the stored file can be downloaded byte-for-byte.
   * Returns { mediaid, namespace, url, bytes }.
   */
  async uploadMedia({ data, filename, namespace, overwrite = false } = {}) {
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Buffer.from(String(data ?? ''))
    if (bytes.length === 0) throw new DokuWikiError('ARGUMENT', '上传内容为空')
    const rawName = String(filename ?? '').trim()
    if (rawName === '') throw new DokuWikiError('ARGUMENT', 'filename 不能为空')
    if (/[\\/]/.test(rawName)) throw new DokuWikiError('ARGUMENT', 'filename 不能包含路径')
    const ns = String(namespace ?? '').replace(/:+$/, '') || `user:${this.#config.username}`
    await this.connect()
    await this.#ensureWebSession()
    const permission = await this.canUpload(ns)
    if (!permission.canUpload) {
      throw new DokuWikiError('ACL', `当前账号没有在命名空间 "${ns}" 上传文件的权限（DokuWiki ACL）`)
    }
    const sectok = await this.#getSectok()
    const form = new FormData()
    form.append('qqfile', new Blob([bytes], { type: 'application/octet-stream' }), rawName)
    form.append('ns', ns)
    form.append('mediaid', rawName)
    form.append('sectok', sectok)
    if (overwrite) form.append('ow', '1')
    const response = await this.#request(
      `/lib/exe/ajax.php?call=mediaupload&ns=${encodeURIComponent(ns)}`,
      {
        method: 'POST',
        headers: {
          Origin: this.#base,
          Referer: `${this.#base}/doku.php?do=media&ns=${encodeURIComponent(ns)}`,
        },
        body: form,
      },
    )
    let payload
    try {
      payload = JSON.parse(response.text)
    } catch {
      throw new DokuWikiError(
        'UPLOAD',
        `上传接口返回了非 JSON 内容（HTTP ${response.status}）：${response.text.slice(0, 200)}`,
      )
    }
    if (response.status !== 200 || payload.error !== undefined) {
      throw new DokuWikiError(
        'UPLOAD',
        `上传失败：${payload.error !== undefined ? payload.error : `HTTP ${response.status}`}`,
      )
    }
    const mediaid = payload.id ?? `${ns}:${rawName}`
    const stored = await this.#requestBytes(`/lib/exe/fetch.php?media=${encodeURIComponent(mediaid)}`)
    if (!stored.ok) {
      throw new DokuWikiError('UPLOAD', `上传后无法读取文件（HTTP ${stored.status}）：${mediaid}`)
    }
    if (stored.bytes.length !== bytes.length || !stored.bytes.equals(Buffer.from(bytes))) {
      throw new DokuWikiError('UPLOAD', `上传后校验失败：服务器上的文件与本地不一致（${mediaid}）`)
    }
    return {
      mediaid,
      namespace: payload.ns ?? ns,
      url: `${this.#base}/lib/exe/fetch.php?media=${encodeURIComponent(mediaid)}`,
      bytes: bytes.length,
    }
  }

  /**
   * Probe what the account may do inside one namespace, using only the network
   * surfaces DokuWiki exposes:
   *   - upload: media manager page serves the upload form only with AUTH_UPLOAD
   *   - create: the edit form is served for a fresh probe page only when the
   *     account may create pages there
   *   - edit/delete: the edit form of an existing page in the namespace
   *   - read: reading an existing page in the namespace
   * Delete follows edit permission in DokuWiki (saving empty text deletes).
   */
  async probePermissions(namespace = '') {
    const ns = String(namespace ?? '').replace(/:+$/, '')
    await this.connect()
    await this.#ensureWebSession()
    const result = {
      namespace: ns,
      read: 'unknown',
      edit: 'unknown',
      create: 'unknown',
      delete: 'unknown',
      upload: 'unknown',
      probes: {},
      warnings: [],
    }
    const recordWarning = (label, error) => {
      result.warnings.push(`${label}: ${error.message}`)
    }

    try {
      const upload = await this.canUpload(ns)
      result.upload = upload.canUpload ? 'yes' : 'no'
      result.probes.upload = 'media manager page'
    } catch (error) {
      if (!(error instanceof DokuWikiError)) throw error
      recordWarning('upload', error)
    }

    const createProbe = `${ns}:dsh_dokuwiki_permission_probe`.replace(/^:/, '')
    try {
      const probe = await this.canEdit(createProbe)
      result.create = probe.canEdit ? 'yes' : 'no'
      result.probes.create = `edit form on ${createProbe}`
    } catch (error) {
      if (!(error instanceof DokuWikiError)) throw error
      recordWarning('create', error)
    }

    let existingPage = null
    try {
      // depth > 0 so pages nested below the namespace are found; otherwise a
      // namespace that only contains sub-namespaces reports no readable page.
      const listing = await this.listPages(ns, { depth: 3 })
      existingPage = listing.pages.map((entry) => entry.id).find((id) => id !== createProbe) ?? null
      result.probes.list = `${listing.pages.length} pages via ${listing.via}`
    } catch (error) {
      if (!(error instanceof DokuWikiError)) throw error
      recordWarning('list', error)
    }

    if (existingPage === null) {
      // Some templates render only namespace folders in the index tree, so the
      // listing above yields no pages even when the namespace has readable
      // content. Fall back to the conventional `<namespace>:start` page.
      const fallbackPage = ns === '' ? 'start' : `${ns}:start`
      try {
        await this.getPage(fallbackPage)
        existingPage = fallbackPage
        result.probes.list = `index returned no pages; using ${fallbackPage}`
      } catch (error) {
        if (!(error instanceof DokuWikiError)) throw error
        recordWarning('read', error)
      }
    }

    if (existingPage !== null) {
      try {
        await this.getPage(existingPage)
        result.read = 'yes'
      } catch (error) {
        if (error instanceof DokuWikiError && ['DENIED', 'AUTH', 'AUTH_LOCKED'].includes(error.code)) {
          result.read = 'no'
        } else {
          recordWarning('read', error)
        }
      }
      try {
        const probe = await this.canEdit(existingPage)
        result.edit = probe.canEdit ? 'yes' : 'no'
        result.probes.edit = `edit form on ${existingPage}`
      } catch (error) {
        if (!(error instanceof DokuWikiError)) throw error
        recordWarning('edit', error)
      }
    } else {
      result.probes.read = 'no readable page found in this namespace'
      result.probes.edit = 'no existing page to probe'
    }
    result.delete = result.edit
    return result
  }

  /* ---------------- write paths ---------------- */

  async #openEditForm(pageid, { allowRelogin = true } = {}) {
    const editUrl = `/doku.php?id=${encodeURIComponent(pageid)}&do=edit`
    const page = await this.#request(editUrl)
    if (page.status === 401 || page.status === 403) {
      throw new DokuWikiError('ACL', `没有权限编辑该页面（HTTP ${page.status}）`)
    }
    if (!page.ok) throw new DokuWikiError('HTTP', `无法打开编辑页（HTTP ${page.status}）`)
    if (page.text.includes('id="dw__editform"') || page.text.includes("id='dw__editform'")) {
      return { html: page.text, url: editUrl }
    }
    // Session expired: the wiki serves the login form instead of the editor.
    if (allowRelogin && /do=login/.test(page.text) && !/do=logout/.test(page.text)) {
      this.#loggedIn = false
      await this.#login()
      return this.#openEditForm(pageid, { allowRelogin: false })
    }
    throw new DokuWikiError('ACL', `当前 wiki 账号无权编辑 ${pageid}（编辑表单未提供）`)
  }

  /**
   * Ask DokuWiki's asynchronous indexer to index one page (the same web bug a
   * browser triggers when a page is viewed). Best effort: full-text search can
   * only find content that has been indexed.
   */
  async indexPage(pageid) {
    await this.#ensureWebSession()
    try {
      await this.#request(`/lib/exe/indexer.php?id=${encodeURIComponent(pageid)}&${Date.now()}`, {
        timeoutMs: 10000,
      })
      return true
    } catch (error) {
      this.#log(`[dokuwiki] 触发索引器失败（${error.message}）`)
      return false
    }
  }

  /** Release the DokuWiki edit lock without saving. */
  async cancelEdit(pageid) {    await this.#ensureWebSession()
    try {
      await this.#request(`/doku.php?id=${encodeURIComponent(pageid)}&do=cancel`, { timeoutMs: 8000 })
      return true
    } catch (error) {
      this.#log(`[dokuwiki] 释放编辑锁失败（${error.message}）`)
      return false
    }
  }

  /** Submit the edit form with the given raw source (shared by write/delete). */
  async #saveText(pageid, text, editSummary) {
    const form = await this.#openEditForm(pageid)
    const fields = parseHtmlInputs(form.html, { formId: 'dw__editform' })
    if (fields === undefined) {
      throw new DokuWikiError('ACL', `无法解析编辑表单（${pageid}），可能 ACL 拒绝了该页面`)
    }
    fields.wikitext = text
    fields.summary = editSummary
    fields.do = 'save'
    const body = new URLSearchParams(fields).toString()
    const response = await this.#submitForm('/doku.php', {
      headers: { Origin: this.#base, Referer: `${this.#base}${form.url}` },
      body,
    })
    if (!response.ok) {
      throw new DokuWikiError('HTTP', `保存请求失败（HTTP ${response.status}）`)
    }
    return response
  }

  /**
   * Create or edit a page through the browser edit form.
   * Returns { valid: true, verified, chars } or { valid: false, reason }.
   */
  async writePage({ pageid, text, summary }) {
    const id = String(pageid ?? '').trim()
    if (id === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
    if (typeof text !== 'string') throw new DokuWikiError('ARGUMENT', 'text 必须是字符串')
    const editSummary = String(summary ?? '').trim()
    if (editSummary === '') throw new DokuWikiError('ARGUMENT', 'summary 不能为空：Recent Changes 里必须能看懂这次改了什么')
    if (text.trim() === '') {
      // DokuWiki stores empty text as a page deletion. Keep the two operations
      // explicit: an empty body in a normal write is almost always a bug.
      throw new DokuWikiError(
        'UNSUPPORTED',
        '普通写入不能保存空内容（DokuWiki 会把空文本当成删除页面）。要删除页面请用 wiki_delete_page。',
      )
    }
    await this.connect()
    await this.#ensureWebSession()
    await this.#saveText(id, text, editSummary)
    const trimmed = text.trim()
    let readback = ''
    try {
      readback = await this.exportRaw(id)
    } catch (error) {
      return { valid: false, reason: `保存后回读失败：${error.message}` }
    }
    if (readback.includes(trimmed)) {
      return { valid: true, verified: true, chars: text.length }
    }
    return {
      valid: false,
      reason:
        '保存未生效（DokuWiki 没有报错但内容未落盘）。已知原因：字段缺失会被当作取消编辑；请检查账号编辑权限，或稍后重试。',
    }
  }

  /**
   * Delete one page. In DokuWiki saving empty text removes the page, so this is
   * the explicit delete operation; the result is verified by re-reading.
   * Returns { deleted: true } or { deleted: false, reason }.
   */
  async deletePage({ pageid, summary }) {
    const id = String(pageid ?? '').trim()
    if (id === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
    const editSummary = String(summary ?? '').trim()
    if (editSummary === '') throw new DokuWikiError('ARGUMENT', 'summary 不能为空：Recent Changes 里必须能看懂为什么删了这页')
    await this.connect()
    await this.#ensureWebSession()
    await this.#saveText(id, '', editSummary)
    try {
      await this.exportRaw(id)
      // Reading still returns raw content: the page is still there.
      return { deleted: false, reason: '删除请求已提交，但回读发现页面仍然存在' }
    } catch (error) {
      if (error instanceof DokuWikiError && error.code === 'DENIED') return { deleted: true }
      throw error
    }
  }

  /** Probe whether the current account may edit a page; always releases the lock. */
  async canEdit(pageid) {
    const id = String(pageid ?? '').trim()
    if (id === '') throw new DokuWikiError('ARGUMENT', 'pageid 不能为空')
    await this.connect()
    await this.#ensureWebSession()
    let canEdit = false
    let reason = ''
    try {
      const form = await this.#openEditForm(id)
      canEdit = form.html.includes('dw__editform')
    } catch (error) {
      if (!(error instanceof DokuWikiError)) throw error
      reason = error.message
    } finally {
      try {
        await this.cancelEdit(id)
      } catch {
        /* best effort */
      }
    }
    return { canEdit, reason }
  }

  /* ---------------- diagnostics ---------------- */

  /**
   * Probe connectivity, login, read access and edit permission in one call.
   * The edit probe always releases its lock.
   */
  async testConnection() {
    const diagnostic = {
      base: null,
      mode: null,
      version: null,
      login: 'skipped',
      read: 'unknown',
      canEdit: null,
      probePage: null,
      warnings: [],
    }
    await this.connect()
    diagnostic.base = this.#base
    diagnostic.mode = this.#mode
    if (this.#mode === 'rpc') {
      try {
        const version = await this.#xmlrpc('dokuwiki.getVersion')
        diagnostic.version = typeof version === 'string' ? version : null
        diagnostic.login = 'ok (xmlrpc basic auth)'
      } catch (error) {
        diagnostic.warnings.push(`XML-RPC 版本查询失败：${error.message}`)
      }
    } else {
      await this.#ensureWebSession()
      diagnostic.login = `ok (${this.#config.username})`
    }
    let readablePage = null
    try {
      await this.getPage('start')
      diagnostic.read = 'ok'
      readablePage = 'start'
    } catch (error) {
      diagnostic.read = `失败: ${error.message}`
    }
    // Probe an existing page first: accounts that may edit pages but not
    // create new ones would be misreported by a create-only probe.
    const probeCandidates = []
    if (readablePage !== null) probeCandidates.push(readablePage)
    probeCandidates.push(`user:${this.#config.username}:dsh_dokuwiki_probe`)
    diagnostic.canEdit = false
    for (const probePage of probeCandidates) {
      try {
        const result = await this.canEdit(probePage)
        diagnostic.probePage = probePage
        if (result.canEdit) {
          diagnostic.canEdit = true
          break
        }
        if (result.reason) diagnostic.warnings.push(result.reason)
      } catch (error) {
        diagnostic.probePage = diagnostic.probePage ?? probePage
        diagnostic.warnings.push(`编辑权限探测失败（${probePage}）：${error.message}`)
      }
    }
    return diagnostic
  }

  /** Drop connection, login and cookie state so the next call reconnects. */
  invalidate() {
    this.#connection = null
    this.#mode = null
    this.#loggedIn = false
    this.#cookieJar.clear()
    this.#sectok = null
  }
}

/**
 * Parse one XML-RPC request body (used by the mock wiki test server).
 * Returns `{ methodName, params }`.
 */
export function parseXmlRpcRequest(text) {
  const root = parseXml(text)
  const call = findChild(root, 'methodcall') ?? findDescendant(root, 'methodcall')
  if (call === undefined) throw new DokuWikiError('XMLRPC_PROTOCOL', 'not an XML-RPC request')
  const methodName = nodeText(findChild(call, 'methodname'))
  const paramsNode = findChild(call, 'params')
  const params = []
  for (const param of paramsNode?.children.filter((candidate) => candidate.name === 'param') ?? []) {
    const valueNode = findChild(param, 'value')
    if (valueNode !== undefined) params.push(xmlValueToJs(valueNode))
  }
  return { methodName, params }
}

export const __testing = {
  basicAuthHeader,
  parseXml,
  parseHtmlInputs,
  parseIndexBranch,
  extractSearchPageIds,
  buildMethodCall,
  serializeXmlValue,
}

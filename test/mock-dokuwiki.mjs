/**
 * A small in-process DokuWiki stand-in for offline tests.
 *
 * It mirrors the behaviours the real client depends on (release 2024-02-06b
 * "Kaos"):
 *   - XML-RPC + Basic Auth on /lib/exe/xmlrpc.php, gated by a `remoteuser`
 *     allow-list like real DokuWiki (accounts outside it get 403);
 *   - browser form login: GET ?do=login returns the full input set, POST must
 *     echo it (a missing `sectok` field is a 403 "partial POST"), successful
 *     login answers 302 + Set-Cookie;
 *   - do=export_raw returns the raw source, or an HTML page when the page is
 *     missing/denied;
 *   - do=index renders one namespace level;
 *   - do=edit serves the edit form only when the account may edit;
 *   - do=save takes `wikitext` (the real field name) and 302-redirects back.
 */
import http from 'node:http'
import { parseXmlRpcRequest } from '../lib/dokuwiki.mjs'

function xmlString(value) {
  return `<value><string>${String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')}</string></value>`
}

function xmlInt(value) {
  return `<value><int>${Number(value)}</int></value>`
}

function xmlStruct(entries) {
  const members = Object.entries(entries)
    .map(([key, value]) => {
      const encoded = Array.isArray(value)
        ? `<value><array><data>${value.map(xmlString).join('')}</data></array></value>`
        : typeof value === 'number'
          ? xmlInt(value)
          : xmlString(value ?? '')
      return `<member><name>${key}</name>${encoded}</member>`
    })
    .join('')
  return `<value><struct>${members}</struct></value>`
}

function xmlRpcResponse(valueXml) {
  return `<?xml version="1.0"?><methodResponse><params><param>${valueXml}</param></params></methodResponse>`
}

function xmlRpcFault(code, message) {
  return `<?xml version="1.0"?><methodResponse><fault>${xmlStruct({ faultCode: code, faultString: message })}</fault></methodResponse>`
}

function htmlPage(body, title = 'Mock Wiki') {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

function loginPage({ sectok = '' } = {}) {
  return htmlPage(`
    <form id="dw__login" method="post" action="/doku.php">
      <input type="hidden" name="sectok" value="${sectok}" />
      <input type="hidden" name="do" value="login" />
      <input type="hidden" name="id" value="start" />
      <input type="text" name="u" value="" />
      <input type="password" name="p" value="" />
      <input type="submit" name="submit" value="登录" />
    </form>`)
}

function editPage(pageid, { text = '', rev = 1700000000 } = {}) {
  return htmlPage(`
    <div class="dokuwiki">edit</div>
    <form id="dw__editform" method="post" action="/doku.php">
      <input type="hidden" name="id" value="${pageid}" />
      <input type="hidden" name="rev" value="${rev}" />
      <input type="hidden" name="sectok" value="editsectok" />
      <input type="hidden" name="do" value="edit" />
      <input type="checkbox" name="minor" value="1" />
      <textarea name="wikitext"></textarea>
      <input type="text" name="summary" value="" />
      <input type="submit" name="save" value="保存" />
    </form>`)
}

function deniedPage() {
  return htmlPage('<div class="dokuwiki">页面不存在或没有权限</div>', 'Denied')
}

function renderIndex(pages, namespace) {
  const prefix = namespace === '' ? '' : `${namespace}:`
  const children = new Set()
  const directPages = []
  for (const pageid of Object.keys(pages)) {
    if (!pageid.startsWith(prefix)) continue
    const rest = pageid.slice(prefix.length)
    if (rest === '') continue
    const colon = rest.indexOf(':')
    if (colon === -1) {
      directPages.push(pageid)
    } else {
      children.add(`${prefix}${rest.slice(0, colon)}`)
    }
  }
  const items = [
    ...[...children].map(
      (child) => `<li class="idx_dir"><a href="/doku.php?do=index&amp;idx=${encodeURIComponent(child)}" class="idx_dir">${child}</a></li>`,
    ),
    ...directPages.map(
      (pageid) =>
        `<li><a href="/doku.php?id=${encodeURIComponent(pageid)}" class="wikilink1">${pageid}</a></li>`,
    ),
  ]
  return htmlPage(`<ul class="idx">${items.join('')}</ul>`)
}

function searchResults(pages, query) {
  const needle = query.toLowerCase()
  const hits = Object.entries(pages).filter(([, text]) => text.toLowerCase().includes(needle))
  const items = hits
    .map(([pageid]) => `<li><a href="/doku.php?id=${encodeURIComponent(pageid)}" class="wikilink1">${pageid}</a></li>`)
    .join('')
  return htmlPage(`<ul class="search_result">${items}</ul>`)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Render the DokuWiki "Recent changes" changelog list (one `<li>` per change). */
function renderRecentChanges(recent) {
  const items = recent
    .map((entry) => {
      const media = entry.type === 'mediafile'
      const href = media
        ? `/doku.php?id=start&amp;tab_details=view&amp;do=media&amp;image=${encodeURIComponent(entry.pageid)}`
        : `/doku.php?id=${encodeURIComponent(entry.pageid)}`
      const diff = media
        ? '<img src="/lib/images/blank.gif" width="15" height="11" alt="" />'
        : `<a href="/doku.php?id=${encodeURIComponent(entry.pageid)}&amp;do=diff" class="diff_link"><img src="/lib/images/diff.png" width="15" height="11" alt="diff" /></a>`
      const summary = entry.summary ? ` — ${escapeHtml(entry.summary)}` : ''
      return `<li class=""><div class="li"><img class="icon" src="/lib/images/fileicons/file.png" alt="${escapeHtml(entry.pageid)}" /> <span class="date">${escapeHtml(entry.date)}</span> ${diff} <a href="${href}" class="wikilink1">${escapeHtml(entry.pageid)}</a> <span class="sum">${summary}</span> <span class="user"><bdi>${escapeHtml(entry.user)}</bdi></span></div></li>`
    })
    .join('')
  return htmlPage(`<form id="dw__recent"><ul class="fix-media-list-overlap">${items}</ul></form>`)
}

function parseCookies(header) {
  const cookies = {}
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim()
  }
  return cookies
}

function sessionCookieValue(sessions, request) {
  const cookies = parseCookies(request.headers.cookie)
  return sessions.has(cookies.DWKSESS ?? '') ? cookies.DWKSESS : undefined
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function readBodyBuffer(request, limit = 8_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** Minimal multipart/form-data parser for the mock upload endpoint. */
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = []
  let index = buffer.indexOf(delimiter)
  while (index !== -1) {
    let partStart = index + delimiter.length
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2
    if (buffer.slice(partStart, partStart + 2).toString('utf8') === '--') break
    const headerEnd = buffer.indexOf('\r\n\r\n', partStart)
    if (headerEnd === -1) break
    const headers = buffer.slice(partStart, headerEnd).toString('utf8')
    const next = buffer.indexOf(delimiter, headerEnd)
    if (next === -1) break
    let dataEnd = next
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2
    const name = /name="([^"]*)"/.exec(headers)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(headers)?.[1] ?? null
    parts.push({ name, filename, data: buffer.slice(headerEnd + 4, dataEnd) })
    index = next
  }
  return parts
}

/**
 * @param {{
 *   pages?: Record<string, string>,
 *   users?: Record<string, string>,
 *   remoteuser?: string[],
 *   canEdit?: (pageid: string, username: string) => boolean,
 *   canUpload?: (namespace: string, username: string) => boolean,
 *   silentSaveFailure?: boolean,
 *   loginLockoutAfter?: number,
 * }} [options]
 */
export async function startMockWiki(options = {}) {
  const state = {
    pages: { ...(options.pages ?? { start: 'Start page', 'user:alice:log': 'log body', 'notes:2026-07:2026-07-02': '2026-07-02 log' }) },
    users: { ...(options.users ?? { alice: 'secret', writer: 'writerpass' }) },
    remoteuser: new Set(options.remoteuser ?? ['alice']),
    canEdit: options.canEdit ?? (() => true),
    canUpload: options.canUpload ?? (() => true),
    silentSaveFailure: options.silentSaveFailure ?? false,
    recent: [
      ...(options.recent ?? [
        { date: '2026/11/10 14:15', pageid: 'start', user: 'alice', summary: '[演示]', type: 'page' },
        { date: '2026/11/09 17:29', pageid: 'notes:2026-07:2026-07-02', user: 'alice', summary: '更新日志', type: 'page' },
        { date: '2026/11/09 17:29', pageid: 'wiki:plot.png', user: 'alice', summary: '创建', type: 'mediafile' },
      ]),
    ],
    /** session token -> { username, sectok } */
    sessions: new Map(),
    /** media id -> Buffer */
    media: new Map(),
    loginAttempts: 0,
    loginFailures: 0,
    xmlrpcCalls: [],
    saveCalls: [],
    cancelCalls: [],
    editFormRequests: [],
    requests: [],
  }
  let sectokCounter = 0

  const sessionOf = (request) => {
    const cookies = parseCookies(request.headers.cookie)
    const token = cookies.DWKSESS ?? ''
    return state.sessions.get(token) ?? null
  }
  const mediaManagerPage = (allowed) =>
    htmlPage(
      allowed
        ? '<div id="mediamanager__uploader"><form id="dw__upload" enctype="multipart/form-data"><input type="file" name="upload" /></form></div>'
        : '<div class="nothing">media_perm_upload</div>',
    )

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
    try {
      if (url.pathname === '/lib/exe/xmlrpc.php' && request.method === 'POST') {
        const contentType = String(request.headers['content-type'] ?? '')
        // Real DokuWiki rejects `text/xml; charset=utf-8` with fault -32606.
        if (!/^\s*(text|application)\/xml\s*$/i.test(contentType)) {
          await readBody(request)
          response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
          response.end(xmlRpcFault(-32606, 'XML-RPC server accepts XML requests only.'))
          return
        }
        const body = await readBody(request)
        const authorization = request.headers.authorization ?? ''
        const credentials = authorization.startsWith('Basic ')
          ? Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':')
          : []
        const username = credentials[0] ?? ''
        const password = credentials.slice(1).join(':')
        state.xmlrpcCalls.push({ username })
        if (state.users[username] === undefined || state.users[username] !== password) {
          response.writeHead(401, { 'Content-Type': 'text/xml' }).end(xmlRpcFault(1, 'auth failed'))
          return
        }
        if (!state.remoteuser.has(username)) {
          response.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden')
          return
        }
        let parsed
        try {
          parsed = parseXmlRpcRequest(body)
        } catch {
          response.writeHead(400).end('bad request')
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
        response.end(dispatchXmlRpc(parsed, state))
        return
      }

      if (url.pathname === '/doku.php' && request.method === 'GET') {
        const action = url.searchParams.get('do') ?? ''
        const pageid = url.searchParams.get('id') ?? 'start'
        const session = sessionCookieValue(state.sessions, request)
        if (action === 'login') {
          sectokCounter += 1
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(loginPage({ sectok: `sectok-${sectokCounter}` }))
          return
        }
        if (session === undefined) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(loginPage())
          return
        }
        if (action === 'export_raw') {
          if (Object.prototype.hasOwnProperty.call(state.pages, pageid)) {
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            response.end(state.pages[pageid])
          } else {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(deniedPage())
          }
          return
        }
        if (action === 'index') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(renderIndex(state.pages, url.searchParams.get('idx') ?? ''))
          return
        }
        if (action === 'search') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(searchResults(state.pages, url.searchParams.get('q') ?? ''))
          return
        }
        if (action === 'recent') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(renderRecentChanges(state.recent))
          return
        }
        if (action === 'edit') {
          state.editFormRequests.push({ pageid })
          const allowed = state.canEdit(pageid, 'session')
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(allowed ? editPage(pageid, { text: state.pages[pageid] ?? '' }) : deniedPage())
          return
        }
        if (action === 'cancel') {
          state.cancelCalls.push({ pageid })
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(htmlPage('cancelled'))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        const currentSession = sessionOf(request)
        const logoutSectok = currentSession === null ? '' : currentSession.sectok
        response.end(
          htmlPage(
            `<a href="/doku.php?id=start&amp;do=logout&amp;sectok=${logoutSectok}">logout</a>`,
          ),
        )
        return
      }

      if (url.pathname === '/doku.php' && request.method === 'POST') {
        const body = await readBody(request)
        const form = new URLSearchParams(body)
        if (form.has('u') || form.has('p')) {
          state.loginAttempts += 1
          if (!form.has('sectok')) {
            response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(htmlPage('login failed'))
            return
          }
          const username = form.get('u') ?? ''
          const password = form.get('p') ?? ''
          if (state.users[username] !== undefined && state.users[username] === password) {
            sectokCounter += 1
            const token = `sess-${state.loginAttempts}-${Math.random().toString(16).slice(2)}`
            state.sessions.set(token, {
              username,
              sectok: sectokCounter.toString(16).padStart(32, '0'),
            })
            response.writeHead(302, {
              'Set-Cookie': `DWKSESS=${token}; Path=/; HttpOnly`,
              Location: '/doku.php?id=start',
            })
            response.end()
          } else {
            state.loginFailures += 1
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(htmlPage('<div class="error">用户名或密码错误</div>'))
          }
          return
        }
        const session = sessionCookieValue(state.sessions, request)
        if (session === undefined) {
          response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(htmlPage('login required'))
          return
        }
        const pageid = form.get('id') ?? ''
        state.saveCalls.push(Object.fromEntries(form.entries()))
        if (form.get('do') !== 'save') {
          response.writeHead(400).end('bad save request')
          return
        }
        if (!form.has('wikitext')) {
          // Real DokuWiki treats a missing wikitext as "cancel editor" and
          // silently does nothing — this is a known trap.
          response.writeHead(302, { Location: `/doku.php?id=${encodeURIComponent(pageid)}` })
          response.end()
          return
        }
        if (!state.silentSaveFailure) {
          const wikitext = form.get('wikitext') ?? ''
          // Real DokuWiki deletes the page file when empty text is saved.
          if (wikitext === '') delete state.pages[pageid]
          else state.pages[pageid] = wikitext
        }
        response.writeHead(302, { Location: `/doku.php?id=${encodeURIComponent(pageid)}` })
        response.end()
        return
      }

      // --- media manager: upload permission probe + upload + fetch ---
      if (url.pathname === '/lib/exe/mediamanager.php' && request.method === 'GET') {
        const session = sessionOf(request)
        if (session === null) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(mediaManagerPage(false))
          return
        }
        const namespace = url.searchParams.get('ns') ?? ''
        const allowed = state.canUpload(namespace, session.username) === true
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(mediaManagerPage(allowed))
        return
      }

      if (url.pathname === '/lib/exe/ajax.php' && request.method === 'POST') {
        const call = url.searchParams.get('call') ?? ''
        const session = sessionOf(request)
        if (session === null) {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'login required' }))
          return
        }
        if (call !== 'mediaupload') {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown call' }))
          return
        }
        const contentType = String(request.headers['content-type'] ?? '')
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
        const buffer = await readBodyBuffer(request)
        const fields = {}
        let filePart = null
        if (boundary !== null) {
          const parsed = parseMultipart(buffer, (boundary[1] ?? boundary[2] ?? '').trim())
          for (const part of parsed) {
            if (part.filename !== null) filePart = part
            else fields[part.name] = part.data.toString('utf8')
          }
        }
        if (filePart === null) {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no file' }))
          return
        }
        if (fields.sectok !== session.sectok) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'Security Token did not match. Possible CSRF attack.' }))
          return
        }
        const namespace = (fields.ns ?? '').replace(/:+$/, '')
        if (state.canUpload(namespace, session.username) !== true) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'upload denied by ACL', ns: namespace }))
          return
        }
        const mediaid = `${namespace === '' ? '' : `${namespace}:`}${fields.mediaid ?? filePart.filename}`
        state.media.set(mediaid, filePart.data)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true, id: mediaid, ns: namespace }))
        return
      }

      if (url.pathname === '/lib/exe/fetch.php' && request.method === 'GET') {
        const mediaid = url.searchParams.get('media') ?? ''
        const data = state.media.get(mediaid)
        if (data === undefined) {
          response.writeHead(404).end('Not Found')
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        response.end(data)
        return
      }

      response.writeHead(404).end('not found')
    } catch (error) {
      response.writeHead(500).end(`mock error: ${error.message}`)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    setPage(pageid, text) {
      state.pages[pageid] = text
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function dispatchXmlRpc({ methodName, params }, state) {
  switch (methodName) {
    case 'dokuwiki.getVersion':
      return xmlRpcResponse(xmlString('2024-02-06b "Kaos"'))
    case 'wiki.getPage': {
      const pageid = String(params[0] ?? '')
      return xmlRpcResponse(xmlString(state.pages[pageid] ?? ''))
    }
    case 'dokuwiki.getPagelist': {
      const namespace = String(params[0] ?? '').replace(/:+$/, '')
      const depth = Number(params[1]?.depth ?? 0)
      const prefix = namespace === '' ? '' : `${namespace}:`
      const entries = Object.entries(state.pages)
        .filter(([pageid]) => pageid.startsWith(prefix) && pageid !== namespace)
        .filter(([pageid]) => {
          if (depth > 0) return true
          return !pageid.slice(prefix.length).includes(':')
        })
        .map(([pageid, text]) => {
          const struct = xmlStruct({ id: pageid, size: Buffer.byteLength(text), rev: 1700000000 })
          return `<value><struct><member><name>id</name>${xmlString(pageid)}</member><member><name>size</name>${xmlInt(Buffer.byteLength(text))}</member><member><name>rev</name>${xmlInt(1700000000)}</member></struct></value>`
        })
      // xmlStruct above is unused; build the array directly.
      return xmlRpcResponse(`<value><array><data>${entries.map((entry) => entry).join('')}</data></array></value>`)
    }
    case 'dokuwiki.search': {
      const query = String(params[0] ?? '').toLowerCase()
      const hits = Object.entries(state.pages)
        .filter(([pageid, text]) => pageid.toLowerCase().includes(query) || text.toLowerCase().includes(query))
        .map(([pageid]) => `<value><struct><member><name>id</name>${xmlString(pageid)}</member><member><name>title</name>${xmlString(pageid)}</member></struct></value>`)
      return xmlRpcResponse(`<value><array><data>${hits.join('')}</data></array></value>`)
    }
    case 'wiki.getPageVersions': {
      const pageid = String(params[0] ?? '')
      const exists = Object.prototype.hasOwnProperty.call(state.pages, pageid)
      if (!exists) return xmlRpcResponse('<value><array><data></data></array></value>')
      // Field names mirror the real DokuWiki XML-RPC response:
      // version (unix seconds), user, ip, type, sum, modified (ISO string).
      const versions = [1700000000, 1690000000].map(
        (version) =>
          `<value><struct><member><name>version</name>${xmlInt(version)}</member><member><name>user</name>${xmlString('alice')}</member><member><name>ip</name>${xmlString('127.0.0.1')}</member><member><name>type</name>${xmlString('C')}</member><member><name>sum</name>${xmlString(`edit ${version}`)}</member><member><name>modified</name>${xmlString(new Date(version * 1000).toISOString())}</member></struct></value>`,
      )
      return xmlRpcResponse(`<value><array><data>${versions.join('')}</data></array></value>`)
    }
    default:
      return xmlRpcFault(-32601, `unknown method ${methodName}`)
  }
}

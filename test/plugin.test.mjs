import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import * as plugin from '../lib/index.js'

function createCredentials() {
  const store = new Map()
  return {
    store,
    async resolve(ref) {
      return store.has(ref) ? { value: store.get(ref), source: 'test-store' } : undefined
    },
    async describe(ref) {
      return store.has(ref)
        ? { configured: true, source: 'test-store', writable: true }
        : { configured: false, writable: true }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

function createMockContext() {
  const tools = new Map()
  const skills = []
  const routes = []
  const events = {}
  const credentials = createCredentials()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    skills: {
      register(definition) {
        skills.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(factory) {
      const disposer = factory()
      return disposer
    },
    get(key) {
      return key === 'credentials' ? credentials : undefined
    },
    on(event, listener) {
      events[event] = listener
      return () => {}
    },
    logger: { debug() {} },
  }
  return { ctx, tools, skills, routes, events, credentials }
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(payload) {
      this.body = payload ?? ''
    },
  }
}

async function callApi(routes, method, routePath, body, { remoteAddress = '127.0.0.1' } = {}) {
  const handler = routes[0]?.handler
  assert.ok(handler, 'plugin must register the configuration API route')
  const request = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')],
  )
  request.method = method
  request.url = `/dsh-dokuwiki/api${routePath}`
  request.socket = { remoteAddress }
  request.headers = { 'content-type': 'application/json' }
  const response = createResponse()
  await handler(request, response)
  return {
    status: response.statusCode,
    json: response.body === '' ? undefined : JSON.parse(response.body),
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function setupPlugin(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dokuwiki-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mock = createMockContext()
  plugin.apply(mock.ctx)
  const cleanup = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
  const configure = async (config) => {
    const result = await callApi(mock.routes, 'POST', '/config', config)
    assert.equal(result.status, 200, JSON.stringify(result.json))
    return result.json
  }
  const setPassword = async (password) => {
    const result = await callApi(mock.routes, 'POST', '/credential', { password })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    return result.json
  }
  /**
   * Trigger the capability probe through the same API the Plugins page uses.
   * The write tools are registered only when the probe detects edit permission.
   */
  const refreshCapabilities = async () => {
    const result = await callApi(mock.routes, 'POST', '/test')
    assert.equal(result.status, 200, JSON.stringify(result.json))
    return result.json
  }
  return { ...mock, home, cleanup, configure, setPassword, refreshCapabilities, options }
}

test('plugin manifest and registrations', () => {
  const mock = createMockContext()
  plugin.apply(mock.ctx)
  assert.equal(plugin.name, 'dsh-dokuwiki')
  assert.deepEqual(plugin.inject, ['tools', 'skills', 'webServer'])
  assert.deepEqual(
    [...mock.tools.keys()].sort(),
    [
      'wiki_can_edit',
      'wiki_download_media',
      'wiki_get_conventions',
      'wiki_list_pages',
      'wiki_page_history',
      'wiki_permissions',
      'wiki_read_page',
      'wiki_search',
      'wiki_status',
    ],
  )
  assert.equal(mock.tools.has('wiki_write_page'), false, '写工具必须等 ACL 探测通过后才注册')
  assert.equal(mock.tools.has('wiki_delete_page'), false)
  assert.equal(mock.tools.has('wiki_upload_media'), false, '上传工具必须等上传权限探测通过后才注册')
  assert.equal(mock.skills.length, 1)
  assert.equal(mock.skills[0].name, 'dokuwiki')
  assert.equal(mock.skills[0].invocation.modelInvocable, true)
  assert.match(mock.skills[0].content, /wiki_write_page/)
  assert.equal(mock.routes.length, 1)
  assert.equal(mock.routes[0].kind, 'prefix')
  assert.equal(mock.routes[0].path, '/dsh-dokuwiki/api')
})

test('tool schemas stay within the DSH JSON-schema subset', () => {
  // DSH rejects union type arrays such as type: ['integer', 'null'] and only
  // accepts one type per field. Catch this offline instead of at plugin load.
  function walk(node, toolName, pathParts) {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, toolName, [...pathParts, String(index)]))
      return
    }
    if (Object.prototype.hasOwnProperty.call(node, 'type')) {
      // A `properties` bag can contain a property literally named "type";
      // only a schema node's own `type` keyword is constrained here.
      if (Array.isArray(node.type)) {
        assert.fail(`${toolName}: ${pathParts.join('.')}.type must be a single type string`)
      }
      if (node.type !== null && typeof node.type !== 'object') {
        assert.equal(
          typeof node.type,
          'string',
          `${toolName}: ${pathParts.join('.')}.type must be a single type string`,
        )
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'enum' || key === 'const' || key === 'examples') continue
      walk(value, toolName, [...pathParts, key])
    }
  }
  const mock = createMockContext()
  plugin.apply(mock.ctx)
  for (const [toolName, definition] of mock.tools) {
    walk(definition.parameters, toolName, ['parameters'])
    walk(definition.output.schema, toolName, ['output.schema'])
  }
})

test('unconfigured plugin returns an actionable CONFIG error', async () => {
  const setup = await setupPlugin()
  try {
    const tool = setup.tools.get('wiki_read_page')
    await assert.rejects(() => tool.execute({ pageid: 'start' }, {}), (error) => {
      assert.match(error.message, /插件/)
      return true
    })
    const status = setup.tools.get('wiki_status')
    const result = await status.execute({}, {})
    assert.equal(result.ok, false)
    assert.match(result.error, /插件/)
  } finally {
    setup.cleanup()
  }
})

test('config API stores non-secret settings and never returns the password', async () => {
  const setup = await setupPlugin()
  try {
    const initial = await callApi(setup.routes, 'GET', '/config')
    assert.equal(initial.status, 200)
    assert.equal(initial.json.credential.configured, false)
    assert.deepEqual(initial.json.config.baseUrls, [])

    await setup.setPassword('super-secret-password')
    const afterPassword = await callApi(setup.routes, 'GET', '/config')
    assert.equal(afterPassword.json.credential.configured, true)
    assert.equal(JSON.stringify(afterPassword.json).includes('super-secret-password'), false)

    const saved = await setup.configure({
      baseUrls: 'http://127.0.0.1:8080/',
      username: 'agent',
      enableWrite: true,
      timeoutMs: 9000,
    })
    assert.deepEqual(saved.config.baseUrls, ['http://127.0.0.1:8080'])
    assert.equal(saved.config.username, 'agent')
    assert.equal(saved.config.timeoutMs, 9000)
    // The writing-conventions page is opt-in: empty unless configured.
    assert.equal(saved.config.conventionsPage, '')
    const withConventions = await setup.configure({ conventionsPage: ' :wiki:writing_rules: ' })
    assert.equal(withConventions.config.conventionsPage, 'wiki:writing_rules')
    const cleared = await setup.configure({ conventionsPage: '' })
    assert.equal(cleared.config.conventionsPage, '')

    const clear = await callApi(setup.routes, 'POST', '/credential', { clear: true })
    assert.equal(clear.json.credential.configured, false)
  } finally {
    setup.cleanup()
  }
})

test('config API rejects invalid values and untrusted requests', async () => {
  const setup = await setupPlugin()
  try {
    const badUrl = await callApi(setup.routes, 'POST', '/config', { baseUrls: ['ftp://nope'] })
    assert.equal(badUrl.status, 400)
    assert.match(badUrl.json.error, /无效/)

    const badTimeout = await callApi(setup.routes, 'POST', '/config', { timeoutMs: 1 })
    assert.equal(badTimeout.status, 400)

    const badConventions = await callApi(setup.routes, 'POST', '/config', { conventionsPage: 'bad page id' })
    assert.equal(badConventions.status, 400)

    const untrusted = await callApi(setup.routes, 'GET', '/config', undefined, { remoteAddress: '10.0.0.9' })
    assert.equal(untrusted.status, 403)
  } finally {
    setup.cleanup()
  }
})

test('writing conventions page is opt-in and served when configured', async () => {
  const { startMockWiki } = await import('./mock-dokuwiki.mjs')
  const wiki = await startMockWiki({ remoteuser: ['alice'] })
  const setup = await setupPlugin()
  try {
    await setup.configure({ baseUrls: [wiki.url], username: 'writer', enableWrite: true })
    await setup.setPassword('writerpass')

    // Opt-in: with nothing configured the tool reports the feature as off.
    const disabled = await setup.tools.get('wiki_get_conventions').execute({}, {})
    assert.equal(disabled.exists, false)
    assert.equal(disabled.disabled, true)

    // Configured page: the raw source comes back, no write is attempted.
    wiki.state.pages['wiki:conventions'] = '====== 写作规范 ======\n\n新页面放 notes 命名空间下。'
    await setup.configure({ conventionsPage: 'wiki:conventions' })
    const conventions = await setup.tools.get('wiki_get_conventions').execute({}, {})
    assert.equal(conventions.exists, true)
    assert.equal(conventions.pageid, 'wiki:conventions')
    assert.match(conventions.source, /新页面放 notes 命名空间下/)
    // DSH validates tool output against the declared schema with
    // additionalProperties: false, so every returned field must be declared.
    const declared = setup.tools.get('wiki_get_conventions').output.schema.properties
    for (const key of Object.keys(conventions)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(declared, key),
        `wiki_get_conventions returned undeclared field "${key}"`,
      )
    }

    // A configured page that cannot be read reports the gap, but does not throw.
    await setup.configure({ conventionsPage: 'wiki:missing' })
    const missing = await setup.tools.get('wiki_get_conventions').execute({}, {})
    assert.equal(missing.exists, false)
    assert.equal(missing.unreadable, true)
  } finally {
    setup.cleanup()
    await wiki.close()
  }
})

test('write/upload tools are offered only when the wiki ACL grants permission', async () => {
  const { startMockWiki } = await import('./mock-dokuwiki.mjs')
  const editableWiki = await startMockWiki({ remoteuser: ['alice'] })
  const readOnlyWiki = await startMockWiki({ remoteuser: ['alice'], canEdit: () => false, canUpload: () => false })
  // Edit-only account: may edit existing pages but may not create new ones.
  const editOnlyWiki = await startMockWiki({
    remoteuser: ['alice'],
    canEdit: (pageid) => pageid === 'start',
    canUpload: () => false,
  })
  const editable = await setupPlugin()
  const readOnly = await setupPlugin()
  const editOnly = await setupPlugin()
  try {
    // Editable account: capacity detection registers the write and upload tools.
    await editable.configure({ baseUrls: [editableWiki.url], username: 'writer' })
    await editable.setPassword('writerpass')
    assert.equal(editable.tools.has('wiki_write_page'), false, '配置前不应注册写工具')
    const editableCaps = await editable.refreshCapabilities()
    assert.equal(editableCaps.capabilities.edit, 'yes')
    assert.equal(editableCaps.capabilities.upload, 'yes')
    assert.equal(editable.tools.has('wiki_write_page'), true)
    assert.equal(editable.tools.has('wiki_delete_page'), true)
    assert.equal(editable.tools.has('wiki_upload_media'), true)

    // Read-only account (ACL denies the edit form and media upload): those
    // tools stay hidden.
    await readOnly.configure({ baseUrls: [readOnlyWiki.url], username: 'writer' })
    await readOnly.setPassword('writerpass')
    const readOnlyCaps = await readOnly.refreshCapabilities()
    assert.equal(readOnlyCaps.capabilities.edit, 'no')
    assert.equal(readOnlyCaps.capabilities.upload, 'no')
    assert.equal(readOnly.tools.has('wiki_write_page'), false)
    assert.equal(readOnly.tools.has('wiki_delete_page'), false)
    assert.equal(readOnly.tools.has('wiki_upload_media'), false)

    // The status tool also reports the detected permissions.
    const status = await readOnly.tools.get('wiki_status').execute({}, {})
    assert.equal(status.read, 'yes')
    assert.equal(status.edit, 'no')
    assert.equal(status.delete, 'no')
    assert.equal(status.upload, 'no')

    // Edit-only account: probing "create a new page" alone used to report
    // edit=no and hide the write tools; the existing-page probe must find it.
    await editOnly.configure({ baseUrls: [editOnlyWiki.url], username: 'writer' })
    await editOnly.setPassword('writerpass')
    const editOnlyCaps = await editOnly.refreshCapabilities()
    assert.equal(editOnlyCaps.capabilities.edit, 'yes')
    assert.equal(editOnlyCaps.capabilities.upload, 'no')
    assert.equal(editOnly.tools.has('wiki_write_page'), true)
    assert.equal(editOnly.tools.has('wiki_delete_page'), true)
    assert.equal(editOnly.tools.has('wiki_upload_media'), false)
  } finally {
    editable.cleanup()
    readOnly.cleanup()
    editOnly.cleanup()
    await editableWiki.close()
    await readOnlyWiki.close()
    await editOnlyWiki.close()
  }
})

test('tools work end-to-end: download media into the workspace', async () => {
  const { startMockWiki } = await import('./mock-dokuwiki.mjs')
  const wiki = await startMockWiki({ remoteuser: ['alice'] })
  const setup = await setupPlugin()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dokuwiki-download-'))
  try {
    await setup.configure({ baseUrls: [wiki.url], username: 'writer', enableWrite: true })
    await setup.setPassword('writerpass')
    await setup.refreshCapabilities()
    const png = Buffer.from('89504e470d0a1a0a0d0a1a0a', 'hex')
    wiki.state.media.set('wiki:plot.png', png)
    const result = await setup.tools
      .get('wiki_download_media')
      .execute({ mediaid: 'wiki:plot.png' }, { agent: { session: { header: { cwd } } } })
    assert.equal(result.ok, true)
    assert.equal(result.mediaid, 'wiki:plot.png')
    assert.equal(result.path, 'wiki_media/plot.png')
    assert.equal(result.bytes, png.length)
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'wiki_media', 'plot.png')), png)
    // A destination that escapes the workspace is rejected.
    await assert.rejects(
      () =>
        setup.tools
          .get('wiki_download_media')
          .execute({ mediaid: 'wiki:plot.png', dest_path: '../escape.png' }, { agent: { session: { header: { cwd } } } }),
      (error) => /工作区/.test(error.message),
    )
  } finally {
    setup.cleanup()
    await wiki.close()
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('tools work end-to-end against a mock wiki', async () => {
  const { startMockWiki } = await import('./mock-dokuwiki.mjs')
  const wiki = await startMockWiki({ remoteuser: ['alice'] })
  const setup = await setupPlugin()
  try {
    await setup.configure({ baseUrls: [wiki.url], username: 'writer', enableWrite: true })
    await setup.setPassword('writerpass')
    const capabilities = await setup.refreshCapabilities()
    assert.equal(capabilities.capabilities.edit, 'yes')
    assert.equal(setup.tools.has('wiki_write_page'), true)
    assert.equal(setup.tools.has('wiki_delete_page'), true)

    const status = await setup.tools.get('wiki_status').execute({}, {})
    assert.equal(status.ok, true)
    assert.equal(status.mode, 'web')
    assert.equal(status.read, 'yes')
    assert.equal(status.edit, 'yes')
    assert.equal(status.delete, 'yes')

    const read = await setup.tools.get('wiki_read_page').execute({ pageid: 'start' }, {})
    assert.equal(read.source, 'Start page')
    assert.equal(read.cached, false)
    const cached = await setup.tools.get('wiki_read_page').execute({ pageid: 'start' }, {})
    assert.equal(cached.cached, true)
    const fresh = await setup.tools.get('wiki_read_page').execute({ pageid: 'start', fresh: true }, {})
    assert.equal(fresh.cached, false)

    const listing = await setup.tools.get('wiki_list_pages').execute({ namespace: 'notes', depth: 1 }, {})
    assert.deepEqual(listing.pages.map((page) => page.id), ['notes:2026-07:2026-07-02'])

    const search = await setup.tools.get('wiki_search').execute({ query: 'Start' }, {})
    assert.ok(search.results.some((hit) => hit.id === 'start'))

    const probe = await setup.tools.get('wiki_can_edit').execute({ pageid: 'user:writer:x' }, {})
    assert.equal(probe.canEdit, true)

    const write = await setup.tools
      .get('wiki_write_page')
      .execute({ pageid: 'user:writer:entry', text: '=== 记录 ===\n\n内容', summary: '测试写入' }, {})
    assert.equal(write.saved, true)
    assert.equal(write.verified, true)
    assert.equal(wiki.state.pages['user:writer:entry'], '=== 记录 ===\n\n内容')
    assert.equal(wiki.state.saveCalls.at(-1).summary, '测试写入')

    const permissions = await setup.tools.get('wiki_permissions').execute({ namespace: 'user:writer' }, {})
    assert.equal(permissions.read, 'yes')
    assert.equal(permissions.create, 'yes')
    assert.equal(permissions.edit, 'yes')
    assert.equal(permissions.delete, 'yes')
    assert.equal(permissions.upload, 'yes')

    // Upload one PNG through the tool and verify the mock stored it.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    const mediaFile = path.join(os.tmpdir(), `dsh-upload-${Date.now()}.png`)
    fs.writeFileSync(mediaFile, png)
    try {
      const upload = await setup.tools
        .get('wiki_upload_media')
        .execute({ file_path: mediaFile, namespace: 'user:writer' }, {})
      assert.equal(upload.ok, true)
      assert.equal(upload.mediaid, 'user:writer:' + path.basename(mediaFile))
      assert.equal(upload.bytes, png.length)
      assert.deepEqual(wiki.state.media.get(upload.mediaid), png)
    } finally {
      fs.rmSync(mediaFile, { force: true })
    }

    const deletion = await setup.tools
      .get('wiki_delete_page')
      .execute({ pageid: 'user:writer:entry', summary: '清理测试页' }, {})
    assert.equal(deletion.deleted, true)
    assert.equal(Object.prototype.hasOwnProperty.call(wiki.state.pages, 'user:writer:entry'), false)
    assert.equal(wiki.state.saveCalls.at(-1).wikitext, '')
  } finally {
    setup.cleanup()
    await wiki.close()
  }
})

test('write can be disabled from config and history is honest about XML-RPC', async () => {
  const { startMockWiki } = await import('./mock-dokuwiki.mjs')
  const wiki = await startMockWiki({ remoteuser: ['alice'] })
  const setup = await setupPlugin()
  try {
    await setup.configure({ baseUrls: [wiki.url], username: 'writer', enableWrite: false })
    await setup.setPassword('writerpass')
    await setup.refreshCapabilities()

    await assert.rejects(
      () => setup.tools.get('wiki_write_page').execute({ pageid: 'user:writer:x', text: 'a', summary: 'b' }, {}),
      (error) => {
        assert.match(error.message, /关闭/)
        return true
      },
    )
    await assert.rejects(
      () => setup.tools.get('wiki_page_history').execute({ pageid: 'start' }, {}),
      (error) => {
        assert.match(error.message, /XML-RPC/)
        return true
      },
    )
  } finally {
    setup.cleanup()
    await wiki.close()
  }
})

test('test-connection API reports an unreachable wiki without throwing', async () => {
  const setup = await setupPlugin()
  try {
    await setup.configure({ baseUrls: ['http://127.0.0.1:1'], username: 'agent' })
    await setup.setPassword('x')
    const result = await callApi(setup.routes, 'POST', '/test')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, false)
    assert.equal(typeof result.json.error, 'string')
  } finally {
    setup.cleanup()
  }
})

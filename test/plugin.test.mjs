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

const TYPE_CHECKERS = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
}

/**
 * DSH validates every tool's canonical output against its declared JSON schema:
 * declared types are enforced (so a nullable field declared as `string` fails)
 * and `additionalProperties: false` rejects fields that are not declared.
 * This mirrors that contract in the offline suite so such bugs fail here.
 */
function assertSchemaMatches(toolName, schema, value, path) {
  if (schema === null || typeof schema !== 'object') return
  if (schema.type !== undefined) {
    const checker = TYPE_CHECKERS[schema.type]
    if (checker !== undefined) {
      assert.ok(checker(value), `${toolName}: ${path} must be ${schema.type}, got ${JSON.stringify(value)}`)
    }
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = schema.properties ?? {}
    const record = value !== null && typeof value === 'object' ? value : {}
    for (const key of Object.keys(record)) {
      if (schema.additionalProperties === false) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(properties, key),
          `${toolName}: ${path}.${key} is not declared (additionalProperties: false)`,
        )
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue
      assertSchemaMatches(toolName, child, record[key], `${path}.${key}`)
    }
    for (const key of schema.required ?? []) {
      assert.ok(Object.prototype.hasOwnProperty.call(record, key), `${toolName}: ${path}.${key} is required`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => assertSchemaMatches(toolName, schema.items, item, `${path}[${index}]`))
  }
}

function assertOutput(toolName, definition, value) {
  assertSchemaMatches(toolName, definition.output.schema, value, '$')
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
      'wiki_list_media',
      'wiki_list_pages',
      'wiki_page_history',
      'wiki_permissions',
      'wiki_read_page',
      'wiki_recent_changes',
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
    // DSH validates the output strictly. Probe fields are declared as strings
    // and are null until the probe has run, so they must be omitted, not null.
    assertOutput('wiki_status', status, result)
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'probePage'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'uploadProbe'), false)
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
    assertOutput('wiki_get_conventions', setup.tools.get('wiki_get_conventions'), disabled)
    assert.equal(disabled.exists, false)
    assert.equal(disabled.disabled, true)

    // Configured page: the raw source comes back, no write is attempted.
    wiki.state.pages['wiki:conventions'] = '====== 写作规范 ======\n\n新页面放 notes 命名空间下。'
    await setup.configure({ conventionsPage: 'wiki:conventions' })
    const conventions = await setup.tools.get('wiki_get_conventions').execute({}, {})
    assertOutput('wiki_get_conventions', setup.tools.get('wiki_get_conventions'), conventions)
    assert.equal(conventions.exists, true)
    assert.equal(conventions.pageid, 'wiki:conventions')
    assert.match(conventions.source, /新页面放 notes 命名空间下/)

    // A configured page that cannot be read reports the gap, but does not throw.
    await setup.configure({ conventionsPage: 'wiki:missing' })
    const missing = await setup.tools.get('wiki_get_conventions').execute({}, {})
    assertOutput('wiki_get_conventions', setup.tools.get('wiki_get_conventions'), missing)
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
    assertOutput('wiki_download_media', setup.tools.get('wiki_download_media'), result)
    assert.equal(result.ok, true)
    assert.equal(result.mediaid, 'wiki:plot.png')
    assert.equal(result.path, 'wiki_media/plot.png')
    assert.equal(result.bytes, png.length)
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'wiki_media', 'plot.png')), png)
    // Media discovery: the media manager is listable through the logged-in
    // session, which is the gap behind "find the photos of X" tasks.
    wiki.state.media.set('log2025:2025-03:2dmot光路.png', png)
    const mediaList = await setup.tools.get('wiki_list_media').execute({ namespace: 'log2025:2025-03' }, {})
    assertOutput('wiki_list_media', setup.tools.get('wiki_list_media'), mediaList)
    assert.deepEqual(
      mediaList.files.map((file) => file.id),
      ['log2025:2025-03:2dmot光路.png'],
    )
    assert.deepEqual(mediaList.subNamespaces, [])
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
    assertOutput('wiki_status', setup.tools.get('wiki_status'), status)
    assert.equal(status.ok, true)
    assert.equal(status.mode, 'web')
    assert.equal(status.read, 'yes')
    assert.equal(status.edit, 'yes')
    assert.equal(status.delete, 'yes')

    const read = await setup.tools.get('wiki_read_page').execute({ pageid: 'start' }, {})
    assertOutput('wiki_read_page', setup.tools.get('wiki_read_page'), read)
    assert.equal(read.source, 'Start page')
    assert.equal(read.cached, false)
    const cached = await setup.tools.get('wiki_read_page').execute({ pageid: 'start' }, {})
    assert.equal(cached.cached, true)
    const fresh = await setup.tools.get('wiki_read_page').execute({ pageid: 'start', fresh: true }, {})
    assert.equal(fresh.cached, false)

    const listing = await setup.tools.get('wiki_list_pages').execute({ namespace: 'notes', depth: 1 }, {})
    assertOutput('wiki_list_pages', setup.tools.get('wiki_list_pages'), listing)
    assert.deepEqual(listing.pages.map((page) => page.id), ['notes:2026-07:2026-07-02'])

    const search = await setup.tools.get('wiki_search').execute({ query: 'Start' }, {})
    assertOutput('wiki_search', setup.tools.get('wiki_search'), search)
    assert.ok(search.results.some((hit) => hit.id === 'start'))

    // Recent changes: parsed from the wiki's changelog page, newest first.
    const recent = await setup.tools.get('wiki_recent_changes').execute({}, {})
    assertOutput('wiki_recent_changes', setup.tools.get('wiki_recent_changes'), recent)
    assert.equal(recent.via, 'recent')
    assert.equal(recent.count, 3)
    assert.deepEqual(
      recent.items.map((entry) => entry.pageid),
      ['start', 'notes:2026-07:2026-07-02', 'wiki:plot.png'],
    )
    assert.equal(recent.items[2].type, 'mediafile')
    const recentLimited = await setup.tools.get('wiki_recent_changes').execute({ limit: 1 }, {})
    assert.equal(recentLimited.count, 1)
    const recentNamespace = await setup.tools
      .get('wiki_recent_changes')
      .execute({ namespace: 'notes' }, {})
    assert.equal(recentNamespace.count, 1)
    assert.equal(recentNamespace.items[0].pageid, 'notes:2026-07:2026-07-02')

    const probe = await setup.tools.get('wiki_can_edit').execute({ pageid: 'user:writer:x' }, {})
    assertOutput('wiki_can_edit', setup.tools.get('wiki_can_edit'), probe)
    assert.equal(probe.canEdit, true)

    const write = await setup.tools
      .get('wiki_write_page')
      .execute({ pageid: 'user:writer:entry', text: '=== 记录 ===\n\n内容', summary: '测试写入' }, {})
    assertOutput('wiki_write_page', setup.tools.get('wiki_write_page'), write)
    assert.equal(write.saved, true)
    assert.equal(write.verified, true)
    assert.equal(wiki.state.pages['user:writer:entry'], '=== 记录 ===\n\n内容')
    assert.equal(wiki.state.saveCalls.at(-1).summary, '测试写入')

    const permissions = await setup.tools.get('wiki_permissions').execute({ namespace: 'user:writer' }, {})
    assertOutput('wiki_permissions', setup.tools.get('wiki_permissions'), permissions)
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
      assertOutput('wiki_upload_media', setup.tools.get('wiki_upload_media'), upload)
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
    assertOutput('wiki_delete_page', setup.tools.get('wiki_delete_page'), deletion)
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

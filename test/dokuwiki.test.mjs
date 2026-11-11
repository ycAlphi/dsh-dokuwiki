import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DokuWikiClient,
  DokuWikiError,
  parseXmlRpcRequest,
  parseXmlRpcResponse,
} from '../lib/dokuwiki.mjs'
import { normalizeBaseUrls, normalizeConfig } from '../lib/store.mjs'
import { startMockWiki } from './mock-dokuwiki.mjs'

async function withWiki(options, run) {
  const wiki = await startMockWiki(options)
  try {
    return await run(wiki)
  } finally {
    await wiki.close()
  }
}

test('XML-RPC codec handles structs, arrays, ints and strings', () => {
  const response = `<?xml version="1.0"?>
    <methodResponse><params><param><value><array><data>
      <value><struct>
        <member><name>id</name><value><string>log:2026</string></value></member>
        <member><name>size</name><value><int>42</int></value></member>
        <member><name>ok</name><value><boolean>1</boolean></value></member>
      </struct></value>
    </data></array></value></param></params></methodResponse>`
  const value = parseXmlRpcResponse(response)
  assert.deepEqual(value, [{ id: 'log:2026', size: 42, ok: true }])
})

test('XML-RPC fault is surfaced as a typed error', () => {
  const text = `<?xml version="1.0"?><methodResponse><fault><value><struct>
    <member><name>faultCode</name><value><int>121</int></value></member>
    <member><name>faultString</name><value><string>permission denied</string></value></member>
  </struct></value></fault></methodResponse>`
  assert.throws(() => parseXmlRpcResponse(text), (error) => {
    assert.equal(error instanceof DokuWikiError, true)
    assert.equal(error.code, 'XMLRPC_FAULT')
    assert.match(error.message, /permission denied/)
    return true
  })
})

test('XML-RPC request parsing round-trips through the mock', () => {
  const call = `<?xml version="1.0"?><methodCall><methodName>dokuwiki.getPagelist</methodName><params>
    <param><value><string>notes:2026-07</string></value></param>
    <param><value><struct><member><name>depth</name><value><int>1</int></value></member></struct></value></param>
  </params></methodCall>`
  const parsed = parseXmlRpcRequest(call)
  assert.equal(parsed.methodName, 'dokuwiki.getPagelist')
  assert.deepEqual(parsed.params, ['notes:2026-07', { depth: 1 }])
})

test('rpc mode: version, page, namespace list, search, versions', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({
      baseUrls: [wiki.url],
      username: 'alice',
      password: 'secret',
    })
    const connection = await client.connect()
    assert.equal(connection.mode, 'rpc')
    assert.match(connection.version, /2024-02-06b/)

    const page = await client.getPage('user:alice:log')
    assert.equal(page.source, 'log body')
    assert.equal(page.via, 'xmlrpc')

    const listing = await client.listPages('notes:2026-07')
    assert.equal(listing.via, 'xmlrpc')
    assert.deepEqual(listing.pages.map((entry) => entry.id), ['notes:2026-07:2026-07-02'])

    const search = await client.search('log body')
    assert.equal(search.via, 'xmlrpc')
    assert.ok(search.results.some((hit) => hit.id === 'user:alice:log'))

    const versions = await client.pageVersions('user:alice:log')
    assert.equal(versions.length, 2)
    assert.equal(versions[0].user, 'alice')
    // Real DokuWiki uses `sum`/`modified`; the client normalizes both spellings.
    assert.equal(versions[0].summary, 'edit 1700000000')
    assert.equal(versions[0].date, 1700000000)
    assert.match(versions[0].modified, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(versions[0].type, 'C')
  })
})

test('web fallback: account outside remoteuser logs in and reads', async () => {
  await withWiki({ remoteuser: ['alice'] }, async (wiki) => {
    const client = new DokuWikiClient({
      baseUrls: [wiki.url],
      username: 'writer',
      password: 'writerpass',
    })
    const connection = await client.connect()
    assert.equal(connection.mode, 'web')

    const page = await client.getPage('start')
    assert.equal(page.via, 'export_raw')
    assert.equal(page.source, 'Start page')

    const listing = await client.listPages('notes', { depth: 1 })
    assert.equal(listing.via, 'index')
    assert.deepEqual(listing.pages.map((entry) => entry.id), ['notes:2026-07:2026-07-02'])

    // The root namespace has no prefix to match; it used to require `:` and
    // silently returned nothing.
    const rootListing = await client.listPages('')
    assert.equal(rootListing.via, 'index')
    assert.deepEqual(rootListing.pages.map((entry) => entry.id), ['start'])

    const search = await client.search('Start')
    assert.equal(search.via, 'html')
    assert.ok(search.results.some((hit) => hit.id === 'start'))

    // Recent changes are read from the rendered changelog page and parsed into
    // structured entries (page edits and media changes).
    const recent = await client.recentChanges({ limit: 2 })
    assert.equal(recent.via, 'recent')
    assert.equal(recent.items.length, 2)
    assert.deepEqual(recent.items[0], {
      date: '2026/11/10 14:15',
      pageid: 'start',
      user: 'alice',
      summary: '[演示]',
      type: 'page',
    })
    const allRecent = await client.recentChanges({ limit: 50 })
    assert.equal(allRecent.items.length, 3)
    assert.equal(allRecent.items[2].type, 'mediafile')
    assert.equal(allRecent.items[2].pageid, 'wiki:plot.png')

    await assert.rejects(() => client.pageVersions('start'), (error) => {
      assert.equal(error.code, 'UNSUPPORTED')
      return true
    })
  })
})

test('web search: titles and snippets come from the Kaos result containers only', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const search = await client.search('log body')
    assert.equal(search.via, 'html')
    // The mock search page also links `start` and `sidebar:junk` from its
    // sidebar; scraping every ?id= link would leak those ids into the results.
    assert.deepEqual(
      search.results.map((hit) => hit.id),
      ['user:alice:log'],
    )
    assert.equal(search.results[0].title, 'user:alice:log')
    assert.match(search.results[0].snippet, /log body/)
  })
})

test('web search: older templates fall back to plain page-id extraction', async () => {
  await withWiki({ searchRender: 'legacy' }, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const search = await client.search('Start')
    assert.equal(search.via, 'html')
    assert.ok(search.results.some((hit) => hit.id === 'start'))
    assert.equal(search.results[0].title, '')
    assert.equal(search.results[0].snippet, '')
  })
})

test('recent changes: page entries without a diff link are still pages', async () => {
  await withWiki(
    {
      recent: [
        {
          date: '2026/11/11 12:03',
          pageid: 'user:writer:new_page',
          user: 'writer',
          summary: '新建页面',
          type: 'page',
          omitDiff: true,
        },
        { date: '2026/11/11 11:00', pageid: 'notes:2026-07:2026-07-02', user: 'writer', summary: '编辑', type: 'page' },
        { date: '2026/11/11 10:00', pageid: 'wiki:plot.png', user: 'writer', summary: '创建', type: 'mediafile' },
      ],
    },
    async (wiki) => {
      const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
      const recent = await client.recentChanges({ limit: 10 })
      // A newly created page may render without its diff link; classifying by
      // the title anchor's media-manager target keeps it a page.
      assert.deepEqual(
        recent.items.map((entry) => [entry.pageid, entry.type]),
        [
          ['user:writer:new_page', 'page'],
          ['notes:2026-07:2026-07-02', 'page'],
          ['wiki:plot.png', 'mediafile'],
        ],
      )
    },
  )
})

test('login failure: one attempt only and a lockout warning', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({
      baseUrls: [wiki.url],
      username: 'writer',
      password: 'wrong-password',
    })
    await assert.rejects(() => client.connect(), (error) => {
      assert.equal(error.code, 'NO_BASE')
      assert.match(error.message, /锁定/)
      return true
    })
    assert.equal(wiki.state.loginAttempts, 1, '客户端不能连续重试登录')
  })
})

test('denied or missing page surfaces DENIED', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'alice', password: 'secret' })
    await assert.rejects(() => client.getPage('does:not:exist'), (error) => {
      assert.equal(error.code, 'DENIED')
      return true
    })
  })
})

test('write: full form fields, readback verification', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const result = await client.writePage({
      pageid: 'user:writer:new_page',
      text: '=== 标题 ===\n\n内容 ABC',
      summary: '新增测试页',
    })
    assert.equal(result.verified, true)
    assert.equal(wiki.state.pages['user:writer:new_page'], '=== 标题 ===\n\n内容 ABC')
    const save = wiki.state.saveCalls.at(-1)
    assert.equal(save.do, 'save')
    assert.equal(save.wikitext, '=== 标题 ===\n\n内容 ABC')
    assert.equal(save.summary, '新增测试页')
    assert.equal(save.sectok, 'editsectok', '编辑表单的隐藏字段必须原样回传')
  })
})

test('write: empty summary and empty text are rejected before touching the wiki', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    await assert.rejects(
      () => client.writePage({ pageid: 'user:writer:x', text: 'body', summary: '  ' }),
      (error) => error.code === 'ARGUMENT',
    )
    await assert.rejects(
      () => client.writePage({ pageid: 'user:writer:x', text: '   ', summary: 'empty' }),
      (error) => error.code === 'UNSUPPORTED',
    )
    assert.equal(wiki.state.saveCalls.length, 0)
  })
})

test('write: ACL denial is reported as ACL', async () => {
  await withWiki({ canEdit: () => false }, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    await assert.rejects(
      () => client.writePage({ pageid: 'notes:2026-07:2026-07-02', text: 'hack', summary: 'nope' }),
      (error) => error.code === 'ACL',
    )
  })
})

test('write: a silent save failure is not reported as success', async () => {
  await withWiki({ silentSaveFailure: true }, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const result = await client.writePage({ pageid: 'user:writer:silent', text: 'body', summary: 'x' })
    assert.equal(result.valid, false)
    assert.match(result.reason, /回读|未落盘/)
  })
})

test('delete: explicit delete removes the page and verifies by readback', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    await client.writePage({ pageid: 'user:writer:to_delete', text: 'temporary', summary: 'create' })
    assert.equal(wiki.state.pages['user:writer:to_delete'], 'temporary')

    const result = await client.deletePage({ pageid: 'user:writer:to_delete', summary: '清理测试页' })
    assert.equal(result.deleted, true)
    assert.equal(Object.prototype.hasOwnProperty.call(wiki.state.pages, 'user:writer:to_delete'), false)
    assert.equal(wiki.state.saveCalls.at(-1).wikitext, '')
    assert.equal(wiki.state.saveCalls.at(-1).summary, '清理测试页')

    await assert.rejects(
      () => client.deletePage({ pageid: 'user:writer:to_delete', summary: '  ' }),
      (error) => error.code === 'ARGUMENT',
    )
  })
})

test('canEdit probe always releases the DokuWiki edit lock', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const result = await client.canEdit('user:writer:probe')
    assert.equal(result.canEdit, true)
    assert.equal(wiki.state.cancelCalls.length, 1)
    assert.equal(wiki.state.cancelCalls[0].pageid, 'user:writer:probe')
  })
})

test('testConnection reports mode, read and edit permission', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'alice', password: 'secret' })
    const diagnostic = await client.testConnection()
    assert.equal(diagnostic.base, wiki.url)
    assert.equal(diagnostic.mode, 'rpc')
    assert.equal(diagnostic.read, 'ok')
    assert.equal(diagnostic.canEdit, true)
    assert.equal(diagnostic.probePage, 'start')
    assert.ok(wiki.state.cancelCalls.length >= 1)
  })
})

test('testConnection finds edit permission on existing pages (create-only probes would miss it)', async () => {
  // An account may be allowed to edit pages without being allowed to create
  // new ones; the diagnostic must probe existing pages first.
  await withWiki({ canEdit: (pageid) => pageid.includes('dsh_dokuwiki_probe') }, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'alice', password: 'secret' })
    const diagnostic = await client.testConnection()
    assert.equal(diagnostic.canEdit, true)
    assert.ok(diagnostic.probePage.includes('dsh_dokuwiki_probe'))
  })
})

test('media: download through fetch.php', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'alice', password: 'secret' })
    const png = Buffer.from('89504e470d0a1a0a0d0a1a0a', 'hex')
    wiki.state.media.set('wiki:plot.png', png)
    const media = await client.downloadMedia('wiki:plot.png')
    assert.equal(media.mediaid, 'wiki:plot.png')
    assert.deepEqual(media.bytes, png)
    await assert.rejects(
      () => client.downloadMedia('wiki:missing.png'),
      (error) => error instanceof DokuWikiError,
    )
    await assert.rejects(
      () => client.downloadMedia('../etc/passwd'),
      (error) => error.code === 'ARGUMENT',
    )
  })
})

test('media: list files and direct sub-namespaces through the media manager', async () => {
  await withWiki(
    {
      media: {
        'root.png': Buffer.from('r'),
        'log2025:2025-03:2dmot光路.png': Buffer.from('a'),
        'log2025:2025-03:other.jpg': Buffer.from('b'),
        'log2025:2025-04:next.png': Buffer.from('c'),
      },
    },
    async (wiki) => {
      const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
      const listing = await client.listMedia('log2025:2025-03')
      assert.equal(listing.namespace, 'log2025:2025-03')
      assert.deepEqual(listing.files, ['log2025:2025-03:2dmot光路.png', 'log2025:2025-03:other.jpg'])
      assert.deepEqual(listing.subNamespaces, [])

      const root = await client.listMedia('')
      assert.deepEqual(root.files, ['root.png'])
      assert.deepEqual(root.subNamespaces, ['log2025'])

      const month = await client.listMedia('log2025')
      assert.deepEqual(month.files, [])
      assert.deepEqual(month.subNamespaces, ['log2025:2025-03', 'log2025:2025-04'])
    },
  )
})

test('upload: namespace upload probe, upload and byte-for-byte verification', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const permission = await client.canUpload('user:writer')
    assert.equal(permission.canUpload, true)

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    const uploaded = await client.uploadMedia({
      data: png,
      filename: 'test-image.png',
      namespace: 'user:writer',
    })
    assert.equal(uploaded.mediaid, 'user:writer:test-image.png')
    assert.equal(uploaded.bytes, png.length)
    const stored = wiki.state.media.get('user:writer:test-image.png')
    assert.ok(stored !== undefined)
    assert.deepEqual(stored, png)
  })
})

test('upload: ACL denial, path-like filename and upload errors are surfaced', async () => {
  await withWiki({ canUpload: () => false }, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    const permission = await client.canUpload('user:writer')
    assert.equal(permission.canUpload, false)
    await assert.rejects(
      () => client.uploadMedia({ data: Buffer.from('x'), filename: 'a.png', namespace: 'user:writer' }),
      (error) => error.code === 'ACL',
    )
  })
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'writer', password: 'writerpass' })
    await assert.rejects(
      () => client.uploadMedia({ data: Buffer.from('x'), filename: '../evil.png', namespace: 'user:writer' }),
      (error) => error.code === 'ARGUMENT',
    )
  })
})

test('probePermissions reports per-namespace read/create/edit/delete/upload', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'alice', password: 'secret' })
    const allowed = await client.probePermissions('notes')
    assert.equal(allowed.read, 'yes')
    assert.equal(allowed.create, 'yes')
    assert.equal(allowed.edit, 'yes')
    assert.equal(allowed.delete, 'yes')
    assert.equal(allowed.upload, 'yes')
    assert.ok(allowed.probes.create.includes('edit form'))
  })
  await withWiki({ canEdit: () => false, canUpload: () => false }, async (wiki) => {
    const client = new DokuWikiClient({ baseUrls: [wiki.url], username: 'alice', password: 'secret' })
    const denied = await client.probePermissions('notes')
    assert.equal(denied.create, 'no')
    assert.equal(denied.edit, 'no')
    assert.equal(denied.upload, 'no')
  })
})

test('unreachable base URLs are skipped in order', async () => {
  await withWiki({}, async (wiki) => {
    const client = new DokuWikiClient({
      baseUrls: ['http://127.0.0.1:1', wiki.url],
      username: 'alice',
      password: 'secret',
    })
    const connection = await client.connect()
    assert.equal(connection.base, wiki.url)
  })
})

test('no reachable base yields a readable error listing attempts', async () => {
  const client = new DokuWikiClient({
    baseUrls: ['http://127.0.0.1:1'],
    username: 'alice',
    password: 'secret',
  })
  await assert.rejects(() => client.connect(), (error) => {
    assert.equal(error.code, 'NO_BASE')
    assert.match(error.message, /127\.0\.0\.1:1/)
    return true
  })
})

test('base URL normalization accepts bare host:port lines', () => {
  assert.deepEqual(normalizeBaseUrls(['wiki.example.com:8080', 'https://wiki.example.org/', '']), [
    'http://wiki.example.com:8080',
    'https://wiki.example.org',
  ])
  assert.throws(() => normalizeBaseUrls('ftp://bad'), /无效/)
})

test('config normalization validates timeouts', () => {
  const config = normalizeConfig({ baseUrls: 'host:8080', username: ' u ', timeoutMs: 5000 })
  assert.deepEqual(config.baseUrls, ['http://host:8080'])
  assert.equal(config.username, 'u')
  assert.equal(config.enableWrite, true)
  assert.throws(() => normalizeConfig({ timeoutMs: 10 }), /timeoutMs/)
})

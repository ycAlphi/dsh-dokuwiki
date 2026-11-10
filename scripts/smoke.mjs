#!/usr/bin/env node
/**
 * Read-only smoke test against ANY reachable DokuWiki — local, on the LAN, or
 * on the public internet. It does not write anything and does not need a local
 * test installation; point it at the wiki you already have and give it a
 * read-capable account.
 *
 * Usage:
 *   node scripts/smoke.mjs --url http://wiki.example.com --user <account> [--password <pass>]
 *                          [--page start] [--query <term>]
 *
 * The password can also be supplied via the DOKUWIKI_PASSWORD environment
 * variable to keep it out of the shell history.
 *
 * Exit codes: 0 ok, 1 check failed, 2 usage error.
 */
import { DokuWikiClient } from '../lib/dokuwiki.mjs'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const url = arg('--url', process.env.DOKUWIKI_URL ?? '')
const user = arg('--user', process.env.DOKUWIKI_USER ?? '')
const password = arg('--password', process.env.DOKUWIKI_PASSWORD ?? '')
const page = arg('--page', 'start')
const query = arg('--query', '')

if (url === '' || user === '') {
  console.log(
    [
      '用法: node scripts/smoke.mjs --url <wiki base URL> --user <account> [--password <password>]',
      '',
      '示例:',
      '  node scripts/smoke.mjs --url http://wiki.example.com --user my_account',
      '  DOKUWIKI_PASSWORD=... node scripts/smoke.mjs --url http://192.168.1.10:8080 --user my_account',
      '',
      '只做只读检查（连接、读页面、列命名空间、搜索、权限探测），不会写入任何内容。',
    ].join('\n'),
  )
  process.exitCode = 2
  process.exit()
}

const client = new DokuWikiClient({ baseUrls: [url], username: user, password, timeoutMs: 30000 })
let failures = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((error) => {
      failures += 1
      console.log(`  FAIL ${name}: ${error.message}`)
    })
}

console.log(`DokuWiki smoke test: ${url} (user: ${user})`)
let mode = 'unknown'
await check('连接并登录', async () => {
  const connection = await client.connect()
  mode = connection.mode
  console.log(`       mode=${connection.mode}${connection.version ? ` version=${connection.version}` : ''}`)
})
await check(`读取页面 "${page}"`, async () => {
  const result = await client.getPage(page)
  console.log(`       ${result.source.length} chars via ${result.via}`)
})
await check('列出根命名空间', async () => {
  const listing = await client.listPages('', { depth: 0 })
  console.log(`       ${listing.pages.length} pages via ${listing.via}`)
})
if (query !== '') {
  await check(`全文搜索 "${query}"`, async () => {
    const search = await client.search(query)
    console.log(`       ${search.results.length} hits via ${search.via}`)
  })
}
await check('权限探测（账号级）', async () => {
  const diagnostic = await client.testConnection()
  console.log(`       read=${diagnostic.read} canEdit=${diagnostic.canEdit}`)
})
await check('权限探测（命名空间级）', async () => {
  const permissions = await client.probePermissions('')
  console.log(
    `       read=${permissions.read} create=${permissions.create} edit=${permissions.edit} delete=${permissions.delete} upload=${permissions.upload}`,
  )
})

console.log(failures === 0 ? '\nPASS：只读 smoke test 全部通过。' : `\nFAIL：${failures} 项检查失败。`)
process.exitCode = failures === 0 ? 0 : 1

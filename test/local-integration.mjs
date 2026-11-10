#!/usr/bin/env node
/**
 * Real-DokuWiki integration test — runs in place against a Windows portable
 * DokuWiki distribution (e.g. DokuWikiStick) and restores it afterwards.
 *
 * What it changes temporarily:
 *   - appends one throwaway superuser (`dshagent`) to conf/users.auth.php;
 *   - appends one ACL line granting it its own user namespace;
 *   - drops a one-off PHP hash helper into the docroot while the server runs;
 *   - writes test pages under `user:dshagent:`.
 *
 * Everything is restored/removed in `finally`, including on failure, and the
 * Apache child it started is killed. If the checkout is copied beforehand, all
 * of this is disposable anyway.
 *
 * Usage:
 *   node test/local-integration.mjs [--stick <portable wiki root>]
 *                                   [--url http://127.0.0.1:8800] [--keep]
 *
 * Exits 0 and skips when no portable installation is found.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DokuWikiClient, DokuWikiError } from '../lib/dokuwiki.mjs'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const KEEP = args.includes('--keep')
const STICK = argValue('--stick', process.env.DOKUWIKI_STICK ?? '')
const USERNAME = 'dshagent'
const PASSWORD = randomBytes(12).toString('base64url')
const BASE_URL = argValue('--url', process.env.DOKUWIKI_STICK_URL ?? 'http://127.0.0.1:8800')

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  + ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  x ${name}: ${error.message}`)
  }
}

async function main() {
  if (STICK === '') {
    console.log('未配置便携版路径（用 --stick <path> 或 DOKUWIKI_STICK 指定），跳过真机集成测试。')
    return 0
  }
  const dokuwikiDir = path.join(STICK, 'dokuwiki')
  const serverDir = path.join(STICK, 'server')
  if (!fs.existsSync(path.join(serverDir, 'mapache.exe')) || !fs.existsSync(path.join(dokuwikiDir, 'doku.php'))) {
    console.log(`未找到便携版 DokuWiki（${STICK}），跳过本地真机集成测试。`)
    return 0
  }
  if (await isServerUp()) {
    console.error(`DokuWiki 已经在 ${BASE_URL} 上运行（可能是你自己的实例），为避免干扰，本次测试中止。`)
    return 2
  }

  const usersFile = path.join(dokuwikiDir, 'conf', 'users.auth.php')
  const aclFile = path.join(dokuwikiDir, 'conf', 'acl.auth.php')
  const hashScript = path.join(dokuwikiDir, '_dsh_hash.php')
  const usersBackup = fs.readFileSync(usersFile, 'utf8')
  const aclBackup = fs.existsSync(aclFile) ? fs.readFileSync(aclFile, 'utf8') : null
  let server = null
  let exitCode = 0
  let mode = 'unknown'

  try {
    fs.writeFileSync(
      hashScript,
      `<?php
header('Content-Type: application/json');
$password = isset($_GET['p']) ? $_GET['p'] : '';
echo json_encode(['hash' => password_hash($password, PASSWORD_BCRYPT)]);
`,
    )
    server = spawn(path.join(serverDir, 'mapache.exe'), [], { cwd: serverDir, stdio: 'ignore', windowsHide: true })
    const baseUrl = await waitForServer(BASE_URL)
    console.log(`DokuWiki 已启动：${baseUrl}`)

    const hashResponse = await fetch(`${baseUrl}/_dsh_hash.php?p=${encodeURIComponent(PASSWORD)}`)
    const { hash } = await hashResponse.json()
    if (typeof hash !== 'string' || !hash.startsWith('$2y$')) throw new Error('PHP 生成的 bcrypt 哈希无效')

    fs.writeFileSync(
      usersFile,
      `${usersBackup.replace(/\n*$/, '\n')}${USERNAME}:${hash}:DSH Agent:dshagent@example.com:user,admin\n`,
    )
    fs.appendFileSync(aclFile, `\nuser:${USERNAME}:*   ${USERNAME}   31\n`)
    console.log(`已临时添加账号 ${USERNAME}（admin 组 = superuser）`)

    const client = new DokuWikiClient({
      baseUrls: [baseUrl],
      username: USERNAME,
      password: PASSWORD,
      timeoutMs: 20000,
      onLog: (message) => console.log(`  . ${message}`),
    })
    const pageid = `user:${USERNAME}:dsh_integration_test`
    const marker = `dsh-dokuwiki integration ${Date.now()}`

    await check('连接并选择访问模式', async () => {
      // The bundled Apache/PHP can be slow on the very first request, so retry
      // the connection a couple of times before declaring failure.
      let connection
      let lastError
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          connection = await client.connect()
          break
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      if (connection === undefined) throw lastError
      mode = connection.mode
      if (!['rpc', 'web'].includes(mode)) throw new Error(`未知模式 ${mode}`)
      console.log(`    模式 = ${mode}${connection.version ? `, 版本 = ${connection.version}` : ''}`)
    })

    await check('读取 start 页面', async () => {
      const page = await client.getPage('start')
      if (typeof page.source !== 'string' || page.source.length === 0) throw new Error('start 页面内容为空')
    })

    await check('写入新页面并回读校验', async () => {
      const result = await client.writePage({
        pageid,
        text: `====== DSH Integration Test ======\n\n${marker}\n\n* 由 dsh-dokuwiki 本地集成测试写入\n`,
        summary: 'dsh-dokuwiki 本地集成测试',
      })
      if (result.valid !== true || result.verified !== true) throw new Error(result.reason ?? '写入未通过校验')
    })

    await check('回读刚写入的内容', async () => {
      const page = await client.getPage(pageid)
      if (!page.source.includes(marker)) throw new Error('回读内容不包含写入标记')
    })

    await check('列出命名空间', async () => {
      const listing = await client.listPages(`user:${USERNAME}`, { depth: 0 })
      if (!listing.pages.some((page) => page.id === pageid)) throw new Error(`命名空间列表缺少 ${pageid}`)
    })

    await check('全文搜索', async () => {
      await client.indexPage(pageid)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const search = await client.search(marker)
      if (!search.results.some((hit) => hit.id === pageid)) throw new Error('搜索结果缺少刚写入的页面')
    })

    await check('can-edit 探测并释放编辑锁', async () => {
      const probe = await client.canEdit(pageid)
      if (probe.canEdit !== true) throw new Error(`预期可编辑，实际不可编辑：${probe.reason}`)
    })

    await check('编辑已存在页面', async () => {
      const page = await client.getPage(pageid, { fresh: true })
      const result = await client.writePage({
        pageid,
        text: `${page.source.trimEnd()}\n\n第二次编辑（${marker}）\n`,
        summary: '第二次编辑：追加一行',
      })
      if (result.valid !== true) throw new Error(result.reason ?? '第二次编辑失败')
    })

    await check('历史版本（rpc 模式可读）', async () => {
      if (mode !== 'rpc') {
        console.log('    网页表单模式，历史版本不可用（符合预期）')
        return
      }
      const versions = await client.pageVersions(pageid)
      if (versions.length < 2) throw new Error(`历史版本过少：${versions.length}`)
    })

    await check('命名空间权限探测', async () => {
      const permissions = await client.probePermissions(`user:${USERNAME}`)
      if (
        permissions.read !== 'yes' ||
        permissions.create !== 'yes' ||
        permissions.edit !== 'yes' ||
        permissions.upload !== 'yes'
      ) {
        throw new Error(`权限探测结果异常：${JSON.stringify(permissions)}`)
      }
    })

    await check('不存在的页面返回 DENIED', async () => {
      await client.getPage('private:definitely_missing_page').then(
        () => {
          throw new Error('不存在的页面竟然读取成功')
        },
        (error) => {
          if (!(error instanceof DokuWikiError) || error.code !== 'DENIED') throw error
        },
      )
    })

    await check('避免空内容误删', async () => {
      await client.writePage({ pageid, text: '   ', summary: 'empty' }).then(
        () => {
          throw new Error('空内容写入未被拒绝（可能会导致删除）')
        },
        (error) => {
          if (error.code !== 'UNSUPPORTED') throw error
        },
      )
    })

    await check('删除页面并确认消失', async () => {
      const result = await client.deletePage({ pageid, summary: '集成测试清理测试页面' })
      if (result.deleted !== true) throw new Error(result.reason ?? '删除未生效')
      await client.getPage(pageid).then(
        () => {
          throw new Error('删除后页面仍然可读')
        },
        (error) => {
          if (error.code !== 'DENIED') throw error
        },
      )
    })

    await check('上传媒体并回读校验', async () => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      )
      const uploaded = await client.uploadMedia({
        data: png,
        filename: 'dsh_integration_upload.png',
        namespace: `user:${USERNAME}`,
      })
      if (!uploaded.mediaid.endsWith('dsh_integration_upload.png')) {
        throw new Error(`上传结果异常：${JSON.stringify(uploaded)}`)
      }
    })

    await check('连接自检', async () => {
      const diagnostic = await client.testConnection()
      if (diagnostic.read !== 'ok') throw new Error(`读取自检失败：${diagnostic.read}`)
      if (diagnostic.canEdit !== true) throw new Error('自检未能确认编辑权限')
    })
  } catch (error) {
    console.error(`集成测试异常：${error.stack ?? error.message}`)
    exitCode = 1
  } finally {
    // 1. stop the server we started
    try {
      if (server !== null) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
          server.kill()
        }
      }
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    // 2. remove the throwaway hash helper
    try {
      fs.rmSync(hashScript, { force: true })
    } catch {
      /* ignore */
    }
    // 3. restore configuration files
    try {
      fs.writeFileSync(usersFile, usersBackup)
      if (aclBackup !== null) fs.writeFileSync(aclFile, aclBackup)
    } catch (error) {
      console.error(`恢复 wiki 配置失败（请手动检查）：${error.message}`)
      exitCode = 1
    }
    // 4. remove test pages (and their attic/meta records)
    for (const kind of ['pages', 'attic', 'meta', 'media']) {
      const target = path.join(dokuwikiDir, 'data', kind, 'user', USERNAME)
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    if (KEEP) console.log(`提示：测试页面记录已清理，服务器已停止。`)
  }

  const failed = results.filter((entry) => entry.ok !== true)
  console.log(`\n集成测试：${results.length - failed.length}/${results.length} 通过，模式=${mode}`)
  if (failed.length > 0) exitCode = 1
  return exitCode
}

async function isServerUp() {
  try {
    const response = await fetch(`${BASE_URL}/doku.php?id=start&do=login`, { signal: AbortSignal.timeout(1200) })
    return response.status === 200
  } catch {
    return false
  }
}

async function waitForServer(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/doku.php?id=start&do=login`, { signal: AbortSignal.timeout(1500) })
      if (response.status === 200) return baseUrl
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`DokuWiki 未在 ${timeoutMs}ms 内启动`)
}

process.exitCode = await main()

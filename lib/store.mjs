/**
 * Local, non-secret plugin state for dsh-dokuwiki.
 *
 * Secrets NEVER live here: the wiki password is stored through the DSH
 * credentials service (`ctx.credentials`) under `DOKUWIKI_PASSWORD`. This file
 * holds only connection metadata (base URLs, username, feature flags) and is
 * written atomically with restrictive permissions where the platform supports
 * it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_CONFIG = Object.freeze({
  /** Ordered DokuWiki base URLs, e.g. ["http://wiki.example.com"] */
  baseUrls: [],
  /** DokuWiki account name (non-secret). */
  username: '',
  /** Master switch for write tools. The wiki ACL still decides what is allowed. */
  enableWrite: true,
  /** Per-request timeout in milliseconds. */
  timeoutMs: 15000,
  /**
   * Optional DokuWiki page id that records this wiki's own page-writing
   * conventions. Empty string = the conventions feature is off (opt-in).
   */
  conventionsPage: '',
})

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

export function configPath() {
  return path.join(dshHome(), 'dokuwiki.config.json')
}

function normalizeBase(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return ''
  if (/\s/.test(raw)) throw new Error(`无效的 base URL（包含空白字符）: ${raw.slice(0, 120)}`)
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)
  if (schemeMatch !== null && !/^https?$/i.test(schemeMatch[1])) {
    throw new Error(`无效的 base URL（只支持 http/https）: ${raw.slice(0, 120)}`)
  }
  const withScheme = schemeMatch === null ? `http://${raw}` : raw
  if (!/^https?:\/\/[^/\s]+/i.test(withScheme)) {
    throw new Error(`无效的 base URL: ${raw.slice(0, 120)}`)
  }
  return withScheme.replace(/\/+$/, '')
}

/** Accept a comma/whitespace/newline separated string or an array. */
export function normalizeBaseUrls(input) {
  const list = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[\s,;]+/)
  const out = []
  for (const entry of list) {
    const url = normalizeBase(entry)
    if (url === '') continue
    if (!/^https?:\/\/[^/\s]+/i.test(url)) {
      throw new Error(`无效的 base URL: ${String(entry).slice(0, 120)}`)
    }
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** Normalize a DokuWiki page id used as the conventions page ('' = disabled). */
export function normalizePageId(input) {
  const pageid = String(input ?? '')
    .trim()
    .replace(/^:+|:+$/g, '')
  if (pageid === '') return ''
  if (/[\s/\\<>"]/.test(pageid)) {
    throw new Error(`conventionsPage 必须是 DokuWiki 页面 id（例如 wiki:conventions），收到：${pageid.slice(0, 120)}`)
  }
  return pageid
}

export function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {}
  const timeoutMs = Number(source.timeoutMs ?? DEFAULT_CONFIG.timeoutMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('timeoutMs 必须是 1000–120000 之间的数字')
  }
  return {
    baseUrls: normalizeBaseUrls(source.baseUrls ?? DEFAULT_CONFIG.baseUrls),
    username: String(source.username ?? '').trim(),
    enableWrite: source.enableWrite === undefined ? DEFAULT_CONFIG.enableWrite : Boolean(source.enableWrite),
    timeoutMs: Math.round(timeoutMs),
    conventionsPage: normalizePageId(source.conventionsPage ?? DEFAULT_CONFIG.conventionsPage),
  }
}

/** Read the stored config; a missing or corrupt file yields defaults. */
export function readConfig() {
  const file = configPath()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: { ...DEFAULT_CONFIG }, warning: undefined }
    return { config: { ...DEFAULT_CONFIG }, warning: `无法读取配置: ${error.message}` }
  }
  try {
    const parsed = JSON.parse(raw)
    return { config: normalizeConfig(parsed), warning: undefined }
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, warning: `配置文件损坏，已忽略: ${error.message}` }
  }
}

/** Atomically persist the config. Never throws for permission best-effort steps. */
export function writeConfig(input) {
  const config = normalizeConfig(input)
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, file)
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    } catch {
      /* best effort */
    }
  }
  return config
}

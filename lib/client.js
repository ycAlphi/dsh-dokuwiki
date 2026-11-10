/**
 * dsh-dokuwiki — browser half.
 *
 * This file is a pre-built client bundle: DSH's client module loader serves it
 * as-is and expects the `window.__ModuleLoader__.load({ id, factory })`
 * wrapper. Inside, the plugin registers a configuration page into the official
 * Plugins page (`plugins.bundle.config`, keyed by the npm package name), so the
 * account and connection settings live next to the bundle card rather than in
 * a separate Settings section.
 *
 * The page talks only to this plugin's own host routes under
 * `/dsh-dokuwiki/api`: GET/POST config, POST credential, POST test. The
 * password goes one way only — the host reports "configured" but never sends
 * it back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dokuwiki',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React

    const API = '/dsh-dokuwiki/api'
    const STYLE_ID = 'dsh-dokuwiki/plugin-config.css'
    const CSS = `
.dwk{max-width:720px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dwk h3{margin:0 0 2px;font-size:14px;font-weight:600}
.dwk-section{border:1px solid var(--dsw-alias-border-secondary, #d9d9d9);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}
.dwk-row{display:flex;flex-direction:column;gap:4px}
.dwk-row-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dwk label{font-weight:500}
.dwk .hint{color:var(--dsw-alias-label-tertiary, #8a8a8a);font-size:12px;line-height:18px}
.dwk input[type=text],.dwk input[type=password],.dwk input[type=number],.dwk textarea{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary, #d9d9d9);background:var(--dsw-alias-bg-secondary, #fff);color:inherit;font:inherit}
.dwk textarea{min-height:64px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
.dwk-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:12px}
.dwk-badge.ok{background:rgba(22,163,74,.12);color:#16a34a}
.dwk-badge.off{background:rgba(234,88,12,.12);color:#ea580c}
.dwk-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dwk button{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,#d9d9d9);background:var(--dsw-alias-fill-secondary,#f5f5f5);color:inherit;cursor:pointer;font:inherit}
.dwk button.primary{background:var(--dsw-alias-fill-primary,#2b6cb0);border-color:transparent;color:#fff}
.dwk button:disabled{opacity:.55;cursor:not-allowed}
.dwk-msg{padding:8px 10px;border-radius:6px;white-space:pre-wrap;font-size:12px;line-height:18px}
.dwk-msg.ok{background:rgba(22,163,74,.1);color:#16a34a}
.dwk-msg.err{background:rgba(220,38,38,.1);color:#dc2626}
.dwk-msg.info{background:rgba(37,99,235,.08);color:#2563eb}
.dwk-pre{white-space:pre-wrap;font-size:12px;line-height:18px;background:var(--dsw-alias-fill-secondary,#f7f7f7);border-radius:6px;padding:8px}
.dwk dl{display:grid;grid-template-columns:110px 1fr;gap:2px 10px;margin:0}
.dwk dt{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dwk dd{margin:0;word-break:break-all}
`

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function splitUrls(text) {
      return String(text ?? '')
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .join('\n')
    }

    async function apiFetch(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`)
      }
      return payload
    }

    function Section({ title, children }) {
      return h('section', { className: 'dwk-section' }, h('h3', null, title), children)
    }

    function CredentialBadge({ credential }) {
      if (credential === null || credential === undefined) return null
      if (credential.configured) {
        return h('span', { className: 'dwk-badge ok' }, '密码已配置')
      }
      return h('span', { className: 'dwk-badge off' }, '密码未配置')
    }

    function DokuWikiConfigPage() {
      const [loading, setLoading] = useState(true)
      const [config, setConfig] = useState(null)
      const [configPath, setConfigPath] = useState('')
      const [credential, setCredential] = useState(null)
      const [baseUrlsText, setBaseUrlsText] = useState('')
      const [username, setUsername] = useState('')
      const [enableWrite, setEnableWrite] = useState(true)
      const [timeoutMs, setTimeoutMs] = useState(15000)
      const [conventionsPage, setConventionsPage] = useState('')
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)
      const [diagnostic, setDiagnostic] = useState(null)
      const [capabilities, setCapabilities] = useState(null)

      const applyPayload = useCallback((payload) => {
        if (payload.config !== undefined) {
          setConfig(payload.config)
          setBaseUrlsText(Array.isArray(payload.config.baseUrls) ? payload.config.baseUrls.join('\n') : '')
          setUsername(payload.config.username ?? '')
          setEnableWrite(payload.config.enableWrite !== false)
          setTimeoutMs(Number(payload.config.timeoutMs ?? 15000))
          setConventionsPage(payload.config.conventionsPage ?? '')
        }
        if (payload.credential !== undefined) setCredential(payload.credential)
        if (payload.configPath !== undefined) setConfigPath(payload.configPath)
        if (payload.capabilities !== undefined && payload.capabilities !== null) setCapabilities(payload.capabilities)
      }, [])

      const load = useCallback(async () => {
        setLoading(true)
        setMessage(null)
        try {
          const payload = await apiFetch('/config')
          applyPayload(payload)
          if (payload.warning) setMessage({ kind: 'info', text: payload.warning })
        } catch (error) {
          setMessage({ kind: 'err', text: error.message })
        } finally {
          setLoading(false)
        }
      }, [applyPayload])

      useEffect(() => {
        ensureStyle()
        load()
      }, [load])

      const run = useCallback(async (key, action) => {
        setBusy(key)
        setMessage(null)
        try {
          await action()
        } catch (error) {
          setMessage({ kind: 'err', text: error.message })
        } finally {
          setBusy('')
        }
      }, [])

      const saveConfig = useCallback(
        () =>
          run('save', async () => {
            const payload = await apiFetch('/config', {
              method: 'POST',
              body: JSON.stringify({
                baseUrls: baseUrlsText,
                username,
                enableWrite,
                timeoutMs: Number(timeoutMs),
                conventionsPage,
              }),
            })
            applyPayload(payload)
            setMessage({ kind: 'ok', text: '配置已保存。' })
          }),
        [applyPayload, baseUrlsText, conventionsPage, enableWrite, run, timeoutMs, username],
      )

      const savePassword = useCallback(
        () =>
          run('password', async () => {
            if (password === '') throw new Error('请先输入密码')
            const payload = await apiFetch('/credential', {
              method: 'POST',
              body: JSON.stringify({ password }),
            })
            setCredential(payload.credential)
            setPassword('')
            setMessage({ kind: 'ok', text: '密码已保存到 DSH 凭据服务（不会回显）。' })
          }),
        [password, run],
      )

      const clearPassword = useCallback(
        () =>
          run('clear', async () => {
            const payload = await apiFetch('/credential', {
              method: 'POST',
              body: JSON.stringify({ clear: true }),
            })
            setCredential(payload.credential)
            setMessage({ kind: 'info', text: '已清除保存的密码。' })
          }),
        [run],
      )

      const testConnection = useCallback(
        () =>
          run('test', async () => {
            const payload = await apiFetch('/test', { method: 'POST', body: '{}' })
            setDiagnostic(payload.diagnostic)
            if (payload.capabilities !== undefined && payload.capabilities !== null) {
              setCapabilities(payload.capabilities)
            }
            setMessage({ kind: 'ok', text: '连接测试通过。' })
          }),
        [run],
      )

      const capabilityBadges = useMemo(() => {
        if (capabilities === null || capabilities === undefined) return null
        const label = (value) => (value === 'yes' ? '✓' : value === 'no' ? '✗' : '?')
        const tone = (value) => (value === 'yes' ? 'ok' : 'off')
        return h(
          'div',
          { className: 'dwk-row-inline' },
          h('span', null, '账号权限：'),
          h('span', { className: `dwk-badge ${tone(capabilities.read)}` }, `读取 ${label(capabilities.read)}`),
          h('span', { className: `dwk-badge ${tone(capabilities.edit)}` }, `编辑 ${label(capabilities.edit)}`),
          h('span', { className: `dwk-badge ${tone(capabilities.delete)}` }, `删除 ${label(capabilities.delete)}`),
          h('span', { className: `dwk-badge ${tone(capabilities.upload)}` }, `上传 ${label(capabilities.upload)}`),
          capabilities.probePage ? h('span', { className: 'hint' }, `探测页：${capabilities.probePage}`) : null,
        )
      }, [capabilities])

      const diagnosticRows = useMemo(() => {
        if (diagnostic === null) return null
        const rows = [
          ['base URL', diagnostic.base ?? '-'],
          ['访问模式', diagnostic.mode === 'rpc' ? 'XML-RPC' : diagnostic.mode === 'web' ? '网页表单登录' : '-'],
          ['wiki 版本', diagnostic.version ?? '（网页模式下不可知）'],
          ['登录', diagnostic.login ?? '-'],
          ['读取', diagnostic.read ?? '-'],
          ['编辑权限', diagnostic.canEdit === null ? '未知' : diagnostic.canEdit ? '有' : '无'],
          ['探测页面', diagnostic.probePage ?? '-'],
        ]
        return h(
          'dl',
          null,
          rows.map(([term, value]) => [h('dt', { key: `t-${term}` }, term), h('dd', { key: `d-${term}` }, value)]),
        )
      }, [diagnostic])

      if (loading) {
        return h('div', { className: 'dwk' }, '正在读取 DokuWiki 配置…')
      }

      return h(
        'div',
        { className: 'dwk' },
        h('div', null, h('h3', null, 'DokuWiki 连接'), h('div', { className: 'hint' }, '配置 wiki 地址和账号后，模型就可以使用 wiki_read_page / wiki_search / wiki_write_page 等工具。密码保存在 DSH 凭据服务中，不会写进配置文件，也不会回显。')),

        h(
          Section,
          { title: '连接配置' },
          h(
            'div',
            { className: 'dwk-row' },
            h('label', null, 'Base URL（每行一个，按顺序尝试）'),
            h('textarea', {
              value: baseUrlsText,
              spellCheck: false,
              placeholder: 'http://wiki.example.com',
              onChange: (event) => setBaseUrlsText(event.target.value),
            }),
            h('div', { className: 'hint' }, '多个地址按顺序尝试，第一个可用的生效。'),
          ),
          h(
            'div',
            { className: 'dwk-row' },
            h('label', null, '用户名'),
            h('input', {
              type: 'text',
              value: username,
              placeholder: 'wiki 账号名',
              onChange: (event) => setUsername(event.target.value),
            }),
          ),
          capabilityBadges,
          h(
            'div',
            { className: 'dwk-row' },
            h('label', null, '请求超时（毫秒）'),
            h('input', {
              type: 'number',
              value: timeoutMs,
              min: 1000,
              max: 120000,
              onChange: (event) => setTimeoutMs(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dwk-row-inline' },
            h('input', {
              type: 'checkbox',
              id: 'dsh-dokuwiki-enable-write',
              checked: enableWrite,
              onChange: (event) => setEnableWrite(event.target.checked),
            }),
            h('label', { htmlFor: 'dsh-dokuwiki-enable-write' }, '允许写入工具'),
            h('span', { className: 'hint' }, '关闭后 wiki_write_page 会拒绝执行；即使打开，实际权限仍由 wiki 账号的 ACL 决定。'),
          ),
          h(
            'div',
            { className: 'dwk-row' },
            h('label', null, '写作规范页（可选）'),
            h('input', {
              type: 'text',
              value: conventionsPage,
              placeholder: 'wiki:conventions',
              onChange: (event) => setConventionsPage(event.target.value),
            }),
            h('div', { className: 'hint' }, '填本 wiki 记录页面写作约定的页面 id 后启用：模型写作前会先读该页并遵守。留空则不启用；该页面必须能被上面的账号读取。'),
          ),
          h(
            'div',
            { className: 'dwk-actions' },
            h('button', { className: 'primary', onClick: saveConfig, disabled: busy !== '' }, busy === 'save' ? '保存中…' : '保存配置'),
          ),
          configPath ? h('div', { className: 'hint' }, `配置文件：${configPath}（不含密码）`) : null,
        ),

        h(
          Section,
          { title: '账号密码' },
          h(
            'div',
            { className: 'dwk-row-inline' },
            h(CredentialBadge, { credential }),
            credential?.source ? h('span', { className: 'hint' }, `来源：${credential.source}`) : null,
            credential?.writable === false ? h('span', { className: 'hint' }, '当前来源只读（可能来自环境变量）') : null,
          ),
          h(
            'div',
            { className: 'dwk-row' },
            h('label', null, credential?.configured ? '替换密码（留空则不改动）' : '密码'),
            h('input', {
              type: 'password',
              value: password,
              autoComplete: 'new-password',
              placeholder: credential?.configured ? '已保存，重新输入可替换' : 'wiki 密码',
              onChange: (event) => setPassword(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dwk-actions' },
            h('button', { onClick: savePassword, disabled: busy !== '' }, busy === 'password' ? '保存中…' : '保存密码'),
            h('button', { onClick: clearPassword, disabled: busy !== '' }, busy === 'clear' ? '清除中…' : '清除密码'),
          ),
        ),

        h(
          Section,
          { title: '测试连接' },
          h(
            'div',
            { className: 'dwk-actions' },
            h('button', { onClick: testConnection, disabled: busy !== '' }, busy === 'test' ? '测试中…' : '测试连接'),
            h('span', { className: 'hint' }, '会实际登录并检查读取/编辑权限（探测编辑页后自动释放编辑锁）。'),
          ),
          diagnosticRows,
        ),

        message === null ? null : h('div', { className: `dwk-msg ${message.kind}` }, message.text),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-dokuwiki',
              },
              DokuWikiConfigPage,
            ),
          ),
        'dsh-dokuwiki: plugin configuration page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.DokuWikiConfigPage = DokuWikiConfigPage
    return module.exports
  },
})

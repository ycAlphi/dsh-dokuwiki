import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The client half is shipped as a pre-built browser bundle, not an ES module:
 * DSH's client loader evaluates `window.__ModuleLoader__.load({ id, factory })`.
 * This test executes that wrapper with a tiny React stand-in and asserts the
 * plugin page is registered into the official config slot.
 */
function loadClientBundle() {
  const code = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', code)
  run(fakeWindow)
  return { loaded, fakeWindow }
}

function createFakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

test('client bundle wraps itself for the DSH module loader', () => {
  const { loaded } = loadClientBundle()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-dokuwiki')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('client bundle exports apply/inject and registers the Plugins-page page', () => {
  const { loaded } = loadClientBundle()
  const spec = loaded[0]
  const fakeReact = createFakeReact()
  const exports = spec.factory((request) => {
    if (request === 'react') return fakeReact
    throw new Error(`unexpected client module request: ${request}`)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.DokuWikiConfigPage, 'function')

  const registrations = []
  let injectedSlot = null
  const slots = {
    inject(name, register) {
      injectedSlot = name
      const disposer = register()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const ctx = {
    effect(factory) {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots,
  }
  exports.apply(ctx)

  assert.equal(injectedSlot, 'plugins.bundle.config')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.bundle.config')
  assert.equal(registrations[0].options.key, 'dsh-dokuwiki')
  assert.equal(registrations[0].component, exports.DokuWikiConfigPage)
})

test('client page talks only to this plugin API and never sends the password anywhere else', () => {
  const code = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.match(code, /\/dsh-dokuwiki\/api/)
  assert.match(code, /plugins\.bundle\.config/)
  // Every network call goes through the same-origin API helper; no fetch to an
  // absolute URL anywhere in the bundle.
  assert.doesNotMatch(code, /fetch\(\s*['"`]https?:/)
  assert.match(code, /fetch\(`\$\{API\}/)
})

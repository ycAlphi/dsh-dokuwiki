import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLazyDisclosure } from '../lib/lazy.mjs'

function createFakeCtx() {
  const listeners = {}
  const effects = []
  return {
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== listener)
      }
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    emit(event, payload) {
      for (const listener of [...(listeners[event] ?? [])]) listener(payload)
    },
    dispose() {
      for (const dispose of effects.splice(0)) dispose()
    },
    listeners,
  }
}

function createFakeRuntime(capabilities = null) {
  const state = { caps: capabilities, listeners: new Set(), detects: 0 }
  const notify = () => {
    for (const listener of [...state.listeners]) listener(state.caps)
  }
  return {
    capabilities: () => state.caps,
    async detectCapabilities() {
      state.detects += 1
      if (state.caps === null) {
        state.caps = { read: 'yes', edit: 'no', delete: 'no', upload: 'no' }
        notify()
      }
      return state.caps
    },
    onCapabilities(listener) {
      state.listeners.add(listener)
      if (state.caps !== null) listener(state.caps)
      return () => state.listeners.delete(listener)
    },
    setCapabilities(next) {
      state.caps = next
      notify()
    },
    _state: state,
  }
}

function createFakeAgent(id, header) {
  const tools = new Map()
  const cleanups = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
  }
  return {
    id,
    ctx,
    tools,
    session: { requestHeader: () => header },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

// Stand-ins for the real registration functions; they only care about which
// tool names land in the calling registrar.
const registerReadTools = (register) => {
  register({ name: 'wiki_status' })
  register({ name: 'wiki_read_page' })
  register({ name: 'wiki_search' })
}
const registerWriteTools = (register) => {
  register({ name: 'wiki_write_page' })
  register({ name: 'wiki_delete_page' })
}
const registerUploadTools = (register) => {
  register({ name: 'wiki_upload_media' })
}

function setup(options = {}) {
  const ctx = createFakeCtx()
  const runtime = createFakeRuntime(options.capabilities ?? null)
  const lazy = createLazyDisclosure({
    ctx,
    runtime,
    registerReadTools,
    registerWriteTools,
    registerUploadTools,
  })
  return { ctx, runtime, lazy }
}

test('skill load unlocks read tools in the invoking agent scope only', async () => {
  const { lazy } = setup()
  const agentA = createFakeAgent('agent-a')
  const agentB = createFakeAgent('agent-b')

  assert.equal(await lazy.onSkillLoaded({ scope: agentA }), true)
  assert.deepEqual([...agentA.tools.keys()].sort(), ['wiki_read_page', 'wiki_search'])
  assert.equal(agentA.tools.has('wiki_status'), false, 'the global status tool is not duplicated')
  assert.equal(agentB.tools.size, 0, 'other sessions stay locked')
  assert.equal(lazy.hasUnlocked('agent-a'), true)
  assert.equal(lazy.hasUnlocked('agent-b'), false)

  // Idempotent: a second load neither duplicates nor re-registers.
  assert.equal(await lazy.onSkillLoaded({ scope: agentA }), true)
  assert.equal(agentA.tools.size, 2)
})

test('a scope-less load falls back to agents.currentInitiator()', async () => {
  const ctx = createFakeCtx()
  const runtime = createFakeRuntime()
  const agent = createFakeAgent('via-initiator')
  const scopedCtx = {
    ...ctx,
    get(key) {
      return key === 'agents' ? { currentInitiator: () => agent } : undefined
    },
  }
  const lazy = createLazyDisclosure({
    ctx: scopedCtx,
    runtime,
    registerReadTools,
    registerWriteTools,
    registerUploadTools,
  })
  assert.equal(await lazy.onSkillLoaded({ cwd: '/' }), true)
  assert.ok(agent.tools.has('wiki_read_page'))
})

test('a scope-less load without an initiator is a no-op', async () => {
  const { lazy } = setup()
  const agent = createFakeAgent('agent-a')
  assert.equal(await lazy.onSkillLoaded({}), false)
  assert.equal(agent.tools.size, 0)
})

test('known capabilities add the gated tools at unlock time', async () => {
  const { lazy } = setup({ capabilities: { read: 'yes', edit: 'yes', upload: 'yes' } })
  const agent = createFakeAgent('agent-a')
  await lazy.onSkillLoaded({ scope: agent })
  assert.deepEqual([...agent.tools.keys()].sort(), [
    'wiki_delete_page',
    'wiki_read_page',
    'wiki_search',
    'wiki_upload_media',
    'wiki_write_page',
  ])
})

test('a late capability result is mirrored into already unlocked sessions', async () => {
  const { lazy, runtime } = setup()
  const agent = createFakeAgent('agent-a')
  await lazy.onSkillLoaded({ scope: agent })
  assert.equal(agent.tools.has('wiki_write_page'), false)
  assert.equal(runtime._state.detects, 1, 'unlock starts the probe in the background')

  runtime.setCapabilities({ read: 'yes', edit: 'yes', upload: 'no' })
  assert.ok(agent.tools.has('wiki_write_page'))
  assert.ok(agent.tools.has('wiki_delete_page'))
  assert.equal(agent.tools.has('wiki_upload_media'), false)

  // A later ACL change removes a group again.
  runtime.setCapabilities({ read: 'yes', edit: 'no', upload: 'no' })
  assert.equal(agent.tools.has('wiki_write_page'), false)
  assert.ok(agent.tools.has('wiki_read_page'))
})

test('agent disposal removes the scoped tools', async () => {
  const { lazy } = setup({ capabilities: { read: 'yes', edit: 'yes', upload: 'no' } })
  const agent = createFakeAgent('agent-a')
  await lazy.onSkillLoaded({ scope: agent })
  assert.ok(agent.tools.has('wiki_write_page'))
  assert.equal(lazy.hasUnlocked('agent-a'), true)
  agent.dispose()
  assert.equal(agent.tools.size, 0)
})

test('the agent/disposed event removes the scoped tools and the state', async () => {
  const { ctx, lazy } = setup({ capabilities: { read: 'yes', edit: 'yes', upload: 'no' } })
  const agent = createFakeAgent('agent-a')
  await lazy.onSkillLoaded({ scope: agent })
  ctx.emit('agent/disposed', { agent })
  assert.equal(agent.tools.size, 0)
  assert.equal(lazy.hasUnlocked('agent-a'), false)
})

test('plugin disposal removes every registration', async () => {
  const { ctx, lazy } = setup({ capabilities: { read: 'yes', edit: 'yes', upload: 'yes' } })
  const agent = createFakeAgent('agent-a')
  await lazy.onSkillLoaded({ scope: agent })
  assert.equal(agent.tools.size, 5)
  ctx.dispose()
  assert.equal(agent.tools.size, 0)
  assert.equal(lazy.hasUnlocked('agent-a'), false)
})

test('a resumed session with wiki tools in its previous header is unlocked on creation', () => {
  const { ctx, lazy } = setup({ capabilities: { read: 'yes', edit: 'no', upload: 'no' } })
  const resumed = createFakeAgent('agent-resumed', {
    tools: [{ name: 'wiki_status' }, { name: 'wiki_read_page' }],
  })
  ctx.emit('agent/created', { agent: resumed, source: 'resume' })
  assert.ok(resumed.tools.has('wiki_read_page'))
  assert.ok(resumed.tools.has('wiki_search'))
})

test('a fresh session is not unlocked by the creation event', () => {
  const { ctx, lazy } = setup()
  const fresh = createFakeAgent('agent-fresh')
  ctx.emit('agent/created', { agent: fresh, source: 'startup' })
  assert.equal(fresh.tools.size, 0)
  assert.equal(lazy.hasUnlocked('agent-fresh'), false)
})

test('a resumed session without wiki tools in its header stays locked', () => {
  const { ctx } = setup()
  const resumed = createFakeAgent('agent-resumed', { tools: [{ name: 'wiki_status' }] })
  ctx.emit('agent/created', { agent: resumed, source: 'resume' })
  assert.equal(resumed.tools.size, 0)
})

test('a broken agent scope fails closed without throwing', async () => {
  const { lazy } = setup()
  assert.equal(await lazy.onSkillLoaded({ scope: { id: 'no-ctx' } }), false)
  assert.equal(await lazy.onSkillLoaded({ scope: null }), false)
  assert.equal(lazy.hasUnlocked('no-ctx'), false)
})

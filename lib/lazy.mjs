/**
 * Session-scoped lazy tool disclosure for dsh-dokuwiki.
 *
 * In lazy mode the plugin registers only the always-available `wiki_status`
 * tool globally. The rest of the wiki tools are registered into one Agent's
 * own scope (`agent.ctx.tools.register`) the first time that Agent loads the
 * `dokuwiki` skill. Consequences:
 *
 *   - every conversation decides for itself when the wiki tools appear;
 *   - other sessions never see them (no global unlock);
 *   - the registrations are torn down with the Agent, and with the plugin when
 *     it unloads (both are required: unloading the plugin does not dispose
 *     `agent.ctx` registrations by itself).
 *
 * The skill provider's `get()` is the only unlock hook: DSH passes the
 * invoking Agent as `options.scope`, so no extra event plumbing is needed for
 * model- or user-invoked skill loads. A resumed session whose previous request
 * header already listed wiki tools is unlocked from `agent/created`, because a
 * resumed agent starts on a fresh process and would otherwise lose the tools
 * the transcript says it has.
 */

const CORE_TOOL = 'wiki_status'
const WIKI_TOOL_PREFIX = 'wiki_'

/**
 * Register the lazy disclosure state machine on a plugin context.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context of the plugin (for events/effects)
 * @param {object} options.runtime dsh-dokuwiki runtime (capabilities probe)
 * @param {(register: (definition: object) => unknown, runtime: object) => void} options.registerReadTools
 * @param {(register: (definition: object) => unknown, runtime: object) => void} options.registerWriteTools
 * @param {(register: (definition: object) => unknown, runtime: object) => void} options.registerUploadTools
 * @param {(message: string) => void} [options.log]
 */
export function createLazyDisclosure({
  ctx,
  runtime,
  registerReadTools,
  registerWriteTools,
  registerUploadTools,
  log = () => {},
}) {
  /** @type {Map<string, ReturnType<typeof createState>>} */
  const agents = new Map()
  let disposed = false

  function createState(agent) {
    return {
      agent,
      unlocked: false,
      cleaned: false,
      promise: null,
      effectDispose: null,
      /** Scoped tool disposers per group, so ACL changes can drop one group. */
      groups: { read: [], write: [], upload: [] },
    }
  }

  const disposeGroup = (state, group) => {
    for (const disposer of state.groups[group].splice(0)) {
      try {
        disposer()
      } catch {
        /* best effort */
      }
    }
  }

  const cleanup = (state) => {
    if (state.cleaned) return
    state.cleaned = true
    for (const group of Object.keys(state.groups)) disposeGroup(state, group)
    if (typeof state.effectDispose === 'function') {
      const dispose = state.effectDispose
      state.effectDispose = null
      try {
        dispose()
      } catch {
        /* best effort */
      }
    }
  }

  const scopedRegistrar = (state, group) => (definition) => {
    const agentCtx = state.agent.ctx
    if (agentCtx === undefined || agentCtx === null || typeof agentCtx.tools?.register !== 'function') {
      return undefined
    }
    const disposer = agentCtx.tools.register(definition)
    if (typeof disposer === 'function') state.groups[group].push(disposer)
    return disposer
  }

  /**
   * Mirror the (account-wide) ACL detection into one unlocked agent scope.
   * The probe result is shared, so it is applied as soon as it is known; when
   * it is not known yet, unlock registers the read tools first and the
   * capability listener fills in the rest later.
   */
  const syncCapabilities = (state, detected) => {
    if (disposed || state.cleaned || !state.unlocked) return
    if (detected === null || detected === undefined) return
    const wantsWrite = detected.edit === 'yes'
    const wantsUpload = detected.upload === 'yes'
    if (wantsWrite && state.groups.write.length === 0) {
      registerWriteTools(scopedRegistrar(state, 'write'), runtime)
      log(`[dsh-dokuwiki] write tools unlocked for session ${state.agent.id}`)
    } else if (!wantsWrite && state.groups.write.length > 0) {
      disposeGroup(state, 'write')
    }
    if (wantsUpload && state.groups.upload.length === 0) {
      registerUploadTools(scopedRegistrar(state, 'upload'), runtime)
      log(`[dsh-dokuwiki] upload tool unlocked for session ${state.agent.id}`)
    } else if (!wantsUpload && state.groups.upload.length > 0) {
      disposeGroup(state, 'upload')
    }
  }

  const syncAll = (detected) => {
    for (const state of [...agents.values()]) {
      try {
        syncCapabilities(state, detected)
      } catch (error) {
        log(`[dsh-dokuwiki] could not sync capabilities into a session: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Unlock the wiki tools for one Agent. Idempotent and single-flight: the
   * read tools are registered synchronously before the returned promise
   * settles, so the next model step already sees them.
   */
  const unlock = (agent) => {
    if (disposed) return Promise.resolve(false)
    if (agent === undefined || agent === null || agent.id === undefined) return Promise.resolve(false)
    if (agent.ctx === undefined || agent.ctx === null) return Promise.resolve(false)
    if (typeof agent.ctx.tools?.register !== 'function') return Promise.resolve(false)
    const id = String(agent.id)
    const existing = agents.get(id)
    if (existing !== undefined) {
      if (existing.unlocked) return Promise.resolve(true)
      if (existing.promise !== null) return existing.promise
      return Promise.resolve(false)
    }
    const state = createState(agent)
    agents.set(id, state)
    const run = (async () => {
      try {
        // Cleanup is owned by the Agent's fiber: disposing the Agent removes
        // the scoped tools again.
        if (typeof agent.ctx.effect === 'function') {
          state.effectDispose = agent.ctx.effect(() => () => cleanup(state))
        }
        registerReadTools(
          (definition) => {
            if (definition.name === CORE_TOOL) return undefined
            return scopedRegistrar(state, 'read')(definition)
          },
          runtime,
        )
        state.unlocked = true
        syncCapabilities(state, runtime.capabilities())
        if (runtime.capabilities() === null) {
          // Do not block skill loading on the network; the capability listener
          // registers the write/upload tools when the probe settles.
          void runtime.detectCapabilities().catch(() => {})
        }
        log(`[dsh-dokuwiki] wiki tools unlocked for session ${id}`)
        return true
      } catch (error) {
        cleanup(state)
        agents.delete(id)
        log(`[dsh-dokuwiki] failed to unlock wiki tools for session ${id}: ${error?.message ?? error}`)
        return false
      }
    })()
    state.promise = run
    void run.finally(() => {
      if (state.promise === run) state.promise = null
    })
    return run
  }

  /**
   * Unlock hook for the skill provider: the invoking Agent arrives as
   * `options.scope` (runtime field of the skills lookup), with
   * `agents.currentInitiator()` as a defensive fallback.
   */
  const onSkillLoaded = async (options) => {
    if (disposed) return false
    let agent
    const scope = options !== null && options !== undefined ? options.scope : undefined
    if (scope !== null && scope !== undefined && scope.ctx !== undefined && scope.id !== undefined) {
      agent = scope
    } else {
      try {
        agent = ctx.get?.('agents')?.currentInitiator?.()
      } catch {
        agent = undefined
      }
    }
    if (agent === undefined || agent === null) return false
    return unlock(agent)
  }

  /** Remember sessions that already had the wiki tools before a restart. */
  const onAgentCreated = (payload) => {
    if (disposed) return
    const agent = payload?.agent
    const source = payload?.source
    if (agent === undefined || agent === null) return
    if (source !== 'resume' && source !== 'clear' && source !== 'compact') return
    try {
      const tools = agent.session?.requestHeader?.()?.tools
      if (!Array.isArray(tools)) return
      const hadWikiTools = tools.some(
        (tool) =>
          typeof tool?.name === 'string' &&
          tool.name.startsWith(WIKI_TOOL_PREFIX) &&
          tool.name !== CORE_TOOL,
      )
      if (hadWikiTools) void unlock(agent)
    } catch (error) {
      log(`[dsh-dokuwiki] could not inspect a resumed session header: ${error?.message ?? error}`)
    }
  }

  const onAgentDisposed = (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    const state = agents.get(String(agent.id))
    if (state === undefined) return
    agents.delete(String(agent.id))
    cleanup(state)
  }

  const stops = []
  if (typeof ctx.on === 'function') {
    stops.push(ctx.on('agent/created', onAgentCreated))
    stops.push(ctx.on('agent/disposed', onAgentDisposed))
  }
  const offCapabilities =
    typeof runtime.onCapabilities === 'function' ? runtime.onCapabilities(syncAll) : undefined

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (typeof offCapabilities === 'function') {
      try {
        offCapabilities()
      } catch {
        /* best effort */
      }
    }
    for (const stop of stops.splice(0)) {
      try {
        stop?.()
      } catch {
        /* best effort */
      }
    }
    for (const state of agents.values()) cleanup(state)
    agents.clear()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)

  return {
    unlock,
    onSkillLoaded,
    dispose,
    hasUnlocked: (id) => agents.get(String(id))?.unlocked === true,
    _agents: agents,
  }
}

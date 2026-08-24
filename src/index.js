/**
 * dsh-force-compact — a DSH Cordis function plugin.
 *
 * Hooks the core model-request seam so that, on **every model request**, the
 * "强制压缩配置" (force-compact) settings are read:
 *
 * - **`agent/request`** (a Waterfall around the frozen call configuration) —
 *   when the `disableThinking` setting is on, the returned `LlmCallConfig`
 *   carries `reasoningEffort: 'off'`, which the LLM adapter maps to
 *   `thinking: { type: 'disabled' }`. Every model request is therefore sent
 *   with thinking/reasoning disabled.
 * - **`agent/pre-step`** (a Waterfall before each model step) — reads the
 *   session's total context tokens; when they reach the `autoThresholdTokens`
 *   threshold the proposed step is rejected (the model request is NOT made)
 *   and a **forced compaction** (`ctx.compaction.compactNow`) runs instead.
 *
 * The plugin also keeps the `session/flush` durability checkpoint: a
 * checkpoint-driven compaction (its own region policy + LLM summarizer,
 * delegated to `ctx.compaction.compactRegion`) so useful history is condensed
 * even between model requests.
 *
 * The compaction implementation lives in `src/`:
 * - `config.js`       — tunables.
 * - `region.js`       — the plugin's own head-anchored region selection.
 * - `summarizer.js`   — the plugin's own one-shot LLM summarizer (preview + shrink gate).
 * - `compact.js`      — the checkpoint orchestrator: region → preview → delegate to `compactRegion`.
 * - `settings.js`     — the `falling-ts-force-compact` settings namespace (the two parameters).
 * - `request-guard.js`— the per-request guard: threshold gate + forced compaction + thinking-off.
 *
 * @module @falling-ts/dsh-force-compact
 */

import { compactSession } from './compact.js'
import { registerNamespace } from './settings.js'
import { forceCompactIfNeeded, thinkingDisabled } from './request-guard.js'

/** @type {string} the function plugin's display name. */
export const name = 'force-compact'

/** @type {readonly string[]} the services this plugin hard-depends on. */
export const inject = ['compaction']

/**
 * Register the model-request Waterfalls, the `session/flush` listener, and the
 * `falling-ts-force-compact` settings namespace (the "强制压缩配置" surface).
 *
 * `compaction` is a hard dependency (`inject`). The `agents`, `settings`, and
 * `tokenMeter` services are optional: each is read with `ctx.get(...)` and
 * guarded against `undefined`, so a missing optional service never blocks a
 * listener (the plugin falls back to its composition defaults or a coarse
 * estimate).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Register the settings namespace when the `settings` service is mounted.
  // `registerNamespace` is a no-op returning `false` when `settings` is absent.
  ctx.effect(async () => {
    const registered = await registerNamespace(ctx)
    if (registered) ctx.logger.debug('[force-compact] registered settings namespace "falling-ts-force-compact"')
  }, 'falling-ts-force-compact: settings namespace')

  // Hook the core model request: when "disable thinking" is on, every model
  // request carries reasoningEffort: 'off'. Reading the settings here (per
  // request) means a settings.yaml edit is picked up on the next request.
  // `agent/request` is a Waterfall — `await next()` yields the config the
  // machine would use; returning a replacement switches it.
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    if (!payload || config === undefined) return config
    const agent = payload.agent
    if (!(await thinkingDisabled(ctx))) return config
    if (config.reasoningEffort === 'off') return config
    return { ...config, reasoningEffort: 'off' }
  })

  // Before each model step, read the session's total context tokens; when they
  // reach the threshold, reject the proposed step (no model request) and run a
  // forced compaction instead. `agent/pre-step` is a Waterfall — returning
  // `{ kind: 'reject' }` stops the step; returning `next()` lets it proceed.
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload && payload.agent
    if (agent === undefined || agent === null) return next()
    const signal = payload.signal
    let rejected = false
    if (signal === undefined || !signal.aborted) {
      try {
        rejected = await forceCompactIfNeeded(ctx, agent, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[force-compact] ${agent.id}: request guard failed — ${message}`)
      }
    }
    return rejected ? { kind: 'reject' } : next()
  })

  // Checkpoint-driven compaction: condense useful history at each durability
  // checkpoint (its own region policy + LLM summarizer, delegated to
  // compactRegion), independent of the per-request guard.
  ctx.on('session/flush', async (session) => {
    const agents = ctx.get('agents')
    if (agents === undefined) return
    const agent = agents.get(session.id)
    if (agent === undefined || agent === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: no live agent — skipping`)
      return
    }
    const controller = new AbortController()
    try {
      await compactSession(ctx, agent, controller)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[force-compact] ${session.id}: compaction failed — ${message}`)
    }
  })
}

/**
 * dsh-force-compact — a DSH Cordis function plugin.
 *
 * Listens to `session/flush` (an awaited `parallel` durability checkpoint) and
 * compacts the session's useful history at each checkpoint. The durable effect
 * is a single summary node appended to the session log.
 *
 * The compaction implementation lives in `src/`:
 * - `config.js`     — tunables.
 * - `region.js`     — the plugin's own head-anchored region selection.
 * - `summarizer.js` — the plugin's own one-shot LLM summarizer (preview + shrink gate).
 * - `compact.js`    — the orchestrator: region → preview → delegate to `compactRegion`.
 *
 * @module @falling-ts/dsh-force-compact
 */

import { compactSession } from './compact.js'
import { registerNamespace } from './settings.js'

/** @type {string} the function plugin's display name. */
export const name = 'force-compact'

/** @type {readonly string[]} the services this plugin hard-depends on. */
export const inject = ['compaction']

/**
 * Register the `session/flush` listener and the `force-compact` settings
 * namespace (the "强制压缩配置" surface).
 *
 * `compaction` is a hard dependency (`inject`). The `settings` service is
 * optional: the namespace is registered only when `settings` is mounted, and a
 * missing settings service never blocks the compaction listener (the plugin
 * falls back to its composition defaults).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Register the settings namespace when the `settings` service is mounted.
  // `registerNamespace` is a no-op returning `false` when `settings` is absent.
  ctx.effect(async () => {
    const registered = await registerNamespace(ctx)
    if (registered) ctx.logger.debug('[force-compact] registered settings namespace "force-compact"')
  }, 'force-compact: settings namespace')

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

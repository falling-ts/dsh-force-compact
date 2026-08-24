/**
 * The turn-end forced compaction.
 *
 * Observes `agent/status`; when an agent transitions to `idle` (no driver
 * remains scheduled or active — i.e. all turns done, including sub-agents) and
 * `turnEndForceCompactionEnabled` is on, compacts the session's useful history
 * through the compaction service's **idle manual entry** (`compactNow`). This
 * fires at the "all done, before the next human turn" boundary the user
 * described: the agent is not busy (all turns and sub-agent work have
 * quiesced) and the next human message has not yet arrived.
 *
 * `compactNow` is the idle manual-compaction entry (owner `null`): it requires an
 * idle agent and uses the engine's own range selection. `compactRegion` is NOT
 * usable here — its owner is `current-turn`, which requires an open turn, so at
 * idle it throws "no open turn". A fresh `AbortController` mints a signal per
 * idle transition (an `agent/status` listener carries no turn signal of its
 * own).
 *
 * @module @falling-ts/dsh-force-compact/turn-end
 */

import { readSettings, DEFAULTS } from './settings.js'

/**
 * Handle one `agent/status` emission: when the agent transitions to `idle` and
 * `turnEndForceCompactionEnabled` is on, compact the session's useful history
 * through `compactNow` (the idle manual-compaction entry). Never throws out of
 * the listener (a failing compaction is logged and swallowed).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agent: import('@deepseek-ai/dsh-agent').Agent, status: string}} payload
 * @returns {Promise<void>}
 */
export async function handleAgentStatus(ctx, payload) {
  const { agent, status } = payload
  if (status !== 'idle') return

  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (settings.turnEndForceCompactionEnabled !== true) return

  const session = agent.session
  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactNow !== 'function') {
    ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable at idle`)
    return
  }

  // compactNow is the idle manual-compaction entry (owner null). It requires an
  // idle agent and uses the engine's own range selection. A fresh
  // AbortController mints a signal (a status listener carries no turn signal of
  // its own).
  const controller = new AbortController()
  try {
    const result = await compaction.compactNow(agent, controller.signal)
    if (result === undefined || result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: idle compaction committed nothing`)
      return
    }
    ctx.logger.info(
      `[force-compact] ${session.id}: idle compaction shadowed ${result.shadowedSeqs.length} nodes `
      + `(~${result.shadowedTokenCount} tokens)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: idle compaction failed — ${message}`)
  }
}

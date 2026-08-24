/**
 * The turn-end forced compaction.
 *
 * Observes `agent/status`; when an agent transitions to `idle` (no driver
 * remains scheduled or active — i.e. all turns done, including sub-agents) and
 * `turnEndForceCompactionEnabled` is on, compacts the earliest
 * `turnEndCompactionRatio` of the session's **tokens** (via `compactRegion`).
 * This fires at the "all done, before the next human turn" boundary the user
 * described: the agent is not busy (all turns and sub-agent work have
 * quiesced) and the next human message has not yet arrived.
 *
 * A fresh `AbortController` mints a signal per idle transition (an
 * `agent/status` listener carries no turn signal of its own).
 *
 * @module @falling-ts/dsh-force-compact/turn-end
 */

import { selectEarliestByTokens } from './region.js'
import { readSettings, DEFAULTS } from './settings.js'

/**
 * Handle one `agent/status` emission: when the agent transitions to `idle` and
 * `turnEndForceCompactionEnabled` is on, force-compact the earliest
 * `turnEndCompactionRatio` of the conversation's tokens. Never throws out of
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
  if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
    ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable at idle`)
    return
  }

  // Measure the session's total context tokens (authoritative when tokenMeter
  // is mounted; character-based fallback otherwise).
  const meter = ctx.get('tokenMeter')
  const totalTokens = meter !== undefined && typeof meter.measure === 'function'
    ? meter.measure(session).totalTokens
    : undefined

  const region = selectEarliestByTokens(session, settings.turnEndCompactionRatio, totalTokens)
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no earliest ${settings.turnEndCompactionRatio} token region at idle`)
    return
  }

  const controller = new AbortController()
  const disableThinking = settings.disableThinking === true
  const compactSignal = {
    signal: controller.signal,
    get reasoningEffort() {
      return disableThinking ? 'off' : undefined
    },
  }
  try {
    const result = await compaction.compactRegion(region.start, region.end, agent, compactSignal)
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

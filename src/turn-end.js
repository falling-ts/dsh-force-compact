/**
 * The turn-end forced compaction.
 *
 * Observes `session/event`; when a turn ends (`turn/end`) and
 * `turnEndForceCompactionEnabled` is on, compacts the earliest
 * `turnEndCompactionRatio` of the session's surface history (via
 * `compactRegion`) so the next turn starts from a shrunken context. A fresh
 * `AbortController` mints a signal per turn end (a `session/event` listener
 * carries no turn signal of its own).
 *
 * @module @falling-ts/dsh-force-compact/turn-end
 */

import { selectEarliestRatio } from './region.js'
import { readSettings, DEFAULTS } from './settings.js'

/**
 * Handle one `session/event` emission: when it is a `turn/end` for a live agent
 * and the setting is enabled, force-compact the earliest
 * `turnEndCompactionRatio` of the conversation. Never throws out of the
 * listener (a failing compaction is logged and swallowed).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {import('@deepseek-ai/dsh-session').SessionEvent} event
 * @returns {Promise<void>}
 */
export async function handleTurnEnd(ctx, session, event) {
  if (event.type !== 'turn/end') return

  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (settings.turnEndForceCompactionEnabled !== true) return

  const agents = ctx.get('agents')
  if (agents === undefined) return
  const agent = agents.get(session.id)
  if (agent === undefined || agent === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no live agent at turn end — skipping`)
    return
  }

  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
    ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable at turn end`)
    return
  }

  const region = selectEarliestRatio(session, settings.turnEndCompactionRatio)
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no earliest ${settings.turnEndCompactionRatio} region at turn end`)
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
      ctx.logger.debug(`[force-compact] ${session.id}: turn-end compaction committed nothing`)
      return
    }
    ctx.logger.info(
      `[force-compact] ${session.id}: turn-end compaction shadowed ${result.shadowedSeqs.length} nodes `
      + `(~${result.shadowedTokenCount} tokens)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: turn-end compaction failed — ${message}`)
  }
}

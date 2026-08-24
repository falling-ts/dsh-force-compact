/**
 * The `/force-compact` slash command.
 *
 * Selected from the `/` command list. Its handler runs **without sending the
 * line to the model**, so it can act on an agent that is busy. When the agent is
 * idle it force-compacts immediately; when the agent is mid-turn it queues a
 * process-local force flag (`queueForceCompact`) that the `agent/pre-step` hook
 * consumes at the next model step — which then force-compacts instead of
 * requesting the model (the "insert a js memory record" behaviour).
 *
 * @module @falling-ts/dsh-force-compact/command
 */

import { queueForceCompact } from './request-guard.js'
import { selectEarliestRatio } from './region.js'
import { readSettings, DEFAULTS } from './settings.js'

/**
 * Register the global `/force-compact` command. A no-op when the `commands`
 * service is not mounted.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether the command was registered.
 */
export function registerCommand(ctx) {
  const commands = ctx.get('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    ctx.logger.debug('[force-compact] commands service unavailable; /force-compact not registered')
    return false
  }

  commands.register({
    name: 'force-compact',
    description: 'Force-compact the agent session context now (skips the model when busy).',
    recordInput: false,
    handler: async (invocation) => {
      const agent = invocation.agent
      const session = agent.session
      const compaction = ctx.get('compaction')
      const settings = (await readSettings(ctx)) ?? DEFAULTS

      // The compaction service is a hard dependency of this plugin; guard the
      // rare case it is not available so the command settles as an error rather
      // than throwing out of the handler.
      if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
        ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable`)
        return { kind: 'error', text: 'compaction service unavailable' }
      }

      // Compact the earliest `forceEarliestRatio` of the conversation via
      // `compactRegion`. When the agent is busy the compaction is rejected
      // (throws a ManualCompactionError) — in that case queue the force flag so
      // the next model step force-compacts instead of requesting the model.
      const region = selectEarliestRatio(session, settings.forceEarliestRatio)
      if (region === null) {
        return { kind: 'success', text: `no earliest ${settings.forceEarliestRatio} region to compact` }
      }
      try {
        const result = await compaction.compactRegion(
          region.start, region.end, agent,
          {
            signal: invocation.signal,
            get reasoningEffort() {
              return settings.disableThinking ? 'off' : undefined
            },
          },
        )
        if (result === undefined || result === null) {
          ctx.logger.debug(`[force-compact] ${session.id}: no safe range to compact`)
          return { kind: 'success', text: 'no compactable range' }
        }
        ctx.logger.info(
          `[force-compact] ${session.id}: /force-compact shadowed ${result.shadowedSeqs.length} nodes `
          + `(~${result.shadowedTokenCount} tokens)`,
        )
        return { kind: 'success', text: `compacted ~${result.shadowedTokenCount} tokens (earliest ${settings.forceEarliestRatio})` }
      } catch (error) {
        // Busy (or otherwise unable) — queue the force flag for the next step.
        queueForceCompact(session.id)
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.info(`[force-compact] ${session.id}: ${message}; queued for the next model step`)
        return {
          kind: 'success',
          text: `agent is busy — will force-compact at the next model step (${message})`,
        }
      }
    },
  })

  ctx.logger.debug('[force-compact] registered /force-compact command')
  return true
}

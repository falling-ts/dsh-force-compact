/**
 * The `/force-compact` slash command.
 *
 * Selected from the `/` command list. Its handler runs **without sending the
 * line to the model**, so it can act on an agent that is busy. When the agent is
 * idle it compacts immediately through the compaction service's **idle manual
 * entry** (`compactNow`); when the agent is busy `compactNow` is rejected
 * (owner `null` requires an idle agent) and the handler queues a process-local
 * force flag (`queueForceCompact`) that the `agent/pre-step` hook consumes at
 * the next model step — which then force-compacts instead of requesting the
 * model (the "insert a js memory record" behaviour).
 *
 * @module @falling-ts/dsh-force-compact/command
 */

import { queueForceCompact, dbg } from './request-guard.js'
import { resolveCompaction } from './service-resolver.js'
import { readRawSetting } from './settings.js'

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
    description: 'Force-compact the agent session context now (compacts immediately when idle).',
    recordInput: false,
    handler: async (invocation) => {
      const agent = invocation.agent
      const session = agent.session
      // Locate the compaction backend through `agent.ctx` (presets isolate it)
      // with a host-global fallback (see `service-resolver.js`). The
      // `compactionMode` setting is read once here (raw, cheap) and passed so
      // the resolver need not re-read settings.
      const mode = await readRawSetting(ctx, 'compactionMode')
      const compaction = await resolveCompaction(ctx, agent, mode)
      void dbg(ctx, `[force-compact] ${session.id}: /force-compact command handler entered (compaction ${compaction && typeof compaction.compactNow === 'function' ? 'available' : 'UNAVAILABLE'})`)

      // Guard the case it is not available so the command settles as an error
      // rather than throwing out of the handler.
      if (compaction === undefined || typeof compaction.compactNow !== 'function') {
        ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable`)
        return { kind: 'error', text: 'compaction service unavailable' }
      }

      // compactNow is the idle manual-compaction entry (owner null). It requires
      // an idle agent and uses the engine's own range selection. When the agent
      // is busy it throws (ManualCompactionError) — in that case queue the force
      // flag so the pre-step hook force-compacts at the next model step.
      try {
        const result = await compaction.compactNow(agent, invocation.signal)
        if (result === undefined || result === null) {
          ctx.logger.debug(`[force-compact] ${session.id}: no safe range to compact`)
          return { kind: 'success', text: 'no compactable range' }
        }
        ctx.logger.info(
          `[force-compact] ${session.id}: /force-compact shadowed ${result.shadowedSeqs.length} nodes `
          + `(~${result.shadowedTokenCount} tokens)`,
        )
        return { kind: 'success', text: `compacted ~${result.shadowedTokenCount} tokens` }
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

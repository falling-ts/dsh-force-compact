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

import { queueForceCompact } from './guard.js'
import { resolveCompaction } from '../engine/backend.js'
import { readRawSetting } from '../core/settings.js'
import { publishCompressing, publishDone } from '../core/ui-signal.js'

/**
 * Register the global `/force-compact` command. A no-op when the `commands`
 * service is not mounted AT THIS MOMENT (typical during the window between
 * plugin boot and the agent-presets plane activating — the caller retries
 * on each guarded listener invocation, so a transient absence self-heals).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether the command was registered this call.
 */
export function registerCommand(ctx) {
  const commands = ctx.get('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    // Silent on purpose: a transient miss during the boot→preset-plane window
    // is expected; the deferred-registration loop in index.js retries until
    // `commands` appears. If the service is PERMANENTLY absent (rare — e.g. a
    // stripped-down composition) the operator sees the symptom (slash-command
    // picker empty) and can diagnose directly rather than chasing hundreds of
    // boot-miss log lines.
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
      // with a host-global fallback (see `engine/backend.js`). The
      // `compactionMode` setting is read once here (raw, cheap) and passed so
      // the resolver need not re-read settings.
      const mode = await readRawSetting(ctx, 'compactionMode')
      const backend = await resolveCompaction(ctx, agent, mode)
      ctx.logger.debug(`[force-compact] ${session.id}: /force-compact handler entered (backend ${backend ? backend.kind : 'UNAVAILABLE'})`)

      // Guard the case it is not available so the command settles as an error
      // rather than throwing out of the handler. When the OFFICIAL service is
      // realm-isolated AND `builtinEnabled=false`, NOTHING backs this command.
      if (backend === undefined || typeof backend.compactNow !== 'function') {
        ctx.logger.warn(
          `[force-compact] ${session.id}: NO compaction backend available (official service unreachable ` +
          `AND builtin engine missing prerequisites). Enable \`builtinEnabled=true\` in the ` +
          `\`falling-ts-force-compact\` namespace to restore the fallback.`
        )
        return { kind: 'error', text: 'no compaction backend available (enable builtinEnabled or make the official service reachable)' }
      }

      // compactNow is the idle manual-compaction entry (owner null). It requires
      // an idle agent and uses the engine's own range selection. When the agent
      // is busy it throws (ManualCompactionError) — in that case queue the force
      // flag so the pre-step hook force-compacts at the next model step.
      try {
        // LIVE UI SIGNAL — PIN RED "compressing" BEFORE the model-request /
        // commit happens. Both publishers swallow their own failures, so the
        // messenger can never disturb the actual compaction outcome returned
        // below.
        await publishCompressing(ctx)
        const result = await backend.compactNow(agent, invocation.signal)
        if (result === undefined || result === null) {
          ctx.logger.debug(`[force-compact] ${session.id}: no safe range to compact via ${backend.kind}`)
          return { kind: 'success', text: 'no compactable range' }
        }
        // COMMITTED (range shadowed + summary added) — pin GREEN "done"; the
        // next model request's `llm/stream` watermark overwrites it with a
        // fresh random working pair shortly after (natural cadence, no timer).
        await publishDone(ctx)
        ctx.logger.info(
          `[force-compact] ${session.id}: /force-compact (${backend.kind}) shadowed ${result.shadowedSeqs?.length ?? '?'} nodes `
          + `(~${result.shadowedTokenCount ?? '?'} tokens)`,
        )
        return { kind: 'success', text: `compacted ~${result.shadowedTokenCount ?? '?'} tokens via ${backend.kind}` }
      } catch (error) {
        // Busy (or otherwise unable) — queue the force flag for the next step.
        queueForceCompact(session.id)
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.info(`[force-compact] ${session.id}: ${backend.kind} said ${message}; queued for the next model step`)
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

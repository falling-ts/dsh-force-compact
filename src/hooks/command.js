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
import { guardFn, renderCrash, captureThrowSite, appendCrashLine as appendDiag } from '../core/crashnet.js'

/**
 * Register the global `/force-compact` command. A no-op when the `commands`
 * service is not mounted AT THIS MOMENT (typical during the window between
 * plugin boot and the agent-presets plane activating — the caller retries
 * on each guarded listener invocation, so a transient absence self-heals).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether the command was registered this call.
 */
// Internal body of `registerCommand` — routed through the crash-net wrapper.
function __registerCommandBody(ctx) {
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
      // SAFETY ENVELOPE: a slash-command handler that throws surfaces a raw
      // error to the user. Contain the whole body so ANY anomaly (missing
      // `invocation.agent`, a missing `session`, a rejecting settings read, a
      // failing backend call) settles as a friendly `{kind:'error'}` result.
      try {
        return await __forceCompactCommandBody(ctx, invocation)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[force-compact] /force-compact handler degraded — ${message}`)
        // UNIVERSAL-CRASH-NET diagnostic alongside the ctx.logger line above —
        // a durable, parseable trail independent of logger wiring.
        try {
          const lines = renderCrash('command.handler', error, captureThrowSite())
          for (const line of lines) appendDiag(line)
        } catch (_netFailure) { /* swallow */ }
        return { kind: 'error', text: `compaction could not be started: ${message}` }
      }
    },
  })

  ctx.logger.debug('[force-compact] registered /force-compact command')
  return true
}

/** Public entry — wrapped by the universal crash net. */
export const registerCommand = guardFn('command.registerCommand', __registerCommandBody)

/** Body of the `/force-compact` command handler; wrapped by its safe envelope. */
async function __forceCompactCommandBody(ctx, invocation) {
  const agent = (invocation && typeof invocation === 'object') ? invocation.agent : undefined
  const session = (agent && typeof agent === 'object') ? agent.session : undefined
  if (agent === undefined || agent === null || session === undefined || session === null || typeof session.id !== 'string') {
    return { kind: 'error', text: 'no usable agent session for this command' }
  }
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
          // Persist this diagnosis (WARN level so it survives the default INFO
          // floor AND the `[force-compact]` marker routes it into the plugin's
          // own durable log file — previously the reason lived ONLY in a
          // `ctx.logger.info` line that the stock in-memory sink dropped,
          // leaving the user with a bare "no compactable range"). Surface
          // facets: node count (below the 6-node minimum?), head source
          // (a previous checkpoint? re-running on an already-condensed head),
          // and the char-estimated surface sum (vs the 8000 retention floor).
          // The richer meter-priced detail (per-node prices, boundaryKind,
          // crossing points) is additionally recorded by the builtin engine's
          // own skip diagnostic (its `info`/`warn` helpers feed this same
          // durable file).
          const surfNodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
          let headIsCheckpoint = false
          if (surfNodes.length > 0 && Array.isArray(session.events)) {
            const headEvent = session.events[surfNodes[0]]
            const headSource = headEvent && headEvent.data && typeof headEvent.data === 'object' ? headEvent.data.source : undefined
            headIsCheckpoint = !!(headSource && typeof headSource === 'object' && (headSource.plugin === 'force-compact-builtin' || headSource.plugin === 'compact'))
          }
          ctx.logger.warn(
            `[force-compact] ${session.id}: no compactable range via ${backend?.kind} — `
            + `${surfNodes.length} surface nodes (min 6 required), head=${headIsCheckpoint ? 'previous checkpoint' : 'ordinary history'}`,
          )
          return { kind: 'success', text: `no compactable range (${surfNodes.length} surface nodes) — say something to build up more history, or raise the surface size` }
        }
        // COMMITTED (range shadowed + summary added) — pin GREEN "done"; the
        // next model request's `llm/stream` watermark overwrites it with a
        // fresh random working pair shortly after (natural cadence, no timer).
        await publishDone(ctx)
        ctx.logger.info(
          `[force-compact] ${session.id}: /force-compact (${backend?.kind}) shadowed ${result.shadowedSeqs?.length ?? '?'} nodes `
          + `(~${result.shadowedTokenCount ?? '?'} tokens)`,
        )
        return { kind: 'success', text: `compacted ~${result.shadowedTokenCount ?? '?'} tokens via ${backend?.kind}` }
      } catch (error) {
        // Busy (or otherwise unable) — queue the force flag for the next step.
        queueForceCompact(session.id)
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.info(`[force-compact] ${session.id}: ${backend?.kind} said ${message}; queued for the next model step`)
        return {
          kind: 'success',
          text: `agent is busy — will force-compact at the next model step (${message})`,
        }
      }
}

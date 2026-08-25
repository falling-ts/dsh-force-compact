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

import { readSettings, DEFAULTS } from '../core/settings.js'
import { resolveCompaction } from '../engine/backend.js'
import { publishCompressing, publishDone } from '../core/ui-signal.js'

/**
 * Handle one `agent/status` emission: when the agent transitions to `idle` and
 * `turnEndForceCompactionEnabled` is on, compact the session's useful history
 * through `compactNow` (the idle manual-compaction entry). Never throws out of
 * the listener (a failing compaction is logged and swallowed).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agent: import('@deepseek-ai/dsh-agent').Agent, status: string}} payload
 * @param {string|undefined} mode the `compactionMode` setting (passed by the caller); undefined re-reads live.
 * @returns {Promise<void>}
 */
export async function handleAgentStatus(ctx, payload, mode) {
  // SAFETY ENVELOPE: this handler fires on EVERY `agent/status` transition.
  // `compactNow` is a heavyweight LLM round-trip and the idle tick recurs ~every
  // 5s, so ANY uncaught throw here would repeat on every tick — the concrete
  // "stutters every request / stuck" symptom. The ENTIRE body is therefore
  // contained: any anomaly (malformed payload, a rejecting `readSettings`, a
  // missing `agent.session`, a failing backend call) logs and returns; it NEVER
  // throws into the `agent/status` dispatch.
  try {
    await __handleAgentStatusBody(ctx, payload, mode)
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error)
    ctx.logger.warn(`[force-compact] handleAgentStatus degraded (swallowed) — ${message}`)
  }
}

/** Body of {@link handleAgentStatus}; wrapped by its safe envelope. */
async function __handleAgentStatusBody(ctx, payload, mode) {
  if (payload === null || typeof payload !== 'object') return
  const agent = payload.agent
  const status = payload.status
  if (status !== 'idle') return
  // A usable session is required to address the compaction; without one there is
  // nothing to do (and no id to log) — degrade quietly rather than deref crash.
  const session = (agent && typeof agent === 'object') ? agent.session : undefined
  const sid = (session && typeof session.id === 'string') ? session.id : '?'
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (settings.turnEndForceCompactionEnabled !== true) {
    // Visible so a tester who flipped the setting OFF can confirm the guard is
    // what suppressed the idle compaction (not a missing listener).
    ctx.logger.debug(`[force-compact] ${sid}: turn-end compaction disabled by settings — idle transition ignored`)
    return
  }

  if (session === undefined || session === null || typeof session.id !== 'string') {
    ctx.logger.debug(`[force-compact] ${sid}: idle transition observed but agent.session is unusable — skipping turn-end compaction`)
    return
  }
  // Locate a usable compaction backend: the OFFICIAL `compaction` service
  // (preferred) OR this plugin's OWN builtin engine (fallback when the service
  // is realm-isolated away — see `engine/backend.js`). At idle the agent is
  // still live in the registry, so its realm-scoped context still resolves the
  // official instance when one exists; otherwise the builtin engine takes over.
  const backend = await resolveCompaction(ctx, agent, mode)
  if (backend === undefined || typeof backend.compactNow !== 'function') {
    const effMode = (mode !== undefined ? mode : settings.compactionMode)
    ctx.logger.warn(
      `[force-compact] ${session.id}: NO compaction backend available at idle (mode=${effMode}). ` +
      `Either the official \`compaction\` service is realm-isolated (standard preset) AND ` +
      `\`builtinEnabled=false\`, OR the builtin engine is missing a prerequisite ` +
      `(needs \`agent.session\` and the \`llm\` service). Enable \`builtinEnabled=true\` in the ` +
      `\`falling-ts-force-compact\` namespace to restore the fallback.`
    )
    return
  }

  // compactNow is the idle manual-compaction entry (owner null). It requires an
  // idle agent and uses the engine's own range selection. A fresh
  // AbortController mints a signal (a status listener carries no turn signal of
  // its own).
  const controller = new AbortController()
  try {
    // LIVE UI SIGNAL — PIN RED "compressing" BEFORE requesting the model /
    // committing anything. Both publishers are guaranteed side-effect-free
    // (they swallow their own failures internally), so a messenger problem
    // can never perturb the compaction transaction itself.
    await publishCompressing(ctx)
    const result = await backend.compactNow(agent, controller.signal)
    if (result === undefined || result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: idle compaction via ${backend?.kind} committed nothing`)
      return
    }
    // COMMITTED — range shadowed + summary added. Pin GREEN "done" NOW; the
    // next model request's `llm/stream` watermark redraws a fresh random
    // working pair within seconds (typically < 3 s — the very next step's
    // LLM boundary), which is the natural visual rhythm: no dedicated timer
    // needed.
    await publishDone(ctx)
    ctx.logger.info(
      `[force-compact] ${session.id}: idle compaction (${backend?.kind}) shadowed ${result.shadowedSeqs?.length ?? '?'} nodes `
      + `(~${result.shadowedTokenCount ?? '?'} tokens)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: idle compaction via ${backend?.kind} FAILED — ${message}`)
  }
}

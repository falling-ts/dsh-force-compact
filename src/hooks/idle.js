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
import { publishCompressing, publishDone, publishEnd } from '../core/ui-signal.js'
import { guardFn, renderCrash, captureThrowSite, appendCrashLine as appendDiag } from '../core/crashnet.js'

import { getProjectedTokens } from '../core/projected.js'
import { MAX_COMPACTION_ROUNDS } from '../core/policy.js'

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
// SAFETY ENVELOPE: this handler fires on EVERY `agent/status` transition.
// `compactNow` is a heavyweight LLM round-trip and the idle tick recurs ~every
// 5s, so ANY uncaught throw here would repeat on every tick — the concrete
// "stutters every request / stuck" symptom. The ENTIRE body is therefore
// contained: any anomaly (malformed payload, a rejecting `readSettings`, a
// missing `agent.session`, a failing backend call) logs and returns; it NEVER
// throws into the `agent/status` dispatch. Additionally, a UNIVERSAL-CRASH-NET
// diagnostic (thrownAt site, deepest plugin frame, nearest non-plugin frame,
// full stack) is appended to the durable crash log on every degradation.
async function __handleAgentStatusEnveloped(ctx, payload, mode) {
  try {
    await __handleAgentStatusBody(ctx, payload, mode)
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error)
    ctx.logger.warn(`[force-compact] handleAgentStatus degraded (swallowed) — ${message}`)
    try {
      const lines = renderCrash('idle.handleAgentStatus', error, captureThrowSite())
      for (const line of lines) appendDiag(line)
    } catch (_netFailure) { /* swallow */ }
  }
}

export const handleAgentStatus = guardFn('idle.handleAgentStatus', __handleAgentStatusEnveloped)

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
    // CONVERSATION-END CLEAR (2026-09): every idle path ends with the badge
    // cleared — an empty `""` text (isImportant) restores the official look.
    // `publishEnd` swallows its own failures; it never throws into the
    // `agent/status` dispatch.
    await publishEnd(ctx)
    return
  }

  if (session === undefined || session === null || typeof session.id !== 'string') {
    ctx.logger.debug(`[force-compact] ${sid}: idle transition observed but agent.session is unusable — skipping turn-end compaction`)
    // CONVERSATION-END CLEAR (2026-09) — same as the other idle exits.
    await publishEnd(ctx)
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
    // CONVERSATION-END CLEAR (2026-09) — same as the other idle exits.
    await publishEnd(ctx)
    return
  }

  // compactNow is the idle manual-compaction entry (owner null). It requires an
  // idle agent and uses the engine's own range selection. A fresh
  // AbortController mints a signal (a status listener carries no turn signal of
  // its own).
  const controller = new AbortController()
  try {
    // LOOP IDLE COMPACTION (2026-09 semantics — user requirement: compact
    // repeatedly until the projected context is below `autoThresholdTokens`,
    // never skip because a single round could not reach it). Each round
    // re-reads the pressure basis and re-runs `compactNow` (which selects its
    // own region against the CURRENT surface). Loop exits when
    //  (a) the projection is below the threshold (checked from the second
    //      round; the FIRST round always attempts a compaction),
    //  (b) `compactNow` commits nothing (no compactable region or a physical
    //      cap: small-span skip, replay ceiling, failure cooldown), or
    //  (c) the hard `MAX_COMPACTION_ROUNDS` ceiling is reached.
    const meter = ctx.get('tokenMeter')
    let committedAny = false
    for (let round = 0; round < MAX_COMPACTION_ROUNDS; round += 1) {
      if (round > 0) {
        let effTotal = getProjectedTokens(ctx, session)
        if (typeof effTotal !== 'number' || !Number.isFinite(effTotal) || effTotal < 0) {
          try {
            const m = (meter !== undefined && typeof meter.measure === 'function') ? meter.measure(session) : undefined
            if (m !== undefined && Number.isFinite(m.surfaceTokens)) effTotal = m.surfaceTokens
          } catch {
            effTotal = undefined
          }
        }
        if (typeof effTotal === 'number' && Number.isFinite(effTotal) && effTotal < settings.autoThresholdTokens) {
          ctx.logger.info(
            `[force-compact] ${session.id}: idle loop compaction — after ${round + 1} round(s) the projected context ~${effTotal} tokens is below threshold ${settings.autoThresholdTokens}; target reached`
          )
          break
        }
      }
      // LIVE UI SIGNAL — PIN RED "compressing" BEFORE the round's compaction
      // commits. Publishers swallow their own failures — the messenger can
      // never perturb the compaction transaction itself.
      await publishCompressing(ctx)
      // P1 — idle is an AUTO entry: pass `opts: { retainTokens }` to preserve
      // the legacy retain-the-latest-N-tokens selection (the 3rd arg,
      // sourceCommandId, stays undefined — idle has no originating command id).
      const result = await backend.compactNow(agent, controller.signal, undefined, { retainTokens: settings.retainLatestTokens })
      if (result === undefined || result === null) {
        ctx.logger.debug(
          `[force-compact] ${session.id}: idle loop compaction round ${round + 1}/${MAX_COMPACTION_ROUNDS} committed nothing via ${backend?.kind} — stopping the loop`
        )
        break
      }
      committedAny = true
      ctx.logger.info(
        `[force-compact] ${session.id}: idle loop compaction round ${round + 1}/${MAX_COMPACTION_ROUNDS} (${backend?.kind}) shadowed `
        + `${result.shadowedSeqs?.length ?? '?'} nodes (~${result.shadowedTokenCount ?? '?'} tokens)`,
      )
    }
    // Pin GREEN "done" once at least one round committed; the next model
    // request's `llm/stream` watermark redraws a fresh random working pair
    // within seconds — no dedicated timer needed.
    if (committedAny) await publishDone(ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: idle compaction via ${backend?.kind} FAILED — ${message}`)
  }
  // ── CONVERSATION-END CLEAR (2026-09) — the badge is cleared at conversation
  // END (replacing the former conversation-START forced working-pair override
  // that lived in index.js): an empty `""` text with isImportant=true wipes
  // whatever the compaction left on the badge — a stale red `[强制压缩中>>>]`
  // when nothing committed (the self-healing case this clear now covers), or
  // the green `[压缩完成!]` when a round did. The publisher swallows its own
  // failures; it never throws into the `agent/status` dispatch.
  // NOTE: when a round DID commit, the DONE banner's 3-second fallback timer
  // (`publishDone` in ui-signal.js) may repaint a fresh working pair ~3 s
  // AFTER this clear — pre-existing behavior, intentionally left untouched.
  await publishEnd(ctx)
}

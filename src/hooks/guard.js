/**
 * dsh-force-compact's per-model-request guard — the "hook the core model
 * request" half of the plugin.
 *
 * Instead of (or in addition to) the `session/flush` checkpoint, this guard
 * runs at the official model-request seam so the decision is made **right
 * before a model request is made**:
 *
 * - **`agent/request`** (a Waterfall around the frozen call configuration) —
 *   a deliberate **pass-through** (2026-08 semantics revision): the returned
 *   `LlmCallConfig` rides UNCHANGED. `disableThinking` now scopes strictly to
 *   this plugin's own compaction summarization call (enforced inside
 *   `engine/builtin.js` → `engine/summarizer.js`); all other model requests
 *   retain the machine's own reasoning-effort configuration.
 * - **`agent/pre-step`** (a Waterfall before each model step) — reads the
 *   session's **projected context tokens** through the official
 *   `contextPressure` projection (`projectedTokens` — the exact figure the
 *   harness renders in the bottom-right corner, provider-anchored). When
 *   the reading is **>= `autoThresholdTokens`**, the guard rejects the proposed
 *   step (so the model request is NOT made) and instead retains the **latest
 *   `retainLatestTokens` of the conversation's tokens verbatim** while sending
 *   everything before that cutoff to the `compaction`
 *   service's `compactRegion` (read live via `ctx.get('compaction')`), which
 *   condenses the head history and lets the loop retry with a smaller context.
 *
 * Both settings are read **per request** through the synchronous
 * `settings.get('falling-ts-force-compact')` so a `settings.yaml` edit is picked up on the
 * next model request without a restart.
 *
 * @module @falling-ts/dsh-force-compact/request-guard
 */

import { readSettings, DEFAULTS } from '../core/settings.js'
import { MAX_COMPACTION_ROUNDS } from '../core/policy.js'
import {
  selectEarliestByTokens,
  selectEarliestByMeasurements,
  selectRetainingLatestTokens,
  validateSurfaceRegionSafe,
} from '../engine/region.js'
import { resolveCompaction } from '../engine/backend.js'
import { publishCompressing, publishDone } from '../core/ui-signal.js'
import { guardFn, renderCrash, captureThrowSite, appendCrashLine as appendDiag } from '../core/crashnet.js'
import { getProjectedTokens } from '../core/projected.js'
import { sessionEvents } from '../core/session-events.js'

/**
 * Process-local "force compact now" records, one per session (keyed by
 * `session.id`). Set by the `/force-compact` command handler when the agent is
 * busy, and consumed (and cleared) by the `agent/pre-step` hook at the next
 * model step. Each entry is a `{commandId}` object (P1 — carries the
 * originating slash-command id so the pre-step consumer can thread it into the
 * `compaction/*` bracket's `sourceCommandId` field). Survives across the
 * agent's steps within the process without any durable state or timer.
 * @type {Map<string, {commandId: string|undefined}>}
 */
const pendingForce = new Map()

/**
 * Queue a forced compaction for one session (the `/force-compact` command).
 * When the agent is idle the command compacts directly; when it is busy it sets
 * this flag so the next model step force-compacts instead of requesting the
 * model.
 * @param {string} sessionId
 * @param {string|undefined} [commandId] the originating slash-command id (P1).
 */
/** Top-level entry — wrapped by the universal crash net. */
export const queueForceCompact = guardFn('guard.queueForceCompact', (sessionId, commandId) => {
  if (sessionId !== undefined && sessionId !== null) {
    pendingForce.set(sessionId, { commandId })
  }
})

/**
 * Consume (and clear) any pending forced-compaction record for one session.
 * @param {string} sessionId
 * @returns {boolean} whether a force was pending and is now cleared.
 */
export const takeForceCompact = guardFn('guard.takeForceCompact', (sessionId) => {
  const pending = pendingForce.get(sessionId)
  if (pending) pendingForce.delete(sessionId)
  return Boolean(pending)
})

/**
 * Read the pending forced-compaction record WITHOUT consuming it (peek). Used
 * by the pre-step consumer to retrieve the `commandId` before clearing.
 * @param {string} sessionId
 * @returns {{commandId: string|undefined}|undefined}
 */
export const peekForceCompact = guardFn('guard.peekForceCompact', (sessionId) => {
  return pendingForce.get(sessionId)
})




/**
 * Compact a session's head so that the latest `retainLatestTokens` of the
 * surface remains verbatim, sending the remainder to a single summarizer call
 * via the `compaction` service's `compactRegion(start, end, agent, signal)`.
 * Measures the session's total context tokens (via `tokenMeter` or a
 * character-based fallback), then delegates the durable mutation.
 *
 * Selection prefers the meter's own per-node prices (when a `measure()` snapshot
 * is available): starting FROM THE LATEST surface node, ACCUMULATE node tokens
 * BACKWARD until the sum REACHES OR EXCEEDS `retainLatestTokens`; the cutoff
 * splits the surface into the head SPAN TO COMPACT and the RETAINED TAIL
 * (verbatim). Everything before the cut (plus the snap-to-nearest-preceding-
 * tool-pairing-balanced-boundary adjustment — the official pairing ledger,
 * a strict superset of `user/message` boundaries) is sent to the summarizer
 * AS ONE BATCH — the original span's entries become shadowed/skipped in
 * derived history. Before spending the summarization round-trip, the selected
 * span passes TWO official safety gates (both ported from `compaction-basic`):
 * a SURFACE-CONSISTENCY cross-check (the meter's priced snapshot must align
 * node-for-node with the CURRENT `session.surface.nodes`; a concurrent
 * modification between measure and selection aborts this attempt) and the
 * `validateSurfaceRegion` DOUBLE-BALANCE gate (both bounds must sit on
 * tool-pairing balanced cuts — a candidate that would split a step's
 * tool-call/result pair is refused here, logged, and skipped).
 *
 * Legacy `selectEarliestByTokens` is used only when no measurement snapshot is
 * available (tokenMeter absent): it estimates total tokens from char-count and
 * picks a head-aligned prefix under the same `retainLatestTokens` budget (with
 * an implicit total assumption that fits the legacy behavior).
 *
 * Never throws: all failures resolve `false` so the caller's model request
 * proceeds unimpeded.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal|undefined} signal the current turn's signal (forwarded to compaction).
 * @param {string|undefined} mode the `compactionMode` setting (passed by the caller); undefined re-reads live.
 * @param {string|undefined} [sourceCommandId] P1 — the originating slash-command id threaded into the `compaction/*` bracket.
 * @returns {Promise<boolean>} whether a compaction was committed.
 */
async function compactRetainingLatest(ctx, agent, signal, mode, sourceCommandId) {
  // SAFETY ENVELOPE: this function's CONTRACT is to resolve `false` (let the
  // request proceed) on ANY failure — a missing service, a missing span, a
  // throwing `tokenMeter.measure`, a rejecting backend call, or even a
  // malformed `agent` shape. None of those may propagate into the `agent/pre-step`
  // waterfall, where an uncaught throw would surface as a stalled/aborted step
  // (the "every request pauses" symptom). The actual logic lives in the inner
  // closure; any exception anywhere inside resolves `false`.
  try {
    return await __compactRetainingLatestBody(ctx, agent, signal, mode, sourceCommandId)
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error)
    const sid = (agent && agent.session && agent.session.id) ? agent.session.id : '?'
    ctx.logger.warn(`[force-compact] ${sid}: compactRetainingLatest degraded to false (letting the request proceed) — ${message}`)
    return false
  }
}

/** Body of {@link compactRetainingLatest}; wrapped by its safe envelope. */
async function __compactRetainingLatestBody(ctx, agent, signal, mode, sourceCommandId) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = agent.session
  if (session === undefined || session === null) return false
  // Locate a usable compaction backend: the OFFICIAL `compaction` service
  // (preferred when reachable) OR this plugin's OWN builtin engine (the
  // fallback when the service is realm-isolated away — e.g. standard preset).
  // Both backends expose the SAME `{ compactNow, compactRegion, kind }` shape
  // so the call site below is agnostic to which one served the request.
  const backend = await resolveCompaction(ctx, agent, mode)
  if (backend === undefined || typeof backend.compactRegion !== 'function') {
    const effMode = (mode !== undefined ? mode : settings.compactionMode)
    ctx.logger.warn(
      `[force-compact] ${session.id}: NO compaction backend available (official service unreachable AND builtin engine ` +
      `either disabled via \`builtinEnabled=false\` or lacking prerequisites: llm.service/stream or agent.session). ` +
      `No compaction performed. If you want the builtin fallback, ensure \`builtinEnabled=true\` in the ` +
      `\`falling-ts-force-compact\` namespace and that the \`llm\` service is mounted.`
    )
    return false
  }
  const meter = ctx.get('tokenMeter')
  const maxRegionNodes = (settings.maxRegionNodes !== undefined && Number.isFinite(Number(settings.maxRegionNodes)))
    ? Number(settings.maxRegionNodes)
    : undefined

  // LOOP COMPACTION (2026-09 semantics — user requirement: "never skip because
  // a prediction says the span cannot pull the total below the threshold;
  // compact repeatedly until the context is below the threshold").
  //
  // The old threshold-aware shrink gate (skip when `total − region >=
  // threshold`) is REMOVED: its arithmetic folded the provider-reported usage
  // baseline into `total` while a compaction only trims the surface, so a
  // baseline-inflated reading parked a compressible session above the
  // threshold forever. Instead we compact REPEATEDLY: each round re-reads the
  // pressure basis against the CURRENT surface (a committed round shrank it),
  // re-selects a fresh region, and commits. The loop exits when
  //   (a) the projected total drops below `autoThresholdTokens` — the target —
  //       checked from the SECOND round on (the FIRST round always attempts a
  //       compaction so the queued `/force-compact` path keeps its explicit
  //       "compact even below the threshold" contract);
  //   (b) no compactable region remains (the surface is fully under the
  //       retention budget — nothing left to condense); or
  //   (c) a round fails to commit (a repeat attempt would retry the same
  //       shape and burn another summarization call for nothing).
  // `MAX_COMPACTION_ROUNDS` is a hard belt-and-braces ceiling so a pathological
  // provider baseline can never trigger an unbounded summarization spend.
  let committedAny = false
  for (let round = 0; round < MAX_COMPACTION_ROUNDS; round += 1) {
    // Pressure basis — PROJECTED TOKENS (the SAME reading the harness renders
    // in the bottom-right corner): provider-anchored sample + surface movement
    // since the sample, so the loop's arithmetic never drifts from what the
    // user sees, and compactions drop the figure the moment a span is
    // shadowed. When the reading is unavailable we fall back to the meter's
    // `surfaceTokens` (closest same-caliber substitute) before the char
    // estimator takes over inside the legacy selector.
    let totalTokens = getProjectedTokens(ctx, session)
    // Measurement snapshot for NODE-BY-NODE region selection — re-taken every
    // round because the previous round's commit changed the surface.
    let measurement
    if (meter !== undefined && typeof meter.measure === 'function') {
      try {
        const measured = meter.measure(session)
        if (measured !== undefined && measured !== null) {
          measurement = measured
          if (totalTokens === undefined) {
            totalTokens = (Number.isFinite(measured.surfaceTokens) && measured.surfaceTokens > 0)
              ? measured.surfaceTokens
              : undefined
          }
        }
      } catch {
        // leave `totalTokens` as-is (possibly already set from the projection)
      }
    }
    // TARGET REACHED — stop looping once the projection is back below the
    // threshold (from the SECOND round onward; the first round always tries a
    // compaction so an explicit `/force-compact` still runs below the gate).
    if (round > 0 && typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens < settings.autoThresholdTokens) {
      ctx.logger.info(
        `[force-compact] ${session.id}: loop compaction — after ${round + 1} round(s) the projected context ~${totalTokens} tokens is below threshold ${settings.autoThresholdTokens}; target reached`
      )
      break
    }

    // Region selection — prefer the same-caliber meter-node selector (tail
    // retention: walk node prices backward from the newest entry until
    // `>= retainLatestTokens`, snap the cutoff to a preceding balanced
    // boundary; everything before it is the head span to compact). When no
    // measurement snapshot exists (tokenMeter absent), fall back to the legacy
    // char-heuristic selector under the same `retainLatestTokens` budget.
    // `maxRegionNodes` clamps an oversized head span so the builtin engine's
    // replay cap is never tripped and a region is ALWAYS committable.
    const region = (measurement !== undefined)
      ? selectRetainingLatestTokens(session, settings.retainLatestTokens, measurement)
      : (() => {
          if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) return null
          const headBudget = Math.max(0, Math.round(totalTokens - settings.retainLatestTokens))
          if (headBudget <= 0) return null
          return selectEarliestByTokens(session, headBudget, maxRegionNodes)
        })()
    if (region === null) {
      if (round > 0) {
        ctx.logger.debug(
          `[force-compact] ${session.id}: loop compaction — no more region to compact after ${round + 1} round(s); stopping (total=${totalTokens == null ? 'unknown(fallback est)' : totalTokens})`
        )
      } else {
        ctx.logger.debug(`[force-compact] ${session.id}: no region to compact retaining ~${settings.retainLatestTokens} latest tokens (basis=${totalTokens == null ? 'unknown(fallback est)' : totalTokens}${measurement !== undefined ? `, surface nodes=${measurement.nodes?.length}, surfaceTokens=${typeof measurement.surfaceTokens === 'number' ? measurement.surfaceTokens : '?'}` : ''})`)
      }
      break
    }

    // ---- Surface-consistency CROSS-CHECK (ported from the official
    //  `compaction-basic` `prepareCompaction`) -------------------------------
    // The meter's priced snapshot MUST align position-for-position with the
    // session's current surface nodes. A concurrent modification between
    // `measure()` and selection would price a STALE span — refuse this round.
    const surfaceNodes = (session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
    const pricedNodes = (measurement !== undefined && Array.isArray(measurement.nodes)) ? measurement.nodes : null
    const misaligned = (pricedNodes !== null)
      && (pricedNodes.length !== surfaceNodes.length
        || pricedNodes.some((node, index) => node === null || typeof node !== 'object'
          || typeof node.seq !== 'number' || node.seq !== surfaceNodes[index]))
    if (pricedNodes !== null && misaligned) {
      ctx.logger.debug(
        `[force-compact] ${session.id}: loop compaction round ${round + 1} — token-meter surface does not match the current session surface ` +
        `(priced=${pricedNodes.length} vs current=${surfaceNodes.length} nodes) — REFUSING this attempt rather than summarize a stale span.`
      )
      break
    }

    // ---- Official PAIRING BOUNDARY GATE (ported from `validateSurfaceRegion`)
    // Verify BOTH bounds are tool-pairing balanced on the CURRENT surface
    // before spending a summarization round-trip; an unbalanced cut is refused.
    const validated = validateSurfaceRegionSafe(session, region.start, region.end)
    if (validated === null) {
      ctx.logger.debug(
        `[force-compact] ${session.id}: loop compaction round ${round + 1} — selected span seq ${region.start}..${region.end} FAILED the official ` +
        `surface/balance validation (unknown bound, inverted index, or an unbalanced tool-pairing cut) — REFUSING this attempt.`
      )
      break
    }

    ctx.logger.debug(
      `[force-compact] ${session.id}: loop compaction round ${round + 1}/${MAX_COMPACTION_ROUNDS} — compacting head spanning seqs ${region?.start}..${region?.end} `
      + `while retaining the latest ~${settings.retainLatestTokens} tokens, via ${backend?.kind} backend (totalTokens=${totalTokens})`
      + ` | REGION-PICK budget=${settings.retainLatestTokens} `
      + `crossingAccBefore=${region.crossingAccBefore} `
      + `crossingNodeSize=${region.crossingNodeSize} `
      + `crossingAccAfter=${region.crossingAccAfter} `
      + `boundaryKind=${region.boundaryKind ?? 'unknown'} `
      + `retainedTokens(after-boundary-snap)=${region.retainedTokens}`
    )
    try {
      // LIVE UI SIGNAL — PIN RED "compressing" BEFORE the region compaction
      // commits. Publishers swallow their own failures, so the messenger can
      // never affect whether the compaction itself commits.
      await publishCompressing(ctx)
      // P1 — forward `sourceCommandId` as the 5th positional arg (official
      // `compactRegion(start, end, agent, signal, sourceCommandId)` and the
      // builtin equivalent both absorb it).
      const result = await backend.compactRegion(region.start, region.end, agent, signal, sourceCommandId)
      if (result === undefined || result === null) {
        ctx.logger.debug(
          `[force-compact] ${session.id}: loop compaction round ${round + 1} committed nothing via ${backend?.kind} — stopping the loop (the next attempt would retry the same shape)`
        )
        break
      }
      // COMMITTED — range shadowed + summary added. Pin GREEN "done" NOW; the
      // next model request's `llm/stream` watermark replaces it with a fresh
      // random working pair shortly after.
      await publishDone(ctx)
      committedAny = true
      ctx.logger.info(
        `[force-compact] ${session.id}: loop compaction round ${round + 1}/${MAX_COMPACTION_ROUNDS} (${backend?.kind}) `
        + `shadowed ${result.shadowedSeqs?.length ?? '?'} nodes (~${result.shadowedTokenCount ?? '?'} tokens) `
        + `spanning seqs ${region?.start}..${region?.end}`,
      )
      // Round committed — the loop continues; the next iteration re-reads the
      // projection and either reports "below threshold" or compacts again.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[force-compact] ${session.id}: loop compaction round ${round + 1} via ${backend?.kind} FAILED — ${message}`)
      break
    }
  }
  return committedAny
}

/**
 * The `agent/pre-step` guard. A `/force-compact` command queued a force flag for
 * this agent (`takeForceCompact`) → compact immediately, bypassing the token
 * threshold. Otherwise, measure the session's total context tokens and, when they
 * reach `autoThresholdTokens`, compact instead. A failed or no-safe-range
 * compaction resolves to `false` (let the request proceed) rather than throwing.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal|undefined} signal the current turn's signal.
 * @param {string|undefined} mode the `compactionMode` setting (passed by the caller); undefined re-reads live.
 * @returns {Promise<boolean>} `true` when the caller should return `{ kind: 'reject' }`.
 */
// SAFETY ENVELOPE (pre-step gate): the CONTRACT is to resolve `false` (let
// the model request proceed) whenever ANYTHING goes wrong — missing/malformed
// `agent.session`, a rejecting `readSettings`, a throwing `tokenMeter.measure`,
// or a failing compaction. An uncaught throw HERE would surface as a broken
// `agent/pre-step` step (a stall), which is precisely the "every request
// pauses" symptom we are eliminating. So the entire body is contained; any
// anomaly logs and lets the request through.
// Additionally, the wrapper appends a UNIVERSAL-CRASH-NET diagnostic
// (message, thrownAt file:line:col, deepest plugin frame, nearest
// non-plugin frame, full call stack) to the durable crash log — belt-
// and-braces beyond the ctx.logger line above.
async function __forceCompactIfNeededEnvelope(ctx, agent, signal, mode) {
  try {
    return await __forceCompactIfNeededBody(ctx, agent, signal, mode)
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error)
    ctx.logger.warn(`[force-compact] forceCompactIfNeeded degraded to false (letting the request proceed) — ${message}`)
    // Crash-net side-channel: always-visible file entry even if ctx.logger
    // is miswired. Swallows its own errors (never disturbs the degradation).
    try {
      const lines = renderCrash('guard.forceCompactIfNeeded', error, captureThrowSite())
      for (const line of lines) appendDiag(line)
    } catch (_netFailure) { /* never affect the request path */ }
    return false
  }
}

export const forceCompactIfNeeded = guardFn('guard.forceCompactIfNeeded', __forceCompactIfNeededEnvelope)

/** Body of {@link forceCompactIfNeeded}; wrapped by its safe envelope. */
async function __forceCompactIfNeededBody(ctx, agent, signal, mode) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = (agent && typeof agent === 'object') ? agent.session : undefined
  // No usable session object → nothing to gate; let the request proceed.
  if (session === undefined || session === null || typeof session.id !== 'string') {
    ctx.logger.debug(`[force-compact] forceCompactIfNeeded: agent.session unusable — threshold gate skipped, letting the request proceed`)
    return false
  }

  // A `/force-compact` command was issued for this agent while it was busy:
  // compact now, regardless of the token threshold — retain the latest
  // `retainLatestTokens` of the surface, compress the head in one batch.
  // P1 — peek the pending record to recover the originating `commandId`
  // BEFORE `takeForceCompact` clears it, so the `compaction/*` bracket can
  // echo the same `sourceCommandId` the idle-manual path used.
  const pendingRecord = peekForceCompact(session.id)
  if (takeForceCompact(session.id)) {
    const queuedCommandId = (pendingRecord && typeof pendingRecord.commandId === 'string' && pendingRecord.commandId.length > 0)
      ? pendingRecord.commandId
      : undefined
    ctx.logger.info(`[force-compact] ${session.id}: /force-compact queued; force-compacting the head (keeping the latest ~${settings.retainLatestTokens} tokens) immediately${queuedCommandId ? ` (commandId=${queuedCommandId})` : ''}`)
    const committed = await compactRetainingLatest(ctx, agent, signal, mode, queuedCommandId)
    ctx.logger.debug(`[force-compact] ${session.id}: /force-compact forced compaction ${committed ? 'COMMITTED' : 'did not commit'} — letting the request proceed`)
    return committed
  }

  // PROJECTED TOKENS — the authoritative pressure basis. Single definition
  // with the harness UI: reads the SAME `projectedTokens` the harness renders
  // in the bottom-right corner, so the plugin's threshold arithmetic never
  // drifts from what the user sees.
  //
  // Caliber note (vs the previous `surfaceTokens` basis): the delta term in
  // `projectedTokens` is estimated at the meter's fixed CHARS_PER_TOKEN=4
  // density, so heavy-CJK / tool-JSON content is systematically undercounted
  // compared to the unanchored node sum — a deliberate provider-anchor trade
  // the meter prefers. Gate thresholds calibrated on the old basis may fire
  // slightly less often; that is intended, not a regression.
  const projectedTotal = getProjectedTokens(ctx, session)
  const total = (typeof projectedTotal === 'number' && Number.isFinite(projectedTotal) && projectedTotal > 0)
    ? projectedTotal
    : estimateSessionTokens(session)
  // Meter snapshot retained for TWO purposes on the threshold branch: (a) the
  // node-priced region selection fed to `compactRetainingLatest` below — keeps
  // the official tool-pairing ledger alignment even when the THRESHOLD BASIS
  // comes from the projection (scalar basis ≠ node-pricing source, and that
  // split is deliberate); (b) the diagnostic facets logged on the rare
  // threshold-hit branch. Defensive:
  // `measure` might return undefined/a non-object or throw on a transient
  // glitch — neither may propagate through a gate that decides whether to run
  // a model step.
  const meter = ctx.get('tokenMeter')
  let measurement
  if (meter !== undefined && typeof meter.measure === 'function') {
    try {
      const maybeMeasurement = meter.measure(session)
      measurement = (maybeMeasurement !== undefined && maybeMeasurement !== null) ? maybeMeasurement : undefined
    } catch {
      measurement = undefined
    }
  }
  // DIAGNOSTIC: log every facet on the threshold branch so a divergent total
  // can be attributed (projection basis vs baseline kind/tokens vs surface sum
  // vs nodes-window sum). Threshold hits are rare events, so unconditional
  // DEBUG here is cheap.
  const diagNodes = (measurement && Array.isArray(measurement.nodes)) ? measurement.nodes : []
  const diagWindowSum = diagNodes.reduce((acc, n) => acc + (Number(n && n.tokens) > 0 ? Number(n.tokens) : 0), 0)
  if (total >= settings.autoThresholdTokens) {
    const baseline = (measurement && measurement.baseline) || undefined
    const estFallback = estimateSessionTokens(session)
    ctx.logger.debug(
      `[force-compact] ${session.id}: MEASURE-DIAG basis=projectedTokens total=${total} `
      + `baseline=${baseline ? `${baseline?.kind}:${baseline?.tokens}` : 'none'} `
      + `delta=${measurement && typeof measurement.surfaceDeltaTokens === 'number' ? measurement.surfaceDeltaTokens : '?'} `
      + `surfaceTokens=${measurement && typeof measurement.surfaceTokens === 'number' ? measurement.surfaceTokens : '?'} `
      + `nodes=${diagNodes.length} windowSum=${diagWindowSum} charEst4=${estFallback}`
    )
  }
  if (total < settings.autoThresholdTokens) {
    ctx.logger.debug(`[force-compact] ${session.id}: total ~${total} tokens < threshold ${settings.autoThresholdTokens} — below gate, letting the request proceed`)
    return false
  }

  // PRE-FLIGHT DIAGNOSTIC — SURFACE-BASED FLOOR OBSERVATION (informational
  // only; NEVER aborts the compaction). Rationale for dropping the early-return
  // this block USED TO perform: `totalTokens` mixes a provider-reported USAGE
  // baseline (which inflates on sessions that have already consumed context)
  // with the live SURFACE DELTA. Shaving the whole surface window lowers the
  // NEXT request's usage baseline dramatically (the provider re-baselines on
  // the compacted surface), so projecting `total − maxRemovableHead` onto the
  // CURRENT measurement is UNSOUND whenever the baseline is usage-flavored:
  // it predicts "cannot cross" precisely in the regime where compaction helps
   // most. Instead we LOG the floor arithmetic (useful attribution data — how
   // much of `total` is baseline vs window vs delta) and ALWAYS fall through to
   // the attempted compaction. The guard's `total` basis is now the projection's `projectedTokens` (provider-anchored, reacts to surface churn); the meter snapshot beside it is diagnostic-only, so the
   // SURFACE-TOKENS ONLY (no usage-baseline water), so this naive projection is
   // meaningful again; it nonetheless stays INFORMATIONAL — the per-region
   // SHRINK GATE downstream makes the actual decision, and no separate
   // blank-result cooldown exists anymore ("先压缩再说": every threshold-hit
   // step attempts a fresh compaction).
  const floorWindow = (measurement && Array.isArray(measurement.nodes) ? measurement.nodes : [])
    .filter(n => n !== null && typeof n === 'object' && Number.isFinite(Number(n.tokens)))
  const windowSumObserved = floorWindow.reduce((acc, n) => acc + Number(n.tokens), 0)
  const maxRemovableObserved = Math.max(0, windowSumObserved - settings.retainLatestTokens)
  const projectedAfterObserved = total - maxRemovableObserved
  if (floorWindow.length > 0 && projectedAfterObserved >= settings.autoThresholdTokens) {
    ctx.logger.debug(
      `[force-compact] ${session.id}: PRE-FLIGHT OBSERVATION — total ${total} `
      + `(diagnostic baseline ${measurement && measurement.baseline ? `${measurement.baseline?.kind}:${measurement.baseline?.tokens}` : 'n/a'} `
      + `+ diagnostic surfaceDelta ${(measurement && measurement.surfaceDeltaTokens != null) ? measurement.surfaceDeltaTokens : '?'}); `
      + `surfaces window = ${windowSumObserved} tokens across ${floorWindow.length} nodes, `
      + `retains ~${settings.retainLatestTokens} → max removable head = ${maxRemovableObserved} tokens; `
      + `naive projected-after ${projectedAfterObserved} is >= threshold ${settings.autoThresholdTokens} `
      + `BUT the baseline is provider-reported usage (resets post-compaction), `
      + `so we PROCEED with the compaction attempt regardless. The downstream `
      + `shrink-gate protects against repeat no-ops (no BLANK cooldown anymore).`
    )
  }

  // SHORT-CIRCUIT: when the whole current surface window does not exceed the
  // retention budget, there is no head to compact (the tail-retaining selector
  // would walk the entire window and return null). The threshold was tripped
  // by the provider-usage baseline rather than by real surface growth, so an
  // attempted compaction is a guaranteed no-op — skip it and let the request
  // proceed without pretending to compact.
  if (windowSumObserved > 0 && Number.isFinite(windowSumObserved) && windowSumObserved <= settings.retainLatestTokens) {
    ctx.logger.debug(
      `[force-compact] ${session.id}: threshold ${settings.autoThresholdTokens} tripped on a surface window (~${Math.round(windowSumObserved)} tokens) that does not exceed retainLatestTokens (~${settings.retainLatestTokens}) — nothing above the retention floor to compact; letting the request proceed`,
    )
    return false
  }

  // At or above the threshold: attempt a retained-tail compaction (the request
  // itself always proceeds; the plugin never rejects the model call).
  ctx.logger.debug(
    `[force-compact] ${session.id}: context ~${total} tokens >= threshold ${settings.autoThresholdTokens} — attempting a retained-tail compaction (success/failure is reported by the backend below; the request itself proceeds regardless)`,
  )
  // NOTE: threshold path has NO originating slash-command, so the 5th argument
  // (sourceCommandId) must be omitted — passing something else here (e.g. the
  // `measurement` snapshot, as an earlier revision did) would leak a non-string
  // into the compaction/* events' sourceCommandId field.
  const committed = await compactRetainingLatest(ctx, agent, signal, mode)
  if (!committed) {
    // BLANK OUTCOME — nothing shrank, so the NEXT step re-attempts at the same
    // total. That is intentional ("先压缩再说"): a blank result never wedges the
    // gate behind a high-water mark; the shrink-gate inside
    // `compactRetainingLatest` plus the engine-side replay/failure caps absorb
    // any repeat no-ops. Letting the request proceed.
    ctx.logger.debug(`[force-compact] ${session.id}: threshold-gate compaction came back BLANK — letting the request proceed (will re-attempt on the next step).`)
  } else {
    ctx.logger.debug(`[force-compact] ${session.id}: threshold-gate compaction COMMITTED — letting the request proceed`)
  }
  return committed
}

/**
 * Whether a model request SHOULD be sent with thinking/reasoning disabled.
 *
 * LEGACY PREDICATE (2026-08 semantics revision): the active `agent/request`
 * hot path no longer calls this helper. `disableThinking` now scopes STRICTLY
 * to THIS PLUGIN'S OWN compaction summarization call — enforced inside
 * `src/engine/builtin.js` (which sources `extra.reasoningEffort` from
 * `settings.disableThinking` and passes it to `src/engine/summarizer.js`,
 * whose `options.reasoningEffort` stamps the `ctx.llm.stream` request). All
 * OTHER model requests (business conversation, sub-agents, tool-driven,
 * other plugins) ride the machine's config UNCHANGED.
 *
 * Kept exported so a FUTURE caller who genuinely wants the blanket
 * "off-everywhere" semantics (or the legacy dual-layer insurance described
 * in the stale docs) can consume the same setting through the same
 * containment envelope without duplicating the read-settings logic.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<boolean>}
 */
// `agent/request` entry — a throw here would corrupt EVERY outgoing model
// request. Contain it: any settings anomaly resolves `false` (thinking left
// at its provider default) rather than breaking the request path.
// Also append a UNIVERSAL-CRASH-NET diagnostic on any degradation.
async function __thinkingDisabledBody(ctx) {
  try {
    const settings = (await readSettings(ctx)) ?? DEFAULTS
    return settings.disableThinking === true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] thinkingDisabled degraded to false — ${message}`)
    try {
      const lines = renderCrash('guard.thinkingDisabled', error, captureThrowSite())
      for (const line of lines) appendDiag(line)
    } catch (_netFailure) { /* swallow */ }
    return false
  }
}

export const thinkingDisabled = guardFn('guard.thinkingDisabled', __thinkingDisabledBody)

/**
 * Coarse token estimate for a session's whole surface content, used only when
 * the `tokenMeter` service is not mounted. Mirrors the character-based
 * heuristic of `engine/checkpoint.js`.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {number}
 */
function estimateSessionTokens(session) {
  // Coarse char-based estimator used ONLY when `tokenMeter` is absent. Must
  // survive ANY receiver/event shape: every dereference is guarded so a
  // malformed session (no `events`, missing `data`, non-object blocks) degrades
  // to 0 rather than throwing — this feeds a fallback measurement, not a
  // correctness path.
  const CHARS_PER_TOKEN = 4
  let chars = 0
  const events = sessionEvents(session)
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    let content
    const data = (event.data && typeof event.data === 'object') ? event.data : undefined
    if (event.type === 'user/message') content = data.content
    else if (event.type === 'assistant/message') {
      content = (data.message && typeof data.message === 'object') ? data.message.content : undefined
    } else if (event.type === 'tool/result') {
      const msg = (data.message && typeof data.message === 'object') ? data.message : undefined
      content = msg !== undefined ? msg.content : undefined
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

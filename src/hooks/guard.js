/**
 * dsh-force-compact's per-model-request guard — the "hook the core model
 * request" half of the plugin.
 *
 * Instead of (or in addition to) the `session/flush` checkpoint, this guard
 * runs at the official model-request seam so the decision is made **right
 * before a model request is made**:
 *
 * - **`agent/request`** (a Waterfall around the frozen call configuration) —
 *   when the `disableThinking` setting is on, the returned `LlmCallConfig`
 *   carries `reasoningEffort: 'off'`, which the LLM adapter maps to
 *   `thinking: { type: 'disabled' }`. Every model request in this process is
 *   therefore sent with thinking/reasoning disabled.
 * - **`agent/pre-step`** (a Waterfall before each model step) — reads the
 *   session's **total context tokens** through the `tokenMeter` service. When
 *   the total is **>= `autoThresholdTokens`**, the guard rejects the proposed
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
import {
  selectEarliestByTokens,
  selectEarliestByMeasurements,
  selectRetainingLatestTokens,
  validateSurfaceRegionSafe,
} from '../engine/region.js'
import { resolveCompaction } from '../engine/backend.js'
import { publishCompressing, publishDone } from '../core/ui-signal.js'
import { guardFn, renderCrash, captureThrowSite, appendCrashLine as appendDiag } from '../core/crashnet.js'

/**
 * Process-local "force compact now" flags, one per session (keyed by
 * `session.id`). Set by the `/force-compact` command handler when the agent is
 * busy, and consumed (and cleared) by the `agent/pre-step` hook at the next
 * model step. This is the "insert a js memory record" the command needs: it
 * survives across the agent's steps within the process without any durable
 * state or timer.
 * @type {Map<string, true>}
 */
const pendingForce = new Map()

/**
 * Queue a forced compaction for one session (the `/force-compact` command).
 * When the agent is idle the command compacts directly; when it is busy it sets
 * this flag so the next model step force-compacts instead of requesting the
 * model.
 * @param {string} sessionId
 */
/** Top-level entry — wrapped by the universal crash net. */
export const queueForceCompact = guardFn('guard.queueForceCompact', (sessionId) => {
  if (sessionId !== undefined && sessionId !== null) pendingForce.set(sessionId, true)
})

/**
 * Consume (and clear) any pending forced-compaction flag for one session.
 * @param {string} sessionId
 * @returns {boolean} whether a force was pending and is now cleared.
 */
export const takeForceCompact = guardFn('guard.takeForceCompact', (sessionId) => {
  const pending = pendingForce.get(sessionId)
  if (pending) pendingForce.delete(sessionId)
  return pending === true
})



/**
 * Estimate the total token count of the messages contained in a region span,
 * using the `tokenMeter.estimateMessage` service when available and falling
 * back to a 4-chars-per-token character heuristic. Mirrors the projection the
 * builtin engine performs (`projectRegion`), but only to SUM sizes for the
 * threshold-aware shrink gate — it builds no durable artifacts.
 * @param {object|undefined} meter the `tokenMeter` service (may be undefined).
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {{start: number, end: number}} region the head-anchored span (inclusive seqs).
 * @returns {number} the summed token estimate (0 when nothing measurable).
 */
/**
 * Sum the meter's per-node prices for the surface nodes whose seq falls within
 * the selected region's [start..end] seq window. Reusing the measurement's own
 * node prices keeps the shrink gate's region figure on the SAME caliber as both
 * the region selector and the gate's `totalTokens` (all fed by the one
 * `measure()` snapshot). Falls back to re-pricing flat surface content via
 * `meter.estimateMessage` / char-heuristic when no measurement is supplied.
 */
function estimateRegionTokens(meter, session, region, measurement) {
  // PREFERRED: when a `measure()` snapshot is available, sum the node prices for
  // the seq window directly — same pricer, same total caliber as the selector.
  if (measurement !== undefined && Array.isArray(measurement.nodes)) {
    const lo = Math.min(region.start, region.end)
    const hi = Math.max(region.start, region.end)
    let tokens = 0
    for (const node of measurement.nodes) {
      const n = Number(node.seq)
      if (Number.isFinite(n) && n >= lo && n <= hi) {
        const t = Number(node.tokens)
        if (Number.isFinite(t) && t > 0) tokens += t
      }
    }
    return tokens
  }
  // LEGACY: no measurement — price the region's surface seqs manually. Malformed
  // shapes degrade to whatever IS measurable (often 0) rather than throwing —
  // feeds a shrink gate, never a correctness path.
  const surfaceNodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const nodes = [...surfaceNodes]
  const firstIdx = nodes.indexOf(region.start)
  const lastIdx = nodes.lastIndexOf(region.end)
  const segment = (firstIdx >= 0 && lastIdx >= firstIdx)
    ? nodes.slice(firstIdx, lastIdx + 1)
    : []
  const events = (session && Array.isArray(session.events)) ? session.events : []
  let tokens = 0
  const useMeter = meter !== undefined && typeof meter.estimateMessage === 'function'
  for (const seq of segment) {
    const event = events[seq]
    if (event === undefined || event === null || typeof event !== 'object') continue
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    let content
    if (event.type === 'user/message') content = data.content
    else if (event.type === 'assistant/message') content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
    else if (event.type === 'tool/result') content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
    if (content === undefined || content === null) continue
    if (useMeter) {
      try {
        tokens += meter.estimateMessage({ role: 'user', content })
      } catch {
        /* estimator hiccup — ignore this block */
      }
    } else {
      let chars = 0
      const blocks = Array.isArray(content) ? content : []
      for (const block of blocks) if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
      tokens += Math.ceil(chars / 4)
    }
  }
  return tokens
}

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
 * @returns {Promise<boolean>} whether a compaction was committed.
 */
async function compactRetainingLatest(ctx, agent, signal, mode) {
  // SAFETY ENVELOPE: this function's CONTRACT is to resolve `false` (let the
  // request proceed) on ANY failure — a missing service, a missing span, a
  // throwing `tokenMeter.measure`, a rejecting backend call, or even a
  // malformed `agent` shape. None of those may propagate into the `agent/pre-step`
  // waterfall, where an uncaught throw would surface as a stalled/aborted step
  // (the "every request pauses" symptom). The actual logic lives in the inner
  // closure; any exception anywhere inside resolves `false`.
  try {
    return await __compactRetainingLatestBody(ctx, agent, signal, mode)
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error)
    const sid = (agent && agent.session && agent.session.id) ? agent.session.id : '?'
    ctx.logger.warn(`[force-compact] ${sid}: compactRetainingLatest degraded to false (letting the request proceed) — ${message}`)
    return false
  }
}

/** Body of {@link compactRetainingLatest}; wrapped by its safe envelope. */
async function __compactRetainingLatestBody(ctx, agent, signal, mode) {
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
  // Measure the session's REAL content mass (SURFACE TOKENS ONLY — no usage-
  // baseline water). `measured.totalTokens` includes a provider-reported usage
  // baseline that inflates with prior consumption and RESETS after each
  // compaction, so keying any threshold arithmetic on it produces phantom
  // "still above threshold" states that never clear; `measured.surfaceTokens`
  // is the honest, stable mass of what the model actually sees. Defensive:
  // `measure` might return undefined/a non-object for a malformed session, and
  // calling it might throw on a transient backend glitch — BOTH must degrade
  // to `undefined` (caller then falls back to the char estimator) rather than
  // propagate.
  const meter = ctx.get('tokenMeter')
  let totalTokens
  let measurement
  if (meter !== undefined && typeof meter.measure === 'function') {
    try {
      const measured = meter.measure(session)
      if (measured !== undefined && measured !== null) {
        measurement = measured
        totalTokens = (Number.isFinite(measured.surfaceTokens) && measured.surfaceTokens > 0)
          ? measured.surfaceTokens
          : undefined
      }
    } catch {
      totalTokens = undefined
    }
  }
  // Region selection: PREFER the same-caliber meter-node selector (prices each
  // candidate from the very `measure()` snapshot that produced `totalTokens`,
  // so the budget is always reachable and the boundary well-defined). The
  // `maxRegionNodes` cap CLAMPS an oversized 0.ratio head-span down to the
  // largest serviceable head-aligned prefix so the builtin engine's replay cap
  // is never tripped and a region is ALWAYS committable on a threshold trip.
  // Fall back to the legacy char-heuristic variant only when no measurement
  // snapshot is available (tokenMeter absent). See the selectors' docs.
  const maxRegionNodes = (settings.maxRegionNodes !== undefined && Number.isFinite(Number(settings.maxRegionNodes)))
    ? Number(settings.maxRegionNodes)
    : undefined
  // Prefer the tail-retaining selector when a measurement snapshot exists: it
  // walks the node prices backward from the newest entry accumulating tokens
  // until `>= retainLatestTokens`, snapping the cutoff to a preceding
  // `user/message` boundary. This is exactly the "keep latest N tokens
  // verbatim, send everything older in one batch to the LLM" semantic the
  // user-facing `retainLatestTokens` knob promises.
  //
  // FALLBACK (legacy `selectEarliestByTokens`): when no measurement snapshot
  // is available (tokenMeter absent), use the char-heuristic variant — it
  // prices from `estimateSessionTokens` and applies the same `maxRegionNodes`
  // clamp for the same bounded-region guarantee.
  const region = (measurement !== undefined)
    ? selectRetainingLatestTokens(session, settings.retainLatestTokens, measurement)
    : (() => {
        // DEGENERATE FALLBACK (tokenMeter absent): express the retention
        // semantic via the char-estimated total. The head to compact is at
        // most (totalEstimated − retainLatestTokens); pass THAT absolute
        // head-budget to the legacy selector, which walks from the head
        // accumulating until the budget is consumed. When the retention
        // budget exceeds the estimated total (tiny session), the head budget
        // clamps to 0 and the selector trivially returns null — no compaction.
        if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) return null
        const headBudget = Math.max(0, Math.round(totalTokens - settings.retainLatestTokens))
        if (headBudget <= 0) return null
        return selectEarliestByTokens(session, headBudget, maxRegionNodes)
      })()
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no region to compact retaining ~${settings.retainLatestTokens} latest tokens (totalTokens=${totalTokens == null ? 'unknown(fallback est)' : totalTokens}${measurement !== undefined ? `, surface nodes=${measurement.nodes?.length}, surfaceTokens=${measurement.surfaceTokens}` : ''})`)
    return false
  }

  // ---- Surface-consistency CROSS-CHECK (ported from the official
  //  `compaction-basic` `prepareCompaction`) -------------------------------
  // The meter's priced snapshot MUST align position-for-position with the
  // session's current surface nodes. When a concurrent modification landed a
  // node between the `measure()` above and selection completion, the two
  // disagree; proceeding would price a STALE span. Refuse the compaction
  // attempt entirely (next step retries on a fresh snapshot) rather than pay
  // for a summarization of the wrong bytes.
  const surfaceNodes = (session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const pricedNodes = (measurement !== undefined && Array.isArray(measurement.nodes)) ? measurement.nodes : null
  if (pricedNodes !== null && (pricedNodes.length !== surfaceNodes.length
    || pricedNodes.some((seq, index) => seq !== surfaceNodes[index]?.seq))) {
    ctx.logger.debug(
      `[force-compact] ${session.id}: token-meter surface does not match the current session surface ` +
      `(priced=${pricedNodes.length} vs current=${surfaceNodes.length} nodes) — REFUSING this compaction ` +
      `attempt rather than summarize a stale span; retrying on the next step.`
    )
    return false
  }

  // ---- Official PAIRING BOUNDARY GATE (ported from the official
  //  `validateSurfaceRegion`) ----------------------------------------------
  // Before spending a summarization round-trip, verify BOTH bounds are
  // tool-pairing balanced on the CURRENT surface (the precise per-event
  // ledger, not an assumption about the selection having done its job). A
  // candidate that would split a step's tool-call/result pair is refused
  // HERE (fail-loud, logged) — the session core's own replace validation
  // remains the last line of defense behind this gate.
  const validated = validateSurfaceRegionSafe(session, region.start, region.end)
  if (validated === null) {
    ctx.logger.debug(
      `[force-compact] ${session.id}: selected span seq ${region.start}..${region.end} FAILED the official ` +
      `surface/balance validation (unknown bound, inverted index, or an unbalanced tool-pairing cut) — ` +
      `REFUSING this compaction attempt; the session core's own replace validation remains the safety net.`
    )
    return false
  }

  // THRESHOLD-AWARE SHRINK GATE (root fix for the low-threshold dead loop).
  // Predict whether compacting this region can ACTUALLY pull the session below
  // `autoThresholdTokens` before paying for a summarization LLM call. When the
  // chosen region is too small relative to the total — i.e. even removing it
  // WHOLE would leave total >= threshold — this compaction cannot achieve the
  // goal, so attempting it just burns an LLM call and (because total hardly
  // drops) re-arms the same gate on the next step: the "send 3 times, third
  // wedges" storm. Skip early and let the request proceed.
  //
  // Only applied when we KNOW the total (tokenMeter available). With an unknown
  // total there is no threshold comparison to make, so we proceed normally.
  // This gate intentionally serves BOTH the auto-threshold path AND the
  // explicit `/force-compact` path (both funnel here), so a command that
  // cannot shrink below the threshold is likewise deferred rather than spammed.
  if (totalTokens !== undefined && totalTokens >= settings.autoThresholdTokens) {
    let regionTokens
    try {
      regionTokens = estimateRegionTokens(meter, session, region, measurement)
    } catch {
      regionTokens = 0 // a measurement failure means "skip the shrink gate"; the inner try/catch handles the eventual compaction.
    }
    // NOTE ON CAP-CLAMPING WITH TAIL RETENTION: unlike the legacy
    // ratio-of-total selector (where a capped head-span had to be deliberately
    // bypassed because committing it was the ONLY way to make headway), the
    // new tail-retention semantic ALREADY bounds the retained side. When a
    // measurement snapshot is present, `selectRetainingLatestTokens` returns a
    // region whose head-span is AT MOST (windowSum − retainLatestTokens)
    // tokens wide — inherently a bounded head. If THAT bound is still too big
    // to cross the threshold, skipping is CORRECT here: retrying the SAME
    // region next step changes nothing (nothing shrunk), so deferring avoids
    // burning repeated summarization calls. We therefore DO NOT special-case
    // a "capped head-span" branch — the math is simpler and correct.
    if (typeof regionTokens === 'number' && regionTokens > 0 && totalTokens - regionTokens >= settings.autoThresholdTokens) {
      ctx.logger.debug(
        `[force-compact] ${session.id}: threshold-aware gate — retained-tail region (~${regionTokens} tokens; retains ~${settings.retainLatestTokens} latest tokens) `
        + `cannot pull total ~${totalTokens} below threshold ${settings.autoThresholdTokens} `
        + `(would still be ~${totalTokens - regionTokens}); SKIPPING compaction, letting the request proceed`
      )
      return false
    }
  }

  ctx.logger.debug(
    `[force-compact] ${session.id}: compacting head spanning seqs ${region?.start}..${region?.end} `
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
    // commits. This single site covers BOTH pre-step trigger paths (queued
    // `/force-compact` flag and the auto token-threshold gate), since both
    // funnel through `compactRetainingLatest`. Publishers swallow their own
    // failures — the messenger can never affect whether the compaction itself
    // commits.
    await publishCompressing(ctx)
    const result = await backend.compactRegion(region.start, region.end, agent, signal)
    if (result === undefined || result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: retained-tail compaction committed nothing via ${backend?.kind}`)
      return false
    }
    // COMMITTED — range shadowed + summary added.
    // Pin GREEN "done"; the next model step's `llm/stream` watermark replaces
    // it with a fresh random working pair shortly after (cadence < 3 s, no timer).
    await publishDone(ctx)
    ctx.logger.info(
      `[force-compact] ${session.id}: retained-latest-${settings.retainLatestTokens}-tokens compaction (${backend?.kind}) `
      + `shadowed ${result.shadowedSeqs?.length ?? '?'} nodes (~${result.shadowedTokenCount ?? '?'} tokens) `
      + `spanning seqs ${region?.start}..${region?.end}`,
    )
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: retained-tail compaction via ${backend?.kind} FAILED — ${message}`)
    return false
  }
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
  if (takeForceCompact(session.id)) {
    ctx.logger.info(`[force-compact] ${session.id}: /force-compact queued; force-compacting the head (keeping the latest ~${settings.retainLatestTokens} tokens) immediately`)
    const committed = await compactRetainingLatest(ctx, agent, signal, mode)
    ctx.logger.debug(`[force-compact] ${session.id}: /force-compact forced compaction ${committed ? 'COMMITTED' : 'did not commit'} — letting the request proceed`)
    return committed
  }

  // Total context tokens for this session — the authoritative measurement the
  // official `compaction-basic` uses for its pressure gate.
  const meter = ctx.get('tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') {
    ctx.logger.debug(`[force-compact] ${session.id}: tokenMeter unavailable — threshold gate skipped, letting the request proceed`)
    return false
  }
  const measurement = meter.measure(session)
  // AUTHORITATIVE PRESSURE BASIS — SURFACE TOKENS ONLY (no usage-baseline
  // water). `totalTokens` mixes a provider-reported USAGE baseline (which
  // inflates on sessions that have already consumed context and RESETS after
  // every compaction, making any high-water mark anchored on it unreachable
  // forever) with the live surface content. The real, stable mass of what the
  // model actually sees is `measurement.surfaceTokens` (the sum of the meter's
  // per-node surface prices), so ALL threshold arithmetic in this guard now
  // keys off it exclusively — gates, shrink predictions, and logs alike.
  // Degraded modes (missing/malformed measurement or non-number
  // `surfaceTokens`) fall back to the char-based estimator, which approximates
  // exactly the surface content mass as well.
  const total = (measurement && typeof measurement.surfaceTokens === 'number' && Number.isFinite(measurement.surfaceTokens)
    && measurement.surfaceTokens > 0)
    ? measurement.surfaceTokens
    : estimateSessionTokens(session)
  // DIAGNOSTIC: log every measurement facet on the threshold branch so a
  // divergent total can be attributed (baseline kind/tokens vs surface sum vs
  // nodes-window sum). Threshold hits are rare events, so unconditional INFO
  // here is cheap.
  const diagNodes = Array.isArray(measurement && measurement.nodes) ? measurement.nodes : []
  const diagWindowSum = diagNodes.reduce((acc, n) => acc + (Number(n.tokens) > 0 ? Number(n.tokens) : 0), 0)
  if (total >= settings.autoThresholdTokens) {
    const baseline = measurement && measurement.baseline
    const estFallback = estimateSessionTokens(session)
    ctx.logger.debug(
      `[force-compact] ${session.id}: MEASURE-DIAG total=${total} `
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
   // the attempted compaction. Note that the guard's `total` is now
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
      + `(usage-baseline ${measurement.baseline ? `${measurement.baseline?.kind}:${measurement.baseline?.tokens}` : 'n/a'} `
      + `+ surfaceDelta ${measurement.surfaceDeltaTokens != null ? measurement.surfaceDeltaTokens : '?'}); `
      + `surfaces window = ${windowSumObserved} tokens across ${floorWindow.length} nodes, `
      + `retains ~${settings.retainLatestTokens} → max removable head = ${maxRemovableObserved} tokens; `
      + `naive projected-after ${projectedAfterObserved} is >= threshold ${settings.autoThresholdTokens} `
      + `BUT the baseline is provider-reported usage (resets post-compaction), `
      + `so we PROCEED with the compaction attempt regardless. The downstream `
      + `shrink-gate protects against repeat no-ops (no BLANK cooldown anymore).`
    )
  }

  // At or above the threshold: do NOT request the model. Retain the latest
  // `retainLatestTokens` of the surface VERBATIM, and send everything before
  // that cutoff (the head) as ONE BATCH to the LLM summarizer. The loop retries
  // the step against the shrunken context (retained tail unchanged).
  ctx.logger.info(
    `[force-compact] ${session.id}: context ~${total} tokens >= threshold ${settings.autoThresholdTokens}; `
    + `rejecting the model request and compacting the head while retaining the latest ~${settings.retainLatestTokens} tokens`,
  )
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
 * Whether a model request should be sent with thinking/reasoning disabled.
 *
 * Called from the `agent/request` Waterfall. When the `disableThinking`
 * setting is on (default), the caller sets `reasoningEffort: 'off'` on the
 * returned `LlmCallConfig`.
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
  const events = (session && Array.isArray(session.events)) ? session.events : []
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

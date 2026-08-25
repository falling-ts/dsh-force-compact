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
 *   step (so the model request is NOT made) and instead compacts the **earliest
 *   `autoEarliestRatio`** of the conversation's tokens via the `compaction`
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
import { selectEarliestByTokens } from '../engine/region.js'
import { resolveCompaction } from '../engine/backend.js'
import { publishCompressing, publishDone } from '../core/ui-signal.js'

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
export function queueForceCompact(sessionId) {
  if (sessionId !== undefined && sessionId !== null) pendingForce.set(sessionId, true)
}

/**
 * Consume (and clear) any pending forced-compaction flag for one session.
 * @param {string} sessionId
 * @returns {boolean} whether a force was pending and is now cleared.
 */
export function takeForceCompact(sessionId) {
  const pending = pendingForce.get(sessionId)
  if (pending) pendingForce.delete(sessionId)
  return pending === true
}

/**
 * Per-session "compaction gave up" cooldown memo.
 *
 * WHY THIS EXISTS (dead-loop prevention): the `agent/pre-step` threshold gate
 * rejects a model step and attempts a compaction when total context >=
 * `autoThresholdTokens`. When that compaction comes back UNCOMMITTED — a blank
 * / empty summary, a shrink-gate reject, a moved range — NOTHING shrank, so the
 * NEXT step measures the SAME total, hits the SAME gate, and compacts AGAIN.
 * Left alone this is an unbounded reject-retry storm that LOOKS like a hang.
 *
 * RULE: when a threshold-gate compaction yields no committed change, we record
 * the session's token count AT THAT MOMENT (plus a short diagnostic note). While
 * the session's total stays at-or-below that mark (+ a small tolerance), we STOP
 * attempting threshold-gated compaction for that session and simply let requests
 * proceed — "blank result, no further action." Once the session grows PAST the
 * mark (genuinely new content accumulates), the cooldown expires automatically,
 * so a legitimately large future context still triggers a fresh attempt. No
 * timers, no persistent state — purely process-local, mirroring `pendingForce`.
 *
 * BOUNDED: capped to at most {@link MAX_COOLDOWN_ENTRIES} sessions so a long-lived
 * process with many conversations cannot accumulate unbounded memo state. When
 * the cap is exceeded, the OLDEST inserted entry is evicted (Map preserves
 * insertion order, so `keys().next()` is deterministic). Entries self-clear on
 * expiry/success, keeping steady-state size near zero in normal use.
 * @type {Map<string, { tokens: number, note: string }>}
 */
const compactCooldown = new Map()
const MAX_COOLDOWN_ENTRIES = 32

/**
 * How far total tokens may grow above a cooled-down mark before the cooldown
 * expires and compaction is retried. A tiny absolute floor avoids jitter on
 * noisy measurements; generous enough that ordinary inter-step noise (a few
 * hundred tokens of tool output) does not spuriously reset.
 */
const COOLDOWN_GROWTH_TOLERANCE = 500

/**
 * Remember that a threshold-gated compaction came back blank for one session,
 * capturing its current token count as the "don't retry until it grows past
 * THIS" high-water mark.
 * @param {string} sessionId
 * @param {number} totalTokens the measured total at the moment of the blank result.
 * @param {string} note why the compaction did not commit (diagnostic only).
 */
function markCompactCooldown(sessionId, totalTokens, note) {
  // Evict oldest-to-newest overflow BEFORE inserting so the new (most recent)
  // session is always retained; delete-first then re-set keeps Map insertion
  // order stable (delete + set moves the key to the tail = newest).
  while (compactCooldown.size >= MAX_COOLDOWN_ENTRIES) {
    const oldest = compactCooldown.keys().next().value
    if (oldest === undefined) break
    compactCooldown.delete(oldest)
  }
  compactCooldown.delete(sessionId) // move to tail if already tracked
  compactCooldown.set(sessionId, { tokens: totalTokens, note })
}

/**
 * Check (and, on expiry, CLEAR) a session's compaction cooldown.
 * @param {string} sessionId
 * @param {number} totalTokens the current measured total.
 * @returns {string|undefined} a human-readable note explaining why compaction is
 *   being skipped, or `undefined` when no cooldown applies (proceed normally).
 *   Clears the memo once the session has grown beyond mark + tolerance.
 */
function consultCompactCooldown(sessionId, totalTokens) {
  const entry = compactCooldown.get(sessionId)
  if (entry === undefined) return undefined
  const grewPast = totalTokens > entry.tokens + COOLDOWN_GROWTH_TOLERANCE
  if (grewPast) {
    compactCooldown.delete(sessionId)
    return undefined
  }
  return entry.note
}

/** Drop a session's cooldown memo (used when a compaction finally succeeds). */
function clearCompactCooldown(sessionId) {
  compactCooldown.delete(sessionId)
}

/**
 * Compact the **earliest** `ratio` fraction of a session's **tokens** via
 * `compactRegion` (the "earliest conversation token ratio" knob). Measures the
 * session's total context tokens (via `tokenMeter` or a character-based
 * fallback), computes the token budget (`totalTokens * ratio`), selects the
 * head-anchored span with `selectEarliestByTokens`, and delegates the durable
 * mutation to the `compaction` service's `compactRegion(start, end, agent,
 * signal)` (read live via `ctx.get('compaction')`), forwarding the caller's
 * `AbortSignal` for cancellation. Resolves `true` when a
 * compaction was committed, `false` otherwise (missing service, no compactable
 * span, or a thrown error) — it never throws.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal|undefined} signal the current turn's signal (forwarded to compaction).
 * @param {number} ratio a fraction in (0, 1] of the session's tokens to compact from the head.
 * @param {string|undefined} mode the `compactionMode` setting (passed by the caller); undefined re-reads live.
 * @returns {Promise<boolean>} whether a compaction was committed.
 */
async function compactEarliestRatio(ctx, agent, signal, ratio, mode) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = agent.session
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
  // Measure the session's total context tokens (authoritative when tokenMeter is
  // mounted; character-based fallback otherwise).
  const meter = ctx.get('tokenMeter')
  const totalTokens = meter !== undefined && typeof meter.measure === 'function'
    ? meter.measure(session).totalTokens
    : undefined
  const region = selectEarliestByTokens(session, ratio, totalTokens)
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no earliest ${ratio} token region to compact (totalTokens=${totalTokens == null ? 'unknown(fallback est)' : totalTokens})`)
    return false
  }
  ctx.logger.debug(`[force-compact] ${session.id}: compacting earliest ${ratio} via ${backend.kind} backend -> span seqs ${region.start}..${region.end} (totalTokens=${totalTokens})`)
  try {
    // LIVE UI SIGNAL — PIN RED "compressing" BEFORE the region compaction
    // commits. This single site covers BOTH pre-step trigger paths (queued
    // `/force-compact` flag and the auto token-threshold gate), since both
    // funnel through `compactEarliestRatio`. Publishers swallow their own
    // failures — the messenger can never affect whether the compaction itself
    // commits.
    await publishCompressing(ctx)
    const result = await backend.compactRegion(region.start, region.end, agent, signal)
    if (result === undefined || result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: earliest ${ratio} compaction committed nothing via ${backend.kind}`)
      return false
    }
    // COMMITTED — range shadowed + summary added. Clear any outstanding
    // cooldown memo for this session (it demonstrably shrank this time, so a
    // future threshold hit should attempt fresh, not inherit a stale give-up).
    clearCompactCooldown(session.id)
    // Pin GREEN "done"; the next model step's `llm/stream` watermark replaces
    // it with a fresh random working pair shortly after (cadence < 3 s, no timer).
    await publishDone(ctx)
    ctx.logger.info(
      `[force-compact] ${session.id}: earliest ${ratio} compaction (${backend.kind}) shadowed ${result.shadowedSeqs?.length ?? '?'} nodes `
      + `(~${result.shadowedTokenCount ?? '?'} tokens)`,
    )
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: earliest ${ratio} compaction via ${backend.kind} FAILED — ${message}`)
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
export async function forceCompactIfNeeded(ctx, agent, signal, mode) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = agent.session

  // A `/force-compact` command was issued for this agent while it was busy:
  // compact now, regardless of the token threshold — the earliest
  // `forceEarliestRatio` of the conversation.
  if (takeForceCompact(session.id)) {
    ctx.logger.info(`[force-compact] ${session.id}: /force-compact queued; force-compacting the earliest ${settings.forceEarliestRatio} immediately`)
    const committed = await compactEarliestRatio(ctx, agent, signal, settings.forceEarliestRatio, mode)
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
  const total = measurement && typeof measurement.totalTokens === 'number'
    ? measurement.totalTokens
    : estimateSessionTokens(session)
  if (total < settings.autoThresholdTokens) {
    ctx.logger.debug(`[force-compact] ${session.id}: total ~${total} tokens < threshold ${settings.autoThresholdTokens} — below gate, letting the request proceed`)
    return false
  }

  // DEAD-LOOP GUARD — BLANK-RESULT SHORT-CIRCUIT. If a PRIOR threshold-gated
  // compaction for this session came back blank/uncommitted and the context has
  // NOT meaningfully grown since, we STOP attempting and let the request proceed
  // as-is. Without this, a blank result shrinks nothing, so EVERY subsequent
  // step re-measures the same total >= threshold, re-compacts, gets another
  // blank, repeats forever — the "hang". Per requirement: a blank outcome means
  // no further automatic action. (An explicit `/force-compact` command above
  // bypasses this guard deliberately — honoring a user's direct request.)
  const cooldownNote = consultCompactCooldown(session.id, total)
  if (cooldownNote !== undefined) {
    ctx.logger.debug(`[force-compact] ${session.id}: threshold reached (~${total} tokens) but AUTO compaction previously came back blank/unchanged and context has not grown past the cooldown mark — SKIPPING compaction, letting the request proceed (note: ${cooldownNote}). Will re-arm once the session grows ~${COOLDOWN_GROWTH_TOLERANCE} tokens past the last blank mark.`)
    return false
  }

  // At or above the threshold: do NOT request the model. Compact the earliest
  // `autoEarliestRatio` of the conversation instead; the loop retries the step
  // against the shrunken context.
  ctx.logger.info(
    `[force-compact] ${session.id}: context ~${total} tokens >= threshold ${settings.autoThresholdTokens}; `
    + `rejecting the model request and compacting the earliest ${settings.autoEarliestRatio}`,
  )
  const committed = await compactEarliestRatio(ctx, agent, signal, settings.autoEarliestRatio, mode)
  if (!committed) {
    // BLANK OUTCOME — record a cooldown HIGH-WATER MARK at this token count so
    // subsequent steps at (roughly) the same total stop hammering. CLEARED
    // automatically once the session genuinely grows (see
    // consultCompactCooldown) or a compaction finally commits (see
    // compactEarliestRatio).
    markCompactCooldown(session.id, total, 'blank/unchanged summary at threshold')
    ctx.logger.debug(`[force-compact] ${session.id}: threshold-gate compaction came back BLANK — recorded a compaction cooldown at ~${total} tokens (auto-gate will pause here until context grows). Letting the request proceed.`)
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
export async function thinkingDisabled(ctx) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  return settings.disableThinking === true
}

/**
 * Coarse token estimate for a session's whole surface content, used only when
 * the `tokenMeter` service is not mounted. Mirrors the character-based
 * heuristic of `engine/checkpoint.js`.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {number}
 */
function estimateSessionTokens(session) {
  const CHARS_PER_TOKEN = 4
  let chars = 0
  for (const event of session.events) {
    let content
    if (event.type === 'user/message') content = event.data.content
    else if (event.type === 'assistant/message') content = event.data.message.content
    else if (event.type === 'tool/result') content = event.data.message !== undefined ? event.data.message.content : undefined
    if (content === undefined) continue
    for (const block of content || []) {
      if (block && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

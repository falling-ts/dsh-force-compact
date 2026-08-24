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

import { readSettings, DEFAULTS } from './settings.js'
import { selectEarliestByTokens } from './region.js'

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
 * @returns {Promise<boolean>} whether a compaction was committed.
 */
async function compactEarliestRatio(ctx, agent, signal, ratio) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = agent.session
  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
    ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable; no compaction performed`)
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
    ctx.logger.debug(`[force-compact] ${session.id}: no earliest ${ratio} token region to compact`)
    return false
  }
  try {
    const result = await compaction.compactRegion(region.start, region.end, agent, signal)
    if (result === undefined || result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: earliest ${ratio} compaction committed nothing`)
      return false
    }
    ctx.logger.info(
      `[force-compact] ${session.id}: earliest ${ratio} compaction shadowed ${result.shadowedSeqs.length} nodes `
      + `(~${result.shadowedTokenCount} tokens)`,
    )
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: earliest ${ratio} compaction failed — ${message}`)
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
 * @returns {Promise<boolean>} `true` when the caller should return `{ kind: 'reject' }`.
 */
export async function forceCompactIfNeeded(ctx, agent, signal) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = agent.session

  // A `/force-compact` command was issued for this agent while it was busy:
  // compact now, regardless of the token threshold — the earliest
  // `forceEarliestRatio` of the conversation.
  if (takeForceCompact(session.id)) {
    ctx.logger.info(`[force-compact] ${session.id}: /force-compact queued; force-compacting the earliest ${settings.forceEarliestRatio} immediately`)
    return await compactEarliestRatio(ctx, agent, signal, settings.forceEarliestRatio)
  }

  // Total context tokens for this session — the authoritative measurement the
  // official `compaction-basic` uses for its pressure gate.
  const meter = ctx.get('tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') return false
  const measurement = meter.measure(session)
  const total = measurement && typeof measurement.totalTokens === 'number'
    ? measurement.totalTokens
    : estimateSessionTokens(session)
  if (total < settings.autoThresholdTokens) return false

  // At or above the threshold: do NOT request the model. Compact the earliest
  // `autoEarliestRatio` of the conversation instead; the loop retries the step
  // against the shrunken context.
  ctx.logger.info(
    `[force-compact] ${session.id}: context ~${total} tokens >= threshold ${settings.autoThresholdTokens}; `
    + `rejecting the model request and compacting the earliest ${settings.autoEarliestRatio}`,
  )
  return await compactEarliestRatio(ctx, agent, signal, settings.autoEarliestRatio)
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
 * heuristic of `compact.js`.
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

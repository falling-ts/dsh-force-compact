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
 *   step (so the model request is NOT made) and instead runs a **forced
 *   compaction** via `ctx.compaction.compactNow`, which condenses the useful
 *   history and lets the loop retry with a smaller context.
 *
 * Both settings are read **per request** through the synchronous
 * `settings.get('force-compact')` so a `settings.yaml` edit is picked up on the
 * next model request without a restart.
 *
 * @module @falling-ts/dsh-force-compact/request-guard
 */

import { readSettings, DEFAULTS } from './settings.js'

/**
 * Force-compact the session before a model request, when the session's total
 * context has reached the configured threshold.
 *
 * Called from the `agent/pre-step` Waterfall. Returns `true` when the step was
 * rejected (a forced compaction ran) and `false` when the guard left the step
 * to proceed (no compaction was needed, or none could be made).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal} signal the current turn's signal (forwarded to compaction).
 * @returns {Promise<boolean>} `true` when the caller should return `{ kind: 'reject' }`.
 */
export async function forceCompactIfNeeded(ctx, agent, signal) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const session = agent.session

  // Total context tokens for this session — the authoritative measurement the
  // official `compaction-basic` uses for its pressure gate.
  const meter = ctx.get('tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') return false
  const measurement = meter.measure(session)
  const total = measurement && typeof measurement.totalTokens === 'number'
    ? measurement.totalTokens
    : estimateSessionTokens(session)
  if (total < settings.autoThresholdTokens) return false

  // At or above the threshold: do NOT request the model. Force a compaction
  // instead; the loop retries the step against the shrunken context.
  ctx.logger.info(
    `[force-compact] ${session.id}: context ~${total} tokens >= threshold ${settings.autoThresholdTokens}; `
    + 'rejecting the model request and forcing a compaction',
  )
  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactNow !== 'function') {
    ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable; letting the request proceed`)
    return false
  }
  try {
    const result = await compaction.compactNow(agent, signal)
    if (result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: forced compaction found no safe range; letting the request proceed`)
      return false
    }
    ctx.logger.info(
      `[force-compact] ${session.id}: forced compaction shadowed ${result.shadowedSeqs.length} nodes `
      + `(~${result.shadowedTokenCount} tokens)`,
    )
    return true
  } catch (error) {
    // A compaction that is already active (a concurrent forced run) or whose
    // range is unbalanced must not block the request: fall through and let it
    // proceed. Cancellation is forwarded through `signal`.
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: forced compaction failed — ${message}; letting the request proceed`)
    return false
  }
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

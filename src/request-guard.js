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
 * `settings.get('falling-ts-force-compact')` so a `settings.yaml` edit is picked up on the
 * next model request without a restart.
 *
 * @module @falling-ts/dsh-force-compact/request-guard
 */

import { readSettings, DEFAULTS } from './settings.js'
import { selectEarliestRatio } from './region.js'
import { compactRegion } from './compact.js'

/**
 * Process-local "force compact now" flags, one per agent (by `agent.id`). Set
 * by the `/force-compact` command handler when the agent is busy, and consumed
 * (and cleared) by the `agent/pre-step` hook at the next model step. This is the
 * "insert a js memory record" the command needs: it survives across the agent's
 * steps within the process without any durable state or timer.
 * @type {Map<string, true>}
 */
const pendingForce = new Map()

/**
 * Queue a forced compaction for one agent (the `/force-compact` command). When
 * the agent is idle the command compacts directly; when it is busy it sets this
 * flag so the next model step force-compacts instead of requesting the model.
 * @param {string} agentId
 */
export function queueForceCompact(agentId) {
  if (agentId !== undefined && agentId !== null) pendingForce.set(agentId, true)
}

/**
 * Consume (and clear) any pending forced-compaction flag for one agent.
 * @param {string} agentId
 * @returns {boolean} whether a force was pending and is now cleared.
 */
export function takeForceCompact(agentId) {
  const pending = pendingForce.get(agentId)
  if (pending) pendingForce.delete(agentId)
  return pending === true
}

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
/**
 * Run a forced compaction for one agent (via `compaction.compactNow`), passing a
 * `reasoningEffort: 'off'` signal when `disableThinking` is set so the
 * compaction's own summarization call also skips thinking. Resolves `true` when a
 * compaction was committed, `false` when none could be made (missing service, no
 * safe range, or a thrown error) — it never throws, so a failed compaction never
 * blocks the caller.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal|undefined} signal the current turn's signal (forwarded to compaction).
 * @returns {Promise<boolean>} whether a compaction was committed.
 */
async function compactAgentNow(ctx, agent, signal) {
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  const disableThinking = settings.disableThinking === true
  const compaction = ctx.get('compaction')
  const session = agent.session
  if (compaction === undefined || typeof compaction.compactNow !== 'function') {
    ctx.logger.warn(`[force-compact] ${session.id}: compaction service unavailable; no compaction performed`)
    return false
  }
  // When the turn's signal is available, wrap it so the compaction's own
  // summarization also skips thinking (the `reasoningEffort` the compaction reads
  // off the signal). Otherwise pass a bare `reasoningEffort`-only signal.
  const compactSignal = signal !== undefined && signal !== null
    ? {
      signal,
      get reasoningEffort() {
        return disableThinking ? 'off' : undefined
      },
    }
    : { reasoningEffort: disableThinking ? 'off' : undefined }
  try {
    const result = await compaction.compactNow(agent, compactSignal)
    if (result === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: forced compaction found no safe range`)
      return false
    }
    ctx.logger.info(
      `[force-compact] ${session.id}: forced compaction shadowed ${result.shadowedSeqs.length} nodes `
      + `(~${result.shadowedTokenCount} tokens)`,
    )
    return true
  } catch (error) {
    // A compaction that is already active (a concurrent forced run) or whose
    // range is unbalanced must not block the caller: resolve `false` and let the
    // step proceed. Cancellation is forwarded through `signal`.
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: forced compaction failed — ${message}`)
    return false
  }
}

/**
 * Compact the **earliest** `ratio` fraction of a session's surface history via
 * `compactRegion` (the "earliest conversation ratio" knob). Selects the head-
 * anchored span with `selectEarliestRatio` and delegates the durable mutation to
 * `ctx.compaction.compactRegion(start, end, agent, signal)`, forwarding the
 * signal (and `reasoningEffort: 'off'` when `disableThinking` is set). Resolves
 * `true` when a compaction was committed, `false` otherwise (missing service, no
 * compactable span, or a thrown error) — it never throws.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal|undefined} signal the current turn's signal (forwarded to compaction).
 * @param {number} ratio a fraction in (0, 1] of the surface history to compact from the head.
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
  const region = selectEarliestRatio(session, ratio)
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no earliest ${ratio} region to compact`)
    return false
  }
  const disableThinking = settings.disableThinking === true
  const compactSignal = signal !== undefined && signal !== null
    ? {
      signal,
      get reasoningEffort() {
        return disableThinking ? 'off' : undefined
      },
    }
    : { reasoningEffort: disableThinking ? 'off' : undefined }
  try {
    const result = await compaction.compactRegion(region.start, region.end, agent, compactSignal)
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

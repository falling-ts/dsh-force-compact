/**
 * dsh-force-compact's compaction orchestrator. Selects a region with its own
 * policy, runs its own LLM summarizer as a pre-commit preview + shrink gate,
 * then delegates the durable surface mutation to `ctx.compaction.compactRegion`
 * — which is the authoritative summarizer and commits the summary node.
 *
 * @module @falling-ts/dsh-force-compact/compact
 */

import { resolveConfig } from './config.js'
import { selectRegion } from './region.js'
import { summarize } from './summarizer.js'

/** Characters per token, mirroring the official token meter's coarse estimate. */
const CHARS_PER_TOKEN = 4

/**
 * Compact a session's useful history at a durability checkpoint.
 *
 * Flow: select the region with the plugin's own policy → project the region's
 * messages → run the plugin's own LLM summarizer as a pre-commit preview +
 * shrink gate → delegate the durable surface mutation to
 * `ctx.compaction.compactRegion` (the authoritative summarizer).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortController} controller
 * @returns {Promise<object | null>} the compaction result, or `null` when nothing was worth compacting.
 */
export async function compactSession(ctx, agent, controller) {
  const session = agent.session
  const config = resolveConfig()
  const region = selectRegion(session, config)
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no compactable region; skipping`)
    return null
  }

  const messages = projectRegionMessages(session, region.start, region.end)
  if (messages.length === 0) {
    ctx.logger.debug(`[force-compact] ${session.id}: region has no surface messages; skipping`)
    return null
  }

  // Pre-commit preview + shrink gate: run the plugin's own LLM summarizer and
  // skip when the preview is not a genuine shrink. The durable mutation is
  // delegated to `compactRegion`, which is the authoritative summarizer.
  const preview = await summarize(ctx, config, agent, messages, controller.signal)
  if (preview === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no summarization target; skipping`)
    return null
  }
  const shadowedTokens = estimateTokens(messages)
  const summaryTokens = estimateBlocks(preview.summary)
  if (summaryTokens >= shadowedTokens) {
    ctx.logger.debug(`[force-compact] ${session.id}: preview ~${summaryTokens} tokens not smaller than shadowed ~${shadowedTokens}; skipping`)
    return null
  }

  const result = await ctx.compaction.compactRegion(region.start, region.end, agent, controller.signal)
  ctx.logger.info(
    `[force-compact] ${session.id}: shadowed ${result.shadowedSeqs.length} nodes `
    + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
  )
  return result
}

/** Coarse token estimate for a set of content blocks. */
function estimateBlocks(blocks) {
  let chars = 0
  for (const block of blocks || []) {
    if (block && typeof block.text === 'string') chars += block.text.length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Project the region's surface events to LLM messages. A simplified projection
 * sufficient for the shrink gate; the authoritative replay happens inside
 * `compactRegion`.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} start
 * @param {number} end
 * @returns {Array<{role: string, content: Array, source?: object}>}
 */
function projectRegionMessages(session, start, end) {
  const messages = []
  for (const event of session.events) {
    if (event.seq < start || event.seq > end) continue
    if (event.type === 'user/message') {
      messages.push({ role: 'user', content: event.data.content, source: event.data.source })
    } else if (event.type === 'assistant/message') {
      messages.push({ role: 'assistant', content: event.data.message.content })
    } else if (event.type === 'tool/result') {
      const message = event.data.message
      if (message !== undefined) messages.push({ role: 'user', content: message.content, source: message.source })
    }
  }
  return messages
}

/**
 * Coarse token estimate for a set of messages, mirroring the token meter's
 * character-based heuristic.
 * @param {Array<{content: Array}>} messages
 * @returns {number}
 */
function estimateTokens(messages) {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

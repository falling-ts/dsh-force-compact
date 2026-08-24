/**
 * dsh-force-compact's own one-shot summarization, modeled on the official
 * `compaction-basic` summarizer. Builds a compaction directive as the final user
 * message after the replayed region (so the provider's KV cache is reused),
 * streams it through `ctx.llm`, and returns the condensed checkpoint.
 *
 * This is a pre-commit preview + shrink gate: the durable surface mutation is
 * delegated to `ctx.compaction.compactRegion`, which is the authoritative
 * summarizer. See `compact.js` for the orchestration.
 *
 * @module @falling-ts/dsh-force-compact/summarizer
 */

/** The compaction directive appended as the final user message. */
export const COMPACTION_INSTRUCTION = [
  'You are a compaction engine for this AI coding assistant. Condense the conversation above into a terse structured checkpoint so another model can resume with no loss of essential context.',
  '',
  'Output EXACTLY these sections, in order, as terse bullets (write "(none)" for an empty section):',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  'Preserve exact file paths, commands, identifiers, and error strings. Do NOT mention this summarization request. Output only the checkpoint text.',
].join('\n')

/**
 * Run the one-shot summarization over a replayed message history.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Readonly<object>} config
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {import('@deepseek-ai/dsh-llm').Message[]} messages the replayed region messages (without the directive).
 * @param {AbortSignal} signal
 * @returns {Promise<{summary: Array, provider: string, model: string, maxTokens?: number} | null>} the condensed checkpoint, or `null` when no target can be resolved or the stream yields no text.
 */
export async function summarize(ctx, config, agent, messages, signal) {
  const target = resolveTarget(agent)
  if (target === undefined) return null

  const request = [
    ...messages,
    { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }], source: { kind: 'plugin', plugin: 'force-compact' } },
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages: request,
    maxTokens: config.maxSummaryTokens,
    signal,
  }
  if (agent.session !== undefined) options.sessionId = agent.session.id
  const purpose = agent.options && agent.options.purpose
  if (typeof purpose === 'string' && purpose.length > 0) options.purpose = purpose

  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return null

  const text = await collectText(llm.stream(options), signal)
  if (text === null || text.length === 0) return null
  return {
    summary: [{ type: 'text', text }],
    provider: target.provider,
    model: target.model,
    maxTokens: config.maxSummaryTokens,
  }
}

/**
 * Resolve the provider/model for the summarization call: the session's latest
 * durable routed request first, then the Agent's configured target.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{provider: string, model: string} | undefined}
 */
function resolveTarget(agent) {
  const session = agent.session
  if (session !== undefined && typeof session.requestHeader === 'function') {
    const header = session.requestHeader()
    const config = header && header.config
    if (config !== undefined && typeof config.provider === 'string' && config.provider.length > 0
      && typeof config.model === 'string' && config.model.length > 0) {
      return { provider: config.provider, model: config.model }
    }
  }
  const opts = agent.options || {}
  if (typeof opts.provider === 'string' && opts.provider.length > 0
    && typeof opts.model === 'string' && opts.model.length > 0) {
    return { provider: opts.provider, model: opts.model }
  }
  return undefined
}

/**
 * Stream one completion and accumulate its text.
 * @param {AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>} stream
 * @param {AbortSignal} signal
 * @returns {Promise<string | null>}
 */
async function collectText(stream, signal) {
  let text = ''
  for await (const chunk of stream) {
    if (signal !== undefined) signal.throwIfAborted()
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    }
  }
  return text
}

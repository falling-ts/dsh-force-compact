/**
 * dsh-force-compact's own one-shot summarization, modeled on the official
 * `compaction-basic` summarizer. Builds a compaction directive as the final user
 * message after the replayed region (so the provider's KV cache is reused),
 * streams it through `ctx.llm`, and returns the condensed checkpoint.
 *
 * This is a pre-commit preview + shrink gate: the durable surface mutation is
 * delegated to the `compaction` service's `compactRegion` (read live via
 * `ctx.get('compaction')`), which is the authoritative summarizer. See
 * `engine/checkpoint.js` for the orchestration.
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
 * @param {{ reasoningEffort?: 'off' | 'low' | 'high' | 'max', maxTokens?: number }} [extra] optional generation overrides. `reasoningEffort` maps to the LLM adapter's thinking toggle; `maxTokens` OVERRIDES the `config.maxSummaryTokens` base value when present (this lets callers like `builtin-engine.js` route through the `settings.maxSummaryTokens` runtime knob without requiring the static `config` constant to change).
 * @returns {Promise<{summary: Array, provider: string, model: string, maxTokens?: number} | null>} the condensed checkpoint, or `null` when no target can be resolved or the stream yields no text.
 */
export async function summarize(ctx, config, agent, messages, signal, extra) {
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
  // The force-compact "disable thinking" setting maps to a per-request
  // `reasoningEffort: 'off'`, which the adapter turns into
  // `thinking: { type: 'disabled' }` (provider thinking off for the call).
  if (extra !== undefined && typeof extra.reasoningEffort === 'string') {
    options.reasoningEffort = extra.reasoningEffort
  }
  // Callers may override the static `config.maxSummaryTokens` via the
  // `extra.maxTokens` knob (e.g., to honor the `settings.maxSummaryTokens`
  // runtime setting without changing the compile-time default). Only apply
  // when the caller supplied a positive numeric override — otherwise keep the
  // static `config` value.
  if (extra !== undefined && Number.isFinite(extra.maxTokens) && extra.maxTokens > 0) {
    options.maxTokens = extra.maxTokens
  }
  if (agent.session !== undefined) options.sessionId = agent.session.id
  // This one-shot call IS the compaction preview: tag it with the closed-union
  // `purpose` the LLM service understands (adapters may map it to
  // purpose-specific generation policy). The agent's free-form purpose string
  // is NOT a valid `GenerateOptions.purpose` value.
  options.purpose = 'compaction'

  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return null

  const text = await collectText(llm.stream(options), signal)
  if (text === null || text.length === 0) return null
  return {
    summary: [{ type: 'text', text }],
    provider: target.provider,
    model: target.model,
    // Reflect the ACTUAL maxTokens used on the request (override-aware), so
    // callers can report what the summarization was really capped at.
    maxTokens: options.maxTokens,
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

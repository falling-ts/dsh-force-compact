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

/** Tags wrapping the structured summary inside the landed checkpoint node. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The compaction directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
/**
 * @typedef {{ system?: string, tools?: ReadonlyArray<object>, messages: Array<object> }} SummarizationInput
 *   Replayed prefix for the summarization call. `system` and `tools` come from
 *   the session's latest request header (prefix-cache alignment); `messages` is
 *   the shadowed region in surface order.
 */

/**
 * @typedef {{ provider: string, model: string }|undefined} Target
 */

/**
 * Run the cache-reusing `ctx.llm.stream()` summarization call.
 *
 * Aligned with the official `compaction-basic` summarizer (single-source-of-
 * truth pattern):
 *  1. target resolution order: **configured** (`config.summarizationProvider` /
 *     `config.summarizationModel`, optional) → **latest routed header**
 *     (`agent.session.requestHeader().config`) → **agent.options**
 *     (`provider` / `model`). The first candidate with BOTH fields wins.
 *  2. The replayed prefix (system + tools from the request header, plus the
 *     shadowed-region messages) is passed VERBATIM so the auxiliary call is a
 *     genuine prefix of the last routed request — the provider's warm KV
 *     cache is reused instead of invalidated. The compaction instruction is
 *     then the only novel input.
 *  3. `purpose: 'compaction'` tags the call for adapter-side routing policy.
 *  4. All chunk kinds are accumulated; a terminal `finish` of `error` /
 *     `aborted` / `max-tokens` throws a typed error (caller closes the
 *     transaction via `closeWithError`); image output is refused (image
 *     content can never safely become a checkpoint).
 *  5. Usage is surfaced when the provider reports it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Readonly<object>} config backend config (may carry `maxSummaryTokens`
 *   and the optional `summarizationProvider` / `summarizationModel` override pair)
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent provides the session
 *   (routed-header lookup) and fallback target.
 * @param {SummarizationInput} input replayed prefix + region messages.
 * @param {AbortSignal} [signal]
 * @param {{ reasoningEffort?: 'off' | 'low' | 'high' | 'max', maxTokens?: number }} [extra]
 *   optional generation overrides: `reasoningEffort` maps to the LLM
 *   adapter's thinking toggle; `maxTokens` OVERRIDES the `config.maxSummaryTokens`
 *   base value when present (callers route through the `settings.maxSummaryTokens`
 *   runtime knob without changing the static default).
 * @returns {Promise<{ summary: Array, provider: string, model: string, maxTokens?: number, usage?: object }|null>}
 *   the condensed checkpoint (text-only blocks), the actual call envelope, and
 *   the provider-reported usage when available. Returns `null` ONLY when no
 *   target can be resolved (the call is never made). All other failures
 *   THROW (typed errors) so callers can classify them via `closeWithError`.
 *
 *   NOTE: a prior version returned `null` for every failure (empty target AND
 *   empty text alike); callers had no way to distinguish. Now: null = "never
 *   called" (missing target OR missing `ctx.llm`), throw = "called, failed".
 */
export async function summarize(ctx, config, agent, input, signal, extra) {
  const target = resolveTarget(config, agent)
  if (target === undefined) return null

  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return null

  // Backwards-compatible call signature: a bare `messages` array (the old
  // 4-arg form) is treated as an input with no system/tools prefix. New
  // callers pass `{ messages, system?, tools? }`.
  const normalized = Array.isArray(input) ? { messages: input } : input
  const regionMessages = normalized.messages || []

  const request = [
    ...regionMessages,
    { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }], source: { kind: 'plugin', plugin: 'force-compact' } },
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages: request,
    maxTokens: config.maxSummaryTokens,
  }
  // Prefix-cache alignment: feed the conversation's own system prompt and tool
  // schemas into the auxiliary call so the provider's warm KV cache for the
  // last routed request is REUSED rather than invalidated. Absent headers
  // (system-less session or a tool-free request) omit the field entirely.
  if (normalized.system !== undefined && typeof normalized.system === 'string' && normalized.system.length > 0) {
    options.system = normalized.system
  }
  if (Array.isArray(normalized.tools) && normalized.tools.length > 0) {
    options.tools = [...normalized.tools]
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
  if (signal !== undefined) options.signal = signal
  const session = agent.session
  if (session !== undefined && session !== null && typeof session.id === 'string') {
    options.sessionId = session.id
  }
  // This one-shot call IS the compaction: tag it with the closed-union
  // `purpose` the LLM service understands (adapters may map it to
  // purpose-specific generation policy). The agent's free-form purpose string
  // is NOT a valid `GenerateOptions.purpose` value.
  options.purpose = 'compaction'

  // Assemble ALL chunk kinds (text + reasoning + images). Reasoning deltas are
  // dropped later by `extractTextOnly`; a terminal finish decides whether the
  // call succeeded. Accumulating the full stream mirrors the official
  // `compaction-basic` `BlockAssembler` shape — the difference is that this
  // plugin does not depend on `@deepseek-ai/dsh-llm` symbols (it ships as
  // plain JS outside the DSH workspace), so the assembly logic is inlined here
  // against the documented `StreamChunk` shape.
  const collected = await collectChunks(llm.stream(options), signal)

  // Terminal finish classification (fail-closed, mirroring the official
  // summarizer's `finishError`). `complete`/`length` are treated per spec:
  // a `length` finish WITHOUT text is an error (truncation), WITH text is a
  // partial-but-valid summary (accepted); `abort` throws.
  const finish = collected.finish
  if (finish === undefined) {
    // Stream terminated without a terminal chunk — treat as aborted/malformed.
    throw new TypeError('summarization stream ended without a terminal finish chunk')
  }
  const finishKind = finish.kind
  if (finishKind === 'error') {
    const err = new Error('summarization provider failure: ' + (failureText(finish.failure) || 'unknown provider error'))
    err.code = 'PROVIDER_ERROR'
    throw err
  }
  if (finishKind === 'aborted' || finishKind === 'abort') {
    const err = new Error('summarization aborted during generation')
    err.code = 'ABORTED'
    throw err
  }
  if (finishKind === 'max-tokens' || finishKind === 'length') {
    const textLen = measuredLength(collected.text)
    if (textLen === 0) {
      const err = new Error('summarization truncated at the token cap with no output')
      err.code = 'MAX_TOKENS_EMPTY'
      throw err
    }
    // Truncated but non-empty: accept as a partial summary. The downstream
    // shrink gate will decide whether it is useful; if it balloons beyond
    // the shadowed span the transaction is aborted there anyway.
  }

  const extracted = extractTextOnly(collected.blocks)
  if (collected.hasImage) {
    // Image output can never safely become a checkpoint user-message. Refuse
    // loudly so the caller can close the transaction via closeWithError.
    const err = new Error('summarization output contained image content — refusing to land as a checkpoint')
    err.code = 'UNSUPPORTED_CONTENT'
    throw err
  }
  if (extracted.length === 0 || extracted.every(b => !(typeof b.text === 'string' && b.text.trim().length > 0))) {
    throw new Error('summarization produced no usable text')
  }

  const result = {
    summary: extracted,
    provider: target.provider,
    model: target.model,
    maxTokens: options.maxTokens,
  }
  // Surface provider-reported usage when the adapter carried it; callers can
  // record it alongside `fc-compact/summary` for observability.
  if (collected.usage !== undefined) result.usage = collected.usage
  return result
}

/**
 * Resolve the provider/model for the summarization call, in priority order
 * (mirroring the official summarizer's three-tier target resolution):
 *
 *   1. CONFIGURED target: `config.summarizationProvider` /
 *      `config.summarizationModel` — an operator-declared override (both
 *      fields must be non-empty strings to count as a target).
 *   2. Latest ROUTED HEADER: `agent.session.requestHeader().config` — the
 *      session's most recent routed request; the model the conversation is
 *      actually running on.
 *   3. AGENT OPTIONS: `agent.options.provider` / `agent.options.model` —
 *      the Agent's configured fallback.
 *
 * @param {Readonly<object>} config
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {Target}
 */
function resolveTarget(config, agent) {
  const cfgProvider = typeof config.summarizationProvider === 'string' ? config.summarizationProvider : ''
  const cfgModel = typeof config.summarizationModel === 'string' ? config.summarizationModel : ''
  if (cfgProvider.length > 0 && cfgModel.length > 0) {
    return { provider: cfgProvider, model: cfgModel }
  }
  const session = agent.session
  if (session !== undefined && typeof session.requestHeader === 'function') {
    try {
      const header = session.requestHeader()
      const hconfig = header && header.config
      if (hconfig !== undefined
          && typeof hconfig.provider === 'string' && hconfig.provider.length > 0
          && typeof hconfig.model === 'string' && hconfig.model.length > 0) {
        return { provider: hconfig.provider, model: hconfig.model }
      }
    } catch {
      // requestHeader is best-effort: a malformed header folds to undefined;
      // fall through to the agent-options fallback below.
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
 * Read the session's latest request header and project the prefix-cache
 * alignment fields (`system` prompt + `tools` schemas) out of it. Used by
 * callers that want to reproduce the last routed request's verbatim prefix so
 * the auxiliary summarization call hits the provider's warm KV cache.
 *
 * NEVER throws: any receiver shape (including a header whose `config` is
 * absent) degrades gracefully to `{ system: undefined, tools: undefined }`.
 *
 * @param {import('@deepseek-ai/dsh-agent').Session|undefined} session
 * @returns {{ system?: string, tools?: object[] }}
 */
export function headerPrefix(session) {
  const result = {}
  if (session === undefined || session === null || typeof session.requestHeader !== 'function') return result
  let header
  try {
    header = session.requestHeader()
  } catch {
    return result
  }
  if (header === undefined || header === null) return result
  if (typeof header.system === 'string' && header.system.length > 0) result.system = header.system
  if (Array.isArray(header.tools) && header.tools.length > 0) result.tools = [...header.tools]
  return result
}

/**
 * Collect EVERY chunk kind from the stream into a small accumulator that
 * mimics the official `BlockAssembler`: ordered content blocks, a boolean
 * `hasImage` flag, the terminal `finish` fact, and the provider-reported
 * `usage` (when the adapter carried it).
 *
 * Inline against the documented `StreamChunk` shape — this plugin ships as
 * plain JS outside the DSH workspace and must not import `@deepseek-ai/dsh-llm`
 * symbols (they are not resolvable at plugin load time).
 *
 * @param {AsyncIterable<object>} stream
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ blocks: Array, text: string, hasImage: boolean, finish: object|undefined, usage: object|undefined, finishReason: string|undefined }> }
 */
async function collectChunks(stream, signal) {
  const blocks = []
  let text = ''
  let hasImage = false
  let finish
  let usage
  let finishReason
  let curReasoning = null
  let curToolCall = null

  const flushPending = () => {
    if (curReasoning !== null) {
      blocks.push(curReasoning)
      curReasoning = null
    }
    if (curToolCall !== null) {
      blocks.push(curToolCall)
      curToolCall = null
    }
  }

  for await (const chunk of stream) {
    if (signal !== undefined && signal.aborted) break
    switch (chunk.type) {
      case 'text-delta':
        flushPending()
        if (typeof chunk.text === 'string') {
          blocks.push({ type: 'text', text: chunk.text })
          text += chunk.text
        }
        break
      case 'reasoning-delta':
        if (curReasoning === null) curReasoning = { type: 'reasoning', text: '' }
        if (typeof chunk.text === 'string') curReasoning.text += chunk.text
        break
      case 'reasoning-chunks':
        flushPending()
        if (Array.isArray(chunk.chunks)) {
          for (const c of chunk.chunks) {
            if (typeof c === 'string') {
              blocks.push({ type: 'reasoning', text: c })
            } else if (c && typeof c.text === 'string') {
              blocks.push({ type: 'reasoning', text: c.text })
            }
          }
        }
        break
      case 'tool-call-start':
        flushPending()
        curToolCall = {
          type: 'tool-call',
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          arguments: '',
        }
        break
      case 'tool-call-delta':
        if (curToolCall === null) curToolCall = { type: 'tool-call', toolCallId: chunk.toolCallId, name: chunk.name || '', arguments: '' }
        if (typeof chunk.argumentsDelta === 'string') curToolCall.arguments += chunk.argumentsDelta
        break
      case 'image':
        flushPending()
        hasImage = true
        blocks.push({ type: 'image', mediaType: chunk.mediaType, url: chunk.url })
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finishReason = chunk.finishReason
        finish = {
          kind: chunk.kind || (finishReason === 'max_tokens' ? 'max-tokens' : finishReason),
          reason: chunk.finishReason,
          ...(chunk.failure !== undefined ? { failure: chunk.failure } : {}),
        }
        break
      default:
        break
    }
  }
  flushPending()
  return { blocks, text, hasImage, finish, usage, finishReason }
}

/**
 * Filter the assembled content blocks down to TEXT ONLY and refuse anything
 * that is structurally unsafe to land as a checkpoint (images). Reasoning
 * blocks are dropped intentionally: they are collapsible UI regions, never
 * durable checkpoint content.
 * @param {Array} blocks
 * @returns {Array<{type:'text', text:string}>}
 */
function extractTextOnly(blocks) {
  return (blocks || []).filter(b => b && b.type === 'text' && typeof b.text === 'string')
}

/** Coerce a provider failure fact to a short human-readable message. */
function failureText(failure) {
  if (failure === undefined || failure === null) return ''
  if (typeof failure === 'string') return failure
  return failure.message || failure.description || ''
}

/** Length of the concatenated text blocks (0 when none). */
function measuredLength(text) {
  return typeof text === 'string' ? text.length : 0
}

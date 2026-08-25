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

import { guardFn } from '../core/crashnet.js'

/** Tag opening the structured summary block inside a landed checkpoint node.
 *  (The matching close tag is the symmetric `</compacted-summary>`; it is kept
 *  as a literal where emitted rather than a second constant, since the open tag
 *  is the sole anchor referenced elsewhere — by the prior-checkpoint rule in
 *  `COMPACTION_INSTRUCTION`.) */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'

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
 * @returns {Promise<object>} NEVER rejects. A discriminated result object the
 *   caller branches on by `status`:
 *   • `{ status: 'ok', summary, provider, model, maxTokens?, usage? }` —
 *     `summary` is the condensed text-only checkpoint blocks.
 *   • `{ status: 'no-target' }` / `{ status: 'no-llm' }` — the call was never
 *     made; caller silently skips (nothing to cool down).
 *   • `{ status: '<failure>', reason: string }` — the call was made but no
 *     usable summary resulted. Failure labels: `not-iterable`, `no-finish`,
 *     `provider-error`, `aborted`, `truncated-empty`, `image-content`,
 *     `empty-text`. Caller arms the per-session cooldown and closes the
 *     transaction with `error`.
 *   No throw path exists: a malformed chunk/finish/object degrades to a
 *   labeled failure, so a bad provider response can never surface a TypeError
 *   nor trap the idle path in an uncaught-exception retry loop.
 */
// Internal body of `summarize` — routed through the crash-net wrapper. The
// documented contract is "NEVER THROWS", but a genuinely novel throw shape
// (e.g. a `JSON.stringify` on a cycle, an exotic iterator) escapes into the
// crash net, leaving a durable trace and propagating the original value
// unchanged (existing callers keep their semantics).
async function __summarizeBody(ctx, config, agent, input, signal, extra) {
  // NEVER THROWS. Always resolves to a structured result the caller branches on
  // by `status`:
  //   { status: 'ok',        summary[], provider, model, maxTokens?, usage? }
  //   { status: 'no-target' }            — no resolvable provider/model (call never made)
  //   { status: 'no-llm' }               — ctx has no `llm.stream` service (call never made)
  //   { status: '<failure>', reason: string } — the call was MADE but produced no usable
  //                                              summary. Failures:
  //     'not-iterable' (returned stream not an async iterable),
  //     'no-finish' (stream consumed but delivered no terminal finish chunk),
  //     'provider-error' (terminal finish kind:'error'),
  //     'aborted' (terminal finish kind:'aborted'),
  //     'truncated-empty' (kind:'max-tokens' with no text),
  //     'image-content' (image blocks present — unsafe as a checkpoint),
  //     'empty-text' (terminated successfully but emitted no text).
  // The caller (builtin.js runTransaction) maps 'ok' → commit; 'no-target'/
  // 'no-llm' → silent skip (nothing to cool down); any other status → arm the
  // per-session failure cooldown + close the transaction with `error`. No throw
  // path exists, so a malformed chunk/finish/object can never propagate a
  // TypeError and the idle path can never loop on an uncaught exception.
  const target = resolveTarget(config, agent)
  if (target === undefined) return { status: 'no-target' }

  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return { status: 'no-llm' }

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
  // Bind the stream ONCE (rather than inline in the collectChunks call) so the
  // missing-finish diagnostic below can describe the ACTUAL object we were given
  // — distinguishing "not async-iterable (swapped by a waterfall listener)" from
  // "iterated cleanly but never delivered a finish chunk".
  const stream = llm.stream(options)
  // `collectChunks` performs the up-front async-iterability assertion and, if the
  // returned value is NOT a real async iterable (a `llm/stream` waterfall
  // listener swapped it for a Promise/plain object), it RESOLVES to
  // `{ _rejected: true, _rejectReason, ... }` rather than throwing. Any other
  // shape is treated as a degenerate collection (zero chunks, no finish) below.
  // We therefore wrap in try/catch as belt-and-braces: even a stray iteration
  // error degrades to a labeled failure instead of escaping `summarize`.
  let collected
  try {
    collected = await collectChunks(stream, signal)
  } catch (err) {
    // `for await` threw mid-iteration (generator fault, network reset, a
    // poisoned composed stream, …). Record it and fall through to the shared
    // failure handling — never let it escape this function.
    collected = {
      blocks: [], text: '', hasImage: false, finish: undefined, usage: undefined,
      _chunkCount: 0, _rejected: true,
      _rejectReason: (err && err.message) ? err.message : String(err),
    }
  }
  if (!collected || typeof collected !== 'object') {
    collected = { blocks: [], text: '', hasImage: false, finish: undefined, usage: undefined, _chunkCount: 0, _rejected: true, _rejectReason: 'collectChunks returned a non-object' }
  }
  if (collected._rejected) {
    // The stream value was not a usable async iterable (see collectChunks).
    return { status: 'not-iterable', reason: 'llm.stream() did not return an async iterable: ' + (collected._rejectReason || describeStream(stream)) }
  }

  // ---- Defensive read of the terminal `finish` ---------------------------
  // We do NOT trust that `finish` is a well-formed object. Every property is
  // read behind an explicit validity guard; any anomaly degrades to a labeled
  // failure instead of throwing.
  const finish = collected.finish
  const finishIsObject = finish !== null && typeof finish === 'object'
  const finishKind = finishIsObject ? (typeof finish.kind === 'string' ? finish.kind : undefined) : undefined

  // No terminal finish chunk (or the chunk carried no recognizable `kind`):
  // the stream stopped without telling us it completed. Report the observed
  // facts and give up — never assume success.
  if (finish === undefined) {
    const n = (typeof collected._chunkCount === 'number') ? collected._chunkCount : '?'
    return {
      status: 'no-finish',
      reason: `stream ended without a terminal finish chunk (collected ${n} chunks; stream was ${describeStream(stream)})`,
    }
  }
  if (!finishIsObject || finishKind === undefined) {
    // A `finish` chunk was seen but its payload was not the expected
    // `FinishReason` object (e.g. `chunk.reason` was undefined/null or a
    // primitive). Treat as an incomplete termination.
    return {
      status: 'no-finish',
      reason: `terminal finish chunk lacked a valid kind (finish rendered as ${renderFinish(finish)})`,
    }
  }

  // Official `FinishReason.kind` closed union (upstream types.ts):
  //   'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'.
  if (finishKind === 'error') {
    // TEMPORARY CRASH-HARNESS PROBE: the recurring terminal failure
    // `provider failure: Cannot read properties of undefined (reading 'kind')`
    // (code UNKNOWN) tells us SOMEWHERE inside the composed stream chain a
    // harness/middleware reader dereferenced `undefined.kind`. To finally root-
    // cause it, dump EVERYTHING observable about the failure fact on the single
    // branch where such a crash lands. Self-limiting: writes at most one line
    // per errored call, logging never propagates, removable once root-caused.
    try {
      const f = readProp(finish, 'failure')
      const stackTop = (() => {
        const st = f && typeof f.stack === 'string' ? f.stack : (new Error('probe-no-stack-on-failure')).stack
        // Keep the frames INSIDE the harness/adapter (skip this probe's own
        // frames): drop lines mentioning this file, keep the rest, max 6.
        const frames = st.split('\n').filter(line => !line.includes('summarizer.js'))
        return frames.slice(0, 6).map(line => line.trim()).join(' <- ')
      })()
      const causeChain = []
      let cursor = f && f.cause
      for (let depth = 0; depth < 4 && cursor !== undefined && cursor !== null; depth++) {
        causeChain.push(typeof cursor === 'object'
          ? { ctor: (cursor.constructor && cursor.constructor.name) || '?', message: cursor.message, name: cursor.name, code: cursor.code }
          : { primitive: cursor })
        cursor = (typeof cursor === 'object') ? cursor.cause : undefined
      }
      const failJson = (() => {
        try { return JSON.stringify({ kind: finish.kind, msg: f && f.message, code: f && f.code }).slice(0, 400) } catch { return '<unserializable>' }
      })()
      console.log(`[force-compact] CRASH-HARNESS: failureFact=${JSON.stringify(f && typeof f === 'object' ? { ctor: f.constructor && f.constructor.name, protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(f)).slice(0, 12), ownKeys: Object.keys(f).slice(0, 12) } : f, (k, v) => (k === 'stack' ? '<omitted>' : v)) } `
        + `failJson=${failJson} causeChain=${JSON.stringify(causeChain).slice(0, 600)} `
        + `stackInsideHarness=[${stackTop}] optionsShape={provider:${options.provider},model:${options.model},msgs:${options.messages.length},tools:${options.tools !== undefined ? options.tools.length : 'absent'},system:${typeof options.system},purpose:${options.purpose},effort:${options.reasoningEffort}}`)
    } catch { /* the probe itself must never mask the original outcome */ }
    return { status: 'provider-error', reason: 'provider failure: ' + (failureText(readProp(finish, 'failure')) || 'unknown provider error') }
  }
  if (finishKind === 'aborted') {
    return { status: 'aborted', reason: 'aborted during generation: ' + (failureText(readProp(finish, 'failure')) || '(caller abort)') }
  }
  if (finishKind === 'max-tokens') {
    // Truncation at the token cap. Empty → useless (report); non-empty → a
    // partial summary we ACCEPT, letting the downstream shrink gate arbitrate.
    if (measuredLength(safeText(collected.text)) === 0) {
      return { status: 'truncated-empty', reason: 'truncated at the token cap with no output' }
    }
    // fall through to extraction (partial accept)
  }
  // `stop` / `tool-calls` / any unrecognized kind are treated as a normal
  // termination — fall through to extracting whatever text was produced. An
  // unrecognized `kind` is NOT fatal: we still surface any text and let the
  // shrink gate decide usefulness.

  // ---- Text extraction --------------------------------------------------
  // `collected.blocks` is expected to be an array; a missing/non-array value
  // simply yields an empty extraction (handled by the empty-text branch).
  const extracted = extractTextOnly(Array.isArray(collected.blocks) ? collected.blocks : [])

  // Image output can never safely become a checkpoint user-message.
  if (collected.hasImage === true) {
    return { status: 'image-content', reason: 'output contained image content — refusing to land as a checkpoint' }
  }

  const usableText = extracted.some(b => b != null && typeof b === 'object' && typeof b.text === 'string' && b.text.trim().length > 0)
  if (!usableText) {
    return { status: 'empty-text', reason: 'produced no usable text' }
  }

  const result = {
    status: 'ok',
    summary: extracted,
    provider: target.provider,
    model: target.model,
    maxTokens: options.maxTokens,
  }
  // Surface provider-reported usage when the adapter carried it; callers can
  // record it alongside `compaction/summary` for observability.
  const usage = collected.usage
  if (usage !== undefined && usage !== null) result.usage = usage
  return result
}

/**
 * Read a single property defensively. Never throws regardless of `obj` shape.
 * Returns `undefined` for non-objects or missing/invalid values. Used wherever
 * we read into a structure we do not control (chunk payloads, finish reasons).
 * @param {*} obj
 * @param {string} key
 * @returns {*}
 */
function readProp(obj, key) {
  try {
    if (obj === null || typeof obj !== 'object') return undefined
    return obj[key]
  } catch {
    return undefined
  }
}

/** Coerce a possibly-missing text field to a safe string for measurement. */
function safeText(value) {
  return typeof value === 'string' ? value : ''
}

/** Render a possibly-malformed `finish` value for diagnostics without throwing. */
function renderFinish(finish) {
  try {
    if (finish === undefined) return 'undefined'
    if (finish === null) return 'null'
    if (typeof finish !== 'object') return typeof finish
    const k = typeof finish.kind === 'string' ? `kind='${finish.kind}'` : 'kind=<missing>'
    return `an object (${k})`
  } catch {
    return '<undescribable>'
  }
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

/** Public entry — wrapped by the universal crash net. */
export const summarize = guardFn('summarizer.summarize', __summarizeBody)

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
 * `finish` is stored AS-IS as the raw `FinishReason` object (`{ kind,
 * failure? }`) — the same thing the official `BlockAssembler` retains — so the
 * caller switches on `finish.kind` and reads `finish.failure` per protocol.
 *
 * @param {AsyncIterable<object>} stream
 * @param {AbortSignal} [signal]
 * @param {{recordOnEmpty?: boolean}} [opts]
 * @returns {Promise<{ blocks: Array, text: string, hasImage: boolean, finish: object|undefined, usage: object|undefined }> }
 */
async function collectChunks(stream, signal, opts) {
  // UP-FRONT ITERABILITY CHECK: `ctx.llm.stream()` is contractually an
  // `AsyncIterable<StreamChunk>` (direct `for await`, no outer await /
  // `.values()`). But `llm.stream` COMPOSES every `llm/stream` waterfall
  // listener, and a listener that `return`s a Promise or a plain (non-
  // async-iterable) object poisons the composition — turning the stream into
  // exactly the unstable "sometimes throws not-async-iterable, sometimes
  // yields nothing" we observed. Detect it HERE with a precise, actionable
  // message naming the offending constructor, instead of letting a confusing
  // `yield* (intermediate value)…` TypeError leak out later.
  const asyncIterFn = (stream && typeof stream === 'object')
    ? (stream[Symbol.asyncIterator]?.bind(stream))
    : undefined
  if (typeof asyncIterFn !== 'function') {
    // The returned value is NOT a usable async iterable (a `llm/stream`
    // waterfall listener swapped the generator for a Promise/plain object, or
    // the value was undefined/null). Rather than THROWING — which would bubble
    // an opaque `yield*`-style TypeError far up the stack — RESOLVE to a
    // marked failure result so the caller can report it as a labeled
    // `not-iterable` summarization failure and recover normally. No partial
    // result is possible (nothing could be consumed), so nothing is salvaged.
    const detail = describeStream(stream)
    return {
      blocks: [], text: '', hasImage: false, finish: undefined, usage: undefined,
      _chunkCount: 0, _rejected: true,
      _rejectReason: `did NOT return an async iterable (got ${detail}); a llm/stream waterfall listener likely replaced the generator with another object`,
    }
  }
  const blocks = []
  let text = ''
  let hasImage = false
  let finish
  let usage

  // Accumulators keyed by BLOCK INDEX, mirroring the official `BlockAssembler`:
  // a `block-start` opens a slot; `*-delta`s fill it; `block-end` closes it.
  // When no `block-start` precedes a delta (some adapters omit it), we lazily
  // open the slot on first delta using the chunk's own index. This keeps streamed
  // output and the final assembled blocks in agreement regardless of whether the
  // adapter emits explicit delimiters.
  const partials = new Map()
  const order = []

  const ensure = (index, blockType) => {
    let p = partials.get(index)
    if (!p) {
      p = { blockType, text: '', toolCallId: undefined, toolCallName: '', toolCallArgs: '' }
      partials.set(index, p)
      order.push(index)
    }
    return p
  }

  const finalizeSlot = (index) => {
    const p = partials.get(index)
    if (!p) return
    if (p.assembled) return // block-end already settled it
    if (p.blockType === 'text') {
      blocks.push({ type: 'text', text: p.text })
      text += p.text
    } else if (p.blockType === 'reasoning') {
      if (p.text !== '') blocks.push({ type: 'reasoning', text: p.text })
    } else if (p.blockType === 'tool-call') {
      blocks.push({
        type: 'tool-call',
        toolCallId: p.toolCallId,
        name: p.toolCallName,
        arguments: p.toolCallArgs,
      })
    }
    p.assembled = true
  }

  const flushOpenSlots = () => {
    // Close any slot that received content but never got a `block-end`
    // (lenient tail-handling). Only slots that actually hold data matter.
    for (const idx of order) {
      const p = partials.get(idx)
      if (p && !p.assembled && (p.text !== '' || p.toolCallArgs !== '')) finalizeSlot(idx)
    }
  }

  // TEMPORARY CHUNK-SHAPE PROBE: when a stream finishes yet produced NO text
  // blocks, record the raw shape (type + keys + first 160 chars) of the FIRST
  // few chunks. Self-limiting to ≤3 chunks so it cannot spam on a long stream.
  // Guarded: logging never propagates.
  let probeBuf = []
  const recording = Boolean(opts && opts.recordOnEmpty)
  let chunkCount = 0

  for await (const rawChunk of stream) {
    if (signal !== undefined && signal.aborted) break
    // Defensive: a malformed stream may yield null/undefined/non-object items.
    // Count them (so the "consumed N chunks" diagnostic stays accurate) but skip
    // their processing — reading `.type` on a non-object would throw.
    const chunk = (rawChunk !== null && typeof rawChunk === 'object') ? rawChunk : undefined
    chunkCount++
    if (chunk === undefined) continue
    if (recording && probeBuf.length < 3 && chunkCount <= 3) {
      // Best-effort shape capture; a non-serializable chunk must not abort the
      // collection, so stringify is guarded and falls back to a placeholder.
      let sample
      try { sample = JSON.stringify(chunk).slice(0, 160) } catch { sample = '<unserializable>' }
      probeBuf.push({ type: chunk.type, keys: Object.keys(chunk).join(','), sample })
    }
    switch (chunk.type) {
      case 'block-start':
        ensure(chunk.index, chunk.blockType)
        break
      case 'text-delta': {
        const p = ensure(chunk.index, 'text')
        if (!p.assembled) p.text += typeof chunk.text === 'string' ? chunk.text : ''
        break
      }
      case 'reasoning-delta': {
        const p = ensure(chunk.index, 'reasoning')
        if (!p.assembled) p.text += typeof chunk.text === 'string' ? chunk.text : ''
        break
      }
      case 'tool-call-delta': {
        const p = ensure(chunk.index, 'tool-call')
        if (!p.assembled) {
          if (chunk.id !== undefined) p.toolCallId = chunk.id
          if (chunk.name) p.toolCallName = chunk.name
          if (typeof chunk.argumentsDelta === 'string') p.toolCallArgs += chunk.argumentsDelta
        }
        break
      }
      case 'block-end': {
        // Authoritative settlement: the adapter hands the COMPLETE block. Take
        // it verbatim rather than trusting accumulated deltas.
        const b = chunk.block
        if (b && b.type) {
          if (b.type === 'text' && typeof b.text === 'string') text += b.text
          if (b.type === 'image' || b.mediaType !== undefined) hasImage = true
          blocks.push(b)
        }
        const p = ensure(chunk.index, b && b.type ? b.type : 'text')
        p.assembled = true
        break
      }
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        // The RAW `finish` chunk carries `reason` — a `FinishReason`
        // `{ kind, failure? }` — directly (NOT a nested re-wrap). Store it as-is
        // so the caller can read `finish.kind` / `finish.failure` per the
        // protocol, matching the official `BlockAssembler` (`_finish =
        // chunk.reason`). Previously this branch re-wrapped into a synthetic
        // `{kind, reason, failure}` shape, losing the discriminator and making
        // every terminal finish classify as SUCCESS → spurious "no usable text".
        finish = chunk.reason
        break
      case 'reasoning-chunks':
        // Legacy/aggregate reasoning variant (not in the core protocol but seen
        // on some routes): fold each element into a reasoning block.
        if (Array.isArray(chunk.chunks)) {
          for (const c of chunk.chunks) {
            if (typeof c === 'string') blocks.push({ type: 'reasoning', text: c })
            else if (c && typeof c.text === 'string') blocks.push({ type: 'reasoning', text: c.text })
          }
        }
        break
      default:
        break
    }
  }
  flushOpenSlots()
  // CHUNK-SHAPE PROBE emission: only when the caller asked to record AND this
  // run yielded zero text blocks — i.e. the exact failure signature ("produced
  // no usable text"). Fully self-contained and guarded: NOTHING in this block
  // may throw out of `collectChunks`, so serialization is try/catch'd and the
  // whole emission is a no-op on any anomaly.
  // NOTE: the bulk CHUNK-SHAPE emission that used to live here was REMOVED —
  // it fired on every no-text run with byte-identical payloads (the upstream
  // error is deterministic) and flooded the dev-server log. The raw chunk
  // shapes are STILL recorded into `probeBuf`; a targeted probe can be
  // re-enabled via `recordOnEmpty` should a genuinely NEW failure shape ever
  // appear. The persistent `CRASH-HARNESS` line emitted on terminal
  // `kind:'error'` finishes (in `summarize`) now carries the discriminating
  // detail instead.
  // `_chunkCount` is exposed (underscore-prefixed, internal) purely so a
  // missing-finish diagnostic can distinguish "consumed N chunks but never a
  // terminal finish" from "consumed ZERO chunks (silent/lazy/no-op stream)".
  return { blocks, text, hasImage, finish, usage, _chunkCount: chunkCount }
}

/**
 * Render a terse, human-readable description of whatever object `stream` actually
 * is — used ONLY in error paths to identify who replaced the expected async
 * iterable. Never throws: any inspection failure degrades to a generic tag.
 * @param {*} stream the object passed where an `AsyncIterable` was expected.
 * @returns {string} e.g. `a Promise (constructor Promise)`, `a Generator`, `undefined`, `an array of length 3`.
 */
function describeStream(stream) {
  try {
    if (stream === undefined) return 'undefined'
    if (stream === null) return 'null'
    const ctor = (stream.constructor && stream.constructor.name) || typeof stream
    if (ctor === 'Promise') return 'a Promise (constructor Promise) — a listener likely wrapped the stream in an async fn'
    if (Array.isArray(stream)) return `an array of length ${stream.length} — a listener likely returned a pre-materialized chunk array`
    const hasAsyncIter = typeof stream[Symbol.asyncIterator] === 'function'
    const hasSyncIter = typeof stream[Symbol.iterator] === 'function'
    const keys = Object.prototype.toString.call(stream)
    return `constructor=${ctor} ${keys} asyncIterable=${hasAsyncIter} syncIterable=${hasSyncIter}`
  } catch {
    return `<undescribable object (${typeof stream})>`
  }
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

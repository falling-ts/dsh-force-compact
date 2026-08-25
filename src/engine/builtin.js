/**
 * dsh-force-compact's BUILTIN compaction engine.
 *
 * A SELF-CONTAINED, durable compaction that does NOT depend on the `compaction`
 * service (which the standard preset realm-isolates away from this plugin). It
 * performs the full persistent effect — a summary node that shadows a head-anchored
 * conversation span — by appending its OWN log-only bracket events and a single
 * `user/message` whose `surfaceOp:{op:'replace'}` shadows the range.
 *
 * Naming: all bracket events carry the plugin-specific `fc-compact/*` prefix so
 * they COEXIST side-by-side with the official `compaction/*` service (when both
 * are mounted) without fighting its global `compaction/invariant` listener.
 *
 * The transaction mirrors the official backend's structure:
 *   fc-compact/start → (LLM summarize) → fc-compact/summary →
 *   user/message{surfaceOp:replace} → fc-compact/end
 *
 * `seq` is auto-assigned by the session (`log.length`); the `replace` bounds
 * and provenance (`sourceEventSeqs`) are enforced by the session core at append
 * time. A stability re-check AFTER the async LLM call aborts the transaction if
 * the surface moved, keeping the log consistent.
 *
 * @module @falling-ts/dsh-force-compact/builtin-engine
 */

import { summarize, CHECKPOINT_PREAMBLE, headerPrefix } from './summarizer.js'
import { selectEarliestByTokens } from './region.js'
import { readSettings, DEFAULTS } from '../core/settings.js'

/** Characters per token — mirrors the token meter's coarse estimator. */
const CHARS_PER_TOKEN = 4

/** Provenance tag carried on the checkpoint message's `source`. */
const CHECKPOINT_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'force-compact-builtin' })

/** Mint a stable transaction identity (opaque string; branded conceptually). */
function mintCompactionId() {
  // Node crypto is reachable in the host process; fall back to a composite id.
  try {
    const crypto = globalThis.crypto
    if (crypto && typeof crypto.randomUUID === 'function') return 'fc-' + crypto.randomUUID()
  } catch { /* fall through */ }
  return 'fc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/**
 * Run a standalone manual compaction over the agent's session (the `compactNow`
 * analogue): select a compactable region with the plugin's own policy, then run
 * the full transaction. Safe to call only when the agent is idle; a busy agent
 * or an already-active transaction is detected and returns `null`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} the compaction result, or `null` when skipped.
 */
export async function compactNowBuiltin(ctx, agent, signal) {
  const session = agent.session
  if (session === undefined || typeof session.append !== 'function') return null
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (!(settings.builtinEnabled !== false)) return null

  // Guard: refuse while a prior fc-compact transaction is still open (durable lock).
  if (hasOpenFctLock(session)) {
    warn(ctx, `${session.id}: builtin fc-compact skipped — a prior fc-compact transaction is still open`)
    return null
  }

  const region = selectHeadAnchoredRegion(settings, session)
  if (region === null) {
    // Diagnose WHY: report the surface-node count and how much of it is already
    // checkpoint material. The typical "nothing worth compacting" case is a
    // session whose head IS a previously-generated checkpoint (small, not
    // worth re-summarizing) — re-running /force-compact right after a
    // successful compaction is the classic trigger.
    const nodes = session.surface.nodes
    const headIsCheckpoint = nodes.length > 0 && session.events[nodes[0]]?.data?.source?.plugin === 'force-compact-builtin'
    info(ctx,
      `${session.id}: builtin fc-compact — no compactable region; skipping `
      + `(${nodes.length} surface nodes, head=${headIsCheckpoint ? 'previous checkpoint' : 'ordinary history'}, `
      + `estimated ~${estimateSurfaceTokens(session)} surface tokens)`,
    )
    return null
  }

  return runTransaction(ctx, agent, session, region, signal, settings)
}

/**
 * Compactor for a SPECIFIC region (the `compactRegion` analogue): run the full
 * transaction over `start..end`. Callers are responsible for choosing a
 * tool-pair-balanced span.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {number} start first surface-node seq, inclusive.
 * @param {number} end last surface-node seq, inclusive.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} the compaction result, or `null` when aborted/skipped.
 */
export async function compactRegionBuiltin(ctx, start, end, agent, signal) {
  const session = agent.session
  if (session === undefined || typeof session.append !== 'function') return null
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (!(settings.builtinEnabled !== false)) return null
  if (start > end) return null
  return runTransaction(ctx, agent, session, { start, end }, signal, settings)
}

/**
 * The core transaction: append the durable bracket + a replace node shadowing
 * the region. Every step is guarded; any failure appends `fc-compact/end` with
 * an `error` and returns `null` (leaving exactly one closed-or-orphaned marker
 * pair so the log stays interpretable on reload).
 */
async function runTransaction(ctx, agent, session, region, signal, settings) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    warn(ctx, `${session.id}: builtin fc-compact unavailable — no LLM service`)
    return null
  }
  const meter = ctx.get('tokenMeter')

  // ---- Prepare the replay input ------------------------------------------
  const { shadowedSeqs, messages } = projectRegion(session, region)
  if (messages.length === 0) {
    info(ctx, `${session.id}: builtin fc-compact — region has no surface messages; skipping`)
    return null
  }
  const shadowedTokenCount = estimateTokens(messages)

  // ---- Open the durable lock ---------------------------------------------
  const compactionId = mintCompactionId()
  let startEvent
  try {
    startEvent = markIgnorable(session.append('fc-compact/start', {
      compactionId,
      turn: currentOpenTurn(session),
    }))
  } catch (error) {
    warn(ctx, `${session.id}: builtin fc-compact — failed to append fc-compact/start: ${messageOf(error)}`)
    return null
  }
  if (signal !== undefined) signal.throwIfAborted()

  // ---- Summarize ---------------------------------------------------------
  // Feed the session's latest request-header prefix (system prompt + tool
  // schemas) verbatim into the summarization call so the provider's warm KV
  // cache for the last routed request is REUSED rather than invalidated (the
  // official `compaction-basic` prefix-cache-alignment strategy). When the
  // header carries neither, the call degrades to the legacy messages-only
  // shape. The summarizer's three-tier target resolution (configured →
  // latest-routed-header → agent.options) picks the right provider/model.
  let summaryBlocks
  let summarizationUsage
  let summarizationProvider
  let summarizationModel
  let summarizationMaxTokens
  try {
    const extra = { reasoningEffort: settings.disableThinking ? 'off' : undefined }
    if (Number.isFinite(settings.maxSummaryTokens) && settings.maxSummaryTokens > 0) {
      extra.maxTokens = settings.maxSummaryTokens
    }
    const prefix = headerPrefix(agent && agent.session)
    const input = {
      messages,
      ...(prefix.system !== undefined ? { system: prefix.system } : {}),
      ...(prefix.tools !== undefined ? { tools: prefix.tools } : {}),
    }
    const preview = await summarize(ctx, settings, agent, input, signal, extra)
    // `summarize` returns null ONLY when no target could be resolved OR the
    // `ctx.llm` service is missing (the call was never made). Every other
    // failure path (terminal error / abort / truncated-with-no-output / image
    // content / empty-text) THROWS a typed error caught below.
    if (preview === null) throw new Error('summarizer produced no text')
    summaryBlocks = preview.summary
    summarizationUsage = preview.usage
    summarizationProvider = preview.provider
    summarizationModel = preview.model
    summarizationMaxTokens = preview.maxTokens
  } catch (error) {
    closeWithError(session, startEvent, compactionId, error, ctx)
    return null
  }

  // ---- Shrink gate -------------------------------------------------------
  const summaryTextLen = estimateBlocks(summaryBlocks)
  if (meter !== undefined && typeof meter.estimateMessage === 'function') {
    try {
      const framedEstimate = meter.estimateMessage({ role: 'user', content: summaryBlocks })
      if (framedEstimate >= shadowedTokenCount) {
        warn(ctx, `${session.id}: builtin fc-compact — summary (~${framedEstimate} tokens) is not smaller than the shadowed span (~${shadowedTokenCount}); aborting to avoid bloat`)
        closeWithError(session, startEvent, compactionId, new Error('summary-not-smaller'), ctx)
        return null
      }
    } catch { /* estimator unavailable — proceed best-effort */ }
  } else if (summaryTextLen >= shadowedTokenCount * CHARS_PER_TOKEN) {
    warn(ctx, `${session.id}: builtin fc-compact — summary characters (${summaryTextLen}) not clearly smaller than the shadowed span (${shadowedTokenCount} est-tokens ≈ ${shadowedTokenCount * CHARS_PER_TOKEN} chars); aborting`)
    closeWithError(session, startEvent, compactionId, new Error('summary-not-smaller'), ctx)
    return null
  }

  // ---- Commit: summary marker + replace node ----------------------------
  if (signal !== undefined) signal.throwIfAborted()
  const targetRange = validateReplacementBounds(session, region)
  if (targetRange === null) {
    closeWithError(session, startEvent, compactionId, new Error('range-moved-under-us'), ctx)
    return null
  }

  let summaryEvent
  const summaryData = {
    compactionId,
    summary: summaryBlocks,
    shadowedRange: targetRange,
    shadowedSeqs,
    shadowedTokenCount,
  }
  // Record the ACTUAL LLM call envelope observed from the summarization
  // invocation (ground-truth provider/model/maxTokens/usage) — this is the
  // authoritative source, replacing the previous pre-call header/options
  // label heuristic. We only reach this point after a successful summarization,
  // so the observed fields are defined whenever the provider carried them.
  if (summarizationProvider) summaryData.provider = summarizationProvider
  if (summarizationModel) summaryData.model = summarizationModel
  if (Number.isFinite(summarizationMaxTokens) && summarizationMaxTokens > 0) {
    summaryData.maxTokens = summarizationMaxTokens
  }
  if (summarizationUsage !== undefined) summaryData.usage = summarizationUsage

  try {
    summaryEvent = markIgnorable(session.append('fc-compact/summary', summaryData))
  } catch (error) {
    closeWithError(session, startEvent, compactionId, error, ctx)
    return null
  }

  const checkpointContent = [
    { type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n' + joinBlocks(summaryBlocks) },
  ]
  let replaceEvent
  try {
    replaceEvent = session.append('user/message', {
      content: checkpointContent,
      source: CHECKPOINT_SOURCE,
    }, {
      surfaceOp: { op: 'replace', start: targetRange.start, end: targetRange.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
  } catch (error) {
    closeWithError(session, startEvent, compactionId, error, ctx)
    return null
  }

  // ---- Close the lock ----------------------------------------------------
  let endSeq
  try {
    const endEvent = markIgnorable(session.append('fc-compact/end', {
      compactionId,
      turn: currentOpenTurn(session),
    }))
    endSeq = endEvent.seq
  } catch {
    // Non-fatal: the summary already landed durably; the missing end marker is
    // tolerated as a (rarely orphaned) lock on next reload.
    info(ctx, `${session.id}: builtin fc-compact — warning: could not append fc-compact/end (lock may appear open on next reload)`)
  }

  info(ctx, `${session.id}: builtin fc-compact OK — replaced span seq[${targetRange.start}..${targetRange.end}] (${shadowedSeqs.length} nodes, ~${shadowedTokenCount} tokens) with a ${summaryTextLen}-char checkpoint`)
  return {
    kind: 'builtin',
    compactionId,
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    endSeq,
    summary: summaryBlocks,
    shadowedRange: targetRange,
    shadowedSeqs,
    shadowedTokenCount,
  }
}

/** Append `fc-compact/end` carrying the error so the lock is released explicitly. */
function closeWithError(session, startEvent, compactionId, error, ctx) {
  try {
    markIgnorable(session.append('fc-compact/end', { compactionId, turn: currentOpenTurn(session), error: messageOf(error) }))
  } catch { /* best effort */ }
  warn(ctx, `builtin fc-compact transaction ended in error: ${messageOf(error)}`)
}

/** Total surface-content token estimate for diagnostics (4 chars/token). */
function estimateSurfaceTokens(session) {
  let chars = 0
  for (const event of session.events) {
    let content
    if (event.type === 'user/message') content = event.data.content
    else if (event.type === 'assistant/message') content = event.data.message && event.data.message.content
    else if (event.type === 'tool/result') content = event.data.message && event.data.message.content
    if (content === undefined) continue
    for (const block of content || []) {
      if (block && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Select the plugin's head-anchored compactable region using the configured
 * `autoEarliestRatio` (default 0.5) against the session's estimated surface
 * tokens, snapping the end to a `user/message` boundary so the replacement is
 * tool-pairing safe. Reuses the module's own selector.
 */
function selectHeadAnchoredRegion(settings, session) {
  const ratio = clamp01(settings.autoEarliestRatio, 0.5)
  return selectEarliestByTokens(session, ratio, undefined)
}

/**
 * Project a region's surface nodes into LLM messages and collect their seqs.
 *
 * A replace op's bounds are interpreted by the session core over the CURRENT
 * SURFACE PROJECTION as an INCLUSIVE INDEX SEGMENT: everything the projection
 * holds between `nodes.indexOf(start)` and `nodes.indexOf(end)` is shadowed
 * (`surface.replacementRange` slices by index, not by seq value). Because a
 * previously-generated checkpoint REPLACES earlier nodes but APPENDS at its
 * own (later) log position, the surviving early survivors keep LOWER seqs yet
 * HIGHER indices than the checkpoint node. An inclusive SEQ-value-range filter
 * (`seq >= start && seq <= end`) therefore MISSES those surviving mid-span
 * nodes whenever a prior checkpoint sits at the head — exactly the second
 * compaction round — and the session core rejects the replace for incomplete
 * provenance ("sourceEventSeqs must include every shadowed surface node").
 *
 * So we compute the shadowed set by the SAME rule the core applies: the index
 * segment from `start` to `end` in the live projection. Log-only events
 * contribute nothing; a projected node that yields no message still counts as
 * shadowed.
 */
function projectRegion(session, region) {
  const nodes = Array.from(session.surface.nodes)
  const firstIdx = nodes.indexOf(region.start)
  const lastIdx = nodes.lastIndexOf(region.end)
  const segment = (firstIdx >= 0 && lastIdx >= firstIdx)
    ? nodes.slice(firstIdx, lastIdx + 1)
    : []
  const messages = []
  const shadowedSeqs = []
  for (const seq of segment) {
    const event = session.events[seq]
    if (event === undefined) continue
    if (event.type === 'user/message') {
      shadowedSeqs.push(seq)
      messages.push({ role: 'user', content: event.data.content })
    } else if (event.type === 'assistant/message') {
      shadowedSeqs.push(seq)
      const content = event.data.message && event.data.message.content
      if (content) messages.push({ role: 'assistant', content })
    } else if (event.type === 'tool/result') {
      const msg = event.data.message
      if (msg && msg.content) {
        shadowedSeqs.push(seq)
        messages.push({ role: 'user', content: msg.content, tool_call_id: msg.toolCallId })
      }
    } else {
      // Still a surface node that yields no message (empty assistant usage
      // host); it is shadowed by the replace even though it contributes no
      // message.
      shadowedSeqs.push(seq)
    }
  }
  return { shadowedSeqs, messages }
}

/**
 * Validate that the replace bounds STILL land on current surface nodes (guarding
 * against a surface that changed under us since preparation). Returns the bounds
 * or `null` when invalid.
 */
function validateReplacementBounds(session, region) {
  const nodes = Array.from(session.surface.nodes)
  const firstIdx = nodes.indexOf(region.start)
  const lastIdx = nodes.lastIndexOf(region.end)
  // Same validity predicate the session core applies: both bounds exist in the
  // projection and start precedes end BY INDEX (not by seq value — see
  // projectRegion).
  if (firstIdx < 0 || lastIdx < 0 || firstIdx > lastIdx) return null
  return { start: region.start, end: region.end }
}

/** Whether an open fc-compact transaction is present (durant lock check). */
function hasOpenFctLock(session) {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type
    if (t === 'fc-compact/start') return true
    if (t === 'fc-compact/end') return false
  }
  return false
}

/** The turn number of the currently-open turn, or `null` (standalone/idle). */
function currentOpenTurn(session) {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'turn/start') return ev.data.turn
    if (ev.type === 'turn/end') return null
  }
  return null
}

/** Coarse token count for a set of messages (4 chars/token). */
function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) for (const b of m.content || []) {
    if (b && typeof b.text === 'string') chars += b.text.length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Character length across a block array's text fields. */
function estimateBlocks(blocks) {
  let n = 0
  for (const b of blocks || []) if (b && typeof b.text === 'string') n += b.text.length
  return n
}

/** Concatenate a block array's text fields. */
function joinBlocks(blocks) {
  return (blocks || []).filter(b => b && typeof b.text === 'string').map(b => b.text).join('\n')
}

/** Clamp a value to (0,1]; defaults to `fallback` when not a finite positive. */
function clamp01(value, fallback) {
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0 || v > 1) return (typeof fallback === 'number' ? fallback : 0.5)
  return v
}

/** A cheap human-readable error string. */
function messageOf(error) {
  if (error === undefined || error === null) return 'unknown'
  return (typeof error === 'string') ? error : (error.message || String(error))
}

/** Info/warn shims routed through the logger (never throws). */
function info(ctx, msg) { try { ctx.logger.debug('[force-compact] ' + msg) } catch {} }
function warn(ctx, msg) { try { ctx.logger.warn('[force-compact] ' + msg) } catch {} }

/**
 * Mark every `fc-compact/*` bracket event as envelope-ignorable BEFORE it lands
 * in the log. These transaction markers are pure bookkeeping: the durable
 * effect lives entirely in the separate `user/message` replace node (which
 * stays required and surfaces normally), so dropping an unrecognized marker can
 * never change how the rest of the log is reconstructed. Without the marker,
 * a session log carrying our custom event types REFUSES TO LOAD on any
 * harness build whose generated `KNOWN_SESSION_EVENT_TYPES` catalog predates
 * this plugin ("event type … unknown to this harness and not marked
 * ignorable") — permanently bricking those logs across version upgrades and
 * making them unreadable even by `session.history` after a process restart.
 * `ignorable` is part of the event ENVELOPE (not `data`), and
 * `Session.append` only accepts `surfaceOp`/`sourceEventSeqs` there, so the
 * flag is attached on the returned deep-freeze-bound copy before it publishes.
 */
function markIgnorable(event) {
  if (event === undefined) return undefined
  if (Object.isFrozen(event)) {
    Object.defineProperty(event, 'ignorable', { value: true, enumerable: true, writable: false, configurable: false })
  } else {
    event.ignorable = true
  }
  return event
}

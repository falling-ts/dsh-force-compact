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

import { summarize } from './summarizer.js'
import { selectEarliestByTokens } from './region.js'
import { readSettings, DEFAULTS } from './settings.js'

/** Characters per token — mirrors the token meter's coarse estimator. */
const CHARS_PER_TOKEN = 4

/** The framing that marks the replacement as established background context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it.'

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
    info(ctx, `${session.id}: builtin fc-compact — no compactable region; skipping`)
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
    startEvent = session.append('fc-compact/start', {
      compactionId,
      turn: currentOpenTurn(session),
    })
  } catch (error) {
    warn(ctx, `${session.id}: builtin fc-compact — failed to append fc-compact/start: ${messageOf(error)}`)
    return null
  }
  if (signal !== undefined) signal.throwIfAborted()

  // ---- Summarize ---------------------------------------------------------
  let summaryBlocks
  try {
    const extra = { reasoningEffort: settings.disableThinking ? 'off' : undefined }
    if (Number.isFinite(settings.maxSummaryTokens) && settings.maxSummaryTokens > 0) {
      extra.maxTokens = settings.maxSummaryTokens
    }
    const preview = await summarize(ctx, settings, agent, messages, signal, extra)
    if (preview === null) throw new Error('summarizer produced no text')
    summaryBlocks = preview.summary
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
  const target = resolveTargetLabel(agent)
  if (target.provider) summaryData.provider = target.provider
  if (target.model) summaryData.model = target.model

  try {
    summaryEvent = session.append('fc-compact/summary', summaryData)
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
    const endEvent = session.append('fc-compact/end', {
      compactionId,
      turn: currentOpenTurn(session),
    })
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
    session.append('fc-compact/end', { compactionId, turn: currentOpenTurn(session), error: messageOf(error) })
  } catch { /* best effort */ }
  warn(ctx, `builtin fc-compact transaction ended in error: ${messageOf(error)}`)
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
 * Mirrors the official backend's projection: user/assistant/tool-result become
 * messages; log-only events contribute nothing.
 */
function projectRegion(session, region) {
  const nodes = session.surface.nodes
  const seqSet = new Set(nodes.filter(seq => seq >= region.start && seq <= region.end))
  const messages = []
  const shadowedSeqs = []
  for (const seq of nodes) {
    if (!seqSet.has(seq)) continue
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
  const nodes = session.surface.nodes
  if (!nodes.includes(region.start) || !nodes.includes(region.end)) return null
  const startIdx = nodes.indexOf(region.start)
  const endIdx = nodes.indexOf(region.end)
  if (startIdx > endIdx) return null
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

/** Resolve the provider/model route label for the summary metadata. */
function resolveTargetLabel(agent) {
  const out = { provider: '', model: '' }
  const session = agent.session
  if (session !== undefined && typeof session.requestHeader === 'function') {
    const header = session.requestHeader()
    const config = header && header.config
    if (config && typeof config.provider === 'string' && config.provider) out.provider = config.provider
    if (config && typeof config.model === 'string' && config.model) out.model = config.model
  }
  const opts = agent.options || {}
  if (!out.provider && typeof opts.provider === 'string' && opts.provider) out.provider = opts.provider
  if (!out.model && typeof opts.model === 'string' && opts.model) out.model = opts.model
  return out
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

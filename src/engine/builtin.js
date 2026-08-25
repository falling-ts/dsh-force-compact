/**
 * dsh-force-compact's BUILTIN compaction engine.
 *
 * A SELF-CONTAINED, durable compaction that does NOT depend on the `compaction`
 * service (which the standard preset realm-isolates away from this plugin). It
 * performs the full persistent effect — a summary node that shadows a head-anchored
 * conversation span — by appending log-only bracket events and a single
 * `user/message` whose `surfaceOp:{op:'replace'}` shadows the range.
 *
 * Naming: the brackets reuse the OFFICIAL `compaction/start|summary|end`
 * vocabulary (already in `KNOWN_SESSION_EVENT_TYPES`) rather than a
 * plugin-private event-type prefix. Rationale: `Session.append` offers no
 * channel to persist
 * the `ignorable` marker, so a CUSTOM event type written through `append` lands
 * WITHOUT it — which would brick the log on a future harness rebuild that does
 * not recognize the type (the persistence load gate refuses an unknown, non-
 * ignorable event). The official `compaction/*` types are already in the catalog,
 * so no marker is needed and the transaction stays durable across rebuilds.
 * The global `compaction/invariant` listener validates these brackets; the
 * bracket payloads are shaped to satisfy it (matching ids/owners/turns, a
 * non-empty `shadowedSeqs` aligned with `shadowedRange`, and — for a successful
 * `compaction/end` — a preceding `compaction/summary`).
 *
 * The transaction mirrors the official backend's structure:
 *   compaction/start → (LLM summarize) → compaction/summary →
 *   user/message{surfaceOp:replace} → compaction/end
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

/**
 * Per-session SUMMARIZATION FAILURE cooldown (process-local, no timers, no
 * persistence) — the storm-suppression layer for the IDLE/`compactNow` path,
 * which (unlike the `agent/pre-step` threshold gate) never consulted the
 * existing `guard.js` blank-result cooldown.
 *
 * Why this exists: `compactNow` runs its OWN head-anchored region selection on
 * EVERY `agent/status: idle` transition. If that region's summarization FAILS
 * (provider error, truncated-empty, non-iterable stream — anything that reaches
 * `closeWithError`), NOTHING commits, so the surface is UNCHANGED. The next idle
 * transition selects the IDENTICAL region and repeats the doomed, expensive LLM
 * round-trip. At the observed cadence (one idle tick roughly every ~5s on a
 * busy session) this becomes a livelock: the SAME giant span re-summarized and
 * re-failed on every tick — the concrete "stutters every request" symptom.
 *
 * Mechanism (mirrors `guard.js`'s `compactCooldown` token-high-water-mark):
 * when a transaction fails we remember the session's CURRENT authoritative
 * total-token count as a "do not retry until it grows past THIS" mark, plus a
 * wall-clock timestamp so a pure stall (no new tokens ever) also cools off after
 * a fixed grace period. Both conditions being satisfied clears the mark and the
 * NEXT attempt proceeds. Wall-clock use here is a process-local monotonic-ish
 * read at DECISION time (Date.now()); it stores no timers and starts no
 * intervals — consistent with the "no timer/memory-state beyond Maps" rule.
 * Capped at MAX_FAILURE_COOLDOWN_ENTRIES to stay bounded under many sessions.
 */
const failureCooldown = new Map()
const MAX_FAILURE_COOLDOWN_ENTRIES = 32
/** Absolute token-growth needed past the recorded mark before a failed span may retry. */
const FAILURE_RETRY_GROWTH_TOL = 500
/** Grace period (ms) after a failure before a retry is permitted EVEN IF the
 *  token count has not grown (guards the "identical doomed span" livelock where
 *  the surface never changes, so the growth test alone would never clear). */
const FAILURE_RETRY_GRACE_MS = 60_000
/** How often (ms) a still-cooled session re-evaluates, bounding how long a
 *  genuinely-stuck span suppresses further attempts; also caps map retention. */
const FAILURE_REEVAL_INTERVAL_MS = 15_000

/** Characters per token — mirrors the token meter's coarse estimator. */
const CHARS_PER_TOKEN = 4

/**
 * Hard CAP on the NUMBER of messages replayed into a single summarization call.
 * A head-anchored region spanning thousands of surface nodes (observed live: a
 * session whose whole 3600-node history kept getting projected into one prompt)
 * produces a multi-hundred-KB prompt that a LOCAL GGUF endpoint
 * (llama.cpp :8080, Qwen3.8-27B) routinely rejects or times out on — guaranteeing
 * a FAILED, never-committing compaction every idle tick (the "stuck, stutters
 * every ~5s" symptom). Refusing such a replay outright (return `null`, skip) is
 * strictly better than paying a doomed round-trip repeatedly: it stops the
 * livelock at its source. The cap is generous (128 messages ≈ a substantial but
 * bounded window) so legitimate mid-size compactions still proceed; only
 * pathological whole-history replays are refused.
 */
const MAX_REPLAY_MESSAGES = 128

/**
 * Consult a session's summarization-failure cooldown. Returns a human-readable
 * SKIP NOTE (suppress this attempt) or `undefined` (proceed normally). Clears
 * the mark when EITHER condition holds, so a recovered span retries promptly:
 *   • the session's total tokens have grown past `mark + tolerance` (new content
 *     arrived → a different, larger span is now worth trying), OR
 *   • `FAILURE_RETRY_GRACE_MS` have elapsed since the last failure (pure stall
 *     guard against the identical-doomed-span livelock).
 * @param {string} sessionId
 * @param {number|undefined} totalTokens current authoritative total (best-effort).
 * @returns {string|undefined} skip-note, or `undefined` to proceed.
 */
function consultFailureCooldown(sessionId, totalTokens) {
  const entry = failureCooldown.get(sessionId)
  if (entry === undefined) return undefined
  const grew = Number.isFinite(totalTokens)
    && totalTokens > entry.tokens + FAILURE_RETRY_GROWTH_TOL
  const agedOut = (Date.now() - entry.at) >= FAILURE_RETRY_GRACE_MS
    && (Date.now() - entry.lastReeval) >= FAILURE_REEVAL_INTERVAL_MS
  if (grew || agedOut) {
    failureCooldown.delete(sessionId)
    return undefined
  }
  // Still cooling: refresh the re-eval watermark (throttled bookkeeping only —
  // no timers spawned) and explain the suppression.
  if (agedOut === false && (Date.now() - entry.lastReeval) >= FAILURE_REEVAL_INTERVAL_MS) {
    entry.lastReeval = Date.now()
  }
  return `last builtin summarization failed (at ~${entry.tokens} total tokens); backing off ${Math.max(1, Math.round((FAILURE_RETRY_GRACE_MS - (Date.now() - entry.at)) / 1000))}s`
}

/**
 * Record a summarization failure for a session so subsequent idle ticks back
 * off (see the `failureCooldown` doc-block for rationale). Bounded & evicted
 * oldest-first like `guard.js`'s cooldown.
 * @param {string} sessionId
 * @param {number|undefined} totalTokens best-effort current total (marks the growth baseline).
 */
function markFailureCooldown(sessionId, totalTokens) {
  while (failureCooldown.size >= MAX_FAILURE_COOLDOWN_ENTRIES) {
    const oldest = failureCooldown.keys().next().value
    if (oldest === undefined) break
    failureCooldown.delete(oldest)
  }
  const now = Date.now()
  const base = Number.isFinite(totalTokens) ? totalTokens : 0
  failureCooldown.delete(sessionId) // move-to-tail semantics
  failureCooldown.set(sessionId, { tokens: base, at: now, lastReeval: now })
}

/** Drop a session's failure cooldown (called when a compaction SUCCEEDS). */
function clearFailureCooldown(sessionId) {
  failureCooldown.delete(sessionId)
}

/**
 * Checkpoint provenance carried on the replacement `user/message`'s `source`.
 * Uses the CANONICAL compaction-checkpoint marker (`{kind:'plugin',
 * plugin:'compact'}`) that `isCompactCheckpointSource` recognizes — so the
 * official `compaction/invariant` validator treats our replacement as a real
 * compaction checkpoint and enforces its correlation with the open
 * `compaction/start`. The plugin-specific identity rides on `compactionId`
 * (see `mintCompactionId`) and the bracket events, not on `source.plugin`,
 * keeping the checkpoint universally recognizable across all backends.
 * `CHECKPOINT_SOURCE_BASE` is spread together with `compactionId` per
 * transaction (below).
 */
const CHECKPOINT_SOURCE_BASE = Object.freeze({ kind: 'plugin', plugin: 'compact' })

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

  // Guard: refuse while a prior compaction transaction is still open (durable lock).
  if (hasOpenFctLock(session)) {
    warn(ctx, `${session.id}: builtin compaction skipped — a prior compaction transaction is still open`)
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
      `${session.id}: builtin compaction — no compactable region; skipping `
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
 * the region. Every step is guarded; any failure appends `compaction/end` with
 * an `error` and returns `null` (leaving exactly one closed-or-orphaned marker
 * pair so the log stays interpretable on reload).
 */
async function runTransaction(ctx, agent, session, region, signal, settings) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    warn(ctx, `${session.id}: builtin compaction unavailable — no LLM service`)
    return null
  }
  const meter = ctx.get('tokenMeter')

  // ---- Failure cooldown ---------------------------------------------------
  // Suppress a retry of a recently FAILED summarization on this session (see
  // the `failureCooldown` doc-block). Best-effort read of the authoritative
  // total; a missing meter simply passes `undefined` and relies on the grace
  // period alone. This is what breaks the idle livelock: a failing span backs
  // off for a bounded interval instead of re-hammering every tick.
  let currentTotalTokens
  if (meter !== undefined && typeof meter.measure === 'function') {
    try { currentTotalTokens = meter.measure(session)?.totalTokens } catch { /* best effort */ }
  }
  const cooledNote = consultFailureCooldown(session.id, currentTotalTokens)
  if (cooledNote !== undefined) {
    info(ctx, `${session.id}: builtin compaction SKIPPED (cooldown) — ${cooledNote}`)
    return null
  }

  // ---- Prepare the replay input ------------------------------------------
  const { shadowedSeqs, messages } = projectRegion(session, region)
  if (messages.length === 0) {
    info(ctx, `${session.id}: builtin compaction — region has no surface messages; skipping`)
    return null
  }
  const shadowedTokenCount = estimateTokens(messages)

  // ---- Replay-size CAP ----------------------------------------------------
  // Refuse a replay whose message count exceeds MAX_REPLAY_MESSAGES. Such a
  // region (typically a head-anchored selection that grabbed nearly the WHOLE
  // session) sends a gigantic prompt the local model endpoint cannot serve, so
  // attempting it guarantees a failed, non-committing transaction repeated on
  // every idle tick — the livelock behind "stuck + stutters each request".
  // Skipping here (before opening the lock or calling the LLM) costs nothing.
  if (messages.length > MAX_REPLAY_MESSAGES) {
    warn(
      ctx,
      `${session.id}: builtin compaction REFUSED — region projects ${messages.length} messages `
      + `(span seq ${region.start}..${region.end}), exceeding the ${MAX_REPLAY_MESSAGES}-message replay cap; `
      + `a summarization of that size is unserviceable on a local model endpoint. Skipping (no lock opened, `
      + `no LLM call made). Lower the auto-region extent (autoEarliestRatio) to compact smaller windows.`,
    )
    return null
  }

  // ---- Open the durable lock ---------------------------------------------
  const compactionId = mintCompactionId()
  let startEvent
  try {
    startEvent = session.append('compaction/start', {
      compactionId,
      turn: currentOpenTurn(session),
    })
  } catch (error) {
    warn(ctx, `${session.id}: builtin compaction — failed to append compaction/start: ${messageOf(error)}`)
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
    // ARM THE FAILURE COOLDOWN: this summarization just failed (provider error
    // / aborted / truncated-empty / non-iterable stream / no-target-null). Without
    // this, the next idle tick would select the SAME region and repeat the doomed
    // round-trip — the livelock. Marking it makes subsequent idle attempts back
    // off for a bounded interval. Armed here (NOT in closeWithError) because
    // closeWithError is ALSO called on the shrink-gate abort, which is a DIFFERENT
    // outcome (a summary WAS produced, just not shrunk) and must NOT cool the LLM.
    markFailureCooldown(session.id, currentTotalTokens)
    closeWithError(session, startEvent, compactionId, error, ctx)
    return null
  }

  // ---- Shrink gate -------------------------------------------------------
  const summaryTextLen = estimateBlocks(summaryBlocks)
  if (meter !== undefined && typeof meter.estimateMessage === 'function') {
    try {
      const framedEstimate = meter.estimateMessage({ role: 'user', content: summaryBlocks })
      if (framedEstimate >= shadowedTokenCount) {
        warn(ctx, `${session.id}: builtin compaction — summary (~${framedEstimate} tokens) is not smaller than the shadowed span (~${shadowedTokenCount}); aborting to avoid bloat`)
        closeWithError(session, startEvent, compactionId, new Error('summary-not-smaller'), ctx)
        return null
      }
    } catch { /* estimator unavailable — proceed best-effort */ }
  } else if (summaryTextLen >= shadowedTokenCount * CHARS_PER_TOKEN) {
    warn(ctx, `${session.id}: builtin compaction — summary characters (${summaryTextLen}) not clearly smaller than the shadowed span (${shadowedTokenCount} est-tokens ≈ ${shadowedTokenCount * CHARS_PER_TOKEN} chars); aborting`)
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
  // DEFENSE-IN-DEPTH: the official `compaction/summary` validator marks
  // `provider` and `model` REQUIRED. If the summarization envelope somehow
  // lacked either (degraded provider metadata), fall back to a non-empty
  // placeholder rather than emitting `undefined`, which the invariant listener
  // would reject. Live runs carry the real ids; this only guards edge cases.
  summaryData.provider = (typeof summarizationProvider === 'string' && summarizationProvider.length > 0)
    ? summarizationProvider
    : 'unknown'
  summaryData.model = (typeof summarizationModel === 'string' && summarizationModel.length > 0)
    ? summarizationModel
    : 'unknown'
  if (Number.isFinite(summarizationMaxTokens) && summarizationMaxTokens > 0) {
    summaryData.maxTokens = summarizationMaxTokens
  }
  if (summarizationUsage !== undefined) summaryData.usage = summarizationUsage

  try {
    summaryEvent = session.append('compaction/summary', summaryData)
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
      source: Object.freeze({ ...CHECKPOINT_SOURCE_BASE, compactionId }),
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
    const endEvent = session.append('compaction/end', {
      compactionId,
      turn: currentOpenTurn(session),
    })
    endSeq = endEvent.seq
  } catch {
    // Non-fatal: the summary already landed durably; the missing end marker is
    // tolerated as a (rarely orphaned) lock on next reload.
    info(ctx, `${session.id}: builtin compaction — warning: could not append compaction/end (lock may appear open on next reload)`)
  }

  // A successful compaction clears ANY residual failure cooldown for this
  // session so the NEXT idle tick isn't suppressed by a stale mark.
  clearFailureCooldown(session.id)
  info(ctx, `${session.id}: builtin compaction OK — replaced span seq[${targetRange.start}..${targetRange.end}] (${shadowedSeqs.length} nodes, ~${shadowedTokenCount} tokens) with a ${summaryTextLen}-char checkpoint`)
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

/** Append `compaction/end` carrying the error so the lock is released explicitly. */
function closeWithError(session, startEvent, compactionId, error, ctx) {
  try {
    session.append('compaction/end', { compactionId, turn: currentOpenTurn(session), error: messageOf(error) })
  } catch { /* best effort */ }
  warn(ctx, `builtin compaction transaction ended in error: ${messageOf(error)}`)
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

/** Whether an open compaction transaction is present (durant lock check). */
function hasOpenFctLock(session) {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type
    if (t === 'compaction/start') return true
    if (t === 'compaction/end') return false
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


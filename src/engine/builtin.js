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
import { selectEarliestByTokens, selectRetainingLatestTokens } from './region.js'
import { readSettings, DEFAULTS } from '../core/settings.js'
import { guardFn } from '../core/crashnet.js'

/**
 * ONE-SHOT LOAD MARKER — proves WHICH built engine is actually loaded on a
 * booted instance (so a stale-process or wrong-source scenario is instantly
 * visible in the dev-server log rather than guessed at). Emitted once per
 * process on first `runTransaction` entry (before any other work), guarded so
 * a console failure can never disturb a compaction. Remove freely once the
 * `reading 'kind'` investigation closes.
 */
let loadMarkerEmitted = false
function emitLoadMarker() {
  if (loadMarkerEmitted) return
  loadMarkerEmitted = true
  try {
    console.log(`[force-compact] BUILTIN ENGINE LOADED — marker v2026-08-25-official-parity `
      + `(official port active: tool-pairing-ledger boundary selection, validateSurfaceRegion double gate, `
      + `surface-consistency cross-check, official busy-lock semantics, tools prefix RESTORED, `
      + `instruction aligned to official COMPACTION_INSTRUCTION)`)
  } catch {
    /* a load marker must never throw out of a compaction path */
  }
}

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
 * Mechanism (token-high-water-mark PLUS wall-clock aging):
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
 *  the surface never changes, so the growth test alone would never clear).
 *  180s (raised from 60s, 2026-08-25): a DETERMINISTIC upstream failure — e.g.
 *  a streaming pipeline defect that always truncates the same head span — will
 *  burn an entire ~40s summarization round-trip on EVERY retry, so a shorter
 *  grace window merely re-hammers the identical doomed span at higher
 *  frequency. Three minutes gives the underlying condition time to change
 *  (server restart, transient overload clearing, …) before the next attempt. */
const FAILURE_RETRY_GRACE_MS = 180_000
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
 * Minimum shadowed-span size (in estimated tokens) below which a summarization
 * is skipped WITHOUT opening the lock or calling the LLM (the small-span
 * pre-check in `runTransaction`). Rationale: for spans this small, the
 * summarizer's verbosity floor means the output very often EXCEEDS the input
 * (observed live 2026-08-25: a ~3175-token span produced a ~3789-token
 * summary → the post-summary shrink gate vetoes it), so attempting such a
 * span deterministically wastes a ~40s local round-trip and burns the
 * transaction bracket for a guaranteed `summary-not-smaller` outcome. Spans
 * grow naturally as head accumulates, so the FIRST worthwhile compression
 * happens automatically once enough older content gathers. The post-summary
 * SHRINK GATE remains authoritative for everything above this floor.
 */
const MIN_USEFUL_SPAN_TOKENS = 8000

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
  return `last builtin summarization failed (at ~${entry?.tokens} total tokens); backing off ${Math.max(1, Math.round((FAILURE_RETRY_GRACE_MS - (Date.now() - (entry?.at ?? Date.now()))) / 1000))}s`
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
// Internal body of `compactNowBuiltin` — routed through the crash-net wrapper
// so an unexpected throw escaping the internal guards becomes a durable,
// parseable diagnostic rather than a silent propagation up the call stack.
async function __compactNowBuiltinBody(ctx, agent, signal) {
  const session = agent.session
  if (session === undefined || typeof session.append !== 'function') return null
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (!(settings.builtinEnabled !== false)) return null

  // Guard: refuse while a prior compaction transaction is still open (durable lock).
  if (hasOpenFctLock(session)) {
    warn(ctx, `${session.id}: builtin compaction skipped — a prior compaction transaction is still open`)
    return null
  }

  // ---- AUTHORITATIVE METER SNAPSHOT (SAME CALIBER AS THE AUTO PATH) -------
  // The manual/self-selecting path prices its region from the OFFICIAL
  // `tokenMeter.measure` snapshot — the exact same measurement the
  // `agent/pre-step` auto path uses (see `hooks/guard.js`): the meter's own
  // per-node prices, so the `retainLatestTokens` budget is expressed in the
  // SAME token caliber that the threshold gate measures, not in a divergent
  // char/4 estimate of flat text (which systematically undercounts nested
  // tool blocks / JSON framing and starves the head budget on short-ish
  // sessions — the observed "/force-compact → no compactable range" cause).
  // Missing/malformed snapshot → `undefined` → the legacy char-heuristic
  // fallback below keeps working (degradation, never a hard failure).
  const meter = ctx.get('tokenMeter')
  let measurement
  if (meter !== undefined && typeof meter.measure === 'function') {
    try {
      const measured = meter.measure(session)
      if (measured !== undefined && measured !== null) measurement = measured
    } catch {
      measurement = undefined
    }
  }

  const region = selectHeadAnchoredRegion(settings, session, measurement)
  if (region === null) {
    // Diagnose WHY: report the surface-node count and how much of it is already
    // checkpoint material. The typical "nothing worth compacting" case is a
    // session whose head IS a previously-generated checkpoint (small, not
    // worth re-summarizing) — re-running /force-compact right after a
    // successful compaction is the classic trigger.
    const surfNodes = (session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
    let headIsCheckpoint = false
    if (surfNodes.length > 0 && Array.isArray(session.events)) {
      const headEvent = session.events[surfNodes[0]]
      const headSource = headEvent && headEvent.data && typeof headEvent.data === 'object' ? headEvent.data.source : undefined
      headIsCheckpoint = !!(headSource && typeof headSource === 'object' && headSource.plugin === 'force-compact-builtin')
    }
    info(ctx,
      `${session.id}: builtin compaction — no compactable region; skipping `
      + `(${surfNodes.length} surface nodes, head=${headIsCheckpoint ? 'previous checkpoint' : 'ordinary history'}, `
      + `estimated ~${estimateSurfaceTokens(session)} surface tokens)`,
    )
    return null
  }

  return runTransaction(ctx, agent, session, region, signal, settings)
}

/**
 * Compactor for a SPECIFIC region (the `compactRegion` analogue): run the full
 * transaction over EXACTLY `start..end`. Callers (the `agent/pre-step` guard,
 * `/force-compact`, …) choose the span themselves — typically via
 * `selectRetainingLatestTokens` priced from a live `tokenMeter.measure`
 * snapshot. This backend RESPECTS that choice verbatim: it does NOT re-derive
 * a region internally, mirroring the official `compaction` service contract
 * where the caller owns region selection. Re-deriving here with a coarser
 * estimator would silently downgrade the caller's precise region to a
 * narrower char-heuristic one (observed live 2026-08-25: a meter-priced
 * head-span shrinking to only the smallest user-boundary slice, shadowing a
 * few thousand tokens instead of the intended tens of thousands).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {number} start first surface-node seq, inclusive.
 * @param {number} end last surface-node seq, inclusive.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} the compaction result, or `null` when aborted/skippedped.
 */
// Internal body of `compactRegionBuiltin` — routed through the crash-net wrapper.
async function __compactRegionBuiltinBody(ctx, start, end, agent, signal) {
  const session = agent.session
  if (session === undefined || typeof session.append !== 'function') return null
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (!(settings.builtinEnabled !== false)) return null
  if (start > end) return null
  return runTransaction(ctx, agent, session, { start, end }, signal, settings)
}

/** Public entries — wrapped by the universal crash net. */
export const compactNowBuiltin = guardFn('builtin.compactNowBuiltin', __compactNowBuiltinBody)
export const compactRegionBuiltin = guardFn('builtin.compactRegionBuiltin', __compactRegionBuiltinBody)

/**
 * The core transaction: append the durable bracket + a replace node shadowing
 * the region. Every step is guarded; any failure appends `compaction/end` with
 * an `error` and returns `null` (leaving exactly one closed-or-orphaned marker
 * pair so the log stays interpretable on reload).
 */
async function runTransaction(ctx, agent, session, region, signal, settings) {
  emitLoadMarker()
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    warn(ctx, `${session.id}: builtin compaction unavailable — no LLM service`)
    return null
  }

  // ---- Busy-lock REFUSAL (ported from the official `assertNoActiveCompaction`)
  // An UNMATCHED `compaction/start` with no later `session/end-seed` proves a
  // transaction is in flight (typically a crashed predecessor that opened its
  // bracket but died before closing). Refuse THIS entry rather than nest a
  // second bracket on top (nested brackets violate the invariant listener's
  // single-inflight-trace contract). Inherited orphans (preceded by a later
  // end-seed) are IGNORED per official semantics — see the helper's doc.
  const busyNote = assertNoActiveCompaction(session, 'builtin.runTransaction')
  if (busyNote !== null) {
    info(ctx, `${session.id}: builtin compaction SKIPPED (${busyNote})`)
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

  // ---- Small-span PRE-CHECK (doom avoidance, mirrors official O26) --------
  // A summarization of a TINY head span is statistically likely to produce
  // MORE text than the span itself (an abstract cannot beat the verbosity
  // floor of a few thousand tokens), so the shrink gate further down WOULD
  // reject it — yet we would have burned the lock + a full LLM round-trip
  // (≈40s on a local endpoint) to learn that. Skip such regions BEFORE the
  // lock opens and the call fires: the caller's selection is honored on the
  // NEXT attempt, and once enough head accumulates the span naturally grows
  // past MIN_USEFUL_SPAN_TOKENS and proceeds. This replaces the wasteful
  // cycle "attempt giant prompt → shrink-gate veto → blank → re-attempt the
  // identical doomed span every step".
  // NOTE: the post-summary SHRINK GATE still applies to everything that
  // passes this pre-check — it remains the authoritative defense.
  let shadowedTokenCount
  const projected = projectRegion(session, region)
  const messages = projected.messages
  const shadowedSeqs = projected.shadowedSeqs
  if (messages.length === 0) {
    info(ctx, `${session.id}: builtin compaction — region has no surface messages; skipping`)
    return null
  }
  shadowedTokenCount = estimateTokens(messages)

  // ---- Threshold-aware SHADOW-SPAN FLOOR ----------------------------------
  // Mirror of `guard.js`'s threshold-aware shrink gate, applied to the
  // SELF-SELECTING path (`compactNow` — idle turn-end hook, `/force-compact`
  // when idle) which otherwise has no equivalent pre-LLM viability check.
  //
  // PREDICATE: when a reliable meter-priced total is known (same condition
  // `guard.js` uses) AND the selected head span is TOO SMALL to drag the total
  // below `autoThresholdTokens` even when removed wholesale
  // (`total − span ≥ threshold`), the compaction CANNOT achieve its purpose.
  // Paying for a summarization call to learn that just re-arms the identical
  // doomed attempt on the next tick (the idle-path twin of the "threshold-
  // aware gate — cannot pull total below threshold; SKIPPING" storm the
  // auto path already suppresses). Skipping here costs nothing — the head
  // grows naturally and becomes compactable on its own once large enough.
  //
  // CALIBER NOTE: the span figure is char-heuristic (`estimateTokens`,
  // ceil(chars/4)); `guard.js` prices its identical predicate from a
  // `tokenMeter.measure` snapshot instead. Heuristic-vs-meter skew is small
  // relative to the hundreds-of-hundreds-of-tokens margin these decisions
  // hinge on (a ~16K-char-estimated span vs. a ~59K meter-priced total
  // leaves ~43K of slack — a realistic ±2K estimation error cannot flip the
  // verdict). The auto path retains its strict meter pricing unchanged; this
  // floor merely PREVENTS the idle path from re-entering the same doom.
  if (currentTotalTokens !== undefined && Number.isFinite(currentTotalTokens)
      && currentTotalTokens >= settings.autoThresholdTokens
      && (currentTotalTokens - shadowedTokenCount) >= settings.autoThresholdTokens) {
    info(ctx,
      `${session.id}: builtin compaction — threshold-aware floor: shadowed span (~${shadowedTokenCount} est-tokens, char heuristic) `
      + `cannot pull the total (~${currentTotalTokens} meter-priced) below ${settings.autoThresholdTokens} `
      + `(removing it wholesale would still leave ~${currentTotalTokens - shadowedTokenCount}). `
      + `Skipping (no lock opened, no LLM call made) — the head will qualify naturally as it grows. `
      + `Raise \`retainLatestTokens\` so less of the tail is retained and more of the head becomes compactable.`,
    )
    return null
  }

  // ---- Small-span SKIP (above) now applied to the measured span ------------
  if (shadowedTokenCount < MIN_USEFUL_SPAN_TOKENS) {
    info(
      ctx,
      `${session.id}: builtin compaction — head span (~${shadowedTokenCount} tokens, seq ${region?.start}..${region?.end}) `
      + `is below the ${MIN_USEFUL_SPAN_TOKENS}-token usefulness floor; a summary of this much content almost surely `
      + `cannot shrink it, so NO lock is opened and NO LLM call is made (the next attempt will see a larger span as `
      + `more head accumulates). Retrying on a bigger head is cheaper than burning a doomed ~40s round-trip.`
    )
    return null
  }

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
      + `(span seq ${region?.start}..${region?.end}), exceeding the ${MAX_REPLAY_MESSAGES}-message replay cap; `
      + `a summarization of that size is unserviceable on a local model endpoint. Skipping (no lock opened, `
      + `no LLM call made). Raise \`retainLatestTokens\` so less of the head is compacted, `
      + `or increase \`maxRegionNodes\` / the built-in engine's replay cap.`,
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
      // FULL OFFICIAL PREFIX-CACHE ALIGNMENT: feed the session's latest
      // request-header SYSTEM PROMPT AND TOOL SCHEMAS verbatim into the
      // auxiliary call (mirrors `summarizeWithLlm`'s `input.tools` pass-through
      // — the auxiliary call becomes a genuine prefix of the last routed
      // request and the provider's warm KV cache is reused instead of
      // invalidated). The earlier temporary omission was a bisection probe
      // against the vendor-side replay `reading 'kind'` crash, which has since
      // been proven unrelated to the `tools` option (replays of ROUTED requests
      // crash identically with or without this field) — so restore full parity.
      ...(prefix.tools !== undefined ? { tools: prefix.tools } : {}),
    }
    // `summarize` NEVER throws and resolves to a discriminated `{ status, ... }`
    // object (plus `reason` on non-ok outcomes). Branch defensively:
    //   • status 'ok'        → commit-ready: read summary/envelope.
    //   • 'no-target'/'no-llm' → call never made (nothing to cool). Silently
    //                            close the bracket with a neutral note and stop.
    //   • anything else      → the call was made but produced no usable summary
    //                            (provider-error / aborted / truncated-empty /
    //                            image-content / empty-text / no-finish /
    //                            not-iterable). ARM the per-session failure
    //                            cooldown (so the idle path backs off instead of
    //                            re-running the same doomed span every tick) and
    //                            close the bracket carrying the descriptive error.
    // Belt-and-braces: `summarize` is total, but we STILL guard the result shape
    // here so a hypothetical non-object result cannot throw downstream either.
    const preview = await summarize(ctx, settings, agent, input, signal, extra)
    const ok = preview !== null && typeof preview === 'object' && preview.status === 'ok'
    if (ok) {
      const s = Array.isArray(preview.summary) ? preview.summary : []
      if (s.length === 0) {
        // Defensive: a declared-'ok' result with an empty summary is anomalous;
        // treat it as a failure rather than committing an empty checkpoint.
        markFailureCooldown(session.id, currentTotalTokens)
        closeWithError(session, startEvent, compactionId, new Error('summarizer returned ok but no summary blocks'), ctx)
        return null
      }
      summaryBlocks = s
      summarizationUsage = (preview.usage !== undefined && preview.usage !== null) ? preview.usage : undefined
      summarizationProvider = typeof preview.provider === 'string' ? preview.provider : ''
      summarizationModel = typeof preview.model === 'string' ? preview.model : ''
      summarizationMaxTokens = Number.isFinite(preview.maxTokens) ? preview.maxTokens : undefined
    } else if (preview !== null && typeof preview === 'object' && (preview.status === 'no-target' || preview.status === 'no-llm')) {
      // The summarization call was NEVER made (no resolvable target, or no `llm`
      // service). There is nothing that "failed", so do NOT arm the cooldown —
      // the next attempt should try again immediately. Close the bracket with a
      // neutral, non-error note and stop (no doomed round-trip occurred).
      const why = (typeof preview.reason === 'string' && preview.reason.length > 0) ? preview.reason : preview.status
      info(ctx, `${session.id}: builtin compaction skipped (no summarization call made — ${why})`)
      try {
        session.append('compaction/end', { compactionId, turn: currentOpenTurn(session), note: why })
      } catch { /* best effort */ }
      return null
    } else {
      // A call was made but yielded no usable summary — OR (defensively) the
      // result was a completely unexpected shape. Arm the cooldown and close with
      // a descriptive error so the operator sees WHY it skipped.
      const label = (preview && typeof preview.status === 'string') ? preview.status : 'unexpected-result-shape'
      const reason = (preview && typeof preview.reason === 'string' && preview.reason.length > 0) ? preview.reason : 'no usable summary'
      markFailureCooldown(session.id, currentTotalTokens)
      warn(ctx, `${session.id}: builtin compaction summarized-but-unusable (${label}): ${reason}`)
      closeWithError(session, startEvent, compactionId, new Error(`summarization ${label}: ${reason}`), ctx)
      return null
    }
  } catch (error) {
    // Last-resort safety net: `summarize` is designed to never reject, but if an
    // unexpected error ever escapes (bug, or a non-guarded read), it lands HERE
    // rather than propagating into the event dispatcher. Same treatment as a
    // labeled failure: arm the cooldown, close the bracket, stop. No throw.
    markFailureCooldown(session.id, currentTotalTokens)
    closeWithError(session, startEvent, compactionId, error instanceof Error ? error : new Error(messageOf(error)), ctx)
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
  info(ctx, `${session.id}: builtin compaction OK — replaced span seq[${targetRange?.start}..${targetRange?.end}] (${shadowedSeqs?.length} nodes, ~${shadowedTokenCount} tokens) with a ${summaryTextLen}-char checkpoint`)
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
  // Coarse char-based fallback used only when `tokenMeter` is absent. Every
  // dereference is guarded so a malformed session (missing `events`, `data`,
  // or `message`) degrades to 0 instead of throwing — this feeds a
  // diagnostics/cooldown decision, never a correctness path.
  let chars = 0
  const events = (session && Array.isArray(session.events)) ? session.events : []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    let content
    if (event.type === 'user/message') content = data.content
    else if (event.type === 'assistant/message') content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
    else if (event.type === 'tool/result') content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
    if (content === undefined) continue
    for (const block of Array.isArray(content) ? content : []) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Select a head-anchored compactable region for the MANUAL `compactNow` path
 * (idle turn-end hook, `/force-compact`-when-idle). PRECEDENCE RULE: this is
 * the SELF-SELECTING fallback only — every region-CARRYING caller routes its
 * own span through `compactRegion` (see its doc) and this helper is NOT
 * consulted.
 *
 * Semantics (identical to the auto path in `hooks/guard.js`): retain the
 * latest `settings.retainLatestTokens` of the surface VERBATIM; everything
 * before that cutoff forms the head-anchored region compacted into a single
 * summary node.
 *
 * CALIBER — MIRROR OF THE AUTO PATH: the primary source is a `tokenMeter
 * .measure` snapshot passed in by the caller (obtained the same way
 * `guards.js` obtains it, see `hooks/guard.js`). When available, the region
 * comes from `selectRetainingLatestTokens` priced from that very snapshot —
 * the meter's own per-node prices — so the retention budget is expressed in
 * the SAME token caliber the threshold gate measures (not a divergent char/4
 * estimate of flat text, which systematically UNDERCOUNTS nested tool blocks
 * and JSON framing; subtracting a fixed 8000-token retention from an
 * undercounted surface sum starved the head budget until fewer than two head
 * nodes remained — the observed "/force-compact → no compactable range").
 *
 * LEGACY FALLBACK (snapshot `undefined` — tokenMeter absent or `measure`
 * threw): the OLD char-heuristic path, preserved for degraded compositions —
 * keep the latest `settings.retainLatestTokens` via the char estimate of the
 * surface sum and route the residual head budget through
 * `selectEarliestByTokens`.
 *
 * Edge cases: with a meter snapshot, `selectRetainingLatestTokens` itself
 * reports `null` when the retained tail consumes the whole window (single
 * huge trailing node) or fewer than 2 nodes exist; with the legacy fallback,
 * if the char-estimated surface sum is smaller than the retention budget
 * (very short session), the head budget clamps to zero and no region results.
 */
function selectHeadAnchoredRegion(settings, session, measurement) {
  const retain = Number.isFinite(settings.retainLatestTokens)
    ? Math.max(0, Math.round(settings.retainLatestTokens))
    : 0
  // PRIMARY (mirror of the auto path): price from the meter's own per-node
  // snapshot — the same caliber as the threshold gate's `surfaceTokens`.
  if (measurement !== undefined && Array.isArray(measurement.nodes) && measurement.nodes.length > 1) {
    return selectRetainingLatestTokens(session, retain, measurement)
  }
  // LEGACY FALLBACK: no meter snapshot — char-estimate the surface sum and
  // route the residual head budget through the legacy selector.
  const surfaceSum = estimateSurfaceTokensLocal(session)
  const headBudget = Math.max(0, surfaceSum - retain)
  if (headBudget <= 0) return null
  return selectEarliestByTokens(session, headBudget, undefined)
}

/** Local surface-sum estimator (module-private copy of the char heuristic). */
function estimateSurfaceTokensLocal(session) {
  const events = (session && Array.isArray(session.events)) ? session.events : []
  let chars = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    let content
    if (event.type === 'user/message') content = data.content
    else if (event.type === 'assistant/message') content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
    else if (event.type === 'tool/result') content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
    if (content === undefined) continue
    for (const block of Array.isArray(content) ? content : []) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / 4)
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
  // Tolerate a malformed surface: a missing `session.surface` / non-array
  // `nodes` yields an EMPTY projection (zero shadowed, zero messages) rather
  // than a throw, so the caller simply finds nothing to compact instead of
  // crashing the transaction.
  const surfaceNodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const nodes = [...surfaceNodes]
  const firstIdx = nodes.indexOf(region.start)
  const lastIdx = nodes.lastIndexOf(region.end)
  const segment = (firstIdx >= 0 && lastIdx >= firstIdx)
    ? nodes.slice(firstIdx, lastIdx + 1)
    : []
  const events = (session && Array.isArray(session.events)) ? session.events : []
  const messages = []
  const shadowedSeqs = []
  for (const seq of segment) {
    const event = events[seq]
    if (event === undefined || event === null || typeof event !== 'object') continue
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    if (event.type === 'user/message') {
      shadowedSeqs.push(seq)
      messages.push({ role: 'user', content: data.content })
    } else if (event.type === 'assistant/message') {
      shadowedSeqs.push(seq)
      const content = (data.message && data.message.content !== undefined) ? data.message.content : undefined
      const source = (data.message && typeof data.message.source === 'object' && data.message.source !== null) ? data.message.source : { kind: 'model' }
      if (content) messages.push({ role: 'assistant', content, source })
    } else if (event.type === 'tool/result') {
      const msg = (data.message && typeof data.message === 'object') ? data.message : undefined
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
  // A malformed surface (missing `session.surface` / non-array `nodes`) means
  // we cannot validate the bounds — return null (refuse the replace) rather
  // than throw. Reading `.nodes` off a null surface would otherwise crash the
  // whole transaction.
  const surfaceNodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const firstIdx = surfaceNodes.indexOf(region.start)
  const lastIdx = surfaceNodes.lastIndexOf(region.end)
  // Same validity predicate the session core applies: both bounds exist in the
  // projection and start precedes end BY INDEX (not by seq value — see
  // projectRegion).
  if (firstIdx < 0 || lastIdx < 0 || firstIdx > lastIdx) return null
  return { start: region.start, end: region.end }
}

/**
 * Inspect open-turn, unmatched-compaction, and latest seed-boundary state
 * independently — ported from the official `inspectCompactionEntryState`.
 * Scans the durable log BACKWARD once, collecting:
 *   • `openTurn`              — the turn number of the currently-open turn, or
 *                               `null` when no turn is open (or the state is
 *                               simply absent);
 *   • `unmatchedCompactionStart` — the LATEST `compaction/start` without a
 *                                  following `compaction/end` (the in-flight
 *                                  transaction lock), `undefined` when none;
 *   • `latestEndSeedSeq`        — the newest `session/end-seed` marker,
 *                                 `undefined` when absent.
 * A backward scan means each field is found in O(1)-amortised passes: we stop
 * as soon as ALL THREE are known.
 * @param {readonly object[]} events the durable session log.
 * @returns {{openTurn: number|null, unmatchedCompactionStart: object|undefined, latestEndSeedSeq: number|undefined}}
 */
function inspectCompactionEntryState(events) {
  const rows = (Array.isArray(events)) ? events : []
  let openTurn = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart
  let compactionEntryStateKnown = false
  let latestEndSeedSeq
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index]
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    if (latestEndSeedSeq === undefined && type === 'session/end-seed' && typeof event.seq === 'number') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (type === 'turn/start') {
        const data = (event.data && typeof event.data === 'object') ? event.data : undefined
        openTurn = (data && data.turn !== undefined) ? data.turn : null
        openTurnStateKnown = true
      } else if (type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/**
 * Refuse to enter a compaction while one is already active — ported from the
 * official `assertCompactionInactive` + `assertNoActiveCompaction`.
 *
 * SEMANTICS (official):
 *   • An UNMATCHED `compaction/start` with NO later `session/end-seed` proves
 *     a transaction is genuinely in flight → throw `ManualCompactionError`-style
 *     rejection (here: return a descriptive string the caller logs and skips on).
 *   • An unmatched `compaction/start` PRECEDED by a LATER `session/end-seed` is
 *     a CONSTRUCTOR-INHERITED ORPHAN (persisted across a session resume whose
 *     reload reseeded the surface from a checkpoint). The official code IGNORES
 *     such a stale marker — it belongs to an earlier session lifecycle and must
 *     NOT wedge subsequent compactions.
 *   • `null` → no refusal (proceed).
 *
 * Our builtin transaction closes its bracket SYNCHRONOUSLY (four appends in a
 * row, no yielding), so a LIVE process can never observe its own in-flight
 * marker from another entry — the refusal only matters for the rare
 * corrupted-orphan case and for defensive double-entry suppression.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {string} stage operation label for the diagnostic (e.g. `'runTransaction'`).
 * @returns {string|null} a human-readable BUSY NOTE when refused, `null` to proceed.
 */
function assertNoActiveCompaction(session, stage) {
  const state = inspectCompactionEntryState((session && Array.isArray(session.events)) ? session.events : [])
  const { unmatchedCompactionStart, latestEndSeedSeq } = state
  if (unmatchedCompactionStart === undefined) return null
  if (latestEndSeedSeq !== undefined && latestEndSeedSeq > (unmatchedCompactionStart.seq ?? -1)) {
    // Inherited orphan cleared by a later end-seed boundary (constructor
    // reseed) — the official semantics explicitly ignore it.
    return null
  }
  return `${stage}: compaction already in progress; the session compaction lock is already active`
}

/** Whether an open compaction transaction is present (busy-lock check — kept for
 *  compatibility; now backed by the official entry-state inspection). */
function hasOpenFctLock(session) {
  return assertNoActiveCompaction(session, 'lockCheck') !== null
}

/** The turn number of the currently-open turn, or `null` (standalone/idle). */
function currentOpenTurn(session) {
  // Reads the latest turn bracket from the durable log to stamp `compaction/*`
  // events' `turn` field. Must never throw (it runs on every append/close): a
  // missing/non-array `events` or a non-object row degrades to `null` (no open
  // turn), matching the standalone/idle case.
  const events = (session && Array.isArray(session.events)) ? session.events : []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev === null || typeof ev !== 'object') continue
    if (ev.type === 'turn/start') {
      const data = (ev.data && typeof ev.data === 'object') ? ev.data : undefined
      return (data && data.turn !== undefined) ? data.turn : null
    }
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


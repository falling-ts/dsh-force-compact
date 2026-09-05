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

import { summarize, headerPrefix, frameSummary } from './summarizer.js'
import { selectEarliestByTokens, selectRetainingLatestTokens } from './region.js'
import { readSettings, DEFAULTS } from '../core/settings.js'
import { guardFn } from '../core/crashnet.js'
import { publishDone } from '../core/ui-signal.js'
import { sessionEvents, sessionEventAt, hasSessionEventStore } from '../core/session-events.js'

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
    console.log(`[force-compact] BUILTIN ENGINE LOADED — marker v2026-08-25-p0-p1-port `
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
 * livelock at its source. The cap is generous (1024 messages ≈ a substantial but
 * bounded window) so legitimate mid-size compactions still proceed; only
 * pathological whole-history replays are refused.
 */
const MAX_REPLAY_MESSAGES = 1024

// ---------------------------------------------------------------------------
// Official-estimator parity helpers (byte-mirrors of
// `deepseek-harness/packages/llm/token-meter/src/estimate.ts`).
//
// WHY THESE EXIST — the shadow-price protocol:
// `compaction/summary` records `shadowedTokenCount` as the HEURISTIC PRICE OF
// THE EXACT SURFACE RANGE IT SHADOWS. That figure rides the token-meter
// surface fold's "shadow-price claim" mechanism: the fold arms a pending claim
// from the summary event and settles it against the IMMEDIATELY FOLLOWING
// surface `replace` (delta = checkpoint estimate − claim tokens). Producers
// are required to price the claimed range under the SAME fixed estimator the
// fold prices appends with ("The counts are exact by construction"), so a
// claim priced under a divergent heuristic makes the fold OVER-subtract
// (undercount) or UNDER-subtract (overcount) the settled total. This port
// exists precisely so the shadow bill we write equals what the fold expects.
//
// Each helper below mirrors the official source line-for-line in plain JS:
//   • CHAR/BLOCK/ROLE overhead constants and `estimateContent` recursion
//     (text/reasoning ceil(len/4)+BLOCK; tool-call name+args+BLOCK;
//     tool-result recurse+BLOCK; unknown block JSON-stringified);
//   • `estimateHeaderParts` ≙ official `estimateHeader` (system ceil(len/4)+ROLE
//     when present; tools ceil(JSON len/4)+BLOCK when non-empty);
//   • `priceSurfaceNode` ≙ official `foldSurface` pricing
//     (user/user-message → message content; assistant/message → its content;
//     tool/result → content + ROLE overhead when content present; otherwise 0);
//   • `priceRegionFromMeasurement` ≙ official `prepareCompaction`'s
//     `selectedNodes.reduce((total, node) => total + node.tokens, 0)`.
// ---------------------------------------------------------------------------

const ESTIMATE_BLOCK_OVERHEAD = 4
const ESTIMATE_ROLE_OVERHEAD = 4

/** Port of official `estimateContent`: recursive block pricing under the fixed density heuristic. */
function estimateContentBlocks(blocks) {
  let tokens = 0
  if (!Array.isArray(blocks)) return tokens
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text === undefined || block.text === null ? '' : block.text).length / CHARS_PER_TOKEN) + ESTIMATE_BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name === undefined || block.name === null ? '' : block.name).length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments === undefined || block.arguments === null ? '' : block.arguments).length / CHARS_PER_TOKEN)
          + ESTIMATE_BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContentBlocks(Array.isArray(block.content) ? block.content : []) + ESTIMATE_BLOCK_OVERHEAD
        break
      default: {
        // Merge-extensible union: unknown block types retain a conservative
        // structural JSON price (official `default` arm).
        let json
        try {
          json = JSON.stringify(block)
        } catch {
          json = ''
        }
        tokens += ESTIMATE_BLOCK_OVERHEAD + Math.ceil(json.length / CHARS_PER_TOKEN)
        break
      }
    }
  }
  return tokens
}

/** Port of official `estimateHeader` (system + tools parts), plain-JS tolerant. */
function estimateHeaderTokens(header) {
  let total = 0
  if (header === null || typeof header !== 'object') return total
  const system = header.system
  if (typeof system === 'string' && system.length > 0) {
    total += Math.ceil(system.length / CHARS_PER_TOKEN) + ESTIMATE_ROLE_OVERHEAD
  }
  const tools = header.tools
  if (Array.isArray(tools) && tools.length > 0) {
    let json
    try {
      json = JSON.stringify(tools)
    } catch {
      json = ''
    }
    total += Math.ceil(json.length / CHARS_PER_TOKEN) + ESTIMATE_BLOCK_OVERHEAD
  }
  return total
}

/**
 * Port of the official surface-fold per-node pricing (`foldSurface`):
 *   • `user/message` / `user` → content blocks, NO role framing;
 *   • `assistant/message` → `data.message.content`, NO role framing;
 *   • `tool/result` → `data.message.content` + ROLE OVERHEAD when content present;
 *   • anything else → 0 (and it is not a priced surface node anyway).
 * All dereferences guarded so a malformed node degrades to 0 rather than throw.
 */
function priceSurfaceNode(event) {
  if (event === null || typeof event !== 'object') return 0
  const data = (event.data && typeof event.data === 'object') ? event.data : {}
  const type = event.type
  if (type === 'user/message' || type === 'user') return estimateContentBlocks(data.content)
  if (type === 'assistant/message') {
    const message = (data.message && typeof data.message === 'object') ? data.message : {}
    return estimateContentBlocks(message.content)
  }
  if (type === 'tool/result') {
    const message = (data.message && typeof data.message === 'object') ? data.message : {}
    if (message.content === undefined || message.content === null) return 0
    return estimateContentBlocks(message.content) + ESTIMATE_ROLE_OVERHEAD
  }
  return 0
}

/**
 * Port of official `prepareCompaction`'s shadow bill — sum the METER-PRICED
 * nodes covering exactly the requested seq range. Prefer the live meter
 * snapshot's per-node prices (`measurement.nodes`, each `{seq, tokens}`,
 * priced by the SAME estimator family the fold uses); fall back to pricing
 * the session log directly when the snapshot is unusable or does not cover
 * the range. Returns `null` when neither source can price the range, so the
 * CALLER decides whether to degrade (pre-check only) or fail-loud
 * (transaction commit — a summary with no priced claim poisons the fold).
 *
 * @param {object} session the durable session (for the direct-log fallback).
 * @param {object} region `{start, end}` inclusive SURFACE-NODE seq bounds.
 * @param {object|undefined} measurement the `tokenMeter.measure` snapshot.
 * @returns {number|null}
 */
function priceRegionFromMeasurement(session, region, measurement) {
  const events = sessionEvents(session)
  const surfaceNodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const firstIdx = surfaceNodes.indexOf(region.start)
  const lastIdx = surfaceNodes.lastIndexOf(region.end)
  if (firstIdx < 0 || lastIdx < firstIdx) return null
  const covered = surfaceNodes.slice(firstIdx, lastIdx + 1)
  const meterNodes = (measurement && Array.isArray(measurement.nodes)) ? measurement.nodes : null
  if (meterNodes !== null) {
    let total = 0
    let complete = true
    for (const seq of covered) {
      const node = meterNodes.find(n => n && typeof n === 'object' && n.seq === seq)
      if (node === undefined || node === null || typeof node.tokens !== 'number' || !Number.isFinite(node.tokens)) {
        complete = false
        break
      }
      total += node.tokens
    }
    if (complete) return total
  }
  let total = 0
  for (const seq of covered) {
    const event = events[seq]
    if (event === undefined || event === null || typeof event !== 'object') return null
    total += priceSurfaceNode(event)
  }
  return total
}

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
 * Mint a stable message identity for the checkpoint `user/message` payload.
 *
 * The `user/message` shape REQUIRES a non-empty `id` (and `role: 'user'`):
 * the load path (`adoptSessionEvent` → `assertMessageEventShape`) rejects an
 * entire log whose `user/message` lacks an identified message, while the
 * append path does NOT validate message shape (it only checks the surface
 * contract) — so a checkpoint written without an `id` commits fine but turns
 * the whole log corrupt on reload ("lacks an identified message"). The
 * official engine gets this for free from `createUserMessage(...)`; this
 * plain-JS engine cannot import that symbol, so it mints an equivalent bare
 * UUID. Deliberately no `fc-` prefix: `MessageId` is a plain string in the
 * core shape.
 */
function mintMessageId() {
  try {
    const crypto = globalThis.crypto
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/**
 * Run a standalone manual compaction over the agent's session (the `compactNow`
 * analogue): select a compactable region with the plugin's own policy, then run
 * the full transaction. Safe to call only when the agent is idle; a busy agent
 * or an already-active transaction is detected and returns `null`.
 *
 * MANUAL SELECTION SEMANTICS (OFFICIAL PARITY, P1): like the official
 * `selectCompactableRange(session, measure, 0)`, a command-driven manual entry
 * selects with `retainTokens=0` — a FULL-SURFACE head-anchored region — rather
 * than retaining the latest `settings.retainLatestTokens` tail. Only callers
 * that pass an explicit `opts` (or use the region-carrying `compactRegion`
 * path) keep the `retainLatestTokens` behavior; the default `compactNow`
 * without opts is treated as a manual command-driven entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortSignal} [signal]
 * @param {string} [sourceCommandId] the originating `/compact`/`/force-compact`
 *                                    command id, threaded into the lifecycle
 *                                    events and the checkpoint source (P1).
 * @param {object} [opts] optional overrides:
 *   - `retainTokens?: number` — explicit retention budget (default: 0 =
 *     full-surface manual selection). Pass `settings.retainLatestTokens` from
 *     the auto/pre-step paths to preserve the legacy "retain the latest N
 *     tokens" behavior.
 * @returns {Promise<object|null>} the compaction result, or `null` when skipped.
 */
// Internal body of `compactNowBuiltin` — routed through the crash-net wrapper
// so an unexpected throw escaping the internal guards becomes a durable,
// parseable diagnostic rather than a silent propagation up the call stack.
async function __compactNowBuiltinBody(ctx, agent, signal, sourceCommandId, opts) {
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

  // MANUAL SELECTION (official `selectCompactableRange(…, 0)` parity): when no
  // explicit `opts.retainTokens` is supplied, treat this as a command-driven
  // manual entry and select the FULL surface (retain 0). Auto/pre-step/idle
  // callers MUST pass `opts: { retainTokens: settings.retainLatestTokens }`
  // (see hooks/guard.js + hooks/idle.js) to preserve the legacy "retain the
  // latest N tokens" behavior they historically relied on.
  const retainTokens = (opts !== undefined && typeof opts === 'object' && Number.isFinite(opts.retainTokens))
    ? Math.max(0, Math.round(opts.retainTokens))
    : 0
  const region = selectHeadAnchoredRegion(settings, session, measurement, retainTokens)
  if (region === null) {
    // Diagnose WHY: report the surface-node count and how much of it is already
    // checkpoint material. The typical "nothing worth compacting" case is a
    // session whose head IS a previously-generated checkpoint (small, not
    // worth re-summarizing) — re-running /force-compact right after a
    // successful compaction is the classic trigger.
    const surfNodes = (session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
    let headIsCheckpoint = false
    if (surfNodes.length > 0 && hasSessionEventStore(session)) {
      const headEvent = sessionEventAt(session, surfNodes[0])
      const headSource = headEvent && headEvent.data && typeof headEvent.data === 'object' ? headEvent.data.source : undefined
      headIsCheckpoint = !!(headSource && typeof headSource === 'object' && headSource.plugin === 'force-compact-builtin')
    }
    info(ctx,
      `${session.id}: builtin compaction — no compactable region; skipping `
      + `(${surfNodes.length} surface nodes, head=${headIsCheckpoint ? 'previous checkpoint' : 'ordinary history'}, `
      + `estimated ~${estimateSurfaceTokens(session)} surface tokens, retainTokens=${retainTokens})`,
    )
    return null
  }

  return runTransaction(ctx, agent, session, region, signal, settings, sourceCommandId, measurement)
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
 * @param {string} [sourceCommandId] optional originating-command id, threaded
 *                                    into the lifecycle events + checkpoint
 *                                    source (mirrors official `compactRegion`
 *                                    taking a 5th positional arg).
 * @returns {Promise<object|null>} the compaction result, or `null` when aborted/skippedped.
 */
// Internal body of `compactRegionBuiltin` — routed through the crash-net wrapper.
async function __compactRegionBuiltinBody(ctx, start, end, agent, signal, sourceCommandId) {
  const session = agent.session
  if (session === undefined || typeof session.append !== 'function') return null
  const settings = (await readSettings(ctx)) ?? DEFAULTS
  if (!(settings.builtinEnabled !== false)) return null
  if (start > end) return null
  return runTransaction(ctx, agent, session, { start, end }, signal, settings, sourceCommandId)
}

/** Public entries — wrapped by the universal crash net. */
export const compactNowBuiltin = guardFn('builtin.compactNowBuiltin', __compactNowBuiltinBody)
export const compactRegionBuiltin = guardFn('builtin.compactRegionBuiltin', __compactRegionBuiltinBody)

/**
 * The core transaction: append the durable bracket + a replace node shadowing
 * the region. Every step is guarded; any failure appends `compaction/end` with
 * an `error` and returns `null` (leaving exactly one closed-or-orphaned marker
 * pair so the log stays interpretable on reload).
 *
 * SOURCE COMMAND ID (OFFICIAL PARITY, P1): an optional originating-command id
 * (from `/compact` / `/force-compact`) is threaded into ALL THREE lifecycle
 * events (`compaction/start` / `compaction/summary` / `compaction/end`) AND
 * the hand-built checkpoint `source` object. The official `invariant`
 * listener validates that all three bracket events carry IDENTICAL
 * `sourceCommandId` values — so threading one value everywhere is mandatory,
 * not optional. When `undefined`, the field is omitted from all payloads and
 * the source carries only `{kind,plugin,compactionId}` (backward compatible).
 *
 * FLUSH (OFFICIAL PARITY, P0): after a SUCCESSFUL `compaction/end` close, the
 * transaction invokes `sessions.flush(session)` when available (best-effort —
 * a missing/unusable service degrades to a deferred-flush-risk note rather
 * than a fatal error). This mirrors the official `compactSurfaceRegion`
 * behavior (`if (closed && options.flush !== undefined) await options.flush()`
 * inside a try/catch that surfaces failures as `CompactionError({cause})`).
 * The awaited `session/flush` checkpoint in `index.js` ALREADY covers the
 * lifetime of a successful transaction for most call sites — an explicit flush
 * here is belt-and-braces for the command-driven entry (where the caller
 * expects durability BEFORE returning) and the busy-pre-step consume path.
 */
async function runTransaction(ctx, agent, session, region, signal, settings, sourceCommandId, measurementArg) {
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
    // NO REJECTION (2026-09 spec: "never reject after trigger; compact directly
    // and keep compacting until below the threshold"). The cooldown note is
    // surfaced for OBSERVABILITY ONLY — it explains WHY recent summarizations on
    // this session have failed (e.g. a hung 90s stream on a slow local endpoint)
    // but it no longer suppresses this attempt. The guard loop (hooks/guard.js)
    // now `continue`s past a failed/empty round and retries, so a failing span
    // no longer parks the session above the threshold for up to 180s.
    info(ctx, `${session.id}: builtin compaction — note: ${cooledNote} (NOT skipping — retrying per the no-rejection policy)`)
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
  // cycle "attempt giant prompt → shrink-gate veto → blanket → re-attempt the
  // identical doomed span every step".
  // NOTE: the post-summary SHRINK GATE still applies to everything that
  // passes this pre-check — it remains the authoritative defense.
  const projected = projectRegion(session, region)
  const messages = projected.messages
  const shadowedSeqs = projected.shadowedSeqs
  if (messages.length === 0) {
    info(ctx, `${session.id}: builtin compaction — region has no surface messages; skipping`)
    return null
  }

  // ---- Shadow bill — OFFICIAL shadow-price protocol parity -----------------
  // Price the EXACT surface range being shadowed under the meter's estimator
  // family (per-node prices from the same snapshot the selection was cut
  // from, falling back to a direct price of the log), so the claim the
  // token-meter fold settles against our `compaction/summary` event
  // subtracts the TRUE cost of the replaced span. See the estimator-parity
  // block above for the mirrored official sources.
  const measurement = (measurementArg && typeof measurementArg === 'object' && Array.isArray(measurementArg.nodes))
    ? measurementArg
    : (typeof meter.measure === 'function' ? (() => { try { return meter.measure(session) } catch { return undefined } })() : undefined)
  let regionPrice
  try {
    regionPrice = priceRegionFromMeasurement(session, region, measurement)
  } catch (error) {
    // Unresolvable surface state — degrade gracefully (refuse to commit, see
    // the null branch) rather than propagate out of the transaction.
    warn(ctx, `${session.id}: builtin compaction — region pricing threw (${messageOf(error)}); refusing to commit`)
    regionPrice = null
  }
  if (regionPrice === null) {
    // Cannot price the claimed range under any caliber (snapshot unusable AND
    // the log cannot be resolved): writing a summary WITHOUT a correct shadow
    // bill would make the fold settle a bogus claim, so refuse to commit
    // rather than poison the persisted projection. Best-effort degradation:
    // the next attempt with a fresh snapshot re-prices cleanly.
    warn(ctx, `${session.id}: builtin compaction ABORTED — could not price region seq[${region.start}..${region.end}] `
      + `against the shadow-price protocol (meter snapshot unusable and direct log pricing failed); refusing to commit`)
    return null
  }
  const shadowedTokenCount = regionPrice


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
  // `sourceCommandId` (P1): the originating `/compact`/`/force-compact` command
  // id, threaded conditionally — OMITTED when `undefined` so the event stays
  // backward-compatible with readers that predate the field (exact mirror of
  // the official `region.ts` conditional spread). All three bracket events
  // (start / summary / end) MUST agree on this value — the official invariant
  // listener enforces it.
  const compactionId = mintCompactionId()
  let startEvent
  try {
    startEvent = session.append('compaction/start', {
      compactionId,
      turn: currentOpenTurn(session),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
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
    // AUDIT LOG (2026-08 addition): state the thinking-scoping DECISION at the
    // moment the `disableThinking` setting is READ and routed into `extra`.
    // One line per summarization attempt (NOT per model request — this is the
    // compaction path only), so the log doubles as the durable answer to
    // "did this compaction carry thinking-off?" without needing the wire trace.
    info(ctx, `${session.id}: compaction thinking-policy — settings.disableThinking=${settings.disableThinking} → extra.reasoningEffort=${settings.disableThinking ? "'off' (this summarization call carries thinking-OFF)" : '(unset — summarization call RIDES MACHINE DEFAULT, no thinking override)'}`)
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
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
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

  // P0 — OFFICIAL FRAMING: wrap the summary BLOCKS (not a joined blob) in
  // `CHECKPOINT_PREAMBLE` + `<compacted-summary>` tags block-wise, byte-mirror
  // of the official `frameSummary` — so a future prior-checkpoint merge finds
  // the structured region the instruction tells the LLM about ("keep the parts
  // still true, drop the expired, fold in the newer") instead of an untagged
  // free-form paragraph.
  const checkpointContent = frameSummary(summaryBlocks)
  const checkpointSourceData = {
    ...CHECKPOINT_SOURCE_BASE,
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  }
  let replaceEvent
  try {
    replaceEvent = session.append('user/message', {
      // `id` + `role` are MANDATORY on the `user/message` payload — see
      // `mintMessageId` for why the checkpoint must carry an identified
      // message even though the append path does not enforce it.
      id: mintMessageId(),
      role: 'user',
      content: checkpointContent,
      source: Object.freeze(checkpointSourceData),
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
      // P1 — same conditional spread as start/summary: the third bracket must
      // agree with the first two (`compaction/invariant` enforces it).
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    })
    endSeq = endEvent.seq
  } catch {
    // Non-fatal: the summary already landed durably; the missing end marker is
    // tolerated as a (rarely orphaned) lock on next reload.
    info(ctx, `${session.id}: builtin compaction — warning: could not append compaction/end (lock may appear open on next reload)`)
  }

  // P0 — DURABILITY FLUSH AFTER `compaction/end` (mirror of the official
  // `compactSurfaceRegion` `if (closed && flush) await flush()` tail). The
  // transaction's four appends are durable by construction, but a command-
  // driven caller (`/force-compact`) expects the on-disk state to be settled
  // BEFORE it returns "Compacted N…". The awaiting `session/flush` checkpoint
  // in `index.js` already covers the idle/auto call sites; this is belt-and-
  // braces for the others. BEST-EFFORT by design: unlike the official engine
  // (which has a typed `CompactionError` to escalate a flush rejection into —
  // deliberately NOT ported, out of scope) we degrade to a WARN and ignore,
  // so a flaky or missing `sessions` service can never turn a SUCCESSFUL
  // committed compaction into a visible failure.
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessions.flush === 'function') {
    try {
      await sessions.flush(session)
    } catch (flushFailure) {
      warn(ctx, `${session.id}: builtin compaction — best-effort session/flush after compaction/end failed (ignored): ${messageOf(flushFailure)}`)
    }
  }

  // A successful compaction clears ANY residual failure cooldown for this
  // session so the NEXT idle tick isn't suppressed by a stale mark.
  clearFailureCooldown(session.id)
  info(ctx, `${session.id}: builtin compaction OK — replaced span seq[${targetRange?.start}..${targetRange?.end}] (${shadowedSeqs?.length} nodes, ~${shadowedTokenCount} tokens) with a ${summaryTextLen}-char checkpoint`)
  // LIVE UI SIGNAL — pin GREEN "[压缩完成!]" NOW that the compaction RESULT is
  // durable: the four-bracket transaction has committed (span shadowed + checkpoint
  // appended), the durability flush above has settled, and the failure cooldown is
  // cleared. This is the ONE authoritative "compaction result landed in the session"
  // boundary, so we emit DONE HERE regardless of WHICH path initiated the compaction
  // (idle / checkpoint / manual / threshold). `publishDone` swallows its own failures
  // (see ui-signal.js) so a messenger hiccup can never disturb the committed outcome
  // returned below. Callers' own `publishDone` sites remain as harmless duplicates
  // (idempotent — republishing the same pinned green payload is a no-op visually).
  try {
    await publishDone(ctx)
  } catch { /* publisher is self-contained; a throw here would corrupt a committed tx */ }
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
    // P1 — echo the originating command id for observability (conditional
    // spread keeps the key ABSENT for non-command-driven transactions so the
    // result shape matches pre-port behavior for those paths).
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
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
  const events = sessionEvents(session)
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
 * Select a head-anchored compactable region — the SINGLE SELF-SELECTOR for
 * `compactNow` (manual command entry AND idle/auto entry alike). Called from
 * {@link __compactNowBuiltinBody} ONLY — region-carrying callers (the
 * `/force-compact` busy-queue consumption and the `session/flush`
 * checkpoint path) always route their OWN span through `compactRegion` and
 * never enter this helper.
 *
 * Manual-vs-auto DISTINCTION (via the OPTIONAL 4th argument, mirroring the
 * official engine's "explicit opts ⇒ caller supplies its own selection"):
 *   • MANUAL entry (`/force-compact`, owner `null`) leaves `opts` undefined →
 *     `__compactNowBuiltinBody` computes `retainTokens = 0` → this helper
 *     receives `retainOverride = 0` → the meter branch delegates to
 *     `selectRetainingLatestTokens(session, 0, measurement)`, whose internal
 *     `budget = max(1, …)` clamp means the tail walk retains effectively
 *     NOTHING and the compactable span becomes the ENTIRE head up to the
 *     pairing-balanced boundary NEAR THE TAIL — the official "full-head"
 *     manual-compaction behavior.
 *   • AUTO / IDLE entry (`agent/status` idle transition, `session/flush`)
 *     OPTS INTO legacy semantics by passing
 *     `opts: { retainTokens: settings.retainLatestTokens }` → the helper
 *     receives that finite override → retain-the-latest-N-tokens behavior
 *     unchanged from pre-port.
 *   • `retainOverride` left `undefined` WITHOUT the caller specifying it (a
 *     future caller that wants the configured default) falls back to
 *     `settings.retainLatestTokens` — preserving the historical default.
 *
 * Pricing fidelity (two branches converging on the same rule): when a
 * reliable `meter.measure` snapshot IS available (nodes array present with ≥
 * 2 entries), both the compactable prefix AND the retained tail are priced
 * from that single authoritative snapshot via
 * {@link selectRetainingLatestTokens} — one `measure()` call, consistent
 * calibration end-to-end (NOT a divergent char/4 estimate of flat text,
 * which systematically UNDERCOUNTS nested tool blocks / JSON framing and
 * starved the head budget — the observed "/force-compact → no compactable
 * range" cause). WITHOUT such a snapshot, fall back to a char heuristic:
 * price the surface sum (4 chars/token),
 * `headBudget = max(0, surfaceSum − retain)`, and hand that head budget to
 * {@link selectEarliestByTokens} (it walks from the head until the running
 * sum reaches the budget).
 *
 * Boundary snapping: whichever branch selects the span ENDS it at a
 * TOOL-PAIRING BALANCED position (official pairing-ledger criterion via
 * `core/pairing.js` — any cut-after with zero unanswered tool calls, a
 * strict superset of the historical `user/message` boundary) so the
 * compacted span never splits a tool call/result pair.
 *
 * Edge cases: with a meter snapshot, `selectRetainingLatestTokens` itself
 * reports `null` when the retained tail consumes the whole window (fewer
 * than 2 nodes, or `tailStartIdx <= 0`); with the legacy fallback, if the
 * char-estimated surface sum is smaller than the retention budget (very
 * short session), the head budget clamps to zero and no region results.
 *
 * @param {object} settings resolved plugin settings (used ONLY when `retainOverride` is undefined).
 * @param {object} session live session handle.
 * @param {object|undefined} measurement fresh `tokenMeter.measure(session)` snapshot.
 * @param {number|undefined} [retainOverride] ABSOLUTE tokens to retain at the
 *   tail. `0` (the manual-command default) ⇒ full-head region. Finite
 *   positive values ⇒ legacy retain-latest behavior. `undefined` ⇒ fall
 *   back to `settings.retainLatestTokens` (historical default for any
 *   caller that doesn't specify).
 * @returns {{start:number,end:number}|null} head-anchored span, or `null`.
 */
function selectHeadAnchoredRegion(settings, session, measurement, retainOverride) {
  const retain = retainOverride !== undefined && Number.isFinite(retainOverride)
    ? Math.max(0, Math.round(retainOverride))
    : (Number.isFinite(settings.retainLatestTokens)
      ? Math.max(0, Math.round(settings.retainLatestTokens))
      : 0)
  // PRIMARY (mirror of the auto path): price from the meter's own per-node
  // snapshot — the node-pricing source shared with the threshold gate's
  // retained-tail selector (whose SCALAR pressure basis is now the
  // projection's `projectedTokens`, the exact figure the harness renders in
  // the bottom-right corner).
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
  const events = sessionEvents(session)
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
  const events = sessionEvents(session)
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
  const state = inspectCompactionEntryState(sessionEvents(session))
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

/**
 * Whether the given session currently has an ACTIVE (in-flight) compaction —
 * an unmatched `compaction/start` bracket that no later `session/end-seed` has
 * cleared. Exported for the per-model-request guard, which uses it to tell a
 * GENUINE in-progress `[强制压缩中>>>]` banner (leave it alone) apart from
 * STALE residue left behind by a compaction that never committed (safe to
 * override with a fresh working pair). Backed by the same official entry-state
 * inspection as {@link hasOpenFctLock}. Never throws (a malformed session
 * degrades to `false`, so the guard's UI clear is never blocked).
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {boolean}
 */
export function isCompactionActive(session) {
  try {
    return hasOpenFctLock(session)
  } catch {
    return false
  }
}

/** The turn number of the currently-open turn, or `null` (standalone/idle). */
function currentOpenTurn(session) {
  // Reads the latest turn bracket from the durable log to stamp `compaction/*`
  // events' `turn` field. Must never throw (it runs on every append/close): a
  // missing/non-array `events` or a non-object row degrades to `null` (no open
  // turn), matching the standalone/idle case.
  const events = sessionEvents(session)
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


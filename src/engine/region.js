/**
 * dsh-force-compact's own region selection, modeled on the official
 * `compaction-basic` region selection. A head-anchored span that retains a
 * recent tail verbatim and ends on a TOOL-PAIRING BALANCED surface boundary —
 * verified with the official pairing ledger (`core/pairing.js`), not assumed
 * from a coarse `user/message` heuristic. Balanced cuts include any surface
 * position with zero unanswered tool calls, so the delegated `compactRegion`
 * never rejects the chosen bounds for unpaired tool calls.
 *
 * @module @falling-ts/dsh-force-compact/region
 */

import { guardFn } from '../core/crashnet.js'
import {
  toolPairingBalancedAfterSafe,
  toolPairingBalancedBeforeSafe,
} from '../core/pairing.js'

/**
 * Select the compactable region for a session.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {Readonly<object>} config
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null` when there is nothing worth compacting.
 */
// Internal body of `selectRegion` — routed through the crash-net wrapper.
function __selectRegionBody(session, config) {
  // A malformed surface (missing `session.surface` / non-array `nodes`) yields
  // nothing to compact — return null rather than throw.
  const nodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const total = nodes.length
  if (total < config.minNodes) return null

  // Retain a recent tail (by surface-node count); the compactable prefix is everything before it.
  const retainCount = Math.max(1, Math.round(total * config.retainRatio))
  let keepFromIdx = total - retainCount
  if (keepFromIdx < 1) return null

  // Walk the tail boundary back to the NEAREST PRECEDING TOOL-PAIRING BALANCED
  // position — the official criterion (ledger in `core/pairing.js`: cut-before
  // the node at `keepFromIdx` is balanced iff zero tool calls straddle it).
  // Any balanced position works, not only `user/message` nodes — such nodes
  // are merely the historically used sufficient subset.
  while (keepFromIdx > 1 && !toolPairingBalancedBeforeSafe(session, nodes[keepFromIdx])) {
    keepFromIdx -= 1
  }
  if (keepFromIdx < 2) return null

  const compactableCount = keepFromIdx - 1
  if (compactableCount < config.minCompactableNodes) return null

  // The compactable PREFIX is indices [0 .. keepFromIdx-2]. Emit its bounds as
  // the MIN and MAX SEQ BY VALUE (not by array position). After a prior
  // checkpoint REPLACES earlier nodes but APPENDS the new checkpoint node at a
  // later log position, the surviving early nodes keep their ORIGINAL (higher)
  // seqs at HIGHER array indices than the checkpoint — so `surface.nodes` is
  // NOT necessarily in ascending-seq order. Reading `nodes[0]` / `nodes[i]`
  // directly could therefore yield `start > end` (an INVERTED span), which
  // downstream `compactRegion` rejects or mishandles. Taking the value-extremes
  // guarantees `start <= end`, and the region still denotes the same leading
  // segment of the projection (bounds are inclusive index segments interpreted
  // by the session core, so the seq ORDERING within the segment is irrelevant).
  // Snap the OUTWARD bounds to TOOL-PAIRING BALANCED positions so the
  // replacement stays balanced: the LEADING position's cut-before must be
  // balanced (trivially satisfied at position 0) and the TRAILING position's
  // cut-after must be balanced (zero tool calls left dangling). Widen `start`
  // downward / shrink `end` upward within the prefix to the nearest balanced
  // positions; when neither bound can be made balanced (degenerate prefix),
  // fall back to the raw value extremes so a valid span is preserved.
  const prefix = nodes.slice(0, keepFromIdx - 1)
  let start = Infinity
  let end = -Infinity
  for (const seq of prefix) {
    if (seq < start) start = seq
    if (seq > end) end = seq
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  let snappedStart = start
  let snappedEnd = end
  // Leading bound: shrink the leading segment until its first node's cut-BEFORE
  // is balanced (at position 0 this is trivially true).
  let startIdx = 0
  while (startIdx < prefix.length && !toolPairingBalancedBeforeSafe(session, prefix[startIdx])) {
    startIdx += 1
  }
  if (startIdx < prefix.length) snappedStart = prefix[startIdx]
  // Trailing bound: pull the tail inward until the last node's cut-AFTER is
  // balanced (any `user/message` position qualifies; so do tool-boundary-closed
  // positions such as a finished step's last node).
  let endIdx = prefix.length - 1
  while (endIdx > startIdx && !toolPairingBalancedAfterSafe(session, prefix[endIdx])) {
    endIdx -= 1
  }
  snappedEnd = prefix[endIdx]
  if (snappedStart > snappedEnd) return null
  return { start: snappedStart, end: snappedEnd }
}

/** Public entry — wrapped by the universal crash net. */
export const selectRegion = guardFn('region.selectRegion', __selectRegionBody)



/**
 * Validate one requested surface-position span — ported from the official
 * `compaction-basic` `validateSurfaceRegion`. Rejects (throws) when either
 * bound is not a CURRENT SURFACE NODE, the ordering is inverted by INDEX, or
 * either bound's tool-pairing balance check fails (the official fail-loud
 * behaviour: a candidate that would split a step's tool-call/result pair is
 * refused BEFORE any expensive summarization begins).
 *
 * Plugin adaptation: our builtin transaction validates bounds through
 * {@link validateReplacementBounds} (non-throwing, `null` on invalid) right
 * before the replace append — that path also cross-checks that the bounds land
 * on current surface nodes. This exported validator adds the PAIRING checks on
 * top, mirroring the official double-gate.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} start the first surface-node seq (inclusive).
 * @param {number} end the last surface-node seq (inclusive).
 * @returns {{start: number, end: number, startIdx: number, endIdx: number, shadowedSeqs: number[]}}
 * @throws {Error} when the span is malformed or unbalanced (official semantics).
 */
// Internal body of `validateSurfaceRegion` — routed through the crash-net wrapper.
function __validateSurfaceRegionBody(session, start, end) {
  const surfaceNodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const startIdx = surfaceNodes.indexOf(start)
  const endIdx = surfaceNodes.lastIndexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`)
  }
  // Official double gate: BOTH bounds must sit on tool-pairing balanced cuts,
  // verified with the precise per-event ledger (not the coarse user-message
  // assumption). The SAFE variants determine a corrupt-surface ledger failure
  // as "balanced", so a damaged log degrades to the session core's own replace
  // validation (its final line of defense) instead of wedging selection forever.
  if (!toolPairingBalancedBeforeSafe(session, surfaceNodes[startIdx])) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfterSafe(session, surfaceNodes[endIdx])) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }
  return {
    start,
    end,
    startIdx,
    endIdx,
    shadowedSeqs: surfaceNodes.slice(startIdx, endIdx + 1),
  }
}

/**
 * Safe variant of {@link __validateSurfaceRegionBody} for hot paths: identical
 * math, but ANY throw (unknown bound, inverted span, unbalanced cut, corrupt
 * surface) resolves to `null` instead of propagating — callers skip the
 * doomed compaction instead of crashing the trigger path. Mirrors the way the
 * official code routes `validateSurfaceRegion` rejections into a clean
 * `SurfaceChangedError`.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} start
 * @param {number} end
 * @returns {{start: number, end: number, startIdx: number, endIdx: number, shadowedSeqs: number[]} | null}
 */
// Public entries — wrapped by the universal crash net.
export const validateSurfaceRegion = guardFn('region.validateSurfaceRegion', __validateSurfaceRegionBody)
export const validateSurfaceRegionSafe = ((session, start, end) => {
  try {
    return validateSurfaceRegion(session, start, end)
  } catch {
    return null
  }
})

/**
 * Select the **earliest** `ratio` fraction of a **token meter measurement** as
 * a head-anchored region to compact — the preferred, same-caliber variant of
 * {@link selectEarliestByTokens}.
 *
 * Why this exists: the naive {@link selectEarliestByTokens} prices each node
 * with its own char/4 heuristic on FLAT surface text only, which systematically
 * UNDERCOUNTS relative to the gate's `totalTokens` (that figure includes the
 * system-prompt + tools schema header, nested tool blocks, and JSON framing).
 * Budgeting against the large `totalTokens` but accumulating a much smaller
 * flat-text total means the budget is never met and the final boundary snap
 * fails — so the selector returns `null` ("no earliest region") and the
 * compaction silently gives up. Feeding it the meter's OWN per-node prices
 * (each node's `tokens` comes from the same `estimateMessage` that feeds
 * `totalTokens`) makes the accumulation reachable and the boundary well-defined.
 *
 * The walk is POSITIONAL over the ordered `measurement.nodes` (model-visible
 * head-to-tail order, as maintained by the meter's surface fold) rather than by
 * `seq` value: after a committed compaction the checkpoint node sits at a higher
 * seq than some surviving early nodes, so nodes are NOT guaranteed ascending by
 * seq. Positional order IS the meaningful "earliest-first" order. Once the
 * running total meets the `totalTokens * ratio` budget, the span's **end** is
 * walked BACKWARD to the NEAREST PRECEDING TOOL-PAIRING BALANCED position
 * (verified with the official pairing ledger — a superset of `user/message`
 * positions; the historical heuristic snapped to `user/message` only because
 * such positions were believed sufficient, never necessary). Returns `null`
 * when there is not enough surface to compact.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} ratio a fraction in (0, 1].
 * @param {Readonly<{
 *   totalTokens: number,
 *   nodes: ReadonlyArray<{ seq: number, tokens: number }>,
 * }>} measurement a `tokenMeter.measure(session)` snapshot; `nodes` is the
 *   ordered per-node pricing and `totalTokens` is the figure to budget against.
 * @param {number} [maxRegionNodes] a hard ceiling on the NUMBER OF SURFACE NODES
 *   the returned region may span (positional, from the head). When the
 *   token-derived 0.ratio crossing point lands beyond this many nodes — typical
 *   for a large `ratio` like 0.7 on a long, tool-heavy conversation — the
 *   region is CLAMPED DOWN to the largest head-aligned prefix that fits under
 *   the cap AND ends on a TOOL-PAIRING BALANCED boundary (official pairing
   ledger — any cut-after-balanced node, not only `user/message`).
   Rationale: the builtin
 *   summarization engine refuses regions whose projected message count exceeds
 *   its replay cap; clamping here (rather than refusing there) GUARANTEES a
 *   committable region on every threshold trip so the auto-gate never livelocks
 *   and the context can actually be pulled back down. Multiple successive gates
 *   chip away the head until the session settles below the threshold.
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null`.
 */
// Internal body of `selectEarliestByMeasurements` — routed through the
// crash-net wrapper.
function __selectEarliestByMeasurementsBody(session, ratio, measurement, maxRegionNodes) {
  const nodes = (measurement && Array.isArray(measurement.nodes) && measurement.nodes.length > 0)
    ? measurement.nodes
    : []
  const total = nodes.length
  if (total < 2) return null
  const clampedRatio = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0.01), 1) : 0.5

  // Same caliber as the accumulation: budget from the SAME measurement whose
  // nodes we accumulate. Fall back to the sum of the nodes' own prices when
  // `totalTokens` is absent/malformed so the budget always stays reachable.
  const nodeSum = nodes.reduce((acc, n) => acc + (Number(n.tokens) > 0 ? Number(n.tokens) : 0), 0)
  const totalTokens = (typeof measurement.totalTokens === 'number' && Number.isFinite(measurement.totalTokens) && measurement.totalTokens > 0)
    ? measurement.totalTokens
    : nodeSum
  const budget = Math.max(1, Math.round(totalTokens * clampedRatio))

  // Upper positional bound on the region span: the smallest of (a) the last
  // node, (b) the token-crossing point, (c) the optional node-count cap. All
  // expressed as an INDEX into `nodes`. We then snap THAT index backward to the
  // nearest PRECEDING TOOL-PAIRING BALANCED position BELOW it (ledger-verified
  // END — any cut-after-balanced node, not only `user/message`), which may
  // bring the span further inward.
  const capBound = (Number.isFinite(maxRegionNodes) && maxRegionNodes > 0)
    ? Math.min(total, Math.ceil(maxRegionNodes)) - 1
    : total - 1

  // Accumulate node-by-node (positional) until the budget is met OR the capped
  // bound is reached, whichever comes FIRST.
  let accumulated = 0
  let endIdx = Math.min(capBound, total - 1)
  for (let i = 0; i <= endIdx; i += 1) {
    accumulated += Number(nodes[i].tokens) > 0 ? Number(nodes[i].tokens) : 0
    if (i <= capBound && accumulated >= budget) {
      endIdx = i
      break
    }
  }

  // Snap the span's end BACKWARD to the nearest PRECEDING TOOL-PAIRING
  // BALANCED position at or before the crossing point so the compacted span
  // ends balanced (official criterion — a strict superset of the old
  // `user/message` heuristic: any node whose cut-after carries zero
  // unanswered tool calls). Walking backward keeps the span WITHIN the cap.
  // If no preceding balanced position exists, fall back to the raw crossing
  // point so a valid region is preserved.
  let settled = endIdx
  while (settled > 0 && !toolPairingBalancedAfterSafe(session, nodes[settled].seq)) {
    settled -= 1
  }
  const endNode = nodes[settled]
  const startNode = nodes[0]
  if (startNode === undefined || endNode === undefined) return null
  const start = startNode.seq
  const end = endNode.seq
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start === end) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/**
 * Select a **tail-retained** region to compact using the TOKEN METER'S OWN
 * per-node prices — the successor to {@link selectEarliestByMeasurements}'s
 * ratio-of-total budgeting.
 *
 * Semantics (per the user-facing policy knob `retainLatestTokens`): starting
 * FROM THE LATEST ENTRY of the measurement's `nodes` (the ordered
 * model-visible head-to-tail surface, exactly the caliber that feeds
 * `totalTokens`), ACCUMULATE node tokens BACKWARD (newest → oldest) until the
 * accumulated sum REACHES OR EXCEEDS `retainLatestTokens` (stop condition:
 * `>=`). Because a node cannot be split, the retained tail may overshoot
 * `budget` by UP TO ONE node's weight — that is the closest achievable
 * "exactly N" boundary given the discrete node granularity. The cutoff CUT
 * POINT splits the window: nodes BEFORE the first fully-retained node form
 * the head-anchored SPAN TO COMPACT (sent to the summarizer as one batch;
 * the original span entries become shadowed / skipped in derived history).
 * The cutoff is then SNAPPED BACKWARD to the nearest PRECEDING TOOL-PAIRING
 * BALANCED position (cut-after-node semantics, verified with the official
 * pairing ledger rather than assumed from a `user/message` heuristic) so the
 * compacted span ends at a balanced, tool-call-safe point — the same
 * invariant the other selectors maintain.
 *
 * Why this supersedes ratio-of-total: budgeting the RETAINED side against a
 * FIXED absolute token amount (not `totalTokens × ratio`) decouples the cut
 * from provider-usage inflation baked into `totalTokens` — the exact
 * divergence that made `autoEarliestRatio` regions undersized against an
 * inflated denominator (observed live: total=71270 dominated by a usage
 * baseline of 61818 left the head region unable to ever reach below threshold
 * no matter how well it summarized).
 *
 * Boundary cases:
 * - `retainLatestTokens <= 0` → clamp to 1 node minimum retained (never
 *   compact the whole surface in one pass).
 * - The retained tail ALREADY reaches the budget at the VERY LAST node
 *   (single huge trailing node ≥ budget) → nothing left to compact: `null`.
 * - Fewer than 2 nodes total → `null`.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} retainLatestTokens the absolute TOKEN COUNT to RETAIN at the
 *   latest end of the surface. Positive integer.
 * @param {Readonly<{
 *   nodes: ReadonlyArray<{ seq: number, tokens: number }>,
 * }>} measurement a `tokenMeter.measure(session)` snapshot whose `nodes` are
 *   the ordered per-node prices.
 * @returns {{start: number, end: number, retainedTokens: number} | null} the
 *   head-anchored span to compact plus the actual retained tail's token sum,
 *   or `null` when there is not enough surface to compact.
 */
// Internal body of `selectRetainingLatestTokens` — routed through the
// crash-net wrapper.
function __selectRetainingLatestTokensBody(session, retainLatestTokens, measurement) {
  const nodes = (measurement && Array.isArray(measurement.nodes) && measurement.nodes.length > 0)
    ? measurement.nodes
    : []
  const total = nodes.length
  if (total < 2) return null
  const budget = (Number.isFinite(retainLatestTokens) && retainLatestTokens > 0)
    ? Math.max(1, Math.floor(retainLatestTokens))
    : 1

  // Walk FROM THE TAIL toward the head, accumulating node tokens. Stop as soon
  // as the accumulated sum reaches OR EXCEEDS `budget` (the `>=` stop rule).
  // The first node included in the accumulated tail is the cutoff point:
  // everything STRICTLY BEFORE it (positionally) is compacted. Because a node
  // cannot be split, the retained tail may overshoot `budget` by UP TO ONE
  // node's weight — that is the closest achievable "exactly N" boundary.
  const events = (session && Array.isArray(session.events)) ? session.events : []
  let acc = 0
  let tailStartIdx = total // exclusive: index just AFTER the last retained node
  let crossingAccBefore = -1 // accumulator value JUST BEFORE the crossing node was added (-1 when the walk consumed the whole window)
  let crossingNodeSize = -1 // size of the node that pushed the accumulator over budget
  let crossingAccAfter = -1 // accumulator value AFTER the crossing node was added
  for (let i = total - 1; i >= 0; i -= 1) {
    tailStartIdx = i
    const t = Number(nodes[i].tokens) > 0 ? Number(nodes[i].tokens) : 0
    const before = acc
    acc += t
    if (acc >= budget) {
      crossingAccBefore = before
      crossingNodeSize = t
      crossingAccAfter = acc
      break
    }
  }
  // The tail occupied indices [tailStartIdx .. total-1]; the compactable
  // prefix occupies [0 .. tailStartIdx-1]. Need at least one node to compact.
  if (tailStartIdx <= 0) return null

  // Snap to the nearest PRECEDING TOOL-PAIRING BALANCED position (official
  // criterion via the `core/pairing.js` ledger — a strict superset of the
  // old `user/message` heuristic: any node whose cut-after carries zero
  // unanswered tool calls). No balanced position in the prefix → keep the raw
  // crossing index so a valid region survives.
  let endIdx = tailStartIdx - 1
  while (endIdx > 0 && !toolPairingBalancedAfterSafe(session, nodes[endIdx].seq)) {
    endIdx -= 1
  }
  const endNode = nodes[endIdx]
  const startNode = nodes[0]
  if (startNode === undefined || endNode === undefined) return null
  const start = startNode.seq
  const end = endNode.seq
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start === end) return null

  // Report the ACTUAL retained tail's token sum (indices [endIdx+1 .. total-1]
  // after the boundary snap — nodes pulled onto the retained side during the
  // snap are INCLUDED here, so this figure is a faithful lower bound on what
  // remains verbatim after compaction).
  let retainedTokens = 0
  for (let i = endIdx + 1; i < total; i += 1) {
    const t = Number(nodes[i].tokens) > 0 ? Number(nodes[i].tokens) : 0
    retainedTokens += t
  }
  // DIAGNOSTIC FIELDS — expose the exact moment the backward walk crossed the
  // `budget` boundary so callers can log WHY the retained tail overshoots:
  //   crossingAccBefore — the accumulated sum JUST BEFORE the crossing node
  //                       (what the tail looked like one node earlier)
  //   crossingNodeSize  — the size of the node that pushed the sum over budget
  //                       (this single node is what makes "≥8000" become e.g.
  //                       "~9423")
  //   crossingAccAfter  — the accumulated sum INCLUDING the crossing node
  //                       (= crossingAccBefore + crossingNodeSize)
  // All three are -1 when the walk consumed the whole window without ever
  // reaching the budget (the degenerate tiny-session case).
  // boundaryKind classifies WHAT KIND of position the span finally settled on
  // after the backward balance snap (feeds the REGION-PICK diagnostic line):
  //   'pairing'           — a ledger-verified balanced position that is NOT a
  //                         `user/message` (the tighter cut the ledger
  //                         enables)
  //   'user-message'      — a human-message position (always balanced too)
  //   'crossing-fallback' — no balanced position ahead of the raw crossing;
  //                         the raw crossing itself was kept
  let boundaryKind
  if (endIdx < total - 1) {
    boundaryKind = 'crossing-fallback'
  } else {
    const endEvent = events[endIdx]
    boundaryKind = (endEvent !== null && typeof endEvent === 'object' && endEvent.type === 'user/message')
      ? 'user-message'
      : 'pairing'
  }
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    retainedTokens,
    crossingAccBefore,
    crossingNodeSize,
    crossingAccAfter,
    boundaryKind,
  }
}

/**
 * Select the **earliest** `ratio` fraction of the session's **tokens** as a
 * head-anchored region to compact — the "earliest conversation token ratio"
 * knob. **Legacy fallback**: used only when no `tokenMeter.measure` snapshot is
 * available. Prefer {@link selectEarliestByMeasurements}, which prices from the
 * same caliber as the gate's `totalTokens` and avoids the undercount/blank
 * failure this char-heuristic variant exhibits on tool-heavy conversations.
 *
 * It walks surface events from the head, accumulating per-event token estimates
 * (4 chars/token heuristic on flat surface text), until the accumulated tokens
 * reach `budget = min(totalTokens, surfaceTokens)`. This mirrors the legacy
 * ratio-of-total behavior where passing a ratio R is equivalent to passing
 * `totalTokens*R` as the absolute token budget to compact from the head —
 * for callers who lack a real `measure()` snapshot. The span covers every
 * surface node from the first through the node that crosses the token budget,
 * then walks the span's **end** FORWARD to the next TOOL-PAIRING BALANCED
 * position (official pairing ledger — any cut-after-balanced node, a strict
 * superset of the historical `user/message` heuristic) so the compacted span
 * ends at a balanced, tool-call-safe point. Returns `null` when there is not
 * enough surface history to compact.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} totalTokens the ABSOLUTE token budget to compact from the
 *   head. Typically the session's estimated total context tokens (char-based
 *   fallback) — walking forward until accumulated per-event tokens reach this
 *   many compacts up to the point where the budget is consumed, leaving the
 *   remaining tail intact. When `totalTokens` exceeds the actual surface
 *   token sum, the entire surface is eligible (equivalent to a ratio of 1.0).
 * @param {number|undefined} [maxRegionNodes] optional positional ceiling on
 *   the region's node count — same contract as
 *   {@link selectEarliestByMeasurements}.
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null`.
 */
// Internal body of `selectEarliestByTokens` — routed through the crash-net wrapper.
function __selectEarliestByTokensBody(session, totalTokens, maxRegionNodes) {
  // A malformed surface yields nothing to compact — return null rather than
  // throwing on a missing `session.surface.nodes`.
  const nodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const total = nodes.length
  if (total < 2) return null
  const budget = (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0)
    ? Math.round(totalTokens)
    : estimateSurfaceTokens(session)

  // Walk surface events from the head, accumulating tokens until the budget
  // is reached. The span end is the last node whose cumulative tokens first
  // meet or exceed the budget. Honor the optional `maxRegionNodes` positional
  // ceiling (same contract as {@link selectEarliestByMeasurements}): the span
  // can NEVER extend past the capped window.
  const capBound = (Number.isFinite(maxRegionNodes) && maxRegionNodes > 0)
    ? Math.min(total, Math.ceil(maxRegionNodes)) - 1
    : total - 1
  let accumulated = 0
  let endIdx = 0
  for (let i = 0; i <= capBound; i++) {
    const seq = nodes[i]
    accumulated += estimateEventTokens(session, seq)
    endIdx = i
    if (accumulated >= budget) break
  }

  // Walk the span's end FORWARD to the next TOOL-PAIRING BALANCED position
  // (official ledger criterion — any cut-after-balanced node, not only
  // `user/message`) so the compacted span ends balanced.
  while (endIdx + 1 < total && !toolPairingBalancedAfterSafe(session, nodes[endIdx])) {
    endIdx += 1
  }
  if (!toolPairingBalancedAfterSafe(session, nodes[endIdx])) return null
  if (endIdx < 1) return null

  return { start: nodes[0], end: nodes[endIdx] }
}

/**
 * Estimate the token count of a single session event's surface content
 * (user/message, assistant/message, tool/result). Log-only events contribute 0.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} seq the event's seq.
 * @returns {number}
 */
function estimateEventTokens(session, seq) {
  // A missing/malformed event (non-array `session.events`, a non-object row, or
  // missing `data` / `message`) degrades to 0 tokens rather than throwing — this
  // estimator feeds a budget decision, never a correctness path.
  const events = (session && Array.isArray(session.events)) ? session.events : []
  const event = events[seq]
  if (event === undefined || event === null || typeof event !== 'object') return 0
  const data = (event.data && typeof event.data === 'object') ? event.data : {}
  let chars = 0
  const sumBlocks = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  if (event.type === 'user/message') {
    sumBlocks(data.content)
  } else if (event.type === 'assistant/message') {
    const content = (data.message && Array.isArray(data.message.content)) ? data.message.content : undefined
    if (content) sumBlocks(content)
  } else if (event.type === 'tool/result') {
    const content = (data.message && Array.isArray(data.message.content)) ? data.message.content : undefined
    if (content) sumBlocks(content)
  }
  return Math.ceil(chars / 4)
}

/**
 * Estimate the total token count of a session's surface content (user +
 * assistant + tool-result messages), using a 4-chars-per-token heuristic.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {number}
 */
function estimateSurfaceTokens(session) {
  // Malformed shape (missing/non-array `events`, non-object rows, missing
  // `data`/`message`) degrades each row to 0 tokens rather than throwing — this
  // estimator feeds a budget decision, never a correctness path.
  let chars = 0
  const events = (session && Array.isArray(session.events)) ? session.events : []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    let content
    if (event.type === 'user/message') content = Array.isArray(data.content) ? data.content : undefined
    else if (event.type === 'assistant/message') content = (data.message && Array.isArray(data.message.content)) ? data.message.content : undefined
    else if (event.type === 'tool/result') content = (data.message && Array.isArray(data.message.content)) ? data.message.content : undefined
    if (content === undefined) continue
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / 4)
}

/** Public entries — wrapped by the universal crash net. */
export const selectEarliestByMeasurements = guardFn('region.selectEarliestByMeasurements', __selectEarliestByMeasurementsBody)
export const selectRetainingLatestTokens = guardFn('region.selectRetainingLatestTokens', __selectRetainingLatestTokensBody)
export const selectEarliestByTokens = guardFn('region.selectEarliestByTokens', __selectEarliestByTokensBody)

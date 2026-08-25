/**
 * dsh-force-compact's own region selection, modeled on the official
 * `compaction-basic` region selection. A head-anchored span that retains a
 * recent tail verbatim and ends on a `user/message` boundary — always a
 * balanced boundary, so the delegated `compactRegion` never rejects it for
 * unpaired tool calls.
 *
 * @module @falling-ts/dsh-force-compact/region
 */

/**
 * Select the compactable region for a session.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {Readonly<object>} config
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null` when there is nothing worth compacting.
 */
export function selectRegion(session, config) {
  // A malformed surface (missing `session.surface` / non-array `nodes`) yields
  // nothing to compact — return null rather than throw.
  const nodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const total = nodes.length
  if (total < config.minNodes) return null

  // Retain a recent tail (by surface-node count); the compactable prefix is everything before it.
  const retainCount = Math.max(1, Math.round(total * config.retainRatio))
  let keepFromIdx = total - retainCount
  if (keepFromIdx < 1) return null

  // Walk the tail boundary back to the nearest `user/message` node. A user
  // message never participates in a tool-call/result pair, so the boundary
  // before it is always tool-pairing balanced and `compactRegion` will accept it.
  const userMessageSeqs = userMessageEventSeqs(session)
  while (keepFromIdx > 1 && !userMessageSeqs.has(nodes[keepFromIdx - 1])) {
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
  // Snap the OUTWARD bounds to `user/message` seqs so the replacement stays
  // tool-pair-balanced: widen `start` downward / shrink `end` upward to the
  // nearest surrounding user-message seq within the compactable prefix.
  const prefix = nodes.slice(0, keepFromIdx - 1)
  let start = Infinity
  let end = -Infinity
  for (const seq of prefix) {
    if (seq < start) start = seq
    if (seq > end) end = seq
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  // Snap both bounds to `user/message` seqs WITHIN the prefix so the replacement
  // stays tool-pair-balanced: the LOWEST user-message seq becomes `start` and
  // the HIGHEST becomes `end`. The session core interprets a replace region as
  // the inclusive index segment between those two nodes, so the segment still
  // spans the intended leading history. When the prefix contains no user message
  // at all (unusual — the head is normally one), fall back to the raw value
  // extremes so a valid span is preserved.
  const userSeqsInRange = [...prefix].filter(s => userMessageSeqs.has(s)).sort((a, b) => a - b)
  const snappedStart = userSeqsInRange.length > 0 ? userSeqsInRange[0] : start
  const snappedEnd = userSeqsInRange.length > 0 ? userSeqsInRange[userSeqsInRange.length - 1] : end
  if (snappedStart > snappedEnd) return null
  return { start: snappedStart, end: snappedEnd }
}

/**
 * The set of seqs that are `user/message` surface events, so the region
 * boundary can be snapped to one without re-deriving the projection.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {Set<number>}
 */
function userMessageEventSeqs(session) {
  const seqs = new Set()
  const events = (session && Array.isArray(session.events)) ? session.events : []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'user/message' && typeof event.seq === 'number') seqs.add(event.seq)
  }
  return seqs
}

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
 * snapped FORWARD to the next `user/message` node (balanced, tool-call-safe
 * boundary). Returns `null` when there is not enough surface to compact.
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
 *   the cap AND ends on a `user/message` boundary. Rationale: the builtin
 *   summarization engine refuses regions whose projected message count exceeds
 *   its replay cap; clamping here (rather than refusing there) GUARANTEES a
 *   committable region on every threshold trip so the auto-gate never livelocks
 *   and the context can actually be pulled back down. Multiple successive gates
 *   chip away the head until the session settles below the threshold.
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null`.
 */
export function selectEarliestByMeasurements(session, ratio, measurement, maxRegionNodes) {
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

  const userMessageSeqs = userMessageEventSeqs(session)

  // Upper positional bound on the region span: the smallest of (a) the last
  // node, (b) the token-crossing point, (c) the optional node-count cap. All
  // expressed as an INDEX into `nodes`. We then snap THAT index backward to the
  // nearest `user/message` boundary BELOW it (a balanced, tool-call-safe END),
  // which may bring the span further inward.
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

  // Snap the span's end BACKWARD to the nearest `user/message` boundary at or
  // before the crossing point so the compacted span ends balanced. Walking
  // backward (instead of forward) keeps the span WITHIN the cap — the previous
  // forward snap could overshoot past the cap. If the prefix has no
  // `user/message` at all, fall back to the raw crossing point so a valid
  // region is preserved.
  let settled = endIdx
  while (settled > 0 && !userMessageSeqs.has(nodes[settled].seq)) {
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
 * The cutoff is then SNAPPED BACKWARD to the nearest preceding `user/message`
 * boundary (positionally before the retained tail's start) so the compacted
 * span ends at a balanced, tool-call-safe point — the same invariant the
 * other selectors maintain.
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
export function selectRetainingLatestTokens(session, retainLatestTokens, measurement) {
  const nodes = (measurement && Array.isArray(measurement.nodes) && measurement.nodes.length > 0)
    ? measurement.nodes
    : []
  const total = nodes.length
  if (total < 2) return null
  const budget = (Number.isFinite(retainLatestTokens) && retainLatestTokens > 0)
    ? Math.max(1, Math.floor(retainLatestTokens))
    : 1

  const userMessageSeqs = userMessageEventSeqs(session)

  // Walk FROM THE TAIL toward the head, accumulating node tokens. Stop as soon
  // as the accumulated sum reaches OR EXCEEDS `budget` (the `>=` stop rule).
  // The first node included in the accumulated tail is the cutoff point:
  // everything STRICTLY BEFORE it (positionally) is compacted. Because a node
  // cannot be split, the retained tail may overshoot `budget` by UP TO ONE
  // node's weight — that is the closest achievable "exactly N" boundary.
  let acc = 0
  let tailStartIdx = total // exclusive: index just AFTER the last retained node
  for (let i = total - 1; i >= 0; i -= 1) {
    tailStartIdx = i
    const t = Number(nodes[i].tokens) > 0 ? Number(nodes[i].tokens) : 0
    acc += t
    if (acc >= budget) break
  }
  // The tail occupied indices [tailStartIdx .. total-1]; the compactable
  // prefix occupies [0 .. tailStartIdx-1]. Need at least one node to compact.
  if (tailStartIdx <= 0) return null

  // Snap the compacted span's END BACKWARD to the nearest `user/message`
  // boundary strictly BEFORE the retained tail starts, so the span ends on a
  // balanced, tool-call-safe node. Nodes BETWEEN the snapped boundary and the
  // raw crossing point stay ON THE RETAINED SIDE: they are never dropped from
  // the head nor lost from the tail — the retained tail can only GROW past the
  // literal budget by the width of those boundary-alignment nodes. This makes
  // the retention guarantee monotone: the verbatim tail is ALWAYS at least as
  // large as `budget` in the common case and larger near boundaries. If no
  // `user/message` exists anywhere in the prefix, fall back to the raw
  // crossing index so a valid region is preserved.
  let endIdx = tailStartIdx - 1
  while (endIdx > 0 && !userMessageSeqs.has(nodes[endIdx].seq)) {
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
  return { start: Math.min(start, end), end: Math.max(start, end), retainedTokens }
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
 * then snaps the span's **end** forward to the next `user/message` boundary
 * (so the compacted span ends at a balanced, tool-call-safe point). Returns
 * `null` when there is not enough surface history to compact.
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
export function selectEarliestByTokens(session, totalTokens, maxRegionNodes) {
  // A malformed surface yields nothing to compact — return null rather than
  // throwing on a missing `session.surface.nodes`.
  const nodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const total = nodes.length
  if (total < 2) return null
  const userMessageSeqs = userMessageEventSeqs(session)
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

  // Snap the span's end forward to the next `user/message` boundary so the
  // compacted span ends balanced.
  while (endIdx + 1 < total && !userMessageSeqs.has(nodes[endIdx])) {
    endIdx += 1
  }
  if (!userMessageSeqs.has(nodes[endIdx])) return null
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

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
 * Select the **earliest** `ratio` fraction of the session's **tokens** as a
 * head-anchored region to compact — the "earliest conversation token ratio" knob.
 *
 * Unlike a node-count-based selector, this measures the actual token content:
 * it walks surface events from the head, accumulating per-event token estimates
 * (4 chars/token heuristic), until the accumulated tokens reach
 * `totalTokens * ratio`. The span covers every surface node from the first
 * through the node that crosses the token budget, then snaps the span's **end**
 * forward to the next `user/message` boundary (so the compacted span ends at a
 * balanced, tool-call-safe point). Returns `null` when there is not enough
 * surface history to compact.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} ratio a fraction in (0, 1].
 * @param {number} [totalTokens] the session's total context tokens (from
 *   `tokenMeter.measure` or a character-based fallback); when omitted, the
 *   function estimates the total itself.
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null`.
 */
export function selectEarliestByTokens(session, ratio, totalTokens) {
  // A malformed surface / bad ratio yields nothing to compact — return null
  // rather than throwing on a missing `session.surface.nodes` or an NaN budget.
  const nodes = (session && session.surface && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const total = nodes.length
  if (total < 2) return null
  const clampedRatio = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0.5

  // Estimate the session's total tokens (surface content only).
  const rawTotal = (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0) ? totalTokens : estimateSurfaceTokens(session)
  const surfaceTokens = rawTotal
  const budget = Math.max(1, Math.round(surfaceTokens * clampedRatio))

  const userMessageSeqs = userMessageEventSeqs(session)

  // Walk surface events from the head, accumulating tokens until the budget
  // is reached. The span end is the last node whose cumulative tokens first
  // meet or exceed the budget.
  let accumulated = 0
  let endIdx = 0
  for (let i = 0; i < total; i++) {
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

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
  const nodes = session.surface.nodes
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

  return { start: nodes[0], end: nodes[keepFromIdx - 1] }
}

/**
 * The set of seqs that are `user/message` surface events, so the region
 * boundary can be snapped to one without re-deriving the projection.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {Set<number>}
 */
function userMessageEventSeqs(session) {
  const seqs = new Set()
  for (const event of session.events) {
    if (event.type === 'user/message') seqs.add(event.seq)
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
  const nodes = session.surface.nodes
  const total = nodes.length
  if (total < 2) return null

  // Estimate the session's total tokens (surface content only).
  const surfaceTokens = totalTokens !== undefined
    ? totalTokens
    : estimateSurfaceTokens(session)
  const budget = Math.max(1, Math.round(surfaceTokens * ratio))

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
  const event = session.events[seq]
  if (event === undefined) return 0
  let chars = 0
  if (event.type === 'user/message') {
    for (const block of event.data.content || []) {
      if (block && typeof block.text === 'string') chars += block.text.length
    }
  } else if (event.type === 'assistant/message') {
    const content = event.data.message && event.data.message.content
    if (content) {
      for (const block of content) {
        if (block && typeof block.text === 'string') chars += block.text.length
      }
    }
  } else if (event.type === 'tool/result') {
    const message = event.data.message
    if (message && message.content) {
      for (const block of message.content) {
        if (block && typeof block.text === 'string') chars += block.text.length
      }
    }
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

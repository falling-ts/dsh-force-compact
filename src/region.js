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
 * Select the **earliest** `ratio` fraction of the session's surface history as a
 * head-anchored region to compact — the "earliest conversation ratio" knob.
 *
 * The span starts at the first surface node and covers the oldest
 * `Math.max(1, Math.round(total * ratio))` nodes, then snaps the span's **end**
 * forward to the next `user/message` boundary (so the compacted span ends at a
 * balanced, tool-call-safe point). Returns `null` when there is not enough
 * surface history to compact.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} ratio a fraction in (0, 1].
 * @returns {{start: number, end: number} | null} the head-anchored span to compact, or `null`.
 */
export function selectEarliestRatio(session, ratio) {
  const nodes = session.surface.nodes
  const total = nodes.length
  if (total < 2) return null

  const compactCount = Math.max(1, Math.round(total * ratio))
  const userMessageSeqs = userMessageEventSeqs(session)

  // The span covers nodes[0..compactCount-1]; snap its end (nodes[compactCount-1])
  // forward to the next `user/message` boundary so the span ends balanced.
  let endIdx = compactCount - 1
  while (endIdx + 1 < total && !userMessageSeqs.has(nodes[endIdx])) {
    endIdx += 1
  }
  // The end must land on a `user/message` boundary (balanced) and be past the
  // first node (a one-node span is not worth compacting).
  if (!userMessageSeqs.has(nodes[endIdx])) return null
  if (endIdx < 1) return null

  return { start: nodes[0], end: nodes[endIdx] }
}

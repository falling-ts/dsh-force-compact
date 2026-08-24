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

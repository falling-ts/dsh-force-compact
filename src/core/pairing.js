/**
 * Tool-pairing balance over a session surface — ported verbatim (plain JS, no
 * type layer) from the official `@deepseek-ai/dsh-compaction` tool-pairing
 * ledger (`deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts`).
 *
 * Compaction changes surface positions, so safe cuts are derived from
 * tool-call/result content in current surface order rather than step markers.
 *
 * Balance definition (official semantics):
 *   • an `assistant/message` event contributes +N where N is the number of
 *     `tool-call` content blocks in `data.message.content`;
 *   • a `tool/result` event contributes -1;
 *   • every other event contributes 0.
 * A surface CUT (between two consecutive surface positions, or before the
 * first / after the last) is BALANCED when the running in-progress tool-call
 * count at that cut is 0 — i.e. no unanswered tool call straddles the cut.
 * A surface of N nodes therefore has N+1 cuts; the leading cut (before the
 * first node) is trivially balanced.
 *
 * The balance table is computed incrementally and cached PER SESSION behind a
 * `WeakMap` keyed on the session object (mirrors the official
 * `balanceCacheBySession`). The cache advances only over the NEW suffix of the
 * surface (appends), so repeated reads over a growing surface stay near-O(new
 * nodes). A surface REPLACEMENT (compactation checkpoint landing) bumps the
 * session's `replaceGeneration`, which forces a full rebuild from scratch —
 * exactly the official rebuild path ("the same fold started from the
 * empty-surface state").
 *
 * Corrupt-surface handling matches the official module: a surface sequence
 * whose log slot holds a different event (`eventForSeq` mismatch) or a
 * `tool/result` with no preceding open call THROWS, so a corrupted log can
 * never leave a partially-advanced cache state behind (the tail is validated
 * BEFORE the live cache mutates). Callers in this plugin wrap the public
 * predicates in safe envelopes that degrade to "assume balanced" rather than
 * throwing into the compaction path — see `safe*` variants below.
 *
 * @module @falling-ts/dsh-force-compact/pairing
 */

import { sessionEvents } from './session-events.js'

/**
 * Incremental balance state for one session surface generation.
 * @typedef {Object} BalanceCache
 * @property {number} generation Surface rewrite generation this state
 *   describes (`session.surface.replaceGeneration`).
 * @property {ReadonlyArray<boolean>} cutBalanced Balance of every surface cut
 *   in current order: a surface of N sequences has N + 1 cuts, entry `i`
 *   being the cut before sequence `i` and the final entry the cut after the
 *   surface tail.
 * @property {Map<number, number>} indexBySeq Current surface position of each
 *   event seq, indexing {@link BalanceCache#cutBalanced}.
 * @property {number} inProgressToolCalls In-progress tool-call count after
 *   the processed surface tail.
 */

const balanceCacheBySession = new WeakMap()

/** How one surface event changes the in-progress tool-call count (official `eventDelta`). */
export function eventDelta(event) {
  const type = event && event.type
  if (type === 'assistant/message') {
    const message = event.data && event.data.message
    const content = (message && Array.isArray(message.content)) ? message.content : []
    return content.filter(block => block && block.type === 'tool-call').length
  }
  if (type === 'tool/result') return -1
  return 0
}

/** Read and validate the event named by a surface sequence (official `eventForSeq`). */
function eventForSeq(events, seq) {
  const event = events[seq]
  if (event === undefined || event.seq !== seq) {
    throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
  }
  return event
}

/** Fold surface sequences not yet in the cache into its balance state (official `extendCache`). */
function extendCache(session, cache, seqs) {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  // Validate the unseen tail BEFORE mutating the live cache, so a corrupt
  // append cannot leave a partially advanced state behind.
  const events = sessionEvents(session)
  const pendingCuts = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    inProgressToolCalls += eventDelta(eventForSeq(events, seq))
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }

  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

/** Balance state synchronized with the current session surface (official `balanceCache`). */
function balanceCache(session) {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = (surface.replaceGeneration === undefined) ? 0 : surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)

  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    // A rebuild is the same fold started from the empty-surface state, whose
    // single leading cut is trivially balanced.
    const rebuilt = extendCache(session, {
      generation,
      cutBalanced: [true],
      indexBySeq: new Map(),
      inProgressToolCalls: 0,
    }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

/** Balance of the cut at a sequence's position plus offset; rejects foreign seqs (official `cutBalance`). */
function cutBalance(cache, seq, offset) {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  }
  return balanced
}

/**
 * Whether the cut immediately BEFORE a current surface sequence is tool-pairing
 * balanced (official `toolPairingBalancedBefore`). THROWS on a corrupt surface
 * or a seq absent from the current surface — use {@link toolPairingBalancedBeforeSafe}
 * on plugin hot paths.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} seq
 * @returns {boolean}
 */
export function toolPairingBalancedBefore(session, seq) {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * Whether the cut immediately AFTER a current surface sequence is tool-pairing
 * balanced (official `toolPairingBalancedAfter`). THROWING variant — see the
 * `Before` twin.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} seq
 * @returns {boolean}
 */
export function toolPairingBalancedAfter(session, seq) {
  return cutBalance(balanceCache(session), seq, 1)
}

/**
 * Safe variant for plugin hot paths: identical math, but a corrupt-surface
 * throw DETERMINES "this cut is balanced" (returns `true`) so a damaged log
 * degrades to "attempt the compaction" (where the session core's own replace
 * validation is the last line of defense) instead of wedging the whole
 * compaction path in a perpetual selection-failure loop.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} seq
 * @returns {boolean}
 */
export function toolPairingBalancedBeforeSafe(session, seq) {
  try {
    return toolPairingBalancedBefore(session, seq)
  } catch (error) {
    const message = (error instanceof Error) ? error.message : String(error)
    try { console.warn(`[force-compact] pairing-ledger degraded (assuming balanced before seq ${seq}): ${message}`) } catch { /* never throw out */ }
    return true
  }
}

/** Safe trailing-cut twin of {@link toolPairingBalancedBeforeSafe}. */
export function toolPairingBalancedAfterSafe(session, seq) {
  try {
    return toolPairingBalancedAfter(session, seq)
  } catch (error) {
    const message = (error instanceof Error) ? error.message : String(error)
    try { console.warn(`[force-compact] pairing-ledger degraded (assuming balanced after seq ${seq}): ${message}`) } catch { /* never throw out */ }
    return true
  }
}

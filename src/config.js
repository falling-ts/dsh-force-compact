/**
 * dsh-force-compact tunables.
 *
 * These are the plugin's own compaction policy knobs. They are deliberately
 * fixed constants (not cordis `Config` fields): a standalone Host listener has
 * no `Config` schema, and a deployment that wants a different policy points its
 * composition at the `compaction` service's own `retainRatio` / `summarizationModel`
 * instead — see AGENTS.md for why.
 * @module @falling-ts/dsh-force-compact/config
 */

/** Minimum surface nodes before any compaction is considered. */
export const MIN_NODES = 6

/** Fraction of the recent tail (by surface-node count) retained verbatim and never compacted. */
export const RETAIN_RATIO = 0.25

/** Compact only when the compactable prefix (all but the retained tail) spans at least this many surface nodes. */
export const MIN_COMPACTABLE_NODES = 4

/** Generation cap for the summarization call. */
export const MAX_SUMMARY_TOKENS = 16384

/**
 * Retry budget for the summarization call when the provider route is transiently
 * unavailable. Bounded so a flush checkpoint cannot stall unboundedly.
 */
export const SUMMARIZE_RETRIES = 2

/**
 * Resolve the full config object for a compaction round.
 * @returns {Readonly<{minNodes: number, retainRatio: number, minCompactableNodes: number, maxSummaryTokens: number, summarizeRetries: number}>}
 */
export function resolveConfig() {
  return Object.freeze({
    minNodes: MIN_NODES,
    retainRatio: RETAIN_RATIO,
    minCompactableNodes: MIN_COMPACTABLE_NODES,
    maxSummaryTokens: MAX_SUMMARY_TOKENS,
    summarizeRetries: SUMMARIZE_RETRIES,
  })
}

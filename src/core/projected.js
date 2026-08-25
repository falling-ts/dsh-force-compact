/**
 * dsh-force-compact shared reader for the official `projectedTokens` reading.
 *
 * WHY THIS MODULE
 * ---------------
 * Every threshold gate, region-selection budget basis, and diagnostic line in
 * the plugin must key off the SAME number the harness renders in the bottom-right
 * corner (`上下文已用 xx% / ~xxK / xxK`). That rendered figure IS the
 * `projectedTokens` member of the host `contextPressure` projection — the
 * provider-anchored sample plus the surface movement since the sample. Reading
 * it through the official registry keeps a single definition of the pressure
 * basis alive inside the plugin instead of a parallel heuristic drifting from
 * upstream revisions.
 *
 * WHERE IT COMES FROM
 * --------------------
 * `ctx.get('sessionProjections')` is the host registry that DRIVES every
 * registered projection unit forward eagerly over committed session events
 * (framework-owned watermark cache). `snapshot(session).values.contextPressure`
 * hands back the SAME wire object the host broadcasts to the browser as
 * `session/projection` frames — already validated against the unit's own
 * `viewSchema`, so the plugin never re-implements the anchor math. Fields are
 * individually optional (`pressureTokens` / `projectedTokens` /
 * `contextWindow`): absent until a provider reports usage.
 *
 * SEMANTICS (mirrors the official JSDoc — read before building gates on this)
 * ----------------------------------------------------------------------------
 * The three members are INDEPENDENT last-wins records, not one atomic request
 * observation: switching models can pair a fresh capacity with the previous
 * route's pressure until the next request reports usage. Official stance —
 * this is a USER-FACING REFERENCE, not a billing or gating input. The plugin
 * therefore treats `projectedTokens` as the authoritative pressure basis but
 * FAILS OPEN (returns `undefined`) when it is absent, so a session that has
 * not reported usage yet still degrades gracefully to the char-based
 * estimator at each call site instead of blocking.
 *
 * CALIBER NOTES FOR CALLERS
 * -------------------------
 * `projectedTokens` = `max(0, pressureTokens + surfaceTokens −
 * sampledSurfaceTokens)`. The delta term is estimated at the meter's fixed
 * density (CHARS_PER_TOKEN=4), so the figure UNDERCOUNTS heavy-CJK / tool-JSON
 * content relative to the pure `surfaceTokens` sum — a deliberate provider
 * anchor the meter prefers over the unanchored sum. Gate thresholds calibrated
 * against the old `surfaceTokens` basis sit slightly higher (fewer triggers)
 * after this swap; that is intended behaviour, not a bug.
 *
 * COST CONTRACT
 * -------------
 * Sync, pure read. First touch of a freshly-restarted long session replays the
 * whole log once (lazy fold seeding) — O(events); every later call in the same
 * process hits the eager-fold watermark cache — effectively O(1). Call sites
 * are the pre-step gate (once per model step) and the retained-tail path (rare
 * compaction rounds), so the hot-path cost is negligible.
 *
 * FAILURE MODES — ALL RESOLVED TO `undefined` (never throw)
 * ---------------------------------------------------------
 * • `ctx` / `ctx.get` absent or not a function → `undefined`
 * • `sessionProjections` registry not mounted (trimmed compositions) → `undefined`
 * • `snapshot` throws on a transient backend fault → caught, `undefined`
 * • `session` unusable → `undefined`
 * • `contextPressure` unit not folded for this session → `undefined`
 * • unit present but `projectedTokens` still absent (no usage sample yet) → `undefined`
 *
 * Callers pair a `=== undefined` result with their existing char-estimator
 * fallback (see `estimateSessionTokens` / `estimateSurfaceTokensLocal`), so a
 * degraded registry never blocks a model request or a compaction commit.
 *
 * @module @falling-ts/dsh-force-compact/projected
 */

/**
 * Read the official `projectedTokens` for one session — the SAME number the
 * harness renders in the bottom-right corner.
 *
 * Fail-open by design (see module doc): every absence/degradation resolves to
 * `undefined` rather than propagating. Pair the result with a char-based
 * estimator fallback at each call site.
 *
 * @param {object} ctx cordis context (Host listener `this` / apply ctx).
 * @param {object|undefined} session live session handle.
 * @returns {number|undefined} the official `projectedTokens` reading, or
 *   `undefined` when the registry is unavailable, the snapshot failed, the
 *   unit is not folded for this session, or no usage sample has been captured
 *   yet (all fail-open — caller decides the fallback).
 */
export function getProjectedTokens(ctx, session) {
  try {
    if (typeof ctx?.get !== 'function') return undefined
    const registry = ctx.get('sessionProjections')
    if (registry === undefined || registry === null) return undefined
    if (typeof registry.snapshot !== 'function') return undefined
    if (session === undefined || session === null) return undefined
    const snap = registry.snapshot(session)
    const cp = snap && snap.values && snap.values.contextPressure
    if (cp === undefined || cp === null) return undefined
    const projected = cp.projectedTokens
    return (typeof projected === 'number' && Number.isFinite(projected)) ? projected : undefined
  } catch {
    return undefined
  }
}

/**
 * Classify WHY {@link getProjectedTokens} resolved to `undefined` for one
 * session — a DIAGNOSTIC aid that reproduces the same read but labels the exact
 * failure tier, so an operator can tell apart "registry/service not reachable
 * from this context" from "reachable but the session simply has no usage sample
 * yet". Pure, sync, never throws, returns a short stable reason string (or
 * `'available'` with the numeric reading attached when the read succeeds).
 *
 * @param {object} ctx cordis context.
 * @param {object|undefined} session live session handle.
 * @returns {string} one of: `available:<n>` / `no-ctx.get` / `registry-absent` /
 *   `registry-no-snapshot` / `session-unusable` / `snap-threw` /
 *   `unit-not-folded` / `no-usage-sample-yet`.
 */
export function diagnoseProjectedTokensAbsence(ctx, session) {
  try {
    if (typeof ctx?.get !== 'function') return 'no-ctx.get'
    const registry = ctx.get('sessionProjections')
    if (registry === undefined || registry === null) return 'registry-absent'
    if (typeof registry.snapshot !== 'function') return 'registry-no-snapshot'
    if (session === undefined || session === null) return 'session-unusable'
    let snap
    try {
      snap = registry.snapshot(session)
    } catch {
      return 'snap-threw'
    }
    const cp = snap && snap.values && snap.values.contextPressure
    if (cp === undefined || cp === null) return 'unit-not-folded'
    const projected = cp.projectedTokens
    return (typeof projected === 'number' && Number.isFinite(projected))
      ? `available:${projected}`
      : 'no-usage-sample-yet'
  } catch {
    return 'unexpected-throw'
  }
}

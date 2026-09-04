/**
 * dsh-force-compact session-event access shim.
 *
 * The harness `Session` class was refactored (upstream 0.1.2-rc.1 era): it no
 * longer exposes a public `events` array — event reads go through
 * `session.eventAt(seq)` and full-log snapshots through
 * `session.snapshotEvents()`. This plugin's own engines (builtin transaction,
 * region selection, pairing ledger, token estimators) were written against the
 * legacy `session.events` array and silently degraded to EMPTY on the new
 * Session (rawSweep=0, "region has no surface messages", pairing treated as
 * trivially balanced). These helpers abstract over both shapes so the plugin
 * reads the SAME events a modern Session actually holds.
 *
 * @module @falling-ts/dsh-force-compact/session-events
 */

/**
 * Materialize the session's full ordered event log, tolerant of both harness
 * generations:
 *  - modern: `session.snapshotEvents()` (immutable frozen snapshot; `seq ==
 *    array index` by the `seq = log.length` contiguity contract);
 *  - legacy: the public `session.events` array.
 * Never throws: every anomaly resolves to an empty array so callers degrade
 * (skip compaction, empty estimate) instead of crashing a request seam.
 * @param {object|undefined} session the live session handle.
 * @returns {readonly object[]} the ordered event log (possibly empty).
 */
export function sessionEvents(session) {
  if (session !== undefined && session !== null && typeof session.snapshotEvents === 'function') {
    try {
      const snap = session.snapshotEvents()
      if (snap !== undefined && snap !== null && Array.isArray(snap)) return snap
    } catch { /* fall through to legacy shape */ }
  }
  return (session && Array.isArray(session.events)) ? session.events : []
}

/**
 * Read ONE event by its sequence number, tolerant of both harness generations:
 *  - modern: `session.eventAt(seq)`;
 *  - legacy: `session.events[seq]`.
 * Never throws; returns `undefined` for absent/malformed reads.
 * @param {object|undefined} session the live session handle.
 * @param {number} seq the event sequence number.
 * @returns {object|undefined} the event, or undefined when the log lacks it.
 */
export function sessionEventAt(session, seq) {
  if (session !== undefined && session !== null && typeof session.eventAt === 'function') {
    try {
      const event = session.eventAt(seq)
      if (event !== undefined && event !== null) return event
    } catch { /* fall through to legacy shape */ }
  }
  return (session && Array.isArray(session.events)) ? session.events[seq] : undefined
}

/**
 * Whether this session exposes a usable event store (modern `snapshotEvents`
 * or legacy `events` array). Used only to gate DIAGNOSTIC reads that need a
 * real event (e.g. the head-checkpoint probe) — the read helpers themselves
 * already degrade safely.
 * @param {object|undefined} session the live session handle.
 * @returns {boolean}
 */
export function hasSessionEventStore(session) {
  return Boolean(
    session !== undefined && session !== null
    && (typeof session.snapshotEvents === 'function' || typeof session.eventAt === 'function'
      || Array.isArray(session.events)),
  )
}
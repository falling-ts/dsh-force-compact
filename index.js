/**
 * Session Auto-Compact.
 *
 * On every session durability checkpoint (`session/flush`), compact the
 * session's useful history into a single summary node via the `compaction`
 * service. Because `session/flush` is an awaited `parallel` checkpoint, the
 * compaction completes as part of the checkpoint and its summary is durable
 * before the caller proceeds.
 *
 * The listener resolves the session's live Agent and calls
 * `compaction.compactNow(agent)`, which force-compacts useful history even
 * below the automatic pressure thresholds. A `null` result is a safe no-op
 * (nothing useful to compact), so repeated flushes are harmless, and the
 * service prevents concurrent compaction of the same session.
 *
 * @module @falling-ts/dsh-compact
 */

/** Cordis function-plugin name. */
export const name = 'auto-compact'

/** Hard service dependency: the plugin is meaningless without it. */
export const inject = ['compaction']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Optional dependency: degrade gracefully if the agent registry is absent.
  const agents = ctx.get('agents')

  ctx.on('session/flush', async (session) => {
    try {
      const sessionId = session ? session.id : undefined
      if (sessionId === undefined) {
        console.log('[auto-compact] session/flush without a session id — skipping')
        return
      }

      const agent = agents ? agents.get(sessionId) : undefined
      if (agent === undefined) {
        console.log('[auto-compact] no live agent registered for session', String(sessionId), '— skipping')
        return
      }

      // compactNow requires a non-undefined AbortSignal: the engine calls
      // signal.throwIfAborted() on its first line, so passing undefined throws a
      // TypeError. No natural cancellation source exists at a durability
      // checkpoint, so mint a fresh controller per checkpoint and let the
      // compaction run to completion (the awaited checkpoint covers its lifetime).
      const controller = new AbortController()
      const result = await ctx.compaction.compactNow(agent, controller.signal)
      console.log(
        '[auto-compact] session', String(sessionId), '→',
        result === null ? 'no-op (nothing useful to compact)' : 'compacted',
      )
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      console.log('[auto-compact] compactNow failed:', msg)
    }
  })
}

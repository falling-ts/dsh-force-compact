/**
 * Locate the `compaction` service for a given agent.
 *
 * In modern harness compositions the compaction BACKEND (`compaction-basic`)
 * is mounted per **agent preset realm** (the `standard` preset isolates the
 * `compaction` service into each session's realm), so the HOST-GLOBAL
 * `ctx.get('compaction')` observes `undefined` while each live agent's own
 * context (`agent.ctx`) resolves the instance. A host-level function plugin
 * (this one) holds a global context, so reading `ctx.get('compaction')` alone
 * finds nothing — but it DOES have the live agent handle on every event
 * payload, and `agent.ctx` is the canonical way to reach that agent's
 * realm-scoped world.
 *
 * The location MODE comes from the `compactionMode` setting (`'realm'`
 * default, `'global'` opt-out), read directly from the raw settings namespace
 * so the hot model-request path never pays a full-settings-parse cost.
 *
 * Resolution tries, in priority order:
 *   1. `agent.ctx` (the agent's realm-scoped context, guaranteed by the
 *      `Agent` type definition) — the modern preset-plane location;
 *   2. the host-global `ctx.get('compaction')` — the base-bundle location
 *      plus a safety net when the agent context did not hold the service;
 *   3. `ctx.compaction` (injected-property convention, topology-sensitive).
 *
 * `'realm'` (default) tries all three so every layout works; `'global'`
 * restricts to steps 2–3 (a deployment known to mount the backend globally).
 *
 * @module @falling-ts/dsh-force-compact/service-resolver
 */

import { readRawSetting, COMPACT_MODE_GLOBAL } from './settings.js'

import { compactNowBuiltin, compactRegionBuiltin } from './builtin-engine.js'

/**
 * Find a usable compaction backend for one agent.
 *
 * Resolution order (priority 1 first):
 *   1. the OFFICIAL `compaction` service (`compactNow`/`compactRegion`) — the
 *      authoritative summarizer; preferred whenever it is reachable from this
 *      agent's context (see the historical note above about realm placement);
 *   2. this plugin's BUILTIN engine (its own transaction, event names, and
 *      summarizer) — the fallback used whenever the official service is
 *      unreachable from this context (the common `standard` preset layout) and
 *      the `builtinEnabled` setting allows it (default `true`).
 *
 * Both backends expose the SAME shape — `compactNow` and `compactRegion` — so
 * callers are agnostic to which produced the result.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx a context to fall back to (the plugin-global context) when the agent-side candidates do not resolve.
 * @param {import('@deepseek-ai/dsh-agent').Agent|undefined} agent the agent owning the target session.
 * @param {string|undefined} mode the `compactionMode` setting value (`'realm'`|`'global'`).
 * @returns {Promise<{ compactNow: Function, compactRegion: Function, kind: 'official'|'builtin' }|undefined>} a normalized backend, or `undefined` when neither the official service nor the builtin engine is usable.
 */
export async function resolveCompaction(ctx, agent, mode) {
  const official = await findOfficialService(ctx, agent, mode)
  if (official !== undefined) {
    return { compactNow: official.compactNow, compactRegion: official.compactRegion, kind: 'official' }
  }
  return await builtinBackend(ctx, agent)
}

/**
 * Locate the OFFICIAL `compaction` service for this agent via the historical
 * two-tier resolver. Reads the `compactionMode` setting (`'realm'` default,
 * `'global'` opt-out) to choose candidates:
 *   - `'realm'` (default): the agent's OWN realm-scoped context (`agent.ctx`,
 *     the canonical modern location), then the host-global `ctx.get('compaction')`;
 *   - `'global'`: only the host-global `ctx.get('compaction')`.
 *
 * NEVER declares `inject:['compaction']` and NEVER reads `ctx.compaction` as a
 * property (that would trip the strict-injection fatal). Only `ctx.get` /
 * `agent.ctx.get` — both safe and tolerant.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent|undefined} agent
 * @param {string|undefined} mode
 * @returns {Promise<object|undefined>} the official compaction service, or `undefined`.
 */
async function findOfficialService(ctx, agent, mode) {
  const effectiveMode = (typeof mode === 'string' && mode === COMPACT_MODE_GLOBAL)
    ? COMPACT_MODE_GLOBAL
    : ((mode === undefined) ? (await readRawSetting(ctx, 'compactionMode')) : 'realm')

  if (effectiveMode !== COMPACT_MODE_GLOBAL
      && agent && agent.ctx !== undefined && agent.ctx !== null) {
    const byRealm = tryGet(agent.ctx)
    if (byRealm !== undefined) return byRealm
  }
  return tryGet(ctx)
}

/**
 * Build the BUILTIN backend for this agent: the plugin's own engine, gated by
 * the `builtinEnabled` setting (default `true`). Returns `undefined` when the
 * engine is disabled or lacks what it needs (an `agent` handle with a session
 * and an `llm` service for the summarizer).
 */
async function builtinBackend(ctx, agent) {
  const enabled = (await readRawSetting(ctx, 'builtinEnabled')) ?? true
  if (!enabled) return undefined
  if (agent === undefined || agent === null || agent.session === undefined) return undefined
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return undefined
  return {
    kind: 'builtin',
    compactNow: (ag, signal) => compactNowBuiltin(ctx, ag, signal),
    compactRegion: (start, end, ag, signal) => compactRegionBuiltin(ctx, start, end, ag, signal),
  }
}

/**
 * Safely attempt `receiver.get('compaction')`, returning the service ONLY when
 * it exposes the methods this plugin calls (`compactNow` / `compactRegion`).
 * Never throws — an unusable receiver or a missing service yields `undefined`.
 *
 * @param {any} receiver any receiver (typically a Cordis context, possibly a
 *   Proxy; some partial receivers may lack `.get` altogether).
 * @returns {object|undefined}
 */
function tryGet(receiver) {
  if (receiver === undefined || receiver === null) return undefined
  if (typeof receiver.get !== 'function') return undefined
  try {
    const svc = receiver.get('compaction')
    if (svc === undefined || svc === null) return undefined
    if (typeof svc.compactNow === 'function' || typeof svc.compactRegion === 'function') return svc
  } catch {
    // Any receiver shape (including non-proxy partials) is tolerated.
  }
  return undefined
}

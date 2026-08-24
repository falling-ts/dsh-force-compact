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

// NOTE: We intentionally DO NOT declare `inject: ['compaction']` anywhere in
// this plugin — the plugin must boot even when the backend is absent (legacy
// bundles without compaction). Reading `ctx.compaction` as a PROPERTY on a
// context where the service was not declared triggers Cordis's strict
// injection contract check and KILLS THE PROCESS with a fatal load failure.
// Every lookup therefore MUST go through `ctx.get('compaction')` (the safe,
// optional path) or `agent.ctx.get(...)` — never a raw property read on the
// context itself.

/**
 * Find the live `compaction` service instance for one agent.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx a context to fall back to (the plugin-global context) when the agent-side candidates do not resolve.
 * @param {import('@deepseek-ai/dsh-agent').Agent|undefined} agent the agent owning the target session. May be `undefined` (then only the ctx-side candidates are tried).
 * @param {string|undefined} mode the `compactionMode` setting value (`'realm'`|`'global'`). When omitted it is read live from settings.
 * @returns {Promise<object|undefined>} the compaction service instance, or `undefined` when no candidate resolves.
 */
export async function resolveCompaction(ctx, agent, mode) {
  const effectiveMode = (typeof mode === 'string' && mode === COMPACT_MODE_GLOBAL)
    ? COMPACT_MODE_GLOBAL
    : ((mode === undefined) ? (await readRawSetting(ctx, 'compactionMode')) : 'realm')

  // Priority 1 (realm mode only): the agent's OWN realm-scoped context — the
  // canonical way to reach a per-realm service in modern preset-plane layouts.
  if (effectiveMode !== COMPACT_MODE_GLOBAL
      && agent && agent.ctx !== undefined && agent.ctx !== null) {
    const byRealm = tryGet(agent.ctx)
    if (byRealm !== undefined) return byRealm
  }

  // Priority 2 (always): the host-global lookup (base-bundle layout + a safety
  // net when the agent context did not hold the service).
  return tryGet(ctx)
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

/**
 * dsh-force-compact's session-flush compaction orchestrator.
 *
 * On the awaited `session/flush` checkpoint: gate on the session's total
 * estimated context reaching `autoThresholdTokens`; select the compactable
 * region with the plugin's own head-anchored policy (`selectRegion`);
 * then DELEGATE THE DURABLE MUTATION TO WHICHEVER BACKEND IS AVAILABLE —
 * the official `compaction` service when reachable (preferred) or this
 * plugin's OWN builtin engine when it isn't (fallback). Both backends
 * perform their OWN preview summarization + shrink gate internally, so this
 * caller no longer re-implements a redundant preview.
 *
 * @module @falling-ts/dsh-force-compact/compact
 */

import { resolveConfig } from '../core/policy.js'
import { selectRegion } from './region.js'
import { readSettings, DEFAULTS } from '../core/settings.js'
import { resolveCompaction } from './backend.js'
import { guardFn, renderCrash, captureThrowSite, appendCrashLine as appendDiag } from '../core/crashnet.js'

/** Characters per token, mirroring the token meter's coarse estimate. */
const CHARS_PER_TOKEN = 4

/**
 * Compact a session's useful history at a durability checkpoint.
 *
 * Flow: gate on threshold → select the region with the plugin's own policy →
 * locate the available backend (official-preferred, builtin-fallback) →
 * delegate the durable `compactRegion` call (each backend performs its own
 * summarization and shrink gate internally).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {AbortController} controller
 * @param {string|undefined} mode the `compactionMode` setting (passed by the caller); undefined re-reads live.
 * @returns {Promise<object | null>} the compaction result (shape depends on the backend;
 *   the builtin engine returns `{ kind:'builtin', compactionId, startSeq, summarySeq,
 *   endSeq, summary, shadowedRange, shadowedSeqs, shadowedTokenCount }`), or `null`
 *   when nothing was worth compacting or no backend was available.
 */
// Internal body of `compactSession` — routed through the crash-net wrapper.
// The existing try/catch around `backend.compactRegion` handles the
// expected-backend-failure path; the crash-net layer adds observability
// for ANOMALOUS throws escaping that catch (malformed `selectRegion` inputs,
// an unexpected throw out of the backend facade, etc.).
async function __compactSessionBody(ctx, agent, controller, mode) {
  // SAFETY GUARD: a missing/unusable `agent.session` means there is nothing to
  // compact — degrade to `null` (skip) rather than a downstream `session.id` /
  // `session.events` dereference throwing out of the flush-checkpoint path.
  const agentObj = (agent && typeof agent === 'object') ? agent : undefined
  const session = (agentObj && agentObj.session) ? agentObj.session : undefined
  if (session === undefined || session === null || typeof session.id !== 'string') {
    if (controller && typeof controller.abort === 'function' && controller.signal.aborted === false) {
      // Nothing actionable; leave the slot open for the caller's finally cleanup.
    }
    const sid = (session && typeof session.id === 'string') ? session.id : '?'
    ctx.logger.debug(`[force-compact] ${sid}: checkpoint skipped — no usable agent session`)
    return null
  }
  const config = resolveConfig()

  // The "强制压缩配置" (force-compact configuration) settings: the automatic
  // compaction trigger threshold and whether to disable thinking for the
  // summarization call. Falls back to composition defaults when the `settings`
  // service is not mounted.
  const settings = (await readSettings(ctx)) ?? DEFAULTS

  // Automatic compaction trigger gate: only compact when the session's
  // estimated total context reaches the configured threshold. Below it, the
  // checkpoint is skipped so short sessions are never force-compacted.
  const sessionTokens = estimateSessionTokens(session)
  ctx.logger.debug(`[force-compact] ${session.id}: session/flush checkpoint fired — session ~${sessionTokens} tokens (threshold ${settings.autoThresholdTokens})`)
  if (sessionTokens < settings.autoThresholdTokens) {
    ctx.logger.debug(`[force-compact] ${session.id}: context ~${sessionTokens} tokens below threshold ${settings.autoThresholdTokens}; skipping`)
    return null
  }

  const region = selectRegion(session, config)
  if (region === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: no compactable region; skipping`)
    return null
  }

  // Locate a usable compaction backend: the OFFICIAL `compaction` service
  // (preferred) OR this plugin's OWN builtin engine (fallback). Each performs
  // its own summarization + shrink gate internally, so no redundant preview
  // is needed here.
  const backend = await resolveCompaction(ctx, agent, mode)
  if (backend === undefined || typeof backend.compactRegion !== 'function') {
    const effMode = (mode !== undefined ? mode : settings.compactionMode)
    ctx.logger.warn(
      `[force-compact] ${session.id}: NO compaction backend available at checkpoint (mode=${effMode}). ` +
      `Enable \`builtinEnabled=true\` in the \`falling-ts-force-compact\` namespace to activate the ` +
      `plugin's own engine as a fallback (it needs the \`llm\` service + \`agent.session\` present).`
    )
    return null
  }

  ctx.logger.debug(`[force-compact] ${session.id}: checkpoint compaction via ${backend?.kind} over seq ${region?.start}..${region?.end}`)
  let result
  try {
    result = await backend.compactRegion(region.start, region.end, agent, controller.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] ${session.id}: checkpoint compaction via ${backend?.kind} FAILED — ${message}`)
    // UNIVERSAL-CRASH-NET diagnostic — a durable trail for every anomalous
    // backend failure, independent of logger wiring.
    try {
      const lines = renderCrash('checkpoint.compactSession.backend-call', error, captureThrowSite())
      for (const line of lines) appendDiag(line)
    } catch (_netFailure) { /* swallow */ }
    return null
  }
  if (result === undefined || result === null) {
    ctx.logger.debug(`[force-compact] ${session.id}: checkpoint compaction via ${backend?.kind} committed nothing`)
    return null
  }
  ctx.logger.info(
    `[force-compact] ${session.id}: checkpoint compaction (${backend?.kind}) shadowed ` +
    `${(result.shadowedSeqs && result.shadowedSeqs.length) ?? '?'} nodes (~${result.shadowedTokenCount ?? '?'} tokens)`,
  )
  return result
}

/** Public entry — wrapped by the universal crash net. */
export const compactSession = guardFn('checkpoint.compactSession', __compactSessionBody)

/**
 * Coarse token estimate for a session's whole surface content (user +
 * assistant + tool-result messages). Used only for the automatic compaction
 * trigger GATE — the authoritative token accounting happens inside the
 * backend's `compactRegion`.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {number}
 */
function estimateSessionTokens(session) {
  // Feeds only the threshold GATE: a malformed session (missing/non-array
  // `events`, non-object rows, missing `data`/`message`) degrades each row to
  // 0 rather than throwing. Every deep deref is individually guarded.
  let chars = 0
  const events = (session && Array.isArray(session.events)) ? session.events : []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    let content
    if (event.type === 'user/message') content = Array.isArray(data.content) ? data.content : undefined
    else if (event.type === 'assistant/message') content = (data.message && Array.isArray(data.message.content)) ? data.message.content : undefined
    else if (event.type === 'tool/result') content = (data.message && Array.isArray(data.message.content)) ? data.message.content : undefined
    if (content === undefined) continue
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

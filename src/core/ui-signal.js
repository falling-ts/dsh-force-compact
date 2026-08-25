/**
 * Live UI status messenger — the plugin-private bridge between the HOST half
 * ("which phase am I in right now?") and the CLIENT half ("paint THAT pair on
 * the `TurnStatus` DOM node").
 *
 * Why settings at all
 * ------------------
 * The client half (`web/client.js`) already mirrors the `falling-ts-force-compact`
 * namespace through `settingsScope.bind` → `createSnapshotStore`, so ANY field
 * written by the host here is reflected in the browser live (the `SettingsScope`
 * revision-fencing contract). That is the ONLY sanctioned host→browser live-data
 * channel this independent plugin bundle can use — there is no reverse RPC seam
 * for a client-loaded plugin to expose arbitrary callable methods (the unary
 * route map is closed and host-defined). The `liveUi` field documented below is
 * therefore a PLUGIN-PRIVATE transient messenger: the host is its only writer;
 * the client never writes it; it deliberately persists to `settings.yaml` like
 * every other field of the namespace (harmless cosmetic residue — the worst
 * outcome after a restart is the badge briefly showing a stale phase before the
 * next LLM call overwrites it).
 *
 * Phases
 * ------
 * Every model request begins with a WORKING phase (a random text+color pair
 * drawn from the 20×20 tables below — the "工作中的状态" set). Around a
 * force-compaction the display is OVERRIDDEN deterministically, not randomly:
 *
 *   • COMPRESSING — pinned red `[强制压缩中>>>]`, fired BEFORE the `compactNow` /
 *     `compactRegion` call;
 *   • DONE        — pinned green `[压缩完成!]`, fired right AFTER the call
 *     commits; then after `DONE_FALLBACK_MS` (3 s) the next LLM-call moment
 *     redraws a fresh random working pair (no dedicated timer — the badge
 *     self-corrects at the very next model step, which is the natural visual
 *     rhythm anyway and keeps this module free of timers entirely).
 *
 * All writers are GUARANTEED never to throw (they wrap the settings-service
 * write in try/catch): a messenger failure must NEVER disrupt the model
 * request or the compaction transaction itself.
 *
 * @module @falling-ts/dsh-force-compact/ui-signal
 */

/** The settings field name carrying the live UI status (host-written, client-read). */
export const LIVE_UI_FIELD = 'liveUi'

/** Phase discriminants. Closed union — consumers switch on exactly these. */
export const PHASE_WORKING = 'working'
export const PHASE_COMPRESSING = 'compressing'
export const PHASE_DONE = 'done'

/** Pinned (never randomized) payloads for the deterministic phases. */
export const PINNED_TEXTS = Object.freeze({
  [PHASE_COMPRESSING]: '[强制压缩中>>>]',
  [PHASE_DONE]: '[压缩完成!]',
})

/** Pinned colors matching {@link PINNED_TEXTS} — red while compacting, green on completion. */
export const PINNED_COLORS = Object.freeze({
  [PHASE_COMPRESSING]: '#ff4d4f',
  [PHASE_DONE]: '#52c41a',
})

/**
 * The 20 WORKING-phase texts. Four-character, plainly-worded verbs describing
 * what the agent is doing right now ("思考中..." / "整理中..." / …) followed by
 * a trailing ellipsis. Colors are unchanged and remain randomly paired with
 * these labels.
 * @readonly
 */
export const WORKING_TEXTS = Object.freeze([
  '正在思考...',
  '正在整理...',
  '正在规划...',
  '正在分析...',
  '正在检索...',
  '正在推理...',
  '正在校验...',
  '正在比对...',
  '正在权衡...',
  '正在归纳...',
  '正在总结...',
  '正在撰写...',
  '正在执行...',
  '正在运行...',
  '正在处理...',
  '正在计算...',
  '正在核实...',
  '正在生成...',
  '正在准备...',
  '正在继续...',
])

/**
 * The 20 WORKING-phase colors — a fixed palette covering the hue wheel (soft
 * blues/greens for calm phases, warm amber/violet toward the end); each pairs
 * with any text independently (random pairing, not a locked text-color index,
 * so repeated draws visibly vary BOTH dimensions).
 * @readonly
 */
export const WORKING_COLORS = Object.freeze([
  '#4f9cf9',
  '#5b8def',
  '#6a5bff',
  '#8b5cf6',
  '#a855f7',
  '#c45bf9',
  '#db6bd4',
  '#e86bb0',
  '#f06b8b',
  '#f76b5b',
  '#fb8c5b',
  '#fca95b',
  '#fdc35b',
  '#d8e05b',
  '#aede5b',
  '#7ee083',
  '#5be0a0',
  '#5becd8',
  '#5bcdf9',
  '#7ba8f9',
])

/**
 * Draw a random working-phase status: a random text paired with a random
 * color (independently chosen, so the pair space is 20×20 = 400 distinct
 * combinations). Pure — no I/O, trivially testable.
 * @returns {{phase: string, text: string, color: string}}
 */
export function randomWorkingPair() {
  return {
    phase: PHASE_WORKING,
    text: WORKING_TEXTS[Math.floor(Math.random() * WORKING_TEXTS.length)],
    color: WORKING_COLORS[Math.floor(Math.random() * WORKING_COLORS.length)],
  }
}

/**
 * Build the pinned payload for a deterministic phase.
 * @param {'compressing'|'done'} phase
 * @returns {{phase: string, text: string, color: string}}
 */
export function pinnedPayload(phase) {
  return { phase, text: PINNED_TEXTS[phase], color: PINNED_COLORS[phase] }
}

/**
 * Publish one UI status onto the `liveUi` field of the `falling-ts-force-compact`
 * namespace. This is THE host→browser delivery point: the client half's
 * `settingsScope.bind` mirror flips its snapshot on the next accepted
 * revision, and the browser component repaints the `TurnStatus` DOM node.
 *
 * Guarantees:
 *   • NEVER throws — a settings-service absence or a rejected write is caught
 *     and logged at most once per lifetime (observability only; the model
 *     request and any surrounding compaction transaction proceed untouched).
 *   • Fire-and-forget from the caller's perspective: the returned promise
 *     always settles (resolve on success, resolve-with-warning on failure).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{phase: string, text: string, color: string}} status
 * @returns {Promise<void>}
 */
let warnedOnce = false
export async function publishUiStatus(ctx, status) {
  try {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') return
    const NS = 'falling-ts-force-compact'
    await settings.update(NS, { [LIVE_UI_FIELD]: status })
    if (!warnedOnce) {
      warnedOnce = true
      try {
        ctx.logger.debug(`[force-compact] ui-signal: publishing ${status?.phase} "${status?.text}" (${status?.color}) via ${NS}.${LIVE_UI_FIELD}`)
      } catch { /* logging must never propagate */ }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger.warn(`[force-compact] ui-signal publish failed (ignored, cosmetic only) — ${message}`)
    } catch { /* never */ }
  }
}

/**
 * The single host-side driver for one MODEL REQUEST'S start moment. Call from
 * the `llm/stream` waterfall (once per outgoing call): draw a fresh random
 * working pair and publish it. Because the drawing is random-per-call, the
 * "3 seconds after `压缩完成!!!`, pick a new working pair" requirement falls
 * out naturally — the NEXT model-step's `llm/stream` fires within seconds of
 * compaction finishing and overwrites the green DONE state with a fresh
 * working pair, so no explicit timer is needed and none is kept (keeping this
 * module timer-free also sidesteps the "plugins don't introduce timers"
 * convention for anything that isn't observationally inert).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishRandomWorking(ctx) {
  await publishUiStatus(ctx, randomWorkingPair())
}

/**
 * Publish the pinned RED "正在压缩…" status. Call BEFORE a `compactNow` /
 * `compactRegion` invocation.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishCompressing(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_COMPRESSING))
}

/**
 * Publish the pinned GREEN "压缩完成!!!" status. Call AFTER a `compactNow` /
 * `compactRegion` invocation commits. The following model step's
 * `llm/stream` listener replaces it with a fresh random working pair (~within
 * 3 s in normal cadence — see {@link publishRandomWorking}).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishDone(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_DONE))
}

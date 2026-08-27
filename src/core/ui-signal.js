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
 *     commits; then after `DONE_FALLBACK_MS` (3 s) a forced
 *     `isImportant=true` push redraws a fresh random Deep working pair
 *     (single-purpose timer — the only one in this module).
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

/** Pinned colors matching {@link PINNED_TEXTS} — extra-dark tuned: deep burgundy-red while compacting, muted pine-green on completion. */
export const PINNED_COLORS = Object.freeze({
  [PHASE_COMPRESSING]: '#9b1c2b',
  [PHASE_DONE]: '#2f6f52',
})

/**
 * The 20 WORKING-phase texts. Deliberately irreverent, meme-flavored one-liners
 * aimed at the agent ITSELF ("我正在憋大招..." / "我在偷渡..." / ...) — the
 * badge talks about what the agent is supposedly up to in a playful voice
 * instead of dry status verbs. Lengths intentionally exceed the old four-char
 * constraint; the client paints the raw string with no width assumption.
 * Colors are unchanged and remain randomly paired with these labels.
 * @readonly
 */
export const WORKING_TEXTS = Object.freeze([
  '正在酝酿骚操作...',
  '正在憋大招...',
  '灵感正在路上...',
  '脑细胞开会中...',
  '灵魂拷问进行中...',
  '偷偷翻你底牌...',
  '量子纠缠计算中...',
  '假装很忙...',
  '摸鱼式工作中...',
  '疯狂敲键盘(精神上)...',
  '正在缝合上下文...',
  '正在驯服混沌...',
  '正在召唤赛博大脑...',
  '正在翻阅《天机》...',
  'GPU 正在冒烟...',
  '正在跟熵值搏斗...',
  '正在画饼给你吃...',
  '正在偷渡灵感...',
  '正在暗中观察...',
  '马上就好(大概)...',
])

/**
 * The 20 WORKING-phase colors — a fixed palette covering the hue wheel (soft
 * blues/greens for calm phases, warm amber/violet toward the end); each pairs
 * with any text independently (random pairing, not a locked text-color index,
 * so repeated draws visibly vary BOTH dimensions).
 * @readonly
 */
/**
 * Extra-dark 20-color WORKING-phase palette (second darkening pass). Each
 * entry sits one brightness step deeper than the prior dark-tuned set while
 * preserving the full hue-wheel sweep (blue → indigo → violet → purple →
 * plum → orchid → magenta → fuchsia → pink → rose → crimson → scarlet →
 * vermilion → rust → ochre → gold → olive → moss → pine → fir → teal →
 * cyan → azure → cobalt → navy). Saturation is held high enough that the
 * badge reads as a distinct hue rather than desaturating toward grey.
 * Random pairing with {@link WORKING_TEXTS} remains unchanged.
 * @readonly
 */
export const WORKING_COLORS = Object.freeze([
  '#1e40af',   // royal blue
  '#1e3a8a',   // deep blue
  '#312e81',   // indigo
  '#4c1d95',   // violet
  '#581c87',   // purple
  '#8318a3',   // plum
  '#86198f',   // orchid
  '#9d174d',   // magenta
  '#9f1239',   // pink
  '#991b1b',   // rose
  '#9a3412',   // crimson
  '#92400e',   // scarlet
  '#854d0e',   // rust
  '#4d7c0f',   // ochre-gold
  '#3f6212',   // olive
  '#166534',   // moss
  '#065f46',   // pine
  '#0e7490',   // teal
  '#155e75',   // cyan
  '#172554',   // navy
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
 * @param {boolean} [isImportant=false] — `true` bypasses the guard entirely
 *   and writes unconditionally. `false` (the default) refuses to overwrite a
 *   currently displayed text that starts with `[` (i.e. a pinned bracket-form
 *   message such as `[强制压缩中>>>]`), returning early without touching
 *   settings.
 * @returns {Promise<void>}
 */
let warnedOnce = false
export async function publishUiStatus(ctx, status, isImportant = false) {
  try {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') return
    const NS = 'falling-ts-force-compact'
    // Non-important pushes refuse to overwrite a pinned bracket-form text.
    if (!isImportant) {
      let currentText
      try {
        // SYNC read — the settings service's `get` returns the cached value
        // immediately (same call style as settings.js:226); the gate is purely
        // advisory (worst case: the write proceeds, nothing breaks), so there
        // is no reason to await an async variant even if one ever appeared.
        const nsValue = (typeof settings.get === 'function') ? settings.get(NS) : undefined
        currentText = (nsValue != null && typeof nsValue === 'object')
          ? nsValue[LIVE_UI_FIELD]?.text
          : (typeof nsValue === 'string' ? nsValue : undefined)
      } catch { /* read failure must not block the important path — fall through */ }
      if (typeof currentText === 'string' && currentText.startsWith('[')) return
    }
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
 * The host-side driver for one MODEL REQUEST's start moment. Call from the
 * `llm/stream` waterfall (once per outgoing call): draw a fresh random working
 * pair and publish it NON-importantly (so a pinned bracket-form text such as
 * `[压缩完成!]` survives the push until its own fallback timer clears it — see
 * {@link publishDone}). A fresh pair is also emitted on the 3-second fallback
 * after DONE ({@link DONE_FALLBACK_MS}), firing with `isImportant=true` so it
 * overwrites the DONE banner even though a `[`-prefixed text is on screen.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishRandomWorking(ctx) {
  await publishUiStatus(ctx, randomWorkingPair())
}

/**
 * Publish the pinned RED "[强制压缩中>>>]" status. Call BEFORE a `compactNow` /
 * `compactRegion` invocation. Passes `isImportant=true` so the pinned
 * bracket-form message can overwrite whatever is currently displayed (including
 * another pinned text).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishCompressing(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_COMPRESSING), true)
}

/**
 * How long after the pinned "[压缩完成!]" DONE banner is published before the
 * forced fallback kicks in and paints a fresh random Deep working pair back on
 * the badge (with `isImportant=true`). 3000 ms.
 *
 * Note: this is the plugin's SINGLE-USE TIMER — a deliberate, documented
 * exception to the collection rule "plugins are pure host listeners that do
 * not introduce timers". See the `dsh-force-compact` AGENTS.md deviation note.
 */
const DONE_FALLBACK_MS = 3000

/**
 * Publish the pinned GREEN "[压缩完成!]" status. Call AFTER a `compactNow` /
 * `compactRegion` invocation commits. After {@link DONE_FALLBACK_MS} (3 s) a
 * forced fallback (`isImportant=true`) overwrites the DONE banner with a fresh
 * random Deep working pair, restoring the usual working appearance regardless
 * of whether a subsequent `llm/stream` fires in the interim. We paint a
 * FRESH random working pair (not the literal pre-compression text, which is no
 * longer recoverable from the settings store — it was already overwritten by
 * the COMPRESSING/DONE banners): the intent is "back to a normal working
 * look", which a freshly-drawn working pair satisfies.
 *
 * Passes `isImportant=true` for the initial DONE push: reaching `publishDone`
 * PRECEDED BY `publishCompressing`, which has already written the pinned red
 * `[强制压缩中>>>]` bracket-form text. Without `isImportant=true` the gate inside
 * {@link publishUiStatus} (which refuses non-important pushes over a currently
 * displayed `[`-bracket text) would see our OWN still-displayed `compressing`
 * banner and bail out, so the green `[压缩完成!]` would silently never be written
 * and the 3 s fallback would jump straight from COMPRESSING to a fresh working
 * pair — the DONE banner never appearing at all. Since a DONE push can only
 * follow a `compressing` push from THIS plugin, there is no manually-set custom
 * banner to protect, and overriding our own prior banner is exactly intended.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishDone(ctx) {
  await publishUiStatus(ctx, pinnedPayload(PHASE_DONE), true)
  setTimeout(() => {
    void publishUiStatus(ctx, randomWorkingPair(), true)
  }, DONE_FALLBACK_MS)
}

/**
 * Live UI status messenger — the plugin-private bridge between the HOST half
 * ("which phase is the agent in right now?") and the CLIENT half ("replace the
 * official running label's leading phrase with THAT status").
 *
 * Why settings at all
 * ------------------
 * The client half (`web/client.js`) already mirrors the `falling-ts-force-compact`
 * namespace through `configForms.get` → `createSnapshotStore`, so ANY field
 * written by the host here is reflected in the browser live (the `ConfigForm`
 * revision-fencing contract). That is the ONLY sanctioned host→browser live-data
 * channel this independent plugin bundle can use — there is no reverse RPC seam
 * for a client-loaded plugin to expose arbitrary callable methods (the unary
 * route map is closed and host-defined). The `liveUi` field documented below is
 * therefore a PLUGIN-PRIVATE transient messenger: the host is its only writer;
 * the client never writes it; it deliberately persists to the settings file like
 * every other field of the namespace (harmless cosmetic residue — the worst
 * outcome after a restart is the badge briefly showing a stale phase before the
 * next agent action overwrites it).
 *
 * Phases — three AGENT ACTION phases plus the compaction banner
 * --------------------------------------------------------------
 * The status text names WHICH KIND OF WORK the agent is doing, one phase per
 * kind of time-consuming agent action:
 *
 *   • REQUESTING — `模型请求中`. Fired when the agent issues a model request
 *     and lasts until the model's FIRST token arrives. Insertion point: the
 *     `agent/request` waterfall (`index.js`), i.e. the agent LOOP's own
 *     business request — the last moment before the adapter is entered.
 *   • RESPONDING  — `模型响应中`. Fired on the FIRST stream chunk of an
 *     attempt and lasting until the response ends. Insertion point: the
 *     `agent/assistant-stream` frame with `index === 0` (the first chunk of
 *     that attempt; `start` deliberately does NOT fire it, because the attempt
 *     opens before any token has arrived).
 *   • TOOLING     — `工具执行中`. Fired when a non-model agent-internal
 *     operation starts. Insertion point: the `tools/pre-execute` waterfall.
 *
 * Around a force-compaction the display is OVERRIDDEN by the compaction banner
 * (kept deliberately — the user asked to PRESERVE it while replacing the
 * working-status text):
 *
 *   • COMPRESSING — pinned `[强制压缩中>>>]`, fired BEFORE the `compactNow` /
 *     `compactRegion` call;
 *   • DONE        — pinned `[压缩完成!]`, fired right AFTER the call commits.
 *     There is NO fallback timer: the next agent action (normally the
 *     `agent/request` of the continuing loop) overwrites it naturally, which
 *     is exactly the phase the agent is in by then.
 *   • END         — pinned EMPTY text `""`, fired at the END of a
 *     conversation (the `agent/status` idle transition — hooks/idle.js): a
 *     CLEAR push that restores the official running label (the client half
 *     drops its replacement prefix and puts the harness's own text back).
 *
 * WHY THE COMPACTION SUMMARIZATION CALL IS EXCLUDED. The user asked for the
 * three phases to cover the agent's own time-consuming actions but NOT a
 * compaction-time request. That exclusion is STRUCTURAL, not filtered: the
 * plugin's own summarizer (and the official engine's) calls `ctx.llm.stream`
 * DIRECTLY, so no `agent/request` waterfall runs for it, no
 * `agent/assistant-stream` frame is emitted (those frames are produced only by
 * the agent loop's live attempt), and it dispatches no tools. A summary call
 * therefore cannot reach any of the three insertion points.
 *
 * A payload carries NO presentation attributes — only `phase`, the canonical
 * zh `text`, and the locale-independent `textId`. The client half substitutes
 * only the official running label's leading phrase ("深度求索中" /
 * "Deep diving...") and leaves the harness's own elapsed-time text, font, and
 * colour untouched.
 *
 * Every published payload carries BOTH a canonical `text` (the Chinese default)
 * and a locale-independent `textId` discriminator: the phase name itself
 * (`'requesting'` / `'responding'` / `'tooling'` / `'compressing'` / `'done'` /
 * `'end'`). `textId` is the localization seam: the client half
 * (`web/client.js` `paintTurnStatus`) maps it through its own `ctx.locale`
 * zh/en/ja/ko dictionaries, so the badge follows the app language, and falls
 * back to the canonical `text` when `textId` is absent or unresolvable. The host
 * half must stay locale-agnostic — dsh exposes the locale service only to the
 * client web half, not to the host.
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
export const PHASE_REQUESTING = 'requesting'
export const PHASE_RESPONDING = 'responding'
export const PHASE_TOOLING = 'tooling'
export const PHASE_COMPRESSING = 'compressing'
export const PHASE_DONE = 'done'
export const PHASE_END = 'end'

/**
 * The canonical zh text of every phase. `end` is the EMPTY clear — see
 * {@link publishEnd}. The `textId` of each payload is the phase name itself, so
 * the client half translates per app language; these strings are the fallback
 * shown when no dictionary entry resolves.
 * @readonly
 */
export const PHASE_TEXTS = Object.freeze({
  [PHASE_REQUESTING]: '模型请求中',
  [PHASE_RESPONDING]: '模型响应中',
  [PHASE_TOOLING]: '工具执行中',
  [PHASE_COMPRESSING]: '[强制压缩中>>>]',
  [PHASE_DONE]: '[压缩完成!]',
  [PHASE_END]: '',
})

/**
 * Build the payload for one phase. Takes `textId = phase` so the client half
 * can localize the canonical zh `text` per app language. Pure — no I/O,
 * trivially testable.
 * @param {'requesting'|'responding'|'tooling'|'compressing'|'done'|'end'} phase
 * @returns {{phase: string, text: string, textId: string}}
 */
export function phasePayload(phase) {
  return { phase, text: PHASE_TEXTS[phase], textId: phase }
}

/**
 * Publish one UI status onto the `liveUi` field of the `falling-ts-force-compact`
 * namespace. This is THE host→browser delivery point: the client half's
 * `configForms.get` mirror flips its snapshot on the next accepted revision, and
 * the browser component replaces the official running label's leading phrase
 * with it.
 *
 * Every phase overwrites whatever is currently displayed, including a pinned
 * `[`-bracket compaction banner: the banner's own lifetime is "until the agent
 * does something else", and the very next real phase IS that something. (An
 * earlier revision gated non-important pushes to protect the banner; with the
 * DONE fallback timer gone, such a gate would strand the banner on screen.)
 *
 * Guarantees:
 *   • NEVER throws — a settings-service absence or a rejected write is caught
 *     and logged at most once per lifetime (observability only; the model
 *     request and any surrounding compaction transaction proceed untouched).
 *   • Fire-and-forget from the caller's perspective: the returned promise
 *     always settles (resolve on success, resolve-with-warning on failure).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{phase: string, text: string, textId: string}} status
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
        ctx.logger.debug(`[force-compact] ui-signal: publishing ${status?.phase} "${status?.text}" textId=${status?.textId} via ${NS}.${LIVE_UI_FIELD}`)
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
 * The agent issued a model request and is waiting for the first token. Call from
 * the `agent/request` waterfall (once per outgoing business call, INCLUDING each
 * retry attempt). A compaction summarization call never traverses that seam, so
 * it can never publish this phase.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishRequesting(ctx) {
  await publishUiStatus(ctx, phasePayload(PHASE_REQUESTING))
}

/**
 * The model's FIRST token arrived. Call from the `agent/assistant-stream`
 * listener on the frame with `index === 0` — the first chunk of that attempt.
 * The attempt's `start` frame deliberately does not publish: the attempt opens
 * before any token has arrived, which is still {@link publishRequesting}'s span.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishResponding(ctx) {
  await publishUiStatus(ctx, phasePayload(PHASE_RESPONDING))
}

/**
 * A non-model agent-internal operation started. Call from the `tools/pre-execute`
 * waterfall. No completion publisher is needed: when the tool settles the agent
 * immediately issues its next model request, which publishes
 * {@link publishRequesting} over it.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishTooling(ctx) {
  await publishUiStatus(ctx, phasePayload(PHASE_TOOLING))
}

/**
 * Publish the pinned "[强制压缩中>>>]" status. Call BEFORE a `compactNow` /
 * `compactRegion` invocation.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishCompressing(ctx) {
  await publishUiStatus(ctx, phasePayload(PHASE_COMPRESSING))
}

/**
 * Publish the pinned "[压缩完成!]" status. Call AFTER a `compactNow` /
 * `compactRegion` invocation commits.
 *
 * There is NO fallback timer (the former 3 s `DONE_FALLBACK_MS` repaint was
 * removed together with the random working texts it repainted). The banner stays
 * until the agent's next action overwrites it — normally the `agent/request` of
 * the loop continuing with the compacted history, which publishes
 * {@link publishRequesting}. An interrupted conversation instead reaches the
 * idle clear ({@link publishEnd}).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishDone(ctx) {
  await publishUiStatus(ctx, phasePayload(PHASE_DONE))
}

/**
 * The conversation-END clear: publish the pinned EMPTY text `""`, so it
 * UNCONDITIONALLY overwrites whatever is currently displayed — including a
 * stale pinned bracket-form text such as `[强制压缩中>>>]` left behind by an
 * interrupted/failed compaction, or a lingering `[压缩完成!]` banner (the
 * non-important guard that used to hold the banner is gone, but an interrupted
 * turn can still leave the badge on its last phase).
 *
 * The client's `paintTurnStatus` treats the empty text as a CLEAR: it puts the
 * harness's own running label back and disconnects its DOM observer, so the
 * badge returns to its official appearance until the next liveUi push.
 *
 * Call ONCE at the END of a conversation (the `agent/status` idle transition —
 * see hooks/idle.js, where it runs on EVERY idle exit path: turn-end compaction
 * committed, nothing committed, compaction disabled, no backend).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function publishEnd(ctx) {
  await publishUiStatus(ctx, phasePayload(PHASE_END))
}

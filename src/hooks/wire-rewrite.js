/**
 * dsh-force-compact's wire-layer second safety net for disabling thinking —
 * appends the OPENAI-COMPATIBLE wire field `reasoning_effort: "none"` to
 * EVERY outgoing LLM call whenever the `disableThinking` setting is on.
 *
 * The dual-layer insurance rationale
 * ---------------------------------
 * The `disableThinking` setting is ALSO honored upstream at the request-seam:
 * the `agent/request` waterfall sets `LlmCallConfig.reasoningEffort = 'off'`,
 * which the DeepSeek adapter serializes to the wire field
 * `thinking: { type: 'disabled' }`. That is the RIGHT field for the real
 * DeepSeek API. But when the SAME wire shape lands on a llama.cpp
 * OpenAI-compatible endpoint (:8080, `Qwen3.8-27B-NVFP4-MTP-LOW.gguf`), the
 * top-level `thinking` key is NOT in the llama.cpp request schema — it is
 * forwarded opaquely into `llama_params` and IGNORED
 * (verified against `D:\AI\llama.cpp\tools\server`: `thinking` appears
 * nowhere in `server-schema.cpp`, and the OAI parsing path never reads a
 * top-level `thinking` key). Net effect of the request-seam path ALONE:
 * `disableThinking:true` SILENTLY FAILS to turn off thinking on llama.cpp —
 * the model thinks anyway, with no error surfacing.
 *
 * The llama.cpp-native (and OpenAI-generic) spelling for "disable reasoning"
 * is a TOP-LEVEL wire field `reasoning_effort: "none"`
 * (`server-common.cpp:1295-1304`), which the OAI parser special-cases into
 * `inputs.enable_thinking = false` UNCONDITIONALLY — independent of jinja
 * template capability. A weaker alternative,
 * `chat_template_kwargs: { enable_thinking: false }`
 * (`server-common.cpp:1286-1291`), depends on the template honoring the
 * `enable_thinking` placeholder; `reasoning_effort:"none"` is more robust.
 *
 * So this hook adds a SECOND wire field on top of whatever the adapter chose:
 *
 *   Layer 1 (adapter, request-seam): `thinking: { type: 'disabled' }`
 *       → honored by the real DeepSeek API; ignored harmlessly elsewhere.
 *   Layer 2 (THIS hook, wire seam):  `reasoning_effort: "none"`
 *       → honored by llama.cpp / OpenAI-compatible endpoints; ignored
 *         harmlessly by the real DeepSeek API (unknown top-level fields are
 *         tolerated, never rejected).
 *
 * Each backend therefore receives AT LEAST ONE field it understands, so
 * `disableThinking:true` genuinely disables thinking regardless of where the
 * call lands — no dead zone between the two spellings.
 *
 * Scope: every outgoing call
 * --------------------------
 * The append applies to ALL outgoing LLM calls (business requests AND this
 * plugin's own summarizer calls) whenever `disableThinking` is on — NO
 * provider/model gating. Rationale: the `reasoning_effort:"none"` field is
 * additive and harmless on every known backend (ignored-by-unknown-field
 * tolerance), so there is zero downside to applying it universally, and doing
 * so eliminates the risk that a target-recognition heuristic MISSES a variant
 * (e.g. an exotic Qwen route whose `provider`/`model` ids match no keyword)
 * and quietly leaves thinking ON. Universal application makes coverage
 * deterministic: if `disableThinking` is on, `reasoning_effort:"none"` rides
 * every request.
 *
 * Why a `llm/stream` Waterfall and not a dedicated adapter
 * ---------------------------------------------------------
 * A dedicated `registerAdapter` for llama.cpp would be cleaner in principle,
 * but the harness already routes llama.cpp traffic THROUGH the DeepSeek
 * adapter (there is no dedicated llama.cpp adapter package in
 * `packages/llm/`); registering a second adapter risks colliding with the
 * existing registration or being shadowed by composition order. The
 * `llm/stream` seam is the single choke-point before `ctx.llm.stream()` runs
 * (documented in `packages/llm/llm/src/index.ts`) — the officially
 * sanctioned interception point for "adjust how the next call serializes",
 * preserving the single-LLM-exit invariant. See
 * `docs/llm-stream-llamacpp-adaptation.md` §7 for the three sanctioned
 * approaches; this file implements approach A (waterfall interception).
 *
 * @module @falling-ts/dsh-force-compact/wire-rewrite
 */

import { readRawSetting } from '../core/settings.js'

/**
 * Register the `llm/stream` Waterfall listener that appends
 * `reasoning_effort: 'none'` to EVERY outgoing LLM call when `disableThinking`
 * is on. Idempotent within one plugin lifetime (a process-local latch
 * prevents double-registration across multiple `apply` invocations in tests
 * or HMR).
 *
 * Per-call behavior:
 *   1. Await `next()` (MUST call it — this is a Waterfall; skipping `next()`
 *      stalls the request chain). Its return value is the options object the
 *      remainder of the pipeline will serialize. Fall back to `payload` if
 *      `next()` yielded nothing.
 *   2. Read `disableThinking` LAZILY via `readRawSetting` (one synchronous
 *      `settings.get`, cached-friendly). When the `settings` service is not
 *      mounted `readRawSetting` returns `undefined` — treated as OFF, so the
 *      hook is a no-op. (The composition default for `disableThinking` is
 *      `true`, but in the ABSENCE of a readable settings surface the
 *      conservative posture is to leave the wire alone rather than assume.)
 *   3. If `disableThinking !== true`, forward `options` UNCHANGED (zero-cost
 *      short-circuit; no allocation).
 *   4. Otherwise shallow-copy `options` with `reasoning_effort: 'none'` added
 *      (never mutate the shared upstream object) and return the copy.
 *
 * The listener NEVER throws: any unexpected shape is forwarded unchanged, so
 * a misbehaving hook cannot break a business-path model call.
 *
 * Observability: a single `ctx.logger.debug` line is emitted ONLY when the
 * append actually happens (i.e. `disableThinking` on + a well-formed options
 * object), carrying the `provider`/`model` identifiers for post-hoc audit.
 * Skip paths write nothing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether this call actually performed the (once-only)
 *   registration. `false` indicates it was a no-op re-entry (already
 *   installed) or a registration failure (not installed; a later re-entry
 *   will retry).
 */
let installed = false
export function registerLlmStreamHook(ctx) {
  if (installed) return false
  try {
    ctx.on('llm/stream', async (payload, next) => {
      const options = (await next()) ?? payload
      if (options === null || options === undefined || typeof options !== 'object') {
        return options
      }
      // Lazy settings read — hot path costs one synchronous `settings.get`.
      const raw = (await readRawSetting(ctx, 'disableThinking'))
      const wantDisableThinking = raw === true
      if (!wantDisableThinking) return options
      // Double-layer insurance: append the OpenAI-compatible
      // `reasoning_effort:"none"` on top of whatever the adapter serialized
      // (typically `thinking:{type:'disabled'}`). Harmless on every known
      // backend; effective wherever the primary `thinking` field is ignored.
      const rewritten = { ...options, reasoning_effort: 'none' }
      try {
        ctx.logger.debug(
          `[force-compact] llm/stream: appended reasoning_effort="none" `
          + `(disableThinking on) for ${options.provider ?? '?'}/${options.model ?? '?'}`,
        )
      } catch { /* observability must never break the requesting path */ }
      return rewritten
    })
    installed = true
    return true
  } catch {
    // Registration failure (rare: e.g. a context without a usable `on`) is
    // fatal to NOTHING — the plugin simply never installs this hook. We DO
    // NOT mark `installed`, so a later re-entry retries.
    return false
  }
}

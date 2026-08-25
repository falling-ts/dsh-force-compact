/**
 * dsh-force-compact's wire-shape correction for OpenAI-compatible backends —
 * specifically the llama.cpp `llama-server` deployment this plugin routinely
 * drives (:8080, `Qwen3.8-27B-NVFP4-MTP-LOW.gguf`).
 *
 * Problem
 * -------
 * The `disableThinking` setting is expressed in the harness layer as
 * `LlmCallConfig.reasoningEffort = 'off'`, which the DeepSeek adapter turns
 * into the wire field `thinking: { type: 'disabled' }`. That is the right
 * field for the real DeepSeek API. But when the same wire shape lands on a
 * llama.cpp OpenAI-compatible endpoint, `thinking` is NOT in the llama.cpp
 * request schema — it is forwarded opaquely into `llama_params` and IGNORED
 * (verified against `D:\AI\llama.cpp\tools\server\server-common.cpp`:
 * `thinking` appears nowhere in `server-schema.cpp`, and the OAI parsing path
 * never reads a top-level `thinking` key). Net effect: `disableThinking:true`
 * SILENTLY FAILS to turn off thinking on llama.cpp — the model thinks anyway,
 * with no error surfacing.
 *
 * The llama.cpp-native spelling for "disable reasoning" is a TOP-LEVEL wire
 * field `reasoning_effort: "none"` (`server-common.cpp:1295-1304`), which the
 * OAI parser special-cases into `inputs.enable_thinking = false`. An
 * equivalent alternative is `chat_template_kwargs: { enable_thinking: false }`
 * (`server-common.cpp:1286-1291`), but that depends on the jinja template
 * actually honoring `enable_thinking`; `reasoning_effort:"none"` is the most
 * robust because it is unconditionally parsed regardless of template
 * capabilities.
 *
 * Solution
 * --------
 * A `llm/stream` Waterfall listener intercepts every outgoing LLM call just
 * before `ctx.llm.stream()` runs (this seam is the single choke-point —
 * documented in `packages/llm/llm/src/index.ts`). When BOTH hold:
 *   1. the `disableThinking` setting is currently on, AND
 *   2. the target is recognized as an OpenAI-compatible (non-DeepSeek)
 *      provider/model — see {@link isOpenAiCompatibleTarget},
 * the hook APPENDS `reasoning_effort: 'none'` onto the wire request it about
 * to send. The original `thinking` field is left untouched (harmless on
 * llama.cpp, still needed if some other downstream ever consumes it). The
 * hook is a Waterfall — `next()` MUST be awaited and its returned options
 * passed back (possibly replaced by our shallow copy) so the rest of the
 * chain continues. When either condition fails, the hook is a transparent
 * no-op (`return await next()`).
 *
 * Why a Waterfall and not a dedicated adapter
 * -------------------------------------------
 * A dedicated `registerAdapter` for llama.cpp would be cleaner in principle,
 * but the harness already routes llama.cpp traffic THROUGH the DeepSeek
 * adapter (there is no dedicated llama.cpp adapter package in
 * `packages/llm/`); registering a second adapter risks colliding with the
 * existing registration or being shadowed depending on composition order.
 * The `llm/stream` seam is the officially sanctioned interception point for
 * "adjust how the next call serializes" and preserves the single-LLM-exit
 * invariant. See `docs/llm-stream-llamacpp-adaptation.md` §7 for the three
 * sanctioned approaches; this file implements approach A (waterfall
 * interception).
 *
 * Target recognition
 * ------------------
 * We intentionally keep this conservative: only rewrite when the
 * configuration LOOKS like an OpenAI-compatible endpoint. Heuristic
 * (any hit ⇒ treat as llama.cpp-shaped):
 *   - provider id contains `llama` (case-insensitive substring), OR
 *   - model id ends in `.gguf` (the llama.cpp convention: model path is a
 *     GGUF absolute path, see `/v1/models` response on :8080).
 * These cover the deployment this plugin drives today without risking a
 * spurious rewrite on a real DeepSeek deployment. If the heuristic misses a
 * future variant, extend {@link isOpenAiCompatibleTarget} accordingly — the
 * worst outcome of a miss is the silent-fail described above, NOT a crash.
 *
 * @module @falling-ts/dsh-force-compact/wire-rewrite
 */

import { readRawSetting } from '../core/settings.js'

/**
 * Recognize an OpenAI-compatible (specifically llama.cpp-shaped) target from
 * the outgoing LLM call's `provider` / `model` identifiers.
 *
 * Deliberately conservative — a miss only means the rewrite is skipped (and
 * the original silent-fail persists); a wrong positive on a real DeepSeek
 * deployment would inject a `reasoning_effort` key the DeepSeek API ignores
 * (its OpenAI-compat layer tolerates unknown top-level fields), so even the
 * false-positive case degrades gracefully rather than failing the request.
 *
 * @param {unknown} provider
 * @param {unknown} model
 * @returns {boolean}
 */
export function isOpenAiCompatibleTarget(provider, model) {
  const p = typeof provider === 'string' ? provider.toLowerCase() : ''
  if (p.indexOf('llama') !== -1) return true
  const m = typeof model === 'string' ? model.toLowerCase() : ''
  if (m.endsWith('.gguf')) return true
  return false
}

/**
 * Register the `llm/stream` Waterfall listener that appends
 * `reasoning_effort: 'none'` for OpenAI-compatible targets when
 * `disableThinking` is on. Idempotent within one plugin lifetime (a
 * process-local latch prevents double-registration across multiple
 * `apply` invocations in tests or HMR).
 *
 * Registration is DEFERRED to first listener invocation (same pattern as the
 * settings-namespace and command registration in `index.js`): at `apply`
 * execution time the LLM service may not yet be mounted, and a boot-time
 * `ctx.on('llm/stream', …)` attempt could race with adapter registration.
 * Deferring keeps the watermark simple: whichever listener fires first wins
 * the one-time install.
 *
 * The listener itself NEVER throws: every failure is swallowed so that a
 * misbehaving hook cannot break a business-path model call. On success the
 * rewritten options (shallow copy with `reasoning_effort` added) are
 * returned; on any skip path the ORIGINAL options object returned from
 * `next()` is forwarded unchanged.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether this call actually performed the (once-only)
 *   registration. `false` indicates it was a no-op re-entry.
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
      // Lazy settings read — the hot path costs one synchronous `settings.get`.
      // When the `settings` service is not mounted, `readRawSetting` returns
      // `undefined`, treated as the composition default (DISABLED — the
      // feature is OFF until explicitly turned on), so the hook is a no-op
      // in that case. (Composition default for `disableThinking` is `true`,
      // but in the absence of a readable settings surface the conservative
      // posture is to leave the wire alone.)
      const raw = (await readRawSetting(ctx, 'disableThinking'))
      const wantDisableThinking = raw === true
      if (!wantDisableThinking) return options
      if (!isOpenAiCompatibleTarget(options.provider, options.model)) return options
      // Shallow copy so we never mutate the shared upstream options object.
      const rewritten = { ...options, reasoning_effort: 'none' }
      try {
        ctx.logger.debug(
          `[force-compact] llm/stream: appended reasoning_effort="none" for `
          + `OpenAI-compatible target ${options.provider}/${options.model}`,
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

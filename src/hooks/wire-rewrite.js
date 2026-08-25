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
 * Current state: NEUTERED to a pure passthrough
 * ---------------------------------------------
 * The original intent was "Layer 2" — append a SECOND wire field
 * `reasoning_effort: "none"` at the `llm/stream` seam on top of the
 * adapter's `thinking:{type:'disabled'}` (Layer 1) so that a llama.cpp /
 * OpenAI-compatible endpoint (which ignores the top-level `thinking` key)
 * would ALSO receive a field it honors. Live testing PROVED that this cannot
 * be achieved at the `llm/stream` waterfall seam without modifying vendor
 * code, because of two hard walls discovered empirically:
 *
 *   1. FROZEN SEED. The waterfall passes EVERY listener the SAME deep-frozen
 *      `GenerateOptions` seed (`payload`; `ctx.waterfall` re-invokes inner
 *      layers with the identical args — see `vendor/cordis/src/events.ts#
 *      waterfall`). In-place assignment `options.reasoning_effort = …` throws
 *      `Cannot add property …, object is not extensible` at the exact moment
 *      a real LLM call fires, which PROPAGATES OUT OF the listener and TAKES
 *      DOWN THE ENTIRE `dsh web` PROCESS.
 *   2. GENERATOR BINDS THE SEED. The base `adapterStream` is an AsyncGenerator
 *      that BOUND the seed object at construction; building a fresh mutable
 *      clone and returning it (or re-dispatching `this.stream(clone)`) never
 *      reaches the serializer, and re-dispatch additionally fails because the
 *      listener's `this` is not reliably the LlmRuntime here (`Cannot read
 *      properties of undefined (reading 'stream')`).
 *
 * Therefore injecting a NEW top-level wire field at this seam requires either
 * a vendor change (out of scope) or a dedicated `registerAdapter` for
 * llama.cpp (would collide with / be shadowed by the existing DeepSeek-route
 * adapter). Rather than ship a hook that either silently no-ops or CRASHES the
 * host, this file is deliberately reduced to a GUARANTEED pure passthrough:
 * it forwards `next()`'s result (the real stream) untouched and performs NO
 * mutation — incapable of breaking any business-path model call.
 *
 * The AUTHORITATIVE disable-thinking mechanism remains Layer 1 (unchanged):
 * the `agent/request` waterfall sets `reasoningEffort:'off'`, which the
 * DeepSeek adapter serializes to the native `thinking:{type:'disabled'}` —
 * honored by the real DeepSeek API. On a llama.cpp / OpenAI-compatible
 * endpoint that top-level field is tolerated-but-ignored, so thinking stays
 * on there — IDENTICAL to having no plugin at all (a documented limitation,
 * never a crash). Restoring the wire-append requires a future dedicated
 * llama.cpp adapter or a vendor-supported options-extension seam.
 *
 * @module @falling-ts/dsh-force-compact/wire-rewrite
 */

/**
 * Register the `llm/stream` Waterfall listener. As of the neutering described
 * in the module header, the listener is a DELIBERATE pure passthrough: it
 * forwards `next()`'s result (the async-iterable chunk stream) untouched and
 * performs NO mutation. See the module header for why the intended
 * `reasoning_effort:"none"` wire-append is NOT possible at this seam without a
 * vendor change or a dedicated llama.cpp adapter.
 *
 * Idempotent within one plugin lifetime (a process-local latch prevents
 * double-registration across multiple `apply` invocations in tests or HMR).
 *
 * Contract guarantees:
 *   • ALWAYS calls `next()` (skipping it would stall the waterfall chain).
 *   • NEVER mutates the (deep-frozen) seed, so it cannot raise
 *     `object is not extensible`.
 *   • NEVER reshapes/spreads the (stream) return value, so it cannot break the
 *     consumer's `for await`.
 *   • Emits no observable log line (pure passthrough).
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
    ctx.on('llm/stream', (payload, next) => {
      // Pure passthrough — deliberate. See the module header for the two hard
      // walls (deep-frozen seed; base generator binds the seed) that make a
      // `reasoning_effort:"none"` wire-append impossible at this seam without
      // a vendor change or a dedicated llama.cpp adapter. Forwarding `next()`
      // untouched is the only action that is guaranteed neither to mutate the
      // frozen seed nor to destroy the stream value. `payload` is unused by
      // design (kept in the signature for waterfall-contract clarity).
      void payload
      return next()
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

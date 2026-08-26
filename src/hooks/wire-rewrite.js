/**
 * dsh-force-compact's Live-UI watermark side-channel on the `llm/stream`
 * waterfall seam — KICKS OFF a fresh random "working" one-liner on every LLM
 * call START so the Live UI (browser) repaints the `TurnStatus` node with a
 * new `liveUi.working` pair. Purely a PRESENTATION-LAYER concern (a settings-
 * write on the `liveUi` field, mirrored live to the browser via the existing
 * settings-sync channel). Performs NO wire modification whatsoever.
 *
 * Why NOT at the `llm/stream` seam for wire-fields (historical note, 2026-08)
 * ----------------------------------------------------------------------------
 * An EARLIER draft of this module attempted to APPEND the llama.cpp-native
 * wire field `reasoning_effort: "none"` to outgoing LLM calls at this same
 * `llm/stream` seam. That approach is PROVABLY INEFFECTIVE HERE for two
 * independent structural reasons (both verified empirically against the
 * harness dispatch code and Cordis waterfall semantics):
 *
 *   1. WATERFALL IS A LINEAR CHAIN THAT DISCARDS INTERMEDIATE RETURNS.
 *      `ctx.waterfall(...)` (vendor/cordis/src/events.ts:234-243) walks its
 *      listener array sequentially, always passing the SAME frozen seed
 *      `args` to each successive layer, and returns the OUTERMOST layer's
 *      value as the final stream. Intermediate layers' return values are
 *      DROPPED — they influence nothing downstream. Our plugin registers
 *      LAST (lazy-install, default `push` order), so our return reaches
 *      nobody; the innermost thunk receives the ORIGINAL seed reference
 *      regardless of what we return.
 *
 *   2. IN-PLACE ASSIGNMENT TO THE FROZEN SEED CRASHES. The seed is a deep-
 *      frozen (non-extensible) `GenerateOptions`; `seed.reasoning_effort =
 *      'none'` throws `Cannot add property …, object is not extensible` at
 *      the instant a real LLM call fires, propagating OUT OF the listener
 *      into the host process and taking the entire `dsh web` instance down.
 *
 * Net effect: any injection-at-the-waterfall design either CRASHES (wall 1)
 * or SILENTLY NO-OPS (wall 2). Both were observed in live testing on a
 * running 3180 dev instance; that is the documented reason the module was
 * reduced to a pure passthrough.
 *
 * Where the wire-append ACTUALLY lives now (since 2026-08)
 * ----------------------------------------------------------------------
 * The correct single-line fix landed in `src/engine/summarizer.js` IMMEDIATELY
 * BEFORE the `llm.stream(options)` call (search for the comment block titled
 * "LLAMA.CPP COMPATIBILITY WIRE FIELD"): when `extra.reasoningEffort === 'off'`
 * (which `engine/builtin.js` stamps whenever `settings.disableThinking` is
 * true), the summarizer sets `options.reasoning_effort = 'none'` ALONGSIDE the
 * existing camelCase `options.reasoningEffort = 'off'` field (which the
 * DeepSeek adapter serializes to `thinking:{type:'disabled'}`). Emitting BOTH
 * fields covers BOTH endpoints simultaneously:
 *
 *   • Real DeepSeek endpoint: reads `reasoningEffort` → emits
 *     `thinking: { type: 'disabled' }`; ignores the unknown snake_case
 *     `reasoning_effort` top-level key (silent no-op, no 400).
 *   • llama.cpp / OpenAI-compatible endpoint: reads the top-level
 *     `reasoning_effort: "none"` → parses natively into
 *     `inputs.enable_thinking = false` UNCONDITIONALLY
 *     (`D:\AI\llama.cpp\tools\server\server-common.cpp:1295-1304`); the
 *     adapter's `thinking` field (still present in the body) is tolerated-
 *     but-ignored there.
 *
 * Because `builtin.js` gates `extra.reasoningEffort` on
 * `settings.disableThinking`, the wire-field rides the EXACT same scoping
 * rule as the primary one: only emitted on COMPRACTION calls where the user
 * has turned thinking OFF. Business-conversation requests and every other LLM
 * call never reach `summarize()` at all, so they are UNAFFECTED.
 *
 * What THIS FILE STILL DOES (Live-UI watermark)
 * ---------------------------------------------
 * Independent of the wire question above, the listener KICKS OFF a fire-
 * and-forget `publishRandomWorking(ctx)` call BEFORE the synchronization
 * point so the Live UI paints a fresh random "working" one-liner on every LLM
 * call start. This is purely a presentation-layer concern (a settings-write
 * on the `liveUi` field, mirrored live to the browser so it can repaint the
 * `TurnStatus` node) and MUST NOT BLOCK the return path. `publishRandomWorking`
 * swallows ALL of its own rejections internally, so the fire-and-forget form
 * leaks no unhandled rejection and never disturbs the stream.
 *
 * Contract guarantees
 * --------------------
 *   • ALWAYS calls `next()` (skipping it would stall the waterfall chain).
 *   • NEVER mutates the (deep-frozen) seed, so it cannot raise
 *     `object is not extensible`.
 *   • NEVER reshapes / spreads the (stream) return value, so it cannot break
 *     the consumer's `for await`.
 *   • Is DECLARED NON-ASYNC: an `async` listener would wrap `next()`'s stream
 *     return in a Promise, and the waterfall dispatcher's downstream
 *     `yield* <promise>` would throw
 *     `yield* (intermediate value)… is not async iterable` on every call.
 *
 * @module @falling-ts/dsh-force-compact/wire-rewrite
 */

/**
 * Register the `llm/stream` Waterfall listener. As of the historical-note
 * section above, the listener is a DELIBERATE pure passthrough w.r.t. WIRE
 * SEMANTICS: it forwards `next()`'s result (the async-iterable chunk stream)
 * untouched and performs NO mutation. Its sole remaining duty is the Live-UI
 * watermark side-channel (see the module header). See
 * `src/engine/summarizer.js` for where the actual `reasoning_effort` wire
 * field is now injected (at the options-construction site, NOT at this
 * waterfall seam).
 *
 * Idempotent within one plugin lifetime (a process-local latch prevents
 * double-registration across multiple `apply` invocations in tests or HMR).
 *
 * Contract guarantees:
 *   • ALWAYS calls `next()` (skipping it would stall the waterfall chain).
 *   • NEVER mutates the (deep-frozen) seed, so it cannot raise
 *     `object is not extensible`.
 *   • NEVER reshapes / spreads the (stream) return value, so it cannot break
 *     the consumer's `for await`.
 *   • FIRES THE LIVE UI STATUS SIDE-CHANNEL (`core/ui-signal.js`) on every
 *     invocation — the "each LLM call start = fresh random working pair"
 *     watermark. Publication is KICKED OFF FIRE-AND-FORGET (a plain non-
 *     awaited `publishRandomWorking(ctx)` call placed BEFORE the synchronous
 *     `return next()`) so the listener itself STAYS SYNC and can directly hand
 *     back the real stream; `publishRandomWorking` swallows all of its own
 *     rejections internally, so the fire-and-forget form leaks no unhandled
 *     rejection. It never touches `payload` (the deep-frozen seed — left
 *     untouched per the historical-note section above), so it can never stall
 *     or corrupt the stream.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether this call actually performed the (once-only)
 *   registration. `false` indicates it was a no-op re-entry (already installed)
 *   or a registration failure (not installed; a later re-entry will retry).
 */

import { publishRandomWorking } from '../core/ui-signal.js'
let installed = false
export function registerLlmStreamHook(ctx) {
  if (installed) return false
  try {
    // CONTRACT: this listener MUST stay SYNCHRONOUS. The `llm/stream`
    // waterfall expects each layer's RETURN VALUE to BE the (async-iterable)
    // chunk stream itself, so that downstream layers / the dispatcher can
    // immediately `yield*` (or `for await`) it. Making the listener `async`
    // wraps that return in a PROMISE, and the downstream `yield* <promise>`
    // explodes with `yield* (intermediate value)… is not async iterable` —
    // exactly the crash observed on every built-in compaction attempt. The
    // side-channel publication therefore runs FIRE-AND-FORGET (never blocking
    // the return): `publishRandomWorking` swallows ALL of its own rejections
    // internally (guaranteed side-effect-free w.r.t. the waterfall), so
    // kicking it off without awaiting cannot leak an unhandled rejection.
    // `payload` is the deep-frozen GenerateOptions seed — NEVER mutated (see
    // the historical-note section in the module header); the publication
    // touches none of that (pure settings-write on the `liveUi` field,
    // mirrored live to the browser so it can repaint the `TurnStatus` node).
    // `void payload` documents the deliberate non-use.
    ctx.on('llm/stream', (payload, next) => {
      void payload
      publishRandomWorking(ctx)   // fire-and-forget: sync kick-off, async settle
      return next()               // synchronous return of the REAL stream
    })
    installed = true
    return true
  } catch (err) {
    ctx.logger?.warn('[force-compact] wire-rewrite install failed:', err?.message ?? err)
    return false
  }
}

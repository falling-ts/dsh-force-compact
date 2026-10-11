/**
 * RETIRED (2026-10) — this module no longer participates in the plugin.
 *
 * It used to register a `llm/stream` Waterfall listener whose sole duty was the
 * Live-UI watermark: a fire-and-forget `publishRandomWorking(ctx)` on every LLM
 * call start, painting a fresh RANDOM "working" one-liner on the badge. That
 * random-text design was replaced by three explicit AGENT ACTION phases
 * ("模型请求中" / "模型响应中" / "工具执行中"), published from the
 * `agent/request`, `agent/assistant-stream`, and `tools/pre-execute` seams
 * registered in `index.js`. With the random texts gone there is nothing left for
 * an `llm/stream` listener to publish: this seam cannot distinguish "waiting for
 * the first token" from "streaming" (that distinction is exactly what the
 * `agent/request` vs `agent/assistant-stream` pairing expresses), and a listener
 * here would ALSO fire for the plugin's own compaction summarization call, which
 * the user explicitly excluded from the status texts.
 *
 * The historical record below is kept because it documents a structural trap
 * that any future `llm/stream` listener must not re-enter.
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
 *      the instant a real LLM call fires, propagating OUT of the listener
 *      into the host process and taking the entire `dsh web` instance down.
 *
 * Net effect: any injection-at-the-waterfall design either CRASHES (wall 1)
 * or SILENTLY NO-OPS (wall 2). Both were observed in live testing on a
 * running 3080 web instance.
 *
 * Where the wire-append ACTUALLY lives (since 2026-08)
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
 * rule as the primary one: only emitted on COMPACTION calls where the user
 * has turned thinking OFF. Business-conversation requests and every other LLM
 * call never reach `summarize()` at all, so they are UNAFFECTED.
 *
 * @module @falling-ts/dsh-force-compact/wire-rewrite
 */

export {}

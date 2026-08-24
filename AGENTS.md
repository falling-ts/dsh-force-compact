# AGENTS.md — dsh-force-compact

These rules apply to `dsh-force-compact/` and supplement the [collection
conventions](../AGENTS.md).

- The plugin's only durable effect is the `compaction` service's summary node
  appended to the session log; the plugin introduces no other state. Do not
  introduce timers, in-memory stores, or client UI — keep it a pure Host
  listener on `session/flush`.
- `compaction` is a hard dependency (`inject` + `ctx.compaction`). `agents` is
  optional (`ctx.get('agents')`, guarded for `undefined`); a missing Agent is a
  logged skip, not an error.
- The listener is async and relied upon: `session/flush` is an awaited
  `parallel` checkpoint, so the compaction must complete before the listener
  returns. Do not detach it into fire-and-forget without making the durability
  guarantee explicit.
- A fresh `AbortController` is minted per flush (the awaited checkpoint covers
  its lifetime); pass its `signal` to the summarizer and `compactRegion`.
- The compaction implementation lives in `src/`:
  - `src/config.js` — tunables (fixed constants, not cordis `Config` fields).
  - `src/region.js` — the plugin's own head-anchored region selection (retain a
    recent tail by surface-node count; end on a `user/message` boundary so the
    delegated `compactRegion` never rejects it for unpaired tool calls).
  - `src/summarizer.js` — the plugin's own one-shot LLM summarizer (replays the
    region, appends a compaction directive, streams through `ctx.llm`).
  - `src/compact.js` — the orchestrator: select region → project region
    messages → run the preview + shrink gate → delegate the durable mutation to
    `ctx.compaction.compactRegion(start, end, agent, signal)`.
  - `src/index.js` — the Cordis function plugin entry (`name` / `inject` /
    `apply`).
- The plugin's own summarizer is a **pre-commit preview + shrink gate**: it
  verifies the compaction is worthwhile before committing. The durable summary
  content is the `compaction` service's authoritative one (`compactRegion`
  re-summarizes and commits). Do not double-summarize in the durable path.
- Monorepo integration wraps this in `src/index.ts` and adds a REAL-composition
  test that boots a test-only `cordis.yml` and asserts the durable summary node;
  this standalone artifact is plain JS with no build step.

## Session data model — what this plugin appends into

The session is an **event-sourced, append-only log** of `SessionEvent`s and is
the single source of truth. LLM history is never stored; it is **derived** via
`deriveMessages()` from that log. There is no separate "conversation" object —
turns, steps, messages, tool calls, compaction, todo, and hooks are all rows in
one log. (Full vocabulary and payload declarations: the upstream
`docs/persistence-catalog` + `docs/subsystems/persistence`; distilled analysis
in this repo's `docs/context-management-analysis.md`.)

**Event envelope** (every row): `{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`.
`seq` is monotonic and contiguous within the session (first event `seq=0`).
`ignorable` absent = required: a reader meeting an unknown *required* type MUST
refuse to rebuild rather than silently drop it. `sourceEventSeqs` / `surfaceOp`
exist **only on surface events**.

**Surface vs log-only.** Only three `type`s are *surface* — `user/message`,
`assistant/message`, `tool/result` — the only ones that produce LLM messages and
enter `deriveMessages()`, and the only ones allowed to carry `surfaceOp` /
`sourceEventSeqs`. Every other `type` is *log-only*: durable and replayable but
never part of the derived history (`turn/*`, `step/*`, `tool/call`,
`compaction/*`, `todo/write`, `hook/*`, `approval/*`, …).

**On disk.** One JSONL line per event, default-wrapped in concatenated
checksummed zstd frames (one frame per append batch); a SQLite backend stores
packed chunk rows instead. `SESSION_FORMAT_VERSION = 0` — pre-release, no
migration; a backend refuses any other version. Crash recovery never truncates:
a left-open `turn/start` is closed with a synthetic
`turn/end { reason: { kind: 'interrupted' } }`.

**What dsh-force-compact appends** (its whole durable effect, via the
`compaction` service): a log-only `compaction/*` node (e.g.
`compaction/summary` with `shadowedRange` / `shadowedSeqs` /
`shadowedTokenCount`), which carries no `surfaceOp` and so never enters model
history by itself, followed synchronously by a **surface `user/message`**
carrying `surfaceOp: { op: 'replace', start, end }` that shadows the compacted
range — that `replace` is the actual surface replacement. Reasoning/"think" is
a **content-block type** (`ContentBlock.type === 'reasoning'`), not an event
type: it travels inside `assistant/message.content` (assembled from
`reasoning-delta` stream chunks / `reasoning-chunks` rows) and the UI renders
it as a collapsible region via `toAssistantBlock()`.

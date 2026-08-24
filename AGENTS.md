# AGENTS.md — dsh-compact

These rules apply to `dsh-compact/` and supplement the [collection
conventions](../AGENTS.md).

- The plugin's only durable effect is the `compaction.compactNow` summary node
  appended to the session log; there is no other state. Do not introduce timers,
  in-memory stores, or client UI — keep it a pure Host listener on
  `session/flush`.
- `compaction` is a hard dependency (`inject` + `ctx.compaction`). `agents` is
  optional (`ctx.get('agents')`, guarded for `undefined`); a missing Agent is a
  logged skip, not an error.
- The listener is async and relied upon: `session/flush` is an awaited
  `parallel` checkpoint, so the `compactNow` call must complete before the
  listener returns. Do not detach it into fire-and-forget without making the
  durability guarantee explicit.
- `compactNow(agent, undefined)` passes no cancellation signal; the
  compaction is fire-and-forget. Do not invent an `AbortController` global that
  is not confirmed by the Host builtins.
- A `null` `compactNow` result is a safe no-op (nothing useful to compact);
  repeated flushes must stay harmless, and the service already prevents
  concurrent same-session compaction.
- Monorepo integration wraps this in `src/index.ts` and adds a
  REAL-composition test that boots a test-only `cordis.yml` and asserts the
  durable summary node; this standalone artifact is plain JS with no build step.

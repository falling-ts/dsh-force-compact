# Session Auto-Compact

English | [中文](README.zh.md)

`@deepseek-ai/dsh-compact` is a DSH **Cordis function plugin** that
automatically compacts a session's useful history into a single summary node at
every session durability checkpoint. When a session's buffered events are about
to reach durable storage, the plugin summarizes the compactable span so the
durable log stays lean.

## How it works

- Listens to **`session/flush`** — an awaited `parallel` durability checkpoint.
  Because the checkpoint awaits every listener, the compaction finishes before the
  caller proceeds, so the summary is durable.
- Resolves the session's live `Agent` via the `agents` service and calls
  **`compaction.compactNow(agent)`**, which force-compacts useful history even
  below the automatic pressure thresholds.
- A `null` result is a safe no-op (nothing useful to compact), so repeated
  flushes are harmless. The `compaction` service prevents concurrent compaction
  of the same session.

```
session/flush(session)
   └─ session.id
   └─ agents.get(session.id)          → live Agent (skip if absent)
   └─ compaction.compactNow(agent)
        ├─ null  → no-op (nothing useful to compact)
        └─ result → compacted a useful span into one summary node
```

## Install

```sh
# From a local copy or git:
dsh web --patch dsh-compact/cordis.yml
```

The overlay inserts the `auto-compact` function plugin into the current
composition without changing shipped defaults.

## Behavior notes

- **Hard dependency:** the `compaction` service. Without it the plugin does
  nothing.
- **Optional dependency:** the `agents` service. If a flush fires after the
  session's Agent is already unregistered, the plugin logs
  `no live agent … — skipping` and skips that checkpoint.
- **Signal:** the compaction is fire-and-forget, so no cancellation signal is
  passed.

## Known limitations

- The plugin compacts at the **durability checkpoint** (`session/flush`), which
  may fire before the Agent is disposed. If your deployment disposes the Agent
  before the final flush, the last compaction may be skipped; listen to
  `agent/disposed` (whose payload carries the `Agent` directly) instead if that
  ordering matters to you.
- No client/browser UI is registered; the plugin is Host-only and observable
  only through `[auto-compact]` log lines and the durable log.

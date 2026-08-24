# dsh-force-compact

English | [中文](README.cn.md)

`@falling-ts/dsh-force-compact` is a DSH **Cordis function plugin** that
compacts a session's useful history at every session durability checkpoint
(`session/flush`). It owns its region-selection policy and LLM summarizer, then
delegates the durable surface mutation to the `compaction` service.

## How it works

- Listens to **`session/flush`** — an awaited `parallel` durability checkpoint.
  Because the checkpoint awaits every listener, the compaction finishes before
  the caller proceeds, so the summary is durable.
- Resolves the session's live `Agent` via the `agents` service.
- **`src/region.js`** — the plugin's own head-anchored region selection: retain
  a recent tail (by surface-node count) and end the span on a `user/message`
  boundary (always a balanced boundary).
- **`src/summarizer.js`** — the plugin's own one-shot LLM summarizer: replays
  the region's messages, appends a compaction directive as the final user
  message, streams through `ctx.llm`, and returns the condensed checkpoint.
- **`src/compact.js`** — the orchestrator: select region → project region
  messages → run the preview + shrink gate → delegate the durable mutation to
  **`ctx.compaction.compactRegion(start, end, agent, signal)`**, which is the
  authoritative summarizer.

```
session/flush(session)
   └─ session.id
   └─ agents.get(session.id)          → live Agent (skip if absent)
   └─ src/compact.js
        ├─ region.select(session)     → {start, end} or null (skip)
        ├─ projectRegionMessages()    → region messages
        ├─ summarizer.summarize()     → preview + shrink gate
        └─ compaction.compactRegion(start, end, agent, signal)
             ├─ null  → no-op (nothing useful to compact)
             └─ result → compacted the span into one summary node
```

## Install

As an installable bundle (recommended):

```sh
# from git:
dsh plugin --profile web add github:falling-ts/dsh-force-compact
# from a local checkout:
dsh plugin --profile web add ./dsh-force-compact
```

or, from a local checkout, as a `--patch` overlay without installing:

```sh
dsh web --patch dsh-force-compact/cordis.patch.yml
```

The layer inserts the `force-compact` function plugin into the current
composition without changing shipped defaults.

## Settings (强制压缩配置)

When the `settings` service is mounted (the web bundle always mounts it via
`@deepseek-ai/dsh-settings-file`), the plugin registers a `force-compact`
settings namespace so two parameters are user-tunable from
`$DSH_HOME/settings.yaml`:

| key | type | default | effect |
| --- | --- | --- | --- |
| `disableThinking` | `boolean` | `true` | when `true`, the plugin's summarization request carries `reasoningEffort: 'off'`, which the LLM adapter maps to `thinking: { type: 'disabled' }` — the provider's thinking/reasoning is switched off for the compaction summarization call. |
| `autoThresholdTokens` | `number` | `120000` | the automatic compaction trigger threshold in tokens. Compaction runs only when the session's estimated total context is **at least** this many tokens; below it, the checkpoint is skipped. |

Example `$DSH_HOME/settings.yaml`:

```yaml
force-compact:
  disableThinking: true
  autoThresholdTokens: 120000
```

When the `settings` service is absent, the plugin falls back to these same
defaults and still compacts normally — the settings namespace is optional, never
a hard dependency.

## Behavior notes

- **Hard dependency:** the `compaction` service. Without it the plugin does
  nothing.
- **Optional dependency:** the `agents` service. If a flush fires after the
  session's Agent is already unregistered, the plugin logs
  `no live agent … — skipping` and skips that checkpoint.
- **Optional dependency:** the `settings` service. When absent, the two
  parameters resolve to their defaults.
- **Signal:** the compaction is fire-and-forget at the checkpoint; a fresh
  `AbortController` is minted per flush.

## Known limitations

- The plugin compacts at the **durability checkpoint** (`session/flush`), which
  may fire before the Agent is disposed. If your deployment disposes the Agent
  before the final flush, the last compaction may be skipped; listen to
  `agent/disposed` (whose payload carries the `Agent` directly) instead if that
  ordering matters to you.
- The plugin's own summarizer is a **pre-commit preview + shrink gate**; the
  durable summary content is the `compaction` service's authoritative one.
- No client/browser UI is registered; the plugin is Host-only. The two
  parameters are tunable through the `force-compact` settings namespace (a
  future dynamic client plugin may read it to expose a settings page), and the
  plugin is observable through `[force-compact]` log lines and the durable log.

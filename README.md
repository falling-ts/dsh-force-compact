# dsh-force-compact

English | [中文](README.cn.md)

`@falling-ts/dsh-force-compact` is a DSH **Cordis function plugin** that
**hooks the core model-request seam**. On every model request it reads the
"强制压缩配置" (`falling-ts-force-compact`) settings and:

- disables **thinking/reasoning** on the request when `disableThinking` is on,
  and
- **force-compacts** the session's context (instead of calling the model) when
  the session's total context tokens reach `autoThresholdTokens`.

It additionally compacts useful history at every session durability checkpoint
(`session/flush`), owning its region-selection policy and LLM summarizer and
delegating the durable surface mutation to the `compaction` service.

## How it works

The plugin hooks the official model-request Waterfalls so the decision is made
**right before a model request is made** (the "hook the core model request"
requirement), plus the durability checkpoint:

- **`agent/request`** — a Waterfall around the frozen call configuration. When
  `disableThinking` is on, the returned `LlmCallConfig` carries
  `reasoningEffort: 'off'`, which the LLM adapter maps to
  `thinking: { type: 'disabled' }`. Every model request in the process is
  therefore sent with thinking disabled. The settings are read here (per
  request), so a `settings.yaml` edit is picked up on the next request.
- **`agent/pre-step`** — a Waterfall before each model step. It reads the
  session's **total context tokens** through the `tokenMeter` service. When the
  total is **>= `autoThresholdTokens`**, it returns `{ kind: 'reject' }` so the
  model request is **not** made, and runs a **forced compaction** via
  `ctx.compaction.compactNow` (which condenses the useful history and lets the
  loop retry with a smaller context).
- **`session/flush`** — an awaited `parallel` durability checkpoint. Because
  the checkpoint awaits every listener, the compaction finishes before the
  caller proceeds, so the summary is durable.
- **`/force-compact`** — a slash command (selected from the `/` list) that
  force-compacts the agent's session. Its handler runs **without sending the
  line to the model**, so it can act on a **busy** agent: when idle it compacts
  immediately; when the agent is mid-turn it inserts a **process-local force
  flag** (a JS memory record — no durable state, no timer) that the
  `agent/pre-step` hook reads at the next model step. When the flag is present,
  that step **skips the token threshold**, force-compacts immediately, and
  returns `{ kind: 'reject' }` so the model request is **not** made.

Supporting modules:

- **`src/request-guard.js`** — the per-request guard: `agent/request`
  thinking-off + `agent/pre-step` threshold gate + forced compaction + the
  `/force-compact` process-local force flag.
- **`src/command.js`** — the `/force-compact` slash command (idle → compact
  now; busy → queue the force flag for the next model step).
- **`src/region.js`** — the plugin's own head-anchored region selection (used by
  the checkpoint path): retain a recent tail (by surface-node count) and end
  the span on a `user/message` boundary (always a balanced boundary).
- **`src/summarizer.js`** — the plugin's own one-shot LLM summarizer: replays
  the region's messages, appends a compaction directive as the final user
  message, streams through `ctx.llm`, and returns the condensed checkpoint.
- **`src/compact.js`** — the checkpoint orchestrator: select region → project
  region messages → run the preview + shrink gate → delegate the durable
  mutation to **`ctx.compaction.compactRegion(start, end, agent, signal)`**,
  which is the authoritative summarizer.

```
agent/request(payload, next)              # every model request
    settings.get("falling-ts-force-compact") -> disableThinking?
        return { ...config, reasoningEffort: "off" }   # thinking off

agent/pre-step(payload, next)             # before each model step
    tokenMeter.measure(session).totalTokens >= autoThresholdTokens?
        no  -> next()                      # let the model request proceed
        yes -> compaction.compactNow(agent, signal)   # force compact
              return { kind: "reject" }    # NO model request this step

session/flush(session)                    # durability checkpoint
    agents.get(session.id)                -> live Agent (skip if absent)
    region.select(session)                -> {start, end} or null (skip)
    projectRegionMessages()               -> region messages
    summarizer.summarize()                -> preview + shrink gate
    compaction.compactRegion(start, end, agent, signal)
        null   -> no-op (nothing useful to compact)
        result -> compacted the span into one summary node
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
`@deepseek-ai/dsh-settings-file`), the plugin registers the
`falling-ts-force-compact` settings namespace so six parameters are user-tunable
from `$DSH_HOME/settings.yaml` (the `falling-ts-` prefix prevents collisions
with other plugins' keys):

| key | type | default | effect |
| --- | --- | --- | --- |
| `disableThinking` | `boolean` | `true` | when `true`, **every model request** carries `reasoningEffort: 'off'`, which the LLM adapter maps to `thinking: { type: 'disabled' }` — the provider's thinking/reasoning is switched off for the request. Also applies to the plugin's own summarization calls. |
| `autoThresholdTokens` | `number` | `80000` | the forced-compaction trigger threshold in tokens. **Before a model request**, the session's total context tokens (via `tokenMeter`) are measured; when they are **>= this value**, the request is rejected and a forced compaction runs instead. The `session/flush` checkpoint path also uses this threshold as its trigger gate. |
| `autoEarliestRatio` | `number` | `0.3` | **auto compact-earliest-conversation ratio** — the fraction of the session's surface history the `agent/pre-step` threshold gate compacts from the **head** (the oldest `autoEarliestRatio` of the conversation) when it fires. |
| `forceEarliestRatio` | `number` | `0.5` | **force compact-earliest-conversation ratio** — the fraction of the conversation the `/force-compact` command compacts from the **head** (idle → compact now; busy → queued for the next model step). |
| `turnEndForceCompactionEnabled` | `boolean` | `true` | **enable turn-end force compaction** — when `true`, a turn-end forced compaction runs at each `turn/end`. |
| `turnEndCompactionRatio` | `number` | `0.4` | **turn-end force compaction ratio** — the fraction of the conversation the turn-end forced compaction compacts from the **head**. |

Example `$DSH_HOME/settings.yaml`:

```yaml
falling-ts-force-compact:
  disableThinking: true
  autoThresholdTokens: 80000
  autoEarliestRatio: 0.3
  forceEarliestRatio: 0.5
  turnEndForceCompactionEnabled: true
  turnEndCompactionRatio: 0.4
```

When the `settings` service is absent, the plugin falls back to these same
defaults and still compacts normally — the settings namespace is optional, never
a hard dependency.

## Behavior notes

- **Hard dependency:** the `compaction` service. Without it the plugin does
  nothing (the forced-compaction path falls through and lets the request
  proceed).
- **Optional dependency:** the `agents` service. Used only by the `session/flush`
  checkpoint path; if a flush fires after the Agent is unregistered, the plugin
  logs `no live agent … — skipping` and skips that checkpoint. The `agent/*`
  Waterfalls receive the `Agent` in their payload and need no `agents` lookup.
- **Optional dependency:** the `settings` service. When absent, the parameters
  resolve to their defaults (`disableThinking: true`, `autoThresholdTokens:
  80000`, `autoEarliestRatio: 0.3`, `forceEarliestRatio: 0.5`,
  `turnEndForceCompactionEnabled: true`, `turnEndCompactionRatio: 0.4`).
- **Optional dependency:** the `tokenMeter` service. Used by the `agent/pre-step`
  threshold gate; when absent, the gate falls back to a coarse character-based
  estimate of the session's surface content.
- **Per-request settings read:** both parameters are read **per model request**
  (synchronous `settings.get('falling-ts-force-compact')`), so a `settings.yaml`
  edit is picked up on the next request without a restart.
- **Signal:** the `agent/*` Waterfalls forward the current turn's signal; the
  `session/flush` checkpoint mints a fresh `AbortController` per flush.

## Known limitations

- The plugin compacts at the **durability checkpoint** (`session/flush`), which
  may fire before the Agent is disposed. If your deployment disposes the Agent
  before the final flush, the last compaction may be skipped; listen to
  `agent/disposed` (whose payload carries the `Agent` directly) instead if that
  ordering matters to you.
- The plugin's own summarizer is a **pre-commit preview + shrink gate**; the
  durable summary content is the `compaction` service's authoritative one.
- The forced-compaction gate **rejects the proposed model step** when the
  threshold is reached, then relies on the loop retrying against the shrunken
  context. If `compactNow` finds no safe range (e.g. nothing useful left to
  compact), the request proceeds as-is rather than looping.
- No client/browser UI is registered; the plugin is Host-only. The two
  parameters are tunable through the `falling-ts-force-compact` settings
  namespace (a future dynamic client plugin may read it to expose a settings
  page), and the plugin is observable through `[force-compact]` log lines and
  the durable log.

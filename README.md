# dsh-force-compact

**Aggressive, local-first context compaction for DeepSeek Harness agents.**

A DSH **Cordis function plugin** that keeps the agent's working context lean *by design*, so you
can deliver a **large-window experience** against a self-hosted llama.cpp serving `Qwen3.8‑27B`
at modest context — no API cost, no data egress.

[中文](README.cn.md)

---

## Why

Most harness setups bolt a big frontier model onto a short context budget. This plugin makes
the opposite bet: **you own the weights, the endpoint, and the context budget.**

- **Self-hosted inference.** Point the agent at a local OpenAI-compatible llama.cpp server
  running `Qwen3.8‑27B` (GGUF / NVFP4 / MTP variants all work through the standard DeepSeek
  adapter path — no separate llama.cpp adapter needed).
- **Low context, high signal.** Rather than fight a small hard cap, the plugin **shrinks the
  conversation itself**, so the agent reasons over a tight, high-signal prompt while effectively
  reaching a much larger working memory.
- **Thinking-off by default.** `disableThinking: true` turns off reasoning effort on **every**
  outbound call, enforced at two complementary seams (real DeepSeek honors one; llama.cpp honors
  the other — see "Backend-agnostic thinking control" below).
- **Private & free.** No per-token billing, no egress, and the exact model/context tradeoff is
  yours to dial.

---

## What it does

Two compaction engines coexist behind one facade (`resolveCompaction`), transparent to callers:

| Engine | Used when | Notes |
|--------|-----------|-------|
| **Official** | `compaction` service is resolvable in the agent realm | Preferred; delegates to `compaction/basic`. |
| **Builtin** | Automatic fallback when the service is realm-isolated (typical standard preset) | Self-contained persistent transaction using only `ctx.sessions` / `ctx.llm.stream` / `ctx.tokenMeter`. Reuses the official `compaction/*` event vocabulary, so it survives cross-build replay with no `ignorable` hacks. |

You never toggle — official wins when reachable, builtin takes over otherwise.

### Trigger points

- **Per-request guard (`agent/pre-step`)** — reads the session's *projected* context tokens
  (the exact number the harness renders bottom-right, provider-anchored). At
  `autoThresholdTokens` it rejects the outgoing request and compacts the head instead, retaining
  the latest `retainLatestTokens` verbatim.
- **Turn-end / idle (`agent/status` → `idle`)** — when the agent quiesces, optionally compacts
  via `compactNow` (gate: `turnEndForceCompactionEnabled`).
- **Manual `/force-compact`** — immediate `compactNow` when idle; queues a process-local force
  flag consumed at the next model step when busy.
- **`session/flush`** — the awaited durability checkpoint.

Every path funnels into the single *"compaction result landed in the session"* boundary — the
same point where the live-UI signal fires.

### Provider-anchored decisions

Decisions key off `projectedTokens` (same figure shown in the UI corner), so the plugin never
drifts from what you see. Threshold-aware shrink gates skip summarizer calls that provably could
not pull the session below the threshold (kills the low-threshold dead loop).

### Meter-aligned shadow-price billing

The builtin transaction bills `shadowedTokenCount` from the **same** `tokenMeter.measure`
per-node prices the official engine uses, so the meter's collapse protocol settles the drop
correctly — the bottom-right counter goes *down* after compaction instead of drifting upward.

### Backend-agnostic thinking control

`disableThinking` is enforced at **two complementary seams**:

1. **Request seam** — `reasoningEffort:'off'` → the DeepSeek adapter serializes
   `thinking:{type:'disabled'}` (real DeepSeek APIs honor it).
2. **Wire seam (`llm/stream`)** — the plugin appends top-level `reasoning_effort:"none"`
   post-serialization, which llama.cpp's OpenAI-compatible layer parses natively
   (`server-common.cpp` maps it to `enable_thinking=false`, independent of template capability).
   Real DeepSeek endpoints simply ignore the unknown key.

Result: thinking is genuinely off on **any** backend, with no target-sniffing heuristic to miss
a route.

### Live-UI status

A tiny host→client messenger (a `liveUi` settings field mirrored live to the browser) paints a
badge beside the turn:

- **🟥 compressing** — pinned red `[强制压缩中>>>]`, fired just before a compaction commits;
- **🟢 done** — pinned green `[压缩完成!]`, fired the instant a compaction result lands; 3 s
  later a fresh random "working" pair takes over;
- **🔵 working** — otherwise a playful random one-liner ("正在缝合上下文…", "正在憋大招…").

Publishers are fail-safe: a messenger glitch can never disturb the actual compaction.

---

## How it works

```
agent/request(payload, next)              # every model request
    disableThinking? -> { ...config, reasoningEffort: "off" }

agent/pre-step(payload, next)             # before each model step
    projectedTokens >= autoThresholdTokens?
        no  -> next()                     # let the model request proceed
        yes -> compactRegion(head-before-retainLatestTokens, signal)
              return { kind: "reject" }   # no model request this step

agent/status({ agent, status })          # lifecycle transition
    status === "idle" && turnEndForceCompactionEnabled?
        -> compactNow(agent, freshSignal) # turn-end compaction

session/flush(session)                   # durability checkpoint
    select region -> project messages -> preview + shrink gate
    -> compaction.compactRegion(start, end, agent, signal)
```

Supporting modules:

- `src/hooks/guard.js` — per-request guard: thinking-off + threshold gate + forced flag.
- `src/hooks/command.js` — the `/force-compact` command.
- `src/hooks/idle.js` — turn-end forced compaction.
- `src/hooks/wire-rewrite.js` — the `llm/stream` wire patch appending `reasoning_effort:"none"`.
- `src/engine/region.js` — head/tail-anchored region selection (with the official pairing ledger).
- `src/engine/summarizer.js` — the one-shot LLM summarizer (fully aligned with official
  `compaction-basic`: target resolution, prefix-cache alignment, `purpose:'compaction'` tag,
  fail-closed finish classification, usage capture).
- `src/engine/builtin.js` — the builtin persistent transaction (official `compaction/*` vocab).
- `src/engine/checkpoint.js` — preview + shrink gate + delegation to the compaction service.
- `src/core/projected.js` — provider-anchored `projectedTokens` reading.
- `src/core/ui-signal.js` — the live-UI messenger.

---

## Install

As an installable bundle (recommended):

```sh
# from npm (published):
npm install @falling-ts/dsh-force-compact
# from git:
dsh plugin --profile web add github:falling-ts/dsh-force-compact
# from a local checkout:
dsh plugin --profile web add ./dsh-force-compact
```

Or, from a local checkout, as a `--patch` overlay without installing:

```sh
dsh web --patch dsh-force-compact/cordis.patch.yml
```

Plugin loaded ⟺ `~/.dsh/logs/dsh-force-compact.log` gains:

```
[force-compact] debug logging enabled — writing [force-compact] lines to <absolute path>
```

Verify a compaction happened:

```
idle compaction (builtin) shadowed N nodes (~M tokens)
builtin compaction OK — replaced span seq[A..B] (N nodes, ~K tokens) with a P-char checkpoint
```

---

## Settings

`$DSH_HOME/settings.yaml`, namespace `falling-ts-force-compact`:

| key | type | default | meaning |
|-----|------|---------|---------|
| `disableThinking` | boolean | `true` | Disable reasoning effort on **every** outbound call (both seams above). |
| `autoThresholdTokens` | number ≥ 32000 | `32000` | Projected-token trigger for the per-request gate. Lower ⇒ more aggressive. **Floor 32000** (stored values clamp back up at read time). |
| `retainLatestTokens` | positive int ≥ 8000 | `8000` | Retain the latest N tokens verbatim; send everything older to the summarizer in one batch. **Floor 8000.** Drives both the auto gate and the `/force-compact` path. |
| `turnEndForceCompactionEnabled` | boolean | `true` | Compact on the agent's `idle` transition. |
| `debug` | boolean | `true` | Emit `[force-compact]` diagnostics to the plugin log. |
| `logFile` | string | `~/.dsh/logs/dsh-force-compact.log` | Diagnostics destination (`~` expands to home dir). |
| `compactionMode` | `'realm' \| 'global'` | `'realm'` | Official-service resolution strategy (priority-1 path). |
| `builtinEnabled` | boolean | `true` | Gate for the builtin engine fallback. |
| `maxSummaryTokens` | integer (1024–200000) | `1024` | Cap on the summarizer LLM `maxTokens`. |

Example — an aggressive **local** profile:

```yaml
falling-ts-force-compact:
  disableThinking: true
  autoThresholdTokens: 40000   # compact sooner ⇒ keep the live prompt small
  retainLatestTokens: 8000
  turnEndForceCompactionEnabled: true
```

When the `settings` service is absent, the plugin falls back to the same defaults and still
compacts — the namespace is optional, never a hard dependency.

---

## Screenshots

![Settings panel — "Force Compaction / 强制压缩" section with all five knobs live-editable](assets/settings-panel.png)

*Settings panel — `设置 > 强制压缩`. All nine fields above can be edited live without restart.*

![Live conversation — red "[forced compacting>>>]" badge pinned beside an in-flight turn](assets/live-conversation.png)

*Conversation page — the live-UI signal paints three states (🟥 compressing / 🟢 done / 🔵 working);
the green banner fades after ~3 s back to a random "working" line.*

### Tuning for low-context llama.cpp

Serve `Qwen3.8‑27B` with a comfortable-but-modest context and let the plugin decide the
effective window: keep `autoThresholdTokens` comfortably **below** the served context so the
live prompt stays small and latency flat, while the agent retains deep memory through the
compressed head. Pressure is measured in *projected* tokens (provider-anchored), so the
threshold maps predictably onto what the UI shows you.

---

## Behavior notes

- **Runtime dependency:** the `compaction` service (preset plane `agent-presets:compaction-basic`).
  Read live via `ctx.get('compaction')`; when unreachable the forced-compaction path falls
  through and lets the request proceed.
- **Optional dependencies:** `settings` / `tokenMeter` / `commands` / `llm` / `agents` are read
  via `ctx.get(...)` with guards — a missing one degrades gracefully rather than crashing.
- **Per-request settings read:** parameters are read per model request, so edits take effect on
  the next request without a restart.
- **Signals:** the `agent/*` Waterfalls forward the current turn's signal; the `session/flush`
  checkpoint and the `agent/status` idle listener each mint a fresh `AbortController`.
- **Persistence:** the durable output is the `compaction/*` bracket events + a
  `surfaceOp:replace` `user/message` checkpoint, replay-safe across builds.
- **Client half:** `web/client.js` adds a Settings section "强制压缩 / Force Compact" for
  editing these values live (uSES-safe mirror, no timers/state).
- **One intentional timer:** the 3 s `publishDone` fallback (presentation-only, documented
  deviation). Otherwise the plugin is pure listeners + a process-local `Map` force flag.

---

## License

MIT (see LICENSE).

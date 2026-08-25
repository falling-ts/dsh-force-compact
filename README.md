# dsh-force-compact

**Local-first, aggressive context compaction for DeepSeek Harness agents.**

A DSH **Cordis function plugin** that keeps your agent's working context lean *by design*, so you
can serve a **genuinely large effective window** against a **self-hosted llama.cpp running
Qwen3.8‑27B** at modest context — getting smooth, low‑latency, high‑quality answers without API
costs or any data leaving your machine.

English | [中文](README.cn.md)

---

## Why run Qwen3.8‑27B locally on llama.cpp, at low context?

Most harness setups bolt a big frontier model onto a short context budget. This plugin makes the
opposite bet: **you own the weights, the endpoint, and the context budget.**

- **Self‑hosted inference.** Point the agent at a local OpenAI‑compatible llama.cpp server
  running `Qwen3.8‑27B` (GGUF / NVFP4 / MTP variants all work through the standard DeepSeek
  adapter path — no separate llama.cpp adapter required). Conversations never leave the box.
- **Stay fast by staying low.** llama.cpp serves a 27B model with a modest context while keeping
  per‑step latency and VRAM in check. Aggressive compaction is what makes that viable: rather than
  fight a small hard cap, the plugin **shrinks the conversation itself**, so the agent always
  reasons over a tight, high‑signal prompt while effectively reaching a far larger working
  memory.
- **Thinking‑off by default.** `disableThinking: true` turns off the model's internal reasoning
  effort on **every** outbound call (business requests *and* the plugin's own summarization
  calls) — faster loops, less token burn. Enforced twice for reliability (see
  "Backend‑agnostic thinking control").
- **Cheaper, private, yours.** No per‑token billing, no data egress, and you dial the exact
  model/context tradeoff.

> **Net effect:** a big‑window *experience* (long sessions, many tools, multi‑turn goals)
> delivered by a locally‑served 27B model at low context. The compression is what makes it feel
> effortless — dramatically better compression efficiency means a dramatically smoother agent
> experience.

---

## What the plugin does

Two compaction engines coexist behind one facade (`resolveCompaction`), transparent to callers:

| Engine | When used | Notes |
|--------|-----------|-------|
| **Official** | When the `compaction` service is reachable in the agent realm | Preferred; delegates to `compaction/basic`. |
| **Builtin** | Automatic fallback when the service is realm‑isolated (typical standard preset) | Self‑contained persistent transaction using only `ctx.sessions` / `ctx.llm.stream` / `ctx.tokenMeter`. Reuses the official `compaction/*` event vocabulary, so it survives cross‑build replay with no `ignorable` hacks. |

You never toggle between them — official wins when reachable, builtin takes over otherwise.

### Trigger points

- **Per‑request guard (`agent/pre-step`)** — reads the session's *projected* context tokens (the
  exact number the harness renders bottom‑right, provider‑anchored). When it reaches
  `autoThresholdTokens`, it rejects the outgoing model request and compacts the head instead,
  retaining the latest `retainLatestTokens` verbatim.
- **Turn‑end / idle compaction (`agent/status` → `idle`)** — when the agent quiesces (all turns
  and sub‑agents done), optionally compacts through `compactNow` (gate:
  `turnEndForceCompactionEnabled`).
- **Manual `/force-compact` slash command** — acts on a *busy* or *idle* agent: compacts
  immediately when idle, or queues a process‑local force flag consumed at the next model step
  when busy.
- **`session/flush` checkpoint** — the awaited durability checkpoint.

Every path funnels into the single *"compaction result landed in the session"* boundary — the
same place the live UI signal is emitted (below).

### Decision basis is *provider‑anchored*

Decisions key off `projectedTokens` — the same figure shown in the UI corner — so the plugin
never drifts from what you see. Heavy CJK / tool‑JSON content is priced at the meter's
chars‑per‑token density for consistency, and a threshold‑aware shrink gate skips summarization
LLM calls that provably could not pull the session below the threshold (eliminating the
low‑threshold dead loop).

### Shadow‑price accounting aligned with the meter

The builtin transaction bills `shadowedTokenCount` from the **same** `tokenMeter.measure`
per‑node prices the official engine uses, so the meter's collapse protocol settles the drop
correctly — the bottom‑right counter goes *down* after compaction instead of drifting upward.

### Backend‑agnostic thinking control

`disableThinking` is enforced at **two complementary seams**:

1. **Request seam** — `reasoningEffort:'off'` → the DeepSeek adapter serializes
   `thinking:{type:'disabled'}` (real DeepSeek APIs honor it).
2. **Wire seam (`llm/stream`)** — the plugin appends top‑level `reasoning_effort:"none"`
   post‑serialization, which llama.cpp's OpenAI‑compatible layer parses natively
   (`server‑common.cpp` maps it to `enable_thinking=false` regardless of template capability).
   Real DeepSeek endpoints simply ignore the unknown key.

Result: thinking is genuinely off on **any** backend — including your local llama.cpp — with no
target‑sniffing heuristic to miss a route.

### Live UI status

A tiny host→client messenger (a `liveUi` settings field, mirrored live to the browser) paints a
badge beside the turn:

- 🟥 `compressing` — pinned red `[强制压缩中>>>]`, fired just before a compaction commits;
- 🟢 `done` — pinned green `[压缩完成!]`, fired the instant a compaction result lands in the
  session, then falls back to a fresh random "working" pair after 3 s;
- 🔵 `working` — otherwise a playful random one‑liner ("正在缝合上下文…", "正在憋大招…").

Publishers are fail‑safe: a messenger glitch can never disturb the actual compaction.

---

## How it works

The plugin hooks the official model‑request Waterfalls so the decision happens **right before a
model request is made**, plus the durability checkpoint:

- **`agent/request`** — a Waterfall around the frozen call configuration. When `disableThinking`
  is on, the returned config carries `reasoningEffort:'off'`. Settings are read **per request**,
  so a `settings.yaml` edit is picked up on the next request.
- **`agent/pre-step`** — a Waterfall before each model step. Reads the session's *projected*
  tokens; when `>= autoThresholdTokens` it returns `{ kind:'reject' }` (no model request) and
  compacts the head while retaining the latest `retainLatestTokens`.
- **`session/flush`** — an awaited `parallel` checkpoint, so compaction completes before the
  caller proceeds.
- **`/force-compact`** — a slash command acting without sending the line to the model:
  immediate `compactNow` when idle; queued force flag when busy.

```
agent/request(payload, next)              # every model request
    disableThinking? -> { ...config, reasoningEffort: "off" }

agent/pre-step(payload, next)             # before each model step
    projectedTokens >= autoThresholdTokens?
        no  -> next()                       # let the model request proceed
        yes -> compactRegion(head-before-retainLatestTokens, signal)
              return { kind: "reject" }     # NO model request this step

agent/status({ agent, status })           # lifecycle transition
    status === "idle" && turnEndForceCompactionEnabled?
        -> compactNow(agent, freshSignal)   # turn-end compaction

session/flush(session)                    # durability checkpoint
    select region -> project messages -> preview + shrink gate
    -> compaction.compactRegion(start, end, agent, signal)
```

Supporting modules:

- `src/hooks/guard.js` — per‑request guard: thinking‑off + threshold gate + forced flag.
- `src/hooks/command.js` — the `/force-compact` command.
- `src/hooks/idle.js` — turn‑end forced compaction.
- `src/hooks/wire-rewrite.js` — the `llm/stream` wire patch appending `reasoning_effort:"none"`.
- `src/engine/region.js` — head/tail‑anchored region selection (+ official pairing ledger).
- `src/engine/summarizer.js` — the one‑shot LLM summarizer.
- `src/engine/builtin.js` — the builtin persistent transaction (official `compaction/*` vocab).
- `src/core/projected.js` — the provider‑anchored `projectedTokens` reading.
- `src/core/ui-signal.js` — the live UI messenger.

---

## Install & verify

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

## Settings (`$DSH_HOME/settings.yaml`, namespace `falling-ts-force-compact`)

| key | type | default | meaning |
|-----|------|---------|---------|
| `disableThinking` | boolean | `true` | Disable model reasoning effort on **every** outbound call (both seams above). |
| `autoThresholdTokens` | number ≥ 32000 | `32000` | Projected‑token trigger for the per‑request gate. Lower ⇒ more aggressive, leaner context. **Floor 32000** (stored values clamp back up at read time). |
| `retainLatestTokens` | positive int ≥ 8000 | `8000` | Retain the latest N tokens verbatim; send everything older to the summarizer in one batch. **Floor 8000**. Drives both the auto gate and the `/force-compact` path. |
| `turnEndForceCompactionEnabled` | boolean | `true` | Compact on the agent's `idle` transition. |
| `debug` | boolean | `true` | Emit `[force-compact]` diagnostics to the plugin log. |
| `logFile` | string | `~/.dsh/logs/dsh-force-compact.log` | Diagnostics destination (`~` expands to home dir). |
| `compactionMode` | `'realm' \| 'global'` | `'realm'` | Official‑service resolution strategy (priority‑1 path). |
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

### Tuning for low‑context llama.cpp

Serve Qwen3.8‑27B with a comfortable‑but‑modest context, then let the plugin decide the
effective window: keep `autoThresholdTokens` comfortably **below** your served context so the
live prompt stays small and latency flat, while the agent retains deep memory through the
compressed head. Because pressure is measured in *projected* tokens (provider‑anchored), the
threshold maps predictably onto what the UI shows you.

---

## Behavior notes & limitations

- **Runtime dependency:** the `compaction` service (preset plane
  `agent-presets:compaction-basic`). Read live via `ctx.get('compaction')`; when unavailable the
  forced‑compaction path falls through and lets the request proceed.
- **Optional dependencies:** `settings`, `tokenMeter`, `commands`, `llm`, `agents` are read via
  `ctx.get(...)` with guards — a missing one degrades gracefully rather than crashing.
- **Per‑request settings read:** parameters are read per model request, so edits take effect on
  the next request without a restart.
- **Signals:** the `agent/*` Waterfalls forward the current turn's signal; the `session/flush`
  checkpoint and the `agent/status` idle listener each mint a fresh `AbortController`.
- **Persistence:** the durable output is the compaction bracket events + a `surfaceOp:replace`
  `user/message` checkpoint, replay‑safe across builds.
- **Client half:** `web/client.js` adds a Settings section "强制压缩 / Force Compact" for editing
  these values live (uSES‑safe mirror, no timers/state).
- **No timers except one:** the single intentional timer is the 3 s `publishDone` fallback
  (presentation‑only, documented deviation). Otherwise the plugin is pure listeners + a
  process‑local `Map` force flag.

---

## License

MIT (see LICENSE).

---
---

# dsh-force-compact —— 面向本地推理的「本地优先 · 激进压缩」插件

**为 DeepSeek Harness agent 提供的上下文压缩能力:本地优先、极简上下文、最大化 agent 使用体验。**

这是一个 DSH **Cordis 函数插件**:它让 agent 的工作上下文**始终保持在紧凑、高信号的区间**,从而
让你能用**自托管 llama.cpp 服务上的 Qwen3.8‑27B**(低上下文配置)跑出**接近大窗口**的体验——更低
延迟、更高可用、数据不出本机,且不产生任何 API 费用。

[English](README.md) | 中文

---

## 为什么要在 llama.cpp 上本地跑 Qwen3.8‑27B、并且刻意压低上下文?

主流做法是把大模型塞进短上下文预算里硬扛。本插件反其道而行:**权重、端点、上下文预算都由你自己
掌控。**

- **自托管推理。** 把 agent 指向一个本地 OpenAI 兼容的 llama.cpp 服务器,运行 `Qwen3.8‑27B`
  (GGUF / NVFP4 / MTP 变体均可走标准 DeepSeek 适配器路径,**无需单独的 llama.cpp 适配器**)。
  对话全程不离开本机。
- **低上下文也能又快又省。** llama.cpp 允许你用适中上下文服务 27B 模型,保持单步延迟与显存都可控。
  激进压缩正是让它可行的关键:不与小硬上限较劲,而是**直接收缩会话本身**——agent 永远在一个紧凑、
  高信号的小 prompt 上推理,却等效获得更大的工作记忆。
- **默认关闭思考。** `disableThinking: true` 对**每一次出站调用**(业务请求 + 摘要调用)都关闭模型
  的内部推理努力——循环更快、token 消耗更低,并在两个互补缝上双重保障(见下文)。
- **更省钱、更私有、归你。** 无按 token 计费、无数据外泄,模型与上下文的取舍完全由你调。

> **净效果:** **大窗口的体验**(长会话、大量工具调用、多轮目标)由一个本地服务的 27B 模型 +
> 低上下文交付。**压缩效率的大幅提升,直接换来 agent 使用体验的大幅改善**——这就是本插件的核心价值。

---

## 插件做了什么

两条压缩引擎通过统一 facade(`resolveCompaction`)并存,对调用者透明:

| 引擎 | 何时使用 | 说明 |
|------|----------|------|
| **官方** | agent realm 内可解析到 `compaction` 服务时 | 首选,委托给 `compaction/basic`。 |
| **内置** | 官方服务被 realm 隔离时自动接管(典型标准预设) | 自包含持久事务,仅依赖 `ctx.sessions` / `ctx.llm.stream` / `ctx.tokenMeter`;复用官方 `compaction/*` 事件词汇,跨 build 重放存活、无需 `ignorable` hack。 |

你**无需手动切换**:官方可达就用官方,不可达才落到内置。

### 触发点

- **每请求门禁(`agent/pre-step`)** —— 读取会话的 *投影* 上下文 token(与 harness 右下角显示的同一
  数值,provider 锚定)。达到 `autoThresholdTokens` 时,拒绝发起模型请求,改为压缩头段,并逐字保留
  最新的 `retainLatestTokens`。
- **回合结束 / idle 压缩(`agent/status` → `idle`)** —— agent 静止(含子代理全部结束)时,可选地经
  `compactNow` 压缩(开关:`turnEndForceCompactionEnabled`)。
- **手动 `/force-compact` 斜杠命令** —— 对忙/闲 agent 都能生效:空闲立即压缩;繁忙则排队一个
  process‑local 强制标记,在下一个模型步骤消费。
- **`session/flush` 检查点** —— 等待型的持久化检查点。

每条路径最终都汇入唯一的「**压缩结果落入会话**」边界——也正是**发送 liveUI 信令**的位置。

### 判定基准是 *provider 锚定* 的

判定使用 `projectedTokens`(与 UI 角标同款数值),插件因此永不偏离你所见的数字。重度 CJK /
tool‑JSON 内容按米表 chars/token 密度计价以保持口径一致;阈值感知的缩容门禁会跳过「注定无法把会话
降到阈值以下」的摘要 LLM 调用(消灭低阈值死循环)。

### 影子价格记账与米表对齐

内置事务的 `shadowedTokenCount` 取自**与官方相同的** `tokenMeter.measure` 逐节点单价,使米表的折叠
协议正确结算下降——压缩后右下角计数是**下降**而非漂移上涨。

### 后端无关的思考控制

`disableThinking` 在**两个互补的缝**上强制执行:

1. **请求缝** —— `reasoningEffort:'off'` → DeepSeek 适配器序列化为 `thinking:{type:'disabled'}`
   (真 DeepSeek API 认这个字段)。
2. **wire 缝(`llm/stream`)** —— 插件在序列化后追加顶层 `reasoning_effort:"none"`,llama.cpp 的
   OpenAI 兼容层原生解析(`server‑common.cpp` 映射到 `enable_thinking=false`,与模板能力无关)。
   真 DeepSeek 端点忽略未知键。

结果:在任何后端(包括本地 llama.cpp)上都**确实关闭了思考**,不依赖目标嗅探启发式而漏判路由。

### LiveUI 状态

一个极小的 host→client 信令通道(`liveUi` 设置字段,实时镜像到浏览器),在 turn 旁绘制徽标:

- 🟥 `compressing` —— 固定红字 `[强制压缩中>>>]`,在压缩提交前一刻发出;
- 🟢 `done` —— 固定绿字 `[压缩完成!]`,**在压缩结果落入会话的瞬间**发出,3 秒后回落为一组全新随机的
  working 文案;
- 🔵 `working` —— 否则是一条玩梗式的随机短句("正在缝合上下文…"、"正在憋大招…")。

发布器绝对安全:信令故障永远不会干扰真实压缩事务。

---

## 工作原理

插件钩住官方的模型请求 Waterfall,使决策发生在**真正发起模型请求之前**,以及持久化检查点上:

- **`agent/request`** —— 围绕冻结调用配置的 Waterfall。`disableThinking` 开启时返回携带
  `reasoningEffort:'off'` 的配置。参数**每次请求**读取,故 `settings.yaml` 改动下次请求即生效。
- **`agent/pre-step`** —— 每个模型步骤前的 Waterfall。读取 *投影* token,达到 `autoThresholdTokens`
  时返回 `{ kind:'reject' }`(不发起模型请求),并压缩头段、逐字保留最新 `retainLatestTokens`。
- **`session/flush`** —— 等待型 `parallel` 检查点,保证压缩在调用方继续前完成。
- **`/force-compact`** —— 斜杠命令,不把该行发送给模型:空闲立即 `compactNow`,繁忙排队强制标记。

```
agent/request(payload, next)              # 每次模型请求
    disableThinking? -> { ...config, reasoningEffort: "off" }

agent/pre-step(payload, next)             # 每个模型步骤前
    projectedTokens >= autoThresholdTokens?
        no  -> next()                       # 放行模型请求
        yes -> compactRegion(head-before-retainLatestTokens, signal)
              return { kind: "reject" }     # 本步不请求模型

agent/status({ agent, status })           # 生命周期过渡
    status === "idle" && turnEndForceCompactionEnabled?
        -> compactNow(agent, freshSignal)   # 回合结束压缩

session/flush(session)                    # 持久化检查点
    选区 -> 投影消息 -> 预览 + 缩容门禁
    -> compaction.compactRegion(start, end, agent, signal)
```

支撑模块:

- `src/hooks/guard.js` —— 每请求门禁:关思考 + 阈值门 + 强制标记。
- `src/hooks/command.js` —— `/force-compact` 命令。
- `src/hooks/idle.js` —— 回合结束强制压缩。
- `src/hooks/wire-rewrite.js` —— `llm/stream` wire 补丁,追加 `reasoning_effort:"none"`。
- `src/engine/region.js` —— 头/尾锚定的选区(含官方配对账本)。
- `src/engine/summarizer.js` —— 一次性 LLM 摘要器。
- `src/engine/builtin.js` —— 内置持久事务(官方 `compaction/*` 词汇)。
- `src/core/projected.js` —— provider 锚定的 `projectedTokens` 读取。
- `src/core/ui-signal.js` —— liveUI 信令器。

---

## 安装与验证

作为可安装 bundle(推荐):

```sh
# 从 git:
dsh plugin --profile web add github:falling-ts/dsh-force-compact
# 从本地 checkout:
dsh plugin --profile web add ./dsh-force-compact
```

或本地 checkout 不经安装、仅作 `--patch` 叠加:

```sh
dsh web --patch dsh-force-compact/cordis.patch.yml
```

插件已加载 ⟺ `~/.dsh/logs/dsh-force-compact.log` 出现:

```
[force-compact] debug logging enabled — writing [force-compact] lines to <绝对路径>
```

验证压缩确实发生:

```
idle compaction (builtin) shadowed N nodes (~M tokens)
builtin compaction OK — replaced span seq[A..B] (N nodes, ~K tokens) with a P-char checkpoint
```

---

## 配置(`$DSH_HOME/settings.yaml`,命名空间 `falling-ts-force-compact`)

| 键 | 类型 | 默认 | 含义 |
|----|------|------|------|
| `disableThinking` | boolean | `true` | 每次出站调用关闭模型推理努力(上述两缝)。 |
| `autoThresholdTokens` | number ≥ 32000 | `32000` | 每请求门禁的投影 token 阈值。越低越激进、上下文越瘦。**下限 32000**(存储值读取时抬升)。 |
| `retainLatestTokens` | 正整数 ≥ 8000 | `8000` | 逐字保留最新 N tokens;更早内容一次性发给摘要器。**下限 8000**。同时驱动自动门禁与 `/force-compact`。 |
| `turnEndForceCompactionEnabled` | boolean | `true` | 在 agent `idle` 过渡时压缩。 |
| `debug` | boolean | `true` | 输出 `[force-compact]` 诊断到插件日志。 |
| `logFile` | string | `~/.dsh/logs/dsh-force-compact.log` | 诊断输出路径(`~` 展开为用户家目录)。 |
| `compactionMode` | `'realm' \| 'global'` | `'realm'` | 官方服务解析策略(priority‑1 路径)。 |
| `builtinEnabled` | boolean | `true` | 内置引擎后备闸门。 |
| `maxSummaryTokens` | 整数 (1024–200000) | `1024` | 摘要 LLM 调用的 `maxTokens` 上限。 |

示例——激进的**本地**配置:

```yaml
falling-ts-force-compact:
  disableThinking: true
  autoThresholdTokens: 40000   # 更早压缩 ⇒ 常驻 prompt 更小
  retainLatestTokens: 8000
  turnEndForceCompactionEnabled: true
```

当 `settings` 服务缺席时,插件回退到相同默认值并照常压缩——该命名空间是可选的,绝不成为硬依赖。

### 面向低上下文 llama.cpp 的调参建议

用舒适但适中的上下文服务 Qwen3.8‑27B,把有效窗口交给插件决定:将 `autoThresholdTokens` 设在**明显
低于**你服务的上下文,使常驻 prompt 保持小、延迟平稳,而 agent 仍通过被压缩的头段保留深层记忆。由于
压力按 *投影* token(provider 锚定)度量,阈值会可预测地对应到你 UI 上看到的数字。

---

## 行为说明与限制

- **运行时依赖:** `compaction` 服务(preset 平面 `agent-presets:compaction-basic`)。经
  `ctx.get('compaction')` 实时读取;不可用时强制压缩路径放行、让请求继续。
- **可选依赖:** `settings` / `tokenMeter` / `commands` / `llm` / `agents` 均经 `ctx.get(...)` 读取并
  守卫;缺任一都优雅降级而非崩溃。
- **每请求读参数:** 参数每次模型请求读取,故改动下次请求即生效、无需重启。
- **信号:** `agent/*` Waterfall 转发当前 turn 的 signal;`session/flush` 检查点与 `agent/status`
  idle 监听器各自新建 `AbortController`。
- **持久性:** 持久产物为压缩括号事件 + 带 `surfaceOp:replace` 的 `user/message` 检查点,跨 build
  重放安全。
- **客户端半部:** `web/client.js` 新增设置分区 "强制压缩 / Force Compact",支持实时改值(uSES 安全的
  镜像,无 timer/状态)。
- **除一处外无 timer:** 唯一有意保留的是 3 s 的 `publishDone` 回落(纯表现层,已在文档声明)。其余均为
  纯监听器 + 一个 process‑local `Map` 强制标记。

---

## License

MIT(见 LICENSE)。

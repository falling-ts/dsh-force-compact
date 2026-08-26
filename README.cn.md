# dsh-force-compact

**面向本地推理的「本地优先 · 激进压缩」插件。**

`@falling-ts/dsh-force-compact` 是一个 DSH **Cordis 函数插件**,它让 agent 的工作上下文**始终
保持在紧凑、高信号的区间**,从而让你能用自托管 llama.cpp 服务上的 `Qwen3.8‑27B`(低上下文
配置)跑出**接近大窗口**的体验——更低延迟、数据不出本机、无 API 费用。

[English](README.md)

---

## 为什么做这件事

主流做法是把大模型塞进短上下文预算里硬扛。本插件反其道而行:**权重、端点、上下文预算都由你
自己掌控。**

- **自托管推理。** 把 agent 指向本地 OpenAI 兼容的 llama.cpp 服务器,运行 `Qwen3.8‑27B`
  (GGUF / NVFP4 / MTP 变体均可走标准 DeepSeek 适配器路径,**无需单独的 llama.cpp 适配器**)。
- **低上下文、高信号。** 不与小硬上限较劲,而是**直接收缩会话本身**——agent 永远在紧凑、
  高信号的小 prompt 上推理,却等效获得更大的工作记忆。
- **压缩关闭思考,业务放行。** `disableThinking: true`(**默认**)只对**本插件自己发出的压缩
  摘要调用**关闭推理努力;**其它**模型请求(业务对话、子代理、工具触发、其它插件)一律沿用
  机器自身配置,不再被插件批量盖章(2026-08 语义收窄,见下文「思考控制:仅作用于压缩」)。
- **私有且免费。** 无按 token 计费、无数据外泄,模型与上下文的取舍完全由你调。

---

## 插件做了什么

两条压缩引擎通过统一 facade(`resolveCompaction`)并存,对调用者透明:

| 引擎 | 何时使用 | 说明 |
|------|----------|------|
| **官方** | agent realm 内可解析到 `compaction` 服务时 | 首选,委托给 `compaction/basic`。 |
| **内置** | 官方服务被 realm 隔离时自动接管(典型标准预设) | 自包含持久事务,仅依赖 `ctx.sessions` / `ctx.llm.stream` / `ctx.tokenMeter`;复用官方 `compaction/*` 事件词汇,跨 build 重放存活、无需 `ignorable` hack。 |

你**无需手动切换**:官方可达就用官方,不可达才落到内置。

### 触发点

- **每请求门禁(`agent/pre-step`)** —— 读取会话的 *投影* 上下文 token(与 harness 右下角显示
  的同一数值,provider 锚定)。达到 `autoThresholdTokens` 时,拒绝发起模型请求,改为压缩头段,
  并逐字保留最新的 `retainLatestTokens`。
- **回合结束 / idle(`agent/status` → `idle`)** —— agent 静止(含子代理全部结束)时,可选地
  经 `compactNow` 压缩(开关:`turnEndForceCompactionEnabled`)。
- **手动 `/force-compact` 斜杠命令** —— 对忙/闲 agent 都能生效:空闲立即压缩;繁忙则排队一个
  process-local 强制标记,在下一个模型步骤消费。
- **`session/flush` 检查点** —— 等待型的持久化检查点。

每条路径最终都汇入唯一的「**压缩结果落入会话**」边界——也正是**发送 liveUI 信令**的位置。

### 判定基准是 provider 锚定的

判定使用 `projectedTokens`(与 UI 角标同款数值),插件因此永不偏离你所见的数字。阈值感知的
缩容门禁会跳过「注定无法把会话降到阈值以下」的摘要 LLM 调用(消灭低阈值死循环)。

### 影子价格记账与米表对齐

内置事务的 `shadowedTokenCount` 取自**与官方相同的** `tokenMeter.measure` 逐节点单价,使米表
的折叠协议正确结算下降——压缩后右下角计数是**下降**而非漂移上涨。

### 思考控制:仅作用于压缩

2026-08 语义收窄后,`disableThinking` **只控制一件事**:本插件自己的压缩摘要调用
(`engine/builtin.js` → `engine/summarizer.js` → `ctx.llm.stream`)是否携带
`reasoningEffort:'off'`。其它一切请求**原样放行**:

| 调用点 | `disableThinking: true` 时的行为 |
|---|---|
| 本插件内置引擎的压缩摘要调用 | 携带 `reasoningEffort:'off'` |
| **其它**所有模型请求——业务对话、子代理委派、工具触发、其它插件 | 沿用机器自身的 `LlmCallConfig` **原样不变**,`settings.yaml` / 请求头配了什么就用什么 |
| 官方 `compaction` 服务的摘要调用 | 不经过本插件的任何缝,不受影响 |

旧的 `agent/request` 批量盖章(打击**所有**业务请求,却讽刺性地**摸不到**任何一个摘要调用
——摘要器直连 `ctx.llm.stream`,根本不走 agent-loop 那条缝)已经移除。
`src/hooks/wire-rewrite.js` 只保留 LiveUI 水印职责,**不再**在 `llm/stream` 缝上做任何 wire 操作。

但是当摘要调用目标是 **llama.cpp / OpenAI 兼容端点**(适配器从 `reasoningEffort:'off'`
产出的 `thinking: { type: 'disabled' }` 字段会被 llama.cpp 的 OAI 解析路径**静默
忽略**)时,摘要器**同时**盖上 llama.cpp 原生的顶层 wire 字段
`reasoning_effort: "none"` —— 门控规则与 camelCase `reasoningEffort` 孪生字段
**完全一致**(只在 `extra.reasoningEffort === 'off'` 时加盖,即
`settings.disableThinking` 为真时)。一个 options 对象同时携带**两个** wire
字段,同时覆盖两类端点:

| 端点家族 | 读取的字段 | 结果 |
|---|---|---|
| 真·DeepSeek API | `reasoningEffort:'off'`(camelCase)→ 序列化为 `thinking:{type:'disabled'}` | 关闭思考 ✅ |
| llama.cpp / OAI 兼容 | `reasoning_effort:"none"`(蛇形顶层)→ 原生解析 | `enable_thinking=false` ✅ |

两类端点对未知的顶层键都是**容忍但不读**,所以同体发出两个字段跨家族无害。
该 wire 字段在 `src/engine/summarizer.js` 的 `llm.stream(options)` 调用**之前**加盖,
**不是**在 `llm/stream` waterfall 监听器里 —— 早期草案曾在该缝上尝试注入,实证证明
结构性无效(waterfall 中间层返回值被丢弃;原地修改种子会炸宿主)。完整论述见
`src/hooks/wire-rewrite.js` 模块头部。

如需在**业务对话**上也关闭思考(不仅压缩),请在**请求头层面**自行配置
provider 的 `reasoningEffort` —— 本插件已刻意退出这一决策。

#### 可观测性:每次摘要尝试的审计行

每一次摘要尝试都会在插件日志(default `debug: true` 可见)打出**两行** `[force-compact]`
诊断,让你**无需抓包**即可核实范围裁决与实际 wire 字段:

```
[force-compact] <sessionId>: compaction thinking-policy — settings.disableThinking=true → extra.reasoningEffort='off' (this summarization call carries thinking-OFF)
[force-compact] <sessionId>: summarization wire-fields → <provider>/<model>: reasoningEffort='off' + reasoning_effort="none" (llama.cpp-native wire field)
```

- **第一行**打在 `disableThinking` 设置被读取并路由进调用 options 的位置
  (`engine/builtin.js`);设置关闭时改为记录本次调用*沿用机器默认*。
- **第二行**打在 llama.cpp 兼容加盖处(`engine/summarizer.js`),记录**离开
  options 对象瞬间的两个 wire 字段**与解析到的 provider/model——"这次压缩的
  关思考到底有没有落到 wire 上"的持久答案;未加盖的字段会显式标注 `(absent…)`。

wire 结论有实证背书而非纸面规格:在本机 llama.cpp OpenAI 兼容端点
(`Qwen3.8‑27B`)上,A/B/C 对照实测——**不带** `reasoning_effort` 的基线请求返回了
非空的 `reasoning_content`(模型默认会思考),而带上顶层 `reasoning_effort:"none"`
的同款请求**完全没有** `reasoning_content`——即该字段在此类端点上真实关闭思考;
业务调用(不带该字段)则维持正常思考。

### LiveUI 状态

一个极小的 host→client 信令通道(`liveUi` 设置字段,实时镜像到浏览器),在 turn 旁绘制徽标:

- **🟥 compressing** —— 固定红色 `[强制压缩中>>>]`,在压缩提交前一刻发出;
- **🟢 done** —— 固定绿色 `[压缩完成!]`,**在压缩结果落入会话的瞬间**发出,3 秒后回落为一组
  全新的随机 working 文案;
- **🔵 working** —— 否则是一条玩梗式的随机短句("正在缝合上下文…"、"正在憋大招…"),颜色为
  20 色深色色板随机抽取。

发布器绝对安全:信令故障永远不会干扰真实压缩事务。

---

## 工作原理

插件钩住官方的模型请求 Waterfall,使决策发生在**真正发起模型请求之前**,以及持久化检查点上:

```
agent/request(payload, next)              # 每次模型请求
    return await next()                  # 纯透传(2026-08 语义收窄:disableThinking
                                         # 只作用于本插件自己的压缩摘要调用)

agent/pre-step(payload, next)             # 每个模型步骤前
    projectedTokens >= autoThresholdTokens?
        否  -> next()                       # 放行模型请求
        是  -> compactRegion(head-before-retainLatestTokens, signal)
               return { kind: "reject" }    # 本步不请求模型

agent/status({ agent, status })          # 生命周期过渡
    status === "idle" && turnEndForceCompactionEnabled?
        -> compactNow(agent, freshSignal)   # 回合结束压缩

session/flush(session)                    # 持久化检查点
    选区 -> 投影消息 -> 预览 + 缩容门禁
    -> compaction.compactRegion(start, end, agent, signal)
```

支撑模块:

- `src/hooks/guard.js` —— 每请求门禁:`agent/request` 纯透传(不再批量盖思考章)+ `pre-step`
  阈值门 + process-local 强制标记(`thinkingDisabled` 仅作 legacy predicate 保留,热路径不再调用)。
- `src/hooks/command.js` —— `/force-compact` 命令。
- `src/hooks/idle.js` —— 回合结束强制压缩。
- `src/hooks/wire-rewrite.js` —— `llm/stream` 的 LiveUI 水印钩子(已不再做 wire 操作;
  见模块头部历史注记了解原因)。
- `src/engine/region.js` —— 头/尾锚定的选区(含官方工具配对账本)。
- `src/engine/summarizer.js` —— 一次性 LLM 摘要器(与官方 `compaction-basic` 全面对齐:
  三级 target 解析、前缀缓存对齐、`purpose:'compaction'` 标签、fail-closed finish 分类、
  usage 采集)。
- `src/engine/builtin.js` —— 内置持久事务(官方 `compaction/*` 词汇)。
- `src/engine/checkpoint.js` —— 预览 + 缩容门禁 + 委托 compaction 服务。
- `src/core/projected.js` —— provider 锚定的 `projectedTokens` 读取。
- `src/core/ui-signal.js` —— liveUI 信令器。

---

## 安装与验证

作为可安装 bundle(推荐):

```sh
# 从 npm(已发布):
npm install @falling-ts/dsh-force-compact
# 从 git:
dsh plugin --profile web add github:falling-ts/dsh-force-compact
# 从本地检出:
dsh plugin --profile web add ./dsh-force-compact
```

或从本地检出,以 `--patch` overlay 挂载(不安装):

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
compaction thinking-policy — settings.disableThinking=true → extra.reasoningEffort='off' (…)
summarization wire-fields → <provider>/<model>: reasoningEffort='off' + reasoning_effort="none" (…)
```

(最后两行即上文「可观测性」所述的那对每次尝试审计行——它们为该次尝试提供了
关思考裁决与其 wire 字段的直接凭证。)

---

## 配置

`$DSH_HOME/settings.yaml`,命名空间 `falling-ts-force-compact`:

| 键 | 类型 | 默认 | 含义 |
|----|------|------|------|
| `disableThinking` | boolean | `true` | 为 `true` 时**仅**本插件的压缩摘要调用携带 `reasoningEffort:'off'`;其它模型请求沿用机器配置原样放行(2026-08 语义收窄,见上文「思考控制:仅作用于压缩」)。 |
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

用舒适但适中的上下文服务 `Qwen3.8‑27B`,把有效窗口交给插件决定:将 `autoThresholdTokens` 设在
**明显低于**你服务的上下文,使常驻 prompt 保持小、延迟平稳,而 agent 仍通过被压缩的头段保留
深层记忆。由于压力按 *投影* token(provider 锚定)度量,阈值会可预测地对应到你 UI 上看到的
数字。

---

## 行为说明

- **运行时依赖:** `compaction` 服务(preset 平面 `agent-presets:compaction-basic`)。经
  `ctx.get('compaction')` 实时读取;不可用时强制压缩路径放行、让请求继续。
- **可选依赖:** `settings` / `tokenMeter` / `commands` / `llm` / `agents` 均经 `ctx.get(...)`
  读取并守卫;缺任一都优雅降级而非崩溃。
- **每请求读参数:** 参数每次模型请求读取,故改动下次请求即生效、无需重启。
- **信号:** `agent/*` Waterfall 转发当前 turn 的 signal;`session/flush` 检查点与
  `agent/status` idle 监听器各自新建 `AbortController`。
- **持久性:** 持久产物为 `compaction/*` 括号事件 + 带 `surfaceOp:replace` 的
  `user/message` 检查点,跨 build 重放安全。
- **客户端半部:** `web/client.js` 新增设置分区 "强制压缩 / Force Compact",支持实时改值
  (uSES 安全的镜像,无 timer/状态)。
- **除一处外无 timer:** 唯一有意保留的是 3 s 的 `publishDone` 回落(纯表现层,已在文档声明)。
  其余均为纯监听器 + 一个 process-local `Map` 强制标记。

---

## 截图

![设置面板 —「强制压缩」分区,五个旋钮全部支持在线编辑](assets/settings-panel.png)

*设置面板 — `设置 > 强制压缩`。上面九个字段都可以实时编辑,无需重启。*

![会话页 — 红色 `[强制压缩中>>>]` 徽章挂在正在进行的回合旁边](assets/live-conversation.png)

*会话页 — live-UI 信令有三种状态(🟥 压缩中 / 🟢 已完成 / 🔵 工作中),绿色横幅约 3 s 后淡出回到随机「工作中」文案。*

---

## License

MIT(见 LICENSE)。

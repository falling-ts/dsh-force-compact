# AGENTS.md — dsh-force-compact

本规则适用于 `dsh-force-compact/`，并补充[集合约定](../AGENTS.md)。

- 插件唯一的持久效果是 `compaction` 服务追加到会话日志的摘要节点；插件不引入其他状态。不要引入 timer、内存态存储或 client UI——保持它是**核心模型请求缝**（`agent/request` / `agent/pre-step`）与 `session/flush` 上的纯 Host 监听器。
- `compaction` 是硬依赖（`inject` + `ctx.compaction`）。`agents`、`settings`、`tokenMeter`、`commands` 都是可选依赖（`ctx.get(...)`，对 `undefined` 做守卫）：`agents` 仅供 `session/flush` 路径（缺少 Agent 是记录日志后跳过）；缺少 `settings` 时两个参数回退到默认值；缺少 `tokenMeter` 时阈值门禁回退到粗略字符估算；缺少 `commands` 时 `/force-compact` 命令不注册（`src/command.js` 是 no-op）。
- **钩住核心模型请求（`agent/request` / `agent/pre-step`）：** 插件的核心行为是钩住官方模型请求缝，**每次请求模型前**读取设置：
  - **`agent/request`**（围绕冻结调用配置的 Waterfall）——`disableThinking` 为 `true` 时，返回的 `LlmCallConfig` 携带 `reasoningEffort: 'off'`（适配器映射为 `thinking: { type: 'disabled' }`），即**每次模型请求**都关闭思考。监听器 `await next()` 取得机器本会使用的配置，再返回替换值；**不得**在缺少 `next()` 时短路（必须调用 `next()`）。
  - **`agent/pre-step`**（每个模型步骤前的 Waterfall）——通过 `tokenMeter.measure(session).totalTokens` 读取会话上下文总 tokens；当其**≥ `autoThresholdTokens`** 时，返回 `{ kind: 'reject' }` **不发起模型请求**，并从头压缩最早 `autoEarliestRatio` 的对话（`compactRegion`）；低于阈值时调用 `next()` 让请求继续。强制压缩失败（无安全区间 / 已活跃）时降级为 `next()`，绝不阻塞请求。
  - 两个参数都**每次请求**通过同步 `settings.get('falling-ts-force-compact')` 读取，因此 `settings.yaml` 的改动在下一次请求即生效。
- **`/force-compact` 斜杠命令（`commands` 服务，可选依赖）：** 通过 `/` 选择执行，其 handler **不发送模型请求**，因此可对**繁忙**的 Agent 生效（`src/command.js`）。handler 逻辑：
  - **空闲**时直接调用 `ctx.compaction.compactNow(agent, invocation.signal)` 强制压缩。
  - **繁忙**时（`compactNow` 因并发/忙碌抛出）调用 `queueForceCompact(session.id)` **插入一个 JS 内存标记**（process-local `Map`，无持久态、无 timer），返回 "将在下一个模型步骤强制压缩"。
  - 该标记由 `agent/pre-step` 钩子（`takeForceCompact`）在**下一个模型步骤**读取并**立即消费**：读到强制标记则**跳过 token 阈值门禁**、立即 `compactNow`，并返回 `{ kind: 'reject' }` **不再请求模型**——即"再请求钩子中如果读取到强制命令, 立马执行压缩, 不再请求模型"。
- **强制压缩配置（`falling-ts-force-compact` 设置命名空间）：** 当 `settings` 服务挂载时，`apply` 注册 `falling-ts-force-compact` 命名空间（`src/settings.js`；`falling-ts-` 前缀防止与其他插件的配置键冲突），两个参数可从 `$DSH_HOME/settings.yaml` 配置：
  - `disableThinking`（`boolean`，默认 `true`）——为 `true` 时**每次模型请求**（以及插件自己的摘要调用）携带 `reasoningEffort: 'off'`（适配器映射为 `thinking: { type: 'disabled' }`），即关闭思考。
  - `autoThresholdTokens`（`number`，默认 `80000`）——强制压缩触发阈值；`agent/pre-step` 仅在会话总上下文 tokens ≥ 该值时强制压缩，低于则跳过。
  - `autoEarliestRatio`（`number` 0.01..1，默认 `0.3`）——**自动压缩最早对话比例**：`agent/pre-step` 阈值门禁触发时，从头压缩会话 surface 历史的该比例（最早 `autoEarliestRatio` 的对话）。
  - `forceEarliestRatio`（`number` 0.01..1，默认 `0.5`）——**强制压缩最早对话比例**：`/force-compact` 命令（空闲直接压缩 / 繁忙由下一个模型步骤消费标记）从头压缩的对话比例。
  - `turnEndForceCompactionEnabled`（`boolean`，默认 `true`）——**是否开启一轮结束强制压缩**：为 `true` 时，`turn/end` 后强制执行一轮结束压缩。
  - `turnEndCompactionRatio`（`number` 0.01..1，默认 `0.4`）——**一轮结束强制压缩比例**：一轮结束强制压缩从头压缩的对话比例。
  - 命名空间注册在 `ctx.effect` 中完成（`apply` 启动时一次性异步执行）；`registerNamespace` 在 `settings` 缺失时是 no-op，绝不阻塞 `agent/*` / `session/flush` 监听器的注册。
- **一轮结束强制压缩（`session/event` 上的 `turn/end` 监听器，`src/turn-end.js`）：** 监听 `session/event`；当事件为 `turn/end` 且 `turnEndForceCompactionEnabled` 为 `true` 时，从头压缩最早 `turnEndCompactionRatio` 的对话（`compactRegion`）。`session/event` 监听器不携带 turn signal，故每次 `turn/end` 新建一个 `AbortController`。压缩失败（已活跃 / 无安全区间）仅记录日志，绝不阻塞 turn。
- 监听器是异步且被依赖的：`session/flush` 是被等待（awaited）的 `parallel` 检查点，因此压缩必须在监听器返回前完成。不要把它拆成 fire-and-forget，除非显式说明持久性保证。
- 每次 flush 新建一个 `AbortController`（被等待的检查点覆盖其生命周期）；把它的 `signal` 传给摘要器与 `compactRegion`。
- 压缩实现位于 `src/`：
  - `src/config.js` —— 可调参数（固定常量，非 cordis `Config` 字段）。
  - `src/region.js` —— 插件自己的 head-anchored 区间选择：`selectRegion`（按 surface 节点数保留最近尾段，检查点路径用）与 `selectEarliestRatio`（从头取最早 `ratio` 的 surface 节点，`user/message` 边界对齐，供 `agent/pre-step` / `turn/end` / `/force-compact` 使用）。
  - `src/summarizer.js` —— 插件自己的一次性 LLM 摘要器（回放区间，追加压缩指令，通过 `ctx.llm` 流式生成）。
  - `src/compact.js` —— 检查点编排器：选区间 → 投影区间消息 → 运行预览 + 收缩门禁 → 把持久变更委托给 `ctx.compaction.compactRegion(start, end, agent, signal)`。
  - `src/request-guard.js` —— 每次请求的门禁：`agent/request` 关闭思考（`reasoningEffort: 'off'`）+ `agent/pre-step` 阈值门禁（`autoEarliestRatio` 从头压缩）+ `/force-compact` 的 process-local 强制标记（`queueForceCompact` / `takeForceCompact`）。
  - `src/command.js` —— `/force-compact` 斜杠命令（`commands` 服务，可选依赖）：空闲直接压缩最早 `forceEarliestRatio`，繁忙时插入 JS 内存标记。
  - `src/turn-end.js` —— 一轮结束强制压缩：`session/event` 上的 `turn/end` 监听器，从头压缩最早 `turnEndCompactionRatio`。
  - `src/index.js` —— Cordis 函数插件入口（`name` / `inject` / `apply`），注册 `agent/request` / `agent/pre-step` / `session/event` / `session/flush` 四个监听器、设置命名空间与 `/force-compact` 命令。
- 插件自己的摘要器是**预提交预览 + 收缩门禁**：它在提交前验证压缩是否值得。持久摘要内容由 `compaction` 服务权威生成（`compactRegion` 重新摘要并提交）。不要在持久路径上重复摘要。
- Monorepo 集成会把它包进 `src/index.ts`，并新增一个真实组合（REAL-composition）测试：启动仅测试用的 `cordis.yml` 并断言持久的摘要节点；本独立产物是 plain JS，无构建步骤。

## 会话数据模型——本插件往什么里追加

会话是 `SessionEvent` 的**事件溯源、仅追加日志**，是唯一事实来源。LLM 历史从不存储；它**派生**自该日志（`deriveMessages()`）。没有独立的"conversation"对象——轮次、步骤、消息、工具调用、压缩、todo、钩子都是同一日志里的行。（完整词汇与 payload 声明：上游 `docs/persistence-catalog` + `docs/subsystems/persistence`；本仓 `docs/context-management-analysis.md` 有浓缩分析。）

**事件信封**（每行）：`{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。
`seq` 在会话内单调连续（首事件 `seq=0`）。`ignorable` 缺省 = 必需：读到未知*必需*类型的读者必须拒绝重建，而不是静默丢弃。`sourceEventSeqs` / `surfaceOp` **只存在于 surface 事件**。

**Surface 与 log-only。** 只有三种 `type` 是 *surface*——`user/message`、`assistant/message`、`tool/result`——它们是唯一产生 LLM 消息、进入 `deriveMessages()` 的类型，也是唯一允许携带 `surfaceOp` / `sourceEventSeqs` 的类型。其余 `type` 都是 *log-only*：持久且可回放，但从不进入派生历史（`turn/*`、`step/*`、`tool/call`、`compaction/*`、`todo/write`、`hook/*`、`approval/*`，……）。

**落盘。** 每个事件一行 JSONL，默认包裹在拼接的带校验和 zstd 帧中（每个追加批次一帧）；SQLite 后端改存打包的 chunk 行。`SESSION_FORMAT_VERSION = 0`——预发布，无迁移；后端拒绝任何其它版本。崩溃恢复从不截断：未闭合的 `turn/start` 以合成 `turn/end { reason: { kind: 'interrupted' } }` 闭合。

**dsh-force-compact 追加的内容**（其全部持久效果，经由 `compaction` 服务）：一个 log-only 的 `compaction/*` 节点（如 `compaction/summary`，含 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`），它不带 `surfaceOp`，因此自身从不进入模型历史；随后同步追加一个 **surface `user/message`**，携带 `surfaceOp: { op: 'replace', start, end }` 遮蔽被压缩区间——该 `replace` 才是真正的 surface 替换。推理/"思考"是**内容块类型**（`ContentBlock.type === 'reasoning'`），不是事件类型：它存在于 `assistant/message.content` 内（由 `reasoning-delta` 流块 / `reasoning-chunks` 行组装），UI 通过 `toAssistantBlock()` 把它渲染为可折叠区域。

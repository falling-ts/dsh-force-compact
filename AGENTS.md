# AGENTS.md — dsh-force-compact

本规则适用于 `dsh-force-compact/`，并补充[集合约定](../AGENTS.md)。

- 插件唯一的持久效果是 `compaction` 服务追加到会话日志的摘要节点；插件不引入其他状态。不要引入 timer、内存态存储或 client UI——保持它是 `session/flush` 上的纯 Host 监听器。
- `compaction` 是硬依赖（`inject` + `ctx.compaction`）。`agents` 是可选依赖（`ctx.get('agents')`，对 `undefined` 做守卫）；缺少 Agent 是记录日志后跳过，而非错误。
- 监听器是异步且被依赖的：`session/flush` 是被等待（awaited）的 `parallel` 检查点，因此压缩必须在监听器返回前完成。不要把它拆成 fire-and-forget，除非显式说明持久性保证。
- 每次 flush 新建一个 `AbortController`（被等待的检查点覆盖其生命周期）；把它的 `signal` 传给摘要器与 `compactRegion`。
- 压缩实现位于 `src/`：
  - `src/config.js` —— 可调参数（固定常量，非 cordis `Config` 字段）。
  - `src/region.js` —— 插件自己的 head-anchored 区间选择（按 surface 节点数保留最近尾段；把区间末端对齐到 `user/message` 边界，使委托的 `compactRegion` 不会因未配对的工具调用而拒绝）。
  - `src/summarizer.js` —— 插件自己的一次性 LLM 摘要器（回放区间，追加压缩指令，通过 `ctx.llm` 流式生成）。
  - `src/compact.js` —— 编排器：选区间 → 投影区间消息 → 运行预览 + 收缩门禁 → 把持久变更委托给 `ctx.compaction.compactRegion(start, end, agent, signal)`。
  - `src/index.js` —— Cordis 函数插件入口（`name` / `inject` / `apply`）。
- 插件自己的摘要器是**预提交预览 + 收缩门禁**：它在提交前验证压缩是否值得。持久摘要内容由 `compaction` 服务权威生成（`compactRegion` 重新摘要并提交）。不要在持久路径上重复摘要。
- Monorepo 集成会把它包进 `src/index.ts`，并新增一个真实组合（REAL-composition）测试：启动仅测试用的 `cordis.yml` 并断言持久的摘要节点；本独立产物是 plain JS，无构建步骤。

## 会话数据模型——本插件往什么里追加

会话是 `SessionEvent` 的**事件溯源、仅追加日志**，是唯一事实来源。LLM 历史从不存储；它**派生**自该日志（`deriveMessages()`）。没有独立的"conversation"对象——轮次、步骤、消息、工具调用、压缩、todo、钩子都是同一日志里的行。（完整词汇与 payload 声明：上游 `docs/persistence-catalog` + `docs/subsystems/persistence`；本仓 `docs/context-management-analysis.md` 有浓缩分析。）

**事件信封**（每行）：`{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。
`seq` 在会话内单调连续（首事件 `seq=0`）。`ignorable` 缺省 = 必需：读到未知*必需*类型的读者必须拒绝重建，而不是静默丢弃。`sourceEventSeqs` / `surfaceOp` **只存在于 surface 事件**。

**Surface 与 log-only。** 只有三种 `type` 是 *surface*——`user/message`、`assistant/message`、`tool/result`——它们是唯一产生 LLM 消息、进入 `deriveMessages()` 的类型，也是唯一允许携带 `surfaceOp` / `sourceEventSeqs` 的类型。其余 `type` 都是 *log-only*：持久且可回放，但从不进入派生历史（`turn/*`、`step/*`、`tool/call`、`compaction/*`、`todo/write`、`hook/*`、`approval/*`，……）。

**落盘。** 每个事件一行 JSONL，默认包裹在拼接的带校验和 zstd 帧中（每个追加批次一帧）；SQLite 后端改存打包的 chunk 行。`SESSION_FORMAT_VERSION = 0`——预发布，无迁移；后端拒绝任何其它版本。崩溃恢复从不截断：未闭合的 `turn/start` 以合成 `turn/end { reason: { kind: 'interrupted' } }` 闭合。

**dsh-force-compact 追加的内容**（其全部持久效果，经由 `compaction` 服务）：一个 log-only 的 `compaction/*` 节点（如 `compaction/summary`，含 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`），它不带 `surfaceOp`，因此自身从不进入模型历史；随后同步追加一个 **surface `user/message`**，携带 `surfaceOp: { op: 'replace', start, end }` 遮蔽被压缩区间——该 `replace` 才是真正的 surface 替换。推理/"思考"是**内容块类型**（`ContentBlock.type === 'reasoning'`），不是事件类型：它存在于 `assistant/message.content` 内（由 `reasoning-delta` 流块 / `reasoning-chunks` 行组装），UI 通过 `toAssistantBlock()` 把它渲染为可折叠区域。

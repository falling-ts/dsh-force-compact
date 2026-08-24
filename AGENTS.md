# AGENTS.md — dsh-force-compact

本规则适用于 `dsh-force-compact/`，并补充[集合约定](../AGENTS.md)。

## 预设域限制（§preset-realm-limitation）

现代 harness 组合中，`compaction-basic` 通常**挂在 agent preset 的一个 `isolate` 组里**
（例如 `standard` preset 的 `- id: compaction / name: cordis:group / isolate: {compaction:true,…}`
组），导致服务仅在该组**后代 realm**可见。本插件是 **Host 全局监听器**——`apply` 上下文、
`event-dispatch` 上下文、`agent.ctx` 都不一定是该组的 descendant，于是 `ctx.get('compaction')`
从这些候选上下文中读取为 `undefined`（经 `agent.ctx` 实测确认：`sessions/llm/tokenMeter/
settings/agents` 都能解析，唯独 `compaction` 不能——证明我们持有的 realm **不是**该组的
descendant，而是同级的另一个 scope）。

本插件遵守 AGENTS.md 既有约束"**不声明 `inject`**"（preset 平面晚于插件 boot 挂载，
硬 inject 会触发启动断言失败），所以**无法通过注入获取该服务**。结果是：

- **默认（`compactionMode:'realm'`）**：尝试 `agent.ctx.get('compaction')`，然后
  回落 `ctx.get('compaction')`。在标准 preset 部署下两者都为 `undefined`，
  四条压缩路径全部**优雅降级为 skip + WARN**（包含本段落指引）。
- **`compactionMode:'global'`**：只用 `ctx.get('compaction')`，适合**将 `compaction-basic`
  行移出 preset 的 `isolate` 组**（改为 root-realm 暴露，或独立 bundle 挂载到 host
  plane）后的部署——此时 `ctx.get` 能命中。
- **真正让压缩"跑起来"的方式**（三选一）：
  1. 修改 agent preset 的 `cordis.yml`，把 `compaction-basic`（连同它需要的
     `toolResultPruner` 协作方）放在**本插件可达的 realm** 下（通常是 root-realm，
     即移出 `isolate` 组）。代价：失去组内隔离，`toolResultPruner` 也变全局——需评估
     是否会与同进程内其它 preset 的同名服务冲突。
  2. 用 `dsh-market` 或独立 profile `bundles` 把 `compaction-basic` 挂到 **Host
     plane**（而非 preset plane），使其成为 root-realm 服务；插件 `ctx.get('compaction')`
     即刻可读（等价 `compactionMode:'global'`）。
  3. 放弃 `compaction-basic`，用**另一个能挂到 root-realm 的 compaction 后端**
     实现同样契约（暴露 `compactNow` / `compactRegion`）。

插件代码层面**已做到最优**：realm-first → global-fallback 的两级解析 + 优雅降级 +
诊断级 WARN。问题本质是**上游 preset 的组合拓扑**与本插件"纯 Host 监听器、零 inject"
之间的张力，只能从**组合**一侧解决。

## 如何判断插件是否加载成功

插件加载成功的**客观判据**是它会在日志文件 `~/.dsh/logs/dsh-force-compact.log`
（Windows 展开为 `%USERPROFILE%\.dsh\logs\dsh-force-compact.log`；路径由
`falling-ts-force-compact` 设置的 `logFile` 控制，默认此值，`~` 经用户家目录展开）
中写入一条带 `[force-compact]` 标记的行：

```
[force-compact] debug logging enabled — writing [force-compact] lines to <已解析的绝对路径>
```

这条行由 `src/debug-log.js` 在安装日志 sink（`ctx.logger.exporter(exporter)`）之
后立即写出，代表**插件 `apply` 已执行且 debug 日志通道就绪**。判断方法：

- **重启/刷新目标实例后**，检查该文件末行是否出现上面这行（或在时间戳较新的行中出现）：
  - 出现 → 插件已成功挂载并运行 `apply`（加载成功）；
  - 文件中根本没有 `[force-compact]` 行 → 插件未挂载 / `apply` 未运行（加载失败或未启用）。
- 也可结合 `settings.describe` 反查：命名空间 `falling-ts-force-compact` 出现在返回值里
  ⇒ Host 侧命名空间已注册（`apply` 已走到注册步骤）。两者互为佐证。
- 该日志行**只在 `debug` 设置为真且日志文件可写时才写**（默认均为真）。若因 `debug:false`
  而看不到此标记，属正常（表示功能仍在工作、只是未开日志），此时以上面的
  `settings.describe` 命名空间作为加载判据。

> 排障经验：`ctx.logger` 的输出不一定落在 `harness-server[-dev]*.sh` 捕获的
> stdout/stderr 日志里；要看插件自身是否运行，直接看上面的 `~/.dsh/logs/
> dsh-force-compact.log` 最可靠。另注意 `dsh web` CLI **没有 `--patch` 选项**——插件经
> profile `package.json` 的 `dsh.profile.bundles` 列表 + `package.json` 的
> `dsh.bundle.patch` 声明自动挂载，不能用 CLI 叠加 patch。

## 概览

- 插件唯一的持久效果是 `compaction` 服务追加到会话日志的摘要节点；插件不引入其他状态。不要引入 timer 或内存态存储；Host 半部保持它是**核心模型请求缝**（`agent/request` / `agent/pre-step`）与 `session/flush` 上的纯 Host 监听器。**另有一个 web client 半部**（`src/client.js`，`package.json` 的 `exports["./client"]` + `dsh.client.platform: web`，经 client module 系统自动组成，无需改 web-app 组合）：仅注册一个 `settings.section`（设置页左侧菜单"强制压缩 / Force Compact"分区，order 30），经 `settingsScope.bind({ namespace: 'falling-ts-force-compact' })` 镜像成 uSES 安全的 `SnapshotStore` 并读写字段（`scope.set`/`scope.unset` 写回 `settings.yaml`），**不**引入 timer、内存态存储或额外订阅；client 半部 `inject: ['slots','locale','settingsScope']`（这三个 client 服务在 client 启动时即可用，与 Host 侧的 `compaction` 运行时依赖不同）。
- `compaction` 是**运行时依赖**，由 preset 平面（`include:agent-presets:compaction-basic`，默认启用并挂载）提供，**不是**启动时硬依赖：插件**不**声明 `inject`——profile 层条目在进程启动时激活，彼时 preset 平面尚未挂载该服务，硬 `inject` 会导致 `assertEntriesActivated` 启动断言失败；各压缩路径在事件时经 `ctx.get('compaction')`（读全局服务存储）实时读取，对 `undefined` 做守卫——服务不可用时该路径记日志后跳过，绝不阻塞请求。`agents`、`settings`、`tokenMeter`、`commands` 都是可选依赖（`ctx.get(...)`，对 `undefined` 做守卫）：`agents` 仅供 `session/flush` 路径（缺少 Agent 是记录日志后跳过）；缺少 `settings` 时两个参数回退到默认值；缺少 `tokenMeter` 时阈值门禁回退到粗略字符估算；缺少 `commands` 时 `/force-compact` 命令不注册（`src/command.js` 是 no-op）。
- **钩住核心模型请求（`agent/request` / `agent/pre-step`）：** 插件的核心行为是钩住官方模型请求缝，**每次请求模型前**读取设置：
  - **`agent/request`**（围绕冻结调用配置的 Waterfall）——`disableThinking` 为 `true` 时，返回的 `LlmCallConfig` 携带 `reasoningEffort: 'off'`（适配器映射为 `thinking: { type: 'disabled' }`），即**每次模型请求**都关闭思考。监听器 `await next()` 取得机器本会使用的配置，再返回替换值；**不得**在缺少 `next()` 时短路（必须调用 `next()`）。
  - **`agent/pre-step`**（每个模型步骤前的 Waterfall）——通过 `tokenMeter.measure(session).totalTokens` 读取会话上下文总 tokens；当其**≥ `autoThresholdTokens`** 时，返回 `{ kind: 'reject' }` **不发起模型请求**，并从头压缩最早 `autoEarliestRatio` 的对话（`compactRegion`）；低于阈值时调用 `next()` 让请求继续。强制压缩失败（无安全区间 / 已活跃）时降级为 `next()`，绝不阻塞请求。
  - 两个参数都**每次请求**通过同步 `settings.get('falling-ts-force-compact')` 读取，因此 `settings.yaml` 的改动在下一次请求即生效。
- **`/force-compact` 斜杠命令（`commands` 服务，可选依赖）：** 通过 `/` 选择执行，其 handler **不发送模型请求**。Agent **空闲**时经 `compactNow`（owner `null`，空闲手动入口）立即压缩（引擎自身区间选择）；**繁忙**时 `compactNow` 被拒绝，handler 排队一个强制标记（`src/command.js`）。handler 逻辑：
  - 直接调用 compaction 服务的 `compactNow(agent, invocation.signal)`（事件时经 `ctx.get('compaction')` 实时读取；owner `null`，空闲手动入口）压缩会话——空闲时立即生效，使用引擎自身的区间选择。
  - 若 `compactNow` 抛出（Agent 繁忙 / 无安全区间），调用 `queueForceCompact(session.id)` **插入一个 JS 内存标记**（process-local `Map`，无持久态、无 timer），返回 "将在下一个模型步骤强制压缩"。
  - 该标记由 `agent/pre-step` 钩子（`takeForceCompact`）在**下一个模型步骤**读取并**立即消费**：读到强制标记则**跳过 token 阈值门禁**、压缩最早 `forceEarliestRatio`（`compactRegion`），并返回 `{ kind: 'reject' }` **不再请求模型**——即"再请求钩子中如果读取到强制命令, 立马执行压缩, 不再请求模型"。
- **强制压缩配置（`falling-ts-force-compact` 设置命名空间）：** 当 `settings` 服务挂载时，`apply` 注册 `falling-ts-force-compact` 命名空间（`src/settings.js`；`falling-ts-` 前缀防止与其他插件的配置键冲突），两个参数可从 `$DSH_HOME/settings.yaml` 配置：
  - `disableThinking`（`boolean`，默认 `true`）——为 `true` 时**每次模型请求**（以及插件自己的摘要调用）携带 `reasoningEffort: 'off'`（适配器映射为 `thinking: { type: 'disabled' }`），即关闭思考。
  - `autoThresholdTokens`（`number`，默认 `131000`）——强制压缩触发阈值；`agent/pre-step` 仅在会话总上下文 tokens ≥ 该值时强制压缩，低于则跳过。
  - `autoEarliestRatio`（`number` 0.01..1，默认 `0.3`）——**自动压缩最早对话比例**：`agent/pre-step` 阈值门禁触发时，按 `tokenMeter` 测量的会话总 tokens 的该比例，从头累计 tokens 至预算后截断（末端对齐 `user/message` 边界），压缩该区间。
  - `forceEarliestRatio`（`number` 0.01..1，默认 `0.5`）——**强制压缩最早对话比例**：`/force-compact` 命令在 Agent **繁忙**时排队强制标记，由 `agent/pre-step` 钩子（`compactRegion`）在下一个模型步骤按总 tokens 的该比例从头截断压缩（命令本身在空闲时经 `compactNow` 用引擎自身区间选择压缩，不使用该比例）。
  - `turnEndForceCompactionEnabled`（`boolean`，默认 `true`）——**是否开启一轮结束强制压缩**：为 `true` 时，agent 转入 `idle`（所有轮次结束，含子代理，下一次人为对话之前）时经 `compactNow`（引擎自身区间选择）强制执行一轮结束压缩。
  - 命名空间注册在 `ctx.effect` 中完成（`apply` 启动时一次性异步执行）；`registerNamespace` 在 `settings` 缺失时是 no-op，绝不阻塞 `agent/*` / `session/flush` 监听器的注册。
- **一轮结束强制压缩（`agent/status` 上的 `idle` 监听器，`src/turn-end.js`）：** 监听 `agent/status`；当 agent 转入 `idle`（无 driver 活动——所有轮次结束，含子代理，下一次人为对话之前）且 `turnEndForceCompactionEnabled` 为 `true` 时，经 `compactNow`（owner `null`，空闲手动入口）压缩会话——使用引擎自身的区间选择（空闲路径无法选择自定义 token 比例，故无一轮结束比例参数）。`agent/status` 监听器不携带 turn signal，故每次 `idle` 新建一个 `AbortController`。压缩失败（已活跃 / 无安全区间）仅记录日志，绝不阻塞。
- 监听器是异步且被依赖的：`session/flush` 是被等待（awaited）的 `parallel` 检查点，因此压缩必须在监听器返回前完成。不要把它拆成 fire-and-forget，除非显式说明持久性保证。
- 每次 flush 新建一个 `AbortController`（被等待的检查点覆盖其生命周期）；把它的 `signal` 传给摘要器与 `compactRegion`。
- 压缩实现位于 `src/`：
  - `src/config.js` —— 可调参数（固定常量，非 cordis `Config` 字段）。
  - `src/region.js` —— 插件自己的 head-anchored 区间选择：`selectRegion`（按 surface 节点数保留最近尾段，检查点路径用）与 `selectEarliestByTokens`（按 `tokenMeter` 测量的总 tokens 的 `ratio` 比例从头累计至预算后截断，末端对齐 `user/message` 边界，供 `agent/pre-step` 使用；`idle` / `/force-compact` 路径改用 `compactNow` 的引擎自身区间选择）。
  - `src/summarizer.js` —— 插件自己的一次性 LLM 摘要器（回放区间，追加压缩指令，通过 `ctx.llm` 流式生成）。
  - `src/compact.js` —— 检查点编排器：选区间 → 投影区间消息 → 运行预览 + 收缩门禁 → 把持久变更委托给 compaction 服务的 `compactRegion(start, end, agent, signal)`（经 `ctx.get('compaction')` 实时读取；不可用时跳过检查点）。
  - `src/request-guard.js` —— 每次请求的门禁：`agent/request` 关闭思考（`reasoningEffort: 'off'`）+ `agent/pre-step` 阈值门禁（`autoEarliestRatio` 从头压缩）+ `/force-compact` 的 process-local 强制标记（`queueForceCompact` / `takeForceCompact`）。
  - `src/command.js` —— `/force-compact` 斜杠命令（`commands` 服务，可选依赖）：空闲时经 `compactNow` 压缩；繁忙时插入 JS 内存标记。
  - `src/turn-end.js` —— 一轮结束强制压缩：`agent/status` 上的 `idle` 监听器，经 `compactNow`（引擎自身区间选择）压缩。
  - `src/index.js` —— Cordis 函数插件入口（`name` / `apply`，不声明 `inject`），注册 `agent/request` / `agent/pre-step` / `agent/status` / `session/flush` 四个监听器、设置命名空间与 `/force-compact` 命令。
- 插件自己的摘要器是**预提交预览 + 收缩门禁**：它在提交前验证压缩是否值得。持久摘要内容由 `compaction` 服务权威生成（`compactRegion` 重新摘要并提交）。不要在持久路径上重复摘要。
- Monorepo 集成会把它包进 `src/index.ts`，并新增一个真实组合（REAL-composition）测试：启动仅测试用的 `cordis.yml` 并断言持久的摘要节点；本独立产物是 plain JS，无构建步骤。

## 会话数据模型——本插件往什么里追加

会话是 `SessionEvent` 的**事件溯源、仅追加日志**，是唯一事实来源。LLM 历史从不存储；它**派生**自该日志（`deriveMessages()`）。没有独立的"conversation"对象——轮次、步骤、消息、工具调用、压缩、todo、钩子都是同一日志里的行。（完整词汇与 payload 声明：上游 `docs/persistence-catalog` + `docs/subsystems/persistence`；本仓 `docs/context-management-analysis.md` 有浓缩分析。）

**事件信封**（每行）：`{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。
`seq` 在会话内单调连续（首事件 `seq=0`）。`ignorable` 缺省 = 必需：读到未知*必需*类型的读者必须拒绝重建，而不是静默丢弃。`sourceEventSeqs` / `surfaceOp` **只存在于 surface 事件**。

**Surface 与 log-only。** 只有三种 `type` 是 *surface*——`user/message`、`assistant/message`、`tool/result`——它们是唯一产生 LLM 消息、进入 `deriveMessages()` 的类型，也是唯一允许携带 `surfaceOp` / `sourceEventSeqs` 的类型。其余 `type` 都是 *log-only*：持久且可回放，但从不进入派生历史（`turn/*`、`step/*`、`tool/call`、`compaction/*`、`todo/write`、`hook/*`、`approval/*`，……）。

**落盘。** 每个事件一行 JSONL，默认包裹在拼接的带校验和 zstd 帧中（每个追加批次一帧）；SQLite 后端改存打包的 chunk 行。`SESSION_FORMAT_VERSION = 0`——预发布，无迁移；后端拒绝任何其它版本。崩溃恢复从不截断：未闭合的 `turn/start` 以合成 `turn/end { reason: { kind: 'interrupted' } }` 闭合。

**dsh-force-compact 追加的内容**（其全部持久效果，经由 `compaction` 服务）：一个 log-only 的 `compaction/*` 节点（如 `compaction/summary`，含 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`），它不带 `surfaceOp`，因此自身从不进入模型历史；随后同步追加一个 **surface `user/message`**，携带 `surfaceOp: { op: 'replace', start, end }` 遮蔽被压缩区间——该 `replace` 才是真正的 surface 替换。推理/"思考"是**内容块类型**（`ContentBlock.type === 'reasoning'`），不是事件类型：它存在于 `assistant/message.content` 内（由 `reasoning-delta` 流块 / `reasoning-chunks` 行组装），UI 通过 `toAssistantBlock()` 把它渲染为可折叠区域。

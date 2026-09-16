# AGENTS.md — dsh-force-compact

本规则适用于 `dsh-force-compact/`，并补充[集合约定](../AGENTS.md)。

## 例外：`publishDone` 的单用途定时器（有意偏离集合约定"不引入 timer"）

集合约定要求插件"纯 Host 监听器：不引入 timer"。本插件在
`src/core/ui-signal.js` 的 `publishDone` 中存在**一处有意的单用途定时器**
（`DONE_FALLBACK_MS = 3000` ms）：发布绿色 `[压缩完成!]` DONE 横幅后，3 秒后
以 `isImportant=true` 强制重绘一对随机 Deep working 文本，把 UI 还原到常规
工作中外观。该定时器是纯表现层（fire-and-forget `setTimeout`，无内存态、
无持久化、不影响任何压缩事务或模型请求），为用户明确要求的 UI 行为，
**不属于**"引入 timer"所指的计时型副作用（如周期调度 / 延时重试），故予以
豁免。除此一处之外，本插件仍不引入任何 timer；`queueForceCompact` 的
process-local `Map` 标记也无 timer。

## 例外：摘要流的硬超时守卫（`AbortSignal.timeout`，2026-08-30 增补）

`src/engine/summarizer.js` 的 `SUMMARIZATION_TIMEOUT_MS = 90_000`（默认值）是一次
**单发超时守卫**：用 `AbortSignal.timeout` + `Promise.race` 把一次摘要
`llm.stream` 收集钉死在硬时限内。这不是周期调度、不是延时重试，而是一次
事务的**防泄漏护栏**——没有它，一个静默挂起的 provider 流会让
`await summarize(...)` 永挂、`compaction/start` 锁永不闭合，后续所有压缩
（idle 自动 + `/force-compact`）都被 `assertNoActiveCompaction` 拒绝直到进程
重启（2026-08-30 在 opencode-go/deepseek-v4-flash 上实测复现）。守卫的性质
与 `publishDone` 定时器同类（fire-and-forget、无内存态、无持久化），归入
同一豁免；除这两处外仍不引入 timer。

**超时值可配置（2026-09）**：实际生效的时限优先取 `settings.summarizationTimeoutMs`
（GUI 设置项「摘要超时上限（ms）」，默认 `90000`，下限 `5000`，上限
`2147483647`），`SUMMARIZATION_TIMEOUT_MS` 常量降级为调用方未提供该字段时的
回退默认。读取时低于下限的值自动抬升至 5000——过小的上限会让慢速本地端点
（如 llama.cpp，摘要常需 ~40s）被误判挂起而频繁失败，故不设下限之下再放行。

**上限为何是硬的（2026-09-17 修正）**：`summarizationTimeoutMs` 是**被调度**的值
（喂给 `AbortSignal.timeout`），不是只参与比较的阈值，所以不能像 token 刻度那样
放任超界。上限取 `2147483647`（Node 最大可调度定时器延迟，即
`@deepseek-ai/dsh-util-timeout` 的 `MAX_TIMER_DELAY_MS`；两个适配器的
`streamIdleTimeoutMs` schema 也用同一上限）：小数会直接抛 `ERR_OUT_OF_RANGE` 中断
摘要；而 `2^31..2^32-1` 区间虽不抛错，却被 Node 静默降为 **1ms**——表现为每次摘要
瞬间超时、而记录的 reason 仍声称走满了配置的时长（实测
`exploration/abortsignal-timeout-boundary-probe.mjs`：`4294967295`/`4294967294`/
`2147483648` 均在 250ms 内 abort，`2147483647` 不 abort）。修法：`settings.js`
读取时双向钳制并取整（`asTimeoutMs`），`summarizer.js` 在唯一调度点再次钳制
（`summarize` 接受任意调用方的 `config`，不能依赖上游已归一化）。

**适配器竞态的时限诊断（2026-09 增补）：** plugin 的 `summarizationTimeoutMs` 必须
**严格小于**目标适配器自带的 stream-idle 看门狗（`streamIdleTimeoutMs`，默认
`300000`ms，pi-ai / deepseek adapter 各自武装、逐 `next()` 计龄）——否则适配器的
空闲超时先到，挂起/超时的 provider 以 provider 侧 `TIMEOUT` error 呈现在
CRASH-HARNESS，而非本插件干净的 `'timeout'` abort（2026-09-14 在 135 消息慢速
llama.cpp 上实测）。`summarizer.js` 的 `emitTimeoutRaceDiagnostic` 在每次摘要调用
放行前做**只读、best-effort、total** 竞态诊断：best-effort 读**两个适配器各自的
配置位置**——`settings.get('llm-pi-ai').providers.<provider>.streamIdleTimeoutMs`
（逐路由）与 `settings.get('llm-deepseek').streamIdleTimeoutMs`（顶层字段；该插件
只有单一 provider 家族故无路由键。2026-09-17 补上：此前只读前者，令 `llm-deepseek`
路由误落到默认 300000 并指向未被使用的命名空间）——取其中**最紧**的一个作为判界
（哪个适配器服务该路由无法在此判定，而最紧的看门狗才是决定竞态的那个）；两者都
读不到时假定平台默认 300000 并标注"未从配置确认"。当 `summarizationTimeoutMs >=
该界` 时发 WARN 携修复指引（把看门狗抬到高于 `summarizationTimeoutMs`：pi-ai 路由
改 `llm-pi-ai.providers.<provider>.streamIdleTimeoutMs`，DeepSeek 路由改
`llm-deepseek.streamIdleTimeoutMs`；或调低后者，保持 `summarizationTimeoutMs <
streamIdleTimeoutMs`）。它不写任何配置、绝不抛出，只增加一条诊断日志。用户要"以
`summarizationTimeoutMs` 为准"的做法：在 settings.yaml 把适配器看门狗抬高到该值
之上（如 `llm-pi-ai.providers.llama.streamIdleTimeoutMs: 600000` 配
`summarizationTimeoutMs: 500000`），使本插件的墙钟上限成为唯一生效的超时（超时以
`'timeout'` 干净态在插件侧闭合）。

## 双引擎架构（内置引擎 + 官方服务并列共存）

本插件拥有**两条独立的压缩路径**，通过统一的 `resolveCompaction(ctx, agent, mode)` facade
对外呈现，对调用者透明。facade 始终返回**统一形状**的后端对象
（`{ compactNow, compactRegion, kind: 'official' | 'builtin' }` 或 `undefined`），
所有下游调用点（`engine/checkpoint.js`、`hooks/idle.js`、`hooks/command.js`、`hooks/guard.js`）
只关心这个形状，不需要知道是哪一路产出的结果。

### 优先级：官方优先，内置后备

```
resolveCompaction
├── 1. findOfficialService(ctx, agent, mode)
│     ├── compactionMode='realm' (默认): agent.ctx → ctx.get('compaction')
│     └── compactionMode='global':       仅 ctx.get('compaction')
└── 2. builtinBackend(ctx, agent)        ← 内置引擎
      门槛: builtinEnabled !== false (默认 true)
            + agent.session 存在
            + ctx.get('llm').stream 是函数
```

官方服务可达 → 使用官方；不可达 → 自动落到内置引擎。**用户无需手动切换**。

## 官方行为全量移植（2026-08 升级：内置引擎与官方 `compaction-basic` 逐项对齐）

内置引擎现已移植官方实现的**全部核心环节**（逐一对照
`deepseek-harness/packages/compaction/{compaction,compaction-basic}/src`），不再是
"结构模仿"而是同数学定义、同 fail-loud 语义：

| 官方来源 | 移植到 | 说明 |
|----------|--------|------|
| `compaction/src/tool-pairing.ts`（增量配对账本：`assistant/message` +tool-call 块数、`tool/result` −1、其余 0；切点平衡 ⇔ 运行计数为 0；`WeakMap` 按 session 缓存、按 `replaceGeneration` 换代重折；损坏面 loud-fail） | `src/core/pairing.js`（逐字 JS 移植 + 插件侧 SAFE 变体） | **精确工具配对账本**取代旧的"最近 `user/message`"启发式——任意配对闭合处都可下刀（step 末节点、收尾 tool result 之后……），保留端 overshoot 比"必须退到下一条人类消息"小得多 |
| 官方选区第二阶段的向头部吸附判据 | `region.js` 四个选择器 | 吸附循环改查账本（`toolPairingBalancedBefore/AfterSafe`）而非 `user/message` 集合；`selectRetainingLatestTokens` 额外产出 `boundaryKind`（`pairing` / `user-message` / `crossing-fallback`）供 REGION-PICK 诊断行观察吸附落在哪种切点 |
| `compaction-basic/src/region.ts` `validateSurfaceRegion`（界外拒绝 + 索引倒置拒绝 + **双侧平衡校验**） | `region.js` 导出 `validateSurfaceRegion`（throwing，官方语义）+ `validateSurfaceRegionSafe`（hot-path 安全壳，异常归一化为 `null`） | 提交前双重把关：不平衡候选在此被拒绝并记日志（fail-loud），不再带着可能劈裂 tool 对的边界往下走；会话核自身的 replace 校验仍是最后一道网 |
| `compaction-basic/src/region.ts` `prepareCompaction` 的 surface 一致性交叉校验（meter 快照必须与 `session.surface.nodes` 逐位相等） | `hooks/guard.js` 选区之后、花钱之前 | 并发修改导致快照过期时整体拒绝本次尝试（下一步新鲜快照重试），绝不摘要错误的字节 |
| `compaction-basic/src/region.ts` `inspectCompactionEntryState` + `assertCompactionInactive`（反向一次扫描同时收集 openTurn / 未配对 `compaction/start` / 最新 `session/end-seed`；**晚于孤儿 start 的 end-seed ⇒ 视为 constructor 继承残留，忽略**） | `builtin.js` `inspectCompactionEntryState` / `assertNoActiveCompaction`（原 `hasOpenFctLock` 由此重构而来） | busy 锁定语义与官方完全一致：真·在途事务拒入；跨生命周期继承的孤儿标记不再永久楔死后续压缩 |
| `compaction-basic/src/summarizer.ts` `COMPACTION_INSTRUCTION` + `CHECKPOINT_PREAMBLE` + `<compacted-summary>` framing | `src/engine/summarizer.js`（逐字对齐，含七节结构与 Rules 段） | 指令文案与官方单源实现逐字一致——摘要输出结构、"(none)" 占位规则、prior-checkpoint 合并规则、"不得提及本次压缩"禁令全部相同 |
| `compaction-basic` 摘要调用的 `system` + `tools` 前缀缓存对齐 | `builtin.js` 摘要输入（**已恢复 `tools` 传入**，撤销此前的二分法临时关闭） | 辅助调用成为上次路由请求的真前缀，复用热 KV 缓存；此前怀疑 `tools` 引发 provider `reading 'kind'` 崩溃，后经活体验证证实该崩溃源于 vendor 侧重放路径（与 `options.tools` 无关），故恢复全量对齐 |

**未移植项及原因**（有意识的差异，非遗漏）：
- 官方 `whole-surface` / `span-stable` **异步摘要期稳定性复检**（`assertWholeSurfaceUnchanged` /
  `assertSelectedSpanStable`，应对摘要进行中新事件插入）——我们内置事务的摘要调用虽仍经
  `await ctx.llm.stream` 让出微任务，但提交前的 `validateReplacementBounds` 已按"当前
  surface 节点是否仍命中同一界点"复检；若未来引入真·多 yield 长摘要（如分段摘要），应补
  装官方的两种 stability 检查。
- `compaction-tool-result-pruner`（独立的 tool result 修剪通路）——与本插件职责正交
  （它是"原地剪枝超限 tool result"，不是"区域替换"），不移植。

REGION-PICK 诊断行新增 `boundaryKind=` 字段；加载标记升级为
`v2026-08-25-p0-p1-port`（dev-server stdout 可见）。

### Shadow-price 协议对齐（2026-08 升级：内置事务的 `shadowedTokenCount` 与官方计价同源）

**背景**——harness 的 token-meter 折叠器（`packages/llm/token-meter/src/surface-projection.ts`）
对"压缩"的处理**不是**扫描压缩标记，而是一个**影子价格索赔（shadow-price claim）协议**：
`compaction/summary` / `compaction/prune` 事件本身 delta 恒 0，只把 `shadowedTokenCount`
武装成一张待核销的索赔（claim，携带 `shadowedRange` 起止 + tokens）；紧随其后的 surface
`replace`（`user/message` + `surfaceOp:{op:'replace',startSeq,endSeq}`）用
`delta = 检查点估价 − claim.tokens` 完成真正的扣减。**范围不匹配的 replace 会 THROW**；
无索赔的 replace 按中性 0 delta 折入。生产者因此必须做到两点：
① summary 与 replace **同步相邻**追加（中间不得插入任何其他事件，否则索赔作废）；
② `shadowedTokenCount` 必须等于**被替换 surface 区间的启发价总和**——官方
`compaction-basic/src/region.ts` `prepareCompaction` 算的是
`selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0)`。
**关键：是 `heuristicTokens`（路由无关的固定启发价），不是 `tokens`（路由价）**，
两者是不同的字段：折叠器 `planSurfaceTokens` 结算 replace 时用的是
`deltaTokens = heuristicTokens(检查点) − Σ heuristicTokens(被替换节点)`，而路由价只进
`compaction/summary` 的另一个字段 `shadowedRouteTokenCount`
（`packages/llm/token-meter/src/types.ts` 原文："The shadow-price protocol prices
replacements with this value"）。逐节点启发价 = `estimateMessage(deriveEventMessage(event))`。

**历史缺陷**——本插件此前的账单口径是"喂给摘要 LLM 的角色化扁平文本按 chars/4"
（`estimateTokens(projectRegion(...).messages)`）：既不含 tool-result 原始输出、也不含
schema/推理块的结构开销，系统性低估真实 surface 成本 → 折叠器结算时
`delta = 检查点估价 − 虚低账单` 偏正甚至转正 → **压缩完成后右下角 `对话消息`
（surfaceTokens）反而上涨**，表现为"压缩后计数器不减反增"。

**修复（本 2026-08 版）**——`src/engine/builtin.js` 顶部新增与官方
`packages/llm/token-meter/src/estimate.ts` **逐字同形的纯 JS 移植块**（CHAR/BLOCK/ROLE
开销常量 + `estimateContent` 递归 + `estimateHeader` 两部分 + `priceSurfaceNode`
按官方 `analyzeNode` 的逐节点规则 + `priceRegionFromMeasurement` 按官方
`prepareCompaction` 的 reduce 语义），`runTransaction` 的账单计算改为：
优先从同一份 `tokenMeter.measure` 快照的 `nodes[]` 累加覆盖区间的 **`heuristicTokens`**
（与选区截点同源，`compactNow` 路径传入、其余入口按需现场采样）；
快照缺失/不全时退化到对 `session.events` 直接逐位估价（`priceSurfaceNode`）；
两条路都无法覆盖 → **fail-loud 拒提交**（宁可放弃本次事务，也不写一条会让持久
投影漂移到错误方向的坏索赔）。`compactNow` 路径的选区、阈值门禁、账单三处
共享**同一份测量快照**（一次 `meter.measure`），杜绝"阈值用一个口径、选区用
另一个口径、账单再用第三个口径"的错位。缩容门禁（`summaryTextLen < 账单 ×
CHARS_PER_TOKEN` 或 meter 估价版）保留不变，确保合规事务净 delta 必为负、
计数严格下降。

**口径纠偏（2026-09-17，与 harness 0.1.6-alpha.1 同步时发现）**——上面那套移植当时
漏了两件事，探针 `exploration/fc-shadow-price-parity-probe.mjs`（与官方
`planSurfaceTokens` / `estimateMessage` **逐例对拍**）现已锁死：

1. **账单取错字段**：`priceRegionFromMeasurement` 累加的是 `node.tokens`（路由价），
   而索赔必须用 `node.heuristicTokens`。凡路由价高于固定启发价的会话（图片、文件——
   它们的请求价归路由所有）都会**少报账单** → `delta` 偏正 → 计数器少扣，正是"压缩后
   不降反升"那一族症状。现取 `heuristicTokens`，仅在该字段缺失（更老的快照）时回退 `tokens`。
2. **退化路径漏角色开销**：`priceSurfaceNode` 只给 `tool/result` 加 `ROLE_OVERHEAD`，
   user/assistant 漏加 4 tokens/条。现改为完整镜像官方
   `estimateMessage(deriveEventMessage(event))`：非 system 一律 `estimateContent + ROLE`；
   system 按文本密度单次取整 + ROLE；**空内容 system/assistant 一律计 0**
   （空 assistant 节点只承载 usage，官方 `deriveEventMessage` 对它返回 `null`——
   注意 `if (content)` 判断对空数组 `[]` 为真，必须显式查 `length === 0`）。

**投影缝（同日同步）**：`priceSurfaceNode` 与 `projectRegion` 现在都先经
`surface.deriveEventMessage(event)` 取消息（三值：对象=采用；`null`=缝判定无消息；
`undefined`=缝不可用 → 回退原始 payload）。原因见下节 `image/offload`。

### 投影型事件与 `image/offload`（harness 0.1.6-alpha.1，2026-09-17 增补）

上游新增 `packages/compaction/compaction-image-offload`：请求图像超出路由预算时，它追加一条
**log-only 的 `@messageProjection` 事件** `image/offload`，`targets` 指名「哪个 surface 节点、
第几个 depth-first 图像 occurrence 被丢弃」。三条关键语义：

- **标记只存在于投影输出里，不在存储事件里**：`image/offload` 的 payload 只有 targets；
  `{...block, offloaded: true}` 由**读时投影**（`offloadMessageImages`）加上，而把标记替换成
  占位文本是**适配器在请求序列化时**做的（`projectOffloadedImages`）。所以"读原始事件"与
  "读投影消息"看到的是不同的东西。
- **门禁变严**：旧适配器会自行静默 offload 超预算的图像；新适配器直接抛
  `LlmError(code='IMAGE_OFFLOAD_REQUIRED')`（文案："request images exceed the route budget;
  N more oldest occurrence(s) must be offloaded"）。
- **恢复缝只有两条**：`agent/request-error` 与 `compaction/summary-error`（后者为区间内新增）。

**为什么这命中本插件**：本插件的摘要调用**直连 `ctx.llm.stream`**，既不在 `agent/request`
缝上、也不在那两条恢复 waterfall 上。而 `projectRegion` 原先直接读 `event.data` 拼回放消息
——**不带 `offloaded` 标记**——于是适配器不会替换，用户已离线的图像会被真的发出去；区间图像
超预算时直接抛 `IMAGE_OFFLOAD_REQUIRED`，摘要以 error 关闭、永不提交（`failureCooldown` 只
兜诊断、不拒绝，故不自愈）。旧版不存在这个失败面。

**现方案**：`projectRegion` 与 `priceSurfaceNode` 都先经 `surface.deriveEventMessage(event)`
（官方逐事件投影读取，已应用全部已提交投影）；`summarizer.js` 另把
`IMAGE_OFFLOAD_REQUIRED` 单独识别为 `status: 'image-offload-required'`，日志给出可操作原因
（压缩更小的区间，或先让 durable 的 `image/offload` 决策丢弃它们），而不是退化成通用
`provider-error`。

**通用教训**：任何"重建模型输入"的代码（回放、修剪、摘要输入）都必须消费**投影后消息**，
而不是原始事件 payload —— 这是上游 2026-08-19 定的强制投影缝（
`.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.md`）。
`image/offload` 是第一个让违反该缝**产生运行时失败**（而非仅语义偏差）的投影事件。

**折叠器侧不变量**（供日后排查）：`pressureTokens`（provider usage 锚定）在
压缩后不会立即变化，要到**下一次请求**拿到新的 usage sample 才会反映收缩；
`surfaceTokens` / `messageTokens`（纯估价折叠）则在 replace 落定瞬间完成扣减。
`projectedTokens = max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)`
只在前者存在时才有意义；contextWindow 缺失时整个环形刻度隐藏。

### 内置引擎（src/engine/builtin.js）

自包含、不依赖官方 `compaction` 服务的完整持久事务：

| 步骤 | 追加的事件 | 说明 |
|------|-----------|------|
| 打开锁 | `compaction/start` | `compactionId`（UUID），`turn`（当前 open turn 号或 null） |
| 摘要生成 | — | 通过 `ctx.llm.stream` 流式生成，受 `maxSummaryTokens` 上限约束；**对齐官方 `compaction-basic`**：注入会话的 `system` 提示词（0.1.5 起取自表面节点 0 的 `system/message`，旧版取请求头 `system`；见 `summarizer.js` `headerPrefix`）+ 请求头 `tools` 模式做前缀缓存对齐、三级 target 解析（configured→routed header→agent.options）、`purpose:'compaction'` 标签、完整 StreamChunk 装配（文本/推理/图像/用量）、终止 finish 分类（error/aborted/max-tokens/image 均按 fail-closed 抛错） |
| 收缩门禁 | — | `tokenMeter.estimateMessage` 判定摘要 tokens < 被遮蔽区间 tokens，否则中止 |
| 提交摘要标记 | `compaction/summary` | 记录 `compactionId`、`shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`、**必填** `provider`/`model`、实测 `maxTokens`/`usage`（摘要调用真正观察到的 LLM 封装，而非预调用启发式猜测） |
| Surface 替换 | `user/message` + `surfaceOp:{op:'replace',startSeq,endSeq}` | 带规范的 compact 检查点 source `{kind:'plugin',plugin:'compact',compactionId}`；`sourceEventSeqs` 指向 start+summary+shadowed |
| 闭合锁 | `compaction/end` | 同上 `compactionId`；失败路径在此带 `error:` 字段（可省略 summary） |

**为什么内置引擎改用官方 `compaction/*` 词汇（而非此前的 `fc-compact/*` 前缀）：**
早期版本刻意用独立 `fc-compact/*` 前缀以规避官方 `compaction/invariant` 监听器。
但该决策带来一个**致命的跨重建砖墙**：会话日志的重载门禁（
`packages/session/session-persistence` coordinator 载入阶段）会把**任何未知且未标记
`ignorable` 的事件类型**判定为"无法重建"而**拒绝整个日志加载**。`fc-compact/*`
并不在 harness 生成的 `KNOWN_SESSION_EVENT_TYPES` 编目内（编目只收录官方
`compaction/*` 等内置类型；下游插件自定义类型按构造就在编目之外），因此
`fc-compact/*` 事件必须携带信封层的 `ignorable:true` 才能在新 build 里存活。可是
`Session.append` 对非 surface 类型**不开放 `ignorable` 通道**——它把返回的事件包封
深冻结，唯一接受的信封键只有 `surfaceOp`/`sourceEventSeqs`（仅 surface 事件可用）。
结果：试图在冻结返回上挂 `ignorable` 直接抛
`Cannot define property ignorable, object is not extensible`，事务在第一个
append 即中断、什么都没落盘，还留下泄漏的锁遮住后续重试。**唯一的正解是把
`markIgnorable` 彻底移除，改用官方 `compaction/*` 词汇**——官方类型天生在编目内，
重载无需 `ignorable`，天然跨 build 持久。代价是要满足官方的全局
`compaction/invariant` 监听器（它校验每一条落地的 `compaction/*`），为此内置事务
严格遵守其全部不变量：三个括号事件共享同一个非空 `compactionId`；`turn` 在有
open turn 时取该 turn 号、空闲路径取 `null`（与 `validateOwner` 一致）；
`compaction/summary` 的 `shadowedSeqs` 非空且首尾等于 `shadowedRange` 起止、
`provider`/`model` 必填；无错误的 `compaction/end` 必须跟在一条 `compaction/summary`
之后（出错路径可省略 summary 并携带 `error`）；括号跨度内不与 `turn/start|end`
交错（四条 append 是同步串，天然成立）。检查点 `user/message` 的 source 也换成
规范的 `{kind:'plugin',plugin:'compact',compactionId}`（`isCompactCheckpointSource`
据此识别，并要求 source 上的 `compactionId` 等于在途事务的 `compactionId`）。
两引擎在同一进程仍可并存（官方服务可达就用官方、不可达才内置接管），共用同一套
`compaction/*` 词汇与同一份 invariant 校验。

### 历史背景（为何需要内置引擎）

早期版本只做了一件事：从 preset 的 `isolate` 组里解析 `compaction` 服务。标准
preset 把 `compaction-basic` 挂在了 `- isolate:{compaction:true,…}` 组里，而本插件
是 **Host 全局监听器**——`apply` 上下文、`event-dispatch` 上下文、`agent.ctx`
都不是该组的 descendant，所以 `ctx.get('compaction')` 在这些上下文里都返回
`undefined`（经验证：`agent.ctx` 能解析 `sessions/llm/tokenMeter/settings/agents`，
唯独 `compaction` 不能——证明我们持有的是同级另一个 scope）。同时 AGENTS.md 既有
约束禁止 `inject:['compaction']`（preset 平面晚挂载，硬 inject 会触发启动断言
失败）。结果是标准 preset 下四条路径全退化为 skip + WARN，压缩实际从未发生过。

内置引擎正是为了填补这一空白而生：它**绕过服务解析问题**，直接用公开可用的
`ctx.sessions.append` + `ctx.llm.stream` + `ctx.tokenMeter.estimateMessage`
完成整条事务链，不需要碰 `compaction` 服务本体。

### 配置项（`falling-ts-force-compact` 命名空间）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `disableThinking` | boolean | `true` | 摘要 LLM 调用携带 `reasoningEffort:'off'` |
| `autoThresholdTokens` | number (≥ 32000) | `32000` | `agent/pre-step` 自动压缩触发阈值；**下限 32000**（表单与读取时双向钳制：低于下限的值读取时自动抬升至 32000） |
| `retainLatestTokens` | positive int (≥ 8000) | `8000` | 自动/强制压缩时**保留最新的绝对 token 数**：从会话**最新条目**起，按官方 `tokenMeter` 的逐节点计数**反向**累加，直到 ≥ 该值**停止**；该截点之前的**所有条目一次性**发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变。**下限 8000**（低于 8000 的值读取时自动抬升至 8000）。替代旧的 `autoEarliestRatio` / `forceEarliestRatio` 比例参数。 |
| `turnEndForceCompactionEnabled` | boolean | `true` | agent 转入 `idle` 时是否触发一轮结束压缩 |
| `debug` | boolean | `true` | `[force-compact]` 调试日志开关 |
| `logFile` | string | `~/.dsh/logs/dsh-force-compact.log` | 调试日志目标路径 |
| `compactionMode` | `'realm'\|'global'` | `'realm'` | 官方服务解析策略（仅影响 priority-1 路径） |
| `builtinEnabled` | boolean | `true` | **内置引擎闸门**。`false` 时严格只走官方；缺省视为 `true`（兼容旧 yaml） |
| `maxSummaryTokens` | integer (1024–200000) | `1024` | 摘要 LLM 调用的 `maxTokens` 上限；防超长摘要。**下限 1024**（低于 1024 的值读取时自动抬升至 1024） |
| `summarizationTimeoutMs` | integer (5000–2147483647, ms) | `90000` | 一次摘要流的硬墙钟超时上限（`summarizer.js` 挂起守卫；见上文硬超时守卫 + 适配器竞态诊断节）。**下限 5000**（低于 5000 的值读取时自动抬升至 5000）；**上限 2147483647**（`AbortSignal.timeout` 可调度的最大延迟；超界值双向钳制、小数截断——见上文"上限为何是硬的"）。必须**严格小于**目标适配器的 `streamIdleTimeoutMs`（否则适配器空闲超时先到，表面出现 `TIMEOUT` error 而非本插件干净的 `'timeout'` abort）；`emitTimeoutRaceDiagnostic` 在调用前自动诊断并在失配时发出 WARN |

### 如何验证内置引擎工作

1. 重启 3180 dev 实例（`bash harness-server-dev.sh`）。
2. 建一个短会话并发送任意消息（哪怕 "Say hello"），等回合结束进入 `idle`。
3. 看 `%USERPROFILE%\.dsh\logs\dsh-force-compact.log` 末行是否出现
   `idle compaction (builtin) shadowed N nodes (~M tokens)` 以及
   `builtin compaction OK — replaced span seq[…] (N nodes, ~M tokens) with a P-char checkpoint`。
4. `session.history` 查该会话，应看到 4 个连续事件：
   `compaction/start` → `compaction/summary` → `user/message`(replace) → `compaction/end`，
   共享同一个 `compactionId`。

### 如何将官方服务"赢回来"

如果你的 preset 改过组合拓扑，使 `compaction-basic` 不再 isolate（root-realm
或服务被显式挂到 host plane），则 `ctx.get('compaction')` 可命中，priority-1 路径
直接胜出，内置引擎自然不参与——无需改动任何配置。

### Wire 层补丁：面向 llama.cpp 的 `reasoning_effort:"none"`（2026-08 添加）

**背景**：`disableThinking` 在 harness 层表达为 `reasoningEffort:'off'`，经
DeepSeek 适配器翻译为 wire 字段 `thinking:{type:'disabled'}`。对真·DeepSeek
API 这是正确的语义，但对 **llama.cpp OpenAI 兼容端点**（本机 :8080 驱动的
`Qwen3.8-27B-NVFP4-MTP-LOW.gguf` 等本地 GGUF 部署）该字段**不被识别**：
llama.cpp 的 OAI schema（`server-schema.cpp`）里没有 `thinking` 这个键，OAI
解析路径也不读取顶层裸 `thinking`（实测于本机 `D:\AI\llama.cpp`），它会被
原样塞进 `llama_params` 然后被**无声忽略**——结果是 `disableThinking:true`
在 llama.cpp 上**静默失效**（模型继续思考，没有任何错误暴露）。

llama.cpp 原生支持关闭推理的两种 wire 形态（`server-common.cpp`）：
- **顶层 `reasoning_effort: "none"`**（1295-1304 行）——最稳，无论模板能力如何
  都会被解析成 `inputs.enable_thinking = false`；
- `chat_template_kwargs: { enable_thinking: false }`（1286-1291 行）——依赖
  模板本身支持 `enable_thinking` 占位符，不如前者鲁棒。

**实现**：`src/hooks/wire-rewrite.js` 提供一个 `llm/stream` Waterfall 监听器
（挂在 `ctx.llm.stream` 前的单一 LLM 出口缝，参见
`deepseek-harness/packages/llm/llm/src/index.ts` 的 `llm/stream` 事件）。
每次出 LLM 调用前，钩子按以下规则做**无条件全量追加**（不再有 provider/model
目标门控——`reasoning_effort:"none"` 在所有已知后端上都无害：真 DeepSeek 容忍
未知顶层键、llama.cpp/OAI 兼容层直接解析执行），因此一旦 `disableThinking`
开启就对**每一次**出站调用（业务请求 + 本插件摘要调用）追加，消除"目标识别
启发式漏判某条 Qwen 路由 → 静默仍思考"的死角：

| 条件 | 行为 |
|------|------|
| `disableThinking` 设置为 `true` | 在 `next()` 返回的 options 上做**浅拷贝**，追加 `reasoning_effort: 'none'` 后返回；原有 `thinking` 字段保留不动，形成**双层保险**。 |
| `disableThinking` 缺失 / 为 `false` | `return await next()` 原样转发，零开销短路（不分配、不改写）。 |

**双层保险（关键设计）**：`disableThinking` 现在由**两处**协同关闭思考，二者互补、各有覆盖：
- **层 1（请求缝，adapter 产出）**：`agent/request` waterfall 设 `reasoningEffort:'off'`，经 DeepSeek 适配器序列化为 wire 字段 `thinking:{type:'disabled'}`。**真 DeepSeek API 认这个字段**；在 llama.cpp/OAI 兼容端点上该顶层键不被 schema 识别、被透传进 `llama_params` 后忽略——故此层对 llama.cpp **无效**。
- **层 2（wire 缝，本钩子追加）**：`llm/stream` waterfall 在 adapter 序列化之后追加顶层 `reasoning_effort:"none"`。**llama.cpp/OAI 兼容端点认这个字段**（`server-common.cpp:1295-1304` 特判为 `inputs.enable_thinking=false`，与 jinja 模板能力无关）；真 DeepSeek 端点将该未知键静默忽略——故此层对真 DeepSeek **无害**。

任一端点至少收到它能理解的其中一个字段，`disableThinking:true` 即在**任何后端**
都如实关闭思考，两层之间无盲区。

**为何不做目标识别**：早期版本曾用 `isOpenAiCompatibleTarget`（`provider` 含
`llama` / `model` 以 `.gguf` 结尾）做保守门控，但漏判某条非常规路由的后果就是
回到静默失效；而误判（真 DeepSeek 被多打一未知键）本就无害。既然两端点都无害，
干脆去掉门控改为全量追加——覆盖率确定性最高，也不再有启发式要维护。

**惰性幂等安装**：与 `maybeRegisterCommand` 同套路——`maybeInstallWireRewrite`
在每个受守卫的监听器（`agent/request` / `agent/pre-step` / `agent/status`
idle 过渡）首次进入时被调用，内部 `registered` 闩锁保证同一生命周期内至多
装一次。`apply` 启动期不调用（预设平面晚挂载，启动期强装会与后续 adapter
注册竞态）。

**为何不用独立 `registerAdapter`**：harness 已把 llama.cpp 流量路由经由
DeepSeek 适配器（无独立的 llama.cpp 适配器包），再起一份 adapter 会与既有
注册冲突或被组合顺序掩盖。`llm/stream` 是官方认可的"调整下一次调用序列化
方式"的拦截缝，不破坏单一 LLM 出口不变量。详见
`docs/llm-stream-llamacpp-adaptation.md` §7（A/B/C 三方案，此处采用 A）。

**观测**：钩子仅在真正改写时输出一条
`ctx.logger.debug('[force-compact] llm/stream: appended reasoning_effort="none" (disableThinking on) for <provider>/<model>')`，
供事后核查；`disableThinking` 关闭或不改写路径零日志。

### 摘要器：深度对齐官方 `compaction-basic`（2026-08 升级）

内置引擎的 `ctx.llm` 摘要调用现已全面对齐官方 `compaction-basic` 的单源实现
（`deepseek-harness/packages/compaction/compaction-basic/src/summarizer.ts` 的
`summarizeWithLlm`）。**单一事实源原则**：所有可观察的 LLM 行为——target 解析顺序、
前缀缓存对齐策略、`purpose` 标签、finish 语义、输出过滤、usage 采集——与官方保持一致，
避免插件维护两份互相漂移的实现。

| 维度 | 现状 |
|------|------|
| **Target 解析** | 三级回退：① 配置 `summarizationProvider`/`summarizationModel`（双非空才有效）→ ② 会话最新路由头 `agent.session.requestHeader().config.{provider,model}` → ③ `agent.options.{provider,model}`。取首个同时提供两字段的候选；三者皆缺 → 返回 `null`（不发出调用）。 |
| **前缀缓存对齐** | 从 `requestHeader()` 提取 `system`（字符串）与 `tools`（数组）原样传入 `options.system` / `options.tools`，辅助调用即成为上次路由请求的真前缀，provider 的热 KV 缓存得以复用而非失效。请求头缺省时相应字段整体省略，退回旧的"仅消息"形态。 |
| **Purpose** | `options.purpose = 'compaction'` 恒定标签（closed-union，adapter 据此路由生成策略）；**不用** agent 的自由文本 purpose。 |
| **流式装配** | 对所有 `StreamChunk` 种类做完整装配（仿官方 `BlockAssembler`，但因插件以 plain JS 发布、无法解析 `@deepseek-ai/dsh-llm` 符号，此处**内联**一份等价装配逻辑，对照文档化的 `StreamChunk` 形状书写）：`text-delta` 累积为 `{type:'text'}` 块；`reasoning-delta`/`reasoning-chunks` 归并为 `{type:'reasoning'}` 块（**后续剔除**——推理是 UI 折叠区，不作 checkpoint 内容）；`image` 置 `hasImage=true` 并保留块；`usage` 捕获 provider 上报的 usage；`finish` 捕获终止事实。 |
| **Finish 分类（fail-closed）** | 无终块 → `TypeError`；`error` → `PROVIDER_ERROR`（携带 provider 失败描述）；`aborted`/`abort` → `ABORTED`；`max-tokens`/`length` 且文本为空 → `MAX_TOKENS_EMPTY`；`max-tokens`/`length` 且有文本 → **接受为部分摘要**（交由下游收缩门禁决定是否有用）；图像输出 → `UNSUPPORTED_CONTENT`；纯白文本 → 抛错。 |
| **错误语义** | `null` 仅表示"从未发出调用"（缺 target 或缺 `ctx.llm`）；其他一切失败一律**抛异常**，由 `runTransaction` 捕获并经 `closeWithError` 走带 `error:` 字段的 `compaction/end`。 |
| **Usage 采集** | provider 上报的 usage 随结果上浮，落到 `compaction/summary` 事件的 `usage` 字段，供可观测性使用。 |
| **`<compacted-summary>` 标签** | 指令尾部明确要求：若输入已含 `<compacted-summary>` 块（前次 checkpoint），不得逐字复制，须保留仍然成立的、丢弃过期信息、并入更新的信息。防二次压缩整段拷贝旧摘要导致雪球膨胀。 |
| **向后兼容** | `summarize(ctx, config, agent, messagesOrInput, signal, extra)` 第 4 参既可传裸 `messages` 数组（旧形态，自动包装为 `{messages}`），也可传 `{messages, system?, tools?}`（新形态）。现有调用方零修改即可享受新能力；`builtin.js` 已切到新形态并喂入 `headerPrefix()` 提取的前缀。 |

### `disableThinking` 语义收窄（2026-08 修订）：只关压缩，业务放行

**需求**："压缩按照是否关闭思考的配置来。其它不是压缩的请求，默认放行"。

**改动**：`disableThinking`（默认 `true`）的作用域从"所有出站模型请求"收窄到
"**本插件自己发出的压缩摘要调用**"：

| 路径 | 改动前 | 改动后 |
|------|--------|--------|
| `agent/request`（业务对话 / 子代理 / 工具触发的每次模型请求） | 统一盖 `reasoningEffort:'off'` | **纯透传**——机器本来的 `LlmCallConfig` 原样放行 |
| 本插件内置引擎的压缩摘要调用（`builtin.js` → `summarizer.js` 的 `ctx.llm.stream`） | `reasoningEffort:'off'`（经 `extra` 传入） | **保持不变**——`disableThinking=true` 时摘要调用携带 `'off'`；`=false` 时不附加、沿用机器默认 |
| 官方 `compaction` 服务的摘要调用 | 不经过本插件的两条缝（直连 `ctx.llm.stream`），不受影响 | 同左 |

**为什么这样改**：`agent/request` 缝在 **agent-loop** 内部
（`packages/core/agent-loop/src/agent.ts:457`），只对**业务对话步骤**触发；
插件与官方引擎的摘要调用都直连 `ctx.llm.stream`，**根本不经过这条缝**。所以
旧实现的实际效果是"业务对话全被打成 `'off'`，而摘要调用反而是从另一处
（`builtin.js:729`）拿的 `'off'`"——方向正好和需求相反。新实现删掉了
`index.js` 里 `__agentRequestListenerBody` 的全局盖章逻辑（改为 `await next()`
后原样返回），`agent/request` 监听器本身**保留**（Waterfall 必须 `next()`，
且懒安装的 debug-sink / settings-namespace / command / wire-rewrite 钩子搭着
它的激活时机安装）；`src/hooks/guard.js` 的 `thinkingDisabled` 助手降为
**legacy predicate**（不再被热路径调用，但仍导出供将来需要 blanket-off
语义的消费方复用）。

**文档滞后警示**：下方"Wire 层补丁"章节描述的"双层保险"（layer 1 =
`agent/request` 盖 `'off'`）是**改动前的行为**——layer 1 已停用；layer 2
（`src/hooks/wire-rewrite.js` 的 `llm/stream` 透传）目前也仅是 LiveUI 水印
钩子，不再做 wire 追加。真实有效的思考关闭只剩 `builtin.js → summarizer.js`
一条线；对 llama.cpp/OpenAI 兼容端点的"压缩调用关闭思考"是否真的落到 wire
字段，取决于所经 adapter 的序列化（见下方 wire 层章节的局限说明）。

---

## 主题（浅色 / 暗色）：颜色一律走 `--fcts-*`（2026-09-17 增补）

本插件的设置分区与控件用内联 style。**内联 style 里的 `var()` 会沿 DOM 继承解析**，所以
`web/client.js` 在 `apply` 时注入一张只定义变量的样式表 `<style id="falling-ts-theme-tokens">`
（`THEME_TOKENS_CSS`，按 id 幂等），组件只引用 `var(--fcts-*)`：

- `body{…}` = **改动前的浅色字面值**（`rgba(0,0,0,…)` 系）→ 浅色外观逐字节不变；
- `body[data-ds-dark-theme]{…}` = **上游语义别名**（`label-primary` / `label-secondary` /
  `border-l*` / `interactive-bg-*`），由官方主题包按肤定义、随主题自动翻转。
  **暗色下说明文字（hint / intro / placeholder / value）取 `--dsw-alias-label-primary`
  = `rgb(249,250,251)`（纯白）**，对比度 17.45:1；此前的 `rgba(0,0,0,0.45)` 在暗色下几乎不可见。

保留字面量的只有品牌色（蓝渐变与辉光）、开关高光与投影阴影；其余（分隔线、边框、滑轨、
未选中文字、开关关闭态底色）一律 token 化。`--fcts-*` 规则与 dsh-web-ding 注入的**逐字相同**
（共享工作区命名空间，按 id 幂等，谁先注入都一样）。

验证：`node exploration/theme-token-probe.mjs`（解析官方主题表 → 逐级解析 var 链 → 按 WCAG
算对比度 → 拒绝悬空的上游 token → 保证浅色取值未漂移 → 扫出设置区残留字面色）。

## 界面文案与语言（i18n，2026-09-17 增补）

设置分区与 LiveUI 徽章的**每一句产品文案都归 locale 服务所有**，代码里不得出现硬编码副本
（上游 `packages/client/AGENTS.md` 的 locale-owned copy 红线，其闸门是
`pnpm run verify-client-ui-i18n`）。

**支持语言**：`zh`（中文）、`en`（English）、`ja`（日本語）、`ko`（한국어）。

**上游只内置 zh/en**：`@deepseek-ai/dsh-client-locale` 的 `LOCALE_IDS = ['zh','en']`，
但 `LocaleId` 是开放的 `string`，注释写明其余语言由**语言包插件**经
`ctx.locale.addLanguage({ id, label, fallback })` 贡献——`label` 用该语言自述，
`fallback` 必须已注册且 fallback 链以 `en` 为终点。本插件在 `apply` 里贡献 `ja`/`ko`
（`contributeLanguages`），于是它们出现在设置页「语言」下拉里，且浏览器语言探测
（先精确匹配整个 tag、再匹配主语言子标签）能够命中。

**为什么两个插件都贡献同样的 id**：`dsh-web-ding` 也贡献 `ja`/`ko`，而两个插件必须各自能
独立安装，不能约定"只由其中一个注册"。先到者拥有该目录项，后到者会收到
`locale "ja" is already registered`——`contributeLanguages` **只吞这一种错**（其余照抛），
并且只为**自己真正添加**的目录项登记 disposer（让位者的 disposer 是 no-op，卸载它不会
误删先到者的目录项）。

**字典**：`web/client.js` 顶部四份平表，zh 是键集事实源，其余三份必须逐键对齐。
`ctx.locale.register(NS, { zh, en, ja, ko })` 一次注册。查找链是
活动语言 → 其 fallback 链 → `en` → `common` 命名空间 → **键名本身**，所以缺键**不报错**，
只会静默回落到 en（或显示键名）——这正是必须由探针守住的原因。

**LiveUI 徽章**：宿主发出的 `liveUi` 只带语言无关的 `textId`（相位名或 `working.N`）
加规范中文 `text`；客户端把 `textId` 映射为 `badgeCompacting`/`badgeDone`/`badgeEnd`/
`badgeWorkingN` 后按活动语言取词，仅当 `textId` 缺失/未知时才回落到宿主的中文 `text`。
`badgeWorking0..19` 的顺序必须与宿主 `src/core/ui-signal.js` 的 `WORKING_TEXTS` 逐位一致
（客户端 zh 条目会**遮蔽**宿主 text，漂移即改变 zh 用户实际看到的文案）。

**验证**（两条都必须绿）：

```sh
node exploration/i18n-parity-probe.mjs        # 词典键集/语言包/副本归属，51 项
node --import <harness>/node_modules/tsx/dist/esm/index.mjs \
     exploration/i18n-locale-runtime-probe.mjs  # 驱动官方 LocaleRuntime 真身，40 项
```

## 如何判断插件是否加载成功

插件加载成功的**客观判据**是它会在日志文件 `~/.dsh/logs/dsh-force-compact.log`
（Windows 展开为 `%USERPROFILE%\.dsh\logs\dsh-force-compact.log`；路径由
`falling-ts-force-compact` 设置的 `logFile` 控制，默认此值，`~` 经用户家目录展开）
中写入一条带 `[force-compact]` 标记的行：

```
[force-compact] debug logging enabled — writing [force-compact] lines to <已解析的绝对路径>
```

这条行由 `src/core/log.js` 在安装日志 sink（`ctx.logger.exporter(exporter)`）之
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

- 插件的持久效果是**追加到会话日志的压缩事务**——具体形态取决于实际走了哪条引擎：走官方时落 `compaction/*` 系列（`compaction/start`、`compaction/summary`、`compaction/end`）加一个 `surfaceOp:replace` 的 `user/message`；走内置时同样落 `compaction/*` 系列（`compaction/start`、`compaction/summary`、`compaction/end`，字段形状与官方完全一致）加同样形态的 `user/message`。两种事务都以"前置括号事件 + 后置 replace 表面节点"的形式落地。除上文"例外"节的单用途定时器（`ui-signal.js` `publishDone`，有意偏离，见该节）外，插件不引入 timer 或内存态存储；Host 半部保持是**核心模型请求缝**（`agent/request` / `agent/pre-step`）与 `session/flush` 上的纯 Host 监听器。**另有一个 web client 半部**（`web/client.js`，`package.json` 的 `exports["./client"]` + `dsh.client.platform: web`，经 client module 系统自动组成，无需改 web-app 组合）：仅注册一个 `settings.section`（设置页左侧菜单"强制压缩 / Force Compact"分区，order 30），经 `settingsScope.bind({ namespace: 'falling-ts-force-compact' })` 镜像成 uSES 安全的 `SnapshotStore` 并读写字段（`scope.set`/`scope.unset` 写回 `settings.yaml`），**不**引入 timer、内存态存储或额外订阅；client 半部 `inject: ['slots','locale','settingsScope']`（这三个 client 服务在 client 启动时即可用，与 Host 侧的 `compaction` 运行时依赖不同）。**liveUi 徽标文字四语**：宿主发出的 `liveUi` 事件携带语言无关的 `textId`（相位名或 `working.N`）+ 规范中文 `text`；badge 显示文本由 client 半部经 `ctx.locale` 的 **zh/en/ja/ko** 词典按 `textId` 本地化（`badgeCompressing`/`badgeDone`/`badgeWorkingN`），跟随应用语言——英文 UI 显示英文俏皮话，日文/韩文 UI 显示对应译文，中文 UI 保持原文；宿主半部无 locale 服务，刻意保持语言无关（textId 缺失/未知时 client 回落到规范中文 `text`）。语言目录项与词典登记见下文"界面文案与语言"节。
- **两条压缩引擎**（见上文"双引擎架构"节）：
  - **官方引擎**——`compaction` 服务提供的 `compactNow` / `compactRegion`，由 preset 平面（`include:agent-presets:compaction-basic`）挂载，**是运行时可选依赖**：插件**不**声明 `inject`——profile 层条目在进程启动时激活，彼时 preset 平面尚未挂载该服务，硬 `inject` 会导致 `assertEntriesActivated` 启动断言失败；各压缩路径在事件时经 `findOfficialService`（`engine/backend.js`）按 `compactionMode`（`realm` 先试 `agent.ctx` 再试 `ctx`；`global` 只试 `ctx`）定位。
  - **内置引擎**——`src/engine/builtin.js` 自实现的完整压缩事务，只依赖 `ctx.sessions.append`、`ctx.llm.stream`、`ctx.tokenMeter.estimateMessage`（全部经 `ctx.get` 读取、可缺省、对 `undefined` 做守卫）。它追加**官方命名的 `compaction/*` 事件**（`compaction/start`、`compaction/summary`、`compaction/end`）与 `user/message`(replace)——**复用**官方词汇而非私造 `fc-compact/*`，因为官方类型天生在 `KNOWN_SESSION_EVENT_TYPES` 编目内，重载无需 `ignorable` 标记即可跨 build 持久（详见上文"为什么内置引擎改用官方 `compaction/*` 词汇"一节）。代价是须满足官方全局 `compaction/invariant` 监听器的全部不变量（共享 `compactionId`、owner/turn 一致、`shadowedSeqs` 对齐 `shadowedRange`、`provider`/`model` 必填、无错 `end` 需紧跟 `summary`）。两引擎并存时优先级：官方可达即用官方；官方不可达才落到内置（`builtinEnabled !== false` 且 `agent.session` / `llm.service/stream` 可用）。
- `agents`、`settings`、`tokenMeter`、`commands`、`llm` 都是可选依赖（`ctx.get(...)`，对 `undefined` 做守卫）：`agents` 仅供 `session/flush` 路径（缺少 Agent 是记录日志后跳过）；缺少 `settings` 时所有参数回退到默认值；缺少 `tokenMeter` 时阈值门禁回退到粗略字符估算；缺少 `commands` 时 `/force-compact` 命令不注册（`src/hooks/command.js` 是 no-op）；缺少 `llm` 时内置引擎不可用（官方引擎不受影响）。
- **钩住核心模型请求（`agent/request` / `agent/pre-step`）：** 插件的核心行为是钩住官方模型请求缝，**每次请求模型前**读取设置：
  - **`agent/request`**（围绕冻结调用配置的 Waterfall）——**纯透传**（2026-08 语义收窄，见上文"disableThinking 语义收窄"节）：监听器 `await next()` 取得机器本会使用的配置后**原样返回**，业务请求沿用机器默认的思考强度；`disableThinking` 只作用于本插件自己的压缩摘要调用。监听器**不得**在缺少 `next()` 时短路（必须调用 `next()`）。
  - **`agent/pre-step`**（每个模型步骤前的 Waterfall）——通过 `tokenMeter.measure(session).totalTokens` 读取会话上下文总 tokens；当其**≥ `autoThresholdTokens`** 时，返回 `{ kind: 'reject' }` **不发起模型请求**，并按 `retainLatestTokens` 语义选区：**从会话最新条目起按官方 `tokenMeter` 逐节点反向累加 token，直到 ≥ `retainLatestTokens` 停止**；截点之前的**所有条目一次性**通过 `compactRegion` 发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变；低于阈值时调用 `next()` 让请求继续。强制压缩失败（无安全区间 / 已活跃）时降级为 `next()`，绝不阻塞请求。
  - **2026-09 语义——触发后循环压缩（不再"预测压不到阈值就跳过"）**：三处触发路径
    （`agent/pre-step` 自动门禁、`/force-compact`（空闲与下一模型步骤）、`agent/status`
    idle）在阈值达到后**循环压缩直到 `projectedTokens` 压回 `autoThresholdTokens` 以下**：
    guard.js 的 `compactRetainingLatest` 每轮重新读数 + 重新选区 + `compactRegion`；内置
    引擎删除了 `compactNow` 路径的 threshold-aware SHADOW-SPAN FLOOR（其 `total − span ≥
    threshold → skip` 判定把 provider 压力基线计入 `total`，baseline 偏高时会令可压缩会话
    滞留超阈值，2026-09 移除；**post-summary 摘要必须小于被遮蔽区间的 shrink gate 保留，
    它才是防膨胀的最后防线**）。循环停止条件：(a) 第二轮起 `projectedTokens < threshold`
    （首轮无条件执行，保住 `/force-compact` 的强制语义）；(b) 选区为 null（整个表面不超过
    `retainLatestTokens` 保留预算，真没有可压的头部——这不是"拒绝"，是无可压对象，保持 `break`）。
    **2026-09 无拒绝语义（用户规格："触发压缩后不要有任何拒绝，直接执行压缩，如果压缩后还是
    超过阈值就继续压缩，一直压缩到阈值以下"）**：(c) 一轮提交失败 / 空提交（`compactRegion` 返回
    null）/ 表面一致性失配 / 配对边界校验失败，全部 **`continue` 重试**（下一轮重新读数 + 重新
    选区），**不再 `break` 中止**——失败不中止压缩，循环继续直到 `projectedTokens` 压回阈值以下。
    内置引擎的**失败冷却（`failureCooldown`）已降级为"仅诊断、不拒绝"**：`consultFailureCooldown`
    只输出一条 note（解释为何近期摘要失败，如本地端点 90s 摘要流挂起），**不再 `return null`
    跳过本次**——避免一次失败把会话在阈值之上搁置长达 180s。`MAX_COMPACTION_ROUNDS=8`
    （`src/core/policy.js`）仍是硬上限，防 provider 基线异常 / 摘要持续挂起时无限烧摘要调用
    （最坏 8 轮 × 90s 摘要超时）。仍 `continue` 重试（而非拒绝）的物理防呆：surface 一致性
    交叉校验、配对边界校验；仍 `return null` 的资源护栏（非阈值预测，防不可服务的巨型摘要调用，
    经无拒绝循环重试 8 轮后自然止步）：small-span（< `MIN_USEFUL_SPAN_TOKENS`）跳过、replay
    消息上限（`MAX_REPLAY_MESSAGES`）；以及 busy 锁（`assertNoActiveCompaction`，防嵌套括号）。
  - 两个参数都**每次请求**通过同步 `settings.get('falling-ts-force-compact')` 读取，因此 `settings.yaml` 的改动在下一次请求即生效。
- **`/force-compact` 斜杠命令（`commands` 服务，可选依赖）：** 通过 `/` 选择执行，其 handler **不发送模型请求**。Agent **空闲**时经 `compactNow`（owner `null`，空闲手动入口）立即压缩（引擎自身区间选择）；**繁忙**时 `compactNow` 被拒绝，handler 排队一个强制标记（`src/hooks/command.js`）。handler 逻辑：
  - 直接调用 compaction 服务的 `compactNow(agent, invocation.signal)`（事件时经 `ctx.get('compaction')` 实时读取；owner `null`，空闲手动入口）压缩会话——空闲时立即生效，使用引擎自身的区间选择。
  - 若 `compactNow` 抛出（Agent 繁忙 / 无安全区间），调用 `queueForceCompact(session.id)` **插入一个 JS 内存标记**（process-local `Map`，无持久态、无 timer），返回 "将在下一个模型步骤强制压缩"。
  - 该标记由 `agent/pre-step` 钩子（`takeForceCompact`）在**下一个模型步骤**读取并**立即消费**：读到强制标记则**跳过 token 阈值门禁**、按 `retainLatestTokens` 语义选区（同上，保留最新 N tokens、头段一次性压缩）并经 `compactRegion` 执行，并返回 `{ kind: 'reject' }` **不再请求模型**——即"再请求钩子中如果读取到强制命令, 立马执行压缩, 不再请求模型"。
- **强制压缩配置（`falling-ts-force-compact` 设置命名空间）：** 当 `settings` 服务挂载时，`apply` 注册 `falling-ts-force-compact` 命名空间（`src/core/settings.js`；`falling-ts-` 前缀防止与其他插件的配置键冲突），九个参数可从 `$DSH_HOME/settings.yaml` 配置（详见上文配置项表格）：
  - `disableThinking`（`boolean`，默认 `true`）——**语义收窄后**（2026-08 修订）：只控制**本插件内置引擎的压缩摘要调用**是否携带 `reasoningEffort:'off'`（适配器映射为 `thinking: { type: 'disabled' }`）。**其它模型请求**（业务对话、子代理、工具触发、其它插件）一律沿用机器默认，不受此开关影响。
  - `autoThresholdTokens`（`number`，默认 `32000`，下限 `32000`）——强制压缩触发阈值；`agent/pre-step` 仅在会话总上下文 tokens ≥ 该值时强制压缩，低于则跳过。低于下限的值读取时自动抬升到 32000。
  - `retainLatestTokens`（positive int，默认 `8000`，下限 `8000`）——**保留最新的绝对 token 数**：`agent/pre-step` 阈值门禁或 `/force-compact` 强制标记触发时，从会话**最新条目**起按官方 `tokenMeter` 逐节点**反向**累加 token，直到运行和 ≥ 该值**停止**；截点之前的**所有条目一次性**通过 `compactRegion` 发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变。低于下限的值读取时自动抬升到 8000。**该参数同时服务于自动路径与 `/force-compact` 命令路径**（后者在空闲时仍经 `compactNow` 用引擎自身区间选择，不经此参数）。
  - `turnEndForceCompactionEnabled`（`boolean`，默认 `true`）——**是否开启一轮结束强制压缩**：为 `true` 时，agent 转入 `idle`（所有轮次结束，含子代理，下一次人为对话之前）时经 `compactNow`（引擎自身区间选择）强制执行一轮结束压缩。
  - 命名空间注册在 `ctx.effect` 中完成（`apply` 启动时一次性异步执行）；`registerNamespace` 在 `settings` 缺失时是 no-op，绝不阻塞 `agent/*` / `session/flush` 监听器的注册。
- **一轮结束强制压缩（`agent/status` 上的 `idle` 监听器，`src/hooks/idle.js`）：** 监听 `agent/status`；当 agent 转入 `idle`（无 driver 活动——所有轮次结束，含子代理，下一次人为对话之前）且 `turnEndForceCompactionEnabled` 为 `true` 时，经 `compactNow`（owner `null`，空闲手动入口）压缩会话——使用引擎自身的区间选择（空闲路径无法选择自定义 token 比例，故无一轮结束比例参数）。`agent/status` 监听器不携带 turn signal，故每次 `idle` 新建一个 `AbortController`。压缩失败（已活跃 / 无安全区间）仅记录日志，绝不阻塞。
- 监听器是异步且被依赖的：`session/flush` 是被等待（awaited）的 `parallel` 检查点，因此压缩必须在监听器返回前完成。不要把它拆成 fire-and-forget，除非显式说明持久性保证。
- 每次 flush 新建一个 `AbortController`（被等待的检查点覆盖其生命周期）；把它的 `signal` 传给摘要器与 `compactRegion`。
- 源码布局（单仓即插件包）：
  - `index.js`（仓库根）—— Cordis 函数插件入口（`name` / `apply`，不声明 `inject`），注册 `agent/request` / `agent/pre-step` / `agent/status` / `session/flush` 四个监听器、设置命名空间与 `/force-compact` 命令。
  - `web/client.js` —— 浏览器半部：设置页 "强制压缩 / Force Compact" 分区（`settings.section`），经 `exports["./client"]` 导出。
  - `src/core/` —— 基础设施：`policy.js`（可调参数，固定常量）、`settings.js`（设置命名空间）、`log.js`（调试日志 sink）。
  - `src/engine/` —— 压缩引擎层：`selectRegion`（按 surface 节点数保留最近尾段，检查点路径用）与 `selectEarliestByTokens`（按 `tokenMeter` 测量的总 tokens 的 `ratio` 比例从头累计至预算后截断，末端对齐 `user/message` 边界，供 `agent/pre-step` 使用；`idle` / `/force-compact` 路径改用 `compactNow` 的引擎自身区间选择）。
  - `summarizer.js` —— 插件自己的一次性 LLM 摘要器（回放区间，追加压缩指令，通过 `ctx.llm` 流式生成）。
  - `builtin.js` —— 内置压缩引擎（复用官方 `compaction/*` 事务链，见上文）。
  - `backend.js` —— 统一后端 facade：官方 `compaction` 服务优先、内置引擎后备（`resolveCompaction`，两条路径形状一致）。
  - `checkpoint.js` —— 检查点编排器：选区间 → 投影区间消息 → 运行预览 + 收缩门禁 → 把持久变更委托给 compaction 服务的 `compactRegion(start, end, agent, signal)`（经 `ctx.get('compaction')` 实时读取；不可用时跳过检查点）。
  - `src/hooks/` —— Cordis 触发钩子：
    - `guard.js` —— 每次请求的门禁：`agent/request` 纯透传（2026-08 语义收窄后不再盖 `reasoningEffort`；`thinkingDisabled` 助手保留为 legacy predicate 但不再被热路径调用）+ `agent/pre-step` 阈值门禁（按 `retainLatestTokens` 保留最新 tokens、头段一次性压缩）+ `/force-compact` 的 process-local 强制标记（`queueForceCompact` / `takeForceCompact`）。
    - `command.js` —— `/force-compact` 斜杠命令（`commands` 服务，可选依赖）：空闲时经 `compactNow` 压缩；繁忙时插入 JS 内存标记。
    - `idle.js` —— 一轮结束强制压缩：`agent/status` 上的 `idle` 监听器，经 `compactNow`（引擎自身区间选择）压缩。
- 每条引擎内部都会做**预提交预览 + 收缩门禁**（各自的 LLM 摘要 + 收缩判定），所以本插件不在持久路径上重复摘要。`engine/checkpoint.js` 本身只做"选区间 + 委派"，不再额外跑一次预览——这是上一版的遗留 bug（曾在此处双重摘要，现已被清理）。
- Monorepo 集成会把它包进 `src/index.ts`，并新增一个真实组合（REAL-composition）测试：启动仅测试用的 `cordis.yml` 并断言持久的摘要节点；本独立产物是 plain JS，无构建步骤。

## 会话事件读取适配（harness Session 重构兼容，2026-09 增补）

harness 在 0.1.2-rc.1 时代重构了 `Session` 类：**不再暴露公开的 `events` 数组**——
事件读取走 `session.eventAt(seq)`、全量日志走 `session.snapshotEvents()`（`seq ==
数组下标` 的连续契约）、消息派生走 `deriveMessages()`。插件此前到处按旧假设
`session.events` 数组读取，升级后**静默退化为空**：`estimateSessionTokens` 恒 0
（`rawSweep=0`）、builtin `projectRegion` 恒"no surface messages"、配对账本的
`eventForSeq` 抛异常（被 SAFE 变体吞成"假定平衡"）。**统一改经
`src/core/session-events.js`** 提供的 `sessionEvents(session)`（新
`snapshotEvents()` / 旧 `events` 数组双兼容，永不抛）与 `sessionEventAt(session, seq)`；
`hasSessionEventStore(session)` 供诊断读取做闸门。**新增任何读会话事件的代码一律
用这两个 helper，禁止直接访问 `session.events`。**

**弃用通告（2026-09-09，上游已实现）**：`Session.eventAt()` / `snapshotEvents()` /
`ownEvents()` 三者现带 `@deprecated`，**新调用被禁止**，理由是存储方向要停止在内存里
保留完整事件序列（`packages/core/session/src/index.ts`；决策笔记
`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`）。
上游明确允许既有代码延后迁移（其自身生产代码同样带 `no-deprecated` 豁免），且当前实现
仍完整保留内存序列，故 `session-events.js` **本轮不动**。迁移方向：改用 `session.surface`
的投影读取（`deriveEventMessage` / `surface.nodes`）与显式分页历史读，**不要**再造一个
同步历史访问的别名/包装（上游明文禁止）。这是本插件下一次上游同步的首要技术债。

## 会话格式 V3 适配（harness 0.1.5，2026-09）

0.1.3→0.1.5 把 `SESSION_FORMAT_VERSION` 从 2 升到 3，三处破坏性变更直接命中本插件的压缩事务：

1. **`surfaceOp` 字段改名**：`{op:'replace',start,end}` → `{op:'replace',startSeq,endSeq}`，且会话核心按 `Object.keys(op).length === 3` 精确校验（`packages/core/session/src/surface.ts` `isReplaceOp`）。旧字段名会被 `session.append` 抛 `invalid replace surfaceOp`，事务在提交处失败。`builtin.js` 的 replace 追加已改用新字段名。
2. **表面节点 0 是受保护的 `system/message`**：核心 `assertSystemHeadRewrite` 拒绝任何覆盖节点 0 的 `replace`（除非替换事件本身是恰好覆盖该节点的 `system/message`）。插件四个选区原先都从 `nodes[0]` 起，会被核心直接拒绝、压缩永远无法提交。`region.js` 现用 `dropSystemHead()` 把系统头从每个选区的节点数组里剔除（镜像官方 `compaction-basic` 的 `firstIdx = systemHead(...) ? 1 : 0`）。
3. **`EpochHeader.system` 删除**：系统提示词不再随请求头携带，改由节点 0 的 `system/message` 承载。`summarizer.js` `headerPrefix()` 在请求头无 `system` 时从节点 0 派生文本，保持摘要调用的 KV 前缀对齐。

回归验证：起 0.1.5 实例，跑一轮超过 `autoThresholdTokens` 的对话，确认 `compaction/summary` + `surfaceOp:replace` 提交成功、右下角 surfaceTokens 下降。

## 会话数据模型——本插件往什么里追加

会话是 `SessionEvent` 的**事件溯源、仅追加日志**，是唯一事实来源。LLM 历史从不存储；它**派生**自该日志（`deriveMessages()`）。没有独立的"conversation"对象——轮次、步骤、消息、工具调用、压缩、todo、钩子都是同一日志里的行。（完整词汇与 payload 声明：上游 `docs/persistence-catalog` + `docs/subsystems/persistence`；本仓 `docs/context-management-analysis.md` 有浓缩分析。）

**事件信封**（每行）：`{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。
`seq` 在会话内单调连续（首事件 `seq=0`）。`ignorable` 缺省 = 必需：读到未知*必需*类型的读者必须拒绝重建，而不是静默丢弃。`sourceEventSeqs` / `surfaceOp` **只存在于 surface 事件**。

**Surface 与 log-only。** 0.1.5（V3）起有四种 `type` 是 *surface*——`system/message`、`user/message`、`assistant/message`、`tool/result`——它们是唯一产生 LLM 消息、进入 `deriveMessages()` 的类型，也是唯一允许携带 `surfaceOp` / `sourceEventSeqs` 的类型。其余 `type` 都是 *log-only*：持久且可回放，但从不进入派生历史（`turn/*`、`step/*`、`tool/call`、`compaction/*`、`todo/write`、`hook/*`、`approval/*`，……）。

**落盘。** 每个事件一行 JSONL，默认包裹在拼接的带校验和 zstd 帧中（每个追加批次一帧）；SQLite 后端改存打包的 chunk 行。`SESSION_FORMAT_VERSION = 3`（0.1.5；0.1.3 为 2，V2→V3 迁移把系统提示词落成表面节点 0 的 `system/message`）；后端拒绝任何其它版本。崩溃恢复从不截断：未闭合的 `turn/start` 以合成 `turn/end { reason: { kind: 'interrupted' } }` 闭合。

**dsh-force-compact 追加的内容**（其全部持久效果）：一组 log-only 的事务括号事件——官方路径是 `compaction/*`（如 `compaction/summary`，含 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`），内置路径现在与官方共用同一套 `compaction/*` 词汇（字段形状完全一致，区别仅在 `compactionId` 来源：官方 backend 铸造 vs 内置 `mintCompactionId` 铸造）——它们不带 `surfaceOp`，因此自身从不进入模型历史；随后同步追加一个 **surface `user/message`**，携带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 遮蔽被压缩区间——该 `replace` 才是真正的 surface 替换。两条路径的 `user/message` 均带 `source: { kind: 'plugin', plugin: 'compact', compactionId }`（规范 checkpoint marker，`isCompactCheckpointSource` 据此识别）便于追溯。推理/"思考"是**内容块类型**（`ContentBlock.type === 'reasoning'`），不是事件类型：它存在于 `assistant/message.content` 内（由 `reasoning-delta` 流块 / `reasoning-chunks` 行组装），UI 通过 `toAssistantBlock()` 把它渲染为可折叠区域。

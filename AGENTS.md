# AGENTS.md — dsh-force-compact

本规则适用于 `dsh-force-compact/`，并补充[集合约定](../AGENTS.md)。

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

### 内置引擎（src/engine/builtin.js）

自包含、不依赖官方 `compaction` 服务的完整持久事务：

| 步骤 | 追加的事件 | 说明 |
|------|-----------|------|
| 打开锁 | `compaction/start` | `compactionId`（UUID），`turn`（当前 open turn 号或 null） |
| 摘要生成 | — | 通过 `ctx.llm.stream` 流式生成，受 `maxSummaryTokens` 上限约束；**对齐官方 `compaction-basic`**：注入会话最新请求头中的 `system` 提示词 + `tools` 模式做前缀缓存对齐、三级 target 解析（configured→routed header→agent.options）、`purpose:'compaction'` 标签、完整 StreamChunk 装配（文本/推理/图像/用量）、终止 finish 分类（error/aborted/max-tokens/image 均按 fail-closed 抛错） |
| 收缩门禁 | — | `tokenMeter.estimateMessage` 判定摘要 tokens < 被遮蔽区间 tokens，否则中止 |
| 提交摘要标记 | `compaction/summary` | 记录 `compactionId`、`shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`、**必填** `provider`/`model`、实测 `maxTokens`/`usage`（摘要调用真正观察到的 LLM 封装，而非预调用启发式猜测） |
| Surface 替换 | `user/message` + `surfaceOp:{op:'replace',start,end}` | 带规范的 compact 检查点 source `{kind:'plugin',plugin:'compact',compactionId}`；`sourceEventSeqs` 指向 start+summary+shadowed |
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
| `maxSummaryTokens` | integer (4096–200000) | `4096` | 摘要 LLM 调用的 `maxTokens` 上限；防超长摘要。**下限 4096**（低于 4096 的值读取时自动抬升至 4096） |

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

- 插件的持久效果是**追加到会话日志的压缩事务**——具体形态取决于实际走了哪条引擎：走官方时落 `compaction/*` 系列（`compaction/start`、`compaction/summary`、`compaction/end`）加一个 `surfaceOp:replace` 的 `user/message`；走内置时同样落 `compaction/*` 系列（`compaction/start`、`compaction/summary`、`compaction/end`，字段形状与官方完全一致）加同样形态的 `user/message`。两种事务都以"前置括号事件 + 后置 replace 表面节点"的形式落地。插件不引入 timer 或内存态存储；Host 半部保持是**核心模型请求缝**（`agent/request` / `agent/pre-step`）与 `session/flush` 上的纯 Host 监听器。**另有一个 web client 半部**（`web/client.js`，`package.json` 的 `exports["./client"]` + `dsh.client.platform: web`，经 client module 系统自动组成，无需改 web-app 组合）：仅注册一个 `settings.section`（设置页左侧菜单"强制压缩 / Force Compact"分区，order 30），经 `settingsScope.bind({ namespace: 'falling-ts-force-compact' })` 镜像成 uSES 安全的 `SnapshotStore` 并读写字段（`scope.set`/`scope.unset` 写回 `settings.yaml`），**不**引入 timer、内存态存储或额外订阅；client 半部 `inject: ['slots','locale','settingsScope']`（这三个 client 服务在 client 启动时即可用，与 Host 侧的 `compaction` 运行时依赖不同）。
- **两条压缩引擎**（见上文"双引擎架构"节）：
  - **官方引擎**——`compaction` 服务提供的 `compactNow` / `compactRegion`，由 preset 平面（`include:agent-presets:compaction-basic`）挂载，**是运行时可选依赖**：插件**不**声明 `inject`——profile 层条目在进程启动时激活，彼时 preset 平面尚未挂载该服务，硬 `inject` 会导致 `assertEntriesActivated` 启动断言失败；各压缩路径在事件时经 `findOfficialService`（`engine/backend.js`）按 `compactionMode`（`realm` 先试 `agent.ctx` 再试 `ctx`；`global` 只试 `ctx`）定位。
  - **内置引擎**——`src/engine/builtin.js` 自实现的完整压缩事务，只依赖 `ctx.sessions.append`、`ctx.llm.stream`、`ctx.tokenMeter.estimateMessage`（全部经 `ctx.get` 读取、可缺省、对 `undefined` 做守卫）。它追加**官方命名的 `compaction/*` 事件**（`compaction/start`、`compaction/summary`、`compaction/end`）与 `user/message`(replace)——**复用**官方词汇而非私造 `fc-compact/*`，因为官方类型天生在 `KNOWN_SESSION_EVENT_TYPES` 编目内，重载无需 `ignorable` 标记即可跨 build 持久（详见上文"为什么内置引擎改用官方 `compaction/*` 词汇"一节）。代价是须满足官方全局 `compaction/invariant` 监听器的全部不变量（共享 `compactionId`、owner/turn 一致、`shadowedSeqs` 对齐 `shadowedRange`、`provider`/`model` 必填、无错 `end` 需紧跟 `summary`）。两引擎并存时优先级：官方可达即用官方；官方不可达才落到内置（`builtinEnabled !== false` 且 `agent.session` / `llm.service/stream` 可用）。
- `agents`、`settings`、`tokenMeter`、`commands`、`llm` 都是可选依赖（`ctx.get(...)`，对 `undefined` 做守卫）：`agents` 仅供 `session/flush` 路径（缺少 Agent 是记录日志后跳过）；缺少 `settings` 时所有参数回退到默认值；缺少 `tokenMeter` 时阈值门禁回退到粗略字符估算；缺少 `commands` 时 `/force-compact` 命令不注册（`src/hooks/command.js` 是 no-op）；缺少 `llm` 时内置引擎不可用（官方引擎不受影响）。
- **钩住核心模型请求（`agent/request` / `agent/pre-step`）：** 插件的核心行为是钩住官方模型请求缝，**每次请求模型前**读取设置：
  - **`agent/request`**（围绕冻结调用配置的 Waterfall）——`disableThinking` 为 `true` 时，返回的 `LlmCallConfig` 携带 `reasoningEffort: 'off'`（适配器映射为 `thinking: { type: 'disabled' }`），即**每次模型请求**都关闭思考。监听器 `await next()` 取得机器本会使用的配置，再返回替换值；**不得**在缺少 `next()` 时短路（必须调用 `next()`）。
  - **`agent/pre-step`**（每个模型步骤前的 Waterfall）——通过 `tokenMeter.measure(session).totalTokens` 读取会话上下文总 tokens；当其**≥ `autoThresholdTokens`** 时，返回 `{ kind: 'reject' }` **不发起模型请求**，并按 `retainLatestTokens` 语义选区：**从会话最新条目起按官方 `tokenMeter` 逐节点反向累加 token，直到 ≥ `retainLatestTokens` 停止**；截点之前的**所有条目一次性**通过 `compactRegion` 发往大模型做摘要（原条目被遮蔽/跳过），保留段逐字不变；低于阈值时调用 `next()` 让请求继续。强制压缩失败（无安全区间 / 已活跃）时降级为 `next()`，绝不阻塞请求。
  - 两个参数都**每次请求**通过同步 `settings.get('falling-ts-force-compact')` 读取，因此 `settings.yaml` 的改动在下一次请求即生效。
- **`/force-compact` 斜杠命令（`commands` 服务，可选依赖）：** 通过 `/` 选择执行，其 handler **不发送模型请求**。Agent **空闲**时经 `compactNow`（owner `null`，空闲手动入口）立即压缩（引擎自身区间选择）；**繁忙**时 `compactNow` 被拒绝，handler 排队一个强制标记（`src/hooks/command.js`）。handler 逻辑：
  - 直接调用 compaction 服务的 `compactNow(agent, invocation.signal)`（事件时经 `ctx.get('compaction')` 实时读取；owner `null`，空闲手动入口）压缩会话——空闲时立即生效，使用引擎自身的区间选择。
  - 若 `compactNow` 抛出（Agent 繁忙 / 无安全区间），调用 `queueForceCompact(session.id)` **插入一个 JS 内存标记**（process-local `Map`，无持久态、无 timer），返回 "将在下一个模型步骤强制压缩"。
  - 该标记由 `agent/pre-step` 钩子（`takeForceCompact`）在**下一个模型步骤**读取并**立即消费**：读到强制标记则**跳过 token 阈值门禁**、按 `retainLatestTokens` 语义选区（同上，保留最新 N tokens、头段一次性压缩）并经 `compactRegion` 执行，并返回 `{ kind: 'reject' }` **不再请求模型**——即"再请求钩子中如果读取到强制命令, 立马执行压缩, 不再请求模型"。
- **强制压缩配置（`falling-ts-force-compact` 设置命名空间）：** 当 `settings` 服务挂载时，`apply` 注册 `falling-ts-force-compact` 命名空间（`src/core/settings.js`；`falling-ts-` 前缀防止与其他插件的配置键冲突），九个参数可从 `$DSH_HOME/settings.yaml` 配置（详见上文配置项表格）：
  - `disableThinking`（`boolean`，默认 `true`）——为 `true` 时**每次模型请求**（以及插件自己的摘要调用）携带 `reasoningEffort: 'off'`（适配器映射为 `thinking: { type: 'disabled' }`），即关闭思考。
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
    - `guard.js` —— 每次请求的门禁：`agent/request` 关闭思考（`reasoningEffort: 'off'`）+ `agent/pre-step` 阈值门禁（按 `retainLatestTokens` 保留最新 tokens、头段一次性压缩）+ `/force-compact` 的 process-local 强制标记（`queueForceCompact` / `takeForceCompact`）。
    - `command.js` —— `/force-compact` 斜杠命令（`commands` 服务，可选依赖）：空闲时经 `compactNow` 压缩；繁忙时插入 JS 内存标记。
    - `idle.js` —— 一轮结束强制压缩：`agent/status` 上的 `idle` 监听器，经 `compactNow`（引擎自身区间选择）压缩。
- 每条引擎内部都会做**预提交预览 + 收缩门禁**（各自的 LLM 摘要 + 收缩判定），所以本插件不在持久路径上重复摘要。`engine/checkpoint.js` 本身只做"选区间 + 委派"，不再额外跑一次预览——这是上一版的遗留 bug（曾在此处双重摘要，现已被清理）。
- Monorepo 集成会把它包进 `src/index.ts`，并新增一个真实组合（REAL-composition）测试：启动仅测试用的 `cordis.yml` 并断言持久的摘要节点；本独立产物是 plain JS，无构建步骤。

## 会话数据模型——本插件往什么里追加

会话是 `SessionEvent` 的**事件溯源、仅追加日志**，是唯一事实来源。LLM 历史从不存储；它**派生**自该日志（`deriveMessages()`）。没有独立的"conversation"对象——轮次、步骤、消息、工具调用、压缩、todo、钩子都是同一日志里的行。（完整词汇与 payload 声明：上游 `docs/persistence-catalog` + `docs/subsystems/persistence`；本仓 `docs/context-management-analysis.md` 有浓缩分析。）

**事件信封**（每行）：`{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。
`seq` 在会话内单调连续（首事件 `seq=0`）。`ignorable` 缺省 = 必需：读到未知*必需*类型的读者必须拒绝重建，而不是静默丢弃。`sourceEventSeqs` / `surfaceOp` **只存在于 surface 事件**。

**Surface 与 log-only。** 只有三种 `type` 是 *surface*——`user/message`、`assistant/message`、`tool/result`——它们是唯一产生 LLM 消息、进入 `deriveMessages()` 的类型，也是唯一允许携带 `surfaceOp` / `sourceEventSeqs` 的类型。其余 `type` 都是 *log-only*：持久且可回放，但从不进入派生历史（`turn/*`、`step/*`、`tool/call`、`compaction/*`、`todo/write`、`hook/*`、`approval/*`，……）。

**落盘。** 每个事件一行 JSONL，默认包裹在拼接的带校验和 zstd 帧中（每个追加批次一帧）；SQLite 后端改存打包的 chunk 行。`SESSION_FORMAT_VERSION = 0`——预发布，无迁移；后端拒绝任何其它版本。崩溃恢复从不截断：未闭合的 `turn/start` 以合成 `turn/end { reason: { kind: 'interrupted' } }` 闭合。

**dsh-force-compact 追加的内容**（其全部持久效果）：一组 log-only 的事务括号事件——官方路径是 `compaction/*`（如 `compaction/summary`，含 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`），内置路径现在与官方共用同一套 `compaction/*` 词汇（字段形状完全一致，区别仅在 `compactionId` 来源：官方 backend 铸造 vs 内置 `mintCompactionId` 铸造）——它们不带 `surfaceOp`，因此自身从不进入模型历史；随后同步追加一个 **surface `user/message`**，携带 `surfaceOp: { op: 'replace', start, end }` 遮蔽被压缩区间——该 `replace` 才是真正的 surface 替换。两条路径的 `user/message` 均带 `source: { kind: 'plugin', plugin: 'compact', compactionId }`（规范 checkpoint marker，`isCompactCheckpointSource` 据此识别）便于追溯。推理/"思考"是**内容块类型**（`ContentBlock.type === 'reasoning'`），不是事件类型：它存在于 `assistant/message.content` 内（由 `reasoning-delta` 流块 / `reasoning-chunks` 行组装），UI 通过 `toAssistantBlock()` 把它渲染为可折叠区域。

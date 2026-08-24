# dsh-force-compact

[English](README.md) | 中文

`@falling-ts/dsh-force-compact` 是一个 DSH **Cordis 函数插件**，**钩住官方的核心
模型请求**。每次请求模型前都会读取"强制压缩配置"（`falling-ts-force-compact`）设置：

- 当 `disableThinking` 开启时，在**请求参数中强制关闭思考/推理**；
- 当会话上下文总 tokens 数**达到** `autoThresholdTokens` 时，**不请求模型**，
  而是**强制执行强制压缩**。

此外，插件还在每次会话持久化检查点（`session/flush`）压缩有用历史：拥有自己的
区间选择策略与 LLM 摘要器，并把持久的 surface 变更委托给 `compaction` 服务。

## 工作原理

插件钩住官方的模型请求 Waterfall，使判断发生在**每次模型请求之前**（即"钩住
核心模型请求"的需求），并保留持久化检查点：

- **`agent/request`** —— 围绕冻结调用配置的 Waterfall。当 `disableThinking` 开启时，
  返回的 `LlmCallConfig` 携带 `reasoningEffort: 'off'`，LLM 适配器将其映射为
  `thinking: { type: 'disabled' }`，即进程内**每次模型请求**都关闭思考。设置在此
  （每次请求）读取，因此 `settings.yaml` 的改动在下一次请求即生效。
- **`agent/pre-step`** —— 每个模型步骤之前的 Waterfall。通过 `tokenMeter` 服务
  读取会话**上下文总 tokens 数**；当其**达到或超过** `autoThresholdTokens` 时，
  返回 `{ kind: 'reject' }` **不发起模型请求**，并通过
  `ctx.compaction.compactNow` 执行**强制压缩**（浓缩有用历史，让循环以更小的
  上下文重试）。
- **`session/flush`** —— 一个被等待（awaited）的 `parallel` 持久化检查点。检查点
  会等待所有监听器完成，因此压缩在调用方继续之前就已结束，摘要保证落盘。

支撑模块：

- **`src/request-guard.js`** —— 每次请求的门禁：`agent/request` 关闭思考 +
  `agent/pre-step` 阈值门禁 + 强制压缩。
- **`src/region.js`** —— 插件自己的 head-anchored 区间选择（供检查点路径使用）：
  按 surface 节点数保留最近尾段，并把区间末端对齐到 `user/message` 边界（始终
  是一个平衡边界）。
- **`src/summarizer.js`** —— 插件自己的一次性 LLM 摘要器：回放区间消息，把压缩
  指令作为最后一条 user 消息追加，通过 `ctx.llm` 流式生成，返回浓缩后的检查点。
- **`src/compact.js`** —— 检查点编排器：选区间 → 投影区间消息 → 运行预览 + 收缩
  门禁 → 把持久变更委托给 **`ctx.compaction.compactRegion(start, end, agent,
  signal)`**（权威摘要器）。

```
agent/request(payload, next)              # 每次模型请求
    settings.get("falling-ts-force-compact") -> disableThinking?
        return { ...config, reasoningEffort: "off" }   # 关闭思考

agent/pre-step(payload, next)             # 每个模型步骤之前
    tokenMeter.measure(session).totalTokens >= autoThresholdTokens?
        否  -> next()                      # 让模型请求继续
        是  -> compaction.compactNow(agent, signal)   # 强制压缩
              return { kind: "reject" }    # 本次步骤不请求模型

session/flush(session)                    # 持久化检查点
    agents.get(session.id)                -> 实时 Agent（不存在则跳过）
    region.select(session)                -> {start, end} 或 null（跳过）
    projectRegionMessages()               -> 区间消息
    summarizer.summarize()                -> 预览 + 收缩门禁
    compaction.compactRegion(start, end, agent, signal)
        null   -> 无操作（没有可压缩内容）
        result -> 已将区间压缩为一个摘要节点
```

## 安装

作为可安装 bundle（推荐）：

```sh
# 从 git：
dsh plugin --profile web add github:falling-ts/dsh-force-compact
# 从本地检出：
dsh plugin --profile web add ./dsh-force-compact
```

或从本地检出，以 `--patch` overlay 挂载（不安装）：

```sh
dsh web --patch dsh-force-compact/cordis.patch.yml
```

该层把 `force-compact` 函数插件插入当前组合（composition），不改动默认发布
配置。

## 设置（强制压缩配置）

当 `settings` 服务已挂载（web bundle 通过 `@deepseek-ai/dsh-settings-file` 始终
挂载它）时，插件会注册 `falling-ts-force-compact` 设置命名空间，使两个参数可从
`$DSH_HOME/settings.yaml` 配置（`falling-ts-` 前缀用于防止与其他插件的键冲突）：

| 键 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `disableThinking` | `boolean` | `true` | 为 `true` 时，**每次模型请求**都携带 `reasoningEffort: 'off'`，LLM 适配器将其映射为 `thinking: { type: 'disabled' }`——即请求时关闭提供方的思考/推理。同样作用于插件自己的摘要调用。 |
| `autoThresholdTokens` | `number` | `120000` | 强制压缩触发阈值（单位 tokens）。**在请求模型前**，通过 `tokenMeter` 测量会话上下文总 tokens 数；当其**达到或超过**该值时，**不请求模型**，而是强制执行一次强制压缩。`session/flush` 检查点路径也把它作为触发门禁。 |

`$DSH_HOME/settings.yaml` 示例：

```yaml
falling-ts-force-compact:
  disableThinking: true
  autoThresholdTokens: 120000
```

当 `settings` 服务不存在时，插件回退到同样的默认值，压缩照常进行——设置命名空间
是可选的，绝非硬依赖。

## 行为说明

- **硬依赖：** `compaction` 服务。没有它插件不做任何事（强制压缩路径会降级为
  让请求继续）。
- **可选依赖：** `agents` 服务。仅供 `session/flush` 检查点路径使用；若某次
  flush 触发时 `Agent` 已被注销，插件打印 `no live agent … — skipping` 并跳过
  该检查点。`agent/*` Waterfall 的 payload 直接携带 `Agent`，无需 `agents` 查找。
- **可选依赖：** `settings` 服务。不存在时，两个参数回退到默认值
  （`disableThinking: true`、`autoThresholdTokens: 120000`）。
- **可选依赖：** `tokenMeter` 服务。供 `agent/pre-step` 阈值门禁使用；不存在时，
  门禁回退到对会话 surface 内容的粗略字符估算。
- **每次请求读取设置：** 两个参数都**每次模型请求**读取
  （同步 `settings.get('falling-ts-force-compact')`），因此 `settings.yaml` 的改动在下一次
  请求即生效，无需重启。
- **信号（signal）：** `agent/*` Waterfall 转发当前 turn 的 signal；
  `session/flush` 检查点每次 flush 新建一个 `AbortController`。

## 已知限制

- 插件在**持久化检查点**（`session/flush`）时压缩，此时 `Agent` 可能尚未被
  注销。如果你的部署在最后一次 flush 之前就注销了 `Agent`，最后一次压缩可能被
  跳过；若该时序对你重要，可改为监听 `agent/disposed`（其 payload 直接携带
  `Agent`）。
- 插件自己的摘要器是**预提交预览 + 收缩门禁**；持久摘要内容由 `compaction`
  服务权威生成。
- 强制压缩门禁在达到阈值时**拒绝所提议的模型步骤**，随后依赖循环以更小的
  上下文重试。若 `compactNow` 找不到安全区间（例如已无可压缩的有用内容），
  则让请求按原样继续，而非循环。
- 不注册任何 client/browser UI；插件是纯 Host 插件。两个参数可通过
  `falling-ts-force-compact` 设置命名空间调参（未来某个动态 client 插件可读取它
  来提供设置页面），并可通过 `[force-compact]` 日志行与持久日志观察。

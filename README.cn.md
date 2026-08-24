# dsh-force-compact

[English](README.md) | 中文

`@falling-ts/dsh-force-compact` 是一个 DSH **Cordis 函数插件**，在每次会话
持久化检查点（`session/flush`）时压缩该会话中有用的历史。它拥有自己的区间选择
策略与 LLM 摘要器，并把持久的 surface 变更委托给 `compaction` 服务。

## 工作原理

- 监听 **`session/flush`** —— 一个被等待（awaited）的 `parallel` 持久化检查点。
  检查点会等待所有监听器完成，因此压缩在调用方继续之前就已结束，摘要保证落盘。
- 通过 `agents` 服务解析该会话的实时 `Agent`。
- **`src/region.js`** —— 插件自己的 head-anchored 区间选择：按 surface 节点数
  保留最近尾段，并把区间末端对齐到 `user/message` 边界（始终是一个平衡边界）。
- **`src/summarizer.js`** —— 插件自己的一次性 LLM 摘要器：回放区间消息，把压缩
  指令作为最后一条 user 消息追加，通过 `ctx.llm` 流式生成，返回浓缩后的检查点。
- **`src/compact.js`** —— 编排器：选区间 → 投影区间消息 → 运行预览 + 收缩门禁
  → 把持久变更委托给 **`ctx.compaction.compactRegion(start, end, agent,
  signal)`**（权威摘要器）。

```
session/flush(session)
   └─ session.id
   └─ agents.get(session.id)          → 实时 Agent（不存在则跳过）
   └─ src/compact.js
        ├─ region.select(session)     → {start, end} 或 null（跳过）
        ├─ projectRegionMessages()    → 区间消息
        ├─ summarizer.summarize()     → 预览 + 收缩门禁
        └─ compaction.compactRegion(start, end, agent, signal)
             ├─ null  → 无操作（没有可压缩内容）
             └─ result → 已将区间压缩为一个摘要节点
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
挂载它）时，插件会注册 `force-compact` 设置命名空间，使两个参数可从
`$DSH_HOME/settings.yaml` 配置：

| 键 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `disableThinking` | `boolean` | `true` | 为 `true` 时，插件的摘要请求携带 `reasoningEffort: 'off'`，LLM 适配器将其映射为 `thinking: { type: 'disabled' }`——即压缩摘要调用时关闭提供方的思考/推理。 |
| `autoThresholdTokens` | `number` | `120000` | 自动压缩触发阈值（单位 tokens）。仅当会话估算总上下文**达到或超过**该值时才压缩；低于该值时跳过该检查点。 |

`$DSH_HOME/settings.yaml` 示例：

```yaml
force-compact:
  disableThinking: true
  autoThresholdTokens: 120000
```

当 `settings` 服务不存在时，插件回退到同样的默认值，压缩照常进行——设置命名空间
是可选的，绝非硬依赖。

## 行为说明

- **硬依赖：** `compaction` 服务。没有它插件不做任何事。
- **可选依赖：** `agents` 服务。若某次 flush 触发时会话的 `Agent` 已被注销，
  插件会打印 `no live agent … — skipping` 并跳过该检查点。
- **可选依赖：** `settings` 服务。不存在时，两个参数回退到默认值。
- **信号（signal）：** 压缩在检查点上是 fire-and-forget；每次 flush 新建一个
  `AbortController`。

## 已知限制

- 插件在**持久化检查点**（`session/flush`）时压缩，此时 `Agent` 可能尚未被
  注销。如果你的部署在最后一次 flush 之前就注销了 `Agent`，最后一次压缩可能被
  跳过；若该时序对你重要，可改为监听 `agent/disposed`（其 payload 直接携带
  `Agent`）。
- 插件自己的摘要器是**预提交预览 + 收缩门禁**；持久摘要内容由 `compaction`
  服务权威生成。
- 不注册任何 client/browser UI；插件是纯 Host 插件。两个参数可通过
  `force-compact` 设置命名空间调参（未来某个动态 client 插件可读取它来提供
  设置页面），并可通过 `[force-compact]` 日志行与持久日志观察。

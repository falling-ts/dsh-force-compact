# Session Auto-Compact（会话自动压缩）

[English](README.md) | 中文

`@falling-ts/dsh-compact` 是一个 DSH **Cordis 函数插件**，在每次会话
持久化检查点（`session/flush`）时，把该会话中有用的历史自动压缩为一个摘要
节点。当会话的缓冲事件即将落盘时，插件把可压缩的区间做摘要，使持久日志保持
精简。

## 工作原理

- 监听 **`session/flush`** —— 一个被等待（awaited）的 `parallel` 持久化检查点。
  检查点会等待所有监听器完成，因此压缩在调用方继续之前就已结束，摘要保证落盘。
- 通过 `agents` 服务解析该会话的实时 `Agent`，并调用
  **`compaction.compactNow(agent)`**——即使低于自动压力阈值，也会强制压缩有用
  的历史。
- 返回 `null` 表示无操作（没有可压缩的有用区间），因此重复的 flush 是安全的；
  `compaction` 服务还会阻止同一会话的并发压缩。

```
session/flush(session)
   └─ session.id
   └─ agents.get(session.id)          → 实时 Agent（不存在则跳过）
   └─ compaction.compactNow(agent)
        ├─ null  → 无操作（没有可压缩内容）
        └─ result → 已将有用区间压缩为一个摘要节点
```

## 安装

作为可安装 bundle（推荐）：

```sh
# 从 git：
dsh plugin --profile web add github:falling-ts/dsh-compact
# 从本地检出：
dsh plugin --profile web add ./dsh-compact
```

或从本地检出，以 `--patch` overlay 挂载（不安装）：

```sh
dsh web --patch dsh-compact/cordis.patch.yml
```

该层把 `auto-compact` 函数插件插入当前组合（composition），不改动默认发布
配置。

## 行为说明

- **硬依赖：** `compaction` 服务。没有它插件不做任何事。
- **可选依赖：** `agents` 服务。若某次 flush 触发时会话的 `Agent` 已被注销，
  插件会打印 `no live agent … — skipping` 并跳过该检查点。
- **信号（signal）：** 压缩是 fire-and-forget，因此不传取消信号。

## 已知限制

- 插件在**持久化检查点**（`session/flush`）时压缩，此时 `Agent` 可能尚未被
  注销。如果你的部署在最后一次 flush 之前就注销了 `Agent`，最后一次压缩可能被
  跳过；若该时序对你重要，可改为监听 `agent/disposed`（其 payload 直接携带
  `Agent`）。
- 不注册任何 client/browser UI；插件是纯 Host 插件，只能通过 `[auto-compact]`
  日志行与持久日志观察。

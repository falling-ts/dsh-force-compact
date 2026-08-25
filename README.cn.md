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
- **默认关闭思考。** `disableThinking: true` 对**每一次出站调用**(业务请求 + 插件自己的摘要
  调用)都关闭模型的内部推理努力,并在两个互补缝上双重保障(见下文「后端无关的思考控制」)。
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

### 后端无关的思考控制

`disableThinking` 在**两个互补的缝**上强制执行:

1. **请求缝** —— `reasoningEffort:'off'` → DeepSeek 适配器序列化为
   `thinking:{type:'disabled'}`(真 DeepSeek API 认这个字段)。
2. **wire 缝(`llm/stream`)** —— 插件在序列化后追加顶层 `reasoning_effort:"none"`,llama.cpp
   的 OpenAI 兼容层原生解析(`server-common.cpp` 映射到 `enable_thinking=false`,与模板能力
   无关)。真 DeepSeek 端点忽略未知键。

结果:在任何后端(包括本地 llama.cpp)上都**确实关闭了思考**,不依赖目标嗅探启发式而漏判路由。

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
    disableThinking? -> { ...config, reasoningEffort: "off" }

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

- `src/hooks/guard.js` —— 每请求门禁:关思考 + 阈值门 + 强制标记。
- `src/hooks/command.js` —— `/force-compact` 命令。
- `src/hooks/idle.js` —— 回合结束强制压缩。
- `src/hooks/wire-rewrite.js` —— `llm/stream` wire 补丁,追加 `reasoning_effort:"none"`。
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
```

---

## 配置

`$DSH_HOME/settings.yaml`,命名空间 `falling-ts-force-compact`:

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

## License

MIT(见 LICENSE)。

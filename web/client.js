/**
 * force-compact 设置分区的浏览器半部（settings.section）。
 *
 * 这是一个闭包工厂 artifact：调用 window.__ModuleLoader__.load({ id, factory })，
 * factory(require) 通过注入的 require 解析外部模块（这里只有基线 react），并返回
 * 插件面 { name, inject, apply }。宿主半部（根 index.js）与本文件是同一 package
 * 的两个面：宿主半部由 main 入口加载，本文件由 exports["./client"] 导出，经
 * dsh.client 声明被 client module 系统自动组成并服务（/plugins/<id>/client.js）。
 *
 * 该分区通过 settingsScope 读写宿主侧 falling-ts-force-compact 设置命名空间
 * （disableThinking / autoThresholdTokens / retainLatestTokens /
 * turnEndForceCompactionEnabled），并在设置页左侧菜单注册 "强制压缩" 分区。
 * 纯展示 + 写回，不引入 timer、内存态存储或额外订阅。
 */
window.__ModuleLoader__.load({
  id: "@falling-ts/dsh-force-compact",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
    // 基线外部（web 平台预载）：把 settingsScope 镜像成 uSES 安全的 SnapshotStore。
    // `createSnapshotStore` 的正确来源是 PLATFORM_MODULES seed 表内的静态包
    // `@deepseek-ai/dsh-client-store`；`@deepseek-ai/dsh-client-runtime` 不在共享模块表
    // 里，require 它会命中 client-modules 的 "missed the module table" 落空错误。
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    /** 该分区拥有的文案命名空间。 */
    const NS = "settings.forceCompact";
    /** 宿主侧 force-compact 设置命名空间（settings.get 读取的键）。 */
    const NS_SETTINGS = "falling-ts-force-compact";

    const zh = {
      nav: "强制压缩",
      intro: "控制 force-compact 插件的压缩行为（强制压缩配置）。改动在 $DSH_HOME/settings.yaml 的 falling-ts-force-compact 段生效。",
      disableThinking: "压缩时关闭思考",
      disableThinkingHint: "为 true 时每次模型请求携带 reasoningEffort: off，关闭思考以节省 token。",
      autoThresholdTokens: "自动压缩阈值（tokens）",
      autoThresholdTokensHint: "会话总上下文 tokens ≥ 该值时，agent/pre-step 阈值门禁触发强制压缩。最小 32000；若填低于此值会自动重置为 32000。",
      retainLatestTokens: "保留最新上下文（tokens）",
      retainLatestTokensHint: "自动/强制压缩时，从会话最新条目往前累加 token（按官方 tokenMeter 逐节点计数），直到 ≥ 该值停止；该截点之前的所有条目一次性发往大模型做摘要（原条目被遮蔽/跳过），保留的尾部逐字保留。默认 8000；最小 8000，若填低于此值会自动重置为 8000。",
      turnEndForceCompaction: "回合结束强制压缩",
      turnEndForceCompactionHint: "为 true 时，agent 转入 idle（一轮结束）时执行一轮结束压缩。",
      debug: "详细日志（debug）",
      debugHint: "为 true 时，每次模型请求/步骤的关键观察行都会写入 logFile（默认 ~/.dsh/logs/dsh-force-compact.log）。生产环境可设为 false 减少噪音。",
      logFile: "日志文件路径",
      logFileHint: "详细日志的目标文件路径（leading ~ 展开为用户家目录）。修改后下次启动生效。",
      logFilePlaceholder: "~/.dsh/logs/dsh-force-compact.log",
      compactionMode: "压缩服务解析模式",
      compactionModeHint: "realm：优先从当前 Agent 域查找 compaction 服务，再回落全局。global：直接使用全局 compaction 服务（需后端已挂到 root realm）。",
      modeRealm: "realm（域优先）",
      modeGlobal: "global（全局）",
      builtinEnabled: "内置压缩引擎",
      builtinEnabledHint: "官方 compaction 服务不可达时（例如标准 preset 将其隔离进 isolate 组），启用插件自研的内置压缩引擎作为后备。默认开启。设为 false 严格只走官方。",
      maxSummaryTokens: "最大摘要数（tokens）",
      maxSummaryTokensHint: "插件自身摘要 LLM 调用的 maxTokens 上限（默认 1024，1024–200000），防止摘要长度失控；收缩门禁另行保证提交的摘要比被遮蔽区间小。最小 1024，若填低于此值会自动重置为 1024。",
      unavailable: "设置不可用",
      loading: "加载中…",
      notWritable: "（当前为只读/内存模式，改动仅本进程生效）",
      onWord: "开",
      offWord: "关",
    };
    const en = {
      nav: "Force Compact",
      intro: "Control how the force-compact plugin compacts. Changes land under the falling-ts-force-compact section of $DSH_HOME/settings.yaml.",
      disableThinking: "Disable thinking during compaction",
      disableThinkingHint: "When true, every model request carries reasoningEffort: off to save tokens.",
      autoThresholdTokens: "Auto-compaction threshold (tokens)",
      autoThresholdTokensHint: "When the session's total context tokens ≥ this value, the agent/pre-step threshold gate force-compacts. Minimum 32000; values below are clamped back to 32000.",
      retainLatestTokens: "Retain latest context (tokens)",
      retainLatestTokensHint: "When auto/forced compaction fires, walk backward from the LATEST surface entry accumulating per-node tokens (the official tokenMeter's prices) until the running sum REACHES OR EXCEEDS this budget; everything before that cutoff is sent to the summarizer in ONE batch (its entries become shadowed/skipped in derived history), and the retained tail stays VERBATIM. Default 8000; minimum 8000 — values below are clamped back to 8000.",
      turnEndForceCompaction: "Force-compaction at turn end",
      turnEndForceCompactionHint: "When true, run a turn-end compaction when the agent becomes idle.",
      debug: "Verbose logging (debug)",
      debugHint: "When true, per-request/step observation lines are appended to logFile (default ~/.dsh/logs/dsh-force-compact.log). Turn off in production to reduce noise.",
      logFile: "Log file path",
      logFileHint: "Destination for verbose logs (leading ~ expands to the user home). Takes effect on the next restart.",
      logFilePlaceholder: "~/.dsh/logs/dsh-force-compact.log",
      compactionMode: "Compaction-service resolution mode",
      compactionModeHint: "realm: locate the compaction service in the current Agent's realm first, falling back to global. global: use the global compaction service directly (requires the backend to be mounted at the root realm).",
      modeRealm: "realm (realm-first)",
      modeGlobal: "global (global)",
      builtinEnabled: "Built-in compaction engine",
      builtinEnabledHint: "Fallback to this plugin's own self-contained engine when the official compaction service is unreachable (e.g. standard-preset realm isolation). Defaults on. Set false to strictly use only the official backend.",
      maxSummaryTokens: "Max summary size (tokens)",
      maxSummaryTokensHint: "maxTokens ceiling on the plugin's own summarization LLM call (default 1024, range 1024–200000). Prevents runaway summaries; the shrink gate separately guarantees the committed summary is smaller than the span it replaces. Minimum 1024 — values below are clamped back to 1024.",
      unavailable: "Settings unavailable",
      loading: "Loading…",
      notWritable: "(read-only / memory mode; changes are process-local)",
      onWord: "on",
      offWord: "off",
    };

    /** 必需服务（cordis fiber inject）。settingsScope 由 ui-settings 提供。 */
    const inject = ["slots", "locale", "settingsScope"];

    // ── 视觉设计 ----------------------------------------------------------------
    // 参照通用设置分区（如「语言」）的排版：扁平、无背景色、行间细分隔线、
    // 紧凑纵向节奏；三栏网格 label（定宽一列）· control（右对齐一列）· hint，
    // label 与 hint 同列同字体纵向对齐，control 靠右，数值输入框等宽中性描边。
    const divider = "rgba(0,0,0,0.08)";
    const hintColor = "rgba(0,0,0,0.45)";
    const mutedColor = "rgba(0,0,0,0.55)";
    const gridCols = "172px 140px minmax(0,1fr)";
    const wrapStyle = { padding: "4px 0" };
    const titleStyle = { margin: "2px 0 2px", fontSize: 15, lineHeight: 1.4 };
    const introStyle = { margin: "0 0 6px", color: hintColor, lineHeight: 1.65, fontSize: 13, maxWidth: 680 };
    const rowStyle = { display: "grid", gridTemplateColumns: gridCols, columnGap: 16, rowGap: 5, padding: "13px 0", borderBottom: "1px solid " + divider, alignItems: "center" };
    const lastRowStyle = { ...rowStyle, borderBottom: "none" };
    const labelStyle = { fontSize: 13.5, fontWeight: 500, lineHeight: 1.35 };
    const controlStyle = { display: "flex", justifyContent: "flex-end", alignItems: "center" };
    const hintStyle = { gridColumn: "1 / 3", gridRow: 3, color: hintColor, fontSize: 12, lineHeight: 1.55 };
    const inputStyle = { width: 128, textAlign: "right", padding: "5px 10px", boxSizing: "border-box", border: "1px solid rgba(0,0,0,0.22)", borderRadius: 6, fontVariantNumeric: "tabular-nums", backgroundColor: "transparent", outline: "none", fontSize: 13 };
    // 精致的 Switch：更缓动的位移动画（cubic-bezier），开态用品牌蓝→亮青渐变
    // + 轻微外发光，滑块白色带双层阴影；悬停时外圈高亮提示可点。
    const brandGrad = "linear-gradient(90deg,#2f6bff 0%,#3d8bff 100%)";
    const springEase = "transform .22s cubic-bezier(.34,1.4,.64,1), box-shadow .22s ease";
    const switchOuter = (disabled) => ({
      position: "relative",
      display: "inline-block",
      padding: 4,
      borderRadius: 999,
      cursor: disabled ? "default" : "pointer",
      transition: "box-shadow .18s ease, background .18s ease",
      outline: "none",
    });
    const switchTrack = (on, hovered, disabled) => ({
      position: "relative",
      display: "block",
      width: 40,
      height: 22,
      borderRadius: 999,
      transition: "background .22s ease, box-shadow .22s ease",
      background: on ? brandGrad : (hovered && !disabled ? "rgba(0,0,0,0.24)" : "rgba(0,0,0,0.16)"),
      boxShadow: on ? "inset 0 0 0 1px rgba(255,255,255,0.12), 0 0 10px rgba(47,107,255,0.35)" : "inset 0 1px 2px rgba(0,0,0,0.12)",
      opacity: disabled ? 0.5 : 1,
    });
    // 不做 scale（同滑块理由：scale+translate 叠加会漂移）。悬停/开态只用阴影+边框表达。
    const switchKnob = (on, hovered, disabled) => ({
      position: "absolute",
      top: 3,
      left: 3,
      width: 16,
      height: 16,
      borderRadius: "50%",
      backgroundColor: "#fff",
      boxShadow: (hovered && !disabled)
        ? "0 1px 3px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(0,0,0,0.08)"
        : "0 1px 2px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.06)",
      transform: on ? "translateX(18px)" : "translateX(0px)",
      transition: springEase,
      pointerEvents: "none",
    });
    const disabledHintStyle = { marginTop: 12, color: hintColor, fontSize: 12.5, marginBottom: 8 };

    /**
     * 精致的 Switch（布尔控件）。外层 button 负责更大的可点热区与 hover 高亮，
     * 内层绘制 track 渐变 + 白色滑块位移动画。支持键盘（Enter/Space 切换）。
     * @param props - { on: boolean, disabled: boolean, onChange(next:boolean) }
     */
    function SwitchButton(props) {
      const { on, disabled, onChange } = props;
      const [hovered, setHovered] = React.useState(false);
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": !!on,
        disabled: !!disabled,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onClick: () => { if (!disabled) onChange(!on); },
        onKeyDown: (e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) { e.preventDefault(); onChange(!on); }
        },
        style: switchOuter(disabled),
        tabIndex: disabled ? -1 : 0,
      },
        h("span", { style: switchTrack(on, hovered, disabled) },
          h("span", { style: switchKnob(on, hovered, disabled) })));
    }

    /**
     * 字符串草稿编辑：类似 useDraftNumber，但针对自由文本（这里是 logFile 路径）。
     * 途中随便打都不写回；失焦/回车时才一次性写回（trim 后空串视为清空）。
     * @returns [draftValue, handlers]
     */
    function useDraftText(key, currentValue, update) {
      const [buf, setBuf] = React.useState(currentValue === undefined ? "" : String(currentValue));
      const focusedRef = React.useRef(false);
      React.useEffect(() => {
        if (!focusedRef.current) {
          setBuf(currentValue === undefined ? "" : String(currentValue));
        }
      }, [currentValue]);
      const commit = () => {
        focusedRef.current = false;
        const trimmed = buf.trim();
        if (trimmed === "") { update(key, undefined); setBuf(""); return; }
        update(key, trimmed);
      };
      const handlers = {
        onFocus: () => { focusedRef.current = true; },
        onChange: (e) => setBuf(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === "Enter") { e.currentTarget.blur(); } },
      };
      return [buf, handlers];
    }

    /** 比例范围常量：自动/强制压缩最早比例均 0.01–1。 */
    const RATIO_MIN = 0.01;
    const RATIO_MAX = 1;


    /**
     * 两选项分段控制器（segmented control）：两个 pill 按钮左右排列，选中项
     * 反白高亮、未选中呈浅灰边框。用于 compactionMode（realm / global）。
     * @param props - { value, options: [{id,label}], onChange(id) }
     */
    function SegmentedPicker(props) {
      const { value, options, onChange, disabled } = props;
      const selected = (id) => value === id;
      const btnBase = {
        appearance: "none", border: "none", padding: 0, background: "none",
        cursor: disabled ? "default" : "pointer", fontSize: 12.5, lineHeight: 1.4,
      };
      const pills = options.map((o) => {
        const sel = selected(o.id);
        const style = {
          ...btnBase,
          padding: "5px 12px",
          borderRadius: 999,
          border: sel ? "1px solid rgba(47,107,255,0.7)" : "1px solid rgba(0,0,0,0.18)",
          background: sel ? "linear-gradient(90deg,#2f6bff 0%,#3d8bff 100%)" : "transparent",
          color: sel ? "#ffffff" : "rgba(0,0,0,0.65)",
          boxShadow: sel ? "0 0 8px rgba(47,107,255,0.35)" : "none",
          opacity: disabled ? 0.5 : 1,
          transition: "color .18s ease, background .18s ease, border-color .18s ease, box-shadow .18s ease",
          minWidth: 84,
          textAlign: "center",
          whiteSpace: "nowrap",
        };
        return h("button", {
          type: "button",
          key: o.id,
          role: "radio",
          "aria-checked": sel,
          disabled: disabled,
          style,
          onClick: () => { if (!disabled) onChange(o.id); },
          onKeyDown: (e) => { if (e.key === "Enter" && !disabled) { e.preventDefault(); onChange(o.id); } },
          tabIndex: sel ? 0 : -1,
        }, o.label);
      });
      return h("div", { role: "radiogroup", style: { display: "inline-flex", gap: 8 } }, pills);
    }

    /**
     * 数字草稿编辑：用本地 buffer 缓存输入，途中随便打（含空串、小数点、负号）
     * 都不写回；失焦/回车时把合法数值一次性写回（clamp 到 [min,max]），非法则
     * 还原为当前值。彻底解决“每次击键都被当作最终值立刻写回导致输不进”。
     * @returns [draftValue, handlers] —— draftValue 供 input.value；handlers 供 input。
     */
    function useDraftNumber(key, currentValue, opts, update) {
      const [buf, setBuf] = React.useState(currentValue === undefined ? "" : String(currentValue));
      // 外部值变化（例如别的入口改了）且本框未在编辑时，同步缓冲区。
      const focusedRef = React.useRef(false);
      React.useEffect(() => {
        if (!focusedRef.current) {
          setBuf(currentValue === undefined ? "" : String(currentValue));
        }
      }, [currentValue]);
      const clamp = (n) => {
        let x = n;
        if (opts.min !== undefined && x < opts.min) x = opts.min;
        if (opts.max !== undefined && x > opts.max) x = opts.max;
        return x;
      };
      const commit = () => {
        focusedRef.current = false;
        const trimmed = buf.trim();
        if (trimmed === "") { update(key, undefined); setBuf(""); return; }
        const n = Number(trimmed);
        if (Number.isNaN(n)) { setBuf(currentValue === undefined ? "" : String(currentValue)); return; }
        const c = clamp(n);
        update(key, c);
        setBuf(String(c));
      };
      const handlers = {
        onFocus: () => { focusedRef.current = true; },
        onChange: (e) => setBuf(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === "Enter") { e.currentTarget.blur(); } },
        inputMode: "decimal",
      };
      return [buf, handlers];
    }

    /**
     * 在 `useDraftNumber` 之上再套一层「硬性 floor」：commit 时把数值先 clamp
     * 到 [hardFloor, opts.max]（忽略 opts.min，改用传入的硬下界），并把钳位后的
     * 值同时写回 store——即使另一入口绕过表单写入 sub-floor 值，下一次 blur
     * 也会把它拉回 floor。用于带最小值的 token 尺度参数。
     * @param {string} key
     * @param {*} currentValue 当前 store 中的值。
     * @param {{ step?: number, min?: number, max?: number }} opts 步进与上下界提示。
     * @param {(k:string,v:any)=>void} update 底层写回函数。
     * @param {number} hardFloor 不可逾越的下限（提交时向上 clamp）。
     * @returns [draftValue, handlers]
     */
    function useDraftNumberClamped(key, currentValue, opts, update, hardFloor) {
      const [buf, setBuf] = React.useState(currentValue === undefined ? "" : String(currentValue));
      const focusedRef = React.useRef(false);
      React.useEffect(() => {
        // External drift (another tab / programmatic write) re-syncs the buffer
        // ONLY when we are not mid-edit, mirroring the unclamped twin.
        if (!focusedRef.current) {
          setBuf(currentValue === undefined ? "" : String(currentValue));
        }
      }, [currentValue, hardFloor]);
      const clampToFloor = (n) => {
        let x = n;
        if (x < hardFloor) x = hardFloor;
        if (opts.max !== undefined && x > opts.max) x = opts.max;
        return x;
      };
      const commit = () => {
        focusedRef.current = false;
        const trimmed = buf.trim();
        if (trimmed === "") { update(key, undefined); setBuf(""); return; }
        const n = Number(trimmed);
        if (Number.isNaN(n)) { setBuf(currentValue === undefined ? "" : String(currentValue)); return; }
        const c = clampToFloor(n);
        update(key, c);
        setBuf(String(c));
      };
      const handlers = {
        onFocus: () => { focusedRef.current = true; },
        onChange: (e) => setBuf(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === "Enter") { e.currentTarget.blur(); } },
        inputMode: "decimal",
      };
      return [buf, handlers];
    }

    /** 比例滑块的几何与外观常量。 */
    const SLIDER_W = 200;      // 轨道宽度（px）
    const SLIDER_H = 4;        // 轨道条高度
    const KNOB_D = 18;         // 旋钮直径
    const SLIDER_BOX_H = KNOB_D + 8; // 命中盒高度
    const KNOB_TRAVEL = SLIDER_W - KNOB_D; // 旋钮左缘位移上限（保持圆钮落在轨道内）
    const TRACK_TOP = (SLIDER_BOX_H - SLIDER_H) / 2; // 轨道条垂直居中
    const KNOB_TOP = (SLIDER_BOX_H - KNOB_D) / 2;    // 旋钮垂直居中
    const sliderFill = (pct) => ({
      position: "absolute",
      left: 0,
      top: TRACK_TOP,
      height: SLIDER_H,
      borderRadius: 999,
      background: "linear-gradient(90deg,rgba(47,107,255,0.5) 0%,#2f6bff 100%)",
      width: (KNOB_D / 2) + KNOB_TRAVEL * pct, // 从轨道中线到旋钮中心的填充
      transition: "width .05s linear",
    });
    // 注意：不做 scale 放大——scale 与 translateX 作为独立变换叠加会在悬停/拖动时
    // 沿 X 额外推移圆钮导致“漂浮”。只用颜色/阴影表达状态，位置恒稳。
    const sliderKnob = (pct, dragging, hovered) => ({
      position: "absolute",
      top: KNOB_TOP,
      left: 0,
      width: KNOB_D,
      height: KNOB_D,
      borderRadius: "50%",
      backgroundColor: "#fff",
      border: "2px solid " + (dragging ? "#2f6bff" : "#3b74ff"),
      boxShadow: dragging
        ? "0 3px 10px rgba(47,107,255,0.5)"
        : (hovered ? "0 2px 6px rgba(47,107,255,0.4)" : "0 1px 3px rgba(0,0,0,0.3)"),
      transform: "translateX(" + (KNOB_TRAVEL * pct) + "px)",
      transition: "transform .06s linear, box-shadow .15s ease, border-color .15s ease",
      cursor: "inherit",
      pointerEvents: "none",
    });

    /** 把比例 0.01–1 换算成归一化占比 0–1，反之亦然。 */
    function ratioToNorm(v) { return Math.max(0, Math.min(1, (v - RATIO_MIN) / (RATIO_MAX - RATIO_MIN))); }
    function normToRatio(p) { return RATIO_MIN + p * (RATIO_MAX - RATIO_MIN); }
    function round2(n) { return Math.round(n * 100) / 100; }

    /**
     * 比例拖动滑块：把 0.01–1 的比例映射为一条可拖动的横向滑轨。
     * 指针事件（pointerdown/move/up，window 级监听跨出边界仍跟手）驱动，
     * 拖动途中每帧即时预览、抬起时一次性写回（round2）；另支持方向键 ±0.01。
     * @returns { trackRef, val, pct, dragging, trackNode }
     */
    function useDragRatio(key, currentVal, update) {
      const trackRef = React.useRef(null);
      const [livePct, setLivePct] = React.useState(undefined);
      const [dragging, setDragging] = React.useState(false);
      const [hovered, setHovered] = React.useState(false);

      const shownVal = livePct !== undefined ? normToRatio(livePct) : (currentVal == null ? RATIO_MIN : currentVal);
      const pct = livePct !== undefined ? livePct : ratioToNorm(shownVal);

      function xToNorm(clientX) {
        const el = trackRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0) return null;
        const x = Math.max(0, Math.min(r.width, clientX - r.left));
        return x / r.width;
      }
      function beginDrag(e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        setDragging(true);
        const p0 = xToNorm(e.clientX);
        if (p0 != null) setLivePct(p0);
        const onMove = (ev) => { const m = xToNorm(ev.clientX); if (m != null) setLivePct(m); };
        const onUp = (ev) => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          const fin = xToNorm(ev.clientX);
          if (fin != null) update(key, round2(normToRatio(fin)));
          setDragging(false);
          setLivePct(undefined);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }
      function handleKey(e) {
        const base = currentVal == null ? RATIO_MIN : currentVal;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
          e.preventDefault();
          update(key, round2(Math.max(RATIO_MIN, base - 0.01)));
        } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
          e.preventDefault();
          update(key, round2(Math.min(RATIO_MAX, base + 0.01)));
        }
      }

      const trackNode = h("div", {
        ref: trackRef,
        onPointerDown: beginDrag,
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => setHovered(false),
        onKeyDown: handleKey,
        tabIndex: 0,
        role: "slider",
        "aria-valuemin": RATIO_MIN,
        "aria-valuemax": RATIO_MAX,
        "aria-valuenow": shownVal,
        style: {
          position: "relative",
          width: SLIDER_W,
          height: KNOB_D + 8,
          display: "inline-block",
          cursor: dragging ? "grabbing" : "pointer",
          touchAction: "none",
          userSelect: "none",
          outline: "none",
        },
      },
        h("div", { style: { position: "absolute", left: 0, right: 0, top: TRACK_TOP, height: SLIDER_H, borderRadius: 999, background: "rgba(0,0,0,0.14)" } }),
        h("span", { style: sliderFill(pct) }),
        h("span", { style: sliderKnob(pct, dragging, hovered) }));

      return { trackRef, val: shownVal, pct, dragging, trackNode };
    }

    /**
     * 渲染 force-compact 设置分区的内容列。
     * @param props - 组合后的槽 props：useForceCompact（hooks 分区的可观察源）、update（写回）、t（文案）。
     * @returns 分区内容，或在设置不可用/加载中时的占位。
     */
    function ForceCompactSection(props) {
      const { useForceCompact, update, t } = props;
      const snap = useForceCompact((s) => s);
      const value = snap.value;
      const valOrUndef = (k) => (value && k in value ? value[k] : undefined);
      // 阈值用草稿数字框；「保留最新 tokens」也用草稿数字框（绝对 token 值，非
      // 比例）。所有 hook 都在组件顶部、任何条件返回之前无条件调用，保证 React
      // hooks 顺序恒定（状态切换不改变 hook 数）。
      // 三个 token 尺度参数均带硬性下界：schema 与表单两侧同设同一 floor，
      // 表单提交时再做一次运行时 clamp（防键盘直接键入 sub-floor 值）。
      const thOpt = { step: 1000, min: 32000, max: 1000000 };
      const [thBuf, thHandlers] = useDraftNumberClamped("autoThresholdTokens", valOrUndef("autoThresholdTokens"), thOpt, update, 32000);
      // retainLatestTokens：整 token 值（step 512），范围 8000–1_000_000。
      const rtOpt = { step: 512, min: 8000, max: 1000000 };
      const [rtBuf, rtHandlers] = useDraftNumberClamped("retainLatestTokens", valOrUndef("retainLatestTokens"), rtOpt, update, 8000);
      // 新增三项的可观察源（同样放在顶部无条件调用，保持 hooks 顺序稳定）。
      const lfOpt = { placeholder: t("logFilePlaceholder") };
      const [lfBuf, lfHandlers] = useDraftText("logFile", valOrUndef("logFile"), update);
      // maxSummaryTokens: 数字框，1024–200000，默认 1024。
      const msOpt = { step: 64, min: 1024, max: 200000 };
      const [msBuf, msHandlers] = useDraftNumberClamped("maxSummaryTokens", valOrUndef("maxSummaryTokens"), msOpt, update, 1024);
      const modeOptions = [
        { id: "realm", label: t("modeRealm") },
        { id: "global", label: t("modeGlobal") },
      ];

      const phStyle = { color: hintColor, fontSize: 13, lineHeight: 1.6, margin: "4px 0 0" };
      if (snap.status === "unavailable") {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: phStyle }, t("unavailable")));
      }
      if (snap.status === "loading") {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: introStyle }, t("intro")), h("p", { style: phStyle }, t("loading")));
      }
      // status === "ready"
      if (value === undefined) {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: introStyle }, t("intro")), h("p", { style: phStyle }, t("loading")));
      }
      const disabled = !snap.writable;

      function labelCell(labelKey) {
        return h("span", { style: labelStyle }, t(labelKey));
      }

      function hintCell(hintKey) {
        return h("span", { style: hintStyle }, t(hintKey));
      }

      function booleanRow(key, labelKey, hintKey, isLast) {
        return h("div", { key: key, style: isLast ? lastRowStyle : rowStyle },
          labelCell(labelKey),
          h("span", { style: controlStyle },
            h(SwitchButton, { on: !!value[key], disabled: disabled, onChange: (nv) => update(key, nv) })),
          hintCell(hintKey));
      }

      function numberRow(key, labelKey, hintKey, buf, handlers, opts, isLast) {
        return h("div", { key: key, style: isLast ? lastRowStyle : rowStyle },
          labelCell(labelKey),
          h("span", { style: controlStyle },
            h("input", {
              type: "number",
              value: buf,
              disabled: disabled,
              step: opts.step,
              min: opts.min,
              max: opts.max,
              style: inputStyle,
              ...handlers,
            })),
          hintCell(hintKey));
      }

      // 比例行：左 label（同列宽），中拖动滑块 + 实时百分比，下排 hint。
      // 单独定义三栏模板（中间留给 200px 滑轨），避免共用 140px 窄列造成溢出。
      const ratioGrid = "172px auto minmax(0,1fr)";
      const ratioRowBase = { display: "grid", gridTemplateColumns: ratioGrid, columnGap: 16, rowGap: 5, padding: "13px 0", borderBottom: "1px solid " + divider, alignItems: "start" };
      const sliderValueStyle = { width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 13, color: mutedColor, flexShrink: 0 };
      function ratioRow(labelKey, hintKey, slider, isLast) {
        const base = { ...ratioRowBase, ...(isLast ? { borderBottom: "none" } : {}) };
        return h("div", { style: base },
          h("span", { style: { ...labelStyle, paddingTop: 11 } }, t(labelKey)),
          h("span", { style: { display: "inline-flex", alignItems: "center", gap: 14 } },
            slider.trackNode,
            h("span", { style: sliderValueStyle }, (Math.round(slider.val * 100) / 100) + "")),
          h("span", { style: { gridColumn: "1 / 4", color: hintColor, fontSize: 12, lineHeight: 1.55 } }, t(hintKey)));
      }

      // logFile 文字行：左 label · 中 textarea-ish input · 下排 hint。
      const textRowBase = { display: "grid", gridTemplateColumns: "172px 220px minmax(0,1fr)", columnGap: 16, rowGap: 5, padding: "13px 0", borderBottom: "1px solid " + divider, alignItems: "center" };
      function textRow(labelKey, hintKey, buf, handlers, opts, isLast) {
        const base = { ...textRowBase, ...(isLast ? { borderBottom: "none" } : {}) };
        return h("div", { style: base },
          h("span", { style: labelStyle }, t(labelKey)),
          h("input", {
            type: "text",
            value: buf,
            disabled: disabled,
            placeholder: opts.placeholder || "",
            style: { ...inputStyle, width: 200, textAlign: "left", fontFamily: "var(--mono-font, monospace)", fontSize: 12.5 },
            ...handlers,
          }),
          h("span", { style: { gridColumn: "1 / 3", gridRow: 3, color: hintColor, fontSize: 12, lineHeight: 1.55 } }, t(hintKey)));
      }
      // compactionMode 行：左 label · 中 SegmentedPicker(realm|global) · 下排 hint。
      function modeRow(isLast) {
        const base = { display: "grid", gridTemplateColumns: "172px 260px minmax(0,1fr)", columnGap: 16, rowGap: 5, padding: "13px 0", borderBottom: "1px solid " + divider, alignItems: "center" };
        const b2 = { ...base, ...(isLast ? { borderBottom: "none" } : {}) };
        const modeValue = valOrUndef("compactionMode");
        return h("div", { style: b2 },
          h("span", { style: labelStyle }, t("compactionMode")),
          h("span", { style: { display: "inline-flex", alignItems: "center" } },
            h(SegmentedPicker, { value: modeValue, options: modeOptions, onChange: (id) => update("compactionMode", id), disabled: disabled })),
          h("span", { style: { gridColumn: "1 / 3", gridRow: 3, color: hintColor, fontSize: 12, lineHeight: 1.55 } }, t("compactionModeHint")));
      }
      return h("div", { style: wrapStyle },
          h("h2", { style: titleStyle }, t("nav")),
          h("p", { style: introStyle }, t("intro")),
          h("div", null,
            booleanRow("disableThinking", "disableThinking", "disableThinkingHint", false),
            numberRow("autoThresholdTokens", "autoThresholdTokens", "autoThresholdTokensHint", thBuf, thHandlers, thOpt, false),
            numberRow("retainLatestTokens", "retainLatestTokens", "retainLatestTokensHint", rtBuf, rtHandlers, rtOpt, false),
            booleanRow("turnEndForceCompactionEnabled", "turnEndForceCompaction", "turnEndForceCompactionHint", false),
            booleanRow("debug", "debug", "debugHint", false),
            textRow("logFile", "logFileHint", lfBuf, lfHandlers, lfOpt, false),
            modeRow(false),
            booleanRow("builtinEnabled", "builtinEnabled", "builtinEnabledHint", false),
            numberRow("maxSummaryTokens", "maxSummaryTokens", "maxSummaryTokensHint", msBuf, msHandlers, msOpt, true)),
          disabled ? h("p", { style: disabledHintStyle }, t("notWritable")) : null);
    }

    /**
     * 「Deep diving…」指示器的实时贴皮器（live UI 徽章）。
     *
     * 宿主半部（core/ui-signal.js）在四个时机改写本命名空间的 liveUi 字段：
     *   • 每次出站 LLM 调用开始时——写入 20×20 随机工作态（phase/text/color）；
     *   • 任意一次强制压缩开始前——固定红色「[强制压缩中>>>]」；
     *   • 压缩成功后——固定绿色「[压缩完成!]」；
     *   • 会话结束时（agent 转入 idle，hooks/idle.js）——空字符串 text
     *     （isImportant）：语义是"清空"——抹掉徽章文字、撤掉相位 class，
     *     徽章回到官方外观（取代 2026-09 前"会话开始时强制重绘随机工作态"）。
     * 本函数把该字段的最新值贴到对话区那个 `<div role="status" aria-live="polite">`
     * （官方 `TurnStatus` 组件，"Deep diving…" 所在处）的**第一个文本节点**上，
     * 并按 phase 着色。这是一次**瞬时 DOM 覆盖**：React 的下一帧重绘会自行还原
     * （这正是文档 turn-status-deep-diving-rendering.md §四「临时改文案」描述的
     * 机制），而下一轮 liveUi 变化又会再次贴上来——净效果就是跟随宿主相位持续
     * 显示,无需本地 timer、也无需 MutationObserver 追帧：宿主每次改写都经由
     * settingsScope 镜像到达这里,天然成为我们的"事件时钟"。
     *
     * 定位策略：全页面可能存在多个 role=status 节点（多标签/多会话并存时,每个
     * 打开的 running 会话各有一个 TurnStatus）。我们取**全部**命中的节点逐一贴
     * 上——装饰性的、幂等的、零侵入（不改 className/结构,只动第一个文本子节点
     * 的 nodeValue + 父节点的相位标记属性）。找不到节点则静默 no-op（当前没有
     * running 会话 → 没有指示器 → 无可贴目标,这是预期行为而非错误）。
     *
     * 着色原理：官方 `TurnStatus` 的可见颜色来自 shimmer——
     * `background: linear-gradient` + `background-clip:text` +
     * `color/-webkit-text-fill-color: transparent`（ChatView.module.css
     * .turnStatus）。因此 **inline `style.color` 对它无效**（填充恒为透明,
     * 看到的是背景渐变,不是 color）。唯一可行的覆盖方式是一条高于普通类规则
     * 的选择器（`[role="status"][data-fc-phase]` + `!important`）同时中和四个
     * 属性：`background:none`（撤掉渐变本体）+ `animation:none`（停掉扫光,
     * prefers-reduced-motion 分支下两者皆静态,一并覆盖）+ `color` /
     * `-webkit-text-fill-color` 设为相位色。样式表经 ensurePhaseStyleSheet
     * 按需注入**一次**（head 下首个 <style>,key 前缀 `dsh-fc-` 保证重复插入
     * 时浏览器按内容复用而不产生重复规则）。选择器以 `data-fc-phase="<phase>"`
     * 精确匹配相位值（非存在性通配）,使不同相位的多个 status 节点各自命中各自
     * 的规则、互不干扰；phase 消失（React 重建节点、新 TurnStatus 挂载）后
     * 属性不复存在 → 规则不再命中 → 官方 shimmer 自然恢复。
     *
     * @param liveUi - 宿主写入的 { phase, text, color }；缺省/null 时 no-op；
     *   `text` 为空字符串时执行"清空"（抹掉所贴文本 + 撤相位 class/属性）。
     */
    // ── 扫光配色表：20 个工作态颜色 + 2 个钉住颜色（compressing 红 / done 绿）──
    // 每条对应 web/swish.css 里的 .falling-ts-swish-NN（@keyframes falling-ts-swish-NN），
    // 色值单一事实源在 src/core/ui-signal.js 的 WORKING_COLORS（20 项）与
    // PINNED_COLORS（2 项），此处仅做"hex → 编号"映射，不做任何样式计算。
    // 2026 深色化第二轮：与 src/core/ui-signal.js 的 WORKING_COLORS（20 项）
    // + PINNED_COLORS（2 项：compressing 暗红 / done 暗绿）逐字对应，
    // 索引 0..19 = 工作态，20 = compressing，21 = done。
    const SWISH_HEXES = [
      "#1e40af","#1e3a8a","#312e81","#4c1d95","#581c87",
      "#8318a3","#86198f","#9d174d","#9f1239","#991b1b",
      "#9a3412","#92400e","#854d0e","#4d7c0f","#3f6212",
      "#166534","#065f46","#0e7490","#155e75","#172554",
      "#9b1c2b","#2f6f52",
    ];
    const SWISH_CLASS_PREFIX = "falling-ts-swish-";
    function swishClassForColor(hex) {
      const norm = String(hex || "").trim().toLowerCase();
      const idx = SWISH_HEXES.findIndex(c => c.toLowerCase() === norm);
      // 未识别色 → 回落到第一档（最冷蓝），避免误贴错误相位色
      const slot = idx >= 0 ? idx : 0;
      return SWISH_CLASS_PREFIX + String(slot).padStart(2, "0");
    }
    // 每个 status 节点上次被贴过的文本子节点（node → textChild）。清空
    // （text → ""）之后该子节点变空，"第一个非空文本子节点"搜索再也找不到
    // 它——WeakMap 让锚点在清空后依然存活：下一轮推送直接命中被清空的旧节点
    // 重新贴字；React 重建节点（新 element → Map 未命中）时回落到搜索、重新
    // 捕获 React 的新文本节点。
    const paintedTextChild = new WeakMap();
    function paintTurnStatus(liveUi) {
      if (typeof document === "undefined") return;
      if (!liveUi || typeof liveUi.text !== "string") return;
      // 空 text = "清空"（会话结束推送，hooks/idle.js → ui-signal publishEnd）：
      // 抹掉徽章文字并撤掉相位 class/属性，徽章回到官方外观。
      const color = liveUi.text.length === 0 ? null : (typeof liveUi.color === "string" && liveUi.color !== "" ? liveUi.color : null);
      const nodes = document.querySelectorAll('[role="status"][aria-live="polite"]');
      if (nodes.length === 0) return; // 没有 running 会话 → 没有 TurnStatus
      const targetCls = color !== null ? swishClassForColor(color) : null;
      for (const node of nodes) {
        let textChild = paintedTextChild.get(node) || null;
        // 校验记忆的锚点仍是本节点下存活的文本子节点（React 重渲染后可能已
        // 被换掉/摘下），失配则回落到"第一个非空文本子节点"搜索。
        if (textChild !== null && (textChild.nodeType !== Node.TEXT_NODE || textChild.parentNode !== node)) textChild = null;
        if (textChild === null) {
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim() !== "") { textChild = child; break; }
          }
          if (textChild === null) continue;
        }
        textChild.nodeValue = liveUi.text; // "" → 清空徽章文字
        paintedTextChild.set(node, textChild);
        // class 化：先清掉所有上一轮的 swish class，再贴本次（target 为空时只清不加）。
        for (const cls of [...node.classList]) {
          if (cls.startsWith(SWISH_CLASS_PREFIX)) node.classList.remove(cls);
        }
        // 相位色载体属性：与 swish class 同步贴/撤（`data-fc-bg` 仅在有相位色时
        // 存在，供 CSS 里的文本强调规则取色；属性消失时强调规则失配、自然回落
        // 官方 caption 灰）。
        if (color !== null) {
          node.setAttribute("data-fc-bg", color);
        } else {
          node.removeAttribute("data-fc-bg");
        }
        if (targetCls) node.classList.add(targetCls);
      }
    }

    /**
     * 把 web/swish.css 的全部内容内联注入到 <head>（一次性，幂等）。
     *
     * 为什么走内联而不是 <link>：宿主 registry 只暴露已知 artifact（client.js 等），
     * 插件新增的同名 .css 不会出现在 /plugins/<id>/ 下（实测 404），也没有别的
     * 合法入口把静态 CSS 资产带进 DOM。plain-JS 插件无构建步骤的约束决定了唯一
     * 可行路径就是把 CSS 文本直接内联成 <style> 注入。
     *
     * 同步纪律：此字符串必须与仓库内的 web/swish.css **语义一致**——后者是给人读的
     * 可读版本（带注释、格式化），前者是给浏览器执行的紧凑版本；两者不是逐字镜像。
     * 改动任意一边都要同步另一边。审查 checklist：
     *   ① 22 段 @keyframes + 22 个 class + 1 段文本强调规则，数量逐一对得上；
     *   ② 所有 var() 引用、渐变色值、selector 逐字一致；
     *   ③ 每段规则都带 !important。
     * 扫光渐变骨架为**相位色底**（<HEX> 0%/40%/60%/100% 四点全相位色），
      * 中央 50% 是**白色扫光带**（var(--dsw-fc-swish-band, #ffffff)）——与官方
      * .turnStatus 的"深色底 + 浅色扫光带"机制同构（官方：deepseek-500 底 +
      * deepseek-200 带），文字填充（-webkit-background-clip:text 继承自官方哈希类）
      * 即相位色本体，不再是白底上一条窄色缝（旧形态为品牌蓝
      * --dsw-static-deepseek-500 白底 + 50% 窄色缝，2026 版已废弃）。
     * 
     * 文本强调：.turnStatusClock（TurnStatus 唯一独立着色的子元素——时长数字，官方
     * 用灰色别名 --dsw-alias-label-caption 着色）随 data-fc-bg 属性取当前相位色；
     * 该属性仅在有相位色时存在（paintTurnStatus 同步贴/撤），属性消失时选择器失配、
     * 官方 caption 灰自然恢复。详见 web/swish.css 头注释与「文本颜色强调」节。
     */
    const SWISH_CSS = "@keyframes falling-ts-swish-00{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-00{animation-name:falling-ts-swish-00!important;background-image:linear-gradient(90deg,#1e40af 0%,#1e40af 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#1e40af 60%,#1e40af 100%)!important}@keyframes falling-ts-swish-01{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-01{animation-name:falling-ts-swish-01!important;background-image:linear-gradient(90deg,#1e3a8a 0%,#1e3a8a 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#1e3a8a 60%,#1e3a8a 100%)!important}@keyframes falling-ts-swish-02{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-02{animation-name:falling-ts-swish-02!important;background-image:linear-gradient(90deg,#312e81 0%,#312e81 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#312e81 60%,#312e81 100%)!important}@keyframes falling-ts-swish-03{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-03{animation-name:falling-ts-swish-03!important;background-image:linear-gradient(90deg,#4c1d95 0%,#4c1d95 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#4c1d95 60%,#4c1d95 100%)!important}@keyframes falling-ts-swish-04{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-04{animation-name:falling-ts-swish-04!important;background-image:linear-gradient(90deg,#581c87 0%,#581c87 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#581c87 60%,#581c87 100%)!important}@keyframes falling-ts-swish-05{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-05{animation-name:falling-ts-swish-05!important;background-image:linear-gradient(90deg,#8318a3 0%,#8318a3 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#8318a3 60%,#8318a3 100%)!important}@keyframes falling-ts-swish-06{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-06{animation-name:falling-ts-swish-06!important;background-image:linear-gradient(90deg,#86198f 0%,#86198f 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#86198f 60%,#86198f 100%)!important}@keyframes falling-ts-swish-07{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-07{animation-name:falling-ts-swish-07!important;background-image:linear-gradient(90deg,#9d174d 0%,#9d174d 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#9d174d 60%,#9d174d 100%)!important}@keyframes falling-ts-swish-08{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-08{animation-name:falling-ts-swish-08!important;background-image:linear-gradient(90deg,#9f1239 0%,#9f1239 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#9f1239 60%,#9f1239 100%)!important}@keyframes falling-ts-swish-09{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-09{animation-name:falling-ts-swish-09!important;background-image:linear-gradient(90deg,#991b1b 0%,#991b1b 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#991b1b 60%,#991b1b 100%)!important}@keyframes falling-ts-swish-10{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-10{animation-name:falling-ts-swish-10!important;background-image:linear-gradient(90deg,#9a3412 0%,#9a3412 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#9a3412 60%,#9a3412 100%)!important}@keyframes falling-ts-swish-11{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-11{animation-name:falling-ts-swish-11!important;background-image:linear-gradient(90deg,#92400e 0%,#92400e 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#92400e 60%,#92400e 100%)!important}@keyframes falling-ts-swish-12{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-12{animation-name:falling-ts-swish-12!important;background-image:linear-gradient(90deg,#854d0e 0%,#854d0e 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#854d0e 60%,#854d0e 100%)!important}@keyframes falling-ts-swish-13{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-13{animation-name:falling-ts-swish-13!important;background-image:linear-gradient(90deg,#4d7c0f 0%,#4d7c0f 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#4d7c0f 60%,#4d7c0f 100%)!important}@keyframes falling-ts-swish-14{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-14{animation-name:falling-ts-swish-14!important;background-image:linear-gradient(90deg,#3f6212 0%,#3f6212 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#3f6212 60%,#3f6212 100%)!important}@keyframes falling-ts-swish-15{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-15{animation-name:falling-ts-swish-15!important;background-image:linear-gradient(90deg,#166534 0%,#166534 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#166534 60%,#166534 100%)!important}@keyframes falling-ts-swish-16{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-16{animation-name:falling-ts-swish-16!important;background-image:linear-gradient(90deg,#065f46 0%,#065f46 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#065f46 60%,#065f46 100%)!important}@keyframes falling-ts-swish-17{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-17{animation-name:falling-ts-swish-17!important;background-image:linear-gradient(90deg,#0e7490 0%,#0e7490 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#0e7490 60%,#0e7490 100%)!important}@keyframes falling-ts-swish-18{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-18{animation-name:falling-ts-swish-18!important;background-image:linear-gradient(90deg,#155e75 0%,#155e75 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#155e75 60%,#155e75 100%)!important}@keyframes falling-ts-swish-19{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-19{animation-name:falling-ts-swish-19!important;background-image:linear-gradient(90deg,#172554 0%,#172554 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#172554 60%,#172554 100%)!important}@keyframes falling-ts-swish-20{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-20{animation-name:falling-ts-swish-20!important;background-image:linear-gradient(90deg,#9b1c2b 0%,#9b1c2b 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#9b1c2b 60%,#9b1c2b 100%)!important}@keyframes falling-ts-swish-21{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-21{animation-name:falling-ts-swish-21!important;background-image:linear-gradient(90deg,#2f6f52 0%,#2f6f52 40%,var(--dsw-fc-swish-band,#ffffff) 50%,#2f6f52 60%,#2f6f52 100%)!important}.turnStatus[data-fc-bg] .turnStatusClock,[data-fc-bg] span:last-of-type{color:attr(data-fc-bg)!important;-webkit-text-fill-color:attr(data-fc-bg)!important}";

    /**
     * 确保 <style id="falling-ts-swish-inline"> 已挂在 <head>（幂等，至多一次）。
     * @returns void
     */
    function ensureSwishStylesheetInlined() {
      if (typeof document === "undefined") return;
      if (document.getElementById("falling-ts-swish-inline")) return;
      const el = document.createElement("style");
      el.id = "falling-ts-swish-inline";
      el.textContent = SWISH_CSS;
      document.head.appendChild(el);
    }

    /**
     * 注册文案字典、绑定设置命名空间、把分区挂到 settings.section。
     * @param ctx - client 根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "force-compact: dictionaries");
      const t = ctx.locale.bind(NS);
      const scope = ctx.settingsScope.bind({ namespace: NS_SETTINGS });
      // 挂载 swish 调色板样式表（首次 apply 时执行一次；effect 登记便于 fiber 卸载时清理）。
      ctx.effect(() => ensureSwishStylesheetInlined(), "force-compact: swish stylesheets");
      // 把 settingsScope 镜像成 uSES 安全的 SnapshotStore（hooks 分区的可观察源）。
      const store = createSnapshotStore({ status: "loading", value: undefined, writable: false });
      const derive = () => {
        // SAFETY ENVELOPE: derive runs BOTH as a direct call and as the
        // scope.subscribe callback — a throwing `scope.getSnapshot()` or an
        // unexpected snapshot shape must not escape out of the subscription
        // dispatch (which would strand the whole settings panel). Any anomaly
        // degrades to leaving the previous snapshot in place (store untouched).
        try {
          const s = scope.getSnapshot();
          if (s === undefined || s === null || typeof s !== "object") return;
          store.update((d) => {
            d.status = s.status;
            d.value = s.value;
            d.writable = s.writable;
          });
          // ── Live UI 徽章（详见上方 paintTurnStatus 文档）──
          // 每次命名空间快照翻转（含宿主写入 liveUi 瞬间）,顺路把最新 liveUi
          // 贴到对话区 TurnStatus DOM 上。这一步搭车在已有 scope.subscribe
          // 回调上不新增任何订阅机制 / timer / 组件,符合 client 端 AGENTS.md
          // 红线。幂等纯装饰:贴不上（无 running 会话/无 DOM 锚点）即静默跳过。
          const liveUi = (typeof s.value === "object" && s.value !== null) ? s.value.liveUi : undefined;
          if (s.status === "ready" && typeof liveUi === "object" && liveUi !== null) {
           paintTurnStatus(liveUi);
          }
        } catch {
          // Never let a cosmetic derive take down the settings panel.
        }
      };
      // 关键：settingsScope 的快照自带权威状态枚举 'loading'|'ready'|'unavailable'
      // （见 ui-settings 的 SettingsScopeController.derive：命名空间未出现时置
      // 'unavailable'，并非 'loading'）。derive 直接透传该枚举，绝不按 mode 二次
      // 映射——否则会把这个 loopback 实例上 mode='host' 的 'unavailable' 误判为
      // 'loading'，让面板在命名空间未被宿主注册期间永久停留在“加载中…”。
      //
      // 宿主侧 settings 命名空间是惰性安装的（插件 apply 时一次性尽力注册；若彼时
      // settings 服务尚未挂载，则由首个 agent/* 事件补装）。一旦命名空间真正出现，
      // 客户端 settingsScope 背后共享的 SettingsDescribeMirror 会收到 settings/
      // document-updated 广播并重新 mirror.load()，随后 derive() 读到 status='ready'
      // 自动渲染出对齐好的表单——无需本分区额外维护 timer 或轮询。
      const unsub = scope.subscribe(derive);
      derive();
      // unsub 本身就是一个 disposer（解绑 scope 监听器）。必须把它作为 effect 的
      // 返回值交给 ctx.effect，由 fiber 在本插件卸载/重跑时运行它以解除订阅；
      // 直接把 unsub 当作用法的“执行体”（ctx.effect(unsub,...)）会令 fiber 立即
      // 调用 unsub() 并把它的 void 返回值当第二个 effect 收集——既提前解绑了本次
      // 订阅，又不登记任何清理项，属错误用法。
      ctx.effect(() => unsub, "force-compact: scope subscription");
      const injected = () => ({
        hooks: { forceCompact: store },
        t: t,
        update: (field, value2) => scope.set(field, value2),
      });
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "force-compact",
        order: 30,
        label: () => t("nav"),
        inject: injected,
      }, ForceCompactSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

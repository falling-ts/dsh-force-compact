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
 * （disableThinking / autoThresholdTokens / autoEarliestRatio / forceEarliestRatio /
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
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

    /** 该分区拥有的文案命名空间。 */
    const NS = "settings.forceCompact";
    /** 宿主侧 force-compact 设置命名空间（settings.get 读取的键）。 */
    const NS_SETTINGS = "falling-ts-force-compact";

    const zh = {
      nav: "强制压缩",
      intro: "控制 force-compact 插件的压缩行为（强制压缩配置）。改动在 $DSH_HOME/settings.yaml 的 falling-ts-force-compact 段生效。",
      disableThinking: "压缩时关闭思考",
      disableThinkingHint: "为 true 时每次模型请求携带 reasoningEffort: off，关闭思考以节省 token。",
      autoThresholdTokens: "自动压缩阈值（token）",
      autoThresholdTokensHint: "会话总上下文 tokens ≥ 该值时，agent/pre-step 阈值门禁触发强制压缩。",
      autoEarliestRatio: "自动压缩最早比例",
      autoEarliestRatioHint: "自动压缩时按会话总 tokens 的该比例从头截断（0.01–1，默认 0.3）。",
      forceEarliestRatio: "强制压缩最早比例",
      forceEarliestRatioHint: "/force-compact 忙碌排队后按总 tokens 的该比例从头截断（0.01–1，默认 0.5）。",
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
      maxSummaryTokens: "摘要最大 tokens",
      maxSummaryTokensHint: "插件自身摘要 LLM 调用的 maxTokens 上限（默认 2400，256–200000），防止摘要长度失控；收缩门禁另行保证提交的摘要比被遮蔽区间小。",
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
      autoThresholdTokensHint: "When the session's total context tokens ≥ this value, the agent/pre-step threshold gate force-compacts.",
      autoEarliestRatio: "Auto-compaction earliest ratio",
      autoEarliestRatioHint: "For auto-compaction, truncate from the head to this ratio of total tokens (0.01–1, default 0.3).",
      forceEarliestRatio: "Force-compaction earliest ratio",
      forceEarliestRatioHint: "After a busy /force-compact queues, truncate from the head to this ratio of total tokens (0.01–1, default 0.5).",
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
      maxSummaryTokens: "Max summary tokens",
      maxSummaryTokensHint: "maxTokens ceiling on the plugin's own summarization LLM call (default 2400, range 256–200000). Prevents runaway summaries; the shrink gate separately guarantees the committed summary is smaller than the span it replaces.",
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
      // 阈值用草稿数字框；两个比例用拖动滑块。三者都在组件顶部、任何条件返回之
      // 前无条件调用对应 hook，保证 React hooks 顺序恒定（状态切换不改变 hook 数）。
      const thOpt = { step: 1000, min: 0, max: 1000000 };
      const [thBuf, thHandlers] = useDraftNumber("autoThresholdTokens", valOrUndef("autoThresholdTokens"), thOpt, update);
      const arSlider = useDragRatio("autoEarliestRatio", valOrUndef("autoEarliestRatio"), update);
      const frSlider = useDragRatio("forceEarliestRatio", valOrUndef("forceEarliestRatio"), update);
      // 新增三项的可观察源（同样放在顶部无条件调用，保持 hooks 顺序稳定）。
      const lfOpt = { placeholder: t("logFilePlaceholder") };
      const [lfBuf, lfHandlers] = useDraftText("logFile", valOrUndef("logFile"), update);
      // maxSummaryTokens: 数字框，256–200000，默认 2400。
      const msOpt = { step: 16, min: 256, max: 200000 };
      const [msBuf, msHandlers] = useDraftNumber("maxSummaryTokens", valOrUndef("maxSummaryTokens"), msOpt, update);
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
            ratioRow("autoEarliestRatio", "autoEarliestRatioHint", arSlider, false),
            ratioRow("forceEarliestRatio", "forceEarliestRatioHint", frSlider, false),
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
     * 宿主半部（core/ui-signal.js）在三个时机改写本命名空间的 liveUi 字段：
     *   • 每次出站 LLM 调用开始时——写入 20×20 随机工作态（phase/text/color）；
     *   • 任意一次强制压缩开始前——固定红色「正在压缩…」；
     *   • 压缩成功后——固定绿色「压缩完成!!!」。
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
     * 的 nodeValue + 父节点的 inline color）。找不到节点则静默 no-op（当前没有
     * running 会话 → 没有指示器 → 无可贴目标,这是预期行为而非错误）。
     *
     * @param liveUi - 宿主写入的 { phase, text, color }；缺省/null 时 no-op。
     */
    function paintTurnStatus(liveUi) {
      if (typeof document === "undefined") return;
      if (!liveUi || typeof liveUi.text !== "string" || liveUi.text.length === 0) return;
      const statusNodes = document.querySelectorAll('[role="status"][aria-live="polite"]');
      if (statusNodes.length === 0) return; // 没有 running 会话 → 没有 TurnStatus
      for (const node of statusNodes) {
        // 第一个文本型子节点（"Deep diving..." 本体；时钟 span 是其后兄弟,不受影响）。
        let textChild = null;
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim() !== "") { textChild = child; break; }
        }
        if (textChild === null) continue; // 结构不符预期 → 跳过,绝不破坏官方布局
        textChild.nodeValue = liveUi.text;
        // phase→颜色已在宿主侧算好（working 随机色 / compressing 红 / done 绿）。
        // 直接设 inline color 即可让 CSS 模块类的 shimmer 动画仍作用于文本填充
        // （shimmer 用的是 gradient + background-clip:text 的透明填充,与 color 无关;
        // 但我们仍显式设一次,以防未来 shimmer 样式调整导致底色缺失时仍可辨识相位）。
        node.style.color = typeof liveUi.color === "string" ? liveUi.color : "";
      }
    }

    /**
     * 注册文案字典、绑定设置命名空间、把分区挂到 settings.section。
     * @param ctx - client 根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "force-compact: dictionaries");
      const t = ctx.locale.bind(NS);
      const scope = ctx.settingsScope.bind({ namespace: NS_SETTINGS });
      // 把 settingsScope 镜像成 uSES 安全的 SnapshotStore（hooks 分区的可观察源）。
      const store = createSnapshotStore({ status: "loading", value: undefined, writable: false });
      const derive = () => {
        const s = scope.getSnapshot();
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
        if (s.status === "ready" && s.value && typeof s.value.liveUi === "object") {
         paintTurnStatus(s.value.liveUi);
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

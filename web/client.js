/**
 * force-compact 设置分区的浏览器半部（settings.section）。
 *
 * 这是一个闭包工厂 artifact：调用 window.__ModuleLoader__.load({ id, factory })，
 * factory(require) 通过注入的 require 解析外部模块（这里只有基线 react），并返回
 * 插件面 { name, inject, apply }。宿主半部（根 index.js）与本文件是同一 package
 * 的两个面：宿主半部由 main 入口加载，本文件由 exports["./client"] 导出，经
 * dsh.client 声明被 client module 系统自动组成并服务（/plugins/<id>/client.js）。
 *
 * 该分区通过 configForms 读写宿主侧 falling-ts-force-compact 设置命名空间
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
    // 基线外部（web 平台预载）：把 configForms 镜像成 uSES 安全的 SnapshotStore。
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
      summarizationTimeoutMs: "摘要超时上限（ms）",
      summarizationTimeoutMsHint: "一次摘要 LLM 流的硬墙钟超时（毫秒）。流在此限内未产出终止状态即判为挂起并中止（防止 compaction/start 锁永不闭合）。默认 90000（90 秒）；最小 5000，若填低于此值会自动重置为 5000；无上限——填很大的值相当于禁用该守卫。",
      unavailable: "设置不可用",
      loading: "加载中…",
      notWritable: "（当前为只读/内存模式，改动仅本进程生效）",
      badgeCompressing: "[强制压缩中>>>]",
      badgeDone: "[压缩完成!]",
      badgeEnd: "",
      badgeWorking0: "正在酝酿骚操作",
      badgeWorking1: "正在憋大招",
      badgeWorking2: "灵感正在路上",
      badgeWorking3: "脑细胞开会中",
      badgeWorking4: "灵魂拷问进行中",
      badgeWorking5: "偷偷翻你底牌",
      badgeWorking6: "量子纠缠计算中",
      badgeWorking7: "假装很忙",
      badgeWorking8: "摸鱼式工作中",
      badgeWorking9: "疯狂敲键盘(精神上)",
      badgeWorking10: "正在缝合上下文",
      badgeWorking11: "正在驯服混沌",
      badgeWorking12: "正在召唤赛博大脑",
      badgeWorking13: "正在翻阅《天机》",
      badgeWorking14: "GPU 正在冒烟",
      badgeWorking15: "正在跟熵值搏斗",
      badgeWorking16: "正在画饼给你吃",
      badgeWorking17: "正在偷渡灵感",
      badgeWorking18: "正在暗中观察",
      badgeWorking19: "马上就好(大概)",
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
      summarizationTimeoutMs: "Summarization timeout (ms)",
      summarizationTimeoutMsHint: "Hard wall-clock cap for ONE summarization stream (ms). A stream that yields no terminal finish within this limit is presumed hung and aborted (preventing a leaked compaction/start lock). Default 90000 (90s); minimum 5000 — values below are clamped back to 5000; no ceiling — a very large value effectively disables the guard.",
      unavailable: "Settings unavailable",
      loading: "Loading…",
      notWritable: "(read-only / memory mode; changes are process-local)",
      badgeCompressing: "[Compacting…]",
      badgeDone: "[Compaction complete!]",
      badgeEnd: "",
      badgeWorking0: "Cooking up a wild move",
      badgeWorking1: "Charging up a big move",
      badgeWorking2: "Inspiration is on the way",
      badgeWorking3: "Brain cells in session",
      badgeWorking4: "Soul-searching in progress",
      badgeWorking5: "Sneaking a peek at your cards",
      badgeWorking6: "Quantum-entangled computing",
      badgeWorking7: "Looking busy",
      badgeWorking8: "Low-key slacking (working)",
      badgeWorking9: "Pounding keys furiously (mentally)",
      badgeWorking10: "Stitching context together",
      badgeWorking11: "Taming the chaos",
      badgeWorking12: "Summoning a cyber brain",
      badgeWorking13: "Leafing through heaven's manual",
      badgeWorking14: "GPU is smoking",
      badgeWorking15: "Wrestling with entropy",
      badgeWorking16: "Dangling a tasty promise",
      badgeWorking17: "Smuggling in inspiration",
      badgeWorking18: "Watching from the shadows",
      badgeWorking19: "Almost done (maybe)",
    };
    // ja / ko 由本插件作为**语言包**贡献（上游 @deepseek-ai/dsh-client-locale 只内置
    // zh/en；LanguageRegistration 的 label 用该语言自述，fallback 必须已注册并以
    // en 为终点）。键集必须与上方 zh 完全一致——zh 是键集事实源，缺键会回落到 en。
    const ja = {
      nav: "強制圧縮",
      intro: "force-compact プラグインの圧縮動作（強制圧縮設定）を制御します。変更は $DSH_HOME/settings.yaml の falling-ts-force-compact セクションに反映されます。",
      disableThinking: "圧縮時の思考を無効化",
      disableThinkingHint: "true のとき、このプラグイン自身の圧縮要約呼び出しに reasoningEffort: off を付与し、思考を無効化してトークンを節約します。通常の対話リクエストには影響しません（マシンの既定値のまま）。",
      autoThresholdTokens: "自動圧縮のしきい値（トークン）",
      autoThresholdTokensHint: "セッションの総コンテキストトークンがこの値以上になると、agent/pre-step のしきい値ゲートが強制圧縮を実行します。最小 32000。これ未満の値は 32000 に戻されます。",
      retainLatestTokens: "最新コンテキストの保持量（トークン）",
      retainLatestTokensHint: "自動／強制圧縮のとき、セッションの最新エントリから公式 tokenMeter のノード単位カウントでトークンを遡って加算し、この値に達した時点で停止します。その境界より前のエントリはまとめて要約 LLM に送られ（元のエントリは遮蔽／スキップされます）、保持された末尾はそのまま残ります。既定 8000、最小 8000。これ未満の値は 8000 に戻されます。",
      turnEndForceCompaction: "ターン終了時の強制圧縮",
      turnEndForceCompactionHint: "true のとき、agent が idle（1 ターンの終了）へ移行した時点でターン終了圧縮を 1 回実行します。",
      debug: "詳細ログ（debug）",
      debugHint: "true のとき、リクエスト／ステップごとの主要な観測行を logFile（既定 ~/.dsh/logs/dsh-force-compact.log）へ書き出します。本番では false にしてノイズを減らせます。",
      logFile: "ログファイルのパス",
      logFileHint: "詳細ログの出力先パス（先頭の ~ はユーザーのホームディレクトリに展開されます）。変更は次回起動時に有効になります。",
      logFilePlaceholder: "~/.dsh/logs/dsh-force-compact.log",
      compactionMode: "圧縮サービスの解決モード",
      compactionModeHint: "realm: 現在の Agent のレルムから compaction サービスを探し、見つからなければグローバルへフォールバックします。global: グローバルの compaction サービスを直接使います（バックエンドが root レルムにマウントされている必要があります）。",
      modeRealm: "realm（レルム優先）",
      modeGlobal: "global（グローバル）",
      builtinEnabled: "内蔵圧縮エンジン",
      builtinEnabledHint: "公式の compaction サービスに到達できないとき（標準プリセットが isolate グループへ隔離している場合など）に、このプラグイン自前の内蔵圧縮エンジンをフォールバックとして使います。既定は有効。false にすると公式のみを使います。",
      maxSummaryTokens: "要約の最大サイズ（トークン）",
      maxSummaryTokensHint: "このプラグイン自身の要約 LLM 呼び出しの maxTokens 上限（既定 1024、範囲 1024〜200000）。要約が暴走するのを防ぎます。コミットされる要約が遮蔽区間より小さいことは、別途シュリンクゲートが保証します。最小 1024。これ未満の値は 1024 に戻されます。",
      summarizationTimeoutMs: "要約のタイムアウト上限（ms）",
      summarizationTimeoutMsHint: "1 回の要約 LLM ストリームに対するハードな実時間上限（ミリ秒）。この時間内に終端状態を返さないストリームはハングとみなして中断します（compaction/start ロックが閉じない事態を防ぎます）。既定 90000（90 秒）、最小 5000。これ未満の値は 5000 に戻されます。上限はありません（非常に大きな値はこのガードを実質的に無効化します）。",
      unavailable: "設定を利用できません",
      loading: "読み込み中…",
      notWritable: "（現在は読み取り専用／メモリモードのため、変更はこのプロセス内でのみ有効です）",
      badgeCompressing: "[強制圧縮中>>>]",
      badgeDone: "[圧縮完了!]",
      badgeEnd: "",
      badgeWorking0: "大胆な一手を思案中",
      badgeWorking1: "大技をチャージ中",
      badgeWorking2: "ひらめきが向かっています",
      badgeWorking3: "脳細胞が会議中",
      badgeWorking4: "魂の問い詰め中",
      badgeWorking5: "こっそり手札を覗き中",
      badgeWorking6: "量子もつれ計算中",
      badgeWorking7: "忙しいフリ中",
      badgeWorking8: "サボりながら作業中",
      badgeWorking9: "キーボードを狂ったように叩いています(精神的に)",
      badgeWorking10: "コンテキストを縫合中",
      badgeWorking11: "混沌を手なずけ中",
      badgeWorking12: "サイバー脳を召喚中",
      badgeWorking13: "『天機』をめくっています",
      badgeWorking14: "GPU が煙を上げています",
      badgeWorking15: "エントロピーと格闘中",
      badgeWorking16: "絵に描いた餅を焼いています",
      badgeWorking17: "ひらめきを密輸中",
      badgeWorking18: "影から様子をうかがっています",
      badgeWorking19: "もうすぐです(たぶん)",
    };
    const ko = {
      nav: "강제 압축",
      intro: "force-compact 플러그인의 압축 동작(강제 압축 설정)을 제어합니다. 변경 사항은 $DSH_HOME/settings.yaml의 falling-ts-force-compact 섹션에 반영됩니다.",
      disableThinking: "압축 시 사고 비활성화",
      disableThinkingHint: "true이면 이 플러그인 자체의 압축 요약 호출에 reasoningEffort: off를 실어 사고를 끄고 토큰을 절약합니다. 일반 대화 요청에는 영향을 주지 않습니다(머신 기본값 유지).",
      autoThresholdTokens: "자동 압축 임계값(토큰)",
      autoThresholdTokensHint: "세션의 총 컨텍스트 토큰이 이 값 이상이면 agent/pre-step 임계값 게이트가 강제 압축을 실행합니다. 최소 32000이며 이보다 낮은 값은 32000으로 되돌립니다.",
      retainLatestTokens: "최신 컨텍스트 유지량(토큰)",
      retainLatestTokensHint: "자동/강제 압축 시 세션의 최신 항목부터 공식 tokenMeter의 노드별 계산으로 토큰을 역산해 더하다가 이 값에 도달하면 멈춥니다. 그 경계 이전의 모든 항목은 한 번에 요약 LLM으로 보내지고(원본 항목은 가려지거나 건너뜀) 유지된 꼬리는 그대로 남습니다. 기본 8000, 최소 8000이며 이보다 낮은 값은 8000으로 되돌립니다.",
      turnEndForceCompaction: "턴 종료 시 강제 압축",
      turnEndForceCompactionHint: "true이면 agent가 idle(한 턴 종료)로 전환될 때 턴 종료 압축을 한 번 실행합니다.",
      debug: "상세 로그(debug)",
      debugHint: "true이면 요청/단계마다 주요 관찰 줄을 logFile(기본 ~/.dsh/logs/dsh-force-compact.log)에 기록합니다. 운영 환경에서는 false로 두어 소음을 줄일 수 있습니다.",
      logFile: "로그 파일 경로",
      logFileHint: "상세 로그의 대상 경로입니다(앞의 ~는 사용자 홈 디렉터리로 확장됩니다). 변경은 다음 시작 시 적용됩니다.",
      logFilePlaceholder: "~/.dsh/logs/dsh-force-compact.log",
      compactionMode: "압축 서비스 해석 모드",
      compactionModeHint: "realm: 현재 Agent의 렐름에서 compaction 서비스를 먼저 찾고 없으면 전역으로 폴백합니다. global: 전역 compaction 서비스를 바로 사용합니다(백엔드가 root 렐름에 마운트되어 있어야 합니다).",
      modeRealm: "realm(렐름 우선)",
      modeGlobal: "global(전역)",
      builtinEnabled: "내장 압축 엔진",
      builtinEnabledHint: "공식 compaction 서비스에 닿을 수 없을 때(예: 표준 프리셋이 isolate 그룹으로 격리한 경우) 이 플러그인 자체의 내장 압축 엔진을 폴백으로 사용합니다. 기본값은 켜짐이며 false로 두면 공식 엔진만 사용합니다.",
      maxSummaryTokens: "요약 최대 크기(토큰)",
      maxSummaryTokensHint: "이 플러그인 자체 요약 LLM 호출의 maxTokens 상한입니다(기본 1024, 범위 1024–200000). 요약이 폭주하는 것을 막습니다. 커밋되는 요약이 가려진 구간보다 작다는 것은 별도의 축소 게이트가 보장합니다. 최소 1024이며 이보다 낮은 값은 1024로 되돌립니다.",
      summarizationTimeoutMs: "요약 시간 초과 상한(ms)",
      summarizationTimeoutMsHint: "요약 LLM 스트림 한 번에 대한 하드 실시간 상한(밀리초)입니다. 이 시간 안에 종료 상태를 내지 않는 스트림은 멈춘 것으로 보고 중단합니다(compaction/start 잠금이 닫히지 않는 상황을 막습니다). 기본 90000(90초), 최소 5000이며 이보다 낮은 값은 5000으로 되돌립니다. 상한은 없습니다(아주 큰 값은 이 가드를 사실상 무력화합니다).",
      unavailable: "설정을 사용할 수 없습니다",
      loading: "불러오는 중…",
      notWritable: "(현재 읽기 전용/메모리 모드라 변경은 이 프로세스에서만 적용됩니다)",
      badgeCompressing: "[강제 압축 중>>>]",
      badgeDone: "[압축 완료!]",
      badgeEnd: "",
      badgeWorking0: "대담한 한 수를 구상 중",
      badgeWorking1: "필살기를 충전 중",
      badgeWorking2: "영감이 오고 있습니다",
      badgeWorking3: "뇌세포 회의 중",
      badgeWorking4: "영혼 심문 진행 중",
      badgeWorking5: "몰래 당신의 패를 엿보는 중",
      badgeWorking6: "양자 얽힘 계산 중",
      badgeWorking7: "바쁜 척하는 중",
      badgeWorking8: "딴짓하며 일하는 중",
      badgeWorking9: "키보드를 미친 듯이 두드리는 중(정신적으로)",
      badgeWorking10: "컨텍스트를 꿰매는 중",
      badgeWorking11: "혼돈을 길들이는 중",
      badgeWorking12: "사이버 두뇌를 소환 중",
      badgeWorking13: "《천기》를 넘겨보는 중",
      badgeWorking14: "GPU가 연기를 내뿜는 중",
      badgeWorking15: "엔트로피와 씨름 중",
      badgeWorking16: "그림의 떡을 구워주는 중",
      badgeWorking17: "영감을 밀수 중",
      badgeWorking18: "그림자에서 지켜보는 중",
      badgeWorking19: "거의 다 됐습니다(아마도)",
    };

    /** 必需服务（cordis fiber inject）。configForms 由 ui-settings 提供。 */
    const inject = ["slots", "locale", "configForms"];

    // ── 视觉设计 ----------------------------------------------------------------
    // 参照通用设置分区（如「语言」）的排版：扁平、无背景色、行间细分隔线、
    // 紧凑纵向节奏；三栏网格 label（定宽一列）· control（右对齐一列）· hint，
    // label 与 hint 同列同字体纵向对齐，control 靠右，数值输入框等宽中性描边。
    //
    // 颜色一律经主题别名 `var(--fcts-*)`（见下方 THEME_TOKENS_CSS），**不写字面色**：
    // 浅色沿用原字面值，暗色自动翻转为上游语义别名（说明文字取纯白）。
    const divider = "var(--fcts-line)";
    const hintColor = "var(--fcts-text-hint)";
    const mutedColor = "var(--fcts-text-muted)";
    const gridCols = "172px 140px minmax(0,1fr)";
    const wrapStyle = { padding: "4px 0" };
    const titleStyle = { margin: "2px 0 2px", fontSize: 15, lineHeight: 1.4 };
    const introStyle = { margin: "0 0 6px", color: hintColor, lineHeight: 1.65, fontSize: 13, maxWidth: 680 };
    const rowStyle = { display: "grid", gridTemplateColumns: gridCols, columnGap: 16, rowGap: 5, padding: "13px 0", borderBottom: "1px solid " + divider, alignItems: "center" };
    const lastRowStyle = { ...rowStyle, borderBottom: "none" };
    const labelStyle = { fontSize: 13.5, fontWeight: 500, lineHeight: 1.35 };
    const controlStyle = { display: "flex", justifyContent: "flex-end", alignItems: "center" };
    const hintStyle = { gridColumn: "1 / 3", gridRow: 3, color: hintColor, fontSize: 12, lineHeight: 1.55 };
    const inputStyle = { width: 128, textAlign: "right", padding: "5px 10px", boxSizing: "border-box", border: "1px solid var(--fcts-line-strong)", borderRadius: 6, fontVariantNumeric: "tabular-nums", backgroundColor: "transparent", outline: "none", fontSize: 13 };
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
      background: on ? brandGrad : (hovered && !disabled ? "var(--fcts-fill-off-hover)" : "var(--fcts-fill-off)"),
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
          border: sel ? "1px solid rgba(47,107,255,0.7)" : "1px solid var(--fcts-line-soft)",
          background: sel ? "linear-gradient(90deg,#2f6bff 0%,#3d8bff 100%)" : "transparent",
          color: sel ? "#ffffff" : "var(--fcts-text-body)",
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
        h("div", { style: { position: "absolute", left: 0, right: 0, top: TRACK_TOP, height: SLIDER_H, borderRadius: 999, background: "var(--fcts-fill-subtle)" } }),
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
      // summarizationTimeoutMs: 数字框，默认 90000，最小 5000，无上限。
      const soOpt = { step: 5000, min: 5000 };
      const [soBuf, soHandlers] = useDraftNumberClamped("summarizationTimeoutMs", valOrUndef("summarizationTimeoutMs"), soOpt, update, 5000);
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
            numberRow("maxSummaryTokens", "maxSummaryTokens", "maxSummaryTokensHint", msBuf, msHandlers, msOpt, false),
            numberRow("summarizationTimeoutMs", "summarizationTimeoutMs", "summarizationTimeoutMsHint", soBuf, soHandlers, soOpt, true)),
          disabled ? h("p", { style: disabledHintStyle }, t("notWritable")) : null);
    }

    /**
     * Live UI 徽章的贴皮入口。宿主半部（core/ui-signal.js）在四个时机改写本
     * 命名空间的 liveUi 字段：每次出站 LLM 调用开始时写入随机工作态；强制压缩
     * 开始前写入固定「[强制压缩中>>>]」；压缩成功后写入固定「[压缩完成!]」；
     * 会话结束（agent 转入 idle，hooks/idle.js）写入空字符串 text —— 语义是
     * "清空"（还原官方原文、断开观察器）。
     * 文本按 textId 经下方词典做 zh/en/ja/ko 本地化（跟随应用语言）。
     * 只替换运行态那行**文字**的前缀，前缀的鲸鱼动画图标与分隔线原样保留。
     * 机制与 DOM 定位策略见下方「官方运行标签的前缀替换器」注释块。
     */
    // ── 官方运行标签的「前缀替换器」──
    // harness 0.2.0 起，运行态文案不再住在回合结束后的 button[data-turn-process] 里
    // ——那个按钮现在只渲染**已结束**回合（`已完成，用时 2分5秒` / `Took 2m 5s`）。
    // 运行态搬进了独立组件 RunningStatus
    // （packages/client/ui-chat/src/client/chat/RunningStatus.tsx），锚点是稳定属性
    // `data-chat-running`：
    //
    //   <div data-chat-running>
    //     <span role="status" aria-live="polite">深度求索中</span>   ← 1px 裁剪的读屏播报
    //     <span class="runningDivider">                              ← 分隔线
    //     <span class="runningContent">
    //       <span class="runningIcon">…鲸鱼动画…</span>              ← 前缀动画小图标
    //       <TextShimmer class="runningText" data-shimmer>深度求索中，用时1分14秒 ···</TextShimmer>
    //     </span>
    //   </div>
    //
    // 因此本插件只做四件事：
    //   • 替换 TextShimmer 里「深度求索中」这一段**前缀**，**保留 harness 自己的
    //     计时尾巴**（`，用时1分14秒 ···`）；
    //   • **绝不触碰前缀的鲸鱼动画图标**（runningIcon 里的 APNG mask + SVG 兜底）
    //     与 runningDivider 分隔线——官方动效原样保留；
    //   • 不写颜色、不动字体、不动布局——官方蓝色与字号逐字不变；
    //   • 绝不触碰 role=status 播报节点（无障碍播报归还官方）。
    //
    // 计时尾巴的切分不硬编码任何中英文：运行态下「TextShimmer 原文 = 官方播报文本 +
    // 计时尾巴」，故取 role=status 节点的文本与原文的**公共前缀**为锚——公共前缀之后
    // 就是 harness 的计时（中英皆然：`深度求索中` + `，用时1分14秒 ···`、`Deep diving`
    // + ` for 1m 14s ···`）；公共前缀为空 ⇒ 不是运行态，官方原文原样留着。
    //
    // TextShimmer 把同一句话渲染**两遍**：一份真实文本节点（可选中、可访问），一份
    // `aria-hidden` 的动画高亮副本——后者的字由 CSS `::after { content:
    // attr(data-shimmer-text) }` 从属性取，元素自身没有文本节点。所以替换必须**双写**
    // （nodeValue + data-shimmer-text），否则扫光扫过时会露出官方旧文案。
    //
    // 为什么需要 MutationObserver：文案每秒被 React 重写一次（时长在跳），一次性覆盖会在
    // 1 秒内被抹掉。观察器在 React 写入的同一微任务里重新贴上，浏览器不会画出中间态；
    // 本插件自己的写入由 `painted` 值短路，不会自激。观察器只在**有活跃相位**期间连接
    // （清空即断开），空闲时零开销、零轮询。
    //
    // 必须改文本节点的 nodeValue，不能写 textContent——后者会换掉 React 持有的那个
    // 文本节点，官方计时将再也更新不上来。

    /** 运行态容器：RunningStatus 的 div 带稳定属性 data-chat-running。 */
    const RUNNING_ROOT_SELECTOR = "[data-chat-running]";

    /** 文案载体：TextShimmer 根（官方在该容器内唯一带 data-shimmer 的元素）。 */
    const SHIMMER_SELECTOR = "[data-shimmer]";

    /** 动画高亮副本的文案属性（CSS ::after 的 content 来源）。 */
    const SHIMMER_TEXT_ATTR = "data-shimmer-text";

    /** 当前要替换进去的前缀；null = 不替换（清空态）。 */
    let desiredPrefix = null;

    /** 已改写的运行态容器 → { painted, suffix, official, decorative }（清空时据此还原官方原文）。 */
    const paintedLabels = new Map();

    /** 活跃相位期间的 DOM 观察器；清空 / 插件卸载即断开。 */
    let labelObserver = null;

    /**
     * 从任意节点向上找到所属的运行态容器。
     * @param {Node|null} node 变更记录的目标（文本节点或元素）。
     * @returns {Element|null} 最近的 [data-chat-running] 祖先（自身算），无则 null。
     */
    function closestRunningRoot(node) {
      let el = (node === null || node === undefined)
        ? null
        : (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      while (el !== null && el !== undefined) {
        if (typeof el.matches === "function" && el.matches(RUNNING_ROOT_SELECTOR)) return el;
        el = el.parentElement;
      }
      return null;
    }

    /**
     * 取容器里最外层的 TextShimmer 根（嵌套实例只算最外层）。
     * @param {Element} root 运行态容器。
     * @returns {Element|null} TextShimmer 根（结构变化时为 null）。
     */
    function shimmerRootOf(root) {
      for (const el of root.querySelectorAll(SHIMMER_SELECTOR)) {
        let parent = el.parentElement;
        let nested = false;
        while (parent !== null && parent !== undefined && parent !== root) {
          if (typeof parent.matches === "function" && parent.matches(SHIMMER_SELECTOR)) { nested = true; break; }
          parent = parent.parentElement;
        }
        if (!nested) return el;
      }
      return null;
    }

    /**
     * 该元素是否落在读屏播报节点（role=status）里——播报文本绝不参与替换。
     * @param {Element} el 候选元素。
     * @param {Element} root 停止上溯的运行态容器。
     * @returns {boolean} 是否属于播报节点子树。
     */
    function insideAnnouncement(el, root) {
      let current = el;
      while (current !== null && current !== undefined && current !== root) {
        if (typeof current.getAttribute === "function" && current.getAttribute("role") === "status") return true;
        current = current.parentElement;
      }
      return false;
    }

    /**
     * 取可见文案的载体：那个**持有真实文本节点**的元素。
     *
     * 动画高亮副本（带 data-shimmer-text）没有文本节点（字由 CSS ::after 生成），跳过；
     * 读屏播报节点（role=status）整棵子树也跳过。优先只在 TextShimmer 子树里找，结构
     * 不含 TextShimmer 时退回整个容器（仍排除播报节点）。
     * @param {Element} root 运行态容器。
     * @returns {{el: Element, node: CharacterData}|null} 载体元素与其文本节点。
     */
    function runningTextOf(root) {
      const shimmer = shimmerRootOf(root);
      const scope = shimmer === null ? root : shimmer;
      for (const el of scope.querySelectorAll("*")) {
        if (typeof el.getAttribute === "function" && el.getAttribute(SHIMMER_TEXT_ATTR) !== null) continue;
        if (scope === root && insideAnnouncement(el, root)) continue;
        for (const child of el.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE) continue;
          if (child.nodeValue.length !== 0) return { el, node: child };
        }
      }
      return null;
    }

    /**
     * 动画高亮副本：容器内唯一带 data-shimmer-text 的元素。
     * @param {Element} root 运行态容器。
     * @returns {Element|null} 属性载体（结构变化时为 null）。
     */
    function decorationOf(root) {
      return root.querySelector("[" + SHIMMER_TEXT_ATTR + "]");
    }

    /**
     * 把动画高亮副本的字同步成同一句（CSS ::after 从属性取 content）。
     * @param {Element|null} decorative 高亮副本元素。
     * @param {string} text 要显示的整句。
     * @returns {void}
     */
    function writeDecoration(decorative, text) {
      if (decorative === null || decorative === undefined) return;
      if (decorative.getAttribute(SHIMMER_TEXT_ATTR) === text) return;
      decorative.setAttribute(SHIMMER_TEXT_ATTR, text);
    }

    /**
     * 容器内 role=status 播报节点的文本——运行态即官方「深度求索中」原文。
     * @param {Element} root 运行态容器。
     * @returns {string} 播报文本（结构变化时为空串）。
     */
    function announcementOf(root) {
      const status = root.querySelector('[role="status"][aria-live="polite"]');
      return status === null ? "" : status.textContent;
    }

    /**
     * 两个字符串的公共前缀长度。
     * @param {string} left 左串。
     * @param {string} right 右串。
     * @returns {number} 公共前缀字符数。
     */
    function commonPrefixLength(left, right) {
      const limit = Math.min(left.length, right.length);
      let index = 0;
      while (index < limit && left[index] === right[index]) index += 1;
      return index;
    }

    /**
     * 官方原文里属于 harness 计时的那一段。
     * @param {Element} root 运行态容器。
     * @param {string} official 载体当前的官方原文。
     * @returns {string|null} 计时尾巴；null = 不是运行态（不贴）。
     */
    function timeSuffixOf(root, official) {
      const announcement = announcementOf(root);
      if (announcement.length === 0) return null;
      const anchor = commonPrefixLength(announcement, official);
      return anchor === 0 ? null : official.slice(anchor);
    }

    /**
     * 把一个运行态容器贴成 desiredPrefix + 官方计时尾巴（真实文本与动画高亮副本双写）。
     * @param {Element} root 运行态容器。
     * @returns {void}
     */
    function paintLabel(root) {
      const carrier = runningTextOf(root);
      if (carrier === null) return;
      const node = carrier.node;
      const decorative = decorationOf(root);
      const current = node.nodeValue;
      const state = paintedLabels.get(root);
      if (state !== undefined && current === state.painted) {
        // 本插件上一轮的文本还在（React 尚未重写）：只需跟上相位文案的变化。
        const next = desiredPrefix + state.suffix;
        if (next !== state.painted) {
          state.painted = next;
          node.nodeValue = next;
          writeDecoration(decorative, next);
        }
        return;
      }
      const suffix = timeSuffixOf(root, current);
      if (suffix === null) { paintedLabels.delete(root); return; } // 非运行态：官方原文不动
      const painted = desiredPrefix + suffix;
      paintedLabels.set(root, { painted, suffix, official: current, decorative });
      if (current !== painted) node.nodeValue = painted;
      writeDecoration(decorative, painted);
    }

    /** 贴全部打开的会话 / 标签页里命中的运行状态（装饰性、幂等）。 */
    function paintAllTurnLabels() {
      if (desiredPrefix === null) return;
      for (const root of document.querySelectorAll(RUNNING_ROOT_SELECTOR)) paintLabel(root);
    }

    /**
     * 这批 DOM 变更是否可能动到运行状态（流式输出时避免无谓的全量重扫）。
     * @param {MutationRecord[]} records 观察器回调的变更批次。
     * @returns {boolean} 是否需要重贴。
     */
    function touchesTurnLabel(records) {
      for (const record of records) {
        if (record.type === "characterData" || record.type === "attributes") {
          if (closestRunningRoot(record.target) !== null) return true;
          continue;
        }
        for (const added of record.addedNodes) {
          if (added.nodeType !== Node.ELEMENT_NODE) continue;
          if (closestRunningRoot(added) !== null || added.querySelector(RUNNING_ROOT_SELECTOR) !== null) return true;
        }
      }
      return false;
    }

    /** 确保观察器已连接（幂等，至多一个）。 */
    function ensureLabelObserver() {
      if (labelObserver !== null || typeof MutationObserver !== "function") return;
      if (document.body === null) return;
      labelObserver = new MutationObserver((records) => {
        if (desiredPrefix === null) return;
        if (!touchesTurnLabel(records)) return;
        paintAllTurnLabels();
      });
      labelObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [SHIMMER_TEXT_ATTR],
      });
    }

    /** 断开观察器（清空态 / 插件卸载）。 */
    function releaseLabelObserver() {
      if (labelObserver === null) return;
      labelObserver.disconnect();
      labelObserver = null;
    }

    /** 清空：断开观察器，并把贴过的运行状态还原成官方原文（文本与高亮副本双还原）。 */
    function clearPaintedLabels() {
      releaseLabelObserver();
      for (const [root, state] of paintedLabels) {
        if (!root.isConnected) continue;
        const carrier = runningTextOf(root);
        if (carrier !== null && carrier.node.nodeValue === state.painted) carrier.node.nodeValue = state.official;
        const decorative = (state.decorative === undefined || state.decorative === null)
          ? decorationOf(root)
          : state.decorative;
        if (decorative !== null && decorative !== undefined
          && decorative.getAttribute(SHIMMER_TEXT_ATTR) === state.painted) {
          decorative.setAttribute(SHIMMER_TEXT_ATTR, state.official);
        }
      }
      paintedLabels.clear();
    }

    // 把宿主写下的语言无关 textId 映射到本 NS 的词典键。相位猜成语同名键
    // （compressing/done/end → badgeCompressing/badgeDone/badgeEnd），工作态
    // 'working.N' → badgeWorkingN（0..19，与 src/core/ui-signal.js 的
    // WORKING_TEXTS 长度对齐）；越界/未知一律 null（回落到规范中文 text）。
    function textIdToKey(textId) {
      if (textId === "compressing" || textId === "done" || textId === "end") {
        return "badge" + textId[0].toUpperCase() + textId.slice(1);
      }
      if (textId.indexOf("working.") === 0) {
        const n = textId.slice("working.".length);
        if (/^\d+$/.test(n) && Number(n) < 20) return "badgeWorking" + n;
      }
      return null;
    }

    // 显示文本：优先按 textId 经 t() 取当前语种词典的译文；t 缺失 / textId
    // 缺失 / 键未解析（t 返回键名自身）时回落到宿主规范中文 text。空串就是"清空"。
    function resolvedText(liveUi, t) {
      const key = textIdToKey(typeof liveUi.textId === "string" ? liveUi.textId : "");
      if (key === null || typeof t !== "function") return liveUi.text;
      const localized = t(key);
      return (typeof localized === "string" && localized !== key) ? localized : liveUi.text;
    }

    /**
     * 把最新 liveUi 贴成官方运行标签的替换前缀（机制见上方说明）。
     * @param {object} liveUi 宿主写入的 { phase, text, textId }。
     * @param {Function} t 本插件命名空间的 t 席位（badge* 词典）。
     * @returns {void}
     */
    function paintTurnStatus(liveUi, t) {
      if (typeof document === "undefined") return;
      if (!liveUi || typeof liveUi.text !== "string") return;
      let display = resolvedText(liveUi, t);
      // 会话结束清空是承载不变量：end 相位的语义就是"清空"，必须无条件触发，
      // 不能经本地化判断——若将来 badgeEnd 被译成非空字符串，也必须还原官方原文。
      if (display.length !== 0 && (liveUi.text === "" || liveUi.textId === "end")) {
        display = "";
      }
      if (display.length === 0) {
        desiredPrefix = null;
        clearPaintedLabels();
        return;
      }
      desiredPrefix = display;
      ensureLabelObserver();
      paintAllTurnLabels();
    }

    /**
     * 主题感知的颜色别名（浅色 / 暗色两套）。
     *
     * 本插件是 plain JS、无构建步骤，组件用内联 style 而非 CSS Module，因此不能像官方
     * 客户端包那样直接写 `color: var(--dsw-alias-*)`——但**内联 style 里的 var() 照样
     * 沿 DOM 继承解析**，所以做法是：注入一张只定义变量的样式表，组件里只引用
     * `var(--fcts-*)`。这样浅色与暗色各有一份取值，组件代码与主题完全解耦。
     *
     * - **浅色**：逐个取改动前的字面值（`rgba(0,0,0,…)` 系），故浅色外观逐字节不变。
     * - **暗色**（选择器 `body[data-ds-dark-theme]`，官方 ui-theme 切换主题时打的属性）：
     *   改指上游语义别名。**说明文字取 `--dsw-alias-label-primary`**——它在暗色下解析为
     *   `--dsw-static-neutral-bluish-50` = `rgb(249,250,251)`，即纯白；其余次级文字取
     *   `label-secondary`，分隔/边框/底纹取 `border-l*` / `interactive-bg-hover`。这些别名
     *   由官方主题包按肤定义（packages/client/ui-theme/src/styles/design-platform.css），
     *   随主题自动翻转，不必本插件自己判肤。
     *
     * 变量前缀用工作区命名空间 `--fcts-`（falling-ts）。dsh-web-ding 注入的规则逐字相同，
     * 两者谁先注入都一样（幂等按元素 id 判定）。
     */
    const THEME_TOKENS_CSS = [
      "body{",
      "--fcts-text-hint:rgba(0,0,0,0.45);",
      "--fcts-text-muted:rgba(0,0,0,0.55);",
      "--fcts-text-body:rgba(0,0,0,0.65);",
      "--fcts-line:rgba(0,0,0,0.08);",
      "--fcts-line-soft:rgba(0,0,0,0.18);",
      "--fcts-line-strong:rgba(0,0,0,0.22);",
      "--fcts-fill-subtle:rgba(0,0,0,0.14);",
      "--fcts-fill-off:rgba(0,0,0,0.16);",
      "--fcts-fill-off-hover:rgba(0,0,0,0.24);",
      "--fcts-fill-hover:rgba(0,0,0,0.06);",
      "}",
      "body[data-ds-dark-theme]{",
      "--fcts-text-hint:var(--dsw-alias-label-primary);",
      "--fcts-text-muted:var(--dsw-alias-label-secondary);",
      "--fcts-text-body:var(--dsw-alias-label-secondary);",
      "--fcts-line:var(--dsw-alias-border-l2);",
      "--fcts-line-soft:var(--dsw-alias-border-l2);",
      "--fcts-line-strong:var(--dsw-alias-border-l3);",
      "--fcts-fill-subtle:var(--dsw-alias-border-l3);",
      "--fcts-fill-off:var(--dsw-alias-interactive-bg-active);",
      "--fcts-fill-off-hover:var(--dsw-alias-interactive-bg-hover-accent);",
      "--fcts-fill-hover:var(--dsw-alias-interactive-bg-hover);",
      "}",
    ].join("");

    /**
     * 确保主题别名样式表已挂在 <head>（幂等，至多一次）。
     * @returns void
     */
    function ensureThemeTokensInlined() {
      if (typeof document === "undefined") return;
      if (document.getElementById("falling-ts-theme-tokens")) return;
      const el = document.createElement("style");
      el.id = "falling-ts-theme-tokens";
      el.textContent = THEME_TOKENS_CSS;
      document.head.appendChild(el);
    }

    /**
     * 把本插件贡献的语言（ja / ko）注册进 locale 目录。
     *
     * 上游 @deepseek-ai/dsh-client-locale 只内置 zh / en（LOCALE_IDS 为
     * ['zh','en']），'ja'/'ko' 这类 id 是**语言包插件**的扩展点：addLanguage 会把
     * 它们加进设置页「语言」下拉，并让浏览器语言探测（先精确匹配、再按主语言
     * 子标签匹配）能够命中它们。label 用该语言自述，fallback 必须已注册且以 en
     * 为终点——这里直接落到内置的 en。
     *
     * 幂等容错：dsh-web-ding 也贡献同样的两种语言（两个插件必须各自能独立安装，
     * 因此不能约定只由其中一个注册）。先到者拥有该目录项，后到者命中
     * "already registered" 而让位——字典仍按 id 生效，只是该语言目录项的生存期
     * 不归本插件所有。返回的 disposer 只撤销本插件真正添加的那几项。
     * @param {object} locale - ctx.locale（LocaleRuntime）。
     * @returns {() => void} 撤销本插件添加的语言目录项。
     */
    function contributeLanguages(locale) {
      const owned = [];
      const languages = [
        { id: "ja", label: "日本語", fallback: "en" },
        { id: "ko", label: "한국어", fallback: "en" },
      ];
      for (const lang of languages) {
        try {
          owned.push(locale.addLanguage(lang));
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          if (!/is already registered/.test(message)) throw error;
        }
      }
      return () => { for (const dispose of owned) dispose(); };
    }

    /**
     * 注册文案字典、绑定设置命名空间、把分区挂到 settings.section。
     * @param ctx - client 根上下文。
     */
    function apply(ctx) {
      // zh 是键集事实源，en/ja/ko 必须与之逐键对齐（缺键时查找链回落到 en）。
      // 语言目录项与字典分开登记：addLanguage 可能因兄弟插件已注册同一 id 而让位
      // （见 contributeLanguages），字典注册则始终由本插件持有。
      ctx.effect(() => {
        const disposeLanguages = contributeLanguages(ctx.locale);
        const disposeDicts = ctx.locale.register(NS, { zh, en, ja, ko });
        return () => { disposeDicts(); disposeLanguages(); };
      }, "force-compact: dictionaries and languages");
      const t = ctx.locale.bind(NS);
      // ui-settings 的 configForms 服务按命名空间交出 ConfigForm（getSnapshot/subscribe
      // 与旧 settingsScope 同形；status 枚举为 'loading'|'ready'|'unavailable'，set/unset/
      // mutate 现在回答 Promise<boolean>）。
      const scope = ctx.configForms.get(NS_SETTINGS);
      // 观察器只在有活跃相位期间连接（见 paintTurnStatus）；卸载时兜底断开。
      ctx.effect(() => releaseLabelObserver, "force-compact: turn-label observer");
      // 主题别名（浅色/暗色两套取值）。注入失败只影响取色、不影响功能。
      ctx.effect(() => ensureThemeTokensInlined(), "force-compact: theme tokens");
      // 把 configForms 镜像成 uSES 安全的 SnapshotStore（hooks 分区的可观察源）。
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
          // ── Live UI 徽章（机制见上方「官方运行标签的前缀替换器」）──
          // 每次命名空间快照翻转（含宿主写入 liveUi 瞬间），顺路把最新相位文案
          // 贴成官方运行态那行文字的前缀（鲸鱼图标与分隔线不动）。贴皮这一步搭车在
          // 已有 scope.subscribe 回调上，不新增订阅；每秒重渲染由 turn-label
          // MutationObserver 兜住（仅活跃相位期间连接，清空即断开）。幂等纯装饰：
          // 页面上没有 [data-chat-running] 就静默跳过。
          const liveUi = (typeof s.value === "object" && s.value !== null) ? s.value.liveUi : undefined;
          if (s.status === "ready" && typeof liveUi === "object" && liveUi !== null) {
           paintTurnStatus(liveUi, t);
          }
        } catch {
          // Never let a cosmetic derive take down the settings panel.
        }
      };
      // 关键：configForms 的快照自带权威状态枚举 'loading'|'ready'|'unavailable'
      // （见 ui-settings 的 ConfigFormController.derive：命名空间未出现时置
      // 'unavailable'，并非 'loading'）。derive 直接透传该枚举，绝不按 mode 二次
      // 映射——否则会把这个 loopback 实例上 mode='host' 的 'unavailable' 误判为
      // 'loading'，让面板在命名空间未被宿主注册期间永久停留在“加载中…”。
      //
      // 宿主侧 settings 命名空间是惰性安装的（插件 apply 时一次性尽力注册；若彼时
      // settings 服务尚未挂载，则由首个 agent/* 事件补装）。一旦命名空间真正出现，
      // 客户端 configForms 背后共享的 SettingsDescribeMirror 会收到 settings/
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

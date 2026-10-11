/**
 * dsh-force-compact — a DSH Cordis function plugin.
 *
 * Hooks the core model-request seam so the "强制压缩配置" (force-compact)
 * settings are read on **every model request**:
 *
 * - **`agent/request`** (a Waterfall around the frozen call configuration) —
 *   a deliberate **pass-through**: business model requests ride the machine's
 *   `LlmCallConfig` unchanged. The `disableThinking` setting does NOT blanket
 *   business calls (2026-08 semantics revision) — it scopes STRICTLY to the
 *   plugin's own compaction summarization call (`engine/summarizer.js` reads
 *   `settings.disableThinking` and stamps `reasoningEffort: 'off'` on its
 *   `ctx.llm.stream` options; `engine/builtin.js` routes the flag through the
 *   `extra` argument). Reading the settings here on every request means a
 *   `settings.yaml` edit is picked up on the next request regardless of scope.
 * - **`agent/pre-step`** (a Waterfall before each model step) — reads the
 *   session's total context tokens; when they reach the `autoThresholdTokens`
 *   threshold the proposed step is rejected (the model request is NOT made)
 *   and the **latest `retainLatestTokens` of the conversation's tokens** is
 *   RETAINED VERBATIM (everything before that cutoff is compacted in one
 *   batch into a single summary node)
 *   compacted via the `compaction` service's `compactRegion` instead.
 *
 * The plugin also keeps the `session/flush` durability checkpoint: a
 * checkpoint-driven compaction (its own region policy + LLM summarizer,
 * delegated to the `compaction` service's `compactRegion`) so useful history
 * is condensed even between model requests.
 *
 * Layout:
 * - `index.js`         — this file; the Cordis plugin entry (listener registrations).
 * - `core/policy.js`   — fixed compaction-policy knobs (tunables).
 * - `core/settings.js` — the `falling-ts-force-compact` settings namespace (parameters + schema).
 * - `core/log.js`      — the debug-log sink (routes `[force-compact]` lines to `logFile`).
 * - `engine/region.js`     — the plugin's own head-anchored region selection.
 * - `engine/summarizer.js` — the plugin's own one-shot LLM summarizer (preview + shrink gate).
 * - `engine/builtin.js`    — the self-contained compaction engine (official-named `compaction/*` transactions).
 * - `engine/checkpoint.js` — the `session/flush` checkpoint orchestrator: region → delegate to a backend.
 * - `engine/backend.js`    — the unified backend facade (official-service-first, builtin-fallback).
 * - `hooks/guard.js`       — the per-model-request guard: threshold gate + forced compaction (+ legacy `thinkingDisabled` predicate).
 * - `hooks/command.js`     — the `/force-compact` slash command (idle → compact now; busy → queue a force flag).
 * - `hooks/idle.js`        — the turn-end (agent `idle`) forced compaction.
 * - `web/client.js`        — the browser half: the Force-Compact settings.section UI.
 *
 * @module @falling-ts/dsh-force-compact
 */

import { compactSession } from './src/engine/checkpoint.js'
import { buildConfigSchema, bindConfig, readRawSetting } from './src/core/settings.js'
import { ensureDebugLogger } from './src/core/log.js'
// `thinkingDisabled` is imported solely to keep the `guard.thinkingDisabled`
// helper reachable from the plugin root for consumers who DO want the blanket
// "off everywhere" predicate; the active `agent/request` hot path no longer
// consumes it (see the pass-through comment on `__agentRequestListenerBody`).
import { forceCompactIfNeeded, thinkingDisabled, clearStuckCompressingBanner } from './src/hooks/guard.js'
void thinkingDisabled
import { registerCommand } from './src/hooks/command.js'
import { handleAgentStatus } from './src/hooks/idle.js'
import { publishRequesting, publishResponding, publishTooling } from './src/core/ui-signal.js'
import { guardFn, installCrashNet } from './src/core/crashnet.js'

/** @type {string} the function plugin's display name. */
export const name = 'force-compact'

/**
 * The plugin's schemastery `Config` — the settings form namespace the Loader
 * auto-derives for this entry (harness 0.1.7's Config-driven settings model,
 * which replaced the removed `settings.register(ns, schema, { base })` API).
 *
 * The namespace IS this entry's loader id (`falling-ts-force-compact`, see
 * cordis.patch.yml). `apply` receives the resolved values and binds them for the
 * Host reads. Top-level await because schemastery is resolved lazily (bare
 * specifier first, then the vendored copy for a standalone checkout);
 * `undefined` leaves the entry without a settings form, and reads fall back to
 * `DEFAULTS`.
 */
export const Config = await buildConfigSchema()

/**
 * Per-session COMPRESSION SLOT — one in-flight `compactSession` operation per
 * session id (keyed by `session.id`, value the SETTLING PROMISE of that
 * operation). Process-local, bounded naturally by the number of live sessions —
 * no timer, no persistent state.
 *
 * WHY THE LISTENER MUST BE SYNCHRONOUS (the "third send wedges" root cause):
 * `session/flush` is an AWAITED `parallel` checkpoint — the dispatcher runs every
 * listener via `Promise.allSettled` and proceeds once they ALL settle. One of
 * those listeners is the PERSISTENCE COORDINATOR's own handler, which awaits
 * `live.writes.flush()` — a SHARED write-behind barrier for the session id. If
 * OUR listener `await`s `compactSession` INSIDE the checkpoint (as it used to),
 * we participate in the flush's await path: our compaction's durable appends
 * enqueue onto the coordinator's PER-ID serial `chains` bucket, and when two
 * `sessions.flush` callers overlap on the same id within one event-loop tick
 * (observed live: two flush checkpoints a millisecond apart, the inner firing
 * while the outer was mid-`compactRegion`), the barrier and the per-id queue
 * enter a mutual-wait interleave — the barrier waits on a `serialize` op whose
 * `prior` never settles, so the barrier never resolves, so the outer `sessions.
 * flush` never returns, so the caller's pre-step waterfall never resumes, and
 * EVERY later `session.list` / `history` for that id queues behind the poisoned
 * `prior` forever (event loop alive, CPU idle, specific id permanently stalled).
 *
 * FIX — decouple the compaction FROM the checkpoint's await path:
 * 1. The listener STARTS the compaction but does NOT `await` it; it returns
 *    immediately (synchronously), so we are never on the flush's await path and
 *    cannot hold the barrier open. The `SessionStore.flush` dispatcher sees our
 *    listener settle instantly.
 * 2. A PER-ID SLOT serializes compactions: if a compaction for the same id is
 *    ALREADY running, a repeat `session/flush` dispatch STARTS NOTHING (skip);
 *    the slot clears only when the in-flight op SETTLES, so a following flush
 *    after it completes starts a fresh attempt. No concurrent same-id
 *    `compactRegion` calls, no re-entrant recursion, no barrier interleave.
 *
 * DURABILITY NOTE: the checkpoint still GUARANTEES the compaction was STARTED by
 * the time it fires (started-before-return, not completed-before-return). Ordering
 * with the next flush is preserved because the slot suppresses overlap until
 * settlement. A crash mid-compaction loses the slot (process-local) and relies on
 * the durable `compaction/*` bracket (an unclosed `compaction/start` surfaces as
 * a `busy` assertion on reload — the expected, safe failure mode).
 * @type {Map<string, Promise<void>>}
 */
const compactSlot = new Map()

/**
 * Register the model-request Waterfalls, the `session/flush` listener, and the
 * `falling-ts-force-compact` settings namespace (the "强制压缩配置" surface).
 *
 * `compaction` is a runtime dependency provided by the preset plane
 * (`include:agent-presets:compaction-basic`, enabled and mounted by default).
 * In modern harness compositions it is mounted **per agent realm** (each preset
 * isolates it), so the plugin-GLOBAL `ctx.get('compaction')` is `undefined`
 * while the listener's OWN context — `this` inside an `agent/*` callback, the
 * agent's scoped context — resolves the instance. Every compaction path therefore
 * captures the LISTENER context (`ctx.on(event, function (p, n) { … })` binds
 * `this` to the dispatch context) and locates the service through it, with a
 * host-global fallback (see `engine/backend.js`). Missing-service cases are
 * still guarded (`undefined` → skip with a log), so a gap never blocks a
 * listener. The plugin therefore declares no `inject` — profile entries activate
 * at process boot, before the preset plane mounts the service, and a boot-time
 * `inject` would fail the boot assertion. `agents`, `settings`, `tokenMeter`, and
 * `commands` are likewise optional: each is read with `ctx.get(...)` and guarded
 * against `undefined` (the plugin falls back to its composition defaults, a
 * coarse estimate, or a skipped registration).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
const __applyInner = (ctx, config) => {
  // The resolved plugin Config (schemastery volatile refs) — every Host read goes
  // through this holder. Bound FIRST so any listener firing during this apply
  // already sees live values rather than DEFAULTS.
  bindConfig(config)
  ctx.logger.info('[force-compact] apply START; settings=' + (ctx.get('settings') !== undefined ? 'present' : 'ABSENT') + ' compaction=' + (ctx.get('compaction') !== undefined ? 'present' : 'ABSENT'))
  // Declare this plugin's OWN settings page (web/client.js registers a
  // settings.section), so the harness must not auto-generate one.
  //
  // Harness 0.1.7 replaced the old `settings.register(ns, schema, { base })` API
  // with a Config-driven model: the form namespace IS this entry's loader id
  // (`falling-ts-force-compact`, see cordis.patch.yml) and the fields come from
  // the `Config` schema this module exports. Nothing is registered at runtime,
  // so the old lazy-retry installation is gone. The `settings` service still
  // mounts later than this plugin's boot effect, hence the lazy `ctx.inject`.
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[force-compact] settings.configure declaration failed (cosmetic only) — ${message}`)
  }

  // Route this plugin's own `[force-compact]` log lines to a durable file when
  // debug logging is enabled. Installed lazily: `ensureDebugLogger` is invoked
  // at the top of each guarded listener (the first moment real work runs) and
  // installs at most once (an idempotent latch), so repeated invocations are a
  // cheap boolean check. It writes through native Node `fs` to `logFile`
  // (default `~/.dsh/logs/dsh-force-compact.log`, under the shared user
  // `$DSH_HOME`, kept out of any single checkout) — bypassing the product `fs`
  // service's workspace fence, which refuses an absolute user-home path.
  // Gated by the `debug` setting (default `true`). Observer-only: a failure
  // here never disturbs the request paths.
  const maybeInstallDebugSink = () => {
    void ensureDebugLogger(ctx).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[force-compact] debug log sink failed — ${message}`)
    })
  }

  // Install the debug-log sink ONCE NOW, at boot (fire-and-forget). When a
  // service is already mounted this completes it immediately; when it is still
  // undefined (the usual case at this early point — the `agent-presets:*` plane
  // mounts shortly after) the guarded listeners re-attempt it and the install
  // latch deduplicates. Observer-only: a failure never disturbs requests.
  maybeInstallDebugSink()

  // Each registration is wrapped in a labeled, logged try/catch so a real-
  // runtime throw is PINPOINTED (name + full stack) and CONTAINED — a bad
  // effect in one registration must not prevent the other listeners from
  // mounting. Keeping these lightweight guards is deliberate: an optional
  // feature (a missing `commands` service, a transient settings glitch)
  // should degrade gracefully rather than abort the whole entry.
  const guard = (label, fn) => {
    try {
      fn()
    } catch (error) {
      const detail = error instanceof Error ? (error.stack || error.message) : String(error)
      ctx.logger.error(`[force-compact][diag] FAILED to register '${label}' — ${detail}`)
    }
  }

  // Register the `/force-compact` slash command (idle → compact now; busy →
  // queue a force flag the `agent/pre-step` hook consumes). NO-OP at boot when
  // the `commands` service is not mounted YET (typical: the service arrives
  // with the preset plane shortly after this plugin's boot-time effect runs).
  // Mirrors the settings-namespace lazy-install pattern: attempt at boot, then
  // re-attempt at the top of EVERY guarded listener (`agent/request`,
  // `agent/pre-step`, etc.) until it settles. A successful registration is
  // idempotent (registering the same-name twice is a no-op at worst), but we
  // settle on the first success so subsequent listeners pay only a boolean
  // check. A permanent absence (deployment genuinely lacks `commands`) leaves
  // the listeners trying on each event until they give up — that is intentional
  // degradation: the rest of the plugin continues working, the command simply
  // remains unregistered.
  const commandState = { settled: false, warnedAbsent: false }
  const COMMAND_WARN_AFTER_MS = 10 * 60 * 1000
  const commandWarnScheduled = { value: false }
  // Make a PERMANENTLY absent `commands` service diagnosable. While the service
  // is simply still arriving (the normal boot→preset-plane window) nothing is
  // emitted; only if the command has STILL not registered ten minutes after
  // `apply` does a single warn explain the silent symptom (empty slash-command
  // picker). Self-cancelling: nothing left running past the plugin's lifetime.
  const scheduleAbsenceWarning = () => {
    if (commandState.settled || commandWarnScheduled.value) return
    commandWarnScheduled.value = true
    ctx.effect(() => () => {
      if (timerValue !== undefined) clearTimeout(timerValue)
      timerValue = undefined
    }, 'force-compact: command-absence warning cleanup')
    let timerValue
    timerValue = setTimeout(() => {
      timerValue = undefined
      if (!commandState.settled) {
        ctx.logger.warn(
          '[force-compact] /force-compact command still UNREGISTERED 10 min after plugin boot — '
          + 'the `commands` service does not appear to be mounted in this composition.',
        )
      }
    }, COMMAND_WARN_AFTER_MS)
  }
  const maybeRegisterCommand = () => {
    if (commandState.settled) return
    if (typeof registerCommand !== 'function') return
    const ok = (() => {
      try { return registerCommand(ctx) === true }
      catch (error) {
        const message = error instanceof Error ? (error.stack || error.message) : String(error)
        if (!commandState.warnedAbsent) {
          commandState.warnedAbsent = true
          ctx.logger.warn(`[force-compact] /force-compact command registration THREW — ${message}`)
        }
        return false
      }
    })()
    if (ok) {
      commandState.settled = true
      ctx.logger.info('[force-compact] /force-compact command registered (deferred)')
      return
    }
    scheduleAbsenceWarning()
  }
  // NOTE: no boot-time invocation here. At `apply` execution the `commands`
  // service is guaranteed absent (preset plane hasn't mounted yet), so a
  // boot attempt would only emit a misleading "MISSING" diagnostic. Instead,
  // EVERY guarded listener invokes `maybeRegisterCommand()` as its first
  // action; the first successful attempt settles the latch permanently.

  // The llm/stream LiveUI watermark hook that used to live here
  // (`src/hooks/wire-rewrite.js`) is RETIRED: the "fresh random working pair per
  // LLM call" watermark is superseded by the three explicit agent-action phases
  // published from the `agent/request` / `agent/assistant-stream` /
  // `tools/pre-execute` seams registered below.

  // Hook the core model request: a DELIBERATE PASS-THROUGH (2026-08 semantics
  // revision) — business model requests carry the machine's own reasoning
  // effort UNCHANGED; `disableThinking` scopes strictly to this plugin's
  // compaction summarization call. `agent/request` is a Waterfall — `await
  // next()` yields the config the machine would use; we forward it as-is. The
  // listener stays registered because the seam MUST `next()` and the lazy
  // install hooks below ride its first activation.
  guard('agent/request listener', () => ctx.on('agent/request', async (payload, next) => {
    // SAFETY ENVELOPE: this is a PER-MODEL-REQUEST seam — an anomaly during
    // the lazy installs must degrade to PASSING THROUGH the original config so
    // the request proceeds normally, never crashing the request chain.
    try {
      maybeInstallDebugSink()
      maybeRegisterCommand()
      // LIVE UI SIGNAL — "模型请求中": the agent has issued a model request and
      // is waiting for the model's first token (published as "模型响应中" by the
      // `agent/assistant-stream` listener below). FIRE-AND-FORGET: a settings
      // write must never sit on the request's critical path, and the publisher
      // swallows its own rejections. Note this seam is traversed ONLY by the
      // agent loop's own business requests — the plugin's compaction
      // summarization call goes straight to `ctx.llm.stream` — so a
      // compaction-time request can never publish this phase. It IS traversed
      // once per RETRY attempt, which is correct: each attempt is a fresh wait.
      void publishRequesting(ctx)
      // NOTE (2026-09): the former CONVERSATION-START Live-UI forced override
      // (publishWorkingOnStart, a fresh random working pair per conversation
      // start) is REMOVED. The badge is now cleared at conversation END
      // instead: hooks/idle.js publishes an empty `""` text on every idle
      // transition (ui-signal `publishEnd`), wiping stale bracket-form residue
      // and any lingering phase in one push.
      return await __agentRequestListenerBody(ctx, payload, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[force-compact] agent/request listener degraded — forwarding config unchanged (swallowed: ${message})`)
      try { return await next() } catch { return undefined }
    }
  }))

  // LIVE UI SIGNAL — "模型响应中": the model's FIRST token has arrived, and the
  // phase lasts until the response ends (the next agent action then overwrites
  // it). Fired on the `chunk` frame with `index === 0` — the first chunk of that
  // attempt. The attempt's `start` frame deliberately does NOT fire it: the
  // attempt opens before any token has arrived, which is still
  // `publishRequesting`'s span. These frames are emitted ONLY by the agent
  // loop's live attempt, so a compaction summarization stream (which the
  // summarizer consumes directly from `ctx.llm.stream`) never produces one.
  guard('agent/assistant-stream listener', () => ctx.on('agent/assistant-stream', ({ frame } = {}) => {
    try {
      if (frame === null || typeof frame !== 'object') return
      if (frame.type !== 'chunk' || frame.index !== 0) return
      // FIRE-AND-FORGET: chunk dispatch is on the live streaming path — a
      // settings write must never delay a token, and the publisher never throws.
      void publishResponding(ctx)
    } catch { /* a status hint must never disturb the stream */ }
  }))

  // LIVE UI SIGNAL — "工具执行中": a non-model, agent-internal operation is
  // running (a model-requested tool call). Registered as a Waterfall around the
  // dispatch, so it MUST reach `next()` on every path; the publication rides
  // fire-and-forget ahead of the chain. No completion publisher is needed: when
  // the tool settles, the loop immediately issues its next model request, which
  // publishes "模型请求中" over it.
  guard('tools/pre-execute listener', () => ctx.on('tools/pre-execute', (_exec, next) => {
    try {
      void publishTooling(ctx)
    } catch { /* never block a tool dispatch for a status hint */ }
    return next()
  }))

/** Body of the `agent/request` listener; wrapped by its safe envelope above. */
async function __agentRequestListenerBody(ctx, payload, next) {
  const config = await next()
  void payload
  void ctx
  // DELIBERATE PASS-THROUGH (2026-08 semantics revision): the `disableThinking`
  // setting now scopes STRICTLY to THIS PLUGIN'S OWN compaction summarization
  // call (enforced at `summarizer.js`, where `extra.reasoningEffort` is sourced
  // from `settings.disableThinking`). Business model requests ride the machine's
  // config UNCHANGED — whatever the deployment's request header carried is
  // honored, and a `settings.yaml` edit is picked up on the next request because
  // this listener still runs every request. `agent/request` sits on the agent
  // LOOP seam: business conversation steps only — the plugin's (and the
  // official engine's) summarization calls never traverse it, so scoping the
  // flag here would have stamped EVERY business call while reaching neither
  // summarizer. The seam itself MUST still `await next()` (documented
  // contract), hence this listener remains registered.
  return config
}

  // Before each model step, run a forced/threshold-triggered compaction as a
  // side effect. `agent/pre-step` is a Waterfall: after the hook processing
  // finishes it MUST route back through the original step decision (`next()`)
  // on every path — the compaction is a side effect; the step decision itself
  // is always `next()`'s (the same pattern as the official `compaction-basic`:
  // compact, then unconditionally `return next()`). Returning a value such as
  // `{ kind: 'reject' }` without ever calling `next()` stalls the request chain.
  guard('agent/pre-step listener', () => ctx.on('agent/pre-step', async (payload, next) => {
    // SAFETY ENVELOPE: the `maybeInstall*` prologue and the terminal `next()`
    // hop sit OUTSIDE the inner compaction try/catch — a throwing install or a
    // rejecting `next()` would otherwise escape the per-step seam. Contain them
    // so the step ALWAYS routes through `next()` (the Waterfall requirement).
    try { maybeInstallDebugSink() } catch { /* non-fatal */ }
    try { maybeRegisterCommand() } catch { /* non-fatal */ }
    const agent = payload && payload.agent
    const signal = payload && payload.signal
    // (2026-09) Model-request hook: clear a STALE pinned "[强制压缩中>>]" banner
    // on the live-UI badge when NO compaction is genuinely in flight (the "总是
    // 卡住" fix). Runs on EVERY model step — awaited, before the compaction attempt
    // below — so the phase write lands FIRST and a fresh COMPRESSING banner (if this
    // very step ends up compacting) still wins over it (no write race). The helper
    // self-swallows all errors, so this await can never throw into the Waterfall
    // `next()` hop.
    await clearStuckCompressingBanner(ctx, agent && agent.session)
    if (agent !== undefined && agent !== null && (signal === undefined || !signal.aborted)) {
      try {
        // The resolver locates the per-realm compaction backend through
        // `agent.ctx` (see `engine/backend.js`). We pass the PLUGIN-GLOBAL
        // `ctx` as the fallback context and read the mode once here (raw, cheap)
        // so the hot path never pays a full-settings-parse cost.
        const mode = await readRawSetting(ctx, 'compactionMode')
        await forceCompactIfNeeded(ctx, agent, signal, mode)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[force-compact] ${(agent && typeof agent.id === 'string') ? agent.id : '?'}: request guard failed — ${message}`)
      }
    }
    try {
      return await next()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[force-compact] agent/pre-step next() hop degraded (swallowed: ${message})`)
      return undefined
    }
  }))

  // Turn-end forced compaction: when `turnEndForceCompactionEnabled` is on,
  // compact the earliest `turnEndCompactionRatio` of the conversation's tokens
  // when the agent transitions to `idle` (all turns done, including sub-
  // agents, before the next human turn).
  guard('agent/status listener', () => ctx.on('agent/status', (payload) => {
    // This listener fires FIRST for a fresh session (the agent goes `idle`
    // almost immediately) — often before ANY `agent/request` / `agent/pre-step`
    // event has arrived, i.e. possibly before the preset plane has mounted the
    // `commands` service. It therefore joins the deferred-registration loop too
    // (as the other guarded listeners do) so the first idle transition is what
    // typically settles the `/force-compact` command registration.
    maybeRegisterCommand()
    // Fire-and-forget: trace listener liveness on the idle transition, read the
    // compactionMode raw (cheap), then hand off to the turn-end handler which
    // locates the per-realm compaction backend via `agent.ctx`.
    // SAFETY: this IIFE has NO other error boundary — an anomaly (a missing
    // `payload.agent.session`, a rejecting `readRawSetting`, or a throwing
    // `handleAgentStatus`) would otherwise become an UNHANDLED REJECTION. Attach
    // a `.catch` so every path settles cleanly. `handleAgentStatus` itself is
    // envelope-guarded; this is belt-and-braces for the sid extraction + mode
    // read that precede it.
    void (async () => {
      const st = (payload && typeof payload === 'object') ? payload.status : undefined
      if (st === 'idle') {
        const agentObj = (payload && typeof payload === 'object' && payload.agent && typeof payload.agent === 'object') ? payload.agent : undefined
        const sess = (agentObj && agentObj.session) ? agentObj.session : undefined
        const sid = (sess && typeof sess.id === 'string') ? sess.id : '?'
        ctx.logger.debug(`[force-compact] agent/status fired: idle for ${sid} — evaluating turn-end compaction`)
      }
      const mode = await readRawSetting(ctx, 'compactionMode')
      await handleAgentStatus(ctx, payload, mode)
    })()
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[force-compact] agent/status idle-turn handler degraded (swallowed) — ${message}`)
      })
  }))

  // Checkpoint-driven compaction: condense useful history at each durability
  // checkpoint (its own region policy + LLM summarizer, delegated to
  // compactRegion), independent of the per-request guard.
  ctx.logger.info('[force-compact][diagnostic] apply END (all registrations attempted)')

  guard('session/flush listener', () => ctx.on('session/flush', (session) => {
    // SAFETY ENVELOPE: `session/flush` is an AWAITED parallel checkpoint — a
    // throw escaping this listener would break the persistence checkpoint on
    // EVERY flush. The synchronous prologue (service installs, agent lookup,
    // slot check) is NOT covered by the async IIFE's own `.catch`, so the whole
    // callback body is wrapped: any anomaly logs and returns cleanly. The async
    // IIFE keeps its own `.catch`/`.finally` for the background compaction op.
    try {
      maybeInstallDebugSink()
      maybeRegisterCommand()
      const sid = (session && typeof session.id === 'string') ? session.id : '?'
      const agents = ctx.get('agents')
      if (agents === undefined) return
      const agent = agents.get(sid)
      if (agent === undefined || agent === null) {
        ctx.logger.debug(`[force-compact] ${sid}: no live agent — skipping`)
        return
      }
      // COMPRESSION SLOT: if a flush-driven compaction for this session id is
      // ALREADY running, a repeat `session/flush` dispatch starts NOTHING and
      // returns immediately — suppressing the concurrent / re-entrant same-id
      // `compactRegion` call that interleaves with the persistence coordinator's
      // per-id chain (the "third send wedges" deadlock vector). The listener is
      // SYNCHRONOUS: it starts the op and returns at once so it is never on the
      // checkpoint's await path (which is what lets the write-behind barrier
      // settle and `session.list` stay responsive). See `compactSlot` above.
      if (compactSlot.has(sid)) {
        ctx.logger.debug(`[force-compact] ${sid}: session/flush dispatched while a compaction slot is still settling — starting no duplicate (serialized by the slot)`)
        return
      }
      const controller = new AbortController()
      // Start the compaction, attach settlement cleanup, store the settling
      // promise as the id's slot. Never `await`ed here — the listener returns
      // before this op progresses, keeping the checkpoint non-blocking.
      const op = (async () => {
        const mode = await readRawSetting(ctx, 'compactionMode')
        await compactSession(ctx, agent, controller, mode)
      })()
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`[force-compact] ${sid}: flush-triggered compaction failed — ${message}`)
        })
        .finally(() => { compactSlot.delete(sid) })
      compactSlot.set(sid, op)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const sid = (session && typeof session.id === 'string') ? session.id : '?'
      ctx.logger.warn(`[force-compact] ${sid}: session/flush listener degraded (swallowed) — ${message}`)
    }
  }))
}

/**
 * Plugin entry — the UNIVERSAL-CRASH-NET-covered form of {@link __applyInner}.
 *
 * Every public entry in the plugin is routed through {@link guardFn}: the
 * wrapper catches any throw (sync or promise rejection) crossing this
 * boundary, appends a full diagnostic (function name, thrownAt
 * `file:line:col`, deepest plugin frame, nearest non-plugin frame, full call
 * stack) to the durable crash log, and propagates the original outcome
 * unchanged. `apply` is called ONCE per fiber at boot — the process-wide net
 * ({@link installCrashNet}) is installed from inside the inner body before
 * any listener is registered.
 *
 * `config` is the Loader-resolved plugin Config (schemastery volatile refs) and
 * MUST be forwarded: the Host reads every tunable through those refs, so
 * dropping it would silently pin every setting to `DEFAULTS`.
 */
export const apply = guardFn('index.apply', (ctx, config) => {
  // Process-wide net — at most one install per process, before anything else.
  installCrashNet()
  return __applyInner(ctx, config)
})

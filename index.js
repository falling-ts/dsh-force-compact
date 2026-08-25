/**
 * dsh-force-compact — a DSH Cordis function plugin.
 *
 * Hooks the core model-request seam so that, on **every model request**, the
 * "强制压缩配置" (force-compact) settings are read:
 *
 * - **`agent/request`** (a Waterfall around the frozen call configuration) —
 *   when the `disableThinking` setting is on, the returned `LlmCallConfig`
 *   carries `reasoningEffort: 'off'`, which the LLM adapter maps to
 *   `thinking: { type: 'disabled' }`. Every model request is therefore sent
 *   with thinking/reasoning disabled.
 * - **`agent/pre-step`** (a Waterfall before each model step) — reads the
 *   session's total context tokens; when they reach the `autoThresholdTokens`
 *   threshold the proposed step is rejected (the model request is NOT made)
 *   and the **earliest `autoEarliestRatio`** of the conversation's tokens is
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
 * - `engine/builtin.js`    — the self-contained compaction engine (`fc-compact/*` transactions).
 * - `engine/checkpoint.js` — the `session/flush` checkpoint orchestrator: region → delegate to a backend.
 * - `engine/backend.js`    — the unified backend facade (official-service-first, builtin-fallback).
 * - `hooks/guard.js`       — the per-model-request guard: threshold gate + forced compaction + thinking-off.
 * - `hooks/command.js`     — the `/force-compact` slash command (idle → compact now; busy → queue a force flag).
 * - `hooks/idle.js`        — the turn-end (agent `idle`) forced compaction.
 * - `web/client.js`        — the browser half: the Force-Compact settings.section UI.
 *
 * @module @falling-ts/dsh-force-compact
 */

import { compactSession } from './src/engine/checkpoint.js'
import { registerNamespace, readRawSetting } from './src/core/settings.js'
import { ensureDebugLogger } from './src/core/log.js'
import { forceCompactIfNeeded, thinkingDisabled } from './src/hooks/guard.js'
import { registerCommand } from './src/hooks/command.js'
import { handleAgentStatus } from './src/hooks/idle.js'
import { registerLlmStreamHook } from './src/hooks/wire-rewrite.js'

/** @type {string} the function plugin's display name. */
export const name = 'force-compact'

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
export function apply(ctx) {
  ctx.logger.info('[force-compact] apply START; settings=' + (ctx.get('settings') !== undefined ? 'present' : 'ABSENT') + ' compaction=' + (ctx.get('compaction') !== undefined ? 'present' : 'ABSENT'))
  // Register the `falling-ts-force-compact` settings namespace. This is done
  // LAZILY and IDEMPOTENTLY rather than in a boot-time effect because the
  // `settings` service (and the schemastery schema builder it depends on) can
  // arrive well AFTER this plugin's boot-time effects run — the same late-mount
  // ordering that makes a boot-time `ctx.get('fs')` observe `undefined`. A
  // boot-time registration attempt would silently no-op and leave the settings
  // panel permanently stuck on "loading". Instead it is attempted at the top of
  // each guarded listener (where services are guaranteed live) until it settles:
  // `settingsState.attempted` records a settled outcome, `installed` means the
  // namespace is registered and further attempts are a cheap early return.
  const settingsState = { settled: false, installed: false, warnedSchemas: false, scheduled: false }
  // Schedule a bounded retry of the namespace install. Called only while the
  // `settings` service is still absent at the attempt site (boot or a guarded
  // listener that ran before the preset plane mounted it). Each retry re-checks;
  // on success the latch settles and the timer self-clears. Because it settles
  // and cancels itself on completion, it is installation bookkeeping, not a
  // persistent timer or piece of long-lived state.
  const RETRY_DELAY_MS = 750
  const RETRY_MAX_ATTEMPTS = 40
  const retryTimer = { value: undefined }
  const maybeRetryRegister = () => {
    if (settingsState.settled || retryTimer.value !== undefined) return
    let attempts = 0
    const attempt = () => {
      retryTimer.value = undefined
      if (settingsState.settled) return
      attempts += 1
      void (async () => {
        const result = await tryRegisterOnce()
        if (result) {
          // Settled (success, or a terminal "schema build failed" outcome).
          if (retryTimer.value !== undefined) clearTimeout(retryTimer.value)
          retryTimer.value = undefined
          return
        }
        // Still missing; bound the retry count so a genuinely absent service
        // cannot spin forever. After the cap we stop scheduling and leave the
        // guarded listeners (agent/* events) as the final safety net.
        if (attempts >= RETRY_MAX_ATTEMPTS) {
          settingsState.settled = true
          return
        }
        if (settingsState.settled) return
        retryTimer.value = setTimeout(attempt, RETRY_DELAY_MS)
      })().catch(() => {})
    }
    attempt()
  }
  const tryRegisterOnce = async () => {
    if (settingsState.settled) return true
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.register !== 'function') {
      // Settings service not mounted yet; keep retrying (do NOT settle).
      return false
    }
    try {
      const ok = await registerNamespace(ctx)
      settingsState.settled = true
      if (ok) {
        settingsState.installed = true
        ctx.logger.info('[force-compact] registered settings namespace "falling-ts-force-compact"')
      } else {
        // `settings` exists but `buildSchema()` failed (typically the
        // schemastery bare-module import could not resolve in this loader).
        // Settle so we stop retrying, but WARN so the silent no-op is
        // diagnosable; warn only once.
        if (!settingsState.warnedSchemas) {
          settingsState.warnedSchemas = true
          ctx.logger.warn(
            '[force-compact] settings present but schema build failed — ' +
              'namespace "falling-ts-force-compact" NOT registered (check @deepseek-ai/schemastery resolvability)',
          )
        }
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      // Transient failure: keep retrying (do NOT settle), warn once.
      if (!settingsState.warnedSchemas) {
        settingsState.warnedSchemas = true
        ctx.logger.warn(`[force-compact] settings namespace registration threw — ${message}`)
      }
      return false
    }
  }
  // Entry point invoked at boot (eager) and atop each guarded listener. Tries
  // once NOW; if the service is absent it schedules a bounded self-cancelling
  // retry instead of giving up, so a cold-start with no agent traffic still
  // lands the namespace (and therefore un-sticks the settings panel).
  const maybeRegisterSettingsNamespace = () => {
    if (settingsState.settled) return
    void (async () => {
      const ok = await tryRegisterOnce()
      if (!ok) maybeRetryRegister()
    })().catch(() => {})
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

  // Attempt BOTH installations ONCE NOW, at boot (fire-and-forget). When a
  // service is already mounted this completes it immediately; when it is still
  // undefined (the usual case at this early point — the `agent-presets:*` plane
  // mounts shortly after) the settings installer additionally schedules a
  // bounded, self-cancelling retry rather than waiting passively for the first
  // agent/* event. Doing this eagerly matters for the settings namespace
  // specifically: a browser client that opens the settings page BEFORE any
  // agent activity would otherwise wait indefinitely for the namespace to
  // appear. The eager boot call and the guarded-listener calls are safe to
  // overlap (the latches deduplicate), and these are observer-only paths whose
  // failures never disturb requests.
  maybeInstallDebugSink()
  maybeRegisterSettingsNamespace()

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

  // Cancel the pending namespace-install retry when this fiber tears down, so
  // no stray timer survives plugin stop/removal. `clearTimeout(undefined)` is a
  // safe no-op when nothing is scheduled.
  guard('settings install retry cleanup', () => {
    ctx.effect(() => () => {
      if (retryTimer.value !== undefined) clearTimeout(retryTimer.value)
    }, 'force-compact: settings install retry cleanup')
  })

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

  // The llm/stream wire-rewrite hook (appends `reasoning_effort:"none"` for
  // OpenAI-compatible targets like :8080 llama.cpp when `disableThinking` is
  // on). Registered lazily via `maybeInstallWireRewrite` from each guarded
  // listener below — same defer pattern as the command registration. The
  // hook lives at `src/hooks/wire-rewrite.js`.
  const maybeInstallWireRewrite = () => {
    registerLlmStreamHook(ctx)
  }

  // Hook the core model request: when "disable thinking" is on, every model
  // request carries reasoningEffort: 'off'. Reading the settings here (per
  // request) means a settings.yaml edit is picked up on the next request.
  // `agent/request` is a Waterfall — `await next()` yields the config the
  // machine would use; returning a replacement switches it.
  guard('agent/request listener', () => ctx.on('agent/request', async (payload, next) => {
    maybeInstallDebugSink()
    maybeRegisterSettingsNamespace()
    maybeRegisterCommand()
    maybeInstallWireRewrite()
    const config = await next()
    if (!payload || config === undefined) return config
    if (!(await thinkingDisabled(ctx))) {
      // disableThinking=false (setting off): leave the machine's config untouched.
      ctx.logger.debug('[force-compact] agent/request: disableThinking=false — leaving reasoning effort unchanged')
      return config
    }
    if (config.reasoningEffort === 'off') {
      // Already off — nothing to switch (still proves the guard is active on this request).
      ctx.logger.debug('[force-compact] agent/request: reasoningEffort already off — no change')
      return config
    }
    ctx.logger.debug(`[force-compact] agent/request: applying reasoningEffort=off (disableThinking=true) — original=${config.reasoningEffort ?? '(unset)'}`)
    return { ...config, reasoningEffort: 'off' }
  }))

  // Before each model step, run a forced/threshold-triggered compaction as a
  // side effect. `agent/pre-step` is a Waterfall: after the hook processing
  // finishes it MUST route back through the original step decision (`next()`)
  // on every path — the compaction is a side effect; the step decision itself
  // is always `next()`'s (the same pattern as the official `compaction-basic`:
  // compact, then unconditionally `return next()`). Returning a value such as
  // `{ kind: 'reject' }` without ever calling `next()` stalls the request chain.
  guard('agent/pre-step listener', () => ctx.on('agent/pre-step', async (payload, next) => {
    maybeInstallDebugSink()
    maybeRegisterSettingsNamespace()
    maybeRegisterCommand()
    maybeInstallWireRewrite()
    const agent = payload && payload.agent
    const signal = payload && payload.signal
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
        ctx.logger.warn(`[force-compact] ${agent.id}: request guard failed — ${message}`)
      }
    }
    return next()
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
    maybeInstallWireRewrite()
    // Fire-and-forget: trace listener liveness on the idle transition, read the
    // compactionMode raw (cheap), then hand off to the turn-end handler which
    // locates the per-realm compaction backend via `agent.ctx`.
    void (async () => {
      const st = payload && payload.status
      if (st === 'idle') {
        const sid = payload && payload.agent ? payload.agent.session.id : '?'
        ctx.logger.debug(`[force-compact] agent/status fired: idle for ${sid} — evaluating turn-end compaction`)
      }
      const mode = await readRawSetting(ctx, 'compactionMode')
      await handleAgentStatus(ctx, payload, mode)
    })()
  }))

  // Checkpoint-driven compaction: condense useful history at each durability
  // checkpoint (its own region policy + LLM summarizer, delegated to
  // compactRegion), independent of the per-request guard.
  ctx.logger.info('[force-compact][diagnostic] apply END (all registrations attempted)')

  guard('session/flush listener', () => ctx.on('session/flush', async (session) => {
    maybeInstallDebugSink()
    maybeRegisterSettingsNamespace()
    maybeRegisterCommand()
    const agents = ctx.get('agents')
    if (agents === undefined) return
    const agent = agents.get(session.id)
    if (agent === undefined || agent === null) {
      ctx.logger.debug(`[force-compact] ${session.id}: no live agent — skipping`)
      return
    }
    const controller = new AbortController()
    try {
      const mode = await readRawSetting(ctx, 'compactionMode')
      await compactSession(ctx, agent, controller, mode)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[force-compact] ${session.id}: compaction failed — ${message}`)
    }
  }))
}

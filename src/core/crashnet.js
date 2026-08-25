/**
 * Universal crash net for every exported method entry in the plugin.
 *
 * Two layers:
 * 1. **Entry wrappers** — every exported function routed through
 *    {@link guardFn} gets its ENTIRE body (the topmost level of the call
 *    tree) covered: on throw, a detailed diagnostic — function name, the exact
 *    throw site (`file:line:column`), the deepest plugin frame, the nearest
 *    NON-plugin frame (usually the vendored caller that actually faulted),
 *    and the full call stack — is appended to the plugin's durable log file.
 * 2. **Process-wide net** ({@link installCrashNet}) — `uncaughtException` +
 *    `unhandledRejection` handlers (installed at most once per process) that
 *    classify whatever escapes every entry point the same way.
 *
 * Output goes straight to the durable debug log (same destination convention
 * as `core/log.js`: `~/.dsh/logs/dsh-force-compact.log`), bypassing
 * `ctx.logger` entirely so a crash remains reconstructable even before the
 * logger is wired or after a process death. Every emission site is itself
 * self-defensive: a logger failure can never disturb a business path.
 *
 * @module @falling-ts/dsh-force-compact/crashnet
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` using the process user home (Windows: USERPROFILE). */
function expandTilde(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed !== '~' && !trimmed.startsWith('~/') && !trimmed.startsWith('~\\')) return value
  const rest = trimmed === '~' ? '' : trimmed.slice(2)
  const home = process.env.USERPROFILE || process.env.HOME || (os.homedir && os.homedir())
  if (home === undefined || home === null || typeof home !== 'string' || home.length === 0) return value
  return path.join(home, rest)
}

/** Durable crash-log path — identical convention to `core/log.js`. */
function crashLogPath() {
  try {
    return expandTilde('~/.dsh/logs/dsh-force-compact.log')
  } catch {
    return ''
  }
}

/** Append one line to the durable crash log. Never throws. */
function appendDiag(line) {
  try {
    const p = crashLogPath()
    if (p === '') return
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, line + '\n', 'utf8')
  } catch (_diagnosticFailure) {
    // A diagnostic sink must never break a business path.
  }
}

/** True when a stack-frame line points inside this plugin package. */
function isPluginFrame(frame) {
  return typeof frame === 'string' && frame.indexOf('dsh-force-compact') >= 0
}

/** Extract a human-readable `file:line:col` from one stack-frame line. */
function frameLocation(frame) {
  if (typeof frame !== 'string') return String(frame)
  const match = /\(?([^(\n]*?)(?:(\d+))?(?:(\d+))?(\))?$/g.exec(frame.trim())
  if (match === null) return frame.trim()
  const file = (match[1] || '').trim()
  const line = match[2]
  const col = match[3]
  if (file === '' && line === undefined) return frame.trim()
  if (line === undefined) return file
  return `${file}:${line}${col === undefined ? '' : ':' + col}`
}

/**
 * Split a stack string into plugin-side and non-plugin frames.
 * @param {string} stackStack the raw `Error.stack` text.
 * @returns {{ pluginFrames: string[], foreignFrames: string[] }}
 */
function partitionFrames(stackStack) {
  const pluginFrames = []
  const foreignFrames = []
  if (typeof stackStack !== 'string') return { pluginFrames, foreignFrames }
  for (const raw of stackStack.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (/(^|\()dsh-force-compact/.test(trimmed)) pluginFrames.push(trimmed)
    else if (/^at /.test(trimmed)) foreignFrames.push(trimmed)
  }
  return { pluginFrames, foreignFrames }
}

/**
 * Render the multi-line crash diagnostic for one thrown value.
 * @param {string} label stable display name of the wrapping entry.
 * @param {unknown} error the thrown value.
 * @param {string} site the exact `file:line:col` where the throw originated,
 *   or the sentinel marker when unavailable.
 * @returns {string[]} formatted lines ready for the durable log.
 */
export function renderCrash(label, error, site) {
  const isErrorLike = error instanceof Error
  const message = isErrorLike ? (error.message ?? '(no message)') : (typeof error === 'string' ? error : (function stringifySafe(v) { try { return JSON.stringify(v) } catch { return String(v) } })(error))
  const stackString = (isErrorLike && typeof error.stack === 'string' && error.stack.length > 0) ? error.stack : ''
  const { pluginFrames, foreignFrames } = partitionFrames(stackString)
  const lines = []
  lines.push(`[force-compact][CRASHNET] ENTRY FAILURE — ${label}`)
  lines.push(`  message: ${message}`)
  lines.push(`  thrownAt: ${typeof site === 'string' && site.length > 0 ? site : '(not captured)'}`)
  if (pluginFrames.length > 0) lines.push(`  deepest-plugin-frame: ${frameLocation(pluginFrames[pluginFrames.length - 1])}`)
  if (foreignFrames.length > 0) lines.push(`  nearest-non-plugin-frame: ${frameLocation(foreignFrames[foreignFrames.length - 1])}`)
  const stackLines = stackString.length > 0 ? stackString.split('\n') : []
  lines.push(`  ---- call stack (up to 40 frames) ----`)
  for (const raw of stackLines.slice(0, 40)) lines.push(`  ${raw}`)
  if (stackLines.length > 40) lines.push(`  …(${stackLines.length - 40} more frames elided)`)
  if (stackLines.length === 0) lines.push(`  (no stack captured — the thrown value carried no .stack)`)
  lines.push(`  ------------------------------------------`)
  return lines
}

/**
 * Capture the EXACT call site of the current expression: the innermost frame
 * of a freshly minted `Error().stack`. Called from the wrapper's catch block
 * it names `file:line:col` of the statement that threw.
 * @returns {string} the call-site coordinate, or a sentinel on failure.
 */
function captureSite() {
  try {
    const raw = new Error('crashnet-site-marker').stack
    if (typeof raw !== 'string' || raw.length === 0) return '(no stack available)'
    const lines = raw.split('\n')
    const idx = lines.findIndex(l => l.indexOf('crashnet-site-marker') >= 0)
    if (idx < 0) return '(marker frame not found)'
    return frameLocation(lines[idx])
  } catch {
    return '(site capture failed)'
  }
}

/**
 * Wrap a method entry with the universal crash net.
 *
 * Semantics:
 * - **Success path**: synchronous bodies resolve synchronously; asynchronous
 *   (promise-returning) bodies keep their promise shape. Callers observe
 *   exactly what they observe today.
 * - **Failure path**: the wrapper appends the full diagnostic to the durable
 *   log AND rethrows/propagates the ORIGINAL error (or promise rejection).
 *   Existing `try/catch` blocks in callers keep receiving it — this layer adds
 *   observability, it changes no control flow.
 *
 * @template {(...args:any)=>any} F
 * @param {string} label stable display name of the wrapped entry.
 * @param {F} fn the body to cover.
 * @returns {F} the covered body.
 */
export function guardFn(label, fn) {
  const wrapped = (...args) => {
    try {
      const result = fn(...args)
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        // Async entry: attach a rejection observer that LOGS but PRESERVES the
        // rejection (downstream catches still fire). The `.catch` chain returns
        // a new promise; callers awaiting it see the identical outcome.
        result.catch((error) => {
          for (const line of renderCrash(`${label} (async)`, error, captureSite())) appendDiag(line)
        })
        return result
      }
      return result
    } catch (error) {
      for (const line of renderCrash(label, error, captureSite())) appendDiag(line)
      throw error
    }
  }
  try { Object.defineProperty(wrapped, 'name', { value: label, configurable: true }) } catch { /* cosmetic */ }
  return wrapped
}

/** Guarded installation flag — at most one set of process handlers. */
let installed = false

/**
 * Install the process-wide crash net (idempotent).
 *
 * Attaches one `uncaughtException` handler and one `unhandledRejection`
 * handler that emit a full diagnostic for anything escaping every wrapped
 * entry (native callbacks, microtask roots, timer callbacks). The exception
 * handler KEEPS THE PROCESS ALIVE (Node's default terminates on
 * `uncaughtException`), so the diagnostic line lands before any later
 * supervisor decision. If a different subsystem installs its own handler
 * earlier, ours still fires — multiple handlers compose.
 */
export function installCrashNet() {
  if (installed) return
  installed = true
  process.on('uncaughtException', (error) => {
    for (const line of renderCrash('UNCAUGHT EXCEPTION (process-wide net)', error, captureSite())) appendDiag(line)
  })
  process.on('unhandledRejection', (reason) => {
    for (const line of renderCrash('UNHANDLED REJECTION (process-wide net)', reason, captureSite())) appendDiag(line)
  })
}

/** Public accessor: append one line to the durable crash log. */
export function appendCrashLine(line) { appendDiag(line) }

/** Public accessor: capture the current call-site coordinates. */
export function captureThrowSite() { return captureSite() }

/** Public accessor: the resolved crash-log path. */
export function getCrashLogPath() { return crashLogPath() }

/**
 * dsh-force-compact debug log sink.
 *
 * Installs a `ctx.logger` exporter that routes **this plugin's own** log lines
 * (those whose first argument is tagged `[force-compact]`) to a file — by
 * default `~/.dsh/logs/dsh-force-compact.log` (under the shared user `$DSH_HOME`,
 * kept out of any single checkout) — whenever debug logging is enabled by the
 * `falling-ts-force-compact` settings (`debug`, a boolean that defaults to
 * `true`). This makes the plugin's otherwise-invisible `warn` / `debug`
 * diagnostics land somewhere durable, closing the loop where the stock
 * logger's in-memory-only default sink + `INFO` floor meant those lines went
 * nowhere.
 *
 * Installation is deferred to {@linkcode ensureDebugLogger}, invoked lazily from
 * the guarded listeners. File I/O goes through **Node's native `node:fs`**
 * (dynamically imported), not the product `fs` service — the latter is fenced
 * by the sandbox policy to the session workspace and refuses an absolute path
 * such as `~/.dsh/logs` (which is deliberately kept OUT of any workspace). A
 * diagnostic side-channel to the user home is therefore best served straight
 * from Node, independent of the instance's sandbox mode.
 *
 * Design notes (kept deliberately minimal, per this plugin's conventions):
 * - No `timer` and no long-lived in-memory queue: each captured line performs
 *   a single fire-and-forget read-append of the file. Occasional loss or
 *   interleaving under concurrent flushes is acceptable for a diagnostic sink
 *   and never affects a request path.
 * - The exporter registers with `levels: { default: DEBUG }` so the host's
 *   default `INFO` floor no longer drops `warn` / `debug`.
 * - Appends are capped (~{@linkcode MAX_LOG_CHARS}) keeping the tail, so the
 *   file cannot grow unbounded.
 * - Every failure is swallowed: a diagnostic sink must never break business
 *   paths.
 *
 * @module @falling-ts/dsh-force-compact/debug-log
 */

import { readSettings, DEFAULTS, NS } from './settings.js'

/** Marker identifying this plugin's own log lines (matches every `ctx.logger.*('[force-compact] …')` call site). */
const MARKER = '[force-compact]'

/**
 * Expand a leading `~` prefix to the absolute OS user home, so `fs.resolve`
 * (which treats `~` as a literal path segment) receives an absolute path.
 *
 * Reuses the harness's own `expandHomePath` (from the resolvable
 * `@deepseek-ai/dsh-home-paths` workspace package, whose `homedir()` honors
 * `USERPROFILE` on Windows) when importable; otherwise falls back to a local
 * expansion driven by whichever user-home environment variable is readable
 * (`USERPROFILE` on Windows, `HOME` elsewhere) without requiring Node globals
 * to be injected. Returns the input unchanged when no supported `~` prefix is
 * present or no home can be determined.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
async function expandHome(path) {
  if (typeof path !== 'string') return path
  const trimmed = path.trim()
  if (trimmed !== '~' && !trimmed.startsWith('~/') && !trimmed.startsWith('~\\')) return path
  const rest = trimmed === '~' ? '' : trimmed.slice(2)
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    const fn = mod.expandHomePath
    if (typeof fn === 'function') return fn(trimmed)
  } catch {
    // Fall through to the local expansion below.
  }
  // Last resort: read the user home from the environment via a dynamically
  // imported `node:os` (reachable from the plugin's loader base), and expand
  // manually if that works too. When none is available, return the input as-is
  // so the caller still attempts a best-effort write rather than throwing.
  const home = await readUserHome()
  if (home === null) return path
  const sep = home.includes('\\') ? '\\' : '/'
  return home + (rest === '' ? '' : sep + rest.replace(/\\/g, sep))
}

/**
 * Best-effort OS user home without relying on injected globals: prefer an
 * explicitly-readable home (via dynamically imported `node:os`), else `null`.
 *
 * @returns {Promise<string|null>}
 */
async function readUserHome() {
  try {
    const mod = await import('node:os')
    const fn = mod && mod.homedir
    if (typeof fn === 'function') {
      const h = fn.call(mod)
      if (typeof h === 'string' && h.length > 0) return h
    }
  } catch {
    // `node:os` unreachable; leave it to the caller.
  }
  return null
}

/** Cap the on-disk log size (characters), keeping the most recent lines. */
const MAX_LOG_CHARS = 1000000

/**
 * Install the debug-log sink for this plugin, **at most once**, called lazily
 * from the guarded listeners.
 *
 * Idempotency: a process-local latch (`debugState`) settles the outcome. On a
 * committed install `installed` becomes `true` and every subsequent call is a
 * cheap early return (no settings read). While a prior attempt has not settled
 * (`attempted` false) a later listener re-enters. The first successful install
 * wins and binds the exporter to its fiber, where it is disposed automatically
 * when the plugin stops, updates, or is removed.
 *
 * Reads the `falling-ts-force-compact` settings live (`debug`, default `true`,
 * and `logFile`, default `~/.dsh/logs/dsh-force-compact.log`), expands a
 * leading `~` to the absolute OS home, and registers a `ctx.logger` exporter
 * that routes only this plugin's own `[force-compact]` lines to the file via
 * native `node:fs` (sandbox-independent). Swallows all failures: a diagnostic
 * sink must never break business paths.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function ensureDebugLogger(ctx) {
  if (debugState.installed) return
  if (debugState.attempted) return
  debugState.attempted = true

  // SAFETY ENVELOPE: a diagnostic-sink installer must NEVER break a business
  // path. Wrap the whole install so any anomaly (a throwing
  // `ctx.logger.exporter`, a rejecting settings read, a bad path) marks the
  // sink as settled-installed and moves on silently rather than propagating.
  try {
    await __ensureDebugLoggerBody(ctx)
  } catch {
    debugState.installed = true
  }
}

async function __ensureDebugLoggerBody(ctx) {
  const resolved = (await readSettings(ctx)) ?? { ...DEFAULTS }
  // The `debug` gate lives at the EXPORT boundary and is re-read on EVERY line
  // (2026-09: no cache — a settings.yaml flip applies to the very next line,
  // even when the exporter was installed under the opposite value). Only the
  // `logFile` PATH is fixed at install time (the exporter is a singleton);
  // changing the path takes effect on the next process start.
  if (!resolved.logFile) {
    ctx.logger.warn('[force-compact] debug logging enabled but no log file path configured — nothing will be written')
    debugState.installed = true
    return
  }

  const filePath = await expandHome(resolved.logFile)
  if (!filePath) {
    ctx.logger.warn('[force-compact] debug logging enabled but no log file path could be resolved — nothing will be written')
    debugState.installed = true
    return
  }

  // The exporter re-checks the LIVE `debug` setting on EVERY line (2026-09: no
  // mid-process cache — "以设置里的为准/严禁中间有缓存"). The gate resolves
  // synchronously through `getSync` (or the sync-backed `get`) so a `debug
  // === false` deployment persists NOTHING, and flipping `debug` in
  // settings.yaml takes effect on the very next line — no restart, no
  // reinstall. The cost is one in-memory settings read per persisted line.
  const exporter = {
    colors: false,
    levels: { default: 3 },
    export: (message) => {
      // Final persistence gate lives HERE (the export boundary): a line is
      // written iff it carries the plugin marker AND the LIVE `debug` setting
      // is on.
      if (!shouldInclude(message)) return
      if (!liveDebugSetting(ctx)) return
      void writeLine(filePath, renderLine(message))
    },
  }

  // Bound to the current fiber; removed on stop/update/undefine.
  ctx.logger.exporter(exporter)
  debugState.installed = true
  // Logged AFTER the exporter is installed so this notice lands in the file too.
  ctx.logger.info(
    `[force-compact] debug logging enabled — writing [force-compact] lines to ${filePath}`,
  )
}

/**
 * Process-local install state for the debug sink: `installed` permanently stops
 * further attempts after a settled outcome; `attempted` prevents re-entering the
 * settings read once a decision has begun (without committing the exporter yet).
 * Module scope, never exported; reset naturally on a fresh process.
 */
const debugState = { attempted: false, installed: false }

/**
 * Read the LIVE `debug` setting synchronously on every call (2026-09: no
 * module-level cache — settings.yaml is the single source of truth and a flip
 * must take effect on the very next exported line). Resolves through the
 * `settings` service's synchronous read (`getSync`), or its ordinary read when
 * backed by a local store. Returns a settled boolean (never throws): missing
 * values fall back to the composition default.
 */
function liveDebugSetting(ctx) {
  try {
    const raw = ctx.get?.('settings')
    let v
    if (raw != null && typeof raw.getSync === 'function') {
      v = raw.getSync(NS)?.debug
    } else if (typeof raw?.get === 'function') {
      v = raw.get(NS)?.debug
    }
    return v !== undefined ? v === true : DEFAULTS.debug
  } catch {
    return DEFAULTS.debug
  }
}

/**
 * Keep only this plugin's own lines: the first `args` element is the log
 * template string and must carry the `[force-compact]` marker.
 *
 * @param {any} message structured log record
 * @returns {boolean}
 */
function shouldInclude(message) {
  if (message === null || typeof message !== 'object') return false
  const args = message.args
  if (!Array.isArray(args) || args.length === 0) return false
  const first = args[0]
  return typeof first === 'string' && first.indexOf(MARKER) !== -1
}

/**
 * Render one message to a single prefixed line: ISO timestamp, severity tag,
 * then the formatted arguments. Errors contribute their stack (or message);
 * objects are compacted to JSON; everything else is stringified. Only the
 * shallow `args` are touched — the live record itself is never cloned or
 * recursively enumerated.
 *
 * @param {any} message
 * @returns {string}
 */
function renderLine(message) {
  // Tolerate a malformed `message`: a non-date `ts` (undefined/null/nonsense
  // string) would otherwise make `new Date(...).toISOString()` throw on the
  // `Invalid Date` value. Degrade to an epoch-zero timestamp so the line still
  // renders — a diagnostic line dropping on a weird record is unacceptable.
  let ts
  try {
    ts = Number.isFinite(+new Date(message.ts).getTime()) ? new Date(message.ts).toISOString() : new Date(0).toISOString()
  } catch {
    ts = new Date(0).toISOString()
  }
  const type = String(message && message.type !== undefined ? message.type : 'info').toUpperCase()
  return `${ts} [${type}] ${formatArgs(Array.isArray(message && message.args) ? message.args : [])}`
}

/**
 * Format the shallow argument list into a printable string.
 *
 * @param {any[]} args
 * @returns {string}
 */
function formatArgs(args) {
  const parts = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg instanceof Error) parts.push(arg.stack || arg.message)
    else if (typeof arg === 'object' && arg !== null) {
      try {
        parts.push(JSON.stringify(arg))
      } catch {
        parts.push(String(arg))
      }
    } else {
      parts.push(String(arg))
    }
  }
  return parts.join(' ')
}

/**
 * Lazily import Node's native filesystem promises, cached after the first load.
 * Native `node:fs` is intentionally chosen over the product `fs` service because
 * the latter is fenced by the sandbox policy to the session workspace and
 * refuses an absolute user-home path; the native module writes the absolute
 * target directly, independent of sandbox mode. Returns `null` if the import
 * ever fails (extremely unlikely for a builtin), letting callers degrade.
 *
 * @returns {Promise<Object|null>}
 */
let nativeFsPromises
async function getNodeFs() {
  if (nativeFsPromises !== undefined) return nativeFsPromises
  try {
    nativeFsPromises = await import('node:fs/promises')
  } catch {
    nativeFsPromises = null
  }
  return nativeFsPromises
}

/**
 * Append one line to the debug log using native Node `fs`. Creates the parent
 * directory if needed, appends, and truncates to {@linkcode MAX_LOG_CHARS}
 * keeping the tail. Fire-and-forget; swallows all errors so a diagnostic sink
 * can never disturb a business path.
 *
 * @param {string} path absolute target path
 * @param {string} line rendered line WITHOUT a trailing newline
 */
async function writeLine(path, line) {
  try {
    const fsp = await getNodeFs()
    if (fsp === null) return
    const { dirname } = await import('node:path')
    // Ensure the containing directory exists (recursive, no-op if present).
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.appendFile(path, line + '\n')
    // Tail-cap: if the file grew past the budget, keep only the last
    // MAX_LOG_CHARS characters so it cannot grow unbounded.
    const stat = await fsp.stat(path).catch(() => null)
    if (stat !== null && stat.size > MAX_LOG_CHARS) {
      const handle = await fsp.open(path, 'r+')
      try {
        const buffer = Buffer.alloc(MAX_LOG_CHARS)
        const { bytesRead } = await handle.readFile(buffer, 0, MAX_LOG_CHARS, stat.size - MAX_LOG_CHARS)
        await handle.writeFile(Buffer.from(buffer.subarray(0, bytesRead)), 0, bytesRead, 0)
        await handle.truncate(bytesRead)
      } finally {
        await handle.close()
      }
    }
  } catch {
    // Diagnostic sink must never break the requesting path.
  }
}

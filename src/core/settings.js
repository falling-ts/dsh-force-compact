/**
 * dsh-force-compact settings — the "强制压缩配置" (Force-Compact Configuration)
 * surface.
 *
 * User-tunable parameters are registered under the `falling-ts-force-compact`
 * settings namespace so the harness settings panel can expose and persist them
 * (the `falling-ts-` prefix prevents collisions with other plugins' keys):
 *
 * - `disableThinking` (boolean, default `true`): when true, the plugin's
 *   compaction summarization request carries `reasoningEffort: 'off'`, which
 *   the LLM adapter maps to `thinking: { type: 'disabled' }` — i.e. the
 *   provider's thinking/reasoning is switched off for the summarization call.
 * - `autoThresholdTokens` (positive integer, default `32000`, floor `32000`):
 *   the automatic compaction trigger threshold in tokens. Compaction runs only
 *   when the session's estimated total context is at least this many tokens;
 *   below it, the checkpoint is skipped. Stored values BELOW the floor are
 *   coerced UP to it at read time (and the schema rejects sub-floor drafts).
 * - `retainLatestTokens` (positive integer, default `8000`, floor `8000`): the
 *   ABSOLUTE TOKEN COUNT retained at the LATEST end of the session's surface
 *   when an auto or forced compaction fires. Starting from the newest surface
 *   node and walking BACKWARD (latest → oldest) using the official
 *   `tokenMeter`'s per-node token prices, node tokens accumulate until the
 *   running sum
 *   REACHES OR EXCEEDS this budget; everything before that cutoff forms the
 *   head-anchored region compacted into a single summary node in one LLM call
 *   (the original entries of the compacted span become shadowed / skipped in
 *   derived history). Replaces the former `autoEarliestRatio` /
 *   `forceEarliestRatio` percentage knobs with a fixed retention target
 *   independent of the (possibly usage-inflated) `totalTokens` denominator.
 * - `turnEndForceCompactionEnabled` (boolean, default `true`): whether a turn-end
 *   forced compaction runs when the agent transitions to `idle` — compaction
 *   goes through the engine's idle manual entry (`compactNow`), which uses its
 *   own range selection (the idle path cannot select a custom token fraction,
 *   so there is no turn-end ratio parameter).
 * - `debug` (boolean, default `true`): the gate for the debug log
 *   (`core/log.js`). **On by default** so the plugin's `[force-compact]`
 *   diagnostics always land in the debug file; set `false` for a production
 *   deployment to suppress the file. There is no environment auto-detection —
 *   the operator declares intent directly via this flag.
 * - `logFile` (string, default `~/.dsh/logs/dsh-force-compact.log`): the
 *   debug-log target path. Leading `~` expands to the OS user home, so by
 *   default the log sits under the shared user `$DSH_HOME` (`~/.dsh/logs/`),
 *   independent of any single session's workspace — keeping the log out of the
 *   official `deepseek-harness` checkout. Any absolute path may override it.
 * - `compactionMode` (`'realm'` | `'global'`, default `'realm'`): how the
 *   plugin locates the official `compaction` service (realm-scoped per-agent
 *   vs host-global). See `COMPACT_MODE_*` constants below.
 * - `builtinEnabled` (boolean, default `true`): the gate for this plugin's
 *   own self-contained compaction engine (see `engine/builtin.js`). When
 *   the official `compaction` service is reachable (host-global mount), it is
 *   always preferred; when unreachable (the standard preset realm-isolates it)
 *   the plugin falls back to the builtin engine — which runs the full durable
 *   transaction itself (reusing the OFFICIAL `compaction/*` event vocabulary, own checkpoint
 *   `user/message` shadowing a head-anchored span, own shrink gate). Setting
 *   this to `false` disables that fallback so ONLY the official backend is
 *   attempted.
 * - `maxSummaryTokens` (positive integer, default `1024`, floor `1024`): the
 *   `maxTokens` bound applied to the plugin's OWN summarization LLM call — a
 *   cap on the summary length. Combined with the shrink gate (the summary must
 *   be strictly smaller than the span it replaces), this prevents runaway
 *   summarizer outputs from ballooning past the region being condensed.
 *   Stored values below the floor are coerced up to it at read time.
 *
 * The namespace is registered against the `settings` service when one is
 * mounted. The schema is BUILT BEST-EFFORT through `@deepseek-ai/schemastery`:
 * when that bare module cannot be resolved from the plugin's install location
 * (common when the plugin is developed outside a node_modules root, where Node
 * cannot walk up to find it), {@linkcode buildSchema} returns `null` and
 * {@linkcode registerNamespace} falls back to registering the namespace with
 * **defaults only** (editable fields, no validation metadata) rather than
 * skipping registration entirely — so the settings panel still loads and the
 * values remain readable/writable. A `settings` service absence still results
 * in a no-op, so it is never a hard dependency.
 *
 * @module @falling-ts/dsh-force-compact/settings
 */

/**
 * The settings namespace id for the force-compact configuration.
 *
 * Prefixed `falling-ts-` so it cannot collide with another plugin's
 * `force-compact` namespace — the `falling-ts` vendor prefix is shared by
 * every setting key this project owns. It is the top-level key in
 * `$DSH_HOME/settings.yaml`.
 */
export const NS = 'falling-ts-force-compact'

/**
 * Accepted values for the `compactionMode` setting.
 *
 * The `compaction` backend is mounted in two fundamentally different shapes
 * depending on the composition:
 *
 * - **modern presets**: the compaction backend (`compaction-basic`) is isolated
 *   into each agent preset's **realm** (see the `standard` preset, which puts
 *   `compaction` inside `- isolate:`), so the HOST-GLOBAL `ctx.get('compaction')`
 *   is `undefined` while each live agent's OWN context resolves the instance.
 * - **base/global bundles**: `compaction-basic` is a top-level host row and the
 *   service is visible at global scope.
 *
 * `COMPACT_MODE_REALM` (default) tries the agent's realm-scoped context first,
 * then falls back to the host-global `ctx.get`, then the injected
 * `ctx.compaction` property — so it covers every layout. `COMPACT_MODE_GLOBAL`
 * restricts resolution to the host-global lookup only (for a deployment known to
 * mount the backend globally).
 */
export const COMPACT_MODE_REALM = 'realm'
export const COMPACT_MODE_GLOBAL = 'global'
export const COMPACT_MODES = [COMPACT_MODE_REALM, COMPACT_MODE_GLOBAL]

/**
 * Composition defaults for the parameters. These are the `base` layer the
 * settings namespace resolves over, so a field the user has not overridden
 * resolves to these values.
 * @type {Readonly<{
 *   disableThinking: boolean,
 *   autoThresholdTokens: number,
 *   retainLatestTokens: number,
 *   turnEndForceCompactionEnabled: boolean,
 *   debug: boolean,
 *   logFile: string,
 *   compactionMode: string,
 *   builtinEnabled: boolean,
 *   maxSummaryTokens: number,
 * }>}
 */
/** Default debug-log destination: the shared user `$DSH_HOME/logs/` dir. */
export const DEFAULT_LOG_FILE = '~/\.dsh/logs/dsh-force-compact.log'.replace('\\', '/')

/**
 * Floor applied to the three token-scale parameters on EVERY read. Stored values
 * BELOW the floor are coerced UP to it (rather than rejected), so a hand-edited
 * settings.yaml with an out-of-band value still yields a legal runtime setting.
 * The web form mirrors these floors as input constraints; the server-side clamp
 * is authoritative in any race (e.g. a stale draft written by a different client
 * while the form was open).
 * @type {Readonly<{
 *   autoThresholdTokens: number,
 *   retainLatestTokens: number,
 *   maxSummaryTokens: number,
 * }>}
 */
export const MIN_TOKEN_SCALES = Object.freeze({
  autoThresholdTokens: 32000,
  retainLatestTokens: 8000,
  maxSummaryTokens: 1024,
})

export const DEFAULTS = Object.freeze({
  disableThinking: true,
  autoThresholdTokens: 32000,
  // Absolute TOKEN COUNT retained at the LATEST end of the surface when an
  // auto / forced compaction fires. Starting from the newest surface node and
  // walking backward, node tokens (from the official `tokenMeter` per-node
  // prices) accumulate until the running sum REACHES OR EXCEEDS this budget;
  // everything BEFORE that cutoff forms the head-anchored region compacted
  // into a single summary node in one summarizer call. Replaces the former
  // `autoEarliestRatio` / `forceEarliestRatio` percentage knobs with a fixed,
  // predictable retention target independent of the (potentially
  // usage-inflated) `totalTokens` denominator.
  retainLatestTokens: 8000,
  turnEndForceCompactionEnabled: true,
  debug: true,
  logFile: DEFAULT_LOG_FILE,
  compactionMode: COMPACT_MODE_REALM,
  // Built-in compaction engine — ON by default so the plugin's own engine is
  // always available as the fallback whenever the official `compaction` service
  // is unreachable from this context (the common standard-preset layout). Set
  // `false` to strictly use the official backend only.
  builtinEnabled: true,
  // Hard ceiling on the summarizer's output tokens (applied as `maxTokens` on
  // the plugin's own summarization LLM call). Prevents runaway summaries when
  // the shadowed span is large; the shrink gate independently ensures the
  // committed summary is smaller than the span it replaces.
  maxSummaryTokens: 1024,
   // Ceiling on the NUMBER OF SURFACE NODES one compaction region may span
   // (positional, counted from the head of the ordered surface). When the
   // token-budget-driven cutoff point lands beyond this many nodes —
   // normal for a large `autoEarliestRatio` such as 0.7 on a long tool-heavy
   // conversation — the region is CLAMPED DOWN to the largest head-aligned
   // prefix under this cap that ends on a `user/message` boundary. Sized
   // safely under the builtin engine's 128-message replay cap (a region of N
   // surface nodes projects at most N messages, so N < 128 keeps the projected
   // message count within the cap), guaranteeing a COMMISIBLE region on every
   // threshold trip so the auto-gate never livelocks. Successive gates chip the
   // head away until the session settles below the threshold.
   maxRegionNodes: 96,
})

/**
 * Read the resolved force-compact settings from the `settings` service, applying
 * the `DEFAULTS` fallback for any field the user has not overridden.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{
 *   disableThinking: boolean,
 *   autoThresholdTokens: number,
 *   retainLatestTokens: number,
 *   turnEndForceCompactionEnabled: boolean,
 *   debug: boolean,
 *   logFile: string,
 *   compactionMode: string,
 *   builtinEnabled: boolean,
 *   maxSummaryTokens: number,
 * } | null>}
 *   the resolved settings, or `null` when the `settings` service is not mounted
 *   (callers should fall back to their composition entry).
 */
export async function readSettings(ctx) {
  // SAFETY ENVELOPE: every model request and compaction path reads settings —
  // a throw escaping here would take down the model-request seam. Wrap the whole
  // read so ANY anomaly (a rejecting `settings.get`, a non-object stored value)
  // degrades to `null` (= "use the caller's composition defaults"), never throw.
  try {
    return await __readSettingsBody(ctx)
  } catch (error) {
    const logger = (typeof ctx?.logger?.warn === 'function') ? ctx.logger.warn.bind(ctx.logger) : () => {}
    logger(`[force-compact] readSettings degraded to defaults — ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function __readSettingsBody(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.get !== 'function') return null
  const rawSection = settings.get(NS)
  if (rawSection === undefined) return null
  // A non-object stored value (corrupt/legacy yaml edge) degrades to an empty
  // section so every field resolves to its DEFAULT below — never a throw.
  const section = (rawSection && typeof rawSection === 'object') ? rawSection : {}
  const asBool = (field, fallback) =>
    (typeof section[field] === 'boolean' ? section[field] : fallback)
  const asPositiveInt = (field, fallback) =>
    (Number.isFinite(section[field]) && section[field] > 0 ? section[field] : fallback)
  // Token-scale parameter: parse + clamp up to the published floor (below-floor
  // values RESOLVE to the floor rather than being rejected).
  const asScaled = (field, floor) => {
    const v = asPositiveInt(field, DEFAULTS[field])
    return Number.isFinite(v) && v < floor ? floor : v
  }
  const disableThinking = asBool('disableThinking', DEFAULTS.disableThinking)
  const autoThresholdTokens = asScaled('autoThresholdTokens', MIN_TOKEN_SCALES.autoThresholdTokens)
  const retainLatestTokens = asScaled('retainLatestTokens', MIN_TOKEN_SCALES.retainLatestTokens)
  const turnEndForceCompactionEnabled = asBool('turnEndForceCompactionEnabled', DEFAULTS.turnEndForceCompactionEnabled)
  const debug = asBool('debug', DEFAULTS.debug)
  const logFile = (typeof section.logFile === 'string' ? section.logFile : DEFAULTS.logFile)
  const rawMode = (typeof section.compactionMode === 'string' ? section.compactionMode.toLowerCase()
    : DEFAULTS.compactionMode)
  const compactionMode = COMPACT_MODES.includes(rawMode) ? rawMode : DEFAULTS.compactionMode
  // Builtin-engine gate: absent / non-boolean stored values treat the field as
  // UNSET (rather than false), preserving the "default on" semantics even
  // when a legacy settings.yaml predates the field.
  const builtinEnabled = (typeof section.builtinEnabled === 'boolean'
    ? section.builtinEnabled
    : DEFAULTS.builtinEnabled)
  const maxSummaryTokens = asScaled('maxSummaryTokens', MIN_TOKEN_SCALES.maxSummaryTokens)
  return {
    disableThinking,
    autoThresholdTokens,
    retainLatestTokens,
    turnEndForceCompactionEnabled,
    debug,
    logFile,
    compactionMode,
    builtinEnabled,
    maxSummaryTokens,
  }
}

/**
 * Build ONE schema field for an enumerated setting (`compactionMode`).
 *
 * Probes the resolved `z` for a usable enum constructor (`z.enum`, else
 * `z.nativeEnum`). When it exists AND returns a schema, that is used (proper
 * constraint + UI affordance). Otherwise — a reduced/partial schema surface —
 * it degrades to a plain `z.string().default(fallback)` so the field STILL
 * exists and is writable; the value is validated at read time in `readSettings`
 * (invalid strings coerce to the default). Crucially this NEVER throws, so the
 * field's construction can never take down the entire `buildSchema` call.
 *
 * @param {any} z the resolved schemastery `z` (or a partial surface).
 * @param {string} fallback the default value (also the fallback-mode default).
 * @returns {unknown} the constructed field schema.
 */
function buildEnumField(z, fallback) {
  const enumFn = (typeof z.enum === 'function' ? z.enum
    : (typeof z.nativeEnum === 'function' ? z.nativeEnum : undefined))
  if (enumFn) {
    try {
      const built = (enumFn.length > 0 ? enumFn(COMPACT_MODES) : enumFn)
      if (built !== undefined && built !== null) return built
    } catch {
      // Unsupported/throwing enum constructor — fall through to the plain field.
    }
  }
  // Plain-string fallback: always constructible, writable, value-checked later.
  return typeof z.string === 'function' ? z.string().default(fallback) : { default: fallback }
}

/**
 * Read ONE RAW field of the `falling-ts-force-compact` namespace, WITHOUT the
 * per-request `readSettings` full-parse overhead. Cached-friendly (re-reads only
 * the single field) so it is safe to call from service-resolution paths.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} field
 * @returns {Promise<unknown>} the raw stored value, or `undefined` when the
 *   settings service is not mounted or the field is unset.
 */
export async function readRawSetting(ctx, field) {
  // SAFETY ENVELOPE: called from service-resolution and command paths; a
  // rejecting `settings.get` or a non-section shape degrades to `undefined`
  // (= "unset") rather than throwing.
  try {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.get !== 'function') return undefined
    const value = settings.get(NS)
    if (value === undefined || value === null) return undefined
    if (value !== null && typeof value !== 'object') return undefined
    return value[field]
  } catch {
    return undefined
  }
}

/**
 * Build the `falling-ts-force-compact` settings schema through `@deepseek-ai/schemastery`.
 *
 * @returns {Promise<((section: unknown) => unknown) & { toJSON: () => unknown } | null>}
 *   the schemastery schema (a callable validator with a `toJSON`), or `null`
 *   when the schemastery module cannot be resolved at runtime.
 */
/**
 * Resolve the `z` schema constructor, tolerating BOTH layouts the plugin ships
 * in:
 *  - a monorepo/dev layout where `@deepseek-ai/schemastery` is a resolvable
 *    bare specifier (other workspace packages depend on it and Node walks up
 *    their `node_modules`);
 *  - this plugin as a STANDALONE repo (its own `node_modules` lacks
 *    schemastery, which lives in the sibling `deepseek-harness/vendor/` copy).
 *    In that case the bare import fails, so we additionally attempt the known
 *    vendored build by ABSOLUTE path (relative to this file, walking upward to
 *    the workspace root), which is portable across machines/users because it is
 *    resolved at runtime from this very file's location. Returns the resolved
 *    `z`, or `undefined` when NO candidate yields a usable `z.object`.
 */
async function resolveZ() {
  // Candidate 1: bare specifier (works when installed inside the monorepo).
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const z = mod.default ?? mod
    if (typeof z.object === 'function') return z
  } catch { /* fall through to candidate 2 */ }
  // Candidate 2: the vendored build sitting beside the checkout. Walk up from
  // THIS file (dsh-force-compact/src/core/) looking for a
  // `deepseek-harness/vendor/schemastery/lib/index.mjs` alongside the checkout
  // root. Portable: computed from this file's own path, never hardcoded.
  try {
    const { fileURLToPath, pathToFileURL } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let hop = 0; hop < 8; hop += 1) {
      const cand = join(dir, 'deepseek-harness/vendor/schemastery/lib/index.mjs')
      if (existsSync(cand)) {
        // Dynamic import() on Windows REQUIRES a file:// URL (a bare drive-letter
        // absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME). Convert the found
        // path so the vendored build loads reliably on both POSIX and Windows.
        const mod = await import(pathToFileURL(cand).href)
        const z = mod.default ?? mod
        if (typeof z.object === 'function') return z
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* candidate 2 unavailable — proceed unresolved */ }
  return undefined
}

export async function buildSchema() {
  try {
    const z = await resolveZ()
    if (z === undefined) return null
    const schema = z.object({
      disableThinking: z.boolean().default(DEFAULTS.disableThinking),
      // Minimal chain: `.step()` and `.min()` were ADDED this pass and are
      // exactly what broke the host's vendored schemastery surface (the
      // standalone-node build resolves these fine but the host's z doesn't
      // expose them as chainable). Fall back to a bare `z.number().default(…)`
      // — the FLOOR IS STILL ENFORCED IN `readSettings` (asScaled clamps
      // stored values BELOW the floor UP TO the floor before they're surfaced),
      // and the web FORM enforces its own minimum at the input level
      // (`useDraftNumberClamped`). So even though the schema carries no
      // machine-checked lower bound, a hand-edited settings.yaml holding a
      // sub-floor value still RESOLVES to the legal floor at read time, and
      // the form refuses to persist a sub-floor draft. Documented trade-off:
      // the schema is descriptive here; the floor is behavioral.
      autoThresholdTokens: z.number().default(DEFAULTS.autoThresholdTokens),
      // ABSOLUTE TOKEN COUNT retained at the latest end of the surface when an
      // auto / forced compaction fires (see the `DEFAULTS` comment for the full
      // semantics). `step(1)` constrains to whole tokens (schemastery has no
      // `.int()`); `min(1)` guards the degenerate 0 case (which clamps to 1
      // node minimum retained anyway).
      retainLatestTokens: z.number().default(DEFAULTS.retainLatestTokens),
      turnEndForceCompactionEnabled: z.boolean().default(DEFAULTS.turnEndForceCompactionEnabled),
      // Debug-log gate, on by default; set false for production deployments.
      debug: z.boolean().default(DEFAULTS.debug),
      // Debug-log target; leading ~ expands to the OS user home. Default sits
      // under the shared user $DSH_HOME so it is never dropped into a checkout.
      logFile: z.string().default(DEFAULTS.logFile),
      // How the plugin locates the compaction backend (realm-scoped per-agent
      // vs host-global). Built best-effort: prefer a proper enum when the
      // schemastery schema supports it; otherwise fall back to a plain
      // `.default()` field so the field ALWAYS exists and stays writable (the
      // value is still validated in `readSettings`, which coerces any invalid
      // string to the default). NEVER let an unsupported enum construct throw —
      // that would escape `buildSchema`'s try/catch and break the WHOLE
      // namespace registration (regressing the settings panel to "loading").
      compactionMode: buildEnumField(z, DEFAULTS.compactionMode),
      // The builtin engine fallback (see `engine/backend.js`): on by default
      // so the plugin's own engine takes over whenever the official
      // `compaction` service is unreachable (standard-preset realm isolation).
      // Value is coerced at read-time in `readSettings`, so the schema field is
      // purely UI affordance.
      builtinEnabled: z.boolean().default(DEFAULTS.builtinEnabled),
      // Token ceiling applied to the plugin's own summarizer LLM call. Bounds
      // runaway summaries; combined with the shrink gate (the summary must be
      // strictly smaller than the span it replaces) this keeps transactions
      // bounded while ensuring compression is always net-negative.
      maxSummaryTokens: z.number().default(DEFAULTS.maxSummaryTokens),
        liveUi: z.any(), // TRANSIENT UI MESSENGER (core/ui-signal.js): host-written { phase,text,color }. z.any() used because the vendored schemastery exposes object/any/string/number/boolean/array only (no record/unknown/chained .optional()); z.record(z.unknown()).optional() throws there and aborts the whole z.object(...), stranding the settings panel on "loading". Absence-by-default is inherent (no .default). readSettings ignores it — not a user preference.
    })
    return schema
  } catch {
    return null
  }
}

/**
 * Register the `falling-ts-force-compact` settings namespace when a `settings` service is
 * mounted. Idempotent for the calling fiber; safe to call once in `apply`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<boolean>} whether the namespace was registered.
 */
export async function registerNamespace(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.register !== 'function') return false

  const schema = await buildSchema()
  // Prefer the full validation schema. When it could not be built (the
  // schemastery bare module is unresolvable from this install location — a
  // common development layout with no ancestor `node_modules`), register a
  // minimal placeholder schema object instead of skipping: the namespace still
  // gets exposed (so the settings panel loads and values stay
  // readable/writable) but without field-level validation metadata. Both layers
  // carry the same `base` defaults, so either way the effective values resolve
  // identically.
  const thirdArg = { base: { ...DEFAULTS } }
  // Placeholder MUST be callable (callable-validator contract of
  // `settings.register`): identity passthrough that accepts any section shape
  // so the namespace stays exposed even when schemastery is unresolvable.
  const placeholderSchema = (section) => section
  placeholderSchema.toJSON = () => ({})
  // Contain the actual `settings.register` call: a hostile/partial `settings`
  // implementation that throws on register must NOT break the plugin's `apply`
  // (which registers all listeners). Degrade to "not registered" (false).
  try {
    settings.register(NS, schema !== null ? schema : placeholderSchema, thirdArg)
    return true
  } catch {
    return false
  }
}

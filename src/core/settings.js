/**
 * dsh-force-compact settings — the "强制压缩配置" (Force-Compact Configuration)
 * surface.
 *
 * Nine user-tunable parameters are registered under the `falling-ts-force-compact`
 * settings namespace so the harness settings panel can expose and persist them
 * (the `falling-ts-` prefix prevents collisions with other plugins' keys):
 *
 * - `disableThinking` (boolean, default `true`): when true, the plugin's
 *   compaction summarization request carries `reasoningEffort: 'off'`, which
 *   the LLM adapter maps to `thinking: { type: 'disabled' }` — i.e. the
 *   provider's thinking/reasoning is switched off for the summarization call.
 * - `autoThresholdTokens` (number, default `131000`): the automatic
 *   compaction trigger threshold in tokens. Compaction runs only when the
 *   session's estimated total context is at least this many tokens; below it,
 *   the checkpoint is skipped.
 * - `autoEarliestRatio` (number 0.01..1, default `0.3`): the fraction of the
 *   session's surface history the automatic path compacts from the **head**
 *   (the oldest `autoEarliestRatio` of the conversation).
 * - `forceEarliestRatio` (number 0.01..1, default `0.5`): the fraction of the
 *   session's surface history the `/force-compact` command compacts from the
 *   **head**.
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
 * - `maxSummaryTokens` (positive integer, default `2400`): the `maxTokens`
 *   bound applied to the plugin's OWN summarization LLM call — a cap on the
 *   summary length. Combined with the shrink gate (the summary must be
 *   strictly smaller than the span it replaces), this prevents runaway
 *   summarizer outputs from ballooning past the region being condensed.
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
 * Composition defaults for the nine parameters. These are the `base` layer the
 * settings namespace resolves over, so a field the user has not overridden
 * resolves to these values.
 * @type {Readonly<{
 *   disableThinking: boolean,
 *   autoThresholdTokens: number,
 *   autoEarliestRatio: number,
 *   forceEarliestRatio: number,
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

export const DEFAULTS = Object.freeze({
  disableThinking: true,
  autoThresholdTokens: 131000,
  autoEarliestRatio: 0.3,
  forceEarliestRatio: 0.5,
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
  maxSummaryTokens: 2400,
})

/**
 * Read the resolved force-compact settings from the `settings` service, applying
 * the `DEFAULTS` fallback for any field the user has not overridden.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{
 *   disableThinking: boolean,
 *   autoThresholdTokens: number,
 *   autoEarliestRatio: number,
 *   forceEarliestRatio: number,
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
  const settings = ctx.get('settings')
  if (settings === undefined) return null
  const value = settings.get(NS)
  if (value === undefined) return null
  const asBool = (field, fallback) =>
    (typeof value[field] === 'boolean' ? value[field] : fallback)
  const asPositiveInt = (field, fallback) =>
    (Number.isFinite(value[field]) && value[field] > 0 ? value[field] : fallback)
  const asRatio = (field, fallback) =>
    (Number.isFinite(value[field]) && value[field] > 0 && value[field] <= 1 ? value[field] : fallback)
  const disableThinking = asBool('disableThinking', DEFAULTS.disableThinking)
  const autoThresholdTokens = asPositiveInt('autoThresholdTokens', DEFAULTS.autoThresholdTokens)
  const autoEarliestRatio = asRatio('autoEarliestRatio', DEFAULTS.autoEarliestRatio)
  const forceEarliestRatio = asRatio('forceEarliestRatio', DEFAULTS.forceEarliestRatio)
  const turnEndForceCompactionEnabled = asBool('turnEndForceCompactionEnabled', DEFAULTS.turnEndForceCompactionEnabled)
  const debug = asBool('debug', DEFAULTS.debug)
  const logFile = (typeof value.logFile === 'string' ? value.logFile : DEFAULTS.logFile)
  const rawMode = (typeof value.compactionMode === 'string' && value.compactionMode.length > 0
    ? value.compactionMode.toLowerCase()
    : DEFAULTS.compactionMode)
  const compactionMode = COMPACT_MODES.includes(rawMode) ? rawMode : DEFAULTS.compactionMode
  // Builtin-engine gate: absent / non-boolean stored values treat the field as
  // UNSET (rather than false), preserving the "default on" semantics even
  // when a legacy settings.yaml predates the field.
  const builtinEnabled = (typeof value.builtinEnabled === 'boolean'
    ? value.builtinEnabled
    : DEFAULTS.builtinEnabled)
  const maxSummaryTokens = asPositiveInt('maxSummaryTokens', DEFAULTS.maxSummaryTokens)
  return {
    disableThinking,
    autoThresholdTokens,
    autoEarliestRatio,
    forceEarliestRatio,
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
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const value = settings.get(NS)
  if (value === undefined || value === null) return undefined
  return value[field]
}

/**
 * Build the `falling-ts-force-compact` settings schema through `@deepseek-ai/schemastery`.
 *
 * @returns {Promise<((section: unknown) => unknown) & { toJSON: () => unknown } | null>}
 *   the schemastery schema (a callable validator with a `toJSON`), or `null`
 *   when the schemastery module cannot be resolved at runtime.
 */
export async function buildSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const z = mod.default ?? mod
    const schema = z.object({
      disableThinking: z.boolean().default(DEFAULTS.disableThinking),
      // `step(1)` constrains to whole numbers (schemastery has no `.int()`).
      autoThresholdTokens: z.number().step(1).min(1).default(DEFAULTS.autoThresholdTokens),
      // A "ratio" is a fraction of the session's surface history, in (0, 1].
      // `step(0.01)` keeps values to two decimals (schemastery has no `.int()`).
      autoEarliestRatio: z.number().step(0.01).min(0.01).max(1).default(DEFAULTS.autoEarliestRatio),
      forceEarliestRatio: z.number().step(0.01).min(0.01).max(1).default(DEFAULTS.forceEarliestRatio),
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
      maxSummaryTokens: z.number().step(1).min(256).max(200000).default(DEFAULTS.maxSummaryTokens),
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
  const placeholderSchema = (() => {
    const obj = {}
    obj.toJSON = () => ({})
    return obj
  })()
  settings.register(NS, schema !== null ? schema : placeholderSchema, thirdArg)
  return true
}

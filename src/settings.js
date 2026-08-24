/**
 * dsh-force-compact settings — the "强制压缩配置" (Force-Compact Configuration)
 * surface.
 *
 * Six user-tunable parameters are registered under the `falling-ts-force-compact`
 * settings namespace so the harness settings panel can expose and persist them
 * (the `falling-ts-` prefix prevents collisions with other plugins' keys):
 *
 * - `disableThinking` (boolean, default `true`): when true, the plugin's
 *   compaction summarization request carries `reasoningEffort: 'off'`, which
 *   the LLM adapter maps to `thinking: { type: 'disabled' }` — i.e. the
 *   provider's thinking/reasoning is switched off for the summarization call.
 * - `autoThresholdTokens` (number, default `80000`): the automatic
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
 *   forced compaction runs at each turn's end.
 * - `turnEndCompactionRatio` (number 0.01..1, default `0.4`): the fraction of the
 *   session's surface history the turn-end forced compaction compacts from the
 *   **head**.
 *
 * The namespace is registered against the `settings` service when one is
 * mounted. The schema is built through `@deepseek-ai/schemastery` (a
 * workspace package resolvable at runtime); when the bare module cannot be
 * resolved, registration is skipped and the plugin falls back to its
 * composition entry config — so a settings service never becomes a hard
 * dependency.
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
 * Composition defaults for the six parameters. These are the `base` layer the
 * settings namespace resolves over, so a field the user has not overridden
 * resolves to these values.
 * @type {Readonly<{
 *   disableThinking: boolean,
 *   autoThresholdTokens: number,
 *   autoEarliestRatio: number,
 *   forceEarliestRatio: number,
 *   turnEndForceCompactionEnabled: boolean,
 *   turnEndCompactionRatio: number,
 * }>}
 */
export const DEFAULTS = Object.freeze({
  disableThinking: true,
  autoThresholdTokens: 80000,
  autoEarliestRatio: 0.3,
  forceEarliestRatio: 0.5,
  turnEndForceCompactionEnabled: true,
  turnEndCompactionRatio: 0.4,
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
 *   turnEndCompactionRatio: number,
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
  const turnEndCompactionRatio = asRatio('turnEndCompactionRatio', DEFAULTS.turnEndCompactionRatio)
  return {
    disableThinking,
    autoThresholdTokens,
    autoEarliestRatio,
    forceEarliestRatio,
    turnEndForceCompactionEnabled,
    turnEndCompactionRatio,
  }
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
      turnEndCompactionRatio: z.number().step(0.01).min(0.01).max(1).default(DEFAULTS.turnEndCompactionRatio),
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
  if (schema === null) return false
  settings.register(NS, schema, { base: { ...DEFAULTS } })
  return true
}

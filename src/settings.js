/**
 * dsh-force-compact settings — the "强制压缩配置" (Force-Compact Configuration)
 * surface.
 *
 * Two user-tunable parameters are registered under the `force-compact`
 * settings namespace so the harness settings panel can expose and persist them:
 *
 * - `disableThinking` (boolean, default `true`): when true, the plugin's
 *   compaction summarization request carries `reasoningEffort: 'off'`, which
 *   the LLM adapter maps to `thinking: { type: 'disabled' }` — i.e. the
 *   provider's thinking/reasoning is switched off for the summarization call.
 * - `autoThresholdTokens` (number, default `120000`): the automatic
 *   compaction trigger threshold in tokens. Compaction runs only when the
 *   session's estimated total context is at least this many tokens; below it,
 *   the checkpoint is skipped.
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

/** The settings namespace id for the force-compact configuration. */
export const NS = 'force-compact'

/**
 * Composition defaults for the two parameters. These are the `base` layer the
 * settings namespace resolves over, so a field the user has not overridden
 * resolves to these values.
 * @type {Readonly<{disableThinking: boolean, autoThresholdTokens: number}>}
 */
export const DEFAULTS = Object.freeze({
  disableThinking: true,
  autoThresholdTokens: 120000,
})

/**
 * Read the resolved force-compact settings from the `settings` service.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{disableThinking: boolean, autoThresholdTokens: number} | null>}
 *   the resolved settings, or `null` when the `settings` service is not mounted
 *   (callers should fall back to their composition entry).
 */
export async function readSettings(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined) return null
  const value = settings.get(NS)
  if (value === undefined) return null
  const disableThinking = typeof value.disableThinking === 'boolean'
    ? value.disableThinking
    : DEFAULTS.disableThinking
  const autoThresholdTokens = Number.isFinite(value.autoThresholdTokens) && value.autoThresholdTokens > 0
    ? value.autoThresholdTokens
    : DEFAULTS.autoThresholdTokens
  return { disableThinking, autoThresholdTokens }
}

/**
 * Build the force-compact settings schema through `@deepseek-ai/schemastery`.
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
    })
    return schema
  } catch {
    return null
  }
}

/**
 * Register the `force-compact` settings namespace when a `settings` service is
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

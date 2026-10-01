/**
 * Token-scale value parser — the single source of truth for how the three
 * token-budget settings (`autoThresholdTokens`, `retainLatestTokens`,
 * `maxSummaryTokens`) turn a stored value into an integer token count.
 *
 * The settings form accepts a scale suffix (`32K`, `1M`, `1.5M`), so a value
 * reaching this parser may be either:
 *
 * - a **number** (what the form writes, and what any programmatic writer
 *   stores): returned truncated to an integer;
 * - a **string** carrying an optional `K` / `M` suffix (what a hand-edited
 *   `$DSH_HOME/settings.yaml` may hold): the numeric part is multiplied by the
 *   suffix's factor and truncated to an integer.
 *
 * Suffix-free strings (`"32000"`) are simply the base-1 case — the value is
 * just converted to an integer. Grouping separators (`,` `_`) and surrounding
 * or internal whitespace are ignored, so `"1_000_000"` and `"1 M"` both parse.
 *
 * **Base 1000, not 1024.** `32K` must equal `32000` — the shipped default of
 * `autoThresholdTokens` (and its floor). Token budgets are decimal quantities
 * here: the floors (`32000`, `8000`, `1024`) and the documented maximum
 * (`200000`) are decimal, so a binary `K` would make the documented default
 * unreachable by suffix (it would be `31.25K`). This mirrors how context
 * windows are quoted for models as well.
 *
 * Everything unparseable falls back to the caller's `fallback` — this parser
 * never throws and never returns `NaN`, because its callers sit on the
 * model-request seam and inside the settings form's commit path.
 *
 * @module @falling-ts/dsh-force-compact/token-scale
 */

/**
 * Multiplier for each accepted scale suffix, keyed by its LOWERCASE letter.
 * `K` = thousand, `M` = million (see the decimal-base rationale above).
 * @type {Readonly<Record<'k' | 'm', number>>}
 */
export const TOKEN_SCALE_MULTIPLIERS = Object.freeze({ k: 1000, m: 1000000 })

/**
 * Multiplier for a value with no suffix.
 * @type {number}
 */
export const TOKEN_SCALE_BASE = 1

/**
 * Parse a stored token-scale value into an integer token count.
 *
 * @param {unknown} raw the stored value: a number, or a string with an
 *   optional `K` / `M` suffix.
 * @param {unknown} fallback returned verbatim when `raw` cannot be parsed
 *   (callers pass the field's default, or `undefined` when they prefer to
 *   detect the failure themselves).
 * @returns {unknown} the parsed integer, or `fallback`.
 */
export function parseTokenScale(raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : fallback
  }
  if (typeof raw !== 'string') return fallback
  // Separators and whitespace are cosmetic: `1_000_000`, `1,000,000`, `1 M`
  // all mean the same number. They are stripped BEFORE the shape check so a
  // grouped value is not rejected as malformed.
  const text = raw.replace(/[\s,_]/g, '')
  if (text === '') return fallback
  // Shape: an optional sign, a decimal number (integer, bare fraction, or
  // both), and an optional single scale letter. Scientific notation is
  // deliberately NOT accepted — `1e3` would otherwise be a silent third
  // spelling of a token budget.
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))([kKmM])?$/.exec(text)
  if (match === null) return fallback
  const value = Number(match[1])
  if (!Number.isFinite(value)) return fallback
  const suffix = match[2]
  const multiplier = suffix === undefined
    ? TOKEN_SCALE_BASE
    : TOKEN_SCALE_MULTIPLIERS[suffix.toLowerCase()]
  // Truncate rather than round: a token budget is a count, and truncation is
  // what the form's own commit path does for the plain-number case.
  return Math.trunc(value * multiplier)
}
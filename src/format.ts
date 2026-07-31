/**
 * Python-flavoured value formatting for error messages.
 *
 * The reader mirrors metacooler's errors, and metacooler builds its messages
 * with `{value!r}`. Reproducing `repr()` rather than reaching for
 * `JSON.stringify` keeps the JS and Python wordings byte-identical for the
 * common cases (`attrs['bin-size'] must be an integer, got 'null'`), which is
 * what makes a message greppable across both implementations.
 */

/**
 * Render a value the way Python's `repr()` would.
 *
 * Strings get single quotes unless they contain one and no double quote —
 * exactly CPython's rule. Booleans are `True`/`False` because that is what an
 * h5py attribute prints as, and `null`/`undefined` are `None` because that is
 * what an absent attribute is on the Python side.
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (typeof value !== 'string') return String(value)
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
  return `${quote}${escaped}${quote}`
}

/** Render a list of strings as Python would print it: `['a', 'b']`. */
export function pyList(values: readonly string[]): string {
  return `[${values.map(pyRepr).join(', ')}]`
}

/**
 * Parse a string the way Python's `int()` does: surrounding whitespace is
 * ignored, a leading sign is allowed, single underscores may separate digits
 * (`int('1_000') == 1000`), and *nothing else* is — not `'1e3'`, not
 * `'1000.0'`, not `'0x10'`.
 *
 * Returns `null` when the string is not an integer literal, so callers decide
 * whether that is an error (`_int_attr`) or a value to leave alone
 * (`MetaCooler.info`'s suppressed cast).
 */
export function pyInt(text: string): number | null {
  const trimmed = text.trim()
  // Underscores are legal only *between* digits, which is why this is not a
  // strip-then-match: `int('1__0')`, `int('_1')` and `int('1_')` all raise.
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(trimmed)) return null
  const value = Number(trimmed.replace(/_/g, ''))
  return Number.isFinite(value) ? value : null
}

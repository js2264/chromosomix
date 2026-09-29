/**
 * A number of contacts, as a reader types it and as the app says it (§6.5).
 *
 * One parser for the breadcrumb's *contacts* box and for `metacooler-run
 * --contacts`, so a number that works in one works in the other: `10M`,
 * `23,000,000`, `2.5e7`, `500k`, `1.2G` — the forms a methods section and a
 * `cooler info` print. And one phrase for what a resampled map is, so the
 * caption of a figure, the heading of a cell and a task's framing line say it
 * the same way.
 */

/** What a suffix multiplies by: thousand, million, billion (`G` or `B`). */
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, g: 1e9, b: 1e9 }

/** Separators a number is grouped with: commas, underscores, spaces, thin spaces, apostrophes. */
const GROUPING = /[\s,_'  ]/g

/**
 * A total typed by a reader: `null` for an empty box (the file as stored), a
 * number of contacts, or why it is not one.
 */
export function parseContacts(text: string): number | null | { refused: string } {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const compact = trimmed.replace(GROUPING, '')
  const match = /^(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?([kmgb])?$/i.exec(compact)
  if (match === null) {
    return { refused: `“${trimmed}” is not a number of contacts: type one like 10M or 23,000,000.` }
  }
  const [, digits, exponent, suffix] = match
  const value =
    Number(digits) * 10 ** Number(exponent ?? 0) * (suffix === undefined ? 1 : SUFFIX[suffix.toLowerCase()])
  // `1.5k` is 1,500 and `0.1` is not a contact; rounding off a hair of float
  // (`1.1M` is 1100000.0000000002) is not rounding off a contact.
  const rounded = Math.round(value)
  if (!Number.isFinite(value) || Math.abs(value - rounded) > 1e-6 * Math.max(1, value)) {
    return { refused: `“${trimmed}” is not a whole number of contacts.` }
  }
  if (rounded < 1) return { refused: 'A map needs at least one contact.' }
  if (rounded > Number.MAX_SAFE_INTEGER) {
    return { refused: `“${trimmed}” contacts is past what can be counted exactly here.` }
  }
  return rounded
}

/** `179,175,551` — every digit, grouped, as the box and a caption print it. */
export function contactsText(contacts: number): string {
  return Math.round(contacts).toLocaleString('en-US')
}

/** What a map was drawn to, as the reader reads it back. */
export interface DrawnDepth {
  /** The total it was drawn to. */
  contacts: number
  /** The contacts the file holds. */
  total: number
  /** `none` where the two are the same number. */
  mode: 'none' | 'sub' | 'over'
}

/**
 * `subsampled to 10,000,000 contacts (of 179,175,551)` — or oversampled, with
 * Boost-HiC named, since an oversample is an inference and a subsample is not.
 * Empty for a map drawn to its own total.
 */
export function depthPhrase(depth: DrawnDepth): string {
  if (depth.mode === 'none') return ''
  const of = `of ${contactsText(depth.total)}`
  return depth.mode === 'sub'
    ? `subsampled to ${contactsText(depth.contacts)} contacts (${of})`
    : `oversampled to ${contactsText(depth.contacts)} contacts (${of}, Boost-HiC)`
}

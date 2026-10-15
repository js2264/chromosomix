/**
 * How many chords a circle draws (§7.6): a preference, not a fact about a file.
 *
 * Every pair of sections that shares a contact has a chord, and on a circle of
 * contigs that is hundreds of thousands of them — a reader thins them to the
 * strongest few hundred to see the structure, and thins every circle they open
 * afterwards the same way. So it is kept in this browser's storage, on
 * `ui/plotOptions.ts`'s rule, rather than in the link: how dense a reader likes
 * the picture is how they read, not what they are looking at.
 */

/** What the select offers: every chord, or the strongest so many. */
export const CHORD_LIMITS: ReadonlyArray<{ value: number; label: string }> = [
  { value: Number.POSITIVE_INFINITY, label: 'all' },
  { value: 1000, label: 'strongest 1,000' },
  { value: 200, label: 'strongest 200' },
  { value: 50, label: 'strongest 50' },
]

const KEY = 'chromosomix:circle-chords'

let current: number | null = null
const listeners = new Set<(limit: number) => void>()

function read(): number {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return Number.POSITIVE_INFINITY
    const value = Number(raw)
    // Only what the select offers, so a stored value from another build lands
    // on `all` rather than on a number no option names.
    return CHORD_LIMITS.some((limit) => limit.value === value) ? value : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The chords a circle draws: `Infinity` for all of them. */
export function chordLimit(): number {
  current ??= read()
  return current
}

export function setChordLimit(limit: number): void {
  current = limit
  try {
    if (Number.isFinite(limit)) window.localStorage.setItem(KEY, String(limit))
    else window.localStorage.removeItem(KEY)
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
  for (const listener of listeners) listener(limit)
}

/** Every circle on screen follows a change made on any of them. */
export function subscribeChordLimit(listener: (limit: number) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

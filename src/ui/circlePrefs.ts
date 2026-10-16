/**
 * How many chords a circle draws, where its rings go and whether their names
 * have a column (§7.6): preferences, not facts about a file.
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

/**
 * Where the rings go (§7.6): inside the sections, between them and the chords,
 * or outside them, the sections then the inner circle round the chords — the
 * `tracks` row. A preference on the chords' terms, and for their reason: it is
 * how a reader likes the picture laid out, not what they are looking at.
 */
export type RingPlacement = 'inside' | 'outside'

const PLACEMENT_KEY = 'chromosomix:circle-rings'

let placement: RingPlacement | null = null
const placementListeners = new Set<(placement: RingPlacement) => void>()

/** Where the rings go: inside, unless the reader put them outside. */
export function ringPlacement(): RingPlacement {
  if (placement === null) {
    try {
      placement = window.localStorage.getItem(PLACEMENT_KEY) === 'outside' ? 'outside' : 'inside'
    } catch {
      placement = 'inside'
    }
  }
  return placement
}

export function setRingPlacement(next: RingPlacement): void {
  placement = next
  try {
    if (next === 'outside') window.localStorage.setItem(PLACEMENT_KEY, next)
    else window.localStorage.removeItem(PLACEMENT_KEY)
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
  for (const listener of placementListeners) listener(next)
}

/** Every circle on screen follows a change made on any of them. */
export function subscribeRingPlacement(listener: (placement: RingPlacement) => void): () => void {
  placementListeners.add(listener)
  return () => placementListeners.delete(listener)
}

/**
 * Whether the rings' names have a column of their own before twelve o'clock
 * (§7.6) — the circle's `name column`, on until the reader turns it off.
 *
 * The circle's own, not the 1D browser's `gutter` (`ui/plotOptions.ts`), which
 * it once followed: a map turned round wants its names out of the rings' way
 * whatever a stack of lanes was set to, and the stack is still on screen beside
 * it in a deck's tracks cell (§25.3) — so the circle turning its column on left
 * the browser's on too, and the map turned back to square found the browser no
 * longer as the reader set it. Kept apart, the circle has its column by default,
 * and the browser's is exactly what it was, every time.
 */
const COLUMN_KEY = 'chromosomix:circle-column'

/** The one line the toggle and the palette say about it. */
export const RING_COLUMN_HINT =
  'The rings’ names right-aligned in a column before twelve, the rings ending short of it.'

let column: boolean | null = null
const columnListeners = new Set<(on: boolean) => void>()

/** Whether the circle's names are in a column: yes, unless the reader said no. */
export function ringColumn(): boolean {
  if (column === null) {
    try {
      column = window.localStorage.getItem(COLUMN_KEY) !== 'off'
    } catch {
      column = true
    }
  }
  return column
}

export function setRingColumn(on: boolean): void {
  column = on
  try {
    if (on) window.localStorage.removeItem(COLUMN_KEY)
    else window.localStorage.setItem(COLUMN_KEY, 'off')
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
  for (const listener of columnListeners) listener(on)
}

/** Every circle on screen follows a change made on any of them, and so does every toggle. */
export function subscribeRingColumn(listener: (on: boolean) => void): () => void {
  columnListeners.add(listener)
  return () => columnListeners.delete(listener)
}

/**
 * The elements circles are drawn in, which is how the `name column`'s key and
 * command find theirs: while a circle is on screen they are its column's, and
 * while none is, the 1D browser's (`App.commands`).
 */
const circles = new Set<Pick<Element, 'isConnected' | 'getClientRects'>>()

/** A circle's element, from its view's birth to its `destroy`; returns the release. */
export function registerCircle(el: Pick<Element, 'isConnected' | 'getClientRects'>): () => void {
  circles.add(el)
  return () => circles.delete(el)
}

/**
 * Whether a circle is drawn on screen now. Asked of the page at the moment of
 * asking rather than kept as a count, because a circle in a session tab out of
 * sight, or in a map turned back to square, is still a mounted view — and its
 * element, hidden with its host, has no boxes to say so.
 */
export function circleOnScreen(): boolean {
  for (const el of circles) if (el.isConnected && el.getClientRects().length > 0) return true
  return false
}

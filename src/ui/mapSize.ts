/**
 * How big a **square** map is drawn, shared by every map on screen.
 *
 * The band's counterpart (`ui/turnBox.ts`), one file later and for the same
 * reasons: the panel is rebuilt on every navigation, so a size held as an
 * instance field is a size the reader loses on the first thing they do after
 * setting it; and the shape of a picture is one reader's preference rather than
 * one file's fact, so it lives in `localStorage` beside the theme and not in the
 * per-session memory §5.5 shares in a link.
 *
 * **One number, not two.** A band has a width and a height because it is *cut*
 * to fill them — the depth follows from the box, which is what §17.2 means by
 * "the box keeps its shape and the distance follows the zoom". A square map has
 * no such freedom: its block is as tall as it is wide, the wrap is `1 / 1`, and a
 * box of another shape would be paper down two sides of the picture. So what a
 * reader sets here is the *side*, and all four handles set the same number: drag
 * any edge outward and the map grows, which is the gesture every image editor has
 * had for thirty years.
 *
 * `null` is the state a fresh reader is in and the state a double-click on any
 * handle puts them back into — **as much room as there is**, which is a rule
 * rather than a number and so cannot be stored as one: 699 px remembered from a
 * tall window is not what "all of it" means in a short one.
 */

/** The smallest map worth drawing in, in CSS pixels. */
export const MIN_MAP_SIZE = 160

const KEY = 'metacooler-viewer:map-size'

/**
 * The side a panel with this much room draws, in CSS pixels.
 *
 * The same division of labour {@link fitTurnBox} makes: what the reader asked for
 * is one number for the session, and how much room there is to honour it is a
 * fact about one panel in one window — so the ask is stored whole and fitted on
 * the way out. Unset means the room itself, which is what a square map has always
 * done: the height a window can spare, capped by the width the columns leave.
 *
 * The floor beats the ceiling, as it does for the band: a panel with less room
 * than the minimum is a panel that cannot honour either, and the smallest real
 * picture is better than one of no pixels.
 */
export function fitMapSize(asked: number | null, room: { width: number; height: number }): number {
  const most = Math.min(room.width, room.height)
  return Math.max(MIN_MAP_SIZE, Math.min(most, asked ?? most))
}

let current: number | null | undefined
const listeners = new Set<(size: number | null) => void>()

/** A stored number that is not a positive, finite size is no number at all. */
function size(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** Stored state outlives the code that wrote it, so it is checked like input. */
function read(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw === null ? null : size(Number(raw))
  } catch {
    return null
  }
}

/** The size the reader has asked for, or `null` for "as much as there is". */
export function getMapSize(): number | null {
  if (current === undefined) current = read()
  return current
}

/** Set it — `null` for the default back — and tell every mounted panel. */
export function setMapSize(next: number | null): void {
  const value = next === null ? null : size(next)
  if (value === getMapSize()) return
  current = value
  try {
    if (value === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, String(value))
  } catch {
    /* a browser that refuses storage still honours the drag for this session */
  }
  for (const listener of listeners) listener(value)
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeMapSize(listener: (size: number | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

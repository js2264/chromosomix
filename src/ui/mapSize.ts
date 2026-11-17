/**
 * How big a map is drawn, and in what shape, shared by every map on screen.
 *
 * The band's counterpart (`ui/turnBox.ts`), one file later and for the same
 * reasons: the panel is rebuilt on every navigation, so a size held as an
 * instance field is a size the reader loses on the first thing they do after
 * setting it; and the shape of a picture is one reader's preference rather than
 * one file's fact, so it lives in `localStorage` beside the theme and not in the
 * per-session memory §5.5 shares in a link.
 *
 * **Two numbers, a width and a height, and a square until the reader says
 * otherwise** (§7.2). It was one number, the side, on the argument that a
 * square block has no shape to choose. That argument is about the *block*; the
 * box is a window onto it, and a window can be any shape, because the zoom is
 * one scalar for both axes and keeps every cell square inside whatever it is
 * drawn in: a box twice as wide as it is tall is a stretch of the diagonal twice
 * as long, at the same magnification — the shape anybody reading along a
 * diagonal past its domains wants, and the shape a stack of tracks under the
 * map leaves room for. So the two ends set the width and the top and bottom
 * the height, as they always have for a band.
 *
 * `null` on an axis is **the side of the square the map opens as** — as much
 * room as there is, which is a rule rather than a number and so cannot be
 * stored as one: 699 px remembered from a tall window is not what "all of it"
 * means in a short one. Both axes `null` is that square, which is the state a
 * fresh reader is in and the one *Fit the view* puts them back into; one axis
 * `null` is a side the reader has not touched, and it goes on following the
 * room as the square's side would.
 */

/** The smallest side of a map worth drawing in, in CSS pixels. */
export const MIN_MAP_SIZE = 160

const KEY = 'chromosomix:map-size'

/** The box the reader asked for, in CSS pixels, `null` on an axis for the square's side. */
export interface MapSize {
  width: number | null
  height: number | null
}

const SQUARE: MapSize = { width: null, height: null }

/**
 * The box a panel with this much room draws, in CSS pixels.
 *
 * The same division of labour {@link fitTurnBox} makes: what the reader asked
 * for is two numbers for the session, and how much room there is to honour them
 * is a fact about one panel in one window — so the ask is stored whole and
 * fitted on the way out. An axis nobody has set is the side of the square the
 * map opens as, which is what a map has always done: the height a window can
 * spare, capped by the width the columns leave. Each axis is then held to its
 * own room, since a box wider than the column or taller than the window is not
 * a box.
 *
 * The floor beats the ceiling, as it does for the band: a panel with less room
 * than the minimum is a panel that cannot honour either, and the smallest real
 * picture is better than one of no pixels.
 */
export function fitMapSize(
  asked: MapSize,
  room: { width: number; height: number },
): { width: number; height: number } {
  const side = Math.min(room.width, room.height)
  const fit = (value: number | null, most: number): number =>
    Math.max(MIN_MAP_SIZE, Math.min(most, value ?? side))
  return { width: fit(asked.width, room.width), height: fit(asked.height, room.height) }
}

let current: MapSize | null = null
const listeners = new Set<(size: MapSize) => void>()

/** A stored number that is not a positive, finite size is no number at all. */
function size(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/**
 * Stored state outlives the code that wrote it, so it is checked like input.
 *
 * A bare number is what this key held while the box was one number — the side
 * of a square — and it is read as that square rather than dropped, so a reader
 * who sized their map before the box had two sides still has the size they
 * chose.
 */
function read(): MapSize {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return { ...SQUARE }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'number') {
      const side = size(parsed)
      return { width: side, height: side }
    }
    if (typeof parsed !== 'object' || parsed === null) return { ...SQUARE }
    const record = parsed as Record<string, unknown>
    return { width: size(record['width']), height: size(record['height']) }
  } catch {
    return { ...SQUARE }
  }
}

function write(box: MapSize): void {
  try {
    if (box.width === null && box.height === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(box))
  } catch {
    /* a browser that refuses storage still honours the drag for this session */
  }
}

/** The box the reader has asked for, as a copy; both `null` is the square. */
export function getMapSize(): MapSize {
  current ??= read()
  return { ...current }
}

/**
 * Resize it, and tell every mounted panel.
 *
 * One axis at a time, because the handles are one axis at a time: an omitted
 * field is one the drag said nothing about, and `null` is the reader asking for
 * the square's side back on that axis alone.
 */
export function setMapSize(next: Partial<MapSize>): void {
  const held = getMapSize()
  const box: MapSize = {
    width: next.width === undefined ? held.width : size(next.width),
    height: next.height === undefined ? held.height : size(next.height),
  }
  if (box.width === held.width && box.height === held.height) return
  current = box
  write(box)
  for (const listener of listeners) listener({ ...box })
}

/** Both sides back to the square the map opens as — what *Fit the view* does. */
export function resetMapSize(): void {
  setMapSize({ ...SQUARE })
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeMapSize(listener: (size: MapSize) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

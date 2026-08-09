/**
 * The rectangle a turned map is drawn in, shared by every map on screen.
 *
 * It lives here rather than on `MatrixPanel` for the reason `ui/viewpoint.ts`
 * says of the 4C anchor, and it is the same reason: **the panel is rebuilt on
 * every navigation**. A click on a chromosome, a change of resolution, a zoom
 * that opens a region — each of those destroys the panel and builds another, so
 * a box held as an instance field is a box the reader loses on the first thing
 * they do after sizing it. Which is the gesture they are certain to make, since
 * the whole point of shaping a band is to go and look at something in it.
 *
 * Shared, and not merely remembered: the turn is the deck's rather than one
 * map's (§17.3), and a deck of bands at four different heights is not a
 * comparison. One reader, one band shape, however many pictures are drawn from
 * it — and a panel with less room than the box asks for draws what it has room
 * for, which is a clamp on the way *out* rather than a second stored number.
 *
 * `localStorage`, on `ui/plotOptions.ts`'s rule: §5.5 shares what is being
 * looked at, and how tall somebody likes their bands is not that. What is stored
 * is CSS pixels, which is what the reader dragged; a window narrower than the
 * one they dragged it in clamps, and one wider leaves the box where they put it
 * rather than growing it to fill the room.
 */

/**
 * The box, in CSS pixels, or `null` on either axis for "as the panel finds it".
 *
 * Two nulls is the state a fresh reader is in and the state a double-click on
 * either handle puts them back into — the default is a *rule* (the panel's own
 * width, and a third of it) rather than a number, so it cannot be stored as one:
 * a width of 574 remembered from a wide window is not what "whatever there is
 * room for" means in a narrow one.
 */
export interface TurnBox {
  width: number | null
  height: number | null
}

const KEY = 'metacooler-viewer:turn-box'

const EMPTY: TurnBox = { width: null, height: null }

/**
 * How tall a turned band is drawn before anybody says otherwise, against its own
 * width.
 *
 * A quarter, which is the shape of the figures this is a viewer for. A whole
 * triangle is exactly twice as wide as it is tall — that is what the half-bin
 * lattice makes it — so a box a quarter of its own width shows half the
 * separation the block holds at the fitted zoom: enough band that a domain has
 * room to be a triangle rather than a smear, and short enough that the picture
 * still reads as one strip along the genome rather than as a map.
 */
export const DEFAULT_TURN_ASPECT = 1 / 4

/**
 * The smallest box worth drawing in, in CSS pixels.
 *
 * A floor rather than a limit: a handle dragged onto its own opposite edge means
 * "as small as it goes", not "gone", and a box of no pixels is a picture with no
 * picture in it — the same rule `turnDepthFor` follows about a band of no rows.
 */
export const MIN_TURN_HEIGHT = 40
export const MIN_TURN_WIDTH = 160

/**
 * The box as a panel with this much room draws it.
 *
 * Where the two halves meet: what the reader asked for is a session-wide pair of
 * numbers, and how much room there is to honour it is a fact about one panel on
 * one window. So the ask is stored whole and fitted here, on the way out —
 * which is what lets a box shaped beside a wide map still be the box beside a
 * narrow one, and what lets a window resized smaller and back again come back
 * to the size the reader chose rather than to whatever survived the squeeze.
 *
 * The floor beats the ceiling. A panel with less room than the minimum is a
 * panel that cannot honour either, and drawing the smallest real picture there
 * is better than drawing one no pixels tall.
 */
export function fitTurnBox(
  asked: TurnBox,
  room: { width: number; height: number },
): { width: number; height: number } {
  const width = Math.max(MIN_TURN_WIDTH, Math.min(room.width, asked.width ?? room.width))
  const height = Math.max(
    MIN_TURN_HEIGHT,
    Math.min(room.height, asked.height ?? Math.round(width * DEFAULT_TURN_ASPECT)),
  )
  return { width, height }
}

let current: TurnBox | null = null
const listeners = new Set<(box: TurnBox) => void>()

/** A stored number that is not a positive, finite size is no number at all. */
function size(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** Stored state outlives the code that wrote it, so every field is checked. */
function read(): TurnBox {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return { ...EMPTY }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY }
    const record = parsed as Record<string, unknown>
    return { width: size(record['width']), height: size(record['height']) }
  } catch {
    return { ...EMPTY }
  }
}

function write(box: TurnBox): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(box))
  } catch {
    /* a browser that refuses storage still honours the drag for this session */
  }
}

/** The box the reader has asked for, as a copy. */
export function getTurnBox(): TurnBox {
  current ??= read()
  return { ...current }
}

/**
 * Resize it, and tell every mounted panel.
 *
 * One axis at a time, because the handles are one axis at a time: an omitted
 * field is one the drag said nothing about, and `null` is the reader asking for
 * the default back on that axis alone.
 */
export function setTurnBox(next: Partial<TurnBox>): void {
  const held = getTurnBox()
  const box: TurnBox = {
    width: next.width === undefined ? held.width : size(next.width),
    height: next.height === undefined ? held.height : size(next.height),
  }
  if (box.width === held.width && box.height === held.height) return
  current = box
  write(box)
  for (const listener of listeners) listener({ ...box })
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeTurnBox(listener: (box: TurnBox) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

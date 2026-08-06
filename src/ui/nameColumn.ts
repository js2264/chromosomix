/**
 * How wide the browser's name column is, and where that number is kept.
 *
 * The column is measured from the names by default — it is as wide as the widest
 * of them and no wider, which is the right answer until a reader disagrees. What
 * they disagree about is usually one long name making a column three others do
 * not need, and the fix is to pin the column and let that name wrap or be cut
 * (`render/laneLabel.ts`'s {@link fitName}). So the width becomes a *decision*
 * the moment the edge is dragged, and stops being one when it is double-clicked.
 *
 * `localStorage` and not the session memory in `state/UiMemory.ts`: how wide a
 * reader likes their track names is a preference about the application rather
 * than a train of thought about one file — the same argument `ui/plotOptions.ts`
 * and the side panels' own widths make.
 */

const KEY = 'metacooler-viewer:name-column'

/** Narrower than this and it is a stripe rather than a column. */
export const NAME_COLUMN_MIN = 40

/**
 * The width the column opens at, before anything has been measured.
 *
 * Only ever seen on the first frame after the option is switched on, and chosen
 * to be about right for a track name so that frame does not visibly jump.
 */
export const NAME_COLUMN_DEFAULT = 110

/**
 * A width the column may actually be, given the canvas it has to fit in.
 *
 * The ceiling is a third of the window: a column wider than that has stopped
 * being a margin and started being the picture, and the axis it leaves is too
 * short to read. Applied on the way in *and* on the way out of storage, because
 * a stored width outlives the build that wrote it and the window it was chosen
 * in — 900 pixels of column on a 600-pixel window would leave no axis at all.
 */
export function clampNameColumn(px: number, available: number): number {
  if (!Number.isFinite(px)) return NAME_COLUMN_DEFAULT
  const ceiling = Math.max(NAME_COLUMN_MIN, Math.floor(available / 3))
  return Math.max(NAME_COLUMN_MIN, Math.min(ceiling, Math.round(px)))
}

/** The width a reader pinned, or `null` — including for a stored absurdity. */
export function readNameColumn(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Pin the column, or hand it back to the names with `null`. */
export function writeNameColumn(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, String(Math.round(px)))
  } catch {
    /* a browser that refuses storage still honours the drag for this session */
  }
}

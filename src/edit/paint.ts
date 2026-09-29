/**
 * Draw the edited map from the picture, through the lens (SPECS §27.9).
 *
 * The picture is in the file's order and the screen is in the edit's, so every
 * pixel asks the lens which cell of the picture it shows: the edited cell under
 * the pixel's centre, then {@link LensGrid.cellMap}, then the level of the
 * pyramid whose cell is about a pixel. That is two lookups a pixel on top of
 * the colour, and no picture is built between the two — so an edit, a pan and a
 * piece dragged under the pointer all cost one paint, the same paint.
 *
 * Pure: typed arrays in, typed arrays out, so it is tested without a canvas.
 */

import { applyColormap, colormapIndex } from '../render/colormaps'
import { logOf, type Quantizer } from '../metacooler/picture'

/** One level of the picture: an upper triangle `n` a side. */
export interface PaintLevel {
  n: number
  cells: Uint8Array
}

/** The window to draw, in units of the edited axis, and the pixels it fills. */
export interface PaintView {
  /** Columns: the units at the left and right edges. */
  x0: number
  x1: number
  /** Rows: the units at the top and bottom edges. */
  y0: number
  y1: number
  width: number
  height: number
}

/**
 * Every byte's colour, as the 32-bit pixel `ImageData` holds — red in the low
 * byte, on the little-endian machines browsers run on. Byte `0`, a cell with
 * nothing in it, is transparent, as a blank cell is on every map (§6.4).
 *
 * `vmin` and `vmax` are base-10 logs, as the picture's own range is.
 */
export function pictureColours(colormap: string, q: Quantizer, vmin: number, vmax: number): Uint32Array {
  const table = applyColormap(colormap)
  const out = new Uint32Array(256)
  const span = vmax > vmin ? vmax - vmin : 1
  for (let byte = 1; byte < 256; byte++) {
    const index = colormapIndex((logOf(byte, q) - vmin) / span)
    if (index < 0) continue
    const at = index * 4
    out[byte] = ((table[at + 3] << 24) | (table[at + 2] << 16) | (table[at + 1] << 8) | table[at]) >>> 0
  }
  return out
}

/** The level of the pyramid whose cell is nearest a pixel at this zoom. */
export function levelFor(unitsPerPixel: number, levels: number): number {
  if (!(unitsPerPixel > 1)) return 0
  return Math.max(0, Math.min(levels - 1, Math.round(Math.log2(unitsPerPixel))))
}

/**
 * The picture cell each pixel along one side shows, at a level — `-1` off the
 * axis or in a gap.
 */
function sideCells(
  cellMap: Int32Array,
  from: number,
  to: number,
  pixels: number,
  shift: number,
): Int32Array {
  const out = new Int32Array(pixels)
  const per = (to - from) / pixels
  for (let p = 0; p < pixels; p++) {
    const unit = Math.floor(from + (p + 0.5) * per)
    const cell = unit >= 0 && unit < cellMap.length ? cellMap[unit] : -1
    out[p] = cell < 0 ? -1 : cell >> shift
  }
  return out
}

/**
 * Paint a window of the edited map into `target`, `view.width × view.height`
 * pixels, row-major.
 *
 * @param rows The lens for the rows, `cols` for the columns: the same one on the
 *   stage's square map, two while a stretch is dragged between them.
 */
export function paintPicture(
  target: Uint32Array,
  view: PaintView,
  rows: Int32Array,
  cols: Int32Array,
  levels: readonly PaintLevel[],
  colours: Uint32Array,
): void {
  const { width, height } = view
  const upp = Math.max((view.x1 - view.x0) / width, (view.y1 - view.y0) / height)
  const level = levelFor(upp, levels.length)
  const { n, cells } = levels[level]
  const rowCell = sideCells(rows, view.y0, view.y1, height, level)
  const colCell = sideCells(cols, view.x0, view.x1, width, level)
  // Where each row's and each column's own run of the triangle begins, so the
  // inner loop is a subtraction and a lookup whichever half a pixel is in.
  const base = (a: number): number => a * n - (a * (a - 1)) / 2
  const colBase = new Float64Array(width)
  for (let x = 0; x < width; x++) colBase[x] = colCell[x] < 0 ? -1 : base(colCell[x])
  for (let y = 0; y < height; y++) {
    const a = rowCell[y]
    const row = y * width
    if (a < 0) {
      target.fill(0, row, row + width)
      continue
    }
    const rowBase = base(a)
    for (let x = 0; x < width; x++) {
      const b = colCell[x]
      if (b < 0) {
        target[row + x] = 0
        continue
      }
      target[row + x] = colours[cells[a <= b ? rowBase + (b - a) : colBase[x] + (a - b)]]
    }
  }
}

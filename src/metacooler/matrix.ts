/**
 * Bounded matrix reads and the COO → dense scatter (spec §5.3, §6.2; M2).
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **The read is bounded.** A block is one slice of `indexes/bin1_offset`
 *    followed by one contiguous slice of each pixel column — four reads, never
 *    a scan. Nothing else in the file is touched.
 * 2. **Storage is upper-triangular.** `bin1_id <= bin2_id`, so an off-diagonal
 *    block whose column range *precedes* its row range has no stored pixels at
 *    all and must be queried transposed and flipped. Skipping that produces
 *    blank inter-genome panels — silently breaking the app's most distinctive
 *    feature rather than erroring.
 */

import {
  BROWSER_CANVAS_DIM_LIMIT,
  BROWSER_DENSE_CELL_LIMIT,
  DENSE_MATRIX_BIN_LIMIT,
  type StorageMode,
} from '../constants'
import { ViewerError } from '../errors'
import type { Hdf5Handle } from '../h5/api'
import { dtypeKind } from '../h5/typed'
import type { DenseMatrix, Extent, MatrixQuery, PixelChunk } from '../types'

/**
 * Hints reused verbatim from `metacooler.ops.show`, so the browser and the CLI
 * refuse an over-large selection with the same sentence. Diverging wording
 * here would make a support question about one unanswerable from the other.
 */
export const DENSE_HINTS = {
  /** `show --level genome` on a file with too many genomes. */
  genome: 'Use a smaller file.',
  /** `show --level contig`. */
  contig: 'Use --level genome, --genomes/--contigs, or a smaller file.',
  /** `show --range/--range2`. */
  range: 'Use a narrower --range/--range2.',
  /** `show --level bin` with a genome/contig selection. */
  binSelection: 'Use --range to select a smaller region, or --level contig.',
} as const

/** The parts of an open map a matrix read needs. `MetaCooler` satisfies it. */
export interface MatrixSource {
  readonly handle: Hdf5Handle
  readonly nBins: number
  readonly storageMode: StorageMode
}

/**
 * Refuse to materialise a dense block larger than Python's limit.
 *
 * A mirror of `_check_dense_size`, including its element-count formulation:
 * the limit is `DENSE_MATRIX_BIN_LIMIT ** 2` *cells*, not bins per axis, so a
 * rectangular selection is judged on what is actually about to be allocated.
 * The message is Python's, down to the `×` and the one decimal place.
 *
 * @throws ViewerError `dense-too-large`.
 */
export function checkDenseSize(nRows: number, nCols: number, hint: string): void {
  if (nRows * nCols > DENSE_MATRIX_BIN_LIMIT ** 2) {
    const gb = (nRows * nCols * 8) / 1e9
    throw new ViewerError(
      'dense-too-large',
      `Refusing to allocate a ${nRows}×${nCols} dense matrix (${gb.toFixed(1)} GB). ${hint}`,
      { nRows, nCols, limit: DENSE_MATRIX_BIN_LIMIT },
    )
  }
}

/**
 * The same question asked of a browser tab, which is a smaller room.
 *
 * Separate from {@link checkDenseSize} rather than folded into it, because that
 * function's numbers and wording are Python's and are asserted verbatim. This
 * one speaks for the renderer: the block is not just allocated, it is
 * transformed, rasterised and put on a canvas, and the canvas has an area cap
 * no amount of memory gets around.
 *
 * @throws ViewerError `dense-too-large`.
 */
export function checkBrowserDenseSize(nRows: number, nCols: number, hint: string): void {
  const cells = nRows * nCols
  const longest = Math.max(nRows, nCols)
  if (cells <= BROWSER_DENSE_CELL_LIMIT && longest <= BROWSER_CANVAS_DIM_LIMIT) return

  // Two different refusals, because they are two different walls and the fix
  // differs: too much of it, or too long a side to rasterise at all.
  const message =
    longest > BROWSER_CANVAS_DIM_LIMIT
      ? `Refusing to draw a ${nRows}×${nCols} block in a browser tab: a ${longest}-bin axis cannot ` +
        `be rasterised, because a canvas is at most ${BROWSER_CANVAS_DIM_LIMIT} pixels on a side.`
      : `Refusing to draw a ${nRows}×${nCols} block in a browser tab: ${fmtCells(cells)} cells is ` +
        `about ${((cells * 16) / 1e9).toFixed(1)} GB once the values, the colour mapping and the ` +
        `canvas are counted. The limit here is ${fmtCells(BROWSER_DENSE_CELL_LIMIT)} cells — ` +
        `roughly ${Math.round(Math.sqrt(BROWSER_DENSE_CELL_LIMIT))} bins per axis.`

  throw new ViewerError('dense-too-large', `${message} ${hint}`, {
    nRows,
    nCols,
    cells,
    limit: BROWSER_DENSE_CELL_LIMIT,
    axisLimit: BROWSER_CANVAS_DIM_LIMIT,
    where: 'browser',
  })
}

/** `2.5e9` → `2.5 billion`, for a sentence rather than a table. */
function fmtCells(cells: number): string {
  if (cells >= 1e9) return `${(cells / 1e9).toFixed(1)} billion`
  if (cells >= 1e6) return `${(cells / 1e6).toFixed(0)} million`
  return String(cells)
}

/**
 * Resolve the `pixels/count` dtype **once**, at open (correction #2).
 *
 * Three paths are legal — int32 at base resolution, int64 wherever counts have
 * been summed (`binnify`, `merge`), and float64 when the source column was
 * float, because `resolve_count_dtype` preserves float sources rather than
 * truncating them. `CORE_COLUMN_KINDS` accordingly permits `i`, `u` *or* `f`,
 * so this tests the dtype *kind* and never an exact dtype.
 *
 * The decode itself is the HDF5 layer's job (`readNumeric` narrows every
 * numeric column to `Number`, which is exact for float64 and for any integer
 * count below 2^53). What the kind buys is the guarantee, recorded once
 * instead of re-derived per pixel, that float counts are never rounded.
 *
 * The kind comes from `h5/typed.dtypeKind`, never from slicing the dtype
 * string: h5wasm reports **C-struct** spellings, not numpy ones — int64 is
 * `'<q'`, float64 `'<d'`, a fixed-length string `'A25'`. Taking `dtype[1]`
 * yields `'q'` and `'d'`, neither of which is in `['i','u','f']`, so every
 * `binnify`/`merge` output (int64) and every float-count file would be refused
 * as "not numeric" — which is exactly what happened before this call was
 * routed through the mapping table.
 *
 * @throws ViewerError `format` for a `count` column that is not numeric.
 */
export function resolveCountKind(dtype: string): 'i' | 'u' | 'f' {
  const kind = dtypeKind(dtype)
  if (kind === 'i' || kind === 'u' || kind === 'f') return kind
  throw new ViewerError(
    'format',
    `/pixels/count is stored as ${dtype} (kind '${kind}'); expected one of the kinds ` +
      `['i', 'u', 'f']. A non-numeric count column cannot be rendered.`,
    { dtype, kind },
  )
}

/**
 * Read every pixel whose **row** bin falls in `[lo, hi)`.
 *
 * One `bin1_offset` slice gives the pixel range; the three pixel columns are
 * then one contiguous span each. Four reads total, independent of how many
 * pixels come back.
 */
export function readPixelSpan(h: Hdf5Handle, lo: number, hi: number): PixelChunk {
  const empty: PixelChunk = {
    bin1: new Int32Array(0),
    bin2: new Int32Array(0),
    count: new Float64Array(0),
    length: 0,
  }
  if (hi <= lo) return empty

  // hi + 1 is safe: bin1_offset has one entry per bin plus a terminator.
  const offsets = h.readNumeric('indexes/bin1_offset', lo, hi + 1)
  const p0 = offsets[0]
  const p1 = offsets[offsets.length - 1]
  if (p1 <= p0) return empty

  const bin1 = h.readNumeric('pixels/bin1_id', p0, p1)
  const bin2 = h.readNumeric('pixels/bin2_id', p0, p1)
  const count = h.readNumeric('pixels/count', p0, p1)
  return {
    bin1: Int32Array.from(bin1),
    bin2: Int32Array.from(bin2),
    count,
    length: count.length,
  }
}

/**
 * Where each stored pixel lands in the output block.
 *
 * - `direct` — `(bin1 → row, bin2 → col)` only.
 * - `transpose` — `(bin2 → row, bin1 → col)` only; the stored pixel is the
 *   flip of the cell being drawn.
 * - `symmetric` — both, with the diagonal placed once.
 */
export type PlacementMode = 'direct' | 'transpose' | 'symmetric'

/** How a block must be fetched and placed, given the storage mode. */
export interface ReadPlan {
  /** Row-bin span to slice out of `bin1_offset`. */
  span: Extent
  mode: PlacementMode
}

/**
 * Decide the bounded read for a block, and how its pixels map into it.
 *
 * Under `symmetric-upper` there are three shapes:
 *
 * - **column range strictly before the row range** — every relevant pixel is
 *   stored with `bin1` in the *columns*, so the span is the column range and
 *   every pixel is placed transposed. This is the case §5.3 warns about.
 * - **row range strictly before the column range** — pixels are stored the way
 *   they will be displayed; read the row band and filter on `bin2`.
 * - **overlapping (including the on-diagonal case)** — read the union, which
 *   is at most `nRows + nCols` wide, place directly, and mirror across the
 *   diagonal without doubling the diagonal itself.
 *
 * Under `square` both triangles are stored, so mirroring is skipped entirely
 * and the row band alone is always correct.
 */
export function planRead(rows: Extent, cols: Extent, storageMode: StorageMode): ReadPlan {
  if (storageMode !== 'symmetric-upper') {
    return { span: rows, mode: 'direct' }
  }
  if (cols[1] <= rows[0]) return { span: cols, mode: 'transpose' }
  if (rows[1] <= cols[0]) return { span: rows, mode: 'direct' }
  return { span: [Math.min(rows[0], cols[0]), Math.max(rows[1], cols[1])], mode: 'symmetric' }
}

/**
 * Scatter a COO chunk into a dense row-major block.
 *
 * Counts are added, never assigned, and never rounded: a float `count` column
 * survives to the canvas exactly as stored.
 */
export function scatterDense(
  chunk: PixelChunk,
  rows: Extent,
  cols: Extent,
  plan: ReadPlan,
  values: Float32Array,
): void {
  const [r0, r1] = rows
  const [c0, c1] = cols
  const nCols = c1 - c0
  const { bin1, bin2, count, length } = chunk
  const placeDirect = plan.mode !== 'transpose'
  const placeFlipped = plan.mode !== 'direct'
  // Under 'symmetric' the two placements are the same cell when b1 === b2, and
  // that guard is the whole reason the diagonal is not counted twice. Under
  // 'transpose' the ranges are disjoint, so b1 === b2 cannot occur anyway.
  const skipDiagonal = plan.mode === 'symmetric'
  for (let i = 0; i < length; i++) {
    const b1 = bin1[i]
    const b2 = bin2[i]
    const v = count[i]
    if (placeDirect && b1 >= r0 && b1 < r1 && b2 >= c0 && b2 < c1) {
      values[(b1 - r0) * nCols + (b2 - c0)] += v
    }
    if (placeFlipped && !(skipDiagonal && b1 === b2) && b2 >= r0 && b2 < r1 && b1 >= c0 && b1 < c1) {
      values[(b2 - r0) * nCols + (b1 - c0)] += v
    }
  }
}

/**
 * Read one dense block: the single entry point every view goes through.
 *
 * @param src The open map (its handle, bin count and storage mode).
 * @param q Row range, optional column range (defaults to the rows), balancing.
 * @param hint Sentence appended to a size refusal — pick one of
 *   {@link DENSE_HINTS} so the wording matches the CLI's for that situation.
 */
export function readDenseMatrix(src: MatrixSource, q: MatrixQuery, hint: string): DenseMatrix {
  if (q.balance) {
    throw new ViewerError(
      'unsupported',
      'Balancing is unavailable in the viewer: weights live in the /bins table, which this ' +
        'reader never reads (spec §3.3 — excluding variable-bin files is what removes every ' +
        '/bins access). Use `metacooler show` for a balanced view.',
      {},
    )
  }

  const rows = checkExtent(q.rows, src.nBins, 'rows')
  const cols = checkExtent(q.cols ?? q.rows, src.nBins, 'cols')
  const nRows = rows[1] - rows[0]
  const nCols = cols[1] - cols[0]
  checkDenseSize(nRows, nCols, hint)
  checkBrowserDenseSize(nRows, nCols, hint)

  const values = new Float32Array(nRows * nCols)
  if (nRows > 0 && nCols > 0) {
    const plan = planRead(rows, cols, src.storageMode)
    const chunk = readPixelSpan(src.handle, plan.span[0], plan.span[1])
    scatterDense(chunk, rows, cols, plan, values)
  }
  return { nrows: nRows, ncols: nCols, values, rowExtent: rows, colExtent: cols }
}

/** Reject a bin range that is inverted or outside the matrix. */
function checkExtent(extent: Extent, nBins: number, which: string): Extent {
  const [lo, hi] = extent
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > nBins) {
    throw new ViewerError(
      'bad-range',
      `Bin range for ${which} is [${lo}, ${hi}); it must be a half-open integer interval ` +
        `inside [0, ${nBins}).`,
      { extent, nBins, which },
    )
  }
  return [lo, hi]
}

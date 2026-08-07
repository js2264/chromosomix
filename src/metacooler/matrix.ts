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
  DENSE_MATRIX_BIN_LIMIT,
  DEVICE_MEMORY_FALLBACK_GIB,
  DEVICE_MEMORY_SHARE,
  MAX_DENSE_ARRAY_BYTES,
  MIN_DENSE_BUDGET_BYTES,
  MIN_DENSE_BUDGET_GIB,
  type StorageMode,
} from '../constants'
import { yieldToEventLoop } from '../async'
import { rasterStride } from '../render/heatmap'
import { ViewerError } from '../errors'
import type { Hdf5Handle } from '../h5/api'
import { dtypeKind } from '../h5/typed'
import type { DenseMatrix, Extent, MatrixQuery, PixelChunk } from '../types'

/**
 * Hints reused verbatim from `metacooler.ops.show`, so the browser and the CLI
 * refuse an over-large selection with the same sentence. Diverging wording
 * here would make a support question about one unanswerable from the other.
 */
/** cooler's own name for the balancing weights; `cooler balance` writes it. */
export const DEFAULT_WEIGHT_COLUMN = 'weight'

/**
 * The value column every cooler has, and the default for every read.
 *
 * cooler's schema fixes `/pixels` at `bin1_id`, `bin2_id`, `count`, and a file
 * may carry more beside them — a second normalisation, an expected value, a
 * per-pixel p-value. Those are data columns exactly as `count` is, so the
 * reader takes the column *by name* rather than knowing one; see
 * {@link scoreColumns} for how a file says which it has.
 */
export const DEFAULT_COUNT_COLUMN = 'count'

/** The two `/pixels` columns that are coordinates rather than values. */
const PIXEL_COORDINATES = new Set(['bin1_id', 'bin2_id'])

/**
 * The value columns a file offers, `count` first.
 *
 * Read from the group's own child list rather than from a fixed set, because
 * "what is in this file" is a question the file answers and this code cannot.
 * Coordinates are dropped; everything else is a number per pixel and therefore
 * something a reader might want the map drawn from.
 */
export function scoreColumns(handle: Hdf5Handle): string[] {
  const keys = handle.keys('pixels').filter((key) => !PIXEL_COORDINATES.has(key))
  // `count` first wherever it is, because it is the one every file has and the
  // one every other column is an alternative *to*.
  return [
    ...keys.filter((key) => key === DEFAULT_COUNT_COLUMN),
    ...keys.filter((key) => key !== DEFAULT_COUNT_COLUMN).sort(),
  ]
}

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
 * What one displayed block costs, in bytes, before it is read.
 *
 * Not a limit — an estimate, and now an honest one. There are exactly two
 * things that scale with the selection and one that does not:
 *
 * - the dense values, `4 B` per cell, held for as long as the view is open;
 * - the raster: pooled values, RGBA, canvas backing store and the transient
 *   auto-range buffer, `16 B` per raster pixel — and the raster is pooled at
 *   {@link RASTER_MAX_DIM}, so this is a constant ceiling rather than something
 *   that grows;
 * - the pixel read, one bounded window at a time
 *   ({@link forEachPixelSpan}), which is why there is no `nnz` term any more.
 *
 * The `nnz` term this used to carry was wrong in two directions at once. It
 * charged `16 B` per stored pixel where the unwindowed read held `32`, and it
 * measured that against `min(cells, nnz)` when what the read actually pulled in
 * was every pixel of the *row band* — a population bounded by the file's `nnz`
 * and unrelated to the block's cell count, so a small block on the diagonal of
 * a large file could cost several times what it was charged. Reading in windows
 * makes the term a constant, which is both cheaper and true.
 */
export function estimateBlockBytes(nRows: number, nCols: number): number {
  const cells = nRows * nCols
  const rasterPixels =
    Math.ceil(nRows / rasterStride(nRows)) * Math.ceil(nCols / rasterStride(nCols))
  // 16 B per raster pixel, not 8: the pooled `Float32Array`, the RGBA bytes and
  // the canvas backing store are all live at once (4 each), and the auto-range
  // buffer is a fourth, transient, over the *pooled* values rather than over
  // the matrix. All four are bounded by `RASTER_MAX_DIM`, so this whole term is
  // a ceiling of about 268 MB however large the selection is.
  return cells * 4 + rasterPixels * 16 + PIXEL_CHUNK_BYTES
}

/**
 * What this machine will lend one block.
 *
 * `navigator.deviceMemory` is a coarse, capped hint rather than a measurement,
 * so the share taken from it is modest and the floor is generous. Absent — Node,
 * Firefox, Safari — the fallback assumes a modest laptop.
 */
export function deviceDenseBudgetBytes(): number {
  const reported = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory
  return denseBudgetFor(
    typeof reported === 'number' && reported > 0 ? reported : DEVICE_MEMORY_FALLBACK_GIB,
  )
}

/**
 * The budget for a machine claiming `gib` gibibytes — the whole policy, with
 * no globals in it so it can be stated as a table in a test.
 *
 * The floor is a correction for a *pessimistic* hint, so it applies only where
 * the hint is large enough to be one. Below {@link MIN_DENSE_BUDGET_GIB} the
 * device is telling us it is small, and raising its budget to a flat 1 GB —
 * four times the whole machine, at the bottom of the reported scale — is not
 * generosity but a killed tab.
 */
export function denseBudgetFor(gib: number): number {
  const share = gib * 1024 ** 3 * DEVICE_MEMORY_SHARE
  return gib >= MIN_DENSE_BUDGET_GIB ? Math.max(MIN_DENSE_BUDGET_BYTES, share) : share
}

/**
 * The same question asked of a browser tab, which is a smaller room.
 *
 * Separate from {@link checkDenseSize} rather than folded into it, because that
 * function's numbers and wording are Python's and are asserted verbatim. This
 * one speaks for the renderer, and it is deliberately an *estimate against a
 * budget* rather than a fixed cell count: a whole yeast genome at 1 kb is
 * 12,100 bins — 1.5e8 cells, which any fixed limit round enough to state would
 * refuse, and which actually costs about 600 MB and opens fine. Small genomes
 * are exactly the case a cooler in this viewer is for, so the guard has to
 * measure rather than guess.
 *
 * There is no `nnz` consultation any more, and no file read: the estimate is a
 * closed form in the block's own shape ({@link estimateBlockBytes}), because
 * windowing the pixel read took the one term that depended on the file out of
 * it. The guard is therefore both cheaper — it never touches the handle — and
 * accurate, which the version that budgeted against `min(cells, nnz)` was not.
 *
 * @throws ViewerError `dense-too-large`.
 */
export function checkBrowserDenseSize(
  nRows: number,
  nCols: number,
  hint: string,
  options: { budgetBytes?: number } = {},
): void {
  const cells = nRows * nCols
  // First, and not subject to the budget: a block whose values do not fit in
  // one typed array cannot be read however much memory the machine has or the
  // user offers. `budgetBytes: Infinity` is a statement about the *estimate*,
  // which is a guess about this machine; this is not a guess and not about this
  // machine. See MAX_DENSE_ARRAY_BYTES.
  if (cells * 4 >= MAX_DENSE_ARRAY_BYTES) {
    const side = Math.floor(Math.sqrt(MAX_DENSE_ARRAY_BYTES / 4))
    throw new ViewerError(
      'dense-too-large',
      `Refusing to load a ${nRows}×${nCols} block: its ${fmtCells(cells)} values are ` +
        `${fmtBytes(cells * 4)} and a browser serves at most ${fmtBytes(MAX_DENSE_ARRAY_BYTES)} ` +
        'in a single array — a limit of the tab, not of this machine, so more memory and more ' +
        `patience will not lift it. The largest square block is about ${side}×${side} bins.` +
        (hint === '' ? '' : ` ${hint}`),
      { nRows, nCols, cells, bytes: cells * 4, limit: MAX_DENSE_ARRAY_BYTES, where: 'array-limit' },
    )
  }

  const budget = options.budgetBytes ?? deviceDenseBudgetBytes()
  const bytes = estimateBlockBytes(nRows, nCols)
  if (bytes <= budget) return

  throw new ViewerError(
    'dense-too-large',
    `Refusing to load a ${nRows}×${nCols} block in a browser tab: ${fmtCells(cells)} cells ` +
      `needs about ${fmtBytes(bytes)}, and this tab is budgeting ${fmtBytes(budget)}. ${hint}`,
    { nRows, nCols, cells, bytes, budget, where: 'browser' },
  )
}

/** `1.6e9` → `1.6 GB`; small enough numbers get MB. */
function fmtBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
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
  const parts: PixelChunk[] = []
  let total = 0
  forEachPixelSpan(h, lo, hi, (chunk) => {
    parts.push({
      bin1: chunk.bin1.slice(),
      bin2: chunk.bin2.slice(),
      count: chunk.count.slice(),
      length: chunk.length,
    })
    total += chunk.length
  })
  if (parts.length === 1) return parts[0]
  const bin1 = new Int32Array(total)
  const bin2 = new Int32Array(total)
  const count = new Float64Array(total)
  let at = 0
  for (const part of parts) {
    bin1.set(part.bin1, at)
    bin2.set(part.bin2, at)
    count.set(part.count, at)
    at += part.length
  }
  return { bin1, bin2, count, length: total }
}

/**
 * Stored pixels whose row bin falls in `[lo, hi)`, without reading the file.
 *
 * Two entries of an index that is one number per bin — the cheapest read there
 * is, and the same one `genomeDensity` makes. It is what a size guard should be
 * asking: a block's cost is set by the pixels its *row band* holds, which is
 * bounded by the file's `nnz` and not by the block's own cell count.
 */
export function spanPixelCount(h: Hdf5Handle, lo: number, hi: number): number {
  if (hi <= lo) return 0
  const start = h.readNumeric('indexes/bin1_offset', lo, lo + 1)[0]
  const end = h.readNumeric('indexes/bin1_offset', hi, hi + 1)[0]
  return Math.max(0, end - start)
}

/**
 * Pixels per window in {@link forEachPixelSpan}; the order of magnitude the
 * scan path already uses.
 */
export const PIXEL_CHUNK = 1_000_000

/**
 * Peak bytes one window of {@link forEachPixelSpan} holds.
 *
 * Two `Int32Array`s and a `Float64Array` at the window size, plus the transient
 * buffers h5wasm mints on the way (an int64 column arrives as `BigInt64Array`
 * and is narrowed in one pass). Charged as a constant by
 * {@link estimateBlockBytes}, which is the whole point of reading in windows.
 */
export const PIXEL_CHUNK_BYTES = PIXEL_CHUNK * 36

/**
 * Read the pixels whose **row** bin falls in `[lo, hi)`, in bounded windows.
 *
 * One `bin1_offset` slice gives the pixel range; the three pixel columns are
 * then read a window at a time and handed to `onChunk` before the next window
 * is fetched.
 *
 * **The windowing is not an optimisation, it is the correctness fix.** The span
 * of a whole-genome block is the whole file, and reading it in one shot put
 * `32 B` per stored pixel on the JS heap simultaneously — 3.2 GB at 100 M
 * pixels — while the estimator that had waved the block through charged 16.
 * It also staged each column whole inside h5wasm's linear memory, which is hard
 * capped at 2 GiB whatever the machine has, so a span past ~2.7e8 pixels failed
 * outright with an error carrying no code and no advice. A window is 36 MB and
 * neither problem exists at any file size.
 *
 * The buffers handed to `onChunk` are **not** retained between calls; a callback
 * that needs them past its own return must copy.
 */
export function forEachPixelSpan(
  h: Hdf5Handle,
  lo: number,
  hi: number,
  onChunk: (chunk: PixelChunk) => void,
  chunkSize: number = PIXEL_CHUNK,
  value: string = DEFAULT_COUNT_COLUMN,
): void {
  const range = pixelSpanRange(h, lo, hi)
  if (range === null) return
  const width = Math.max(1, Math.trunc(chunkSize))
  for (let at = range[0]; at < range[1]; at += width) {
    onChunk(readPixelWindow(h, at, Math.min(at + width, range[1]), value))
  }
}

/** What a span asks for: the pixel range, or `null` when it holds none. */
function pixelSpanRange(h: Hdf5Handle, lo: number, hi: number): [number, number] | null {
  if (hi <= lo) return null
  // hi + 1 is safe: bin1_offset has one entry per bin plus a terminator.
  const offsets = h.readNumeric('indexes/bin1_offset', lo, hi + 1)
  const p0 = offsets[0]
  const p1 = offsets[offsets.length - 1]
  return p1 <= p0 ? null : [p0, p1]
}

function readPixelWindow(
  h: Hdf5Handle,
  at: number,
  end: number,
  value: string = DEFAULT_COUNT_COLUMN,
): PixelChunk {
  const bin1 = h.readInt32('pixels/bin1_id', at, end)
  const bin2 = h.readInt32('pixels/bin2_id', at, end)
  const count = h.readNumeric(`pixels/${value}`, at, end)
  return { bin1, bin2, count, length: count.length }
}

/** How a caller watches, and interrupts, a walk over a span of pixels. */
export interface SpanScanOptions {
  chunkSize?: number
  /** Polled between windows; `true` abandons the walk where it stands. */
  cancelled?: () => boolean
  /** Pixels read so far, and how many there are in this span. */
  onProgress?: (done: number, total: number) => void
}

/**
 * The same walk, watched — and therefore interruptible.
 *
 * Identical to {@link forEachPixelSpan} in what it reads and in what order; the
 * difference is the `await` between windows. That is not politeness, it is the
 * whole of what makes a cancel work: the cancel arrives as a message, and a
 * synchronous loop never lets the message queue run however many microtasks it
 * awaits (`../async`). A read that can take twenty seconds has to be one a
 * person can call off, and cannot report how far along it is unless it stops
 * between windows to say so.
 *
 * @returns `false` when it stopped early because the caller said so.
 */
export async function forEachPixelSpanAsync(
  h: Hdf5Handle,
  lo: number,
  hi: number,
  onChunk: (chunk: PixelChunk) => void,
  options: SpanScanOptions = {},
): Promise<boolean> {
  const range = pixelSpanRange(h, lo, hi)
  if (range === null) return true
  const [p0, p1] = range
  const width = Math.max(1, Math.trunc(options.chunkSize ?? PIXEL_CHUNK))
  const total = p1 - p0
  for (let at = p0; at < p1; at += width) {
    if (options.cancelled?.() === true) return false
    const end = Math.min(at + width, p1)
    onChunk(readPixelWindow(h, at, end))
    options.onProgress?.(end - p0, total)
    await yieldToEventLoop()
  }
  return true
}

/**
 * Stored pixels' worth of gap that is cheaper to read across than to seek over.
 *
 * The byte sources read in 1 MiB chunks, and a stored pixel is 16 bytes on the
 * wire, so anything under about 65,000 pixels is inside a chunk that is being
 * fetched regardless. Merging below it turns a thousand small bands into a few
 * large ones without reading a byte more than the source already would.
 */
export const PIXEL_BAND_GAP = 65_536

/**
 * The same walk over **several** pixel ranges, as one operation.
 *
 * A selection of four MAGs out of two thousand used to cost the whole file: the
 * pixels it wants are scattered, so the read walked `[0, nBins)` and threw away
 * everything that was not on either axis. But the pixels are sorted by `bin1`,
 * so every pixel a selection wants is inside the *row band* of one of its own
 * sequences — a pair with both ends selected is stored under the lower of them,
 * which is selected — and `bin1_offset` says where each band is in two lookups.
 *
 * So the caller hands in the bands, already merged, and this walks them in
 * order with one progress count across the lot. Cancellation is checked between
 * windows exactly as it is for a single range, because it is the same loop.
 */
export async function forEachPixelRangesAsync(
  h: Hdf5Handle,
  ranges: ReadonlyArray<Extent>,
  onChunk: (chunk: PixelChunk) => void,
  options: SpanScanOptions = {},
): Promise<boolean> {
  const width = Math.max(1, Math.trunc(options.chunkSize ?? PIXEL_CHUNK))
  const total = ranges.reduce((sum, [p0, p1]) => sum + Math.max(0, p1 - p0), 0)
  let done = 0
  for (const [p0, p1] of ranges) {
    for (let at = p0; at < p1; at += width) {
      if (options.cancelled?.() === true) return false
      const end = Math.min(at + width, p1)
      onChunk(readPixelWindow(h, at, end))
      done += end - at
      options.onProgress?.(done, total)
      await yieldToEventLoop()
    }
  }
  return true
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
  const rows = checkExtent(q.rows, src.nBins, 'rows')
  const cols = checkExtent(q.cols ?? q.rows, src.nBins, 'cols')
  const nRows = rows[1] - rows[0]
  const nCols = cols[1] - cols[0]
  checkDenseSize(nRows, nCols, hint)
  checkBrowserDenseSize(nRows, nCols, hint, {
    ...(q.budgetBytes === undefined ? {} : { budgetBytes: q.budgetBytes }),
  })

  const values = allocateDense(nRows, nCols, hint)
  if (nRows > 0 && nCols > 0) {
    const plan = planRead(rows, cols, src.storageMode)
    // Scattered window by window: `scatterDense` is additive and per-pixel, so
    // it needs no knowledge that the span arrived in pieces, and the peak COO
    // footprint is one window rather than the whole row band.
    forEachPixelSpan(
      src.handle,
      plan.span[0],
      plan.span[1],
      (chunk) => {
        scatterDense(chunk, rows, cols, plan, values)
      },
      PIXEL_CHUNK,
      q.value ?? DEFAULT_COUNT_COLUMN,
    )
    if (q.balance === true) applyWeights(src.handle, rows, cols, values)
  }
  return { nrows: nRows, ncols: nCols, values, rowExtent: rows, colExtent: cols }
}

/**
 * The dense block, or a refusal carrying the same code as the estimate's.
 *
 * The estimate is a prediction; this is the machine answering. A typed array
 * the runtime cannot serve throws a catchable `RangeError`, which is a
 * *measurement* of what is available in the only unit that matters and is free
 * to take — where guessing from `navigator.deviceMemory`, a value two of the
 * three major engines do not implement, is neither. Translating it here is what
 * lets the estimate above be generous without the failure being a raw stack
 * trace on an error screen.
 */
function allocateDense(nRows: number, nCols: number, hint: string): Float32Array {
  try {
    return new Float32Array(nRows * nCols)
  } catch (cause) {
    const cells = nRows * nCols
    throw new ViewerError(
      'dense-too-large',
      `This machine could not allocate the ${nRows}×${nCols} block: ${fmtCells(cells)} cells ` +
        `is ${fmtBytes(cells * 4)} in one array, and the request was refused. ${hint}`,
      { nRows, nCols, cells, bytes: cells * 4, where: 'allocation', cause: String(cause) },
    )
  }
}

/**
 * Multiply a block by its bin weights, which is what "balanced" means.
 *
 * `balanced[i][j] = raw[i][j] * w[i] * w[j]` — cooler's own definition, and the
 * only normalisation a cooler ships. A `NaN` weight marks a bin the balancer
 * threw out (low coverage, repeat-dense); the product is then `NaN`, which the
 * renderer draws as transparent, so a filtered row reads as absent rather than
 * as empty. That is matplotlib's "bad" colour and it is the diagnostically
 * correct answer.
 *
 * **This is the one read of `/bins` in the reader**, and it is bounded: two
 * slices of the weight column, one per axis, for the bins actually on screen —
 * never the whole column, never `/bins/chrom`, and never at all unless the user
 * asked for balanced counts. Spec §3.3's rule is that *coordinates* never come
 * from `/bins`; they still do not.
 */
function applyWeights(
  handle: Hdf5Handle,
  rows: Extent,
  cols: Extent,
  values: Float32Array,
): void {
  const column = DEFAULT_WEIGHT_COLUMN
  const path = `bins/${column}`
  if (!handle.has(path)) {
    throw new ViewerError(
      'unsupported',
      `This file has no /bins/${column} column, so there are no weights to balance with. ` +
        'Run `cooler balance` on it, or view the raw counts.',
      { column },
    )
  }
  const rowWeights = handle.readNumeric(path, rows[0], rows[1])
  const colWeights =
    cols[0] === rows[0] && cols[1] === rows[1]
      ? rowWeights
      : handle.readNumeric(path, cols[0], cols[1])

  const nCols = cols[1] - cols[0]
  for (let r = 0; r < rows[1] - rows[0]; r++) {
    const wr = rowWeights[r]
    const base = r * nCols
    for (let c = 0; c < nCols; c++) {
      values[base + c] = values[base + c] * wr * colWeights[c]
    }
  }
}

/** Bin ranges, validated against the file's bin count. */
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

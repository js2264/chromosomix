/**
 * The stage's whole-genome picture (SPECS §27.9): every contact of a map, at
 * up to 16,384 cells a side, one byte a cell.
 *
 * It exists for one reason: a reader cannot curate a genome they cannot see,
 * and the 4,096-cell ceiling every other map keeps (`RASTER_MAX_DIM`) is a
 * cell of 760 kb on a human genome — larger than most of the contigs a curator
 * has come to move. So the stage keeps a picture of its own, four times finer,
 * and keeps it **in the file's order**: an edit is then a new mapping from the
 * cells on screen to the cells of the picture, never a new picture, which is
 * what makes one instant at this scale (`edit/grid.ts` builds the mapping,
 * `edit/paint.ts` draws through it).
 *
 * **One byte a cell, the upper triangle.** 16,384² cells as 32-bit floats are a
 * gigabyte; as bytes, and half of them, 134 MB. A byte is the base-10 log of the
 * value over a range fixed from the first band read, 254 steps of it, with `0`
 * for a cell that holds nothing. It is a picture and nothing else: every number
 * a reader is shown is read from the file, never from a byte of this.
 *
 * **One pass, in bands.** The rows are read a band at a time — the pixels whose
 * first bin falls in the band, which is one ranged read of a cooler's pixel
 * table — summed into a band of floats, and quantized before the next band is
 * read, so the floats never outnumber one band. The range is set from the first
 * band, with a decade of room below it and half of one above: every band
 * carries the far contacts of its rows as well as their diagonal, so the first
 * is a fair sample of the rest, and a value past either end is drawn at that end
 * rather than lost.
 *
 * **A pyramid over it**, each level the mean of four cells of the one below,
 * because a whole yeast genome on a screen is twelve cells to a pixel, and a
 * pixel that shows one of the 144 cells under it sparkles where the map is
 * sparse. The stage samples the level whose cell is about a pixel.
 */

import { yieldToEventLoop } from '../async'
import type { Extent } from '../types'
import type { Coords } from './coords'
import type { PixelStore } from './store'

/** Cells a side, at most: the stage's picture and nothing else (§27.9). */
export const PICTURE_CELLS = 16_384

/** How many floats a band may hold while it is being summed — 64 MB of them. */
const BAND_BYTES = 64 * 1024 * 1024

/** The smallest level the pyramid stops at, in cells a side. */
const PYRAMID_FLOOR = 256

/** Where the picture's cells fall on the map's bins. */
export interface PictureLayout {
  /** Bins of the map summed into one cell a side; `1` is the map's own bins. */
  stride: number
  /** Cells a side. */
  n: number
  /** The cell each bin of the map falls in; `-1` for a bin of a sequence the picture leaves out. */
  slot: Int32Array
  /**
   * The first cell of each sequence, and one past the last: one more than
   * the sequences drawn. A cell never holds two sequences — the grid starts
   * afresh at each — so a piece of one can be moved without carrying the end
   * of another.
   */
  offsets: Int32Array
  /**
   * The map's sequences drawn, in its order, where they are not all of them:
   * one genome of a metagenome and the contigs brought into it (§27.10).
   */
  contigs?: Int32Array
}

/**
 * The grid `stride` bins a cell makes of a map, anchored to every sequence —
 * or to those of `contigs`, the map's own indices in its order, the rest left
 * out: a picture of one genome of a metagenome is a picture of its sequences
 * alone.
 */
export function pictureLayout(coords: Coords, stride: number, contigs?: ArrayLike<number>): PictureLayout {
  const k = Math.max(1, Math.trunc(stride))
  const drawn = contigs ?? null
  const count = drawn === null ? coords.nContigs : drawn.length
  const offsets = new Int32Array(count + 1)
  const slot = new Int32Array(coords.nBins)
  if (drawn !== null) slot.fill(-1)
  let cell = 0
  for (let i = 0; i < count; i++) {
    const c = drawn === null ? i : drawn[i]
    offsets[i] = cell
    const [lo, hi] = coords.contigBinExtent(c)
    for (let bin = lo; bin < hi; bin++) slot[bin] = cell + Math.floor((bin - lo) / k)
    cell += Math.ceil((hi - lo) / k)
  }
  offsets[count] = cell
  return { stride: k, n: cell, slot, offsets, ...(drawn === null ? {} : { contigs: Int32Array.from(drawn) }) }
}

/** Cells a side at `stride`, from the sequences' bin counts alone. */
function cellsAt(coords: Coords, stride: number, contigs?: ArrayLike<number>): number {
  let total = 0
  const count = contigs === undefined ? coords.nContigs : contigs.length
  for (let i = 0; i < count; i++) {
    const [lo, hi] = coords.contigBinExtent(contigs === undefined ? i : contigs[i])
    total += Math.ceil((hi - lo) / stride)
  }
  return total
}

/**
 * The fewest bins a cell that brings the picture within `cap` cells a side, or
 * `null` where no number does: a cell never holds two sequences, so an assembly
 * of more sequences than that has no picture of this kind (§27.13). Of the
 * sequences of `contigs` alone, where it is given.
 */
export function pictureStride(coords: Coords, cap = PICTURE_CELLS, contigs?: ArrayLike<number>): number | null {
  if ((contigs === undefined ? coords.nContigs : contigs.length) > cap) return null
  const cells = (stride: number): number => cellsAt(coords, stride, contigs)
  if (cells(1) <= cap) return 1
  let high = 2
  while (cells(high) > cap) high *= 2
  let low = high >> 1
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (cells(mid) <= cap) high = mid
    else low = mid
  }
  return high
}

/** Stored pixels a row of the picture's cells should hold, on the mean: below it, a map is too shallow at its bins to see or weigh. */
export const PICTURE_DEPTH = 64

/**
 * The fewest bins a cell of a map as shallow as this one takes for its rows to
 * hold {@link PICTURE_DEPTH} stored pixels each, on the mean — from the store's
 * row index alone, so nothing is read to know it. A metagenome's genome at a
 * kilobase holds a few contacts a row, and a picture of it at its own bins is
 * white, and every window of it a guess; `1` for any map deeper than that.
 *
 * @param offsets The store's `bin1_offset`: the stored pixels before each row.
 */
export function depthStride(coords: Coords, offsets: ArrayLike<number> | null, contigs?: ArrayLike<number>, least = PICTURE_DEPTH): number {
  if (offsets === null) return 1
  let pixels = 0
  let bins = 0
  const count = contigs === undefined ? coords.nContigs : contigs.length
  for (let i = 0; i < count; i++) {
    const [lo, hi] = coords.contigBinExtent(contigs === undefined ? i : contigs[i])
    pixels += offsets[hi] - offsets[lo]
    bins += hi - lo
  }
  if (!(bins > 0) || !(pixels > 0)) return 1
  return Math.max(1, Math.ceil(least / (pixels / bins)))
}

/**
 * The finest bins, in base pairs, a map as deep as this one shows — rows of
 * {@link PICTURE_DEPTH} stored pixels on the mean — from one rung's row index:
 * its {@link depthStride} of its bins where it is shallow at them, and finer
 * than them where it is deep, on the reckoning that a finer rung spreads the
 * same stored pixels over proportionally more rows. A finer rung holds more
 * pixels than that, never fewer, so the answer errs coarse. What a window of
 * the stage is never read finer than (§27.9).
 */
export function depthFloor(coords: Coords, offsets: ArrayLike<number> | null, binsize: number, contigs?: ArrayLike<number>, least = PICTURE_DEPTH): number {
  if (offsets === null) return binsize
  let pixels = 0
  let bins = 0
  const count = contigs === undefined ? coords.nContigs : contigs.length
  for (let i = 0; i < count; i++) {
    const [lo, hi] = coords.contigBinExtent(contigs === undefined ? i : contigs[i])
    pixels += offsets[hi] - offsets[lo]
    bins += hi - lo
  }
  if (!(bins > 0) || !(pixels > 0)) return binsize
  const perRow = pixels / bins
  return perRow < least ? binsize * Math.ceil(least / perRow) : binsize / Math.floor(perRow / least)
}

/** Where cell `(a, b)`, `a ≤ b`, lives in an upper triangle `n` a side. */
export function triangleIndex(a: number, b: number, n: number): number {
  return a * n - (a * (a - 1)) / 2 + (b - a)
}

/** Cells in an upper triangle `n` a side, the diagonal included. */
export function triangleSize(n: number): number {
  return (n * (n + 1)) / 2
}

/**
 * What a byte stands for: the base-10 logs byte `1` and byte `255` are.
 * Byte `0` is a cell that holds nothing.
 */
export interface Quantizer {
  low: number
  high: number
}

/** A value as a byte. Anything above nothing is at least `1`, so faint is never empty. */
export function encode(value: number, q: Quantizer): number {
  if (!(value > 0)) return 0
  const step = (Math.log10(value) - q.low) * (254 / (q.high - q.low))
  const byte = 1 + Math.round(step)
  return byte < 1 ? 1 : byte > 255 ? 255 : byte
}

/** The base-10 log a byte stands for; `-Infinity` for `0`. */
export function logOf(byte: number, q: Quantizer): number {
  return byte === 0 ? Number.NEGATIVE_INFINITY : q.low + ((byte - 1) * (q.high - q.low)) / 254
}

/** Every byte's value, as a table: `0` for byte `0`. */
export function decodeTable(q: Quantizer): Float64Array {
  const table = new Float64Array(256)
  for (let b = 1; b < 256; b++) table[b] = 10 ** logOf(b, q)
  return table
}

/**
 * The range a band's values set: from a decade under their thousandth-lowest
 * part to half a decade over their highest. `null` where the band holds too
 * few contacts to say, and the caller falls back to a range wide enough for
 * any map (`FALLBACK`).
 */
function rangeOf(values: Float32Array): Quantizer | null {
  // A histogram of the logs, a hundredth of a decade a bin — a percentile
  // without sorting sixteen million floats.
  const LOW = -20
  const BINS = 4000
  const counts = new Uint32Array(BINS)
  let seen = 0
  let top = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!(v > 0)) continue
    const x = Math.log10(v)
    if (x > top) top = x
    const bin = Math.floor((x - LOW) * 100)
    counts[bin < 0 ? 0 : bin >= BINS ? BINS - 1 : bin]++
    seen++
  }
  if (seen < 1000) return null
  const floorAt = seen * 0.001
  let running = 0
  let floor = LOW
  for (let bin = 0; bin < BINS; bin++) {
    running += counts[bin]
    if (running >= floorAt) {
      floor = LOW + bin / 100
      break
    }
  }
  const low = floor - 1
  const high = Math.max(top + 0.5, low + 1)
  return { low, high }
}

/** Twenty decades: balanced values and raw counts alike, drawn coarsely. */
const FALLBACK: Quantizer = { low: -12, high: 8 }

/**
 * The contacts the same pass keeps as numbers, for the method that proposes
 * edits (§27.5): the picture is bytes and nothing else, so what the method
 * weighs is gathered beside it, from the same floats, before they are
 * quantized.
 *
 * Every value is the **mean over a cell's bin pairs** — the balanced value, or
 * the raw count, of one pair of bins — so a pooled cell and a single bin speak
 * one unit, and a cell part of whose bins the balancer dropped is the mean of
 * the ones it kept.
 */
export interface PictureContacts {
  /** Cells a side, as the picture has them. */
  n: number
  /** The original sequence each cell is in, as the file orders them. */
  sequenceOf: Int32Array
  /** Cells past the diagonal the band keeps, the diagonal included. */
  width: number
  /**
   * The cells nearest the diagonal, as they are: `band[a * width + k]` is cell
   * `(a, a + k)`, inside one sequence; `NaN` past its end, and where the
   * balancer dropped every bin of either cell.
   */
  band: Float32Array
  /**
   * The whole map on a coarser grid, `factor` cells a coarse cell, anchored to
   * every sequence as the picture's grid is: each coarse cell the mean of the
   * cells in it that hold anything the balancer kept, `NaN` where none does.
   * An upper triangle, {@link triangleIndex} over `n`.
   */
  coarse: { n: number; factor: number; of: Int32Array; values: Float32Array }
  /** Each cell's row sum of those means over the whole map — its coverage. */
  marginal: Float64Array
  /** Bins of each cell the balancer kept: every one of them, unbalanced. */
  kept: Uint16Array
  /**
   * The cells as they are between the **ends** of sequences (§27.5): every
   * cell within `depth` of either end of a sequence is in its end's zone, and
   * every pair of zone cells the band does not already hold — two sequences'
   * ends, or a sequence's two ends — is kept here, where it holds anything, so
   * that whether two ends meet is weighed at the picture's own resolution
   * rather than on the coarse grid. A pair of kept cells that is not listed
   * held nothing. `complete` is `false` where the budget ran out first, and the
   * pairs past it are read from the coarse grid.
   */
  ends?: PictureEnds
}

/** The cells between sequence ends, sparse: see {@link PictureContacts.ends}. */
export interface PictureEnds {
  depth: number
  /** Each cell's zone — `2s` the start of sequence `s`, `2s + 1` its end — or `-1`. */
  zone: Int32Array
  /**
   * The pairs that held anything, by row as a compressed sparse matrix: the
   * pairs of row `a` are `rowStart[a]` to `rowStart[a + 1]`, each a column above
   * `a` in `cols`, ascending, and its value in `values` — so a pair is found by
   * a binary search of its row, and nothing is built to find it.
   */
  rowStart: Int32Array
  cols: Int32Array
  values: Float32Array
  complete: boolean
}

/** The value a {@link PictureEnds} holds for cells `lo ≤ hi`, or `undefined` where it lists none. */
export function endValue(ends: PictureEnds, lo: number, hi: number): number | undefined {
  let low = ends.rowStart[lo]
  let high = ends.rowStart[lo + 1] - 1
  const cols = ends.cols
  while (low <= high) {
    const mid = (low + high) >> 1
    const c = cols[mid]
    if (c < hi) low = mid + 1
    else if (c > hi) high = mid - 1
    else return ends.values[mid]
  }
  return undefined
}

/** What the gathering keeps: how wide a band, and how coarse a whole. */
export interface GatherOptions {
  /** Cells past the diagonal the band keeps. */
  width: number
  /** The most coarse cells a side. */
  coarseCells: number
  /** Cells from each end of a sequence whose pairs with other ends are kept as they are; none where absent. */
  endDepth?: number
  /** The most end pairs kept. */
  endBudget?: number
}

/** The most pairs of end cells a pass keeps: 48 MB of them. */
export const END_BUDGET = 4_000_000

/**
 * The fewest cells a coarse cell for the coarse grid to fit `cap` a side,
 * anchored to every sequence — or, where there are more sequences than `cap`,
 * the fewest that make each one coarse cell: no factor does better, and a
 * search past it would go on for ever.
 */
export function coarseFactor(offsets: Int32Array, cap: number): number {
  const at = (factor: number): number => {
    let total = 0
    for (let c = 0; c + 1 < offsets.length; c++) total += Math.ceil((offsets[c + 1] - offsets[c]) / factor)
    return total
  }
  let longest = 1
  for (let c = 0; c + 1 < offsets.length; c++) longest = Math.max(longest, offsets[c + 1] - offsets[c])
  if (at(1) <= cap) return 1
  if (at(longest) > cap) return longest
  // The count falls as the factor grows: the least factor that fits, by halving.
  let low = 1
  let high = longest
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (at(mid) <= cap) high = mid
    else low = mid
  }
  return high
}

/** What a read of the picture hands back, before the pyramid is built on it. */
export interface PictureRead {
  /** The upper triangle, `n` a side: {@link triangleIndex} addresses it. */
  cells: Uint8Array
  quantizer: Quantizer
  /** Cells at each byte, `0` included — what the display range is taken from. */
  histogram: Float64Array
  /** Stored pixels walked. */
  pixels: number
  /** What the method weighs, where it was asked for. */
  contacts?: PictureContacts
}

/**
 * Read a map into its picture.
 *
 * @param weights One per bin of the map, for balanced values; `null` for the
 *   raw column. A `NaN` weight is a bin the balancer dropped, and its cells stay
 *   empty — "a blank row is an unbalanced row" (§6.4).
 * @param upperTriangular Whether the store holds each pair once. A `square`
 *   store holds both, and only the upper half of each band is taken.
 * @returns `null` where the caller cancelled.
 */
export async function readPicture(options: {
  store: PixelStore
  coords: Coords
  layout: PictureLayout
  weights: Float64Array | null
  value?: string
  bandBytes?: number
  /** Keep the contacts the method weighs as well (§27.5), and how. */
  gather?: GatherOptions
  cancelled?: () => boolean
  onProgress?: (done: number, total: number) => void
}): Promise<PictureRead | null> {
  const { store, layout, weights } = options
  const n = layout.n
  const slot = layout.slot
  const nBins = slot.length
  const cells = new Uint8Array(triangleSize(n))
  const histogram = new Float64Array(256)
  const gather = options.gather === undefined ? null : gathering(layout, weights, options.gather)

  // The bins of each cell, so a band of cell rows is the runs of bins its
  // sequences hold — one run where every sequence is drawn, and never the rows
  // of a sequence left out between two drawn.
  const firstBin = new Int32Array(n).fill(-1)
  const endBin = new Int32Array(n)
  for (let bin = 0; bin < nBins; bin++) {
    const cell = slot[bin]
    if (cell < 0) continue
    if (firstBin[cell] < 0) firstBin[cell] = bin
    endBin[cell] = bin + 1
  }
  const runsOf = (r0: number, r1: number): Extent[] => {
    const runs: Extent[] = []
    for (let cell = r0; cell < r1; cell++) {
      if (firstBin[cell] < 0) continue
      const last = runs[runs.length - 1]
      if (last !== undefined && last[1] === firstBin[cell]) last[1] = endBin[cell]
      else runs.push([firstBin[cell], endBin[cell]])
    }
    return runs
  }

  const rowsPerBand = Math.max(1, Math.floor((options.bandBytes ?? BAND_BYTES) / (4 * Math.max(1, n))))
  const band = new Float32Array(Math.min(n, rowsPerBand) * n)

  // Pixels per band where the store can say, for a bar that moves with the
  // bytes rather than with the rows; the rows otherwise.
  let offsets: Float64Array | null = null
  try {
    offsets = store.binOffsets()
  } catch {
    offsets = null
  }
  const pixelsIn = (runs: readonly Extent[]): number =>
    offsets === null ? 0 : runs.reduce((sum, [lo, hi]) => sum + (offsets[hi] - offsets[lo]), 0)
  const total = offsets !== null ? pixelsIn(runsOf(0, n)) : n
  let done = 0
  let quantizer: Quantizer | null = null
  let pixels = 0

  for (let r0 = 0; r0 < n; r0 += rowsPerBand) {
    if (options.cancelled?.() === true) return null
    const r1 = Math.min(n, r0 + rowsPerBand)
    const runs = runsOf(r0, r1)
    const width = (r1 - r0) * n
    band.fill(0, 0, width)
    const before = done
    const stopped = !(await store.forEachBands(
      runs,
      (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const b1 = chunk.bin1[i]
          const b2 = chunk.bin2[i]
          // The upper half only: a square store holds the lower one as well.
          if (b2 < b1) continue
          const r = slot[b1]
          const c = slot[b2]
          // A contact with a sequence the picture leaves out.
          if (r < 0 || c < 0) continue
          let v = chunk.count[i]
          if (weights !== null) v *= weights[b1] * weights[b2]
          if (!(v > 0)) continue
          // A pooled cell on the diagonal is a square of bin pairs of which the
          // store holds one half: counted twice off its own diagonal, it is the
          // sum the square holds.
          band[(r - r0) * n + c] += r === c && b1 !== b2 ? 2 * v : v
        }
        pixels += chunk.length
      },
      {
        ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled }),
        ...(options.value === undefined ? {} : { value: options.value }),
        onProgress: (bandDone) => {
          if (offsets === null) return
          options.onProgress?.(before + bandDone, total)
        },
      },
    ))
    if (stopped) return null

    quantizer ??= rangeOf(band.subarray(0, width)) ?? FALLBACK
    for (let r = r0; r < r1; r++) {
      const row = (r - r0) * n
      let at = triangleIndex(r, r, n)
      for (let c = r; c < n; c++, at++) {
        const byte = encode(band[row + c], quantizer)
        cells[at] = byte
        histogram[byte]++
      }
      gather?.row(r, band, row)
    }
    done = offsets !== null ? before + pixelsIn(runs) : r1
    options.onProgress?.(done, total)
    await yieldToEventLoop()
  }

  return {
    cells,
    quantizer: quantizer ?? FALLBACK,
    histogram,
    pixels,
    ...(gather === null ? {} : { contacts: gather.finish() }),
  }
}

/**
 * The method's share of the pass (§27.5): a row of the picture's floats at a
 * time, as each band is quantized, into the band along the diagonal, the coarse
 * whole and the coverage. The floats are sums over a cell's bin pairs; each is
 * divided by how many pairs the balancer kept, so every value is one pair's.
 */
function gathering(
  layout: PictureLayout,
  weights: Float64Array | null,
  options: GatherOptions,
): { row(r: number, band: Float32Array, at: number): void; finish(): PictureContacts } {
  const n = layout.n
  const width = Math.max(1, Math.trunc(options.width))
  const kept = new Uint16Array(n)
  for (let bin = 0; bin < layout.slot.length; bin++) {
    if (layout.slot[bin] >= 0 && (weights === null || weights[bin] > 0)) kept[layout.slot[bin]]++
  }
  const sequenceOf = new Int32Array(n)
  for (let c = 0; c + 1 < layout.offsets.length; c++) sequenceOf.fill(c, layout.offsets[c], layout.offsets[c + 1])

  const factor = coarseFactor(layout.offsets, Math.max(1, options.coarseCells))
  const of = new Int32Array(n)
  let coarseN = 0
  for (let c = 0; c + 1 < layout.offsets.length; c++) {
    const first = layout.offsets[c]
    for (let cell = first; cell < layout.offsets[c + 1]; cell++) of[cell] = coarseN + Math.floor((cell - first) / factor)
    coarseN += Math.ceil((layout.offsets[c + 1] - first) / factor)
  }

  const bandOut = new Float32Array(n * width).fill(Number.NaN)
  const sums = new Float64Array(triangleSize(coarseN))
  const counts = new Uint32Array(triangleSize(coarseN))
  const marginal = new Float64Array(n)

  // The end zones: each sequence's first and last `depth` cells — a short
  // one's nearer half to each end.
  const depth = Math.max(0, Math.trunc(options.endDepth ?? 0))
  const zone = new Int32Array(n).fill(-1)
  if (depth > 0) {
    for (let s = 0; s + 1 < layout.offsets.length; s++) {
      const first = layout.offsets[s]
      const last = layout.offsets[s + 1]
      const length = last - first
      zone.fill(2 * s, first, first + Math.min(depth, Math.ceil(length / 2)))
      zone.fill(2 * s + 1, last - Math.min(depth, Math.floor(length / 2)), last)
    }
  }
  const budget = Math.max(0, Math.trunc(options.endBudget ?? END_BUDGET))
  // Rows arrive in order and each row's columns ascending, so the pairs are
  // kept already sorted, and each row's first pair is where it starts.
  const rowStart = new Int32Array(depth > 0 ? n + 1 : 0)
  let endCols = new Int32Array(depth > 0 ? 1024 : 0)
  let endValues = new Float32Array(endCols.length)
  let ends = 0
  let complete = true
  const keep = (c: number, v: number): void => {
    if (ends >= budget) {
      complete = false
      return
    }
    if (ends === endCols.length) {
      const size = Math.min(budget, endCols.length * 2)
      const cols = new Int32Array(size)
      const values = new Float32Array(size)
      cols.set(endCols)
      values.set(endValues)
      endCols = cols
      endValues = values
    }
    endCols[ends] = c
    endValues[ends] = v
    ends++
  }

  return {
    row(r, band, at) {
      if (depth > 0) rowStart[r] = ends
      const kr = kept[r]
      if (kr === 0) return
      const sequence = sequenceOf[r]
      const coarseRow = of[r]
      const coarseAt = triangleIndex(coarseRow, coarseRow, coarseN) - coarseRow
      const inZone = zone[r] >= 0
      for (let c = r; c < n; c++) {
        const kc = kept[c]
        if (kc === 0) continue
        const v = band[at + c] / (kr * kc)
        const inBand = c - r < width && sequenceOf[c] === sequence
        if (inBand) bandOut[r * width + (c - r)] = v
        else if (inZone && v > 0 && zone[c] >= 0) keep(c, v)
        const index = coarseAt + of[c]
        sums[index] += v
        counts[index]++
        marginal[r] += v
        if (c !== r) marginal[c] += v
      }
    },
    finish() {
      const values = new Float32Array(sums.length)
      for (let i = 0; i < sums.length; i++) values[i] = counts[i] === 0 ? Number.NaN : sums[i] / counts[i]
      return {
        n,
        sequenceOf,
        width,
        band: bandOut,
        coarse: { n: coarseN, factor, of, values },
        marginal,
        kept,
        ...(depth > 0
          ? {
              ends: {
                depth,
                zone,
                rowStart: finishRows(rowStart, ends),
                cols: endCols.slice(0, ends),
                values: endValues.slice(0, ends),
                complete,
              },
            }
          : {}),
      }
    },
  }
}

/** Close a row index: every row set its own start as the pass reached it, in order; the last row ends where the pairs do. */
function finishRows(rowStart: Int32Array, total: number): Int32Array {
  rowStart[rowStart.length - 1] = total
  return rowStart
}

/** One level of the pyramid: an upper triangle `n` a side. */
export interface PictureLevel {
  n: number
  cells: Uint8Array
}

/**
 * The levels over a picture, each the mean of the four cells under it, down to
 * {@link PYRAMID_FLOOR} cells a side. The first is the picture itself.
 *
 * A mean, not a sum, so one colour scale serves every level: a cell of a
 * coarser level says how dense the stretch is, as a cell of the finest does.
 */
export function pyramid(level0: PictureLevel, q: Quantizer, floor = PYRAMID_FLOOR): PictureLevel[] {
  const table = decodeTable(q)
  const levels: PictureLevel[] = [level0]
  let below = level0
  while (below.n > floor) {
    const pn = below.n
    const prev = below.cells
    const m = Math.ceil(pn / 2)
    const cells = new Uint8Array(triangleSize(m))
    let at = 0
    for (let a = 0; a < m; a++) {
      const i0 = 2 * a
      const i1 = i0 + 1
      for (let b = a; b < m; b++, at++) {
        const j0 = 2 * b
        const j1 = j0 + 1
        // The four children, each read from the upper half: on the diagonal
        // `(i1, j0)` is below it, and is `(j0, i1)`.
        let sum = table[prev[triangleIndex(i0, j0, pn)]]
        let count = 1
        if (j1 < pn) {
          sum += table[prev[triangleIndex(i0, j1, pn)]]
          count++
        }
        if (i1 < pn) {
          sum += table[prev[i1 <= j0 ? triangleIndex(i1, j0, pn) : triangleIndex(j0, i1, pn)]]
          count++
          if (j1 < pn) {
            sum += table[prev[triangleIndex(i1, j1, pn)]]
            count++
          }
        }
        cells[at] = encode(sum / count, q)
      }
    }
    below = { n: m, cells }
    levels.push(below)
  }
  return levels
}

/**
 * The display range a picture opens at, in base-10 logs: its cells' first and
 * ninety-ninth percentiles, the rule every map's automatic range follows
 * (`render/scale.ts`, `AUTO_VMIN_PERCENTILE`, `AUTO_VMAX_PERCENTILE`).
 */
export function displayRange(histogram: Float64Array, q: Quantizer): { vmin: number; vmax: number } {
  let filled = 0
  for (let b = 1; b < 256; b++) filled += histogram[b]
  if (filled === 0) return { vmin: q.low, vmax: q.high }
  const at = (fraction: number): number => {
    const target = filled * fraction
    let running = 0
    for (let b = 1; b < 256; b++) {
      running += histogram[b]
      if (running >= target) return logOf(b, q)
    }
    return q.high
  }
  const vmin = at(0.01)
  const vmax = at(0.99)
  return vmax > vmin ? { vmin, vmax } : { vmin, vmax: vmin + 1 }
}

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
  /** The cell each bin of the map falls in. */
  slot: Int32Array
  /**
   * The first cell of each sequence, and one past the last: `nContigs + 1`
   * long. A cell never holds two sequences — the grid starts afresh at each —
   * so a piece of one can be moved without carrying the end of another.
   */
  offsets: Int32Array
}

/** The grid `stride` bins a cell makes of a map, anchored to every sequence. */
export function pictureLayout(coords: Coords, stride: number): PictureLayout {
  const k = Math.max(1, Math.trunc(stride))
  const nContigs = coords.nContigs
  const offsets = new Int32Array(nContigs + 1)
  const slot = new Int32Array(coords.nBins)
  let cell = 0
  for (let c = 0; c < nContigs; c++) {
    offsets[c] = cell
    const [lo, hi] = coords.contigBinExtent(c)
    for (let bin = lo; bin < hi; bin++) slot[bin] = cell + Math.floor((bin - lo) / k)
    cell += Math.ceil((hi - lo) / k)
  }
  offsets[nContigs] = cell
  return { stride: k, n: cell, slot, offsets }
}

/** Cells a side at `stride`, from the sequences' bin counts alone. */
function cellsAt(coords: Coords, stride: number): number {
  let total = 0
  for (let c = 0; c < coords.nContigs; c++) {
    const [lo, hi] = coords.contigBinExtent(c)
    total += Math.ceil((hi - lo) / stride)
  }
  return total
}

/**
 * The fewest bins a cell that brings the picture within `cap` cells a side, or
 * `null` where no number does: a cell never holds two sequences, so an assembly
 * of more sequences than that has no picture of this kind (§27.13).
 */
export function pictureStride(coords: Coords, cap = PICTURE_CELLS): number | null {
  if (coords.nContigs > cap) return null
  if (cellsAt(coords, 1) <= cap) return 1
  let high = 2
  while (cellsAt(coords, high) > cap) high *= 2
  let low = high >> 1
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (cellsAt(coords, mid) <= cap) high = mid
    else low = mid
  }
  return high
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
}

/** What the gathering keeps: how wide a band, and how coarse a whole. */
export interface GatherOptions {
  /** Cells past the diagonal the band keeps. */
  width: number
  /** The most coarse cells a side. */
  coarseCells: number
}

/** The fewest cells a coarse cell for the coarse grid to fit `cap` a side, anchored to every sequence. */
export function coarseFactor(offsets: Int32Array, cap: number): number {
  const at = (factor: number): number => {
    let total = 0
    for (let c = 0; c + 1 < offsets.length; c++) total += Math.ceil((offsets[c + 1] - offsets[c]) / factor)
    return total
  }
  let factor = 1
  while (at(factor) > cap && factor < 1 << 20) factor++
  return factor
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

  // The first bin of each cell, so a band of cell rows is a band of bins.
  const firstBin = new Int32Array(n + 1)
  firstBin.fill(nBins)
  for (let bin = nBins - 1; bin >= 0; bin--) firstBin[slot[bin]] = bin
  firstBin[n] = nBins

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
  const total = offsets !== null ? offsets[nBins] - offsets[0] : n
  let done = 0
  let quantizer: Quantizer | null = null
  let pixels = 0

  for (let r0 = 0; r0 < n; r0 += rowsPerBand) {
    if (options.cancelled?.() === true) return null
    const r1 = Math.min(n, r0 + rowsPerBand)
    const bins: Extent = [firstBin[r0], firstBin[r1]]
    const width = (r1 - r0) * n
    band.fill(0, 0, width)
    const before = done
    const stopped = !(await store.forEachBands(
      [bins],
      (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const b1 = chunk.bin1[i]
          const b2 = chunk.bin2[i]
          // The upper half only: a square store holds the lower one as well.
          if (b2 < b1) continue
          let v = chunk.count[i]
          if (weights !== null) v *= weights[b1] * weights[b2]
          if (!(v > 0)) continue
          const r = slot[b1]
          const c = slot[b2]
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
    done = offsets !== null ? offsets[firstBin[r1]] - offsets[0] : r1
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
    if (weights === null || weights[bin] > 0) kept[layout.slot[bin]]++
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

  return {
    row(r, band, at) {
      const kr = kept[r]
      if (kr === 0) return
      const sequence = sequenceOf[r]
      const coarseRow = of[r]
      const coarseAt = triangleIndex(coarseRow, coarseRow, coarseN) - coarseRow
      for (let c = r; c < n; c++) {
        const kc = kept[c]
        if (kc === 0) continue
        const v = band[at + c] / (kr * kc)
        if (c - r < width && sequenceOf[c] === sequence) bandOut[r * width + (c - r)] = v
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
      return { n, sequenceOf, width, band: bandOut, coarse: { n: coarseN, factor, of, values }, marginal, kept }
    },
  }
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

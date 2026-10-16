/**
 * A map read at a resolution the reader added (§3.4): every `factor` of its bins
 * along each sequence summed into one, behind the same two seams an ordinary
 * map is read through — its pixels and its handle — so that everything above
 * sees an ordinary map one bin size up.
 *
 * The map *draws* a derived rung by summing as it reads (`pooling.ts`); what is
 * here is for everything that reads a map rather than drawing it — the analysis
 * worker's tasks and the command line's — which ask for windows, bands, whole
 * passes, weights and bin columns in bins of the map they were handed, and
 * should be handed the map the reader is looking at rather than the file's own
 * rung (§18.4).
 *
 * ## Pixels
 *
 * A coarse pixel is the sum of the fine pixels in its block, which is exactly
 * what `cooler coarsen` writes: a contact is in one fine bin and so in one
 * coarse one, and the sum of counts *is* the count. A fine pixel of an
 * upper-triangular store lands on or above the coarse diagonal, so the coarse
 * map is upper-triangular too, and the block on the diagonal holds each stored
 * pixel once — the cell `pooling.ts` draws there.
 *
 * Summed a coarse row at a time ({@link CoarseRows}): every store this wraps
 * hands its pixels over a row at a time — a cooler's index is by row, and a read
 * of rows is a walk down them — so the cells of one coarse row are all in before
 * the next row begins, and a row is handed on, summed, the moment the walk
 * leaves it. A store that does not keep to that order — the edited map of
 * `lens.ts`, whose inverted segments run backwards, a `.hic` read a block at a
 * time — loses nothing by it: a row it comes back to is summed again and handed
 * on again, and every reader of pixels adds them up (`scatterDense`, the
 * accumulators of `aggregate.ts`, each task's own loop), so a coarse pixel
 * handed over in two parts is the same number.
 *
 * ## Weights
 *
 * Balanced values do not sum the way counts do, and no single weight per coarse
 * bin reproduces the sum of the fine balanced values the map draws. What is
 * here is the weight a coarse bin has under the model balancing itself assumes
 * — a count is a bias per bin, times a bias per bin, times the signal, and a
 * weight is one over the bias — where the coarse bin's bias is the sum of its
 * fine bins' and the coarse bin is `n` fine ones: the **harmonic mean** of the
 * fine weights, `n / Σ 1/wᵢ`, over the bins the balancer kept. Where the signal
 * is level across a block, the coarse count times two such weights *is* the sum
 * of the fine balanced values; where it is not, the two differ by how unevenly
 * signal and bias vary inside one coarse bin — and both differ from
 * `cooler zoomify --balance`, which fits new weights at the coarser rung, which
 * is the caveat §3.4 prints for the map. A coarse bin none of whose fine bins
 * the balancer kept is dropped, as a fine one is.
 *
 * Every other bin column is the coarse bin's: its sequence and start are its
 * first fine bin's, its end its last's, and any other number the mean of its
 * fine bins' — a column of per-bin values (a GC fraction, a mappability) is a
 * value per base pair of the bin, and its mean is that.
 */

import type { StorageMode } from '../constants'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import type { Extent, PixelChunk } from '../types'
import type { CoarseGrid } from './coarsen'
import { ChunkBuffer } from './lens'
import { planRead, type ReadPlan, type SpanScanOptions } from './matrix'
import type { PixelStore, ScanAllOptions } from './store'

/** The weight column, whose coarse value is a harmonic mean rather than a mean. */
const WEIGHT = 'weight'

/**
 * Coarse pixels handed on per this many: often enough that a scan's progress and
 * its way out stay as live as the fine one's, seldom enough to cost nothing.
 */
const EMIT_EVERY = 1 << 16

/**
 * The pixels of the coarse map: the fine map's, read over the fine bins a
 * question needs and summed into the coarse bins they land in.
 */
export class CoarseStore implements PixelStore {
  /** Every fine bin's coarse bin, built on the first read. */
  private index: Int32Array | null = null

  constructor(
    private readonly inner: PixelStore,
    private readonly grid: CoarseGrid,
    private readonly storageMode: StorageMode,
  ) {}

  /** Unknown until every block has been summed, which no read does: `null`, as the interface allows. */
  get nnz(): number | null {
    return null
  }

  get countKind(): 'i' | 'u' | 'f' {
    return this.inner.countKind
  }

  get rectangular(): boolean | undefined {
    return this.inner.rectangular
  }

  scoreColumns(): string[] {
    return this.inner.scoreColumns()
  }

  /**
   * Each coarse bin's stored pixels as its fine bins' — the number of fine
   * pixels a read of it walks, which is what a size guard is asking, and a
   * density for a sortable column as the fine one is.
   */
  binOffsets(): Float64Array {
    const inner = this.inner.binOffsets()
    const out = new Float64Array(this.grid.nBins + 1)
    for (let bin = 0; bin <= this.grid.nBins; bin++) out[bin] = inner[this.grid.fineBin(bin)] ?? 0
    return out
  }

  /**
   * A coarse window, from the fine window it sums. Only the fine pixels whose
   * coarse cell is in the window are summed — a read of a band hands over whole
   * rows, and summing a row's worth of cells outside the window would cost a
   * row's worth of slots for every window of a pileup.
   */
  async forEachWindow(
    rows: Extent,
    cols: Extent,
    _plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options?: SpanScanOptions,
  ): Promise<boolean> {
    const fineRows = this.grid.toFine(rows)
    const fineCols = this.grid.toFine(cols)
    const plan = planRead(fineRows, fineCols, this.storageMode)
    const sums = new CoarseRows(this.coarseIndex(), { rows, cols, mode: plan.mode }, onChunk)
    const going = await this.inner.forEachWindow(fineRows, fineCols, plan, (chunk) => sums.add(chunk), options)
    if (going) sums.finish()
    return going
  }

  forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options?: SpanScanOptions,
  ): Promise<boolean> {
    const fine = bands.map((band) => this.grid.toFine(band)).filter(([lo, hi]) => hi > lo)
    if (fine.length === 0) return Promise.resolve(true)
    const sums = new CoarseRows(this.coarseIndex(), this.grid.nBins, onChunk)
    return this.inner.forEachBands(fine, (chunk) => sums.add(chunk), options).then((going) => {
      if (going) sums.finish()
      return going
    })
  }

  async scanAll(options: ScanAllOptions): Promise<void> {
    let stopped = false
    const sums = new CoarseRows(this.coarseIndex(), this.grid.nBins, (chunk) => {
      if (stopped) return
      if (options.onChunk(chunk) === false) stopped = true
    })
    await this.inner.scanAll({
      ...options,
      onChunk: (chunk) => {
        sums.add(chunk)
        return !stopped
      },
    })
    if (!stopped) sums.finish()
  }

  private coarseIndex(): Int32Array {
    this.index ??= this.grid.coarseIndex()
    return this.index
  }
}

/** The coarse window a read is for, where it is one: only its cells are summed. */
interface CoarseWindow {
  rows: Extent
  cols: Extent
  mode: ReadPlan['mode']
}

/**
 * Fine pixels summed into coarse ones, a coarse row at a time, and handed on in
 * chunks with each row's cells in column order.
 *
 * One slot per coarse column the read can reach — the window's two extents, or
 * every coarse bin for a band or a whole pass — stamped with the row that last
 * wrote it, so starting a row clears nothing.
 */
class CoarseRows {
  private readonly sums: Float64Array
  private readonly stamp: Int32Array
  private touched = new Int32Array(256)
  private nTouched = 0
  private row = -1
  private generation = 0
  private readonly out = new ChunkBuffer()
  private held = 0
  /** Columns `[colLo, colHi)` are slots `0…`, then rows `[rowLo, rowHi)` after them. */
  private readonly colLo: number
  private readonly colSpan: number
  private readonly rowLo: number

  constructor(
    private readonly coarseOf: Int32Array,
    private readonly reach: CoarseWindow | number,
    private readonly emit: (chunk: PixelChunk) => void,
  ) {
    if (typeof reach === 'number') {
      this.colLo = 0
      this.colSpan = reach
      this.rowLo = 0
      this.sums = new Float64Array(reach)
    } else {
      this.colLo = reach.cols[0]
      this.colSpan = reach.cols[1] - reach.cols[0]
      this.rowLo = reach.rows[0]
      this.sums = new Float64Array(this.colSpan + (reach.rows[1] - reach.rows[0]))
    }
    this.stamp = new Int32Array(this.sums.length)
  }

  add(chunk: PixelChunk): void {
    const { bin1, bin2, count, length } = chunk
    const coarseOf = this.coarseOf
    const window = typeof this.reach === 'number' ? null : this.reach
    for (let i = 0; i < length; i++) {
      const a = coarseOf[bin1[i]]
      const b = coarseOf[bin2[i]]
      if (a === undefined || b === undefined) continue
      if (window !== null && !wanted(window, a, b)) continue
      if (a !== this.row) this.startRow(a)
      let slot = b - this.colLo
      if (slot < 0 || slot >= this.colSpan) slot = this.colSpan + (b - this.rowLo)
      if (slot < 0 || slot >= this.sums.length) continue
      if (this.stamp[slot] !== this.generation) {
        this.stamp[slot] = this.generation
        this.sums[slot] = count[i]
        if (this.nTouched === this.touched.length) {
          const grown = new Int32Array(this.touched.length * 2)
          grown.set(this.touched)
          this.touched = grown
        }
        this.touched[this.nTouched++] = b
      } else {
        this.sums[slot] += count[i]
      }
    }
    if (this.held > 0) this.handOn()
  }

  /** The row in hand, then whatever is held. */
  finish(): void {
    this.closeRow()
    this.row = -1
    if (this.held > 0) this.handOn()
  }

  private startRow(row: number): void {
    this.closeRow()
    this.row = row
    this.generation++
  }

  private closeRow(): void {
    if (this.nTouched === 0) return
    const columns = this.touched.subarray(0, this.nTouched).sort()
    for (const b of columns) {
      let slot = b - this.colLo
      if (slot < 0 || slot >= this.colSpan) slot = this.colSpan + (b - this.rowLo)
      this.out.push(this.row, b, this.sums[slot], false)
      this.held++
    }
    this.nTouched = 0
    if (this.held >= EMIT_EVERY) this.handOn()
  }

  private handOn(): void {
    this.emit(this.out.chunk())
    this.out.reset()
    this.held = 0
  }
}

/**
 * Whether a coarse cell is one the window's reader places, under its plan —
 * the test `scatterDense` makes, made before the sum rather than after it.
 */
function wanted(window: CoarseWindow, a: number, b: number): boolean {
  const { rows, cols, mode } = window
  if (mode !== 'transpose' && a >= rows[0] && a < rows[1] && b >= cols[0] && b < cols[1]) return true
  return mode !== 'direct' && b >= rows[0] && b < rows[1] && a >= cols[0] && a < cols[1]
}

/**
 * The fine map's handle, answering for the coarse one where a question is about
 * bins: the bin columns, each at the coarse bins as the module docstring says,
 * and the counts in the root's attributes. Every other path is the file's own —
 * the sequences are the same sequences, at the same lengths.
 */
export function coarsenedHandle(
  handle: Hdf5Handle,
  grid: CoarseGrid,
  attrs: Record<string, AttrValue>,
): Hdf5Handle {
  const numeric = new Map<string, Float64Array>()
  const text = new Map<string, string[]>()
  const isBins = (path: string): boolean => path.startsWith('bins/')
  const numbers = (path: string): Float64Array => {
    let column = numeric.get(path)
    if (column === undefined) {
      column = coarseColumn(path.slice('bins/'.length), handle.readNumeric(path), grid)
      numeric.set(path, column)
    }
    return column
  }
  const strings = (path: string): string[] => {
    let column = text.get(path)
    if (column === undefined) {
      const fine = handle.readStrings(path)
      column = []
      for (let bin = 0; bin < grid.nBins; bin++) column.push(fine[grid.fineBin(bin)] ?? '')
      text.set(path, column)
    }
    return column
  }
  return new Proxy(handle, {
    get(target, property) {
      switch (property) {
        case 'attrs':
          return (): Record<string, AttrValue> => attrs
        case 'datasetLength':
          return (path: string): number => (isBins(path) ? grid.nBins : target.datasetLength(path))
        case 'readNumeric':
          return (path: string, lo?: number, hi?: number): Float64Array =>
            isBins(path) ? numbers(path).slice(lo ?? 0, hi ?? grid.nBins) : target.readNumeric(path, lo, hi)
        case 'readStrings':
          return (path: string, lo?: number, hi?: number): string[] =>
            isBins(path) ? strings(path).slice(lo ?? 0, hi ?? grid.nBins) : target.readStrings(path, lo, hi)
        default: {
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        }
      }
    },
  })
}

/** One numeric bin column at the coarse bins: see the module docstring for which rule is whose. */
export function coarseColumn(name: string, fine: ArrayLike<number>, grid: CoarseGrid): Float64Array {
  const out = new Float64Array(grid.nBins)
  for (let bin = 0; bin < grid.nBins; bin++) {
    const lo = grid.fineBin(bin)
    const hi = grid.fineBin(bin + 1)
    if (name === 'chrom' || name === 'start') {
      out[bin] = fine[lo]
    } else if (name === 'end') {
      out[bin] = fine[hi - 1]
    } else if (name === WEIGHT) {
      // n / Σ 1/wᵢ over the bins the balancer kept; dropped where it kept none.
      let kept = 0
      let inverse = 0
      for (let at = lo; at < hi; at++) {
        const w = fine[at]
        if (Number.isFinite(w) && w > 0) {
          kept++
          inverse += 1 / w
        }
      }
      out[bin] = kept === 0 ? Number.NaN : kept / inverse
    } else {
      let kept = 0
      let sum = 0
      for (let at = lo; at < hi; at++) {
        const value = fine[at]
        if (Number.isFinite(value)) {
          kept++
          sum += value
        }
      }
      out[bin] = kept === 0 ? Number.NaN : sum / kept
    }
  }
  return out
}

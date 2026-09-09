/**
 * The imported pixel table, as the rest of the reader wants it.
 *
 * The third {@link PixelStore}, after `CoolerStore` over HDF5 and `HicStore`
 * over a `.hic` — and the easiest of the three, because the difficulty the
 * interface exists to absorb is *where the pixels are*, and here they are in
 * two `Int32Array`s that this object owns.
 *
 * ## Why this one answers questions the others refuse
 *
 * `HicStore.binOffsets()` throws by name: a `.hic` has no per-bin pixel index
 * and inventing one would mean reading the whole file to open it. That argument
 * does not apply here for the plainest of reasons — the whole file *was* read,
 * and the index is a by-product of having read it. `bin1` comes out of the
 * importer already ascending, so the CSR row pointer is one linear pass and is
 * exact.
 *
 * So a pairs-backed map is a *fuller* citizen than a `.hic`: `nnz` is a real
 * number rather than `null`, the stored-pixel density column works, and nothing
 * downstream has a branch for the case where it does not. That is worth stating
 * because it is the payoff of binning up front rather than on demand — the cost
 * was paid once, at open, and every question afterwards is answered from
 * memory.
 *
 * ## Semantics are the cooler path's, deliberately
 *
 * `forEachWindow` honours `plan.span` and ignores the column range, which is
 * exactly what `CoolerStore` does and exactly what `scatterDense` is written
 * against — the columns are discarded by the scatter. Narrowing by column here
 * would be free and is still not done: two stores that emit different pixel
 * sets for the same query are two stores that can disagree, and the whole point
 * of the interface is that nothing above it can tell which file it is looking
 * at.
 */

import { yieldToEventLoop } from '../async'
import type { Extent, PixelChunk } from '../types'
import type { ReadPlan, SpanScanOptions } from '../metacooler/matrix'
import { PIXEL_BAND_GAP } from '../metacooler/matrix'
import type { PixelStore, ScanAllOptions } from '../metacooler/store'
import { ViewerError } from '../errors'
import type { BinnedPixels } from './bin'

/** Pixels per chunk handed to a callback; the cooler path's own default. */
const CHUNK = 1 << 20

export class PairsStore implements PixelStore {
  private offsets: Float64Array | null = null

  constructor(private readonly pixels: BinnedPixels) {}

  get nnz(): number {
    return this.pixels.nnz
  }

  /**
   * Counts are integers and are stated as such.
   *
   * A pairs file is a list of observations, so a bin's value is a count of
   * them: there is no balancing, no expected value and no float anywhere in the
   * path. Saying `'i'` is what lets the float-preservation guarantee stay off.
   */
  readonly countKind = 'i' as const

  scoreColumns(): string[] {
    return ['count']
  }

  /**
   * The CSR row pointer, built once.
   *
   * `bin1` is ascending out of the importer — the merge pass guarantees it even
   * for a file that was not sorted — so this is a counting pass and nothing
   * more.
   */
  binOffsets(): Float64Array {
    if (this.offsets !== null) return this.offsets
    const { bin1, nnz, nBins } = this.pixels
    const offsets = new Float64Array(nBins + 1)
    let at = 0
    for (let bin = 0; bin < nBins; bin++) {
      while (at < nnz && bin1[at] === bin) at++
      offsets[bin + 1] = at
    }
    this.offsets = offsets
    return offsets
  }

  async forEachWindow(
    _rows: Extent,
    _cols: Extent,
    plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    this.refuseOtherColumns(options.value)
    const range = this.pixelRange(plan.span[0], plan.span[1])
    return this.emit(range[0], range[1], onChunk, options)
  }

  async forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    this.refuseOtherColumns(options.value)
    for (const [lo, hi] of this.mergedBands(bands)) {
      if (!(await this.emit(lo, hi, onChunk, options))) return false
    }
    return true
  }

  async scanAll(options: ScanAllOptions): Promise<void> {
    const width = Math.max(1, Math.trunc(options.chunkSize ?? CHUNK))
    const total = this.pixels.nnz
    for (let at = 0; at < total; at += width) {
      const end = Math.min(at + width, total)
      if (options.onChunk(this.chunk(at, end)) === false) return
      options.onProgress?.(end, total)
      await yieldToEventLoop()
    }
  }

  /** Pixel index range for a half-open bin range, from the CSR pointer. */
  private pixelRange(lo: number, hi: number): Extent {
    const offsets = this.binOffsets()
    const nBins = this.pixels.nBins
    const from = offsets[Math.max(0, Math.min(nBins, lo))]
    const to = offsets[Math.max(0, Math.min(nBins, hi))]
    return [from, Math.max(from, to)]
  }

  /**
   * Bin ranges as merged pixel ranges.
   *
   * The same shape, and the same gap constant, as `CoolerStore.pixelBandsOf`.
   * The gap is about the *source's* 1 MiB reads there and about nothing here —
   * but merging still matters, because each range costs a chunk boundary and a
   * yield, and a selection of four hundred contigs would otherwise be four
   * hundred of both.
   */
  private mergedBands(extents: readonly Extent[]): Extent[] {
    const bands: Extent[] = []
    for (const [lo, hi] of extents) {
      if (hi <= lo) continue
      const [p0, p1] = this.pixelRange(lo, hi)
      if (p1 > p0) bands.push([p0, p1])
    }
    bands.sort((a, b) => a[0] - b[0])
    const merged: Extent[] = []
    for (const band of bands) {
      const last = merged[merged.length - 1]
      if (last !== undefined && band[0] <= last[1] + PIXEL_BAND_GAP) {
        last[1] = Math.max(last[1], band[1])
      } else {
        merged.push([band[0], band[1]])
      }
    }
    return merged
  }

  /** Hand `[from, to)` over in chunks, yielding so a cancel is seen. */
  private async emit(
    from: number,
    to: number,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions,
  ): Promise<boolean> {
    const width = Math.max(1, Math.trunc(options.chunkSize ?? CHUNK))
    const total = to - from
    for (let at = from; at < to; at += width) {
      if (options.cancelled?.() === true) return false
      const end = Math.min(at + width, to)
      onChunk(this.chunk(at, end))
      options.onProgress?.(end - from, total)
      await yieldToEventLoop()
    }
    return true
  }

  /**
   * One chunk, as a `PixelChunk` — **copied**, never a view.
   *
   * A `subarray` would be free and is the wrong call, for a reason particular
   * to this store: it is the only one whose arrays are the *session's own
   * data*. `CoolerStore` hands back what it just read out of HDF5 and
   * `HicStore` what it just decoded from a block, so a caller that keeps or
   * neuters one of their chunks damages nothing. Here a view is a window onto
   * the imported table itself, and `transfersFor` — which walks a result
   * payload and transfers every buffer it finds — would *detach the whole
   * pixel table* the first time a chunk reached one. The map would go blank
   * with no error anywhere.
   *
   * So the three arrays are materialised per chunk, which is exactly what the
   * other two stores pay anyway, and the failure mode stops existing rather
   * than being documented as a rule for future callers to remember.
   */
  private chunk(from: number, to: number): PixelChunk {
    const { bin1, bin2, count } = this.pixels
    return {
      bin1: bin1.slice(from, to),
      bin2: bin2.slice(from, to),
      count: Float64Array.from(count.subarray(from, to)),
      length: to - from,
    }
  }

  /** A column that is not `count` is a question this container cannot answer. */
  private refuseOtherColumns(value: string | undefined): void {
    if (value === undefined || value === 'count') return
    throw new ViewerError(
      'unsupported',
      `A map binned from a .pairs file stores one value per pixel — the number of contacts ` +
        `— so there is no '${value}' column to draw. Extra per-pixel columns come from a ` +
        'cooler that was written with them.',
      { value },
    )
  }
}

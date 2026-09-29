/**
 * Where the pixels come from, once there is more than one kind of file.
 *
 * Everything above this line — the views, the aggregations, the pooled reads,
 * the fourteen analysis tasks — is written against *stored pixels in global bin
 * coordinates, upper-triangular*. That description is true of a cooler and true
 * of a `.hic`, and it is the only thing about either that the rest of the app
 * needs. The containers disagree about how those pixels are indexed, and this
 * interface is exactly the width of that disagreement.
 *
 * ## Why the seam is here and not lower
 *
 * A `.hic` cannot pretend to be a cooler at the *dataset* level, and the
 * temptation to try it should be resisted once rather than repeatedly. A cooler
 * indexes pixels by a single cumulative array — `indexes/bin1_offset` — and
 * addresses them by a flat position in one globally sorted table. A `.hic` has
 * no such table and no such order: it is one matrix per chromosome pair, cut
 * into blocks. Synthesising a global sort would mean reading the entire file to
 * open it, which is the one thing §2 does not do.
 *
 * So the seam is drawn one level up, at the operation rather than the dataset:
 * *give me the stored pixels this rectangle needs*. A cooler answers by reading
 * a row band and letting the scatter discard the columns; a `.hic` answers by
 * reading the blocks the rectangle actually covers, which is strictly less. Both
 * hand back COO in the same coordinates, and nothing downstream branches.
 *
 * ## What is deliberately *not* here
 *
 * **Weights.** Balancing goes on reading `bins/weight` through the handle, for
 * both containers, because a `.hic`'s normalisation vectors can be served under
 * that name (`hic/handle.ts`) at the same cost. Putting them here as well would
 * be a second path to one number, and `analysis/run/blocks.ts` — which reads the
 * weight column directly — would have had to learn about stores for nothing.
 *
 * **Tables and attributes.** Same reason, and the same mechanism: a `.hic`
 * header *is* a `/chroms` table and a set of root attributes once somebody
 * writes the twenty lines that say so.
 */

import { yieldToEventLoop } from '../async'
import type { Extent, PixelChunk } from '../types'
import type { Hdf5Handle } from '../h5/api'
import {
  DEFAULT_COUNT_COLUMN,
  PIXEL_BAND_GAP,
  forEachPixelRangesAsync,
  forEachPixelSpanAsync,
  scoreColumns as coolerScoreColumns,
  type ReadPlan,
  type SpanScanOptions,
} from './matrix'

/** How a caller walks every pixel in the file. */
export interface ScanAllOptions {
  chunkSize?: number
  /** Returning `false` abandons the scan where it stands. */
  onChunk(chunk: PixelChunk): boolean | void
  onProgress?(done: number, total: number): void
}

/**
 * The pixels of one open map, however they are stored.
 *
 * Implementations: {@link CoolerStore} over HDF5, and `hic/store.ts` over a
 * `.hic`. A third would be a third container, not a third strategy.
 */
export interface PixelStore {
  /**
   * Stored pixels in the file, or `null` where the container does not say.
   *
   * A cooler carries the number as an attribute and as a dataset length; a
   * `.hic` carries a per-matrix sum of *counts* and no count of records, so it
   * answers `null` rather than a plausible-looking guess. Every caller treats
   * `null` as "unknown" and none of them needs it to draw.
   */
  readonly nnz: number | null

  /** The dtype kind of the value column, for the float-preservation guarantee. */
  readonly countKind: 'i' | 'u' | 'f'

  /** Value columns this file offers, `count` first. */
  scoreColumns(): string[]

  /**
   * Cumulative stored-pixel counts, one entry per bin plus a terminator.
   *
   * The density proxy behind the genomes table's sortable column, and behind
   * nothing else once {@link forEachBands} owns the selection read. A container
   * that has no such index throws a named refusal rather than estimating: the
   * column is a *count of stored pixels*, and a number that is not that would be
   * a sortable lie.
   */
  binOffsets(): Float64Array

  /**
   * `true` where {@link forEachWindow} reads the blocks of the rectangle and no
   * more — a two-dimensional index, as a `.hic` has — rather than the whole row
   * band a CSR index can only locate. A reader that needs several rectangles,
   * the lens of an edit (`lens.ts`), reads such a store a rectangle at a time
   * and any other a band at a time. Absent is `false`.
   */
  readonly rectangular?: boolean

  /**
   * Walk the stored pixels a rectangle needs.
   *
   * `plan` is what `planRead` decided about the storage mode — whether the
   * rectangle is read direct, transposed, or symmetrically across the diagonal
   * — and a store may use it to narrow further or ignore it entirely. The chunks
   * handed to `onChunk` are **not retained** between calls; a callback that
   * needs one past its own return must copy.
   *
   * @returns `false` when it stopped early because the caller cancelled.
   */
  forEachWindow(
    rows: Extent,
    cols: Extent,
    plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options?: SpanScanOptions,
  ): Promise<boolean>

  /**
   * Walk the stored pixels of a set of bin ranges, against every column.
   *
   * The selection view (§5.1's *show N selected*): four MAGs out of two
   * thousand, their own maps on the diagonal and every block between them off
   * it. The bands are row ranges and the columns are the whole file, because
   * that is the picture.
   */
  forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options?: SpanScanOptions,
  ): Promise<boolean>

  /** Walk every stored pixel in the file. The genome × genome overview's read. */
  scanAll(options: ScanAllOptions): Promise<void>
}

/**
 * A cooler's pixel table, which is what every one of these operations was
 * written against before there was an interface at all.
 *
 * Nothing here is new behaviour. It is the four call sites that used to live in
 * `MetaCooler`, moved behind a name so that a second container can occupy the
 * same name — which is why this class is thin to the point of looking pointless
 * and should stay that way. Logic that migrates into it is logic that a `.hic`
 * will have to reimplement.
 */
export class CoolerStore implements PixelStore {
  constructor(
    private readonly handle: Hdf5Handle,
    private readonly nBins: number,
    readonly countKind: 'i' | 'u' | 'f',
  ) {}

  private offsets: Float64Array | null = null

  get nnz(): number {
    return this.handle.datasetLength('pixels/bin1_id')
  }

  scoreColumns(): string[] {
    return coolerScoreColumns(this.handle)
  }

  binOffsets(): Float64Array {
    this.offsets ??= this.handle.readNumeric('indexes/bin1_offset')
    return this.offsets
  }

  async forEachWindow(
    _rows: Extent,
    _cols: Extent,
    plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    // The column range is not consulted, and that is the CSR index's limit
    // rather than an oversight: `bin1_offset` locates a row band and says
    // nothing about which columns it holds, so the discard happens in the
    // scatter. A `.hic` does better here because its index is two-dimensional.
    return forEachPixelSpanAsync(this.handle, plan.span[0], plan.span[1], onChunk, options)
  }

  async forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    return forEachPixelRangesAsync(this.handle, this.pixelBandsOf(bands), onChunk, options)
  }

  async scanAll(options: ScanAllOptions): Promise<void> {
    const chunkSize = options.chunkSize ?? 1_000_000
    const total = this.nnz
    for (let lo = 0; lo < total; lo += chunkSize) {
      const hi = Math.min(lo + chunkSize, total)
      // `readInt32` rather than `readNumeric` then a narrowing pass: the bin ids
      // are int64 on disk and array indices in use, and the double in between
      // was 8 B per pixel per column that existed only to be thrown away.
      const bin1 = this.handle.readInt32('pixels/bin1_id', lo, hi)
      const bin2 = this.handle.readInt32('pixels/bin2_id', lo, hi)
      const count = this.handle.readNumeric(`pixels/${DEFAULT_COUNT_COLUMN}`, lo, hi)
      const keepGoing = options.onChunk({ bin1, bin2, count, length: count.length })
      options.onProgress?.(hi, total)
      if (keepGoing === false) return
      // A *real* yield, not `await Promise.resolve()`: the cancel arrives as a
      // message, and a microtask never lets the message queue run (`../async`).
      await yieldToEventLoop()
    }
  }

  /**
   * The stored-pixel bands a set of bin ranges occupies, merged.
   *
   * `bin1_offset` is one entry per bin and already in memory, so a band costs
   * two array reads and no I/O. Bands that touch — or that are separated by less
   * than a window's worth of pixels — become one, because the source reads in
   * 1 MiB chunks and seeking over a gap smaller than that costs more than
   * reading across it.
   *
   * Sorted, because the ranges arrive in display order and the file is in file
   * order; a selection that puts MAG_9 before MAG_2 must still be read forwards.
   */
  private pixelBandsOf(extents: readonly Extent[]): Extent[] {
    const offsets = this.binOffsets()
    const bands: Extent[] = []
    for (const [lo, hi] of extents) {
      if (hi <= lo) continue
      const p0 = offsets[Math.max(0, lo)]
      const p1 = offsets[Math.min(this.nBins, hi)]
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
}

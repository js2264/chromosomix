/**
 * A `.hic`'s pixels, as the rest of the reader wants them.
 *
 * The counterpart to `hic/handle.ts`: that module answers the questions a
 * cooler's *metadata* answers, and this one answers the question its pixel
 * table answers. Together they are the whole of the container's surface, and
 * nothing above either knows which file it is looking at.
 *
 * ## The one place this is better than a cooler, and why it is not exploited
 *
 * A cooler's index is one-dimensional: `bin1_offset` locates a row band, and
 * whichever columns that band happens to hold come back and are discarded by
 * the scatter. A `.hic`'s index is two-dimensional, so an off-diagonal
 * rectangle — the pair view, the exact shape this application exists to draw —
 * costs the blocks it covers rather than a whole row band across the genome.
 *
 * That advantage is taken here and is deliberately *not* pushed upward. No
 * caller is given a faster path, no view branches on the container, and no
 * budget is relaxed on the strength of it. A read that is cheaper is simply
 * cheaper; making it visible would make the containers different, which is the
 * property this whole subtree is built to avoid.
 *
 * ## Emitting each stored pixel exactly once
 *
 * Every accumulator above — `scatterDense`, `pixelAccumulator`,
 * `sparseAggregator` — is **additive**, and mirrors what it is given across the
 * diagonal under `symmetric-upper`. So a pixel handed over twice is a cell
 * counted twice, silently, in a picture that still looks like a contact map.
 * Every walk below therefore visits each stored chromosome pair at most once,
 * and the pair set is built as a deduplicated set rather than as a nested loop.
 */

import { ViewerError } from '../errors'
import { yieldToEventLoop } from '../async'
import type { Extent, PixelChunk } from '../types'
import type { ReadPlan, SpanScanOptions } from '../metacooler/matrix'
import type { PixelStore, ScanAllOptions } from '../metacooler/store'
import type { HicFile } from './HicFile'

/** A chromosome pair key, so a set can hold one. */
function pairKey(a: number, b: number): number {
  return a * 1e6 + b
}

export class HicStore implements PixelStore {
  constructor(private readonly file: HicFile) {}

  /**
   * A `.hic` states no record count, and this does not guess one.
   *
   * `sumCounts` per matrix is a sum of *values*, not a count of records, and a
   * block's record count is only knowable by decompressing it. Every caller
   * treats `null` as unknown; the one that used it for a progress denominator
   * counts chromosome pairs instead, which is a real number rather than a
   * plausible one.
   */
  readonly nnz = null

  /** Blocks hold int16 counts or float32 values; the float kind covers both. */
  readonly countKind = 'f' as const

  /** The index is two-dimensional: a rectangle costs its own blocks (`PixelStore.rectangular`). */
  readonly rectangular = true

  scoreColumns(): string[] {
    // One value per record and no room in the format for a second. A `.hic`
    // cannot carry the extra per-pixel columns a cooler may (`expected`, a
    // p-value), so the score picker offers the one that exists.
    return ['count']
  }

  binOffsets(): Float64Array {
    throw new ViewerError(
      'unsupported',
      'A .hic has no per-bin pixel index, so the stored-pixel density column cannot be ' +
        'computed for one. It is a metagenome diagnostic and a .hic has no genomes, so ' +
        'nothing that draws asks for it.',
      {},
    )
  }

  /**
   * The stored pixels a rectangle needs.
   *
   * `plan` is not consulted, and that is correct rather than lazy: it exists to
   * tell a one-dimensional index *which* row band to fetch for a rectangle it
   * cannot express, and this index can express the rectangle. What comes back is
   * every stored pixel inside `rows × cols` **or** inside its transpose, which
   * is the same set under upper-triangular storage and is exactly what
   * `scatterDense` expects to be handed for any of the three plan modes.
   */
  async forEachWindow(
    rows: Extent,
    cols: Extent,
    _plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    this.refuseOtherColumns(options.value)
    return this.walk(this.pairsFor(rows, cols), (a, b) => this.file.pairRecords(a, b, rows, cols), onChunk, options)
  }

  /**
   * The selection view's read: a set of row bands, against every column.
   *
   * A pair is visited when its **first** chromosome — the lower of the two, and
   * therefore the one holding `bin1` — is touched by a band, which mirrors the
   * cooler path's semantics exactly: `forEachPixelRangesAsync` walks the pixels
   * whose `bin1` lies in the band, and the accumulator mirrors the rest.
   */
  async forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    this.refuseOtherColumns(options.value)
    const touched = new Set<number>()
    for (const band of bands) for (const chrom of this.file.chromsSpanning(band)) touched.add(chrom)

    const whole: Extent = [0, this.file.nBins]
    const pairs = this.file.storedPairs().filter(([a]) => touched.has(a))
    return this.walk(
      pairs,
      (a, b) => {
        // The row window is the bands clipped to `a`; the column window is the
        // file. Passing the union of the bands rather than one band at a time is
        // what keeps a pair visited once when two bands land on one chromosome.
        const extent = this.clipTo(a, bands)
        return extent === null ? Promise.resolve(null) : this.file.pairRecords(a, b, extent, whole)
      },
      onChunk,
      options,
    )
  }

  /**
   * Every stored pixel, pair by pair — the genome × genome overview's read.
   *
   * **`options.chunkSize` is not honoured, and that is a limitation rather than
   * a decision.** `CoolerStore.scanAll` reads a bounded window of the pixel
   * table at a time, which is what lets `estimateBlockBytes` charge a constant
   * `PIXEL_CHUNK_BYTES` for the read instead of a term in `nnz`. A `.hic`'s
   * pixels are reachable only through `HicFile.pairRecords`, whose unit is a
   * whole chromosome pair: it holds every decoded block of that pair live and
   * then allocates one combined COO buffer over their total, so peak memory is
   * roughly 28 B per stored record of the largest pair — hundreds of MB for
   * chr1 at a fine rung, against the constant the estimator assumes. The block
   * LRU does not bound it: it bounds what is *cached*, and the read holds
   * strong references to blocks it has already been handed.
   *
   * Narrowing it from this side is not available. `HicFile.localSpan` unions
   * the two axes for an intra pair, so asking for a sub-rectangle of one asks
   * for the bounding square, and two neighbouring sub-rectangles come back
   * holding the same blocks — a pixel handed over twice, which is the one thing
   * the doctrine at the head of this file forbids. The fix is a block-batched
   * read inside `HicFile` that `pairRecords` is then written on top of; until
   * that exists the same caveat applies to {@link forEachWindow} and
   * {@link forEachBands}, whose `chunkSize` is dropped for the same reason.
   */
  async scanAll(options: ScanAllOptions): Promise<void> {
    const whole: Extent = [0, this.file.nBins]
    const pairs = this.file.storedPairs()
    let done = 0
    let stopped = false
    for (const [a, b] of pairs) {
      const records = await this.file.pairRecords(a, b, whole, whole)
      done += 1
      if (records !== null && !stopped) {
        if (options.onChunk(records) === false) stopped = true
      }
      options.onProgress?.(done, pairs.length)
      if (stopped) return
      await yieldToEventLoop()
    }
  }

  /**
   * The stored pairs a rectangle touches.
   *
   * Built from the chromosomes on each axis and then filtered against the master
   * index, so a file written intra-only costs no request for the inter pairs it
   * does not have. Normalised to `(low, high)` and deduplicated, because
   * `rows × cols` and `cols × rows` are one stored matrix.
   */
  private pairsFor(rows: Extent, cols: Extent): Array<[number, number]> {
    const rowChroms = this.file.chromsSpanning(rows)
    const colChroms = this.file.chromsSpanning(cols)
    const seen = new Set<number>()
    const pairs: Array<[number, number]> = []
    for (const r of rowChroms) {
      for (const c of colChroms) {
        const pair: [number, number] = r <= c ? [r, c] : [c, r]
        const key = pairKey(pair[0], pair[1])
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push(pair)
      }
    }
    return pairs
  }

  /** The span of `bands` that falls on one chromosome, as one global extent. */
  private clipTo(chrom: number, bands: readonly Extent[]): Extent | null {
    const [base, end] = this.file.chromExtent(chrom)
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const band of bands) {
      const from = Math.max(band[0], base)
      const to = Math.min(band[1], end)
      if (to <= from) continue
      lo = Math.min(lo, from)
      hi = Math.max(hi, to)
    }
    return Number.isFinite(lo) ? [lo, hi] : null
  }

  /**
   * The common loop: pair by pair, cancellable between them, yielding after each.
   *
   * The yield is what makes a cancel arrive at all — the same argument
   * `forEachPixelSpanAsync` makes for its window loop, and the same reason a
   * whole-file read of either container can be called off.
   */
  private async walk(
    pairs: ReadonlyArray<[number, number]>,
    read: (a: number, b: number) => Promise<PixelChunk | null>,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions,
  ): Promise<boolean> {
    let done = 0
    for (const [a, b] of pairs) {
      if (options.cancelled?.() === true) return false
      const records = await read(a, b)
      if (records !== null && records.length > 0) onChunk(records)
      done += 1
      options.onProgress?.(done, pairs.length)
      await yieldToEventLoop()
    }
    return true
  }

  /**
   * A value column that is not `count` is a question this format cannot answer.
   *
   * Refused by name rather than silently served as `count`, which is the exact
   * failure `SpanScanOptions.value` was added to fix for coolers: one picture
   * drawn from two quantities, with no tell.
   */
  private refuseOtherColumns(value: string | undefined): void {
    if (value === undefined || value === 'count') return
    throw new ViewerError(
      'unsupported',
      `A .hic stores one value per record, so there is no '${value}' column to draw. ` +
        'Extra per-pixel columns are a cooler feature.',
      { value },
    )
  }
}

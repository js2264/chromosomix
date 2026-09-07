/**
 * The resolution ladder, built from the base rung rather than from the file.
 *
 * ## Why the rungs are not binned in the same pass
 *
 * They could be — four scratch rows instead of one, and the pass is dominated
 * by inflate anyway. They are not, because aggregating the base rung is
 * *cheaper than reading the records again* by two orders of magnitude: yeast at
 * 1 kb is 179 M records and 13.7 M pixels, so every rung above the base costs a
 * walk over 13.7 M integers instead of 179 M lines of text. The pass stays
 * single-purpose, the rungs stay derived, and adding a rung after the fact
 * costs seconds rather than a re-import.
 *
 * ## Why every rung derives from the base and never from the rung below
 *
 * The 1/2/5/10/20/50 series is not a chain of integer multiples — 5 is not a
 * multiple of 2 — so a rung cannot generally be summed from its predecessor.
 * Every rung *is* an exact multiple of the base, which is all §3.3 requires:
 * `binnify` wants the target to be a whole multiple of the source, and the
 * source here is always the base. So the ladder is a fan out of one rung, not a
 * staircase, and the arithmetic stays exact at every step.
 *
 * ## The bin mapping is per contig, not global
 *
 * `coarse = floor(base / k)` is the obvious formula and it is wrong at every
 * contig boundary: each contig starts a fresh bin and its last bin may be
 * short, so a global division slides the whole of contig *n+1* by however much
 * contig *n*'s tail did not fill. The mapping has to go through the contig —
 * base bin → contig → offset within contig → coarse bin — which is §3.3's
 * arithmetic run backwards and the reason a lookup from bin to contig is built
 * once and kept.
 */

import { yieldToEventLoop } from '../async'
import { binCountFor, chromOffsetsFor } from './format'
import type { BinnedPixels } from './bin'

/**
 * The multiplier series a ladder steps through.
 *
 * A 1-2-5 decade, which is what a reader means by "the next resolution up": it
 * roughly halves the bin count each step without ever leaving round numbers, so
 * a 1 kb base gives 1 kb, 2 kb, 5 kb, 10 kb, 20 kb — the resolutions published
 * coolers actually carry.
 */
export const LADDER_MULTIPLIERS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000]

/** The most rungs a ladder may have, which is the length of the series. */
export const MAX_LADDER_RUNGS = LADDER_MULTIPLIERS.length

/**
 * Bin sizes for a ladder of `rungs` levels over `base`, coarsest last.
 *
 * A rung whose bins would not divide the smallest contig into at least one bin
 * is still included: a contig shorter than the bin size occupies exactly one
 * bin, which is what `ceil` already says and what cooler itself stores.
 */
export function ladderSizes(base: number, rungs: number): number[] {
  const wanted = Math.max(1, Math.min(rungs, MAX_LADDER_RUNGS))
  return LADDER_MULTIPLIERS.slice(0, wanted).map((multiplier) => base * multiplier)
}

/**
 * A base bin → contig index lookup.
 *
 * One `Int32Array` of `nBins`, built once and reused by every rung. A binary
 * search over `chromOffset` would be `log n` per pixel against a table walked
 * millions of times per rung; four bytes a bin is the cheaper side of that
 * trade by a wide margin.
 */
export function contigOfBin(chromOffset: Float64Array, nBins: number): Int32Array {
  const lookup = new Int32Array(nBins)
  for (let contig = 0; contig + 1 < chromOffset.length; contig++) {
    const from = chromOffset[contig]
    const to = chromOffset[contig + 1]
    for (let bin = from; bin < to && bin < nBins; bin++) lookup[bin] = contig
  }
  return lookup
}

export interface AggregateOptions {
  onProgress?: (done: number, total: number, note?: string) => void
  cancelled?: () => boolean
}

/**
 * Sum a base pixel table onto a coarser grid.
 *
 * The output is in cooler's pixel order — `bin1` ascending, `bin2` ascending
 * within it — by construction rather than by a sort: the base table is already
 * in that order and the bin mapping is monotone non-decreasing, so coarse
 * `bin1` cannot go backwards. Coarse `bin2` *can*, since one coarse row gathers
 * many base rows, which is why a row accumulator is still needed.
 *
 * @returns `null` when the caller cancelled.
 */
export async function aggregatePixels(
  base: BinnedPixels,
  binSize: number,
  options: AggregateOptions = {},
): Promise<BinnedPixels | null> {
  if (binSize === base.binSize) return base
  if (binSize % base.binSize !== 0) {
    throw new Error(
      `A ladder rung must be a whole multiple of the base: ${binSize} is not a multiple of ${base.binSize}.`,
    )
  }
  const k = binSize / base.binSize
  const contigs = base.contigs
  const chromOffset = chromOffsetsFor(contigs, binSize)
  const nBins = binCountFor(contigs, binSize)
  const lookup = contigOfBin(base.chromOffset, base.nBins)

  const coarseOf = (bin: number): number => {
    const contig = lookup[bin]
    return chromOffset[contig] + Math.floor((bin - base.chromOffset[contig]) / k)
  }

  const scratch = new Int32Array(nBins)
  let touched: Int32Array = new Int32Array(Math.min(nBins, 1 << 16))
  let nTouched = 0

  let bin1: Int32Array = new Int32Array(Math.min(base.nnz, 1 << 20) || 1)
  let bin2: Int32Array = new Int32Array(bin1.length)
  let count: Int32Array = new Int32Array(bin1.length)
  let out = 0
  let row = -1
  let sum = 0

  const flush = (): void => {
    if (nTouched === 0) return
    const columns = touched.subarray(0, nTouched)
    columns.sort()
    while (out + nTouched > bin1.length) {
      bin1 = grow(bin1)
      bin2 = grow(bin2)
      count = grow(count)
    }
    for (let i = 0; i < nTouched; i++) {
      const col = columns[i]
      bin1[out] = row
      bin2[out] = col
      count[out] = scratch[col]
      out++
      scratch[col] = 0
    }
    nTouched = 0
  }

  const CHUNK = 1 << 20
  for (let start = 0; start < base.nnz; start += CHUNK) {
    if (options.cancelled?.() === true) return null
    const stop = Math.min(start + CHUNK, base.nnz)
    for (let i = start; i < stop; i++) {
      const r = coarseOf(base.bin1[i])
      const c = coarseOf(base.bin2[i])
      if (r !== row) {
        flush()
        row = r
      }
      if (scratch[c] === 0) {
        if (nTouched === touched.length) touched = grow(touched)
        touched[nTouched++] = c
      }
      scratch[c] += base.count[i]
      sum += base.count[i]
    }
    options.onProgress?.(stop, base.nnz, `aggregating to ${binSize} bp`)
    // A real yield, so a cancel arriving as a message is seen (`../async`).
    await yieldToEventLoop()
  }
  flush()

  return {
    binSize,
    contigs: [...contigs],
    chromOffset,
    nBins,
    bin1: bin1.subarray(0, out),
    bin2: bin2.subarray(0, out),
    count: count.subarray(0, out),
    nnz: out,
    sum,
    skippedUnknownContig: base.skippedUnknownContig,
    clampedPosition: base.clampedPosition,
    wasUnsorted: base.wasUnsorted,
  }
}

function grow(array: Int32Array): Int32Array {
  const next: Int32Array = new Int32Array(Math.max(1, array.length * 2))
  next.set(array)
  return next
}

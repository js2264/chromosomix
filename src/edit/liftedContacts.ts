/**
 * A contact map lifted through an edit of the reference (SPECS §27.8): every
 * stored pixel of a rung, read through the lens — which carries each to the
 * bins of the edited assembly it lands in — gathered, sorted and summed into
 * the table a `.cool` stores. Raw counts, bins moved whole: a piece that begins
 * inside a bin moves with the bin it rounds to, as the map draws it.
 *
 * What a stretch set aside is not in the lens, and its contacts are not
 * written; a duplicated stretch's are written twice, once at each copy. Both
 * are counted in what the file says about itself.
 */

import type { MetaCooler } from '../metacooler/MetaCooler'
import { chromOffsetsFor } from '../pairs/format'
import { mergeDuplicates, type BinnedPixels } from '../pairs/bin'

/** A growable list of 32-bit integers. */
class Ints {
  data = new Int32Array(1 << 16)
  length = 0
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
  view(): Int32Array {
    return this.data.subarray(0, this.length)
  }
}

/**
 * Every pixel of a map drawn through an edit, as the table a `.cool` of the
 * edited assembly stores: the upper triangle, sorted, duplicates summed.
 *
 * @param map A map opened through the lens (`MetaCooler.withLens`), whose
 *   pixels already name the edited assembly's bins.
 * @returns `null` where `cancelled` said so.
 */
export async function liftedTable(
  map: MetaCooler,
  options: { cancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<BinnedPixels | null> {
  const names = [...map.chromnames]
  const lengths = Array.from(map.coords.contigLengths)
  const binSize = map.binsize
  const contigs = names.map((name, i) => ({ name, length: lengths[i] }))
  const chromOffset = chromOffsetsFor(contigs, binSize)
  const nBins = chromOffset[chromOffset.length - 1]
  const bin1 = new Ints()
  const bin2 = new Ints()
  const count = new Ints()
  let stopped = false
  await map.storedPixels.scanAll({
    onChunk: (chunk) => {
      if (options.cancelled?.() === true) {
        stopped = true
        return false
      }
      // A chunk is a buffer the lens reuses: read up to its length, now.
      for (let i = 0; i < chunk.length; i++) {
        const a = chunk.bin1[i]
        const b = chunk.bin2[i]
        const c = Math.round(chunk.count[i])
        if (c <= 0 || a < 0 || b < 0 || a >= nBins || b >= nBins) continue
        // A turned stretch reads its pairs the other way round: the upper
        // triangle is the lower bin first.
        bin1.push(a <= b ? a : b)
        bin2.push(a <= b ? b : a)
        count.push(c)
      }
      return true
    },
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
  if (stopped) return null
  const table: BinnedPixels = {
    binSize,
    contigs,
    chromOffset,
    nBins,
    bin1: bin1.view().slice(),
    bin2: bin2.view().slice(),
    count: count.view().slice(),
    nnz: count.length,
    sum: 0,
    skippedUnknownContig: 0,
    skippedBadPosition: 0,
    clampedPosition: 0,
    wasUnsorted: true,
    truncated: false,
    contigsWithoutCisContacts: [],
  }
  const merged = mergeDuplicates(table)
  let sum = 0
  for (let i = 0; i < merged.nnz; i++) sum += merged.count[i]
  return { ...merged, sum }
}

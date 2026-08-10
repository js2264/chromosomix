/**
 * Fixed-bin coordinate arithmetic (spec §3.3).
 *
 * **`/bins` is never read.** Excluding variable-bin files bought exactly this:
 * with a uniform bin size the whole coordinate model is arithmetic over two
 * arrays that open already put in memory — `indexes/chrom_offset` and
 * `contigs/length`. So one of the four large tables in the file is never
 * touched: not on open, not per view, not over the network. A read of `/bins`
 * anywhere in this codebase is a bug, and a test enforces it.
 */

/**
 * Index a monotone non-decreasing offset array, CSR-style.
 *
 * Returns the largest `i` with `offsets[i] <= value`, i.e. NumPy's
 * `searchsorted(offsets, value, side='right') - 1` — the slot that *owns*
 * `value`. Used for bin → contig (`chrom_offset`) and contig → genome
 * (`genome_offset`) alike, so the one binary search is written once.
 *
 * @param offsets Non-decreasing array of length `n + 1`.
 * @param value Position to locate.
 * @returns Owning index in `[0, n)`, clamped at both ends.
 */
export function searchOffset(offsets: ArrayLike<number>, value: number): number {
  let lo = 0
  let hi = offsets.length - 1
  // Invariant: the answer is in [lo, hi). Empty runs (offsets[i] === offsets[i+1])
  // are skipped naturally because the loop lands on the *last* slot whose start
  // is <= value, and an empty slot's successor shares its start.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= value) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The fixed-bin coordinate system of one open map.
 *
 * Constructed from the two things `MetaCooler.open` already holds. Every
 * method is arithmetic; none performs I/O.
 */
export class Coords {
  /** Uniform bin width in bp. Guaranteed positive by the §3.2 gate. */
  readonly binsize: number
  /** `indexes/chrom_offset`: first bin of contig `c`, length `nContigs + 1`. */
  readonly chromOffset: Float64Array
  /** `contigs/length`: contig lengths in bp, length `nContigs`. */
  readonly contigLengths: Float64Array

  constructor(binsize: number, chromOffset: Float64Array, contigLengths: Float64Array) {
    this.binsize = binsize
    this.chromOffset = chromOffset
    this.contigLengths = contigLengths
  }

  /** Number of contigs. */
  get nContigs(): number {
    return this.contigLengths.length
  }

  /** Total number of bins — `chrom_offset`'s last entry, by definition. */
  get nBins(): number {
    return this.chromOffset.length > 0 ? this.chromOffset[this.chromOffset.length - 1] : 0
  }

  /**
   * Bins covering contig `c`: `ceil(length / binsize)` (spec §3.3).
   *
   * Equals `chrom_offset[c + 1] - chrom_offset[c]` on any file that passes
   * validation; the two are computed independently so a disagreement is a
   * genuine signal rather than a tautology.
   */
  binsInContig(contig: number): number {
    return Math.ceil(this.contigLengths[contig] / this.binsize)
  }

  /** First bin index of contig `c`. */
  contigStartBin(contig: number): number {
    return this.chromOffset[contig]
  }

  /** Half-open bin range `[lo, hi)` of contig `c`, straight from the index. */
  contigBinExtent(contig: number): [number, number] {
    return [this.chromOffset[contig], this.chromOffset[contig + 1]]
  }

  /**
   * Global bin index of base-pair position `pos` (0-based) within contig `c`.
   *
   * `chrom_offset[c] + floor(pos / binsize)`, which is exactly what cooler's
   * `_region_to_extent` computes for a fixed-bin file.
   */
  binIndex(contig: number, pos: number): number {
    return this.chromOffset[contig] + Math.floor(pos / this.binsize)
  }

  /** Contig owning global bin `b`, by binary search over `chrom_offset`. */
  contigOfBin(bin: number): number {
    return searchOffset(this.chromOffset, bin)
  }

  /** Start coordinate (bp, 0-based) of global bin `b` within its contig. */
  binStart(bin: number): number {
    const contig = this.contigOfBin(bin)
    return (bin - this.chromOffset[contig]) * this.binsize
  }

  /**
   * End coordinate (bp, exclusive) of global bin `b`.
   *
   * The `min()` is the one place the short last bin of a contig matters —
   * cooler's own rule, which metacooler's validator enforces. Everything else
   * in this file is exact.
   */
  binEnd(bin: number): number {
    const contig = this.contigOfBin(bin)
    const start = (bin - this.chromOffset[contig]) * this.binsize
    return Math.min(start + this.binsize, this.contigLengths[contig])
  }

  /**
   * Map every bin in `[lo, hi)` to its contig id.
   *
   * Seeded with one binary search, then advanced by walking `chrom_offset` —
   * O(nBinsInRange + nContigsSpanned) rather than a search per bin. This is
   * the substitute for reading `/bins/chrom`, which the aggregation path
   * (§6.2) would otherwise need.
   */
  contigsOfBins(lo: number, hi: number): Int32Array {
    const out = new Int32Array(Math.max(0, hi - lo))
    if (out.length === 0) return out
    let contig = this.contigOfBin(lo)
    let nextBoundary = this.chromOffset[contig + 1]
    for (let bin = lo; bin < hi; bin++) {
      while (bin >= nextBoundary && contig + 1 < this.nContigs) {
        contig += 1
        nextBoundary = this.chromOffset[contig + 1]
      }
      out[bin - lo] = contig
    }
    return out
  }
}

/**
 * A bin extent of one resolution, as a bin extent of another.
 *
 * What a zoom needs the moment it is allowed to change rung: the reader's own
 * `matrix` request speaks bins, and **bin indices are not comparable across the
 * levels of an `.mcool`**. Each level has its own `chrom_offset`, and each
 * sequence's last bin is short by its own amount, so the same index means a
 * different place — a different *chromosome*, after a few sequences have gone
 * by. `test/unit/coarse-extent.test.ts` is a whole file about a real cooler
 * where the arithmetic and the bin table disagree, and this is the conversion
 * that has to survive it.
 *
 * So it goes through base pairs, which is the only currency two levels share,
 * and it goes through them **per contig** rather than globally: an extent is
 * anchored to the sequence its first bin falls in, exactly as the reader's own
 * grid is (`snapToGrid`).
 *
 * Rounded **outward** at both ends. A coarse level cannot answer a fine
 * question exactly, and a window that contains what was asked for is the honest
 * failure — the same rule the deck's navigation lock follows when it moves a
 * coarse panel (`panels/lock.ts`), and for the same reason: showing slightly
 * more than was asked for is a picture, and showing slightly less is a picture
 * with something missing from it.
 *
 * An extent spanning several contigs converts its two ends independently, which
 * is right: the ends are what bound the read, and every sequence between them is
 * inside it whichever level it is measured on.
 */
export function crossResolution(from: Coords, to: Coords, extent: readonly [number, number]): [number, number] {
  if (from === to || from.binsize === to.binsize) return [extent[0], extent[1]]
  if (extent[1] <= extent[0]) {
    const at = Math.min(Math.max(extent[0], 0), to.nBins)
    return [at, at]
  }
  const inFile = (bin: number): number => Math.min(Math.max(bin, 0), Math.max(0, from.nBins - 1))

  const loContig = from.contigOfBin(inFile(extent[0]))
  const [fromLoStart] = from.contigBinExtent(loContig)
  const [toLoStart, toLoEnd] = to.contigBinExtent(loContig)
  // **A window that starts at a sequence starts at that sequence**, whatever the
  // two bin sizes divide into. This is not the same answer the arithmetic gives:
  // it is the `chrom_offset` rule the whole coordinate model rests on, and it is
  // what makes converting a whole chromosome and converting it back exact.
  const lo =
    extent[0] <= fromLoStart
      ? toLoStart
      : Math.min(
          Math.max(toLoStart, toLoEnd - 1),
          toLoStart + Math.floor(((extent[0] - fromLoStart) * from.binsize) / to.binsize),
        )

  // The contig of the last bin *inside* the extent, not of the exclusive end —
  // which sits in the next sequence whenever a window ends on a boundary.
  const hiContig = from.contigOfBin(inFile(extent[1] - 1))
  const [fromHiStart, fromHiEnd] = from.contigBinExtent(hiContig)
  const [toHiStart, toHiEnd] = to.contigBinExtent(hiContig)
  // And the mirror of the rule above: a window that reaches the end of a
  // sequence reaches the end of it at the other level too. The arithmetic would
  // fall short here on exactly the files this matters for — a coarse level whose
  // trailing part-bin was absorbed rather than given a row has *fewer* bins than
  // `ceil(length / binsize)`, so the last of them covers more base pairs than
  // its width says (`test/unit/coarse-extent.test.ts`).
  const hi =
    extent[1] >= fromHiEnd
      ? toHiEnd
      : Math.min(
          toHiEnd,
          toHiStart + Math.ceil(((extent[1] - fromHiStart) * from.binsize) / to.binsize),
        )

  return [Math.min(lo, Math.max(0, hi - 1)), Math.min(to.nBins, Math.max(lo + 1, hi))]
}

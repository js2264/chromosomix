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

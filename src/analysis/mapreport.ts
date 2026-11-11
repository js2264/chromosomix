/**
 * The map report's own numbers: the library, and the resolutions it can bear.
 *
 * Everything else in the report is another task's output, gathered (§18.8):
 * P(s), coverage and cis and trans per sequence are computed by those tasks and
 * carried here as they are. What no task computed before is in this file — the
 * totals a library is first judged by, read off the matrix in one pass, and the
 * **resolution ladder**: how contact is spread over bins of each size, from the
 * coarsest to the finest, so a reader can see down to which bin size a map
 * still has contacts in most of its bins.
 *
 * **Numbers, never a verdict.** Rao et al. 2014 call a map's resolution the
 * smallest bin size at which 80 % of bins hold at least 1,000 contacts, and
 * Juicer's `calculate_map_resolution.sh` reports that one size. Both cuts are
 * choices with a number in them; the report gives what they are applied to
 * instead — at every bin size, the count 80 % of bins reach, the median, the
 * mean, and how many bins are empty or nearly so — and leaves the cut to the
 * reader, who can make Rao's at a glance down the column.
 *
 * **A contact is counted at both its ends**, as Juicer's script counts it: a
 * contact between two bins is one for each, and a contact within one bin is two
 * for it. That is what makes a coarser bin's count the sum of its finer bins'
 * exactly, so one pass at the finest bins answers every coarser one — and why
 * these counts are not the Coverage task's, which counts a bin's contact with
 * itself once.
 */

import { CIS_THRESHOLDS_KB } from '../pairs/stats'

/** What one pass over the pixel table counts. */
export interface LibraryTotals {
  /** The sum of every stored count. */
  contacts: number
  cis: number
  trans: number
  /** Contacts within one bin. */
  diagonal: number
  /** Cis contacts whose bins start at least this many kilobases apart, for each of {@link CIS_THRESHOLDS_KB}. */
  cisAtLeast: Array<[number, number]>
  /** Stored pixels with a count. */
  pixels: number
  /** Contact ends per bin: a contact counts once at each of its two bins. */
  ends: Float64Array
}

/**
 * The library's totals and each bin's contact ends, fed pixel chunks.
 *
 * Float64 throughout, for `CoverageAccumulator`'s reason: the sums are of
 * millions of counts, and a share is two of them divided.
 */
export class LibraryAccumulator {
  private readonly ends: Float64Array
  private contacts = 0
  private cis = 0
  private trans = 0
  private diagonal = 0
  private pixels = 0
  private readonly cisAtLeast = new Float64Array(CIS_THRESHOLDS_KB.length)
  /** The thresholds in bins' separations, which is all a pixel knows of distance. */
  private readonly thresholdBp: number[]

  constructor(
    readonly nBins: number,
    private readonly contigOf: Int32Array,
    readonly binsize: number,
  ) {
    this.ends = new Float64Array(nBins)
    this.thresholdBp = CIS_THRESHOLDS_KB.map((kb) => kb * 1000)
  }

  addPixels(bin1: Int32Array, bin2: Int32Array, count: Float64Array, length: number): void {
    for (let k = 0; k < length; k++) {
      const value = count[k]
      if (!(value > 0)) continue
      const a = bin1[k]
      const b = bin2[k]
      if (a < 0 || a >= this.nBins || b < 0 || b >= this.nBins) continue
      this.pixels++
      this.contacts += value
      this.ends[a] += value
      this.ends[b] += value
      const contig = this.contigOf[a]
      if (contig < 0 || contig !== this.contigOf[b]) {
        this.trans += value
        continue
      }
      this.cis += value
      if (a === b) this.diagonal += value
      const separation = Math.abs(b - a) * this.binsize
      for (let t = 0; t < this.thresholdBp.length; t++) {
        if (separation >= this.thresholdBp[t]) this.cisAtLeast[t] += value
      }
    }
  }

  finish(): LibraryTotals {
    return {
      contacts: this.contacts,
      cis: this.cis,
      trans: this.trans,
      diagonal: this.diagonal,
      cisAtLeast: CIS_THRESHOLDS_KB.map((kb, t) => [kb, this.cisAtLeast[t]]),
      pixels: this.pixels,
      ends: this.ends,
    }
  }
}

/** One bin size of the ladder. */
export interface LadderRow {
  binsize: number
  bins: number
  mean: number
  median: number
  /** The largest count at least 80 % of bins reach: the order statistic at ⌊0.2 · bins⌋. */
  reached80: number
  /** Bins with no contact at all, as a fraction of {@link bins}. */
  empty: number
  /** Bins with fewer contacts than a tenth of the median, empty ones included. */
  belowTenthMedian: number
}

/**
 * The bin sizes the ladder reports, coarsest first.
 *
 * The file's own resolutions that are whole multiples of the base bin, and the
 * base bin doubled until it is a tenth of the longest sequence — so a yeast map
 * at 1 kb climbs to 128 kb and a human one to 16 Mb, and every file has a
 * ladder whether or not it carries one. Never finer than the base, which is
 * the finest the pass saw.
 */
export function ladderSizes(base: number, fileRungs: readonly number[], longest: number): number[] {
  const sizes = new Set<number>()
  if (!(base > 0)) return []
  const limit = Math.max(base, longest / 10)
  for (let size = base; size <= limit; size *= 2) sizes.add(size)
  for (const rung of fileRungs) {
    if (rung >= base && rung % base === 0) sizes.add(rung)
  }
  return [...sizes].sort((a, b) => b - a)
}

/**
 * Each bin size's spread of contact ends, coarsest first.
 *
 * `ends` is per base bin over the whole file; `contigs` says where each sequence
 * starts and how many base bins it has. A coarser bin is a run of whole base
 * bins within one sequence — the last of a sequence is short, as the file's own
 * last bin is — so its count is their sum, exactly.
 */
export function resolutionLadder(
  ends: Float64Array,
  contigs: ReadonlyArray<{ startBin: number; bins: number }>,
  base: number,
  sizes: readonly number[],
): LadderRow[] {
  const rows: LadderRow[] = []
  for (const size of sizes) {
    const factor = size / base
    if (!Number.isInteger(factor) || factor < 1) continue
    let total = 0
    for (const contig of contigs) total += Math.ceil(contig.bins / factor)
    const values = new Float64Array(total)
    let at = 0
    for (const contig of contigs) {
      for (let from = 0; from < contig.bins; from += factor) {
        let sum = 0
        const to = Math.min(contig.bins, from + factor)
        for (let bin = from; bin < to; bin++) sum += ends[contig.startBin + bin]
        values[at++] = sum
      }
    }
    rows.push(spreadOf(size, values))
  }
  return rows
}

/** The numbers of one row, from the counts of its bins. */
export function spreadOf(binsize: number, values: Float64Array): LadderRow {
  const n = values.length
  if (n === 0) {
    return { binsize, bins: 0, mean: Number.NaN, median: Number.NaN, reached80: Number.NaN, empty: Number.NaN, belowTenthMedian: Number.NaN }
  }
  const sorted = Float64Array.from(values).sort()
  let sum = 0
  let empty = 0
  for (const value of sorted) {
    sum += value
    if (value === 0) empty++
  }
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const tenth = median / 10
  let below = 0
  for (const value of sorted) {
    if (value < tenth) below++
    else break
  }
  return {
    binsize,
    bins: n,
    mean: sum / n,
    median,
    reached80: sorted[Math.floor(0.2 * n)],
    empty: empty / n,
    belowTenthMedian: below / n,
  }
}

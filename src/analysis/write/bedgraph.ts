/**
 * A per-bin result as bedGraph, which is the plainest thing it can be.
 *
 * Offered beside the bigWig rather than instead of it (§18.7). The bigWig is
 * what a genome browser opens and what a colleague expects; this is what a
 * person opens to *check* it — four columns of text, greppable, diffable, and
 * readable by every tool that has ever touched a genome.
 *
 * It agrees with the bigWig cell for cell, and the two rules that make that true
 * are the two the bigWig writer takes for its own reasons (§18.7):
 *
 * - **A bin with no value is omitted, never written as `NaN` or as `0`.** Every
 *   downstream tool reads a `NaN` in column four as a value, and a zero as a
 *   measurement of nothing. Neither is what an absent bin means. `±Infinity`
 *   goes the same way, for the reason `bigwig.ts` gives at `intervalsFor`: BBI
 *   cannot carry one, so writing one here would be the two files disagreeing
 *   about the same bin — which is exactly what "agrees cell for cell" rules
 *   out.
 * - **The last bin of a contig ends at the sequence, not at the bin boundary.**
 *   A sequence length is not a multiple of the bin size, so the final interval
 *   is short — and one that overran would, on a genome browser, draw signal over
 *   the start of the next chromosome.
 *
 * A `track type=bedGraph` line is deliberately not written. It is a UCSC browser
 * directive rather than part of the format, `bedGraphToBigWig` rejects a file
 * that carries one, and this app's own parser would have to learn to skip it.
 * The provenance goes in `#` comments instead, which every reader already skips.
 */

import type { ProfileOutput, Provenance } from '../types'
import { provenanceLines } from './tsv'

/** One sequence of the assembly a profile is laid out over. */
export interface BedGraphContig {
  name: string
  /** Absolute bin this contig starts at. */
  startBin: number
  bins: number
  length: number
}

/**
 * At most this many significant digits per value.
 *
 * A `Float32Array` carries about seven, and printing seventeen — which is what
 * `String(value)` does for a float that is not exactly representable — makes a
 * 12,000-line file half again as large to express precision the input never
 * had. Trailing zeros and a trailing point are trimmed, so a whole number is
 * written as one.
 */
function format(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(7)))
}

/**
 * Whether a bin has a value at all.
 *
 * One predicate, used by both writers below and matching `bigwig.ts` exactly,
 * because the two files must agree about every bin and the cheapest way for them
 * to stop agreeing is for each to decide separately what counts as absent. It
 * was `Number.isNaN` in both for a while, and the consequence was a bedGraph
 * that wrote a zero where the bigWig wrote an infinity.
 */
function present(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

/**
 * The profile, as bedGraph text.
 *
 * Sorted by construction rather than by a sort: a profile is laid out over the
 * assembly in bin order and the contigs are given in the order the file lists
 * them, so the rows come out in the order `bedGraphToBigWig` requires without
 * anything being compared. Where that stops being true — a caller passing
 * contigs out of order — the file is wrong in a way this module cannot detect,
 * which is why `contigs` is documented as the file's own order rather than as
 * any order.
 */
export function profileToBedGraph(
  output: ProfileOutput,
  contigs: readonly BedGraphContig[],
  provenance: Provenance,
): string {
  const rows: string[] = provenanceLines(provenance)
  const { values, extent, binsize } = output

  for (const contig of contigs) {
    for (let local = 0; local < contig.bins; local++) {
      const bin = contig.startBin + local
      if (bin < extent[0] || bin >= extent[1]) continue
      const value = values[bin - extent[0]]
      if (!present(value)) continue
      const start = local * binsize
      const end = Math.min(contig.length, start + binsize)
      if (!(end > start)) continue
      rows.push(`${contig.name}\t${start}\t${end}\t${format(value)}`)
    }
  }

  rows.push('')
  return rows.join('\n')
}

/**
 * Consecutive equal values folded into one interval.
 *
 * Not the default, and offered rather than applied. A run-length-encoded
 * bedGraph is the same picture in a fraction of the lines and is what you want
 * for something like a compartment call, where a whole chromosome arm holds one
 * value; it is actively unhelpful for a coverage track, where nothing repeats
 * and the only effect is a comparison per row. A `NaN` never joins a run, so a
 * gap still breaks one.
 */
export function profileToBedGraphRuns(
  output: ProfileOutput,
  contigs: readonly BedGraphContig[],
  provenance: Provenance,
): string {
  const rows: string[] = provenanceLines(provenance)
  const { values, extent, binsize } = output

  for (const contig of contigs) {
    let runStart = -1
    let runValue = Number.NaN
    const flush = (endLocal: number): void => {
      if (runStart < 0) return
      const start = runStart * binsize
      const end = Math.min(contig.length, endLocal * binsize)
      if (end > start) rows.push(`${contig.name}\t${start}\t${end}\t${format(runValue)}`)
      runStart = -1
    }
    for (let local = 0; local < contig.bins; local++) {
      const bin = contig.startBin + local
      const inside = bin >= extent[0] && bin < extent[1]
      const value = inside ? values[bin - extent[0]] : undefined
      if (!present(value)) {
        flush(local)
        continue
      }
      // Bit-for-bit equality, not a tolerance. Two float32 values that differ in
      // the last place are two measurements, and merging them would be this
      // module deciding they are the same thing.
      if (runStart >= 0 && value === runValue) continue
      flush(local)
      runStart = local
      runValue = value
    }
    flush(contig.bins)
  }

  rows.push('')
  return rows.join('\n')
}

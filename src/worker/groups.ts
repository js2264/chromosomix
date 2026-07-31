/**
 * Axis runs: which contig or genome each stretch of a rendered block belongs to.
 *
 * The UI needs three things from this — separator positions, tick labels, and
 * "what did I just click on" — and all three are the same list of labelled
 * runs, so they are computed once, worker-side, and travel with the block.
 *
 * Everything here goes through `Coords`, which is the §3.3 arithmetic over
 * `chrom_offset` and `contigs/length`. **`/bins` is never read**, so `/bins/chrom`
 * — which `ops/show.py` uses for exactly this — is derived rather than fetched.
 */

import type { AggregatedMatrix } from '../metacooler/aggregate'
import type { MetaCooler } from '../metacooler/MetaCooler'
import type { Extent } from '../types'
import type { AxisGroup } from './protocol'

/** Collapse a per-cell id vector into labelled runs, in block-local offsets. */
export function idRuns(ids: Int32Array, labelOf: (id: number) => string): AxisGroup[] {
  const runs: AxisGroup[] = []
  if (ids.length === 0) return runs
  let start = 0
  for (let i = 1; i <= ids.length; i++) {
    if (i === ids.length || ids[i] !== ids[start]) {
      runs.push({ label: labelOf(ids[start]), start, end: i })
      start = i
    }
  }
  return runs
}

/** Contig runs covering a bin range. */
export function contigRuns(mc: MetaCooler, extent: Extent): AxisGroup[] {
  const ids = mc.coords.contigsOfBins(extent[0], extent[1])
  return idRuns(ids, (id) => mc.chromnames[id] ?? String(id))
}

/** Genome runs covering a bin range, using the file's own `genome_id` mapping. */
export function genomeRuns(mc: MetaCooler, extent: Extent): AxisGroup[] {
  const contigs = mc.coords.contigsOfBins(extent[0], extent[1])
  const genomes = new Int32Array(contigs.length)
  for (let i = 0; i < contigs.length; i++) genomes[i] = mc.contigGenomeIds[contigs[i]]
  return idRuns(genomes, (id) => mc.genomeNames[id] ?? String(id))
}

/**
 * One run per output row of an aggregated block: after a roll-up each row *is*
 * one contig or one genome, so the runs are unit width and carry the id's name.
 */
export function aggregatedRuns(mc: MetaCooler, ids: Int32Array, level: 'contig' | 'genome'): AxisGroup[] {
  const names = level === 'contig' ? mc.chromnames : mc.genomeNames
  const out: AxisGroup[] = new Array(ids.length)
  for (let i = 0; i < ids.length; i++) {
    out[i] = { label: names[ids[i]] ?? String(ids[i]), start: i, end: i + 1 }
  }
  return out
}

/** Row and column runs for an aggregated block. */
export function aggregatedAxes(
  mc: MetaCooler,
  aggregated: AggregatedMatrix,
): { rows: AxisGroup[]; cols: AxisGroup[] } {
  return {
    rows: aggregatedRuns(mc, aggregated.rowIds, aggregated.level),
    cols: aggregatedRuns(mc, aggregated.colIds, aggregated.level),
  }
}

/** `bin → contig index` for the whole file, for the contig-level overview. */
/**
 * `bin → genome index` for the whole file, for the full-scan overview only.
 *
 * One `Int32Array` of `nBins` entries — 1.7 MB on the 423 k-bin reference file,
 * against a scan that touches every pixel anyway. Ids are the file's own; §7.4's
 * "nothing is renumbered" holds here as everywhere.
 */
export function binContigArray(mc: MetaCooler): Int32Array {
  return mc.coords.contigsOfBins(0, mc.nBins)
}

export function binGenomeArray(mc: MetaCooler): Int32Array {
  const contigs = mc.coords.contigsOfBins(0, mc.nBins)
  const out = new Int32Array(contigs.length)
  for (let i = 0; i < contigs.length; i++) out[i] = mc.contigGenomeIds[contigs[i]]
  return out
}

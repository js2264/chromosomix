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

/**
 * Collapse a per-cell id vector into labelled runs, in block-local offsets.
 *
 * `startOf` reports where each id's unit begins in *absolute* bin space, which
 * is what lets the UI turn a cell offset back into a base-pair position even
 * when the block starts partway into a contig (see {@link AxisGroup.unitStart}).
 * Omitted where there is no such thing — an aggregated axis, an overview.
 *
 * `binOf` answers the other question a run is asked — which sequence is this —
 * and is separate for the reason {@link AxisGroup.unitBin} gives: a coarsened
 * axis has an origin that depends on its own block and an identity that does
 * not, so one number cannot be both.
 */
export function idRuns(
  ids: Int32Array,
  labelOf: (id: number) => string,
  startOf?: (id: number) => number,
  lengthOf?: (id: number) => number,
  binOf?: (id: number) => number,
): AxisGroup[] {
  const runs: AxisGroup[] = []
  if (ids.length === 0) return runs
  let start = 0
  for (let i = 1; i <= ids.length; i++) {
    if (i === ids.length || ids[i] !== ids[start]) {
      const id = ids[start]
      runs.push({
        label: labelOf(id),
        start,
        end: i,
        ...(startOf === undefined ? {} : { unitStart: startOf(id) }),
        ...(lengthOf === undefined ? {} : { unitLength: lengthOf(id) }),
        ...(binOf === undefined ? {} : { unitBin: binOf(id) }),
      })
      start = i
    }
  }
  return runs
}

/** Contig runs covering a bin range. */
export function contigRuns(mc: MetaCooler, extent: Extent): AxisGroup[] {
  const ids = mc.coords.contigsOfBins(extent[0], extent[1])
  return idRuns(
    ids,
    (id) => mc.chromnames[id] ?? String(id),
    (id) => mc.coords.contigStartBin(id),
    (id) => mc.coords.contigLengths[id],
    (id) => mc.coords.contigStartBin(id),
  )
}

/** Genome runs covering a bin range, using the file's own `genome_id` mapping. */
export function genomeRuns(mc: MetaCooler, extent: Extent): AxisGroup[] {
  const contigs = mc.coords.contigsOfBins(extent[0], extent[1])
  const genomes = new Int32Array(contigs.length)
  for (let i = 0; i < contigs.length; i++) genomes[i] = mc.contigGenomeIds[contigs[i]]
  return idRuns(
    genomes,
    (id) => mc.genomeNames[id] ?? String(id),
    (id) => mc.genomeExtent(id)[0],
  )
}

/**
 * Genome runs over an axis that is already one contig per slot.
 *
 * The contig-level sibling of {@link genomeRuns}, which walks bins. Here the
 * axis carries contig ids directly, so the run encoding is over those — and it
 * is a *run* encoding rather than one entry per slot for the same reason
 * everywhere else: contigs arrive grouped by genome (C4), so a genome is a
 * stretch, and the tooltip resolves an offset by binary search over stretches.
 *
 * No `unitStart`: a genome's absolute bin has no meaning on an axis whose unit
 * is a contig index, and a position inside one would be an invention.
 */
export function aggregatedGenomeRuns(mc: MetaCooler, contigIds: Int32Array): AxisGroup[] {
  const genomes = new Int32Array(contigIds.length)
  for (let i = 0; i < contigIds.length; i++) genomes[i] = mc.contigGenomeIds[contigIds[i]]
  return idRuns(genomes, (id) => mc.genomeNames[id] ?? String(id))
}

/**
 * Whether a selection's genome runs are the lines to *draw*, or only a name for
 * the tooltip (`MatrixResult.genomeBoundaries`).
 *
 * **What was ticked is what the axis is divided and labelled by.** Ticking four
 * MAGs asks for four blocks, and their two thousand contig hairlines drawn
 * across them are the grey wash the whole-metagenome view already refuses
 * (`ui/MatrixPanel.separatorsFor`) — they hide exactly the block structure that
 * was the reason for ticking. Ticking *contigs* is the same rule read the other
 * way: there the choice was the contigs, their names are the answer to "what did
 * I pick", and coarsening to the genomes they came from would lose it.
 *
 * One genome is not a selection of genomes to divide by — its own contigs are
 * the only structure inside it, which is what a single genome's map has always
 * shown. Hence the runs rather than the names asked for: a name this file does
 * not have is already gone from them, so four ticks that matched one genome are
 * one genome here.
 */
export function selectionDrawsGenomes(
  unit: 'genome' | 'contig',
  genomeRuns: readonly AxisGroup[] | undefined,
): boolean {
  return unit === 'genome' && genomeRuns !== undefined && genomeRuns.length > 1
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

/**
 * `bin → unit index` for the whole file, for the full-scan overview only.
 *
 * One `Int32Array` of `nBins` entries — 1.7 MB on the 423 k-bin reference file,
 * against a scan that touches every pixel anyway. Ids are the file's own; §7.4's
 * "nothing is renumbered" holds here as everywhere.
 *
 * Both are memoised per open file: toggling contig ↔ genome level, or re-running
 * the scan after a cancel, rebuilt a 1.7 MB array and an O(nBins) walk each time
 * for an answer that cannot change while the file is open. `WeakMap` because the
 * lifetime that matters is the reader's, and it is the reader that gets dropped.
 */
const BIN_UNITS = new WeakMap<MetaCooler, { contig?: Int32Array; genome?: Int32Array }>()

function memo(mc: MetaCooler): { contig?: Int32Array; genome?: Int32Array } {
  let slot = BIN_UNITS.get(mc)
  if (slot === undefined) {
    slot = {}
    BIN_UNITS.set(mc, slot)
  }
  return slot
}

export function binContigArray(mc: MetaCooler): Int32Array {
  const slot = memo(mc)
  slot.contig ??= mc.coords.contigsOfBins(0, mc.nBins)
  return slot.contig
}

export function binGenomeArray(mc: MetaCooler): Int32Array {
  const slot = memo(mc)
  if (slot.genome === undefined) {
    // Written in place over the contig ids rather than into a second array:
    // `contigsOfBins` mints a fresh buffer for this call, the mapping is
    // position-wise, and the intermediate was 1.7 MB of immediate garbage.
    const out = mc.coords.contigsOfBins(0, mc.nBins)
    const genomeOf = mc.contigGenomeIds
    for (let i = 0; i < out.length; i++) out[i] = genomeOf[out[i]]
    slot.genome = out
  }
  return slot.genome
}

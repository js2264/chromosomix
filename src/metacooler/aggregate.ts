/**
 * Contig and genome roll-up of an **already-loaded** matrix (spec §4, M2.5).
 *
 * This is the free operation in the cost table: a genome's matrix is already
 * in memory (§2), so the contig-level view of it is arithmetic, not I/O. No
 * function in this file touches the handle.
 *
 * Three constraints shape it:
 *
 * - **bin → contig comes from `chrom_offset`**, by binary search, not from
 *   `/bins/chrom`. `/bins` is never read (§3.3), and the index already encodes
 *   the same mapping exactly.
 * - **accumulation is `Float64Array`.** The on-disk format widens counts to
 *   int64 precisely because summation overflows int32 (a genome pair can
 *   exceed 2^31 contacts on real metagenomic data); a `Float32Array`
 *   accumulator would start losing whole contacts above 2^24.
 * - **an on-diagonal block must be folded before it is summed.** The loaded
 *   block carries *both* triangles of an upper-triangular store, so a stored
 *   pixel `(i, j)` with `i < j` appears at both `(i, j)` and `(j, i)`. Summing
 *   the block naively therefore counts every within-group off-diagonal pixel
 *   twice, inflating exactly the diagonal of the result — which is where a
 *   contig- or genome-level heatmap has its largest values, so the error is
 *   invisible as an artefact and simply reads as "the diagonal is strong".
 *   `_aggregate_sparse` maps stored pixels once and only then symmetrises
 *   (`agg + agg.T - diag(agg)`), and {@link aggregateDense} reproduces that.
 */

import type { DenseMatrix } from '../types'
import type { Coords } from './coords'

/** Aggregation level, matching `ops/aggregate.py`. */
export type AggregationLevel = 'contig' | 'genome'

/**
 * A rolled-up block. Deliberately not a {@link DenseMatrix}: the values are
 * `Float64Array`, and each axis carries the ids it aggregated to so the UI can
 * label rows without re-deriving them.
 */
export interface AggregatedMatrix {
  nrows: number
  ncols: number
  /** Row-major sums, `nrows * ncols` long. */
  values: Float64Array
  /** Contig or genome id of each output row, in output order. */
  rowIds: Int32Array
  /** Contig or genome id of each output column, in output order. */
  colIds: Int32Array
  level: AggregationLevel
}

/** A grouping of an axis: which output slot each input row falls into. */
export interface AxisGrouping {
  /** Output slot of every input row/column. */
  slot: Int32Array
  /** The group id occupying each output slot, in first-appearance order. */
  ids: Int32Array
}

/**
 * Collapse a vector of group ids into output slots, preserving the order in
 * which each id is first seen.
 *
 * First-appearance order is the right rule even though bins arrive sorted by
 * contig (and contigs by genome, under the accepted ordering): it makes the
 * function total, so a caller that hands it an arbitrary permutation gets a
 * sensible answer instead of a silently wrong one.
 */
export function groupRuns(ids: Int32Array): AxisGrouping {
  const slot = new Int32Array(ids.length)
  const seen = new Map<number, number>()
  const order: number[] = []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    let index = seen.get(id)
    if (index === undefined) {
      index = order.length
      seen.set(id, index)
      order.push(id)
    }
    slot[i] = index
  }
  return { slot, ids: Int32Array.from(order) }
}

/**
 * Sum a dense block into the groups its axes belong to.
 *
 * @param m The loaded block; `m.values` is read, never modified.
 * @param rows Grouping of `m`'s rows (`slot.length === m.nrows`).
 * @param cols Grouping of `m`'s columns (`slot.length === m.ncols`).
 * @param level What the group ids mean, carried through to the result.
 * @param symmetrised `true` when the block covers one bin range on both axes
 *   and was mirrored out of an upper-triangular store — i.e. the block is
 *   symmetric and each stored pixel off the diagonal is present twice. Then
 *   only the upper triangle is summed and the result is mirrored, which is
 *   `_aggregate_sparse`'s `agg + agg.T - diag(agg)` and the only way to match
 *   `metacooler aggregate` / `metacooler show --level contig`. Requires a
 *   square block; a rectangular one (a genome *pair*) holds each stored pixel
 *   once and must be summed directly.
 */
export function aggregateDense(
  m: DenseMatrix,
  rows: AxisGrouping,
  cols: AxisGrouping,
  level: AggregationLevel,
  symmetrised = false,
): AggregatedMatrix {
  const nrows = rows.ids.length
  const ncols = cols.ids.length
  const values = new Float64Array(nrows * ncols)
  const fold = symmetrised && m.nrows === m.ncols
  for (let r = 0; r < m.nrows; r++) {
    const a = rows.slot[r]
    const inRow = r * m.ncols
    // `c = r` keeps the diagonal, drops the mirror. On a square block the two
    // axes index the same bins, so `c >= r` is exactly `bin1_id <= bin2_id`.
    for (let c = fold ? r : 0; c < m.ncols; c++) {
      const b = cols.slot[c]
      // The output slot is upper-triangular too, mirroring `to_upper_triangle`
      // on the *group* ids. Under the accepted ordering `a <= b` already holds
      // whenever `r <= c`; the swap keeps the function total for a caller that
      // hands in an arbitrary permutation.
      const out = fold && a > b ? b * ncols + a : a * ncols + b
      const value = m.values[inRow + c]
      // A NaN is a bin the balancer dropped, not a value. It contributes
      // nothing rather than turning its whole contig NaN — one filtered bin
      // among 4,000 would otherwise blank the chromosome it sits in, and a
      // balanced contig-level view of a real file would be empty.
      if (!Number.isNaN(value)) values[out] += value
    }
  }
  if (fold) {
    for (let a = 0; a < nrows; a++) {
      for (let b = a + 1; b < ncols; b++) values[b * ncols + a] = values[a * ncols + b]
    }
  }
  return { nrows, ncols, values, rowIds: rows.ids, colIds: cols.ids, level }
}

/**
 * Contig id of every bin in `[lo, hi)`, derived from `chrom_offset`.
 *
 * The substitute for `/bins/chrom`, which `_bin_to_level_mapping` reads and
 * this viewer must not.
 */
export function contigGrouping(coords: Coords, lo: number, hi: number): AxisGrouping {
  return groupRuns(coords.contigsOfBins(lo, hi))
}

/**
 * Genome id of every bin in `[lo, hi)`: the same `chrom_offset` walk, then one
 * lookup per bin into `contigs/genome_id` — the file's own mapping, used as
 * written.
 */
export function genomeGrouping(
  coords: Coords,
  contigGenomeIds: Int32Array,
  lo: number,
  hi: number,
): AxisGrouping {
  const contigs = coords.contigsOfBins(lo, hi)
  const genomes = new Int32Array(contigs.length)
  for (let i = 0; i < contigs.length; i++) genomes[i] = contigGenomeIds[contigs[i]]
  return groupRuns(genomes)
}

/**
 * Roll a loaded block up to contig or genome level in one call.
 *
 * The block's own `rowExtent` / `colExtent` say which bins it covers, so the
 * grouping is derived from the matrix itself and cannot drift out of step with
 * the data it describes — and it is also what decides whether the block needs
 * folding: identical extents mean an on-diagonal block, which carries both
 * triangles of the store and would otherwise double-count its own diagonal.
 *
 * @param upperTriangular `true` for a `symmetric-upper` file (every one
 *   metacooler writes). Under `square` storage both triangles are stored
 *   independently, each dense cell is a value in its own right, and the direct
 *   sum is the correct one.
 *
 * A block whose extents *partially* overlap is neither case: it is mirrored
 * inside the overlap only. No view produces one — genome views are
 * on-diagonal and pair views disjoint — so it is summed directly, and the
 * overlap would be double-counted if a caller ever built one.
 */
export function aggregateMatrix(
  m: DenseMatrix,
  coords: Coords,
  contigGenomeIds: Int32Array,
  level: AggregationLevel,
  upperTriangular = true,
): AggregatedMatrix {
  const build = (extent: readonly [number, number]): AxisGrouping =>
    level === 'contig'
      ? contigGrouping(coords, extent[0], extent[1])
      : genomeGrouping(coords, contigGenomeIds, extent[0], extent[1])
  const onDiagonal = m.rowExtent[0] === m.colExtent[0] && m.rowExtent[1] === m.colExtent[1]
  const rows = build(m.rowExtent)
  // Reused, not rebuilt: on-diagonal the two axes *are* the same bins, and
  // sharing the object makes that identity visible rather than incidental.
  const cols = onDiagonal ? rows : build(m.colExtent)
  return aggregateDense(m, rows, cols, level, onDiagonal && upperTriangular)
}

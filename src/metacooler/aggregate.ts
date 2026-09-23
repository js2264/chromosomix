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

import type { DenseMatrix, Extent } from '../types'
import type { Coords } from './coords'
import { IDENTITY_PLAN, partitionAxis } from './pooling'
import type { PlacementMode } from './matrix'

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

/** What {@link pixelAccumulator} hands back: a place to put pixels, and the block. */
export interface PixelAccumulator<V extends Float64Array | Float32Array> {
  place(bin1: number, bin2: number, value: number): void
  finish(): Omit<AggregatedMatrix, 'level' | 'values'> & { values: V }
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
 * The same grouping, with its output slots collapsed until there are at most
 * `cap` of them.
 *
 * A contig-level roll-up allocates one cell per contig on each axis and nothing
 * bounded it: a genome of 4,882 contigs is a 190 MB accumulator for a picture
 * 4,096 pixels wide, and the renderer then pooled it two cells to a pixel — flat,
 * blind to which contig was which, so the pointer resolved one sequence and the
 * pixel held the largest of the four pairs under it. That is the straddling the
 * bin path was fixed for, reached through a different door.
 *
 * So the axis is coarsened where it is built, by the same {@link partitionAxis}
 * the bin grid uses, over the *groups* rather than over the bins. A cell is then
 * a run of whole contigs — kept inside one genome, since that is the distinction
 * the picture exists to draw — and it is named after the first of them, which is
 * what a run of them was already named after.
 *
 * @param groupOf Coarser structure over the groups, if there is one: the genome
 *   each contig belongs to. Absent at genome level, where there is nothing above.
 */
export function coarsenGrouping(
  grouping: AxisGrouping,
  cap: number,
  groupOf?: (id: number) => number,
): { grouping: AxisGrouping; perCell: number } {
  const n = grouping.ids.length
  if (n <= cap) return { grouping, perCell: 1 }
  const starts = Int32Array.from({ length: n }, (_, i) => i)
  const groups = groupOf === undefined ? undefined : Int32Array.from(grouping.ids, groupOf)
  const part = partitionAxis(n, starts, cap, IDENTITY_PLAN, groups)
  const slot = new Int32Array(grouping.slot.length)
  for (let i = 0; i < slot.length; i++) {
    const was = grouping.slot[i]
    slot[i] = was < 0 ? -1 : part.slot[was]
  }
  const ids = new Int32Array(part.cells)
  for (let c = 0; c < part.cells; c++) ids[c] = grouping.ids[part.cellStart[c]]
  return { grouping: { slot, ids }, perCell: part.plan.contigsPerCell }
}

/**
 * The roll-up, from the **stored pixels** rather than from a dense block.
 *
 * {@link aggregateMatrix} needs the block materialised first, and that is the wrong
 * way round for a selection whose output is small and whose input is not: a
 * whole yeast genome at 500 bp is 2,366 MB of `Float32Array` and 295 million
 * loop iterations to produce a 17 × 17 answer — 2,046,919 dense cells per output
 * cell — and its cost does not move with the file's sparsity, because it walks
 * cells rather than pixels. Measured on that shape: 2,090 ms against 139 ms for
 * this, with identical output.
 *
 * It also means the roll-up no longer passes through the dense guard. A
 * contig-level whole-genome view was being refused for the size of a block it
 * only ever wanted to collapse — the one escape hatch the refusal offered, and
 * it did not work.
 *
 * The accumulation is `_aggregate_sparse`'s: map each stored pixel once into its
 * pair of groups, then symmetrise on the diagonal. That is exactly what
 * {@link aggregateDense}'s `fold` reproduces from the mirrored dense block, so
 * the two agree cell for cell.
 *
 * @param place Called once per stored pixel with its two bin ids and value;
 *   the caller drives the read, so this module still performs no I/O.
 */
export function sparseAggregator(
  rows: Extent,
  cols: Extent,
  coords: Coords,
  contigGenomeIds: Int32Array,
  level: AggregationLevel,
  plan: PlacementMode,
  upperTriangular = true,
  cap = Number.POSITIVE_INFINITY,
): {
  place(bin1: number, bin2: number, value: number): void
  finish(): AggregatedMatrix
  perCell: number
} {
  const build = (extent: Extent): AxisGrouping =>
    level === 'contig'
      ? contigGrouping(coords, extent[0], extent[1])
      : genomeGrouping(coords, contigGenomeIds, extent[0], extent[1])
  const onDiagonal = rows[0] === cols[0] && rows[1] === cols[1]
  // Only a contig axis has a coarser structure to stay inside; at genome level
  // the group already *is* the genome.
  const groupOf =
    level === 'contig' && contigGenomeIds.length > 0
      ? (id: number): number => contigGenomeIds[id] ?? -1
      : undefined
  const rowCoarse = coarsenGrouping(build(rows), cap, groupOf)
  const colCoarse = onDiagonal ? rowCoarse : coarsenGrouping(build(cols), cap, groupOf)
  const acc = pixelAccumulator(
    rows,
    cols,
    rowCoarse.grouping,
    colCoarse.grouping,
    plan,
    upperTriangular,
  )
  return {
    place: acc.place,
    finish: () => ({ ...acc.finish(), level }),
    perCell: Math.max(rowCoarse.perCell, colCoarse.perCell),
  }
}

/**
 * The accumulation itself, over groupings the caller chose.
 *
 * Split out from {@link sparseAggregator} because the *arithmetic* — map each
 * stored pixel into a pair of output slots, fold the diagonal once — has nothing
 * to do with what the slots are. Contigs and genomes are two answers (above);
 * runs of `stride` consecutive bins are a third, which is how a block is read at
 * a coarser bin size than the file stores (`metacooler/pooling.ts`).
 *
 * On-diagonal is decided from the extents rather than passed, for the same
 * reason it is there: identical extents mean the block carries both triangles of
 * an upper-triangular store, and summing it without folding double-counts every
 * off-diagonal pixel into the diagonal of the result — where a coarsened map has
 * its largest values, so the error reads as "the diagonal is strong".
 */
export function pixelAccumulator(
  rows: Extent,
  cols: Extent,
  rowGroups: AxisGrouping,
  colGroups: AxisGrouping,
  plan: PlacementMode,
  upperTriangular?: boolean,
): PixelAccumulator<Float64Array>
/**
 * …and the **narrowing** form, for a block whose next stop is the wire.
 *
 * On a folded diagonal — one square axis, one stored triangle — it keeps only
 * the upper triangle, in `Float64`, and finishes straight into the `Float32`
 * square the worker would have narrowed it to anyway. The full-square `Float64`
 * and its `Float32` copy were both alive at the end of a whole-file read:
 * 12 B a cell, 200 MB at the raster's 4,096², which is the allocation a browser
 * refuses first. This is 8 B a cell at the peak — what the contig and genome
 * levels have always cost (`worker/overview.ts`) — so the level that is the
 * default no longer needs more memory than the two beside it.
 *
 * Off the diagonal, or over a square store, nothing is folded and the ordinary
 * `Float64` square comes back, exactly as the other form.
 */
export function pixelAccumulator(
  rows: Extent,
  cols: Extent,
  rowGroups: AxisGrouping,
  colGroups: AxisGrouping,
  plan: PlacementMode,
  upperTriangular: boolean,
  narrow: true,
): PixelAccumulator<Float64Array | Float32Array>
export function pixelAccumulator(
  rows: Extent,
  cols: Extent,
  rowGroups: AxisGrouping,
  colGroups: AxisGrouping,
  plan: PlacementMode,
  upperTriangular = true,
  narrow = false,
): PixelAccumulator<Float64Array | Float32Array> {
  const onDiagonal = rows[0] === cols[0] && rows[1] === cols[1]
  const fold = onDiagonal && upperTriangular

  const nrows = rowGroups.ids.length
  const ncols = colGroups.ids.length
  // The triangle, where the fold makes the lower half a copy of the upper.
  const triangle = narrow && fold && nrows === ncols
  const values = new Float64Array(triangle ? (nrows * (nrows + 1)) / 2 : nrows * ncols)
  const [r0, r1] = rows
  const [c0, c1] = cols
  const placeDirect = plan !== 'transpose'
  // Not simply `plan !== 'direct'`. The flipped placement is what builds the
  // *mirrored dense block*, and on an on-diagonal selection the fold below is
  // what mirrors instead — `aggregateDense` reads only `c >= r` there for
  // exactly this reason. Placing both and folding as well counts every pixel
  // twice, which lands on the diagonal of the result, where a contig-level
  // heatmap has its largest values and an inflated one reads as normal.
  //
  // A *partially* overlapping selection is `symmetric` but not folded, and there
  // both placements are correct, because the dense path sums every cell.
  const placeFlipped = plan !== 'direct' && !fold
  const skipDiagonal = plan === 'symmetric'

  const add = (row: number, col: number, value: number): void => {
    const a = rowGroups.slot[row]
    const b = colGroups.slot[col]
    // A negative slot is a bin the grouping left out — the case a *selection*
    // makes, where most of the file is not on either axis (`selectionPooling`).
    // Dropped here rather than filtered by the caller, so that every grouping
    // this accumulator accepts is one it can be handed pixels for.
    if (a < 0 || b < 0) return
    // Upper-triangular in *group* space too, mirroring `to_upper_triangle`, so
    // the fold below has one triangle to mirror rather than two half-filled ones.
    if (triangle) {
      const lo = a < b ? a : b
      const hi = a < b ? b : a
      values[lo * nrows - (lo * (lo - 1)) / 2 + (hi - lo)] += value
      return
    }
    values[fold && a > b ? b * ncols + a : a * ncols + b] += value
  }

  return {
    place(bin1: number, bin2: number, value: number): void {
      // A NaN is a bin the balancer dropped, not a value; it contributes
      // nothing rather than turning its whole contig NaN.
      if (Number.isNaN(value)) return
      if (placeDirect && bin1 >= r0 && bin1 < r1 && bin2 >= c0 && bin2 < c1) {
        add(bin1 - r0, bin2 - c0, value)
      }
      if (
        placeFlipped &&
        !(skipDiagonal && bin1 === bin2) &&
        bin2 >= r0 &&
        bin2 < r1 &&
        bin1 >= c0 &&
        bin1 < c1
      ) {
        add(bin2 - r0, bin1 - c0, value)
      }
    },
    finish() {
      if (triangle) {
        // Row by row through the triangle, which is the order it is stored in,
        // so the one strided write is the mirror and the reads are sequential.
        const square = new Float32Array(nrows * nrows)
        let at = 0
        for (let a = 0; a < nrows; a++) {
          for (let b = a; b < nrows; b++, at++) {
            const v = values[at]
            square[a * nrows + b] = v
            square[b * nrows + a] = v
          }
        }
        return { nrows, ncols, values: square, rowIds: rowGroups.ids, colIds: colGroups.ids }
      }
      if (fold) {
        for (let a = 0; a < nrows; a++) {
          for (let b = a + 1; b < ncols; b++) values[b * ncols + a] = values[a * ncols + b]
        }
      }
      return { nrows, ncols, values, rowIds: rowGroups.ids, colIds: colGroups.ids }
    },
  }
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

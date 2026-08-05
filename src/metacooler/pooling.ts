/**
 * Reading a block at a **coarser grid** than the file stores.
 *
 * The whole-genome view of a cooler asks for a block whose cell count is the
 * square of the file's bin count, and past about 23,000 bins that block cannot
 * be made at all: its values are one `Float32Array` and a browser serves at most
 * 2 GiB in one (`MAX_DENSE_ARRAY_BYTES`). A whole yeast genome at 500 bp is
 * 24,228 bins and 2.3 GB, and it was offered, computed, and then refused.
 *
 * The picture it was refused for is one nothing could have shown: the renderer
 * draws at most `RASTER_MAX_DIM` pixels per axis, so 24,228 rows were going to be
 * drawn as about 4,000 pixels whatever happened. So the pooling moves to the
 * *read*: sum consecutive bins into one cell, in the worker, from the stored
 * pixels, and the block that arrives is the one that was always going to be
 * drawn — 65 MB instead of 2.3 GB, and no giant allocation to refuse.
 *
 * **One rule carries the whole module: a cell never straddles a contig.** It is
 * either a run of bins inside one sequence, or a run of *whole* sequences — never
 * the tail of one and the head of the next. That is what lets the rest of the app
 * treat the result as data rather than as a picture: a cell of bins has a
 * position inside a sequence, a cell of sequences has a list of names, and both
 * can be labelled, ticked, hovered and exported without a caveat. A straddling
 * cell has none of those things and, drawn, it *invents* contact between two
 * sequences that never touched — the brightest lie a contact map can tell,
 * because it lands on the diagonal where the eye is already looking for signal.
 *
 * The second rule follows from the first: **the grid the reader builds is the
 * grid the renderer draws.** {@link partitionAxis} takes the cap as an input and
 * never exceeds it, so nothing downstream has to pool a second time. It used to
 * aim at the cap and overshoot by up to 1,024 cells, and the renderer then pooled
 * what arrived — flat, contig-blind, two cells to a pixel — which is exactly the
 * straddling the read had just gone to the trouble of avoiding.
 */

import { RASTER_MAX_DIM } from '../render/heatmap'
import type { Coords } from './coords'
import type { AxisGrouping } from './aggregate'

/**
 * Cells per axis a pooled read aims for: exactly what the renderer will draw.
 *
 * `RASTER_MAX_DIM` and not a number of its own, because the raster is the reason
 * this exists. Reading finer than the picture can show costs memory and time to
 * produce values that are pooled again a step later and never seen; reading
 * coarser would throw away detail the screen has room for. At this cap the block
 * is at most 4096² cells — 67 MB of `Float32Array` — however many bins the file
 * has.
 */
export const POOLED_CELL_CAP = RASTER_MAX_DIM

/**
 * How a coarser axis is built out of a finer one.
 *
 * Two numbers rather than one because there are two regimes and they are not the
 * same kind of coarsening. Below the cap a cell is `binsPerCell` bins of one
 * sequence and the axis is still an axis of positions — a coarser *bin* grid, the
 * relationship an `.mcool`'s 5 kb level has to its 1 kb level. Above it, where
 * the sequences alone outnumber the cells the screen has, no bin grid exists that
 * gives each sequence a cell, so a cell becomes `contigsPerCell` whole sequences
 * and the axis is an axis of *names*. The second regime is not a degraded first
 * one: it is the contig-level roll-up the file already has a word for, applied
 * because the picture asked for it rather than because a menu did.
 */
export interface PoolPlan {
  /** Bins of one sequence summed into one cell. `1` is the identity. */
  binsPerCell: number
  /**
   * Whole sequences summed into one cell. `1` is every case with room for one
   * cell per sequence, which is every cooler and most assemblies.
   */
  contigsPerCell: number
}

/** Nothing is coarsened: one cell per bin. */
export const IDENTITY_PLAN: PoolPlan = { binsPerCell: 1, contigsPerCell: 1 }

/**
 * The coarsest axis that still fits in `cap` cells, from the two numbers a
 * caller has before it has read anything.
 *
 * It has to be computable twice and agree: once by the view, which labels the
 * axis in the matching units, and once by the read, which sums into them. Bin
 * count and sequence count are what both sides hold after `open`, so the plan is
 * a function of those and the cap, and the *exact* cell count — which depends on
 * where the sequences fall — is reported back by the read rather than predicted.
 *
 * The bound that makes it safe: an axis of `k` sequences and `n` bins at
 * `binsPerCell = u` comes to `Σ ceil(lengthᵢ / u)` cells, which is at most
 * `n/u + k`. Asking for that to be at most `cap` gives `u ≥ n / (cap − k)`, and
 * so a plan that fits *whatever* the sequence lengths are. Where `k` alone
 * reaches the cap there is no such `u` — the sum can never fall below `k` — and
 * the axis switches to whole sequences per cell.
 */
export function poolPlan(nBins: number, nContigs: number, cap = POOLED_CELL_CAP): PoolPlan {
  const bins = Math.max(0, Math.trunc(nBins))
  const contigs = Math.max(1, Math.trunc(nContigs))
  if (cap <= 0 || bins <= cap) return IDENTITY_PLAN
  if (contigs >= cap) {
    return { binsPerCell: 1, contigsPerCell: Math.max(2, Math.ceil(contigs / cap)) }
  }
  return { binsPerCell: Math.max(2, Math.ceil(bins / (cap - contigs))), contigsPerCell: 1 }
}

/** Whether a plan groups whole sequences rather than bins within one. */
export function groupsContigs(plan: PoolPlan): boolean {
  return plan.contigsPerCell > 1
}

/** One axis of a pooled read: which cell each bin falls into, and what it is. */
export interface BinPooling extends AxisGrouping {
  /** Contig id of every output cell — one entry per cell, for the axis runs. */
  ids: Int32Array
  /** Bins summed into one cell. `1` is the identity, and is not pooling. */
  stride: number
  /** Whole sequences summed into one cell. `1` is the ordinary case. */
  contigsPerCell: number
  /** First input index of every cell, `cells + 1` long. */
  cellStart: Int32Array
}

/**
 * A partition of `[0, n)` into at most `cap` cells, none of which straddles a
 * boundary.
 *
 * The one piece of arithmetic behind every grid in the app. It is used twice
 * over, on two different axes of the same idea: the reader partitions *bins*
 * whose boundaries are contig starts, and the renderer partitions *cells* whose
 * boundaries are the separators it is about to draw. Both want the same
 * guarantee, and a guarantee stated once is a guarantee that cannot hold in one
 * place and lapse in the other — which is precisely what happened when the two
 * were written separately.
 *
 * @param starts Ascending indices at which a new segment begins, `starts[0] === 0`.
 *   Empty is read as one segment covering everything.
 * @param cap The most cells the result may have. Never exceeded.
 * @param floor The coarsest grid a caller has already committed to — a view that
 *   has labelled its axis at 6 kb per cell must not be handed 3 kb cells. Only
 *   ever coarsens the answer; the cap still binds above it.
 * @param segmentGroup Coarser structure over the segments — the genome each
 *   contig belongs to. Where cells hold whole contigs, a cell is kept inside one
 *   genome, which is the one distinction the whole application exists to draw: a
 *   cell mixing intra-genome contacts with inter-genome ones collapses it. The
 *   same rule `worker/overview.ts` already applies to its slots, for the same
 *   reason, and for the further one that a cell belonging to exactly one genome
 *   is a cell that can be clicked through to that genome. Given up only where
 *   the genomes themselves outnumber the cells, which is its own signal that the
 *   axis should be genomes.
 */
export function partitionAxis(
  n: number,
  starts: ArrayLike<number>,
  cap: number,
  floor: PoolPlan = IDENTITY_PLAN,
  segmentGroup?: ArrayLike<number>,
): { slot: Int32Array; cellStart: Int32Array; cells: number; plan: PoolPlan } {
  const count = Math.max(0, Math.trunc(n))
  if (count === 0) {
    return { slot: new Int32Array(0), cellStart: new Int32Array(1), cells: 0, plan: IDENTITY_PLAN }
  }
  const segments = starts.length > 0 ? starts.length : 1
  const limit = Math.max(1, Math.trunc(cap))
  const at = (i: number): number => (starts.length > 0 ? starts[i] : 0)
  const lengthOf = (i: number): number => (i + 1 < segments ? at(i + 1) : count) - at(i)

  // No stride gives every segment a cell — a sum of `ceil`s can never fall below
  // the number of segments — so past the cap a cell holds whole segments. The
  // caller may already have said so, in which case its number is the floor.
  if (floor.contigsPerCell > 1 || segments > limit) {
    const group = Math.max(
      floor.contigsPerCell,
      smallestGroup(segments, limit, segmentGroup),
    )
    if (group > 1) return build(count, segments, at, lengthOf, 1, group, segmentGroup)
  }
  const stride = Math.max(floor.binsPerCell, smallestStride(segments, lengthOf, limit))
  return build(count, segments, at, lengthOf, stride, 1)
}

/**
 * The smallest `u` for which `Σ ceil(lengthᵢ / u)` fits the cap.
 *
 * {@link poolPlan}'s closed form is an upper bound over *any* set of lengths, and
 * a bound is what a caller who has not read the file needs. Here the lengths are
 * in hand, so the exact minimum is one binary search away — a dozen passes over
 * at most `cap` segments — and taking it is worth the twenty lines: rounding a
 * stride of 7 up to 8 throws away an eighth of the resolution the screen was
 * going to show, for nothing.
 */
function smallestStride(
  segments: number,
  lengthOf: (i: number) => number,
  cap: number,
): number {
  const cells = (stride: number): number => {
    let sum = 0
    for (let i = 0; i < segments; i++) sum += Math.ceil(lengthOf(i) / stride)
    return sum
  }
  let low = 1
  let high = 1
  // Double until it fits. It always does: at a stride of `n` every segment is
  // one cell, and `segments < cap` is the branch that got here.
  while (cells(high) > cap) high *= 2
  while (low < high) {
    const mid = (low + high) >> 1
    if (cells(mid) <= cap) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * The smallest number of whole segments per cell that fits the cap.
 *
 * With no coarser structure it is `ceil(segments / cap)` and nothing more. With
 * one, a cell also ends wherever the group does, so a group with an awkward
 * remainder costs a cell — and the sum of those remainders is what the search is
 * for. `segments` itself is always a valid answer *provided* the groups
 * themselves fit; where they do not, snapping is impossible and the caller is
 * told by getting an unsnapped answer rather than an impossible one.
 */
function smallestGroup(
  segments: number,
  cap: number,
  segmentGroup?: ArrayLike<number>,
): number {
  const flat = Math.max(1, Math.ceil(segments / cap))
  if (segmentGroup === undefined) return flat
  const cells = (group: number): number => {
    let count = 0
    let taken = 0
    for (let s = 0; s < segments; s++) {
      if (s === 0 || segmentGroup[s] !== segmentGroup[s - 1] || taken >= group) {
        count++
        taken = 0
      }
      taken++
    }
    return count
  }
  if (cells(segments) > cap) return flat
  let low = flat
  let high = segments
  while (low < high) {
    const mid = (low + high) >> 1
    if (cells(mid) <= cap) high = mid
    else low = mid + 1
  }
  return low
}

/** Lay the cells out, given the regime chosen above. */
function build(
  n: number,
  segments: number,
  at: (i: number) => number,
  lengthOf: (i: number) => number,
  binsPerCell: number,
  contigsPerCell: number,
  segmentGroup?: ArrayLike<number>,
): { slot: Int32Array; cellStart: Int32Array; cells: number; plan: PoolPlan } {
  const slot = new Int32Array(n)
  const cellStart: number[] = []
  let cells = 0
  if (contigsPerCell > 1) {
    let taken = 0
    for (let s = 0; s < segments; s++) {
      const breaks =
        s === 0 ||
        taken >= contigsPerCell ||
        (segmentGroup !== undefined && segmentGroup[s] !== segmentGroup[s - 1])
      if (breaks) {
        cellStart.push(at(s))
        cells++
        taken = 0
      }
      taken++
      const end = at(s) + lengthOf(s)
      for (let i = at(s); i < end; i++) slot[i] = cells - 1
    }
  } else {
    for (let s = 0; s < segments; s++) {
      const from = at(s)
      const end = from + lengthOf(s)
      for (let i = from; i < end; i++) {
        // A new segment, or `binsPerCell` in: either way the next index opens a
        // cell. The first index of a segment always does.
        if ((i - from) % binsPerCell === 0) {
          cellStart.push(i)
          cells++
        }
        slot[i] = cells - 1
      }
    }
  }
  cellStart.push(n)
  return {
    slot,
    cellStart: Int32Array.from(cellStart),
    cells,
    plan: { binsPerCell, contigsPerCell },
  }
}

/** Indices at which a new run begins, for {@link partitionAxis}. */
export function runStarts(ids: ArrayLike<number>): Int32Array {
  const out: number[] = []
  for (let i = 0; i < ids.length; i++) {
    if (i === 0 || ids[i] !== ids[i - 1]) out.push(i)
  }
  return Int32Array.from(out)
}

/**
 * Assign every bin in `[lo, hi)` to a pooled cell, within `cap` cells and never
 * across a contig.
 *
 * The plan is derived from the range itself rather than taken from the caller:
 * the caller works from the file's totals and cannot know how the sequences fall
 * inside the range it asked for, and a cell count that overshoots by even one is
 * a second pooling downstream. What the caller *chose* is honoured as a floor —
 * a view that has already labelled its axis at 6 kb is not handed 3 kb cells —
 * and the plan actually used is reported back.
 */
export function poolBins(
  coords: Coords,
  lo: number,
  hi: number,
  aim: PoolPlan = IDENTITY_PLAN,
  cap = POOLED_CELL_CAP,
  contigGenomeIds?: ArrayLike<number>,
): BinPooling {
  const count = Math.max(0, hi - lo)
  if (count === 0) {
    return {
      slot: new Int32Array(0),
      ids: new Int32Array(0),
      stride: 1,
      contigsPerCell: 1,
      cellStart: new Int32Array(1),
    }
  }
  const contigs = coords.contigsOfBins(lo, hi)
  const starts = runStarts(contigs)
  const genomes =
    contigGenomeIds === undefined || contigGenomeIds.length === 0
      ? undefined
      : Int32Array.from(starts, (start) => contigGenomeIds[contigs[start]] ?? -1)
  const part = partitionAxis(count, starts, cap, aim, genomes)
  const ids = new Int32Array(part.cells)
  for (let c = 0; c < part.cells; c++) ids[c] = contigs[part.cellStart[c]]
  return {
    slot: part.slot,
    ids,
    stride: part.plan.binsPerCell,
    contigsPerCell: part.plan.contigsPerCell,
    cellStart: part.cellStart,
  }
}

/**
 * The same grid over a **chosen set of contigs**, and nothing else.
 *
 * A reader who ticks four MAGs out of two thousand is asking for one picture of
 * those four — their own maps on the diagonal and everything between them off
 * it — and that picture is not a range of bins: the four are scattered through
 * the file. So the axis is built from the selection rather than from an extent,
 * in the order given, and every bin that is not in it maps to `-1`, which
 * `pixelAccumulator` drops.
 *
 * The two regimes are the range's exactly: bins of one sequence per cell while
 * there is room, whole sequences per cell when the selection has more sequences
 * than the picture has pixels. The second is why a selection of six thousand
 * contigs is a picture now rather than a refusal.
 *
 * @param extents Bin range of each selected contig, in the order to display
 *   them. Whoever chose the order is the caller: the tables sort, and a picture
 *   that reordered the selection behind them would be answering a different
 *   question.
 */
export function selectionPooling(
  nBins: number,
  extents: ReadonlyArray<{ id: number; extent: readonly [number, number] }>,
  plan: PoolPlan,
): BinPooling {
  const slot = new Int32Array(nBins).fill(-1)
  const ids: number[] = []
  const cellStart: number[] = []
  const step = Math.max(1, Math.trunc(plan.binsPerCell))
  const group = Math.max(1, Math.trunc(plan.contigsPerCell))
  let placed = 0
  for (let u = 0; u < extents.length; u++) {
    const { id, extent } = extents[u]
    const [lo, hi] = extent
    for (let bin = lo; bin < hi; bin++) {
      // A fresh cell at each group of sequences, or at each sequence and every
      // `step` bins after it — the same two regimes as a range, applied per
      // selected piece.
      const opens = group > 1 ? u % group === 0 && bin === lo : (bin - lo) % step === 0
      if (opens) {
        ids.push(id)
        cellStart.push(placed)
      }
      slot[bin] = ids.length - 1
      placed++
    }
  }
  cellStart.push(placed)
  return {
    slot,
    ids: Int32Array.from(ids),
    stride: step,
    contigsPerCell: group,
    cellStart: Int32Array.from(cellStart),
  }
}

/**
 * The plan a selection needs: its own bin and sequence counts against the cap.
 *
 * Not the file's — four MAGs of a metagenome are a small picture however large
 * the file is, and pooling them by the file's plan would throw away the detail
 * the selection was made to look at.
 */
export function selectionPlan(bins: number, contigs: number, cap = POOLED_CELL_CAP): PoolPlan {
  return poolPlan(bins, contigs, cap)
}

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
 * **A cell holds at most `binsPerCell` bins, and never part of one sequence
 * beside anything else.** One rule, and everything follows from it: a sequence
 * longer than the capacity keeps cells of its own, cut at its own start, so the
 * axis is still an axis of positions and a coarser *bin* grid — the relationship
 * an `.mcool`'s 5 kb level has to its 1 kb level. A sequence too small to fill a
 * cell shares one with its neighbours, because an assembly of six thousand
 * contigs cannot give each of them a pixel that does not exist.
 *
 * It used to be two rules, and the second was wrong: past the point where the
 * sequences outnumbered the cells, *every* cell took a fixed number of whole
 * sequences — so a contig of four bins was crushed into half a cell beside a
 * contig of one, while the picture had room to draw all four. Capacity gives the
 * large ones their cells back and merges only what has to merge.
 */
export interface PoolPlan {
  /** The most bins one cell holds. `1` is the identity. */
  binsPerCell: number
  /**
   * The most whole sequences any one cell ended up holding; `1` when none share.
   *
   * A property of the answer rather than of the question — which sequences are
   * small enough to share depends on where they fall — so it is reported by the
   * read and never asked for.
   */
  contigsPerCell: number
}

/** Nothing is coarsened: one cell per bin. */
export const IDENTITY_PLAN: PoolPlan = { binsPerCell: 1, contigsPerCell: 1 }

/**
 * The coarsest axis that still fits in `cap` cells, from the one number a caller
 * has before it has read anything.
 *
 * A bound, not the answer. The exact capacity depends on how the sequences fall
 * — which of them are small enough to share a cell — and only the reader knows
 * that, so it searches ({@link partitionAxis}) and reports what it used. This is
 * for the view that has to name a resolution *before* the read returns, and the
 * reader only ever coarsens from here.
 *
 * The sequence count is taken and not used. It was the second half of a bound
 * over the old two-regime rule, where every sequence started a cell of its own
 * and the leftovers had to be budgeted for; under a capacity they do not, and
 * the parameter stays only because every caller passes it and dropping it from
 * four call sites would say less than this paragraph does.
 */
export function poolPlan(nBins: number, _nContigs: number, cap = POOLED_CELL_CAP): PoolPlan {
  const bins = Math.max(0, Math.trunc(nBins))
  if (cap <= 0 || bins <= cap) return IDENTITY_PLAN
  return { binsPerCell: Math.max(2, Math.ceil(bins / cap)), contigsPerCell: 1 }
}

/** Whether any cell of a plan ended up holding more than one whole sequence. */
export function groupsContigs(plan: PoolPlan): boolean {
  return plan.contigsPerCell > 1
}

/** A partition of an axis into cells that never split a sequence. */
export interface AxisPartition {
  /** Output cell of every input index. */
  slot: Int32Array
  /** First input index of every cell, `cells + 1` long. */
  cellStart: Int32Array
  /** How many whole sequences each cell holds; `1` unless small ones shared it. */
  cellSegments: Int32Array
  cells: number
  plan: PoolPlan
}

/** One axis of a pooled read: which cell each bin falls into, and what it is. */
export interface BinPooling extends AxisGrouping {
  /** Contig id of every output cell — one entry per cell, for the axis runs. */
  ids: Int32Array
  /** Bins summed into one cell. `1` is the identity, and is not pooling. */
  stride: number
  /** The most whole sequences any one cell holds; `1` when none share. */
  contigsPerCell: number
  /** First input index of every cell, `cells + 1` long. */
  cellStart: Int32Array
  /**
   * Every sequence in every cell, flat, indexed by {@link memberStart}.
   *
   * A cell that holds one is the ordinary case and the list repeats {@link ids}.
   * A cell that holds several is the reason this exists: the axis is labelled
   * with the first of them, and the readout, the sequence list and anything else
   * that asks "what is under this pixel" needs the rest.
   */
  members: Int32Array
  /** Where each cell's sequences begin in {@link members}, `cells + 1` long. */
  memberStart: Int32Array
  /** Bins the axis covers, where it is a selection rather than a range. */
  bins?: number
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
): AxisPartition {
  const count = Math.max(0, Math.trunc(n))
  if (count === 0) {
    return {
      slot: new Int32Array(0),
      cellStart: new Int32Array(1),
      cellSegments: new Int32Array(0),
      cells: 0,
      plan: IDENTITY_PLAN,
    }
  }
  const segments = starts.length > 0 ? starts.length : 1
  const limit = Math.max(1, Math.trunc(cap))
  const at = (i: number): number => (starts.length > 0 ? starts[i] : 0)
  const lengthOf = (i: number): number => (i + 1 < segments ? at(i + 1) : count) - at(i)
  const capacity = Math.max(
    floor.binsPerCell,
    smallestCapacity(segments, lengthOf, limit, segmentGroup),
  )
  return build(count, segments, at, lengthOf, capacity, segmentGroup)
}

/** Cells a capacity comes to, without laying them out. */
function packCount(
  segments: number,
  lengthOf: (i: number) => number,
  capacity: number,
  groupOf?: ArrayLike<number>,
): number {
  let cells = 0
  let open = 0
  let openGroup = -1
  for (let s = 0; s < segments; s++) {
    const length = lengthOf(s)
    if (length >= capacity) {
      cells += Math.ceil(length / capacity)
      open = 0
      openGroup = -1
      continue
    }
    const group = groupOf === undefined ? 0 : groupOf[s]
    if (open === 0 || open + length > capacity || group !== openGroup) {
      cells++
      open = length
      openGroup = group
    } else {
      open += length
    }
  }
  return cells
}

/**
 * The smallest capacity that fits the cap, and whether the genomes survive it.
 *
 * A cell may not span two genomes while there is room for that; where the
 * genomes themselves outnumber the cells there is no capacity at which it can
 * hold, and the constraint is dropped rather than the picture refused. Same
 * escape `worker/overview.ts` takes, for the same reason.
 */
function smallestCapacity(
  segments: number,
  lengthOf: (i: number) => number,
  cap: number,
  groupOf?: ArrayLike<number>,
): number {
  let groups = groupOf
  const fits = (capacity: number): boolean => packCount(segments, lengthOf, capacity, groups) <= cap
  let high = 1
  while (!fits(high)) {
    if (high >= Number.MAX_SAFE_INTEGER / 2) {
      if (groups === undefined) return high
      // Even one cell per genome is more than the picture holds. Give the
      // boundaries up rather than the picture.
      groups = undefined
      high = 1
    } else {
      high *= 2
    }
  }
  let low = 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (fits(mid)) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * Lay the cells out: at most `capacity` bins each, and never part of one
 * sequence beside anything else.
 *
 * One rule where there used to be two, and the second one was wrong. A cell used
 * to hold either `k` bins of one sequence *or* a fixed number of whole ones, and
 * an axis with more sequences than cells took the second — uniformly, so a
 * sequence of four bins was crushed into half a cell beside a sequence of one
 * while the picture had room to draw it. Capacity says it once: a sequence longer
 * than the capacity keeps cells of its own, cut at its own start, and only the
 * ones too small to fill a cell share.
 */
function build(
  n: number,
  segments: number,
  at: (i: number) => number,
  lengthOf: (i: number) => number,
  capacity: number,
  groupOf?: ArrayLike<number>,
): AxisPartition {
  const slot = new Int32Array(n)
  const cellStart: number[] = []
  const cellSegments: number[] = []
  let cells = 0
  let open = 0
  let openGroup = -1
  for (let s = 0; s < segments; s++) {
    const from = at(s)
    const length = lengthOf(s)
    const end = from + length
    if (length >= capacity) {
      // Its own cells, cut from its own start, so the grid is anchored to the
      // sequence exactly as it is when nothing shares.
      open = 0
      openGroup = -1
      for (let i = from; i < end; i++) {
        if ((i - from) % capacity === 0) {
          cellStart.push(i)
          cellSegments.push(1)
          cells++
        }
        slot[i] = cells - 1
      }
      continue
    }
    const group = groupOf === undefined ? 0 : groupOf[s]
    if (open === 0 || open + length > capacity || group !== openGroup) {
      cellStart.push(from)
      cellSegments.push(1)
      cells++
      open = length
      openGroup = group
    } else {
      open += length
      cellSegments[cells - 1]++
    }
    for (let i = from; i < end; i++) slot[i] = cells - 1
  }
  cellStart.push(n)
  let widest = 1
  for (const held of cellSegments) widest = Math.max(widest, held)
  return {
    slot,
    cellStart: Int32Array.from(cellStart),
    cellSegments: Int32Array.from(cellSegments),
    cells,
    plan: { binsPerCell: capacity, contigsPerCell: widest },
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
      members: new Int32Array(0),
      memberStart: new Int32Array(1),
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
  const members: number[] = []
  const memberStart = new Int32Array(part.cells + 1)
  for (let c = 0; c < part.cells; c++) {
    memberStart[c] = members.length
    const from = part.cellStart[c]
    const to = part.cellStart[c + 1]
    ids[c] = contigs[from]
    for (let i = from; i < to; i++) {
      if (i === from || contigs[i] !== contigs[i - 1]) members.push(contigs[i])
    }
  }
  memberStart[part.cells] = members.length
  return {
    slot: part.slot,
    ids,
    stride: part.plan.binsPerCell,
    contigsPerCell: part.plan.contigsPerCell,
    cellStart: part.cellStart,
    members: Int32Array.from(members),
    memberStart,
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
  cap = POOLED_CELL_CAP,
): BinPooling {
  const lengths = extents.map(({ extent }) => Math.max(0, extent[1] - extent[0]))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const capacity = Math.max(
    plan.binsPerCell,
    smallestCapacity(lengths.length, (i) => lengths[i], Math.max(1, Math.trunc(cap))),
  )

  const slot = new Int32Array(nBins).fill(-1)
  const ids: number[] = []
  const cellStart: number[] = []
  const members: number[] = []
  const memberStart: number[] = []
  let placed = 0
  let open = 0
  let widest = 1
  let held = 0
  for (let u = 0; u < extents.length; u++) {
    const { id, extent } = extents[u]
    const [lo, hi] = extent
    const length = lengths[u]
    if (length === 0) continue
    // The range's rule, applied to a scattered set: a sequence longer than the
    // capacity keeps cells of its own, cut at its own start; one too small to
    // fill a cell joins the one before it. A selection is exactly the axis a
    // uniform *count* of sequences per cell got wrong — tick two thousand of
    // them and the large ones would be crushed beside the small.
    const ownCells = length >= capacity
    for (let bin = lo; bin < hi; bin++) {
      const offset = bin - lo
      const opens = ownCells
        ? offset % capacity === 0
        : offset === 0 && (open === 0 || open + length > capacity)
      if (opens) {
        ids.push(id)
        cellStart.push(placed)
        memberStart.push(members.length)
        members.push(id)
        open = 0
        held = 0
      } else if (offset === 0) {
        // Joined the open cell: it is a second sequence in it, not a second cell.
        members.push(id)
      }
      slot[bin] = ids.length - 1
      placed++
    }
    if (ownCells) {
      open = 0
      held = 0
    } else {
      open += length
      held++
      widest = Math.max(widest, held)
    }
  }
  cellStart.push(placed)
  memberStart.push(members.length)
  return {
    slot,
    ids: Int32Array.from(ids),
    stride: capacity,
    contigsPerCell: widest,
    cellStart: Int32Array.from(cellStart),
    members: Int32Array.from(members),
    memberStart: Int32Array.from(memberStart),
    bins: total,
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

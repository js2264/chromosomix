/**
 * A block laid out in the reader's order (§7.6): whole genomes moved, and whole
 * contigs moved within their genome, with nothing read again.
 *
 * Every square map of a metagenome is read in the file's order — genome then
 * length (C4) — and every one of them is made of **runs**: an axis is cut into
 * contig runs, and on a block of several genomes those sit under genome runs.
 * Nothing downstream asks where a run is in the file. The labels, the dividers,
 * the readout, the lanes along the axes, a click and a box all resolve through
 * the run they are in (`ui/blockAxes.ts`, `render/locus.ts`), and an O/E
 * measures distance only within one run — so moving whole runs, and shifting
 * each run's arithmetic origin with it, is a picture in another order that
 * still says the right thing everywhere.
 *
 * What it cannot do is cut inside a run. A cell that holds several small
 * contigs (`merged`, or a pooled slot of the whole metagenome, `NODE_7431 +15`)
 * moves as one, with the first of them the reader placed; a slot of several
 * genomes, where a file has more genomes than the picture has cells, moves with
 * its first genome.
 *
 * Never in place: the block it is handed may be the reader's cache's own
 * (`worker/answers.ts`), and the panel keeps it as read for the tasks, which
 * index it by absolute bin (`MatrixPanel.analysisBlock`).
 */

import type { OrderRanks } from '../state/readerOrder'
import type { AxisGroup, MatrixResult } from '../worker/protocol'

/** The genome each axis is, where a block carries no genome runs over it: one genome's map, a pair's two. */
export interface AxisGenomes {
  rows?: string
  cols?: string
}

/**
 * The largest block reordered, in cells: past it the file's order is drawn
 * rather than a second copy of a quarter-gigabyte held beside the first.
 */
export const ORDER_COPY_CELLS = 64 * 1024 * 1024

/** One axis rearranged: where each new cell came from, and the runs over the new axis. */
interface AxisMove {
  /** New cell → the cell it was. */
  from: Int32Array
  groups: AxisGroup[]
  genomes: AxisGroup[] | undefined
}

/**
 * The block in the reader's order — the same object where nothing moves, so a
 * caller can tell a reordered block by identity.
 */
export function orderBlock(block: MatrixResult, ranks: OrderRanks, axes: AxisGenomes = {}): MatrixResult {
  if (block.wrapped !== undefined) return block
  if (block.nrows * block.ncols > ORDER_COPY_CELLS) return block
  const rows = axisMove(block.rowGroups, block.rowGenomes, block.level, block.nrows, ranks, axes.rows)
  // A square block's two axes are the same runs, and moved the same way.
  const square =
    block.rowGroups === block.colGroups ||
    (block.nrows === block.ncols &&
      block.rowExtent[0] === block.colExtent[0] &&
      block.rowExtent[1] === block.colExtent[1] &&
      axes.rows === axes.cols)
  const cols = square ? rows : axisMove(block.colGroups, block.colGenomes, block.level, block.ncols, ranks, axes.cols)
  if (rows === null && cols === null) return block
  const values = moveValues(block.values, block.nrows, block.ncols, rows?.from ?? null, cols?.from ?? null)
  return {
    ...block,
    values,
    rowGroups: rows?.groups ?? block.rowGroups,
    colGroups: cols?.groups ?? block.colGroups,
    ...(block.rowGenomes === undefined ? {} : { rowGenomes: rows?.genomes ?? block.rowGenomes }),
    ...(block.colGenomes === undefined ? {} : { colGenomes: cols?.genomes ?? block.colGenomes }),
  }
}

/** A stretch of the axis that moves as one: a genome, with the runs inside it. */
interface Segment {
  genome: string | undefined
  /** The genome run over it, where the block has them. */
  run: AxisGroup | undefined
  runs: AxisGroup[]
  index: number
}

/**
 * How one axis moves, or `null` where it does not — no rank changes anything,
 * or the runs do not tile the axis, which is no axis this knows how to cut.
 */
function axisMove(
  groups: readonly AxisGroup[],
  genomeRuns: readonly AxisGroup[] | undefined,
  level: MatrixResult['level'],
  n: number,
  ranks: OrderRanks,
  axisGenome: string | undefined,
): AxisMove | null {
  if (groups.length === 0 || !tiles(groups, n)) return null
  const segments = segmentsOf(groups, genomeRuns, level, axisGenome)
  const ordered = [...segments].sort(
    (a, b) => rank(ranks.genomeRank(a.genome ?? '')) - rank(ranks.genomeRank(b.genome ?? '')) || a.index - b.index,
  )
  let moved = ordered.some((segment, i) => segment !== segments[i])
  for (const segment of ordered) {
    const contigs = segment.genome === undefined ? undefined : ranks.contigRanks(segment.genome)
    if (contigs === undefined || segment.runs.length < 2) continue
    const before = segment.runs
    const after = before
      .map((run, index) => ({ run, index, rank: runRank(run, contigs) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.run)
    if (after.some((run, i) => run !== before[i])) {
      segment.runs = after
      moved = true
    }
  }
  if (!moved) return null

  const from = new Int32Array(n)
  const out: AxisGroup[] = []
  const outGenomes: AxisGroup[] = []
  let at = 0
  for (const segment of ordered) {
    const segmentStart = at
    for (const run of segment.runs) {
      const length = run.end - run.start
      for (let k = 0; k < length; k++) from[at + k] = run.start + k
      out.push(shifted(run, at - run.start))
      at += length
    }
    if (segment.run !== undefined) {
      outGenomes.push({ ...shifted(segment.run, segmentStart - segment.run.start), end: at })
    }
  }
  return { from, groups: out, genomes: genomeRuns === undefined ? undefined : outGenomes }
}

/** Whether the runs cover the axis end to end, in order, without a gap. */
function tiles(groups: readonly AxisGroup[], n: number): boolean {
  let at = 0
  for (const group of groups) {
    if (group.start !== at || group.end <= group.start) return false
    at = group.end
  }
  return at === n
}

/**
 * The axis cut into what moves together.
 *
 * - A genome × genome axis: every run is a genome — or a slot of several,
 *   moved with its first — and is its own segment.
 * - An axis with genome runs: each genome is a segment of the contig runs that
 *   start inside it. A run that starts in none (no genome-run block has one,
 *   but an axis is only as tidy as its reader) is a segment of its own, kept
 *   where it was among the others.
 * - Any other axis is one genome's, or nobody's: one segment, its contigs
 *   moved within it where the view says which genome it is.
 */
function segmentsOf(
  groups: readonly AxisGroup[],
  genomeRuns: readonly AxisGroup[] | undefined,
  level: MatrixResult['level'],
  axisGenome: string | undefined,
): Segment[] {
  if (level === 'genome' && genomeRuns === undefined) {
    return groups.map((group, index) => ({ genome: group.name ?? group.label, run: undefined, runs: [group], index }))
  }
  if (genomeRuns === undefined || genomeRuns.length === 0) {
    return [{ genome: axisGenome, run: undefined, runs: [...groups], index: 0 }]
  }
  const segments: Segment[] = []
  let current: Segment | null = null
  for (const group of groups) {
    const run = genomeRuns.find((candidate) => group.start >= candidate.start && group.start < candidate.end)
    if (current !== null && current.run === run && run !== undefined) {
      current.runs.push(group)
      continue
    }
    current = { genome: run?.label, run, runs: [group], index: segments.length }
    segments.push(current)
  }
  return segments
}

/** A run's place among its genome's contigs: the earliest the reader gave any contig in it. */
function runRank(run: AxisGroup, contigs: ReadonlyMap<string, number>): number {
  if (run.merged !== undefined && run.merged.length > 0) {
    let best = Number.POSITIVE_INFINITY
    for (const member of run.merged) best = Math.min(best, rank(contigs.get(member.label)))
    return best
  }
  return rank(contigs.get(run.name ?? run.label))
}

function rank(value: number | undefined): number {
  return value === undefined ? Number.POSITIVE_INFINITY : value
}

/**
 * A run moved by `delta` cells, its arithmetic origin with it: a position in
 * its contig is `(extent start + offset − unitStart) × bin size`, so the origin
 * shifts as the offset does and every base pair it names stays put. Its
 * identity, `unitBin`, does not move.
 */
function shifted(run: AxisGroup, delta: number): AxisGroup {
  if (delta === 0) return run
  return {
    ...run,
    start: run.start + delta,
    end: run.end + delta,
    ...(run.unitStart === undefined ? {} : { unitStart: run.unitStart + delta }),
  }
}

/** The values with rows and columns taken from where they were, a column stretch at a time. */
function moveValues(
  values: Float32Array,
  nrows: number,
  ncols: number,
  rowsFrom: Int32Array | null,
  colsFrom: Int32Array | null,
): Float32Array {
  const out = new Float32Array(nrows * ncols)
  const stretches = colsFrom === null ? [[0, 0, ncols]] : stretchesOf(colsFrom)
  for (let r = 0; r < nrows; r++) {
    const source = (rowsFrom === null ? r : rowsFrom[r]) * ncols
    const target = r * ncols
    for (const [to, fromCol, length] of stretches) {
      out.set(values.subarray(source + fromCol, source + fromCol + length), target + to)
    }
  }
  return out
}

/** Consecutive columns that came from consecutive columns: `[to, from, length]`. */
function stretchesOf(from: Int32Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  let start = 0
  for (let i = 1; i <= from.length; i++) {
    if (i < from.length && from[i] === from[i - 1] + 1) continue
    out.push([start, from[start], i - start])
    start = i
  }
  return out
}

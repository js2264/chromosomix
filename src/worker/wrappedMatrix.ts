/**
 * Reading a block of a circular sequence, across its own junction.
 *
 * The other half of `worker/wrap.ts`: that module says which stored pieces an
 * unwrapped window covers, and this one reads them and lays them out as one
 * block. It is here rather than in `reader.worker.ts` because it is the piece
 * worth testing — the assembly, the grid, and the axis runs that tell
 * `render/locus.ts` which lap each stretch belongs to — and a worker entry point
 * cannot be imported by a test: it touches `self` at module scope.
 *
 * What it needs of the world is {@link WrapEnv}, which is three decisions the
 * reader worker already makes for every other read and must go on making in one
 * place: what grid a window of this width is worth reading at, where that grid's
 * cells fall, and whether the reader has cancelled.
 */

import { ViewerError } from '../errors'
import type { MetaCooler } from '../metacooler/MetaCooler'
import type { PoolPlan } from '../metacooler/pooling'
import type { Extent } from '../types'
import type { AxisGroup, MatrixResult, WorkerRequest } from './protocol'
import { stitch, wrapPieces, wrapUnitStarts, type Sub } from './wrap'

/** What a wrapped read needs of the worker around it. */
export interface WrapEnv {
  /**
   * The grid a window this wide on this sequence is worth reading at, or `null`
   * for the file's own bins.
   *
   * The worker's own `fitPlan`, asked about a window of the given width *inside*
   * the sequence — a wrapped window has the same cell count as an unwrapped one
   * of the same width on the same sequence, and asking about the unwrapped
   * extent would walk off the end of the contig table.
   */
  planFor(wrap: Extent, rowWidth: number, colWidth: number): PoolPlan | null
  /** The worker's own `snapToGrid`: an extent widened to the contig's cell edges. */
  snap(extent: Extent, plan: PoolPlan): Extent
  /** The hint a dense read of this shape would carry, for a refusal's message. */
  hint(rows: Extent, cols: Extent): string
  /** Raises if the reader has called the run off; checked between sub-reads. */
  throwIfCancelled(): void
  /** Progress hooks for a pooled sub-read, where the worker has any. */
  hooks?: Parameters<MetaCooler['pooledMatrix']>[2]
}

/**
 * A block of a circular sequence, read across its junction.
 *
 * The request's extents are *unwrapped* — see `worker/wrap.ts` — so each axis is
 * one or two stored runs, and the block is the outer product of them: up to four
 * reads, one of which is the far corner of the contig's own square, where the
 * contacts joining the end of the circle to its beginning are stored.
 *
 * ## The grid is chosen once, for the whole window
 *
 * Everything in `ui/refine.ts` rests on two blocks of the same place agreeing
 * cell for cell, and that holds here for the reason it holds everywhere else:
 * {@link snapToGrid} anchors the grid to the **sequence** rather than to the
 * request. So the plan is fitted once against the whole window and every piece
 * is read with it, which is what makes the two halves of a junction-crossing
 * block halves of one picture rather than two pictures with a seam.
 *
 * One artefact survives, and it is honest: where the sequence's length is not a
 * whole number of cells, the cell at the junction is short. That is the same
 * partial last cell every pooled view of every chromosome already ends with —
 * what circularity does is move it into the middle of the picture instead of
 * leaving it at the edge.
 *
 * ## What the block says about itself
 *
 * `rowExtent` and `colExtent` are the **unwrapped** extents, which is what the
 * view pans in and what `ui/refine.ts` reasons about; `wrapped` says so. The axis
 * runs carry a `unitStart` shifted one lap per revolution, which is what makes
 * `render/locus.ts` read the second stretch as the beginning of the sequence
 * rather than as somewhere past its end — so ticks, tooltips, tracks and
 * annotations all place themselves correctly across the join with no knowledge
 * of any of this.
 */
export async function readWrapped(
  mc: MetaCooler,
  request: Extract<WorkerRequest, { kind: 'matrix' }>,
  rows: Extent,
  cols: Extent,
  wrap: Extent,
  env: WrapEnv,
): Promise<MatrixResult> {
  // One contig, by construction: a circular sequence is a sequence, and the flag
  // is set against one. Checked rather than assumed, because everything below
  // reads a piece's axis run straight off it — a wrap extent spanning two
  // contigs would produce one run labelled with the first of them.
  const contig = mc.coords.contigOfBin(wrap[0])
  const [contigStart, contigEnd] = mc.coords.contigBinExtent(contig)
  if (contigStart !== wrap[0] || contigEnd !== wrap[1]) {
    throw new ViewerError(
      'unsupported',
      'A circular window must be a whole sequence: it is the sequence that joins its own ends.',
      { wrap, contig: mc.chromnames[contig] },
    )
  }

  const asked: PoolPlan = {
    binsPerCell: Math.max(1, Math.trunc(request.binsPerCell ?? 1)),
    contigsPerCell: Math.max(1, Math.trunc(request.contigsPerCell ?? 1)),
  }
  const plan =
    asked.binsPerCell > 1 || asked.contigsPerCell > 1
      ? asked
      : (env.planFor(wrap, rows[1] - rows[0], cols[1] - cols[0]) ?? {
          binsPerCell: 1,
          contigsPerCell: 1,
        })
  // A cell of whole sequences would make a circular block one cell wide. Refused
  // rather than drawn: there is nothing to slide along, and a single pixel
  // answers no question.
  if (plan.contigsPerCell > 1) {
    throw new ViewerError(
      'unsupported',
      'A circular sequence cannot be read at whole-sequence resolution: there is only one of it.',
      { wrap },
    )
  }
  const k = Math.max(1, plan.binsPerCell)

  const rowPieces = wrappedLane(env, rows, wrap, plan)
  const colPieces = wrappedLane(env, cols, wrap, plan)
  if (rowPieces.length === 0 || colPieces.length === 0) {
    throw new ViewerError('unsupported', 'A circular window with nothing in it cannot be read.', {
      rows,
      cols,
      wrap,
    })
  }

  const read = async (row: LanePiece, col: LanePiece): Promise<Sub> => {
    const query = {
      rows: row.read,
      cols: col.read,
      ...(request.balance === true ? { balance: true } : {}),
      ...(request.value === undefined ? {} : { value: request.value }),
      ...(request.budgetBytes === undefined ? {} : { budgetBytes: request.budgetBytes }),
    }
    if (k <= 1) {
      const dense = await mc.matrix(query, env.hint(row.read, col.read))
      return { nrows: dense.nrows, ncols: dense.ncols, values: dense.values }
    }
    const pooled = await mc.pooledMatrix(query, plan, env.hooks ?? {})
    env.throwIfCancelled()
    const values = pooled.values instanceof Float32Array ? pooled.values : Float32Array.from(pooled.values)
    return { nrows: pooled.nrows, ncols: pooled.ncols, values }
  }

  const grid: Sub[][] = []
  for (const row of rowPieces) {
    const line: Sub[] = []
    for (const col of colPieces) line.push(await read(row, col))
    grid.push(line)
  }
  const rowCells = grid.map((line) => line[0].nrows)
  const colCells = grid[0].map((piece) => piece.ncols)
  const { nrows, ncols, values } = stitch(grid)

  const rowExtent = laneExtent(rowPieces)
  const colExtent = laneExtent(colPieces)
  return {
    nrows,
    ncols,
    values,
    rowExtent,
    colExtent,
    rowGroups: wrappedRuns(mc, contig, rowPieces, rowCells, rowExtent[0], k),
    colGroups: wrappedRuns(mc, contig, colPieces, colCells, colExtent[0], k),
    ...(request.genomes === true && mc.hasGenomes
      ? {
          rowGenomes: wrappedGenomeRuns(mc, contig, rowPieces, rowCells),
          colGenomes: wrappedGenomeRuns(mc, contig, colPieces, colCells),
        }
      : {}),
    level: 'bin',
    wrapped: wrap,
    ...(k > 1 ? { binsPerCell: k } : {}),
  }
}

/** One stored run of a wrapped axis, snapped to the grid the whole block uses. */
interface LanePiece {
  /** The stored extent actually read — {@link snapToGrid}'s, at `k > 1`. */
  read: Extent
  /** Unwrapped bin this piece's first bin sits at. */
  unwrapped: number
}

/**
 * One axis of a wrapped window, as pieces to read.
 *
 * `wrapPieces` says which stored runs the window covers; this snaps each of them
 * to the grid the block is being read on, which at bin level is a no-op and at
 * `k > 1` is what makes the pieces tile. They still tile after snapping because
 * the grid is anchored to the **sequence**: the piece that ends at the sequence's
 * last bin keeps that end (`snapToGrid` clamps to the contig), and the piece that
 * begins at its first bin is already on a cell edge. Only the outer two edges of
 * the window move, and they move outward, which is what every pooled read in this
 * file already does.
 */
function wrappedLane(env: WrapEnv, extent: Extent, wrap: Extent, plan: PoolPlan): LanePiece[] {
  const out: LanePiece[] = []
  for (const piece of wrapPieces(extent, wrap)) {
    const read =
      plan.binsPerCell > 1 ? env.snap([piece.from, piece.to], plan) : ([piece.from, piece.to] as Extent)
    if (!(read[1] > read[0])) continue
    // The unwrapped position of the bin the piece *actually starts at*, which
    // after a snap is up to `k − 1` bins before the one that was asked for.
    out.push({ read, unwrapped: read[0] + piece.shift })
  }
  return out
}

/**
 * The unwrapped extent a lane's pieces add up to.
 *
 * Contiguous by construction — see {@link wrappedLane} — so it is the first
 * piece's own start and the total width, which is the pair the view pans in.
 */
function laneExtent(pieces: readonly LanePiece[]): Extent {
  const width = pieces.reduce((sum, piece) => sum + (piece.read[1] - piece.read[0]), 0)
  return [pieces[0].unwrapped, pieces[0].unwrapped + width]
}

/**
 * The axis runs of a wrapped block: one per piece, on the one sequence.
 *
 * The only part of this that takes thought is `unitStart`, which
 * `render/locus.ts` reads as *the position the sequence itself begins at*, and
 * which therefore has to name a **different** place for each lap — or the stretch
 * on the far side of the junction would report a `bpStart` of a whole sequence
 * length rather than of zero, and every tick, track and annotation on it would be
 * drawn a chromosome away.
 *
 * The formula is the one `bpWithin` inverts: a cell at block offset `o` reports
 * `(blockStart + o − unitStart) × cellSize`, and what we want that to be is the
 * distance from the sequence's own first cell. For a piece whose first cell is
 * `at` cells into the block and `before` cells into the sequence, that is
 * `blockStart + at − before`. At bin level `before` is a bin count and the cell
 * size is the bin size, so the same line serves both.
 */
function wrappedRuns(
  mc: MetaCooler,
  contig: number,
  pieces: readonly LanePiece[],
  cells: readonly number[],
  blockStart: number,
  k: number,
): AxisGroup[] {
  const [contigStart] = mc.coords.contigBinExtent(contig)
  const label = mc.chromnames[contig] ?? String(contig)
  const length = mc.coords.contigLengths[contig]
  const starts = wrapUnitStarts({
    starts: pieces.map((piece) => piece.read[0]),
    cells,
    blockStart,
    contigStart,
    binsPerCell: k,
  })
  const out: AxisGroup[] = []
  let at = 0
  for (let i = 0; i < pieces.length; i++) {
    out.push({
      label,
      start: at,
      end: at + cells[i],
      unitStart: starts[i],
      ...(length === undefined ? {} : { unitLength: length }),
    })
    at += cells[i]
  }
  return out
}

/** {@link wrappedRuns} for the genome layer, which carries no `unitStart`. */
function wrappedGenomeRuns(
  mc: MetaCooler,
  contig: number,
  pieces: readonly LanePiece[],
  cells: readonly number[],
): AxisGroup[] {
  const id = mc.contigGenomeIds[contig]
  const label = mc.genomeNames[id] ?? String(id)
  const total = cells.reduce((sum, count) => sum + count, 0)
  void pieces
  // One run, because every piece is the same sequence and so the same genome.
  return total > 0 ? [{ label, start: 0, end: total }] : []
}

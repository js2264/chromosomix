/**
 * Reading a block at a **coarser bin size** than the file stores.
 *
 * The whole-genome view of a cooler asks for a block whose cell count is the
 * square of the file's bin count, and past about 23,000 bins that block cannot
 * be made at all: its values are one `Float32Array` and a browser serves at most
 * 2 GiB in one (`MAX_DENSE_ARRAY_BYTES`). A whole yeast genome at 500 bp is
 * 24,228 bins and 2.3 GB, and it was offered, computed, and then refused.
 *
 * The picture it was refused for is one nothing could have shown: the renderer
 * pools any raster to `RASTER_MAX_DIM` per axis, so 24,228 rows were going to be
 * drawn as about 4,000 pixels whatever happened. So the pooling moves to the
 * *read*: sum every `stride` consecutive bins into one cell, in the worker, from
 * the stored pixels, and the block that arrives is the one that was always going
 * to be drawn — 65 MB instead of 2.3 GB, and no giant allocation to refuse.
 *
 * **The result is a coarser resolution of the same file, not a different kind of
 * object.** The stride restarts at every contig, so a cell is `stride` bins of
 * one sequence and a run of cells is that sequence — exactly the shape a bin has,
 * one size up. That is what lets the rest of the app treat it as bins: the view
 * multiplies its bin size by the stride and every coordinate, tick, tooltip and
 * selection is then correct without knowing pooling happened. It is the same
 * relationship an `.mcool`'s 5 kb level has to its 1 kb level, computed on the
 * way through rather than stored (`cooler zoomify`, `metacooler binnify`).
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
 * The cell count past which contig snapping is given up.
 *
 * Snapping rounds each contig's cell count up, so an axis comes out above the
 * aim by about half a cell per contig — ten on a yeast cooler, which is nothing,
 * and 133,000 on a metagenome, which is a larger axis than the one pooling was
 * called in to shrink. The limit tells those two apart without pretending an
 * exact cap is achievable.
 *
 * 1,024 cells of slack, so an assembly of up to about two thousand sequences
 * keeps its boundaries. It is also what bounds the accumulator: the sum is
 * `Float64` — a pooled cell adds up thousands of counts and `Float32` starts
 * dropping whole contacts above 2^24 — so the axis limit is a memory limit at
 * 8 bytes per cell pair, and 5,120² is 210 MB.
 */
export const POOLED_CELL_LIMIT = POOLED_CELL_CAP + 1024

/**
 * Bins per cell for a block of `nBins`, aiming at `cap` cells per axis.
 *
 * `1` means no pooling: the block already fits and is read exactly, cell for
 * bin. Above that it is `ceil(nBins / cap)` and nothing cleverer, because the
 * number has to be computed *twice* and agree — once by the view, which labels
 * the axes in the matching units, and once by the read, which sums into them.
 * One formula over one input is what makes that safe; the exact cell count,
 * which depends on where the contigs fall, is reported back rather than
 * predicted.
 */
export function poolStride(nBins: number, cap = POOLED_CELL_CAP): number {
  if (cap <= 0 || nBins <= cap) return 1
  return Math.max(2, Math.ceil(nBins / cap))
}

/** One axis of a pooled read: which cell each bin falls into, and what it is. */
export interface BinPooling extends AxisGrouping {
  /** Contig id of every output cell — one entry per cell, for the axis runs. */
  ids: Int32Array
  /** Bins summed into one cell. `1` is the identity, and is not pooling. */
  stride: number
  /**
   * `false` when a cell may span two contigs.
   *
   * True in every case the UI can reach, and it is what makes the block a
   * coarser *bin* grid: a cell is `stride` bins from one sequence, so a position
   * inside it is a position inside that sequence. Where it is false the axis is
   * still drawn and still labelled, but the coordinates under it are off by up
   * to one cell at each boundary.
   */
  snapped: boolean
}

/**
 * Assign every bin in `[lo, hi)` to a pooled cell.
 *
 * Snapped to contig starts wherever the contigs are few enough to each have a
 * cell — which is every file this is reached from, a cooler's chromosomes being
 * tens rather than thousands. Past that the split is flat: a metagenome's
 * 266,271 contigs cannot each start a cell without producing an axis larger than
 * the one pooling was called in to shrink, and a whole-*metagenome* picture has
 * its own view (§7.3) that answers the question properly.
 */
export function binPooling(coords: Coords, lo: number, hi: number, stride: number): BinPooling {
  const count = Math.max(0, hi - lo)
  const slot = new Int32Array(count)
  if (count === 0) return { slot, ids: new Int32Array(0), stride, snapped: true }

  const contigs = coords.contigsOfBins(lo, hi)
  const ids: number[] = []
  let cells = 0
  let cellStart = 0
  for (let i = 0; i < count; i++) {
    // A new contig, or `stride` bins into the current cell: either way the next
    // bin opens a cell. The first bin opens the first one.
    if (i === 0 || contigs[i] !== contigs[i - 1] || i - cellStart >= stride) {
      if (i > 0) cells++
      cellStart = i
      ids.push(contigs[i])
    }
    slot[i] = cells
  }
  return { slot, ids: Int32Array.from(ids), stride, snapped: true }
}

/**
 * The same assignment with the contig boundaries given up.
 *
 * `floor(i / stride)`, so a cell may hold the end of one contig and the start of
 * the next. Only for an axis with more contigs than cells, where snapping would
 * produce one cell per contig and defeat the pooling entirely.
 */
export function flatBinPooling(
  coords: Coords,
  lo: number,
  hi: number,
  stride: number,
): BinPooling {
  const count = Math.max(0, hi - lo)
  const slot = new Int32Array(count)
  if (count === 0) return { slot, ids: new Int32Array(0), stride, snapped: false }
  const contigs = coords.contigsOfBins(lo, hi)
  const cells = Math.ceil(count / stride)
  const ids = new Int32Array(cells)
  for (let i = 0; i < count; i++) slot[i] = Math.floor(i / stride)
  // A cell is named by the contig its *first* bin is in. On an axis this coarse
  // a straddling cell holds the tail of one sequence and the head of the next,
  // and no rule picks the right name for it — the first bin at least makes the
  // labels monotone, so the axis still reads in file order.
  for (let c = 0; c < cells; c++) ids[c] = contigs[Math.min(count - 1, c * stride)]
  return { slot, ids, stride, snapped: false }
}

/** Snapped where that is possible, flat where it is not. */
export function poolBins(
  coords: Coords,
  lo: number,
  hi: number,
  stride: number,
  limit = POOLED_CELL_LIMIT,
): BinPooling {
  if (stride <= 1) return binPooling(coords, lo, hi, 1)
  const snapped = binPooling(coords, lo, hi, stride)
  return snapped.ids.length <= limit ? snapped : flatBinPooling(coords, lo, hi, stride)
}

/**
 * The same grid over a **chosen set of contigs**, and nothing else.
 *
 * A reader who ticks four MAGs out of two thousand is asking for one picture of
 * those four — their own maps on the diagonal and everything between them off
 * it — and that picture is not a range of bins: the four are scattered through
 * the file. So the axis is built from the selection rather than from an extent,
 * in the order given, and every bin that is not in it maps to `-1`, which
 * {@link pixelAccumulator} drops.
 *
 * `stride` coarsens exactly as it does for a range, per contig, so a selection
 * of large sequences is bounded by the same cap as everything else.
 *
 * @param extents Bin range of each selected contig, in the order to display
 *   them. Whoever chose the order is the caller: the tables sort, and a picture
 *   that reordered the selection behind them would be answering a different
 *   question.
 */
export function selectionPooling(
  nBins: number,
  extents: ReadonlyArray<{ id: number; extent: readonly [number, number] }>,
  stride: number,
): BinPooling {
  const slot = new Int32Array(nBins).fill(-1)
  const ids: number[] = []
  const step = Math.max(1, Math.trunc(stride))
  for (const { id, extent } of extents) {
    const [lo, hi] = extent
    for (let bin = lo; bin < hi; bin++) {
      // A fresh cell at each contig's start and every `step` bins after it —
      // the same rule as a range, applied per selected piece.
      if ((bin - lo) % step === 0) ids.push(id)
      slot[bin] = ids.length - 1
    }
  }
  return { slot, ids: Int32Array.from(ids), stride: step, snapped: true }
}

/**
 * The stride a selection needs: its own bin count against the cap.
 *
 * Not the file's bin count — four MAGs of a metagenome are a small picture
 * however large the file is, and pooling them by the file's stride would throw
 * away the detail the selection was made to look at.
 */
export function selectionStride(bins: number, cap = POOLED_CELL_CAP): number {
  return poolStride(bins, cap)
}

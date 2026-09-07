/**
 * The single-cell container: many coolers in one file, read as one map.
 *
 * An `.scool` (Wolff et al., *Bioinformatics* 37:2053) is a set of coolers over
 * **one shared bin space** — one per cell — and that shared bin space is the
 * whole of why this file is short. Every cell indexes the same bins, so a bin
 * id means the same thing in all of them, and summing a set of cells is not an
 * operation at all: it is the same read performed several times into the same
 * accumulator.
 *
 * ## Why the sum needs no arithmetic
 *
 * `scatterDense` is **additive and per-pixel** (`metacooler/matrix.ts`), which
 * it has to be anyway — a read arrives in chunks and a bounded rectangle may be
 * covered by several. So a store that hands the same callback every cell's
 * chunks in turn produces their sum, exactly, with no summing code, no
 * intermediate matrix and a peak footprint of one chunk. The aggregation *is*
 * the fan-out.
 *
 * The same is true of the two other things a store answers. `nnz` is a total
 * over the set. `binOffsets` is a cumulative count, and a sum of cumulative
 * counts is the cumulative count of the sum — so the density column, the
 * band planner and the selection read all work over a cell set without
 * knowing one is there.
 *
 * ## What this deliberately does not do
 *
 * **Balance per cell.** Weights are applied once, to the summed block, from the
 * shared `/bins` — which is cooler's own definition of a balanced matrix
 * applied to the pseudo-bulk the reader asked for. Balancing each cell before
 * summing would make the result something other than a contact count, and the
 * files that most want summing (raw single-cell coolers, this format's whole
 * reason for existing) carry no weights to do it with.
 *
 * **Hold a cooler per cell.** A cell is a group path and an offsets array, and
 * the sibling-rung machinery that opens a whole `MetaCooler` per entry does not
 * scale to the several thousand cells a real file has. What is held is one
 * borrowed handle per *selected* cell, over the one mount.
 */

import { yieldToEventLoop } from '../async'
import { ViewerError } from '../errors'
import type { Hdf5Handle } from '../h5/api'
import { pyList } from '../format'
import type { Extent, Layout, PixelChunk } from '../types'
import { cellPath } from './detect'
import { DEFAULT_COUNT_COLUMN, type ReadPlan, type SpanScanOptions } from './matrix'
import { CoolerStore, type PixelStore, type ScanAllOptions } from './store'

/**
 * How many cells a single aggregate may sum over before the caller must say so.
 *
 * Not a limit on the picture — the block a sum produces is the same size
 * whether it came from one cell or four thousand — but on the *reads*: every
 * cell in the set is a walk of its own pixel bands, so the cost is linear in
 * cells where every other read in this application is bounded by the rectangle
 * asked for. Above this the caller gates, the way the whole-file view gates on
 * its pixel count.
 */
export const CELL_SUM_GATE = 64

/** One cell of an scool, resolved to something that can be read. */
interface Cell {
  name: string
  store: CoolerStore
}

export class ScoolStore implements PixelStore {
  readonly countKind: 'i' | 'u' | 'f'
  private readonly cells: Cell[]
  private offsets: Float64Array | null = null

  /**
   * @param handle The file's root handle; each cell is a borrowed view of it.
   * @param layout The detected layout, which says where the cells live.
   * @param names The selected cells, in the order the reader ticked them.
   * @param nBins Bins in the shared space — the same for every cell.
   */
  constructor(
    handle: Hdf5Handle,
    layout: Layout,
    names: readonly string[],
    private readonly nBins: number,
    countKind: 'i' | 'u' | 'f',
  ) {
    this.countKind = countKind
    this.cells = names.map((name) => ({
      name,
      store: new CoolerStore(handle.at(cellPath(layout, name)), nBins, countKind),
    }))
  }

  /** The cells this store is summing, in the order they were given. */
  get names(): string[] {
    return this.cells.map((cell) => cell.name)
  }

  /**
   * Stored pixels across the set — a total, not a distinct count.
   *
   * Two cells that both record a contact between the same pair of bins
   * contribute two stored pixels and one cell of the summed block, so this
   * overstates the block's occupancy and understates nothing. It is used to
   * forecast *read cost*, which is what it measures exactly.
   */
  get nnz(): number {
    let total = 0
    for (const cell of this.cells) total += cell.store.nnz
    return total
  }

  /**
   * The value columns every selected cell offers.
   *
   * An intersection rather than the first cell's list: a column one cell has
   * and another does not cannot be summed across the set, and offering it would
   * put a picker entry on screen whose read fails on the second cell. `count`
   * is in every cooler by construction, so the intersection is never empty.
   */
  scoreColumns(): string[] {
    const [first, ...rest] = this.cells
    if (first === undefined) return [DEFAULT_COUNT_COLUMN]
    let columns = first.store.scoreColumns()
    for (const cell of rest) {
      const theirs = new Set(cell.store.scoreColumns())
      columns = columns.filter((name) => theirs.has(name))
    }
    return columns.length > 0 ? columns : [DEFAULT_COUNT_COLUMN]
  }

  /**
   * Cumulative stored-pixel counts over the whole set.
   *
   * The sum of the cells' own `indexes/bin1_offset`, element by element, which
   * is the cumulative count of the summed pixel set because a cumulative sum is
   * linear. Memoised: it is `nBins + 1` doubles and every band plan reads it.
   *
   * This is the one place the set costs something up front — one small index
   * read per cell — and it is why a selection is gated on its cell count.
   */
  binOffsets(): Float64Array {
    if (this.offsets !== null) return this.offsets
    const total = new Float64Array(this.nBins + 1)
    for (const cell of this.cells) {
      const offsets = cell.store.binOffsets()
      const n = Math.min(total.length, offsets.length)
      for (let i = 0; i < n; i++) total[i] += offsets[i]
    }
    this.offsets = total
    return total
  }

  /**
   * Every selected cell's pixels for this rectangle, into one callback.
   *
   * The plan passes through unchanged, and that it can is the second thing the
   * shared bin space buys: `ReadPlan.span` is a *bin* range, resolved against
   * each cell's own `bin1_offset` when it is read (`forEachPixelSpanAsync`), so
   * one plan addresses every cell correctly. It carries the storage mode's
   * decisions — transpose, mirror, skip the diagonal — which an scool's cells
   * share as they share their bins.
   */
  async forEachWindow(
    rows: Extent,
    cols: Extent,
    plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    for (const cell of this.cells) {
      if (!(await cell.store.forEachWindow(rows, cols, plan, onChunk, options))) return false
      // Between cells rather than only inside them: a set of four thousand
      // sparse cells is four thousand small reads, and a cancel arriving as a
      // message needs the queue to run to be seen (`../async`).
      await yieldToEventLoop()
    }
    return true
  }

  async forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    for (const cell of this.cells) {
      if (!(await cell.store.forEachBands(bands, onChunk, options))) return false
      await yieldToEventLoop()
    }
    return true
  }

  /**
   * Every pixel of every selected cell.
   *
   * Progress is reported against the set's total so a scan over four thousand
   * cells advances a single bar rather than restarting it per cell.
   */
  async scanAll(options: ScanAllOptions): Promise<void> {
    const total = this.nnz
    let done = 0
    let stopped = false
    for (const cell of this.cells) {
      if (stopped) return
      const before = done
      await cell.store.scanAll({
        ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
        onChunk: (chunk) => {
          const keepGoing = options.onChunk(chunk)
          if (keepGoing === false) stopped = true
          return keepGoing
        },
        onProgress: (cellDone) => {
          done = before + cellDone
          options.onProgress?.(done, total)
        },
      })
      done = before + cell.store.nnz
      options.onProgress?.(Math.min(done, total), total)
    }
  }
}

/**
 * Resolve the cells a view names against the cells a file has.
 *
 * `null` means *all of them*, which is what a file addressed with no cell set
 * means: an scool with nothing ticked is the pseudo-bulk of everything in it,
 * and that is the picture somebody who dropped one and pressed on wanted.
 *
 * A name the file does not carry is refused rather than skipped. Silently
 * dropping it would answer a request for eight cells with the sum of seven and
 * no sign that anything was missing — which is the same argument the region
 * parser makes about a contig name, and the same answer.
 */
export function resolveCells(available: readonly string[], wanted: readonly string[] | null): string[] {
  if (wanted === null || wanted.length === 0) return [...available]
  const have = new Set(available)
  const missing = wanted.filter((name) => !have.has(name))
  if (missing.length > 0) {
    throw new ViewerError(
      'cell-not-found',
      `This file has no ${missing.length === 1 ? 'cell' : 'cells'} ${pyList(missing.slice(0, 8))}. ` +
        `It carries ${available.length} ${available.length === 1 ? 'cell' : 'cells'}, ` +
        `starting ${pyList(available.slice(0, 3))}.`,
      { missing, available: available.length },
    )
  }
  // Deduplicated, and in the file's own order rather than the order they were
  // named: the same cell twice would be counted twice, and a set read forwards
  // is one pass over the file rather than a seek per name.
  const set = new Set(wanted)
  return available.filter((name) => set.has(name))
}

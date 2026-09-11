/**
 * Getting a square, from wherever the cheapest square is.
 *
 * Almost every task on the map needs the same thing: a dense on-diagonal block
 * for one sequence, at the file's own resolution, balanced the way the run asked
 * for. And almost every one of them can get it two ways — out of the block the
 * view is already holding, or by reading it — with the same three conditions
 * deciding which (§18.3, §18.6).
 *
 * Those conditions were written once, for P(s), and are here because insulation
 * needed exactly them and a second copy is how the two would come to disagree
 * about what "usable" means. Each is load-bearing:
 *
 * - the block has to **cover** the span, or the part it does not cover would be
 *   silently absent from a result that claims to describe the whole sequence;
 * - it has to be at the file's **own resolution**, since a pooled block is
 *   coarser than the file and `AnalysisFraming.binsPerCell` exists precisely so a
 *   task can decline to pretend otherwise;
 * - it has to have been read with the **balancing this run wants**, because the
 *   block is whatever the map happens to be drawn from and the reader may have
 *   asked for the other one.
 *
 * A task that skips any of the three gets an answer that is plausible, cheap and
 * wrong, which is the combination this whole subtree is written against.
 */

import { ViewerError } from '../../errors'
import type { MetaCooler } from '../../metacooler/MetaCooler'
import { DEFAULT_WEIGHT_COLUMN } from '../../metacooler/matrix'
import type { JobContext } from '../job'
import type { BlockInput } from '../worker/protocol'
import type { SeparationBand } from '../band'
import { diagonalTiles, tileRows } from '../tiles'

/** A half-open run of absolute bins. */
export interface Span {
  from: number
  to: number
}

/** Whether a block contains the whole of `span` on both axes. */
export function blockCovers(block: BlockInput, span: Span): boolean {
  return (
    block.rowExtent[0] <= span.from &&
    block.rowExtent[1] >= span.to &&
    block.colExtent[0] <= span.from &&
    block.colExtent[1] >= span.to
  )
}

/**
 * The view's block, if it can honestly answer for every span.
 *
 * `null` rather than a partial answer: the caller then reads, which is slower
 * and right, and there is no third state in which some spans come from the block
 * and some from the file at a different resolution.
 */
export function usableBlock(
  job: JobContext,
  spans: readonly Span[],
  balance: boolean,
): BlockInput | null {
  const block = job.inputs.block
  if (block === undefined || block.binsPerCell !== 1 || job.framing.balance !== balance) return null
  for (const span of spans) if (!blockCovers(block, span)) return null
  return block
}

/**
 * One span's square, cut out of a larger block.
 *
 * The copy is skipped where the block *is* the span, which is the usual case —
 * the reader is looking at one contig and asks about that contig — and it
 * matters because the alternative allocates a second copy of a block that can be
 * nine megabytes for no reason at all.
 */
export function squareOf(block: BlockInput, span: Span): BlockInput {
  const exact =
    block.rowExtent[0] === span.from &&
    block.rowExtent[1] === span.to &&
    block.colExtent[0] === span.from &&
    block.colExtent[1] === span.to
  if (exact) return block

  const n = span.to - span.from
  const values = new Float32Array(n * n)
  const rowSkip = span.from - block.rowExtent[0]
  const colSkip = span.from - block.colExtent[0]
  for (let r = 0; r < n; r++) {
    const at = (rowSkip + r) * block.ncols + colSkip
    values.set(block.values.subarray(at, at + n), r * n)
  }
  return {
    nrows: n,
    ncols: n,
    values,
    rowExtent: [span.from, span.to],
    colExtent: [span.from, span.to],
    binsPerCell: 1,
  }
}

/**
 * A span's square, from the block or from the file.
 *
 * The one call a task on the diagonal should make. `block` is whatever
 * {@link usableBlock} returned for the whole run, so the decision is made once
 * per run rather than once per sequence — which is what stops a metagenome from
 * checking the same three conditions four thousand times.
 */
export async function squareFor(
  job: JobContext,
  span: Span,
  options: { block: BlockInput | null; balance: boolean; value: string },
): Promise<BlockInput> {
  if (options.block !== null) return squareOf(options.block, span)
  const dense = await job.mc.matrix({
    rows: [span.from, span.to],
    cols: [span.from, span.to],
    balance: options.balance,
    value: options.value,
  })
  return {
    nrows: dense.nrows,
    ncols: dense.ncols,
    values: dense.values,
    rowExtent: [dense.rowExtent[0], dense.rowExtent[1]],
    colExtent: [dense.colExtent[0], dense.colExtent[1]],
    binsPerCell: 1,
  }
}

// ---------------------------------------------------------------------------
// Reading a diagonal, without the square around it
// ---------------------------------------------------------------------------

/**
 * A run of diagonals of one sequence, read without the square around it.
 *
 * **The reason this exists is that everything downstream of it was already
 * banded and the read was not.** `analysis/chromosight.ts` keeps its detrended
 * map and its correlation map as {@link DiagonalBand}s precisely because holding
 * them as `n²` costs gigabytes on a mammalian chromosome — and then the runner
 * handed them an `n²` dense square to build from, which put a cap on the
 * sequence length that had nothing to do with the arithmetic.
 *
 * Read row-band by row-band: the cells with `0 ≤ col − row ≤ hi` for rows
 * `[a, b)` all lie in columns `[a, b + hi)`, so one rectangle per tile covers
 * them with no overlap between tiles. What is held is `(hi + 1) × n` cells
 * whatever the sequence is, and what is read at a time is one tile.
 *
 * `Float32` rather than `Float64`, matching what `mc.matrix` returns: this is
 * the file's own numbers, not a derived quantity, and doubling them would double
 * the one array that does scale with the sequence.
 */
export class ContigBand implements SeparationBand {
  readonly values: Float32Array

  constructor(
    readonly n: number,
    /** Highest offset `col - row` stored, inclusive. */
    readonly hi: number,
    /**
     * Whether the sequence joins its own end to its own beginning (§8.16).
     *
     * What it changes is only what {@link forward} answers past either end — the
     * storage is identical, because a circular band's wrapped cells live at the
     * same `(offset, row)` as any other: the cell `offset` along from row `r` is
     * at `(r + offset) mod n`, and {@link bandFor} reads the corner of the
     * square that holds those and fills them in.
     */
    readonly circular: boolean = false,
  ) {
    this.values = new Float32Array((hi + 1) * n).fill(Number.NaN)
  }

  /** `(row, col)` where the cell is stored; `0` outside the band. */
  at(row: number, col: number): number {
    const offset = col - row
    if (offset < 0 || offset > this.hi || row < 0 || row >= this.n) return 0
    const value = this.values[offset * this.n + row]
    // `0` rather than `NaN` for a cell that was never read, which is what this
    // accessor has always answered and what `analysis/chromosight.ts` is written
    // against. {@link forward} is the one that tells *nothing here* apart from
    // *nothing read*, because the kernels that use it need to.
    return Number.isNaN(value) ? 0 : value
  }

  /**
   * The cell `offset` along the diagonal from `row` — the accessor the banded
   * kernels are written against. See `analysis/band.ts`.
   */
  forward(row: number, offset: number): number {
    if (offset < 0) return this.forward(row + offset, -offset)
    if (offset > this.hi) return Number.NaN
    let r = row
    if (this.circular) {
      r = ((row % this.n) + this.n) % this.n
    } else if (r < 0 || r + offset >= this.n) {
      return Number.NaN
    }
    return this.values[offset * this.n + r]
  }
}

/**
 * One sequence's band, from the block on screen or from the file.
 *
 * The block path is the same three conditions {@link usableBlock} already
 * decided, so a reader who pressed Run while looking at the sequence pays
 * nothing; the read path is tiled and bounded. Either way what comes back is the
 * same object, so nothing downstream knows which it got.
 *
 * ## The one extra read a circular sequence costs
 *
 * On a circular sequence the cell `d` bins after the last bin is a cell `d`
 * bins into the *first*, and in the contig's own square that cell is not near
 * the diagonal at all — it is in the **top-right corner**, rows `[0, hi)` against
 * columns `[n − hi, n)`. A tiled band walk never goes near it, which is exactly
 * why a band read that simply kept the same tiles and changed the accessor would
 * answer `NaN` for every bin within `hi` of the junction: a circular chromosome
 * with a linear-looking seam at the one place the flag was set to fix.
 *
 * So a circular band reads one more rectangle. It is `hi × hi` cells whatever
 * the sequence is, it is one request, and it is the whole of the difference.
 */
export async function bandFor(
  job: JobContext,
  span: Span,
  options: {
    /** Widest diagonal to keep, in bins. */
    hi: number
    block: BlockInput | null
    balance: boolean
    value: string
    /**
     * Read the sequence as a circle: the band wraps past the last bin (§8.16).
     *
     * `hi` is then capped at half the sequence rather than at its length, since
     * past half the circle the short way round is the other way and a band wider
     * than that would hold every cell twice.
     */
    circular?: boolean
    /** Called between tiles, so a chromosome-long read can be stopped. */
    onTile?: (done: number, total: number) => Promise<void> | void
  },
): Promise<ContigBand> {
  const n = span.to - span.from
  const circular = options.circular === true
  const hi = Math.max(
    0,
    Math.min(options.hi, circular ? Math.floor(n / 2) : Math.max(0, n - 1)),
  )
  const band = new ContigBand(n, hi, circular)

  const fill = (
    values: ArrayLike<number>,
    ncols: number,
    rowFrom: number,
    rowTo: number,
    colFrom: number,
  ): void => {
    for (let r = rowFrom; r < rowTo; r++) {
      const base = (r - rowFrom) * ncols - colFrom
      const last = Math.min(n - 1, r + hi)
      for (let c = r; c <= last; c++) {
        band.values[(c - r) * n + r] = values[base + c]
      }
    }
  }

  /**
   * The wrapped cells, from the corner of the contig's own square.
   *
   * `corner` is rows `[0, hi)` by columns `[n − hi, n)` of that square, row-major
   * and `hi` wide. The cell it holds at `(c, r)` — a *low* row against a *high*
   * column — is the contact between bin `r` near the end and bin `c` near the
   * start, which is the cell `c + n − r` bins along the circle from `r`. Only
   * the separations at or below `hi` belong in the band; the rest of the corner
   * is the long way round and is already stored at its short-way offset.
   */
  const fillWrap = (corner: ArrayLike<number>, ncols: number): void => {
    for (let c = 0; c < hi; c++) {
      for (let r = n - hi; r < n; r++) {
        const offset = c + n - r
        if (offset < 1 || offset > hi) continue
        band.values[offset * n + r] = corner[c * ncols + (r - (n - hi))]
      }
    }
  }

  if (options.block !== null) {
    const block = options.block
    const rowSkip = span.from - block.rowExtent[0]
    const colSkip = span.from - block.colExtent[0]
    for (let r = 0; r < n; r++) {
      const at = (rowSkip + r) * block.ncols + colSkip
      const last = Math.min(n - 1, r + hi)
      for (let c = r; c <= last; c++) band.values[(c - r) * n + r] = block.values[at + c]
    }
    if (circular && hi > 0) {
      // The corner is inside a block that covers the whole sequence, so there is
      // nothing to read — only to index. Same arithmetic as {@link fillWrap},
      // against the block's own stride.
      for (let c = 0; c < hi; c++) {
        const at = (rowSkip + c) * block.ncols + colSkip
        for (let r = n - hi; r < n; r++) {
          const offset = c + n - r
          if (offset < 1 || offset > hi) continue
          band.values[offset * n + r] = block.values[at + r]
        }
      }
    }
    return band
  }

  const tile = tileRows(hi, hi)
  const tiles = Math.max(1, Math.ceil(n / tile))
  for (let t = 0; t < tiles; t++) {
    await options.onTile?.(t, tiles)
    const rowFrom = t * tile
    const rowTo = Math.min(n, rowFrom + tile)
    if (rowTo <= rowFrom) break
    const colTo = Math.min(n, rowTo + hi)
    const dense = await job.mc.matrix({
      rows: [span.from + rowFrom, span.from + rowTo],
      cols: [span.from + rowFrom, span.from + colTo],
      balance: options.balance,
      value: options.value,
    })
    fill(dense.values, dense.ncols, rowFrom, rowTo, rowFrom)
  }
  if (circular && hi > 0) {
    const corner = await job.mc.matrix({
      rows: [span.from, span.from + hi],
      cols: [span.to - hi, span.to],
      balance: options.balance,
      value: options.value,
    })
    fillWrap(corner.values, corner.ncols)
  }
  await options.onTile?.(tiles, tiles)
  return band
}

/**
 * One sequence walked as overlapping squares along its diagonal.
 *
 * For a kernel that wants a *square* — the insulation diamond does, and it is
 * goldened against cooltools cell for cell, so it is not being rewritten to take
 * a band. Each tile is a square of `body + 2 × halo` bins and the caller is told
 * which of its bins are fully inside it: those are the ones whose whole window
 * the tile holds, and the ones at its seams belong to the neighbouring tile.
 *
 * At the two ends of the sequence the halo is clipped rather than padded, which
 * is what keeps the first and last `halo` bins answering exactly as they do from
 * a whole square — with no score at all, because their window runs off the
 * sequence and not because a tile boundary fell there.
 */
export async function forEachDiagonalTile(
  job: JobContext,
  span: Span,
  options: {
    /** Bins of margin each side; the kernel's own reach. */
    halo: number
    block: BlockInput | null
    balance: boolean
    value: string
  },
  onTile: (tile: {
    /** The square, `size × size`, in the sequence's own bins. */
    values: Float32Array
    size: number
    /** Where the square starts, local to the sequence. */
    from: number
    /** Local bins whose scores this tile owns, half-open. */
    ownFrom: number
    ownTo: number
    index: number
    total: number
  }) => Promise<void> | void,
): Promise<void> {
  const n = span.to - span.from
  const halo = Math.max(0, options.halo)
  // Through `diagonalTiles`, so the panel's estimate counts the reads this
  // loop actually makes (§18.6).
  const body = tileRows(halo * 2, halo * 2)
  const tiles = diagonalTiles(n, halo)

  for (let t = 0; t < tiles; t++) {
    const ownFrom = t * body
    const ownTo = Math.min(n, ownFrom + body)
    if (ownTo <= ownFrom) break
    const from = Math.max(0, ownFrom - halo)
    const to = Math.min(n, ownTo + halo)
    const square = await squareFor(
      job,
      { from: span.from + from, to: span.from + to },
      { block: options.block, balance: options.balance, value: options.value },
    )
    await onTile({
      values: square.values,
      size: to - from,
      from,
      ownFrom,
      ownTo,
      index: t,
      total: tiles,
    })
  }
}

/**
 * Non-zero **cis** pixels per bin, over the whole file, in one pass.
 *
 * The detectability cut needs a count over a whole *row* — every separation, not
 * just the scanned band — which is the one quantity in this task that a banded
 * read genuinely cannot produce. It used to fall out of the dense square for
 * free, and now that the square is gone it has to be counted from the pixel
 * table instead.
 *
 * The count is exactly what the mirrored square gave: a stored pixel `(i, j)`
 * adds one to both ends and a diagonal pixel adds one, so an upper-triangular
 * sparse table and a mirrored dense block agree per bin — the identity
 * `detectableFromCounts` already relied on. **Cis only**, because the square it
 * replaces was one contig's: a trans pixel was never in it.
 *
 * Once per run rather than once per sequence, and only where the file carries no
 * weights — with them `detectableFromWeights` reads a column and no matrix at
 * all, which is every balanced cooler and so the common case.
 */
export async function cisMarginal(job: JobContext): Promise<Float64Array> {
  const mc = job.mc
  // Bin → contig, so a pixel spanning two sequences can be left out without a
  // binary search per pixel. One `Int32Array` of `nBins` against a pass over
  // every pixel in the file is the same trade `run/coverage.ts` makes.
  const contigOf = new Int32Array(mc.nBins).fill(-1)
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    for (let bin = from; bin < to; bin++) contigOf[bin] = cid
  }
  const sums = new Float64Array(mc.nBins)
  job.progress(0, 1, 'Counting coverage')
  await mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      for (let i = 0; i < chunk.length; i++) {
        const bin1 = chunk.bin1[i]
        const bin2 = chunk.bin2[i]
        if (contigOf[bin1] !== contigOf[bin2]) continue
        const count = chunk.count[i]
        if (!Number.isFinite(count) || count === 0) continue
        sums[bin1] += 1
        if (bin2 !== bin1) sums[bin2] += 1
      }
    },
    onProgress: (at, of) => job.progress(at, of, 'Counting coverage'),
  })
  return sums
}

/**
 * The contigs a result may be produced for.
 *
 * `__unbinned__`'s contigs are left out, which is §7.4's rule applied one level
 * down exactly as the overview scan applies it — and through `displayGenomes()`
 * rather than by matching the reserved name a second time, because §7.4 is
 * emphatic that the name is matched in exactly one place.
 */
export function displayableContigs(mc: MetaCooler): number[] {
  const out: number[] = []
  const shown = mc.hasGenomes ? new Set(mc.displayGenomes()) : null
  for (let cid = 0; cid < mc.nContigs; cid++) {
    if (shown !== null && !shown.has(mc.contigGenomeIds[cid])) continue
    out.push(cid)
  }
  return out
}

/** One contig's bin span, or `null` where it has no bins. */
export function spanOfContig(mc: MetaCooler, cid: number): Span | null {
  const [from, to] = mc.contigExtent(cid)
  return to > from ? { from, to } : null
}

/**
 * Bins whose weight survived the balancer, or `null` when nothing is balanced.
 *
 * Read once for the whole file rather than per span. It is one `Float64Array` of
 * `nBins` against a pass that touches every pixel in the file, which is the same
 * trade `worker/groups.ts` makes for the overview's bin → unit array.
 */
export function validBins(mc: MetaCooler, balance: boolean): Float64Array | null {
  if (!balance) return null
  const path = `bins/${DEFAULT_WEIGHT_COLUMN}`
  if (!mc.handle.has(path)) {
    throw new ViewerError(
      'unsupported',
      `This file has no /${path} column, so there are no weights to balance with. ` +
        'Run `cooler balance` on it, or turn balancing off and read the raw counts.',
      { column: DEFAULT_WEIGHT_COLUMN },
    )
  }
  return mc.handle.readNumeric(path, 0, mc.nBins)
}

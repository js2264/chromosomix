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

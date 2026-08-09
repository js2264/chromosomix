/**
 * Aggregate peak analysis, run.
 *
 * Three things happen here that the kernel deliberately does not know about: the
 * anchors are turned into windows, the windows are *read*, and the reads are
 * coalesced.
 *
 * **Coalescing is an optimisation of the reads and not of the resolution**, and
 * the distinction is the whole reason the task exists in this shape (§18.6).
 * Windows that sit near each other on both axes are read as one block and sliced
 * apart afterwards — the same cells, at the same bin size, in fewer requests.
 * What is never done is widening the *query* to a bounding box, which would come
 * back pooled and hand every window a coarser bin than the file has.
 *
 * Loop anchors cluster, which is what makes this worth doing: on a real yeast
 * micro-C loop set the clusters collapse several thousand windows into a few
 * hundred reads. On a local file it changes nothing measurable, because a read
 * there is a `slice()` — which is why the estimate prices the un-coalesced upper
 * bound and lets the run come in under it, rather than promising a saving that
 * depends on how the anchors happen to be distributed.
 */

import type { FeatureSet, PairSet } from '../../annotations/types'
import { DETAIL_SEP } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import {
  PileupAccumulator,
  p2ll,
  ratioOf,
  resampleWindow,
  shiftedControls,
  type AnchorPair,
} from '../apa'
import { ExpectedAccumulator, expectedAt } from '../expected'
import {
  boolParam,
  idParam,
  numParam,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { makeRandom } from '../random'
import { isScaled, onDiagonal, windowBins } from '../tasks/apa'
import type { MatrixOutput, TableOutput, TaskOutput } from '../types'
import { usableBlock, type Span } from './blocks'

/** A rectangle of the matrix, in absolute bins. */
interface Rect {
  rowFrom: number
  rowTo: number
  colFrom: number
  colTo: number
}

/** One window to pile up, and what it came from. */
interface Plan {
  rect: Rect
  /** For the per-anchor table; absent for a control. */
  label?: string
  separation: number
  control: boolean
  group: number
}

/**
 * The largest block a coalesced read is allowed to become, per side.
 *
 * Coalescing trades bytes for requests, and past a point the trade is bad: two
 * windows 400 bins apart share one 500-bin block, which is 250,000 cells read to
 * deliver 5,000. The cap keeps the merged block within a small multiple of what
 * the windows actually need, so the saving is in requests and not in waste.
 */
const MERGE_CAP_BINS = 512

export const runApa: TaskRunner = async (job) => {
  const usingPairs = !onDiagonal(job.params)
  const setId = idParam(job.params, usingPairs ? 'pairs' : 'features')
  const pairs = usingPairs && setId !== null ? job.inputs.pairs?.[setId] : undefined
  const features = !usingPairs && setId !== null ? job.inputs.features?.[setId] : undefined
  if (pairs === undefined && features === undefined) {
    // Named rather than returned empty. A task that finishes in a millisecond
    // with no figure and no sentence is indistinguishable from one that is
    // broken, and this is the commonest way to reach that state: the drawer
    // opens on a task whose input has not been chosen yet.
    job.note(
      usingPairs
        ? 'No loop set was chosen. Load a BEDPE — a loop table, a set of anchor pairs — and pick it under Pairs.'
        : 'No feature set was chosen. Load a BED or a GTF and pick it under Features.',
    )
    return []
  }

  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const side = isScaled(job.params)
    ? Math.max(11, Math.round(numParam(job.params, 'grid', 51)))
    : windowBins(job.params) * 2 + 1
  const maxAnchors = Math.max(10, Math.round(numParam(job.params, 'maxAnchors', 5000)))
  const norm = strParam(job.params, 'norm', 'matched')

  const anchors = usingPairs
    ? pairAnchors(job, pairs as PairSet)
    : featureAnchors(job, features as FeatureSet)
  if (anchors.length === 0) {
    job.note('No anchor of this set lands inside a sequence this file has, so there is nothing to pile up.')
    return []
  }

  const groups = groupAnchors(job, anchors, usingPairs ? null : (features as FeatureSet))
  const kept = groups.map((group) => group.slice(0, maxAnchors))
  const dropped = groups.reduce((sum, group, i) => sum + (group.length - kept[i].length), 0)
  if (dropped > 0) {
    job.note(
      `${dropped.toLocaleString()} anchors past the cap of ${maxAnchors.toLocaleString()} were ` +
        'not read. Raise the cap to use them all.',
    )
  }

  const plans: Plan[] = []
  const rng = makeRandom(Math.round(numParam(job.params, 'seed', 1)))
  const controlsPer = norm === 'matched' ? Math.max(1, Math.round(numParam(job.params, 'controls', 5))) : 0
  const minShift = job.toBins(numParam(job.params, 'minShift', 100_000))
  const maxShift = Math.max(minShift, job.toBins(numParam(job.params, 'maxShift', 1_000_000)))

  for (let g = 0; g < kept.length; g++) {
    for (const anchor of kept[g]) {
      const rect = rectFor(job, anchor, side)
      if (rect === null) continue
      plans.push({ rect, label: anchor.label, separation: anchor.pair.separation, control: false, group: g })
      if (controlsPer === 0) continue
      for (const control of shiftedControls(anchor.pair, anchor.bounds, {
        perPair: controlsPer,
        minShift,
        maxShift,
        rng,
      })) {
        const controlRect = rectFor(job, { ...anchor, pair: control }, side)
        if (controlRect !== null) {
          plans.push({ rect: controlRect, separation: control.separation, control: true, group: g })
        }
      }
    }
  }
  if (plans.length === 0) {
    job.note('Every window ran off the end of its sequence. Use a narrower window.')
    return []
  }

  const real = kept.map(() => new PileupAccumulator(side, side))
  const controls = kept.map(() => new PileupAccumulator(side, side))
  const expected = new ExpectedAccumulator(job.mc.nBins)
  const perAnchor: Array<{ label: string; separation: number; score: number }> = []
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))

  const block = usableBlock(job, plans.map(spanOf), balance)
  const batches = coalesce(plans)
  let done = 0

  for (const batch of batches) {
    job.throwIfCancelled()
    job.progress(done, plans.length, `${done.toLocaleString()} of ${plans.length.toLocaleString()} windows`)
    const dense = await readRect(job, batch.rect, { block, balance, value })
    // Once per *read*, not once per window: a coalesced block covers several
    // windows, and feeding it in per window would count every one of its cells
    // as many times as the batch is large — which would leave the mean intact
    // and the counts, and therefore nothing visible, wrong.
    if (norm === 'oe') accumulateExpected(expected, dense, batch.rect)
    for (const plan of batch.plans) {
      done++
      const window = cut(dense, batch.rect, plan.rect, side)
      if (window === null) continue
      let seen = 0
      for (const cell of window) if (Number.isFinite(cell)) seen++
      if (seen < window.length * minValid) continue
      if (plan.control) {
        controls[plan.group].add(window)
        continue
      }
      real[plan.group].add(window)
      if (plan.label !== undefined) {
        perAnchor.push({
          label: plan.label,
          separation: plan.separation * job.mc.binsize,
          score: p2ll(window, side, side),
        })
      }
    }
  }
  job.progress(plans.length, plans.length, 'Done')
  job.throwIfCancelled()

  const outputs: TaskOutput[] = []
  const curve = norm === 'oe' ? expected.finish() : null

  for (let g = 0; g < kept.length; g++) {
    const observed = real[g].finish()
    if (observed.n === 0) continue
    const name = kept.length === 1 ? 'APA' : `APA · group ${g + 1}`

    let values = observed.values
    let centre: number | undefined
    let label = `${name} · raw`
    if (norm === 'matched') {
      const control = controls[g].finish()
      if (control.n > 0) {
        values = ratioOf(observed.values, control.values)
        centre = 1
        label = `${name} · over distance-matched control`
      } else {
        job.note('No control window could be placed, so the raw pileup is shown.')
      }
    } else if (norm === 'oe' && curve !== null) {
      values = overExpected(observed.values, side, curve)
      centre = 1
      label = `${name} · observed / expected`
    }

    outputs.push({
      kind: 'matrix',
      id: `apa-${g}`,
      label,
      nrows: side,
      ncols: side,
      values,
      xLabel: isScaled(job.params) ? 'Scaled position' : 'Bins from the centre',
      yLabel: isScaled(job.params) ? 'Scaled position' : 'Bins from the centre',
      xTicks: [],
      yTicks: [],
      colormap: centre === undefined ? 'default' : DEFAULT_DIVERGING_COLORMAP,
      ...(centre === undefined ? {} : { centre }),
      stats: [
        { label: 'windows', value: observed.n, digits: 0, hint: 'Anchors that contributed.' },
        {
          label: 'P2LL',
          value: p2ll(values, side, side),
          digits: 2,
          hint: 'Centre against the lower-left corner. Above 1 is enrichment.',
        },
      ],
    } satisfies MatrixOutput)
  }

  if (perAnchor.length > 0) {
    perAnchor.sort((a, b) => (Number.isNaN(b.score) ? -1 : b.score) - (Number.isNaN(a.score) ? -1 : a.score))
    outputs.push({
      kind: 'table',
      id: 'apa-anchors',
      label: 'Per anchor',
      columns: [
        { key: 'anchor', label: 'Anchor', kind: 'text' },
        { key: 'separation', label: 'Separation (bp)', kind: 'number', digits: 0 },
        { key: 'score', label: 'P2LL', kind: 'number', digits: 3 },
      ],
      rows: perAnchor.map((row) => ({
        anchor: row.label,
        separation: row.separation,
        score: row.score,
      })),
    } satisfies TableOutput)
  }
  return outputs
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

interface Anchor {
  pair: AnchorPair
  bounds: Span
  label: string
  rank: number
  /** Bins the feature spans, for the scaled mode. */
  span: number
}

function pairAnchors(job: JobContext, set: PairSet): Anchor[] {
  const out: Anchor[] = []
  for (let i = 0; i < set.length; i++) {
    const a = binOf(job, set.contigs[set.contig1[i]], set.start1[i], set.end1[i])
    const b = binOf(job, set.contigs[set.contig2[i]], set.start2[i], set.end2[i])
    // Both anchors on one sequence, because a pileup off the diagonal between
    // two *different* sequences is a trans pileup and a different question — one
    // no loop caller emits and no APA convention describes.
    if (a === null || b === null || a.contig !== b.contig) continue
    const row = Math.min(a.bin, b.bin)
    const col = Math.max(a.bin, b.bin)
    out.push({
      pair: { row, col, separation: col - row },
      bounds: a.bounds,
      label: set.name[i] === '' ? `${set.contigs[set.contig1[i]]}:${set.start1[i]}` : set.name[i],
      rank: set.score[i],
      span: col - row,
    })
  }
  return out
}

function featureAnchors(job: JobContext, set: FeatureSet): Anchor[] {
  const out: Anchor[] = []
  for (let i = 0; i < set.length; i++) {
    const at = binOf(job, set.contigs[set.contig[i]], set.start[i], set.end[i])
    if (at === null) continue
    const span = Math.max(1, job.toBins(set.end[i] - set.start[i]))
    out.push({
      pair: { row: at.bin, col: at.bin, separation: 0 },
      bounds: at.bounds,
      label: set.name[i] === '' ? `${set.contigs[set.contig[i]]}:${set.start[i]}` : set.name[i],
      rank: set.score[i],
      span,
    })
  }
  return out
}

/** The bin an interval's centre falls in, and the sequence's bin bounds. */
function binOf(
  job: JobContext,
  contig: string,
  start: number,
  end: number,
): { bin: number; bounds: Span; contig: string } | null {
  if (!job.mc.hasContig(contig)) return null
  const cid = job.mc.contigId(contig)
  const [from, to] = job.mc.contigExtent(cid)
  const bin = job.mc.coords.binIndex(cid, Math.round((start + end) / 2))
  if (bin < from || bin >= to) return null
  return { bin, bounds: { from, to }, contig }
}

/** The anchor groups a run draws, after ranking and subsetting. */
function groupAnchors(job: JobContext, anchors: Anchor[], set: FeatureSet | null): Anchor[][] {
  const rankBy = idParam(job.params, 'rankBy')
  const subset = strParam(job.params, 'subset', 'all')
  if (rankBy === null || subset === 'all' || set === null) return [anchors]

  const ranked = rankBy === 'score' ? anchors : withDetailRank(anchors, set, rankBy)
  const sorted = [...ranked].sort((a, b) => {
    if (Number.isNaN(a.rank)) return Number.isNaN(b.rank) ? 0 : 1
    if (Number.isNaN(b.rank)) return -1
    return b.rank - a.rank
  })
  if (subset === 'top') {
    return [sorted.slice(0, Math.max(1, Math.round(numParam(job.params, 'count', 500))))]
  }
  const groups = Math.max(2, Math.round(numParam(job.params, 'groups', 4)))
  const size = Math.ceil(sorted.length / groups)
  const out: Anchor[][] = []
  for (let g = 0; g < groups; g++) {
    const slice = sorted.slice(g * size, (g + 1) * size)
    if (slice.length > 0) out.push(slice)
  }
  return out
}

/** The ranking column, dug out of the `detail` string a parser joined. */
function withDetailRank(anchors: Anchor[], set: FeatureSet, column: string): Anchor[] {
  return anchors.map((anchor, i) => {
    for (const part of (set.detail[i] ?? '').split(DETAIL_SEP)) {
      const at = part.search(/[=:]/)
      if (at < 0) continue
      if (part.slice(0, at).trim() !== column) continue
      const value = Number.parseFloat(part.slice(at + 1).trim())
      return { ...anchor, rank: Number.isFinite(value) ? value : Number.NaN }
    }
    return { ...anchor, rank: Number.NaN }
  })
}

// ---------------------------------------------------------------------------
// Windows and reads
// ---------------------------------------------------------------------------

/** The rectangle one anchor's window covers, clamped to its sequence. */
function rectFor(job: JobContext, anchor: Anchor, side: number): Rect | null {
  const { from, to } = anchor.bounds
  if (isScaled(job.params)) {
    const flank = Math.round(anchor.span * numParam(job.params, 'flankFraction', 0.5))
    const rowFrom = anchor.pair.row - flank
    const rowTo = anchor.pair.row + (anchor.pair.separation === 0 ? anchor.span : 0) + flank
    const colFrom = anchor.pair.col - flank
    const colTo = anchor.pair.col + (anchor.pair.separation === 0 ? anchor.span : 0) + flank
    if (rowFrom < from || colTo > to || rowTo <= rowFrom || colTo <= colFrom) return null
    return { rowFrom, rowTo, colFrom, colTo }
  }
  const half = (side - 1) / 2
  const rect = {
    rowFrom: anchor.pair.row - half,
    rowTo: anchor.pair.row + half + 1,
    colFrom: anchor.pair.col - half,
    colTo: anchor.pair.col + half + 1,
  }
  // Clipped windows are dropped rather than padded. A pileup is an average over
  // identically shaped things, and half a window averaged into the middle of the
  // picture is signal in the wrong cells.
  if (rect.rowFrom < from || rect.colTo > to) return null
  return rect
}

function spanOf(plan: Plan): Span {
  return { from: Math.min(plan.rect.rowFrom, plan.rect.colFrom), to: Math.max(plan.rect.rowTo, plan.rect.colTo) }
}

/** Windows near each other on both axes, gathered into one read. */
function coalesce(plans: Plan[]): Array<{ rect: Rect; plans: Plan[] }> {
  const sorted = [...plans].sort((a, b) => a.rect.rowFrom - b.rect.rowFrom || a.rect.colFrom - b.rect.colFrom)
  const out: Array<{ rect: Rect; plans: Plan[] }> = []
  for (const plan of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined) {
      const merged = {
        rowFrom: Math.min(last.rect.rowFrom, plan.rect.rowFrom),
        rowTo: Math.max(last.rect.rowTo, plan.rect.rowTo),
        colFrom: Math.min(last.rect.colFrom, plan.rect.colFrom),
        colTo: Math.max(last.rect.colTo, plan.rect.colTo),
      }
      if (merged.rowTo - merged.rowFrom <= MERGE_CAP_BINS && merged.colTo - merged.colFrom <= MERGE_CAP_BINS) {
        last.rect = merged
        last.plans.push(plan)
        continue
      }
    }
    out.push({ rect: { ...plan.rect }, plans: [plan] })
  }
  return out
}

interface Dense {
  values: Float32Array
  nrows: number
  ncols: number
}

async function readRect(
  job: JobContext,
  rect: Rect,
  options: { block: ReturnType<typeof usableBlock>; balance: boolean; value: string },
): Promise<Dense> {
  if (options.block !== null) {
    const block = options.block
    const nrows = rect.rowTo - rect.rowFrom
    const ncols = rect.colTo - rect.colFrom
    const values = new Float32Array(nrows * ncols)
    for (let r = 0; r < nrows; r++) {
      const at = (rect.rowFrom - block.rowExtent[0] + r) * block.ncols + (rect.colFrom - block.colExtent[0])
      values.set(block.values.subarray(at, at + ncols), r * ncols)
    }
    return { values, nrows, ncols }
  }
  const dense = await job.mc.matrix({
    rows: [rect.rowFrom, rect.rowTo],
    cols: [rect.colFrom, rect.colTo],
    balance: options.balance,
    value: options.value,
  })
  return { values: dense.values, nrows: dense.nrows, ncols: dense.ncols }
}

/** One window out of a coalesced read, resampled to the pileup's shape. */
function cut(dense: Dense, read: Rect, want: Rect, side: number): Float64Array | null {
  const rows = want.rowTo - want.rowFrom
  const cols = want.colTo - want.colFrom
  if (rows <= 0 || cols <= 0) return null
  const rowSkip = want.rowFrom - read.rowFrom
  const colSkip = want.colFrom - read.colFrom
  if (rowSkip < 0 || colSkip < 0 || rowSkip + rows > dense.nrows || colSkip + cols > dense.ncols) {
    return null
  }
  const cutOut = new Float32Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    const at = (rowSkip + r) * dense.ncols + colSkip
    cutOut.set(dense.values.subarray(at, at + cols), r * cols)
  }
  return resampleWindow(cutOut, rows, cols, side, side)
}

// ---------------------------------------------------------------------------
// Observed over expected
// ---------------------------------------------------------------------------

/**
 * Feed the read block into the expected curve.
 *
 * Only what was read, which is exactly the point: the offsets an APA needs are
 * the ones its own windows span, and those cells are already in hand. A
 * genome-wide P(s) would be a whole scan to divide fifty diagonals by.
 */
function accumulateExpected(accumulator: ExpectedAccumulator, dense: Dense, rect: Rect): void {
  accumulator.addBlock({
    nrows: dense.nrows,
    ncols: dense.ncols,
    values: dense.values,
    rowExtent: [rect.rowFrom, rect.rowTo],
    colExtent: [rect.colFrom, rect.colTo],
  })
}

/**
 * The pileup divided by the expected at each cell's own diagonal offset.
 *
 * The offset of a *pileup* cell is not the offset of the matrix cell it came
 * from — a pileup is many windows at many separations averaged together — so the
 * division is by the offset relative to the pileup's centre, which is the
 * convention every published APA uses and the only one that is the same for
 * every contributing window.
 */
function overExpected(
  values: Float32Array,
  side: number,
  curve: ReturnType<ExpectedAccumulator['finish']>,
): Float32Array {
  const out = new Float32Array(values.length)
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const offset = Math.abs(c - r)
      const denominator = expectedAt(curve, offset)
      const observed = values[r * side + c]
      out[r * side + c] =
        Number.isFinite(observed) && Number.isFinite(denominator) && denominator !== 0
          ? observed / denominator
          : Number.NaN
    }
  }
  return out
}

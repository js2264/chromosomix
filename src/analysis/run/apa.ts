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
 *
 * **The domain pileup is the third window shape and the one with a body.** A set
 * of TADs — intervals between two called boundaries — piled up in the scaled
 * mode gives the picture everybody draws next to a loop APA: the domain as the
 * square in the middle, its two boundaries as the cross through it, and the
 * neighbouring domains in the corners. Three things make it that picture rather
 * than a plausible smear, and each is written where it happens: the window is
 * `[start − fL, end + fL]` on **both axes** so the body is centred
 * ({@link planFor}); the body's two ends are pinned to their **own grid lines**
 * for every domain whatever its length ({@link cut}); and a distance-matched
 * control is shifted by a **multiple of the window** rather than by a length in
 * base pairs, because a control 100 kb from a megabase-wide window is mostly the
 * window.
 */

import type { FeatureSet, PairSet } from '../../annotations/types'
import { DETAIL_SEP } from '../../annotations/types'
import { contextOf, type NameContext } from '../../genome/naming'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import {
  PileupAccumulator,
  domainScore,
  p2ll,
  ratioOf,
  resampleWindow,
  resampleWindowTo,
  scaledEdges,
  scaledLayout,
  shiftedControls,
  type AnchorPair,
  type ScaledLayout,
} from '../apa'
import { ExpectedAccumulator, expectedAt } from '../expected'
import {
  boolParam,
  chosenInput,
  contigIdFor,
  idParam,
  missingInput,
  numParam,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { makeRandom } from '../random'
import {
  flankFractionOf,
  isChromosight,
  isDomainPileup,
  isScaled,
  onDiagonal,
  windowBins,
} from '../tasks/apa'
import type { MatrixOutput, TableOutput, TaskOutput } from '../types'
import { chromosightPileup } from './apaChromosight'
import { usableBlock, type Span } from './blocks'

/** A rectangle of the matrix, in absolute bins. */
interface Rect {
  rowFrom: number
  rowTo: number
  colFrom: number
  colTo: number
}

/**
 * Where a scaled window's body sits, in absolute bins.
 *
 * Carried on the plan rather than recomputed at cut time because the *control*
 * windows have a body too — the same length as the anchor they were drawn from,
 * shifted with it — and a control resampled on a different layout from the real
 * window it is the denominator of would divide two different pictures.
 */
interface Body {
  from: number
  to: number
  /** Flank each side, in bins. Fractional, so every body lands on one grid line. */
  pad: number
}

/** One window to pile up, and what it came from. */
interface Plan {
  rect: Rect
  /** For the per-anchor table; absent for a control. */
  label?: string
  separation: number
  control: boolean
  group: number
  /** The scaled on-diagonal layout this window is resampled on; absent otherwise. */
  body?: Body
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
  // By the **parameter key** — `pairs` or `features`, whichever mode is in
  // force — and never by the entry id in `params`; see `chosenInput`.
  const heldPairs = chosenInput(job.inputs.pairs, job.params, 'pairs')
  const heldFeatures = chosenInput(job.inputs.features, job.params, 'features')
  const pairs = usingPairs ? heldPairs.value : undefined
  const features = usingPairs ? undefined : heldFeatures.value
  if (pairs === undefined && features === undefined) {
    // Named rather than returned empty. A task that finishes in a millisecond
    // with no figure and no sentence is indistinguishable from one that is
    // broken, and this is the commonest way to reach that state: the drawer
    // opens on a task whose input has not been chosen yet.
    job.note(
      missingInput(usingPairs ? heldPairs : heldFeatures, {
        unchosen: usingPairs
          ? 'No loop set was chosen. Load a BEDPE — a loop table, a set of anchor pairs — and pick it under Pairs.'
          : 'No feature set was chosen. Load a BED or a GTF and pick it under Features.',
        gone: `The ${usingPairs ? 'loop' : 'feature'} set chosen is no longer loaded. Re-open the file, or pick another.`,
      }) ?? '',
    )
    return []
  }

  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const side = isScaled(job.params)
    ? Math.max(11, Math.round(numParam(job.params, 'grid', 51)))
    : windowBins(job.params) * 2 + 1
  const norm = strParam(job.params, 'norm', 'matched')

  const anchors = usingPairs
    ? pairAnchors(job, pairs as PairSet)
    : featureAnchors(job, features as FeatureSet)
  if (anchors.length === 0) {
    job.note('No anchor of this set lands inside a sequence this file has, so there is nothing to pile up.')
    return []
  }

  // The chromosight pileup is a different computation over the same anchors —
  // the map is detrended before anything is cut out of it, so it reads whole
  // sequences rather than windows — and it answers with its own three outputs.
  // Branching here rather than at the top is deliberate: the anchor resolution
  // above, including §5.9's naming, is shared and must stay shared.
  if (isChromosight(job.params)) {
    return chromosightPileup(
      job,
      anchors.map((anchor) => ({
        row: anchor.pair.row,
        col: anchor.pair.col,
        bounds: anchor.bounds,
        label: anchor.label,
      })),
    )
  }

  // Every anchor of every group. There used to be a cap here, and it was not a
  // budget so much as a silent change of subject: a pileup of the first five
  // thousand anchors is a pileup of whichever ones sorted first, under a caption
  // saying how many were left out — which nobody compares across two runs.
  const kept = groupAnchors(job, anchors, usingPairs ? null : (features as FeatureSet))

  // The grid's own division into flank, body, flank — one layout for the whole
  // run, which is what puts every domain's two boundaries on the same two grid
  // lines however long the domain is. Unused off the diagonal and in the fixed
  // mode, where a window has no body.
  const layout = scaledLayout(side, flankFractionOf(job.params))
  const scaledWindows = isScaled(job.params)
  const scaledDomains = isDomainPileup(job.params)

  const plans: Plan[] = []
  const rng = makeRandom(Math.round(numParam(job.params, 'seed', 1)))
  const controlsPer = norm === 'matched' ? Math.max(1, Math.round(numParam(job.params, 'controls', 5))) : 0
  const minShift = job.toBins(numParam(job.params, 'minShift', 100_000))
  const maxShift = Math.max(minShift, job.toBins(numParam(job.params, 'maxShift', 1_000_000)))
  const minShiftScale = Math.max(0, numParam(job.params, 'minShiftScale', 1))
  const maxShiftScale = Math.max(minShiftScale, numParam(job.params, 'maxShiftScale', 3))

  for (let g = 0; g < kept.length; g++) {
    for (const anchor of kept[g]) {
      const plan = planFor(job, anchor, side, layout)
      if (plan === null) continue
      plans.push({ ...plan, label: anchor.label, separation: anchor.pair.separation, control: false, group: g })
      if (controlsPer === 0) continue
      // **The shift is a multiple of the window in the scaled mode and a length
      // in base pairs in the fixed one**, and the difference is not a
      // convenience. A domain pileup's window is as wide as the domain plus its
      // flanks — often a megabase — so a control drawn 100 kb away is ninety per
      // cent the same cells as the thing it is the denominator of, and the ratio
      // it produces is 1 everywhere with the domain washed out of it. A fixed
      // window is a couple of dozen bins and a shift in base pairs is exactly
      // the right way to ask.
      const width = scaledWindows ? Math.max(1, widthOf(plan.rect)) : 0
      const from = scaledWindows ? Math.round(width * minShiftScale) : minShift
      const to = scaledWindows ? Math.max(from, Math.round(width * maxShiftScale)) : maxShift
      for (const control of shiftedControls(anchor.pair, anchor.bounds, {
        perPair: controlsPer,
        minShift: from,
        maxShift: to,
        rng,
      })) {
        const controlPlan = planFor(job, shiftAnchor(anchor, control), side, layout)
        if (controlPlan !== null) {
          plans.push({ ...controlPlan, separation: control.separation, control: true, group: g })
        }
      }
    }
  }
  if (plans.length === 0) {
    job.note('Every window ran off the end of its sequence. Use a narrower window.')
    return []
  }

  // **Observed/expected has no meaning on a scaled grid**, and the estimate
  // refuses the combination before Run rather than here. This is the stored
  // session that names it anyway: one cell of a scaled pileup is fed by windows
  // at a dozen different separations — that is what scaling *is* — so there is
  // no single diagonal offset to divide it by, and dividing it by one anyway
  // produced a plausible picture of nothing. Said out loud and the raw pileup
  // shown, which is the honest half of what was asked for.
  const oeOnAScaledGrid = norm === 'oe' && isScaled(job.params)
  if (oeOnAScaledGrid) {
    job.note(
      'Observed / expected is not available in the scaled mode: every window contributes cells ' +
        'at a different separation to the same cell of the picture, so a pileup cell has no one ' +
        'diagonal offset to divide by. The raw pileup is shown — use the distance-matched ' +
        'control, which is drawn at the same separations by construction.',
    )
  }

  const real = kept.map(() => new PileupAccumulator(side, side))
  const controls = kept.map(() => new PileupAccumulator(side, side))
  const expected = new ExpectedAccumulator(job.mc.nBins)
  const perAnchor: Array<{ label: string; separation: number; score: number }> = []

  const block = usableBlock(job, plans.map(spanOf), balance)
  const batches = coalesce(plans)
  let done = 0

  for (const batch of batches) {
    // The pileup is arithmetic over windows already in hand, so nothing below
    // returns to the event loop on its own and a cancel would sit in the queue
    // until the last batch had been summed. See `analysis/job.ts`.
    await job.breathe()
    job.progress(done, plans.length, `${done.toLocaleString()} of ${plans.length.toLocaleString()} windows`)
    const dense = await readRect(job, batch.rect, { block, balance, value })
    // Once per *read*, not once per window: a coalesced block covers several
    // windows, and feeding it in per window would count every one of its cells
    // as many times as the batch is large — which would leave the mean intact
    // and the counts, and therefore nothing visible, wrong.
    if (norm === 'oe' && !oeOnAScaledGrid) accumulateExpected(expected, dense, batch.rect)
    for (const plan of batch.plans) {
      done++
      // Every window that could be cut is summed, however little of it carries
      // a value. There used to be a minimum here, and what it dropped was the
      // windows in the sparsest regions — which are exactly the ones a weak
      // pileup is weak because of, so removing them made every pileup look
      // better than the data. `PileupAccumulator` counts per cell, so a
      // half-empty window contributes what it has and nothing more.
      const window = cut(dense, batch.rect, plan, side, layout)
      if (window === null) continue
      if (plan.control) {
        controls[plan.group].add(window)
        continue
      }
      real[plan.group].add(window)
      if (plan.label !== undefined) {
        perAnchor.push({
          label: plan.label,
          separation: plan.separation * job.mc.binsize,
          score: scaledDomains ? domainScore(window, layout) : p2ll(window, side, side),
        })
      }
    }
  }
  job.progress(plans.length, plans.length, 'Done')
  job.throwIfCancelled()

  const outputs: TaskOutput[] = []
  const curve = norm === 'oe' && !oeOnAScaledGrid ? expected.finish() : null

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

    const axis = isScaled(job.params)
      ? scaledDomains
        ? `Position along the feature (0 → 1), flanked by ${flankFractionOf(job.params)}×`
        : 'Scaled position'
      : 'Bins from the centre'
    const ticks = scaledDomains ? scaledTickLabels(layout, flankFractionOf(job.params)) : []

    outputs.push({
      kind: 'matrix',
      id: `apa-${g}`,
      label,
      nrows: side,
      ncols: side,
      values,
      xLabel: axis,
      yLabel: axis,
      xTicks: ticks,
      yTicks: ticks,
      colormap: centre === undefined ? 'default' : DEFAULT_DIVERGING_COLORMAP,
      ...(centre === undefined ? {} : { centre }),
      stats: [
        { label: 'windows', value: observed.n, digits: 0, hint: 'Anchors that contributed.' },
        scaledDomains
          ? {
              label: 'in / out',
              value: domainScore(values, layout),
              digits: 2,
              hint:
                'The domain’s own corner against the same block across its boundary. ' +
                'Above 1 means contact stops at the edge.',
            }
          : {
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
        { key: 'score', label: scaledDomains ? 'In / out' : 'P2LL', kind: 'number', digits: 3 },
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
  /**
   * The rows and columns a *scaled* window's body covers, half-open, in bins.
   *
   * The feature's own bins on both axes for an on-diagonal anchor — which is
   * what makes the domain land in the middle of the picture rather than in the
   * corner of it — and the single anchor bin on each axis for a pair, whose
   * scaled window is a square about the loop and has no body to resample.
   */
  rows: Span
  cols: Span
}

function pairAnchors(job: JobContext, set: PairSet): Anchor[] {
  const out: Anchor[] = []
  // The set's own list is what says how *it* spells sequences, and a `.bedpe`
  // loaded against a `chr1` lead is walked here against whichever panel of the
  // deck this job is running on (§18.2). Computed once per set, not per row.
  const from = contextOf(set.contigs)
  for (let i = 0; i < set.length; i++) {
    const a = binOf(job, set.contigs[set.contig1[i]], set.start1[i], set.end1[i], from)
    const b = binOf(job, set.contigs[set.contig2[i]], set.start2[i], set.end2[i], from)
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
      rows: { from: row, to: row + 1 },
      cols: { from: col, to: col + 1 },
    })
  }
  return out
}

function featureAnchors(job: JobContext, set: FeatureSet): Anchor[] {
  const out: Anchor[] = []
  const from = contextOf(set.contigs)
  for (let i = 0; i < set.length; i++) {
    const at = binOf(job, set.contigs[set.contig[i]], set.start[i], set.end[i], from)
    if (at === null) continue
    out.push({
      pair: { row: at.bin, col: at.bin, separation: 0 },
      bounds: at.bounds,
      label: set.name[i] === '' ? `${set.contigs[set.contig[i]]}:${set.start[i]}` : set.name[i],
      rank: set.score[i],
      // The feature's **own bins**, not `round(length / binsize)`. The two differ
      // by one wherever an interval straddles a bin edge, and the difference is
      // not academic here: the body is what the scaled window is centred on and
      // resampled against, so a span taken from the length and a centre taken
      // from the midpoint disagree about where the feature is by up to a bin.
      span: at.body.to - at.body.from,
      rows: at.body,
      cols: at.body,
    })
  }
  return out
}

/**
 * The bin an interval's centre falls in, and the sequence's bin bounds.
 *
 * `named` is the naming context of the *set* the interval came out of, so a BED
 * of `chr1` loci resolves against a file that writes `1` (§5.9). The sequence
 * comes back under **this file's** spelling rather than the set's, which is what
 * makes the two anchors of a pair comparable: two names that resolve to one
 * sequence are one sequence, and comparing the strings would call them cis and
 * trans by turns.
 */
function binOf(
  job: JobContext,
  contig: string,
  start: number,
  end: number,
  named?: NameContext,
): { bin: number; body: Span; bounds: Span; contig: string } | null {
  const cid = contigIdFor(job.mc, contig, named)
  if (cid < 0) return null
  const [from, to] = job.mc.contigExtent(cid)
  const bin = job.mc.coords.binIndex(cid, Math.round((start + end) / 2))
  if (bin < from || bin >= to) return null
  // The bins the interval itself covers, clamped to the sequence and never
  // empty: a feature narrower than one bin is one bin, since that is the finest
  // thing this file can say about where it is.
  const first = clamp(job.mc.coords.binIndex(cid, Math.max(0, Math.min(start, end))), from, to - 1)
  const last = clamp(job.mc.coords.binIndex(cid, Math.max(0, Math.max(start, end) - 1)), first, to - 1)
  return {
    bin,
    body: { from: first, to: last + 1 },
    bounds: { from, to },
    contig: job.mc.chromnames[cid],
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
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

/**
 * The window one anchor gets: the rectangle to read, and where its body sits.
 *
 * Three shapes, and the middle one is the whole of this change.
 *
 * **Fixed** is the centre bin plus or minus a half-width, on both axes.
 *
 * **Scaled, on the diagonal** — a *domain* pileup — is the feature's own bins
 * with a flank each side, on both axes: `[start − fL, end + fL]²`, so the domain
 * is the square in the middle of the picture and its two boundaries are the
 * cross through it. It used to be `[centre − fL, centre + L + fL]`, which is the
 * same width and half a domain to the right of where it belongs: the body sat
 * against the top-left corner with the whole flank on the far side, and a set of
 * real TADs piled up into a picture with the domain in the wrong place and no
 * way to tell from the figure.
 *
 * **Scaled, off the diagonal** is a square about each anchor whose side is a
 * fraction of the separation — the rectangle between two anchors, which is what
 * the reader asked for when they said the window should scale with the loop.
 *
 * The pad is deliberately **fractional**: the read is whole bins, but the grid
 * lines the body is resampled onto are `start` and `end` exactly, so a 17-bin
 * domain and a 431-bin one put their boundaries on the same two columns instead
 * of within half a bin of them.
 */
function planFor(
  job: JobContext,
  anchor: Anchor,
  side: number,
  layout: ScaledLayout,
): { rect: Rect; body?: Body } | null {
  const { from, to } = anchor.bounds
  if (isScaled(job.params)) {
    // Nothing to scale *by*: a pair whose two anchors land in the same bin has
    // no separation for the window to be a fraction of, and a window of one bin
    // stretched over the grid is a flat square averaged in as though it were
    // evidence. Dropped, as it was before there was a body.
    if (anchor.span <= 0) return null
    // No flank cells on the grid means no flank read: a reader who asked for
    // none gets the body, not a band of bins that is read and then dropped.
    const pad = layout.flank === 0 ? 0 : anchor.span * flankFractionOf(job.params)
    const rect = {
      rowFrom: Math.floor(anchor.rows.from - pad),
      rowTo: Math.ceil(anchor.rows.to + pad),
      colFrom: Math.floor(anchor.cols.from - pad),
      colTo: Math.ceil(anchor.cols.to + pad),
    }
    if (rect.rowFrom < from || rect.colTo > to) return null
    if (rect.rowTo <= rect.rowFrom || rect.colTo <= rect.colFrom) return null
    // Only the on-diagonal window has a body to resample against, and it is the
    // *mode* that says so rather than the separation: a pair's two anchors can
    // fall in one bin, and reading that as "on the diagonal" would resample a
    // loop window against a body one bin wide.
    if (!isDomainPileup(job.params)) return { rect }
    return { rect, body: { from: anchor.rows.from, to: anchor.rows.to, pad } }
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
  return { rect }
}

/** One anchor moved to where a control landed, body and all. */
function shiftAnchor(anchor: Anchor, control: AnchorPair): Anchor {
  const delta = control.row - anchor.pair.row
  return {
    ...anchor,
    pair: control,
    rows: { from: anchor.rows.from + delta, to: anchor.rows.to + delta },
    cols: { from: anchor.cols.from + delta, to: anchor.cols.to + delta },
  }
}

/** The widest side of a rectangle, in bins. */
function widthOf(rect: Rect): number {
  return Math.max(rect.rowTo - rect.rowFrom, rect.colTo - rect.colFrom)
}

/**
 * The axis labels for a scaled on-diagonal grid, in units of the feature.
 *
 * Five of them, evenly spaced, because that is what a matrix output's ticks are
 * — one label per fraction `i / 4` of the axis.
 *
 * **The axis is piecewise, not linear, and reading it as linear is wrong by a
 * cell.** The grid gives the flank a whole number of cells and the body what is
 * left, and those two counts are not in the ratio the flank fraction is — a
 * 41-cell grid at half a body each side is 10, 21, 10 — so a cell of flank and a
 * cell of body are different lengths of feature. The map is therefore three
 * straight lines meeting at the two boundaries, which is exactly how the window
 * was resampled ({@link scaledEdges}); the ends come out at `−f` and `1 + f`
 * because that is where they are.
 */
function scaledTickLabels(layout: ScaledLayout, flankFraction: number): string[] {
  if (layout.flank === 0) return ['0', '0.25', '0.5', '0.75', '1']
  const bodyStart = layout.flank / layout.side
  const bodyEnd = (layout.flank + layout.body) / layout.side
  const at = (fraction: number): number => {
    if (fraction <= bodyStart) return -flankFraction * (1 - fraction / bodyStart)
    if (fraction >= bodyEnd) return 1 + (flankFraction * (fraction - bodyEnd)) / (1 - bodyEnd)
    return (fraction - bodyStart) / (bodyEnd - bodyStart)
  }
  // `Number(...)` rather than the fixed string, so `1.00` reads as `1` and a
  // rounded `-0.00` reads as `0` rather than as a minus sign nobody can explain.
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => String(Number(at(fraction).toFixed(2))))
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

/**
 * One window out of a coalesced read, resampled to the pileup's shape.
 *
 * Two resamplings, and which one runs is decided by whether the plan has a
 * **body**. Without one the window is stretched evenly onto the grid, which is
 * right for a fixed window (it is already the right size) and for a scaled pair
 * (a square about the loop, with nothing inside it that has to land anywhere in
 * particular). With one — a domain — the grid is flank, body, flank and the
 * body's two ends are pinned to their own grid lines, so every domain in the set
 * contributes its boundary to the same column.
 */
function cut(
  dense: Dense,
  read: Rect,
  plan: Plan,
  side: number,
  layout: ScaledLayout,
): Float64Array | null {
  const want = plan.rect
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
  if (plan.body === undefined) return resampleWindow(cutOut, rows, cols, side, side)
  // In cells of this window rather than absolute bins, which is what the edges
  // are measured in.
  const edges = scaledEdges(
    layout,
    plan.body.from - want.rowFrom,
    plan.body.to - want.rowFrom,
    plan.body.pad,
  )
  return resampleWindowTo(cutOut, rows, cols, edges, edges)
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

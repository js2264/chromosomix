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
 *
 * **A window is cut as coolpuppy cuts one**, because coolpuppy is what these
 * pileups are held to (§18.10) and the two parted company wherever a window
 * reached the diagonal. Nothing is taken from below it: the map read here is
 * drawn whole, both triangles, so a loop window crossing the diagonal used to
 * pile up the cells below it — contacts it already held above, mirrored — and
 * coolpuppy's, cut from the upper triangle, left them out, which on a real loop
 * set was ten per cent in the cells nearest the diagonal. The first
 * {@link minDiagOf} diagonals are left out as well, at coolpuppy's default of
 * two. And observed / expected divides **each window, cell by cell**, by its
 * sequence's own expected at that cell's own diagonal, then averages — see
 * {@link cut} for what it did before, which was not that.
 */

import type { FeatureSet, PairSet } from '../../annotations/types'
import { DETAIL_SEP } from '../../annotations/types'
import { formatPosition } from '../../genome/assembly'
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
import {
  boolParam,
  chosenInput,
  contigIdFor,
  idParam,
  listParam,
  missingInput,
  numParam,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { loopSpectrum } from '../loopSpectrum'
import { makeRandom } from '../random'
import {
  anchorAt,
  flankFractionOf,
  isChromosight,
  isDomainPileup,
  autoMinDist,
  isScaled,
  minDiagOf,
  minDistOf,
  onDiagonal,
  poolsAnchors,
  usesPairSet,
  allPairs,
  distanceBins,
  MAX_GENERATED_PAIRS,
  windowBins,
} from '../tasks/apa'
import type { MarginProfile, MatrixOutput, TableOutput, TaskOutput } from '../types'
import { chromosightPileup } from './apaChromosight'
import { diagonalMeans, usableBlock, type Span } from './blocks'
import { offsetTicks } from './labels'

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
  /** The sequence the window is on, in absolute bins: whose expected it takes. */
  bounds: Span
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
  // Which **input** the run reads, which since the third anchor mode is no
  // longer the same question as which side of the diagonal it draws on: *every
  // pair* reads a feature set and its windows are off the diagonal.
  const usingPairs = usesPairSet(job.params)
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

  const madePairs = allPairs(job.params)
  const anchors = usingPairs
    ? pairAnchors(job, pairs as PairSet)
    : madePairs
      ? generatedPairs(job, features as FeatureSet)
      : featureAnchors(job, features as FeatureSet)
  if (anchors.length === 0) {
    job.note(
      madePairs
        ? 'No two features of this set are on one sequence within the separation range, so there ' +
            'is no pair to pile up. Widen the range, or check that the set and the file spell ' +
            'their sequences alike.'
        : 'No anchor of this set lands inside a sequence this file has, so there is nothing to pile up.',
    )
    return []
  }
  if (madePairs) {
    job.note(
      `${anchors.length.toLocaleString()} pairs made from ` +
        `${(features as FeatureSet).length.toLocaleString()} features.`,
    )
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

  // **The one floor a loop set has, and it is coolpuppy's**: a loop nearer the
  // diagonal than the nearest loop (`minDist`) is left out, and by default that
  // is twice the half-width and two bins — coolpuppy's `mindist='auto'` — which
  // is where a window stops reaching the diagonals it would have gaps cut in. It
  // is a floor on *where* a loop is, not a sample of the set, and it is said:
  // how many, how near, and how to have them all.
  const piled = usingPairs && !isScaled(job.params) ? nearEnough(job, anchors) : anchors
  if (piled.length === 0) return []

  // Every anchor of every group. There used to be a cap here, and it was not a
  // budget so much as a silent change of subject: a pileup of the first five
  // thousand anchors is a pileup of whichever ones sorted first, under a caption
  // saying how many were left out — which nobody compares across two runs.
  // Two ways of dividing the same anchors, and never both at once: N separation
  // bins crossed with K rank groups is N×K panels nobody reads, and neither
  // division means anything once it has been taken inside the other. Separation
  // wins where it is asked for, and the form hides the ranking controls off the
  // diagonal in any case.
  const bins = distanceBins(job.params)
  const kept =
    bins > 1
      ? bySeparation(piled, bins)
      : groupAnchors(job, piled, onDiagonal(job.params) ? (features as FeatureSet) : null)
  const groupNames = bins > 1 ? separationNames(kept, (span) => job.toBp(span)) : null

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
  // Bins in, bins out: `shiftedControls` has always wanted a bin offset, and the
  // form asks for one now, so the `toBins` that used to sit here is gone rather
  // than moved (§18.2).
  const minShift = Math.max(0, Math.round(numParam(job.params, 'minShift', 50)))
  const maxShift = Math.max(minShift, Math.round(numParam(job.params, 'maxShift', 500)))
  const minShiftScale = Math.max(0, numParam(job.params, 'minShiftScale', 1))
  const maxShiftScale = Math.max(minShiftScale, numParam(job.params, 'maxShiftScale', 3))

  for (let g = 0; g < kept.length; g++) {
    for (const anchor of kept[g]) {
      const plan = planFor(job, anchor, side, layout)
      if (plan === null) continue
      plans.push({
        ...plan,
        label: anchor.label,
        separation: anchor.pair.separation,
        control: false,
        group: g,
        bounds: anchor.bounds,
      })
      if (controlsPer === 0) continue
      // **The shift is a multiple of the window in the scaled mode and a count
      // of bins in the fixed one**, and the difference is not a convenience. A
      // domain pileup's window is as wide as the domain plus its flanks — often
      // a thousand bins — so a control drawn fifty bins away is ninety per cent
      // the same cells as the thing it is the denominator of, and the ratio it
      // produces is 1 everywhere with the domain washed out of it. A fixed
      // window is a couple of dozen bins, and there a count of bins is exactly
      // the right way to ask: it is the same window at every resolution.
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
          plans.push({
            ...controlPlan,
            separation: control.separation,
            control: true,
            group: g,
            bounds: anchor.bounds,
          })
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
  // The tracks whose aggregate is drawn along the pileup's two edges, and one
  // running mean per group, per track, per axis. Empty where none was chosen,
  // which is every run this task has ever done until now.
  const tracks = marginTracks(job)
  const alongRows = kept.map(() => tracks.map(() => new PileupAccumulator(1, side)))
  const alongCols = kept.map(() => tracks.map(() => new PileupAccumulator(1, side)))
  const pooled = poolsAnchors(job.params)
  const perAnchor: Array<{ label: string; separation: number; score: number }> = []
  // How every window is cut, the same for the real ones and their controls,
  // since a control masked differently from the window it divides would put a
  // pattern in the ratio that is in neither.
  const shape: CutOptions = {
    minDiag: minDiagOf(job.params),
    mirrored: onDiagonal(job.params),
  }

  const block = usableBlock(job, plans.map(spanOf), balance)
  const expected =
    norm === 'oe' && !oeOnAScaledGrid ? await expectedBySequence(job, plans, { block, balance, value }) : null
  const batches = coalesce(plans)
  let done = 0

  for (const batch of batches) {
    // The pileup is arithmetic over windows already in hand, so nothing below
    // returns to the event loop on its own and a cancel would sit in the queue
    // until the last batch had been summed. See `analysis/job.ts`.
    await job.breathe()
    job.progress(done, plans.length, `${done.toLocaleString()} of ${plans.length.toLocaleString()} windows`)
    const dense = await readRect(job, batch.rect, { block, balance, value })
    for (const plan of batch.plans) {
      done++
      // Every window that could be cut is summed, however little of it carries
      // a value. There used to be a minimum here, and what it dropped was the
      // windows in the sparsest regions — which are exactly the ones a weak
      // pileup is weak because of, so removing them made every pileup look
      // better than the data. `PileupAccumulator` counts per cell, so a
      // half-empty window contributes what it has and nothing more.
      const window = cut(dense, batch.rect, plan, side, layout, {
        ...shape,
        expected: expected?.get(plan.bounds.from),
      })
      if (window === null) continue
      if (plan.control) {
        controls[plan.group].add(window)
        continue
      }
      real[plan.group].add(window)
      // **Only the real windows**, and the same ones: a marginal averaged over
      // the controls as well would be a profile of the shifted anchors, which
      // is the denominator of the picture rather than the picture. Cut from the
      // plan's own rectangle and resampled by the plan's own edges, so a cell of
      // the profile is the cell of the pileup above it by construction.
      if (tracks.length > 0) {
        const edges = edgesFor(plan, layout)
        for (let t = 0; t < tracks.length; t++) {
          const down = marginOf(tracks[t].values, plan.rect.rowFrom, plan.rect.rowTo, side, edges)
          const across = marginOf(tracks[t].values, plan.rect.colFrom, plan.rect.colTo, side, edges)
          alongRows[plan.group][t].add(down)
          alongCols[plan.group][t].add(across)
          // Pooled, every window contributes **both** of its anchors to **both**
          // edges, so the two profiles come out one mean over twice as many
          // anchors rather than two means over half as many each. Done here, a
          // window at a time, rather than by averaging the two finished profiles
          // at the end: the two accumulators count per cell, and a cell one of
          // them never saw would be weighted as though it had. See
          // {@link poolsAnchors}.
          if (pooled) {
            alongRows[plan.group][t].add(across)
            alongCols[plan.group][t].add(down)
          }
        }
      }
      if (plan.label !== undefined) {
        perAnchor.push({
          label: plan.label,
          separation: plan.separation * job.mc.binsize,
          score: scaledDomains ? domainScore(window, layout) : p2ll(window, side, side),
        })
      }
    }
  }
  job.progress(plans.length, plans.length, 'done')
  job.throwIfCancelled()

  const outputs: TaskOutput[] = []

  for (let g = 0; g < kept.length; g++) {
    const observed = real[g].finish()
    if (observed.n === 0) continue
    const name =
      groupNames !== null
        ? `APA · ${groupNames[g]}`
        : kept.length === 1
          ? 'APA'
          : `APA · group ${g + 1}`

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
    } else if (expected !== null) {
      // Already divided, window by window, as each was cut — so the mean is
      // the mean of the ratios, which is coolpuppy's `ooe`, and not a ratio of
      // means, which is what dividing the finished pileup would give.
      centre = 1
      label = `${name} · observed / expected`
    }

    // **What the middle of the picture is**, which stopped being "the centre" the
    // moment a window could be cut about a feature's start. An axis labelled
    // *bins from the centre* over a pileup at four thousand transcription start
    // sites is a caption for a figure nobody drew.
    const from = onDiagonal(job.params)
      ? anchorAt(job.params) === 'start'
        ? 'the feature’s start'
        : anchorAt(job.params) === 'end'
          ? 'the feature’s end'
          : 'the feature’s centre'
      : 'the centre'
    const axis = isScaled(job.params)
      ? scaledDomains
        ? `Position along the feature (0 → 1), flanked by ${flankFractionOf(job.params)}×`
        : 'Scaled position'
      : `Distance from ${from}`
    // **In base pairs, not in bins.** A fixed window is a window of the genome,
    // and what a reader asks of a pileup is how far from the anchor the thing
    // they are looking at lies; a count of bins answers that only for somebody
    // holding the resolution in their head, and differently at every
    // resolution. A *scaled* window has no such distance — its axis is the
    // feature, 0 to 1 — and keeps its own labels ({@link scaledTickLabels}).
    const ticks = isScaled(job.params)
      ? scaledDomains
        ? scaledTickLabels(layout, flankFractionOf(job.params))
        : []
      : offsetTicks(side, job.mc.binsize)

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
      // The aggregate signal above and beside the aggregate map, over the same
      // windows: the figure this task could not draw, and the one most papers
      // that use an APA actually print.
      ...(() => {
        const margins = marginsOf(tracks, alongRows[g], alongCols[g])
        return margins === undefined ? {} : { margins }
      })(),
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
    // **The loop spectrum**, before the table and only off the diagonal, where a
    // separation exists to plot against. Every anchor already carries its own
    // P2LL and its own separation — the table below prints both — and the one
    // thing the pileup above cannot show is how the first varies with the
    // second. A loop set whose 30 kb pairs are loops and whose 2 Mb pairs are
    // noise averages into a single plausible dot, and the two numbers that say
    // so are already in hand (`analysis/loopSpectrum.ts`).
    if (!onDiagonal(job.params)) {
      const spectrum = loopSpectrum(perAnchor, {
        id: 'apa-loop-spectrum',
        label: 'Loop spectrum',
        noun: allPairs(job.params) ? 'pairs' : 'loops',
        yLabel: 'P2LL — centre against the lower-left corner',
      })
      if (spectrum !== null) outputs.push(spectrum)
    }
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
// Track aggregates along the edges
// ---------------------------------------------------------------------------

/** One chosen track: what it is called, and one value per bin of this map. */
interface MarginTrack {
  name: string
  values: Float32Array
}

/**
 * The tracks whose aggregate is drawn along the pileup's edges.
 *
 * **By the parameter key plus the entry id**, which is how a `multiple` entry
 * parameter's inputs are filed (`AnalysisRunner`'s `chosenEntries`) — and a
 * track arrives as a *vector over the map's bins* rather than as a file handle,
 * which is what lets a task in this venue read one at all (§18.6): the bigWig
 * lives in the annotations worker and is megabytes, and what a marginal profile
 * needs is one number per bin, which the lane renderer already computes.
 *
 * A row dropped between the form being filled in and Run being pressed is simply
 * absent, and is left out rather than drawn as a flat line.
 */
function marginTracks(job: JobContext): MarginTrack[] {
  const chosen = listParam(job.params, 'tracks')
  const out: MarginTrack[] = []
  for (const id of chosen) {
    const values = job.inputs.vectors?.[`tracks:${id}`]
    if (values === undefined) continue
    out.push({ name: job.inputs.labels?.[id] ?? id, values })
  }
  if (out.length < chosen.length) {
    // Said out loud, because the pileup comes back looking perfectly finished
    // with one fewer line above it than the form promised — and a reader who
    // dropped a track between filling the form in and pressing Run has no other
    // way to find out which of the two things happened.
    job.note(
      `${(chosen.length - out.length).toLocaleString()} of ${chosen.length.toLocaleString()} ` +
        'tracks could not be read and are not drawn beside the pileup. Re-open the file, or ' +
        'pick another under Track aggregates.',
    )
  }
  return out
}

/**
 * The grid edges one window's profile is resampled onto, or `undefined`.
 *
 * The plan's own, so a marginal cell is the cell of the pileup above it: a
 * domain window is flank, body, flank with the body pinned to its own two grid
 * lines ({@link cut}), and a profile stretched evenly over the same window would
 * put the boundary a column away from where the picture draws it.
 */
function edgesFor(plan: Plan, layout: ScaledLayout): Float64Array | undefined {
  if (plan.body === undefined) return undefined
  return scaledEdges(
    layout,
    plan.body.from - plan.rect.rowFrom,
    plan.body.to - plan.rect.rowFrom,
    plan.body.pad,
  )
}

/**
 * One window's stretch of a track, resampled onto the pileup's grid.
 *
 * Bins outside the vector read as `NaN` rather than as zero — a window running
 * off the end of the last sequence has no coverage there, and zero is a
 * measurement. `PileupAccumulator` skips them per cell, so a window that is half
 * off the end contributes the half it has.
 *
 * The resampling is `analysis/apa.ts`'s, over a source one row tall: area
 * weighted and gap preserving, which is the same arithmetic the matrix window
 * goes through and therefore the same answer about where a feature's edge lands.
 */
function marginOf(
  values: Float32Array,
  from: number,
  to: number,
  side: number,
  edges: Float64Array | undefined,
): Float64Array {
  const span = to - from
  if (span <= 0) return new Float64Array(side).fill(Number.NaN)
  const source = new Float64Array(span)
  for (let i = 0; i < span; i++) {
    const at = from + i
    source[i] = at >= 0 && at < values.length ? values[at] : Number.NaN
  }
  if (edges === undefined) return resampleWindow(source, 1, span, 1, side)
  return resampleWindowTo(source, 1, span, Float64Array.from([0, 1]), edges)
}

/**
 * The finished profiles for one group, or `undefined` where there are none.
 *
 * A profile with no window behind it is left out rather than drawn empty: a flat
 * line along the top of a pileup is a claim about the signal, and *no anchor of
 * this group could be profiled* is not that claim.
 */
function marginsOf(
  tracks: readonly MarginTrack[],
  rows: readonly PileupAccumulator[],
  cols: readonly PileupAccumulator[],
): { top?: MarginProfile[]; right?: MarginProfile[] } | undefined {
  if (tracks.length === 0) return undefined
  const top: MarginProfile[] = []
  const right: MarginProfile[] = []
  for (let t = 0; t < tracks.length; t++) {
    // The **columns** run along the top and the **rows** down the right side,
    // which is what puts each profile beside the axis it is a profile of.
    const alongTop = cols[t].finish()
    const alongSide = rows[t].finish()
    if (alongTop.n > 0) top.push({ name: tracks[t].name, values: Float64Array.from(alongTop.values) })
    if (alongSide.n > 0) {
      right.push({ name: tracks[t].name, values: Float64Array.from(alongSide.values) })
    }
  }
  if (top.length === 0 && right.length === 0) return undefined
  return {
    ...(top.length === 0 ? {} : { top }),
    ...(right.length === 0 ? {} : { right }),
  }
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
   * For a loaded pair, how far apart its two anchors' centres are, in base
   * pairs: what coolpuppy measures its `mindist` on, and so what the nearest
   * loop is held to here. Absent for anything else.
   */
  centreDistance?: number
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
      // An anchor the file gave no name is named by its first base as a reader
      // reads one (§26.1), here and in the two places below. It was the stored
      // start, 0-based, in the *Per anchor* table of a drawer whose every other
      // coordinate is 1-based.
      label: set.name[i] === '' ? formatPosition(set.contigs[set.contig1[i]], set.start1[i]) : set.name[i],
      rank: set.score[i],
      span: col - row,
      centreDistance: Math.abs((set.start2[i] + set.end2[i]) / 2 - (set.start1[i] + set.end1[i]) / 2),
      rows: { from: row, to: row + 1 },
      cols: { from: col, to: col + 1 },
    })
  }
  return out
}

/**
 * The loops no nearer the diagonal than the nearest loop, and a note for the rest.
 *
 * coolpuppy's `mindist`, measured as coolpuppy measures it — between the two
 * anchors' centres, in base pairs, a loop exactly at the floor kept — so that a
 * BEDPE whose anchors are not bin-aligned is cut at the same loop in both. The
 * floor is asked in bins, as every matrix parameter is (§18.2), and is base
 * pairs here at this file's resolution.
 */
function nearEnough(job: JobContext, anchors: Anchor[]): Anchor[] {
  const nearest = minDistOf(job.params)
  const floor = nearest * job.mc.binsize
  const out = anchors.filter((anchor) => (anchor.centreDistance ?? Number.POSITIVE_INFINITY) >= floor)
  const left = anchors.length - out.length
  if (left === 0) return out
  const how =
    `nearer the diagonal than ${nearest.toLocaleString()} bins (${shortBp(floor)})` +
    (nearest === autoMinDist(job.params) ? ', coolpuppy’s default,' : '')
  job.note(
    out.length === 0
      ? `Every loop of this set is ${how} so there is nothing to pile up. Set the nearest loop lower, ` +
          'or to 0 for every one.'
      : `${left.toLocaleString()} of ${anchors.length.toLocaleString()} loops are ${how} and are left ` +
          'out. Set the nearest loop to 0 to pile up every one.',
  )
  return out
}

/**
 * The base a window is cut about: the feature's start, its centre or its end.
 *
 * **Strand decides which end is which**, exactly as `analysis/metaplot.ts`'s
 * reference point does, because *start* means the 5′ end and a minus-strand gene
 * runs the other way. A set with no strand column reads as plus throughout,
 * which is what an unstranded peak set means by its own coordinates.
 *
 * The end takes the feature's **last base** rather than its exclusive end, which
 * is a bin off on any feature whose end lands on a bin boundary — and on a gene
 * set that is most of them, since annotation ends are round numbers.
 */
function anchorBase(set: FeatureSet, i: number, at: 'start' | 'centre' | 'end'): number {
  const start = set.start[i]
  const end = set.end[i]
  if (at === 'centre') return Math.round((start + end) / 2)
  const last = Math.max(start, end - 1)
  const reversed = set.strand[i] < 0
  if (at === 'start') return reversed ? last : start
  return reversed ? start : last
}

function featureAnchors(job: JobContext, set: FeatureSet): Anchor[] {
  const out: Anchor[] = []
  const from = contextOf(set.contigs)
  const reference = anchorAt(job.params)
  for (let i = 0; i < set.length; i++) {
    const at = binOf(job, set.contigs[set.contig[i]], set.start[i], set.end[i], from, {
      point: anchorBase(set, i, reference),
    })
    if (at === null) continue
    out.push({
      pair: { row: at.bin, col: at.bin, separation: 0 },
      bounds: at.bounds,
      label: set.name[i] === '' ? formatPosition(set.contigs[set.contig[i]], set.start[i]) : set.name[i],
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
  options: { point?: number } = {},
): { bin: number; body: Span; bounds: Span; contig: string } | null {
  const cid = contigIdFor(job.mc, contig, named)
  if (cid < 0) return null
  const [from, to] = job.mc.contigExtent(cid)
  // The reader's own reference point where there is one, and the midpoint
  // otherwise — which is what a loop set's anchor has and what this task did
  // before the choice existed. The *body* below is the feature either way: the
  // scaled mode resamples the whole interval, and where it is cut about is a
  // question only the fixed mode asks.
  const bin = job.mc.coords.binIndex(cid, options.point ?? Math.round((start + end) / 2))
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

/** How a window is cut out of the map before it is piled up. */
interface CutOptions {
  /** Diagonals, the main one first, whose cells are left out; see {@link minDiagOf}. */
  minDiag: number
  /**
   * Whether the window sits on the diagonal and is its own mirror.
   *
   * There the cells below the diagonal are the cells above it, transposed, and
   * the window is kept whole with only the near diagonals left out on both
   * sides — which is coolpuppy's local pileup exactly, since coolpuppy cuts the
   * upper triangle and then folds the finished picture onto its transpose. Off
   * the diagonal nothing is taken from below it.
   */
  mirrored: boolean
  /**
   * The expected of the window's sequence, by diagonal, where every window is
   * divided by it; `undefined` otherwise.
   */
  expected?: Float64Array
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
 *
 * Before either, the window is cut as coolpuppy cuts one ({@link CutOptions}),
 * and divided by its expected where the run asked for observed / expected:
 * **each cell by the expected at its own diagonal**, `|col − row|` in the map,
 * on its own sequence. That replaced a division of the *finished* pileup by an
 * expected looked up at each cell's distance from the pileup's centre, which is
 * a cell's diagonal only for a window on the diagonal. For a loop forty bins out
 * it divided the loop's own pixel by the expected of the main diagonal, and the
 * expected came from the windows' own cells, which were not read that close to
 * the diagonal at all — so the centre of a loop pileup came out at 0.2 on a
 * mouse loop set coolpuppy puts at 2.9.
 */
function cut(
  dense: Dense,
  read: Rect,
  plan: Plan,
  side: number,
  layout: ScaledLayout,
  options: CutOptions,
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
  const cutOut = new Float64Array(rows * cols)
  const { minDiag, mirrored, expected } = options
  for (let r = 0; r < rows; r++) {
    const at = (rowSkip + r) * dense.ncols + colSkip
    for (let c = 0; c < cols; c++) {
      const diagonal = want.colFrom + c - (want.rowFrom + r)
      if ((mirrored ? Math.abs(diagonal) : diagonal) < minDiag) {
        cutOut[r * cols + c] = Number.NaN
        continue
      }
      const observed = dense.values[at + c]
      if (expected === undefined) {
        cutOut[r * cols + c] = observed
        continue
      }
      // A diagonal with nothing on it gives no ratio rather than an infinity,
      // for the reason `ratioOf` gives.
      const denominator = expected[Math.abs(diagonal)]
      cutOut[r * cols + c] = denominator > 0 ? observed / denominator : Number.NaN
    }
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
 * Each sequence's expected, by diagonal, as deep as its farthest window reaches.
 *
 * Keyed by the sequence's first bin, which is what a plan carries. **The whole
 * sequence, and no more of it than the windows need**: cooltools' expected is a
 * property of the sequence, so a window is divided by what that sequence does
 * at the window's diagonals everywhere along it — not by what the windows
 * themselves hold there, which over a loop set is the mean of the places the set
 * picked and enriched by construction. The depth is the one economy, and it is
 * an exact one: a diagonal no window reaches is a diagonal nothing is divided by.
 */
async function expectedBySequence(
  job: JobContext,
  plans: readonly Plan[],
  options: { block: ReturnType<typeof usableBlock>; balance: boolean; value: string },
): Promise<Map<number, Float64Array>> {
  const deepest = new Map<number, { bounds: Span; hi: number }>()
  for (const plan of plans) {
    // The farthest a cell of this window is from the diagonal, either side of it.
    const reach = Math.max(
      Math.abs(plan.rect.colTo - 1 - plan.rect.rowFrom),
      Math.abs(plan.rect.rowTo - 1 - plan.rect.colFrom),
    )
    const held = deepest.get(plan.bounds.from)
    if (held === undefined) deepest.set(plan.bounds.from, { bounds: plan.bounds, hi: reach })
    else if (reach > held.hi) held.hi = reach
  }
  const out = new Map<number, Float64Array>()
  let done = 0
  for (const [from, { bounds, hi }] of deepest) {
    job.progress(done, deepest.size, `the expected, sequence ${done + 1} of ${deepest.size}`)
    out.set(
      from,
      await diagonalMeans(job, bounds, {
        hi,
        block: options.block,
        balance: options.balance,
        value: options.value,
        onTile: async () => {
          await job.breathe()
          job.throwIfCancelled()
        },
      }),
    )
    done++
  }
  return out
}

// ---------------------------------------------------------------------------
// Pairs made rather than loaded
// ---------------------------------------------------------------------------

/**
 * Every pair of a feature set on one sequence, inside the separation range.
 *
 * The sliding window is the whole of the implementation and the whole of what
 * makes it affordable: the set is sorted by `(contig, start)` already (§8.4), so
 * for each feature the partners are a contiguous run of the ones after it, and
 * the run ends at the first one past `maxSep`. That makes the cost proportional
 * to the number of pairs **produced** rather than to `n²` — which matters,
 * because the two differ by four orders of magnitude on a genome-wide peak set
 * with a two-hundred-bin reach.
 *
 * **The range is in bins and the filter is on the pair's own bin offset**, which
 * is the thing the pileup is a picture of: `pair.separation` is `col − row`, the
 * separation bands are bin offsets, and the diagonal a pair is dropped for
 * sitting on is one bin wide. The base-pair reading this replaces compared the
 * distance between two feature centres, so two features 30 kb apart were inside
 * a 20 kb floor on a 50 kb map and in the same bin — a pair on the diagonal,
 * which the last guard in the loop had to catch separately. The offsets are
 * monotone in the centres, so the `break` that makes the walk affordable still
 * holds.
 *
 * Past {@link MAX_GENERATED_PAIRS} the pairs are **sampled rather than
 * truncated**, and the distinction is the one §18.8 draws about the cap this
 * task used to have on its anchors: taking the first two hundred thousand is
 * taking whichever sequences sort first, and a pileup of chromosome I under a
 * caption saying *200,000 pairs* is a change of subject. Reservoir sampling with
 * the run's own seed gives a uniform sample of the whole set, which is a smaller
 * version of the same figure rather than a different one.
 */
function generatedPairs(job: JobContext, set: FeatureSet): Anchor[] {
  const minSep = Math.max(0, Math.round(numParam(job.params, 'minSep', 2)))
  const maxSep = Math.max(minSep + 1, Math.round(numParam(job.params, 'maxSep', 200)))
  job.note(
    `Pairs ${minSep.toLocaleString()} to ${maxSep.toLocaleString()} bins apart, which is ` +
      `${shortBp(minSep * job.mc.binsize)} to ${shortBp(maxSep * job.mc.binsize)} at this ` +
      `file’s ${job.mc.binsize.toLocaleString()} bp resolution.`,
  )
  const from = contextOf(set.contigs)
  const rng = makeRandom(Math.round(numParam(job.params, 'seed', 1)))

  // Resolved once per feature rather than once per pair: `contigIdFor` walks a
  // naming context and a set of forty thousand features inside a 2 Mb window
  // produces millions of pairs, so resolving inside the inner loop is the one
  // decision here that would make the run minutes rather than seconds.
  interface Placed {
    contig: string
    centre: number
    bin: number
    bounds: Span
    body: Span
    label: string
  }
  const placed: Placed[] = []
  const reference = anchorAt(job.params)
  for (let i = 0; i < set.length; i++) {
    // The **same point** the window is cut about is the point the separation is
    // measured between, and it has to be: a range of 20 kb to 2 Mb between gene
    // centres and a pileup at gene starts would be two different sets of pairs
    // wearing one caption.
    const point = anchorBase(set, i, reference)
    const at = binOf(job, set.contigs[set.contig[i]], set.start[i], set.end[i], from, { point })
    if (at === null) continue
    placed.push({
      contig: at.contig,
      centre: point,
      bin: at.bin,
      bounds: at.bounds,
      body: at.body,
      label: set.name[i] === '' ? formatPosition(set.contigs[set.contig[i]], set.start[i]) : set.name[i],
    })
  }
  // By this file's own sequence name and then by position, because the set's
  // order is the *set's* and two of its names may resolve to one sequence here
  // (§5.9). Sorting on what was resolved is what keeps the sliding window below
  // correct in exactly that case.
  placed.sort((a, b) => (a.contig === b.contig ? a.centre - b.centre : a.contig < b.contig ? -1 : 1))

  const out: Anchor[] = []
  let seen = 0
  const offer = (anchor: Anchor): void => {
    seen++
    if (out.length < MAX_GENERATED_PAIRS) {
      out.push(anchor)
      return
    }
    // Reservoir: the `k`-th candidate replaces a held one with probability
    // `cap / k`, which leaves every candidate equally likely to survive.
    const at = Math.floor(rng() * seen)
    if (at < MAX_GENERATED_PAIRS) out[at] = anchor
  }

  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j]
      if (b.contig !== a.contig) break
      const row = Math.min(a.bin, b.bin)
      const col = Math.max(a.bin, b.bin)
      const separation = col - row
      if (separation > maxSep) break
      if (separation < minSep) continue
      // A pair in one bin is not an off-diagonal pileup — it is the diagonal,
      // which is the largest thing in the matrix and would dominate every cell
      // it contributed to. Only reachable at a floor of zero now that the floor
      // is in bins; kept, because zero is a number a reader can type.
      if (row === col) continue
      offer({
        pair: { row, col, separation: col - row },
        bounds: a.bounds,
        label: `${a.label} × ${b.label}`,
        rank: Number.NaN,
        span: col - row,
        // One bin each, like a loaded pair's anchors: what is being asked about
        // is the contact between two places, and the scaled mode's rectangle
        // between them is built from these two spans by the same code path.
        rows: { from: row, to: row + 1 },
        cols: { from: col, to: col + 1 },
      })
    }
  }

  if (seen > out.length) {
    job.note(
      `${seen.toLocaleString()} pairs are inside the separation range and ` +
        `${out.length.toLocaleString()} were sampled, uniformly and with this run’s seed. ` +
        'Narrow the range for all of them.',
    )
  }
  return out
}

/**
 * The anchors split into `bins` log-spaced separation bands.
 *
 * **Log-spaced, on the quantiles of nothing** — the edges come from the observed
 * minimum and maximum separation rather than from equal counts — because the
 * quantity being divided is a separation, and contact falls off with it as a
 * power law. Equal-count bins over a set whose separations pile up at one end
 * produce a first band spanning a decade and a last one spanning a factor of
 * two, and the pileups are then not comparable with each other, which is the
 * entire reason for splitting them.
 *
 * Empty bands are dropped rather than drawn empty, so a set with a gap in its
 * separations produces fewer panels than asked for rather than a blank one.
 */
function bySeparation(anchors: Anchor[], bins: number): Anchor[][] {
  let lo = Number.POSITIVE_INFINITY
  let hi = 0
  for (const anchor of anchors) {
    const separation = anchor.pair.separation
    if (separation <= 0) continue
    if (separation < lo) lo = separation
    if (separation > hi) hi = separation
  }
  if (!Number.isFinite(lo) || hi <= lo) return [anchors]

  const logLo = Math.log(lo)
  const step = (Math.log(hi) - logLo) / bins
  const out: Anchor[][] = Array.from({ length: bins }, () => [])
  for (const anchor of anchors) {
    const separation = anchor.pair.separation
    // A pair whose two anchors land in one bin has no separation to band by, and
    // it goes in the nearest band rather than being dropped: §18.8's rule is
    // that every anchor is piled up, and a run that quietly discarded the
    // shortest-range pairs would be weakest exactly where the signal is
    // strongest.
    const at =
      separation <= 0
        ? 0
        : Math.min(bins - 1, Math.floor((Math.log(separation) - logLo) / step))
    out[at].push(anchor)
  }
  return out.filter((band) => band.length > 0)
}

/** What each band is called, in base pairs, from the separations it holds. */
function separationNames(bands: Anchor[][], toBp: (bins: number) => number): string[] {
  return bands.map((band) => {
    let lo = Number.POSITIVE_INFINITY
    let hi = 0
    for (const anchor of band) {
      const separation = anchor.pair.separation
      if (separation < lo) lo = separation
      if (separation > hi) hi = separation
    }
    // The band's **own** extremes rather than the edges it was cut at, so the
    // label says what is in it rather than what could have been.
    return `${shortBp(toBp(Math.max(0, lo)))}–${shortBp(toBp(hi))}`
  })
}

/** `1.2 Mb`, `340 kb`, `900 bp` — the band label, short enough to be a title. */
function shortBp(bp: number): string {
  if (!Number.isFinite(bp)) return '?'
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(bp >= 1e7 ? 0 : 1)} Mb`
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(bp >= 1e4 ? 0 : 1)} kb`
  return `${Math.round(bp)} bp`
}

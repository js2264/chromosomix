/**
 * Aggregate peak analysis, as a descriptor.
 *
 * The task whose *cost model* is the interesting part, and it is the one place
 * in this catalogue where the expensive choice is the correct one (§18.6).
 *
 * A pileup could be taken from one big read covering every anchor. It must not
 * be: a bounding-box read is pooled at `RASTER_MAX_DIM` (§7.2), so on any
 * sizeable genome the pileup would quietly be at a coarser bin than the file
 * has, and the picture would not say so. So this reads one small block per
 * feature, at the file's own resolution, and pays for it — on a local file with
 * nothing, since a read there is a `slice()`, and on a remote file with range
 * requests that are coalesced where the anchors cluster and then *counted in
 * front of the reader* before **Run** is pressed.
 *
 * That last part is the §7.3 pattern rather than a compromise: an expensive
 * thing is offered with its price, not hidden and not refused.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { CHROMOSIGHT_PRESETS } from '../chromosightPresets'
import { BALANCE_PARAM } from './shared'
import { isIntervalSet } from '../../annotations/types'

/** Half-width of a fixed window, in bins. */
export function windowBins(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : 12
  return Math.max(1, Math.min(200, Math.round(value)))
}

/**
 * Whether the windows are resampled to a common grid.
 *
 * `false` under the chromosight normalisation whatever the mode control says,
 * and that is not a special case bolted on: there the window *is* the template,
 * 17 bins for loops, because the score under the picture is a correlation
 * against those 289 cells. A resampled window would still produce a picture and
 * the number beneath it would no longer be the one chromosight computes. The
 * mode control is hidden in that state rather than ignored, so the form and the
 * arithmetic say the same thing.
 */
export function isScaled(params: Params): boolean {
  return params.mode === 'scaled' && params.norm !== 'chromosight'
}

/** Whether this run is the chromosight pileup rather than one of the other three. */
export function isChromosight(params: Params): boolean {
  return params.norm === 'chromosight'
}

/** Whether the anchors are pairs (off-diagonal) or single features. */
export function onDiagonal(params: Params): boolean {
  return params.anchors !== 'pairs'
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'anchors',
    label: 'Anchors',
    default: 'pairs',
    options: [
      {
        value: 'pairs',
        label: 'Loop set',
        needsKinds: ['pairs'],
        hint: 'Off the diagonal, between two anchors.',
      },
      {
        value: 'features',
        label: 'Feature set',
        needsKinds: ['gtf', 'segments', 'variants'],
        hint: 'On the diagonal, at each feature.',
      },
    ],
  },
  {
    kind: 'pairSet',
    key: 'pairs',
    label: 'Pairs',
    when: (params) => params.anchors === 'pairs',
  },
  {
    kind: 'featureSet',
    key: 'features',
    label: 'Features',
    when: (params) => params.anchors !== 'pairs',
  },
  {
    kind: 'choice',
    key: 'mode',
    label: 'Mode',
    default: 'fixed',
    options: [
      { value: 'fixed', label: 'Fixed window', hint: 'Centre plus or minus a number of bins.' },
      { value: 'scaled', label: 'Scaled', hint: 'The feature or the span between anchors, resampled.' },
    ],
    // The chromosight pileup's window is its template's size. See {@link isScaled}.
    when: (params) => params.norm !== 'chromosight',
  },
  {
    kind: 'number',
    key: 'window',
    label: 'Half-width',
    default: 12,
    min: 1,
    max: 200,
    integer: true,
    unit: 'bins',
    when: (params) => !isScaled(params) && params.norm !== 'chromosight',
  },
  {
    kind: 'number',
    key: 'grid',
    label: 'Grid',
    hint: 'Every window resampled to this many cells a side.',
    default: 51,
    min: 11,
    max: 201,
    integer: true,
    when: (params) => isScaled(params),
  },
  {
    kind: 'number',
    key: 'flankFraction',
    label: 'Flank',
    hint: 'As a fraction of the feature’s own length, each side.',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.1,
    slider: true,
    when: (params) => isScaled(params),
  },
  {
    kind: 'choice',
    key: 'norm',
    label: 'Normalisation',
    default: 'matched',
    options: [
      {
        value: 'matched',
        label: 'Distance-matched',
        hint: 'Against shifted anchors at the same separations. Controls for local background too.',
      },
      {
        value: 'oe',
        label: 'Observed / expected',
        hint: 'Against the file’s own P(s). Controls for the distance decay only.',
      },
      { value: 'none', label: 'None', hint: 'The raw pileup.' },
      {
        value: 'chromosight',
        label: 'Chromosight',
        hint: 'The map detrended by its own distance law, then averaged — and every anchor scored against the template.',
      },
    ],
  },
  {
    kind: 'choice',
    key: 'csPattern',
    label: 'Template',
    default: 'loops',
    hint: 'What each window is scored against, and how wide it is.',
    when: (params) => params.norm === 'chromosight',
    options: CHROMOSIGHT_PRESETS.map((preset) => ({
      value: preset.name,
      label: preset.name.replace(/_/g, ' '),
      hint: preset.blurb,
    })),
  },
  {
    kind: 'number',
    key: 'controls',
    label: 'Controls per pair',
    default: 5,
    min: 1,
    max: 25,
    integer: true,
    slider: true,
    when: (params) => params.norm === 'matched',
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'minShift',
    label: 'Smallest shift',
    default: 100_000,
    min: 0,
    unit: 'bp',
    when: (params) => params.norm === 'matched',
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'maxShift',
    label: 'Largest shift',
    default: 1_000_000,
    min: 1,
    unit: 'bp',
    when: (params) => params.norm === 'matched',
    section: 'Control',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    hint: 'The same seed gives the same control twice (§18.4).',
    default: 1,
    when: (params) => params.norm === 'matched',
    section: 'Control',
  },
  {
    kind: 'column',
    key: 'rankBy',
    label: 'Rank by',
    from: 'features',
    optional: true,
    noneLabel: 'Do not rank',
    when: (params) => params.anchors !== 'pairs',
    section: 'Ranking',
  },
  {
    kind: 'choice',
    key: 'subset',
    label: 'Then',
    default: 'all',
    when: (params) =>
      params.anchors !== 'pairs' && typeof params.rankBy === 'string' && params.rankBy !== '',
    options: [
      { value: 'all', label: 'One pileup' },
      { value: 'top', label: 'Top N' },
      { value: 'groups', label: 'K groups' },
    ],
    section: 'Ranking',
  },
  {
    kind: 'number',
    key: 'count',
    label: 'N',
    default: 500,
    min: 1,
    integer: true,
    when: (params) => params.subset === 'top',
    section: 'Ranking',
  },
  {
    kind: 'number',
    key: 'groups',
    label: 'Groups',
    default: 4,
    min: 2,
    max: 6,
    integer: true,
    slider: true,
    when: (params) => params.subset === 'groups',
    section: 'Ranking',
  },
  // **There is no Quality section, and its two settings are not defaults — they
  // are gone.** *Most anchors to use* capped the read at five thousand, and
  // *Minimum coverage of a window* dropped any window less than half filled.
  // Both quietly changed what the pileup was *of*: the first made it a pileup of
  // whichever anchors happened to sort first, and the second dropped exactly the
  // windows in sparse regions — which are the ones a weak pileup is weak because
  // of. A reader comparing two conditions could not tell whether a difference
  // was in the data or in which windows each run had thrown away. Every anchor
  // is used and every window is summed; `PileupAccumulator` already counts per
  // cell, so a half-empty window contributes what it has and nothing more.
  BALANCE_PARAM,
]

/** Rows and columns one window will occupy. */
function windowSide(params: Params): number {
  return isScaled(params)
    ? Math.max(11, Math.round(typeof params.grid === 'number' ? params.grid : 51))
    : windowBins(params) * 2 + 1
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const usingPairs = !onDiagonal(params)
  const chosen = usingPairs ? params.pairs : params.features
  if (typeof chosen !== 'string' || chosen === '') {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: usingPairs
        ? 'Choose a loop set. A BEDPE dropped on the Annotations panel becomes one.'
        : 'Choose a feature set to pile up on the diagonal.',
    }
  }

  const entry = context.entries.find((row) => row.id === chosen)
  const anchors = anchorCount(entry?.summary)

  // The chromosight normalisation is priced differently because it *reads*
  // differently: the distance law it detrends by is a property of a whole
  // sequence, so it takes one square per sequence the anchors sit on rather than
  // one small block per anchor. That is usually far fewer requests and far more
  // bytes, and saying "k windows" here would price the wrong run.
  if (isChromosight(params)) {
    const widest = context.contigs.reduce((most, contig) => Math.max(most, contig.bins), 0)
    return {
      class: 'scan',
      requests: Math.max(1, context.contigs.length) * (params.balance === true ? 5 : 4),
      bytes: widest * widest * 4,
      note:
        'One dense square per sequence the anchors sit on — up to ' +
        `${((widest * widest * 4) / 1e6).toFixed(0)} MB at a time — detrended by its own distance ` +
        'law, then a window cut at each anchor and scored against the template. ' +
        `${anchors === null ? '' : `${anchors.toLocaleString()} anchors. `}` +
        'Progress is reported per sequence and it can be cancelled at any point.',
    }
  }

  const side = windowSide(params)
  const cells = side * side
  const controls = params.norm === 'matched' ? Math.round(Number(params.controls ?? 5)) : 0
  // Every anchor, since there is no cap any more: the estimate has to price the
  // run that will happen rather than the one a removed setting used to bound.
  const windows = anchors === null ? null : anchors * (1 + controls)

  if (context.blockLoaded && context.framing?.binsPerCell === 1) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note:
        `Every window comes out of the block already on screen — ${cells.toLocaleString()} cells ` +
        'each, no reads. Windows outside it are read.',
    }
  }

  // Counted rather than hand-waved, because the whole point of the k-reads
  // decision is that its price is visible. Coalescing brings the real number
  // down where anchors cluster, which loop anchors do; the estimate is
  // deliberately the un-coalesced upper bound so the run is never dearer than
  // the button said.
  const requests = windows === null ? null : windows * 2
  return {
    class: 'scan',
    requests,
    bytes: windows === null ? null : windows * cells * 4,
    note:
      windows === null
        ? 'One small block per anchor, at the file’s own resolution.'
        : `${windows.toLocaleString()} windows of ${side}×${side} bins, one small block each at ` +
          `the file’s own resolution — at most ${(windows * 2).toLocaleString()} range requests ` +
          'before nearby anchors are read together. Cancellable at any point.',
  }
}

/**
 * How many anchors a loaded set holds, from the one-line summary it carries.
 *
 * The payload itself is on the main thread and could be counted exactly, but the
 * *estimate* runs on every keystroke in the form and the context deliberately
 * carries entries rather than their megabytes. `null` where the summary cannot
 * be read, and the note then says what it can rather than a number it guessed.
 */
function anchorCount(summary: string | undefined): number | null {
  if (summary === undefined) return null
  const match = /([\d,]+)/.exec(summary)
  if (match === null) return null
  const value = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

export const APA_TASK: AnalysisTask = {
  id: 'apa',
  title: 'Aggregate peak analysis',
  blurb: 'Pile up the matrix at a set of loops or features, against a control.',
  group: 'tracks',
  venue: 'analysis',
  version: 1,
  // **Not** `requires: ['expected']`, though §18.8 describes the O/E path as
  // needing it. `requires` is static and the runner resolves it before every
  // run, so declaring it would compute a whole-file P(s) on every APA — while
  // O/E is not the default and most runs never look at it. And the expected an
  // APA needs is a narrower question than the task's: the diagonal offsets its
  // own windows span, on the contigs its own anchors sit on, which the runner
  // accumulates from the squares it is already reading. A composite that
  // recomputed a genome-wide curve to divide fifty offsets by would be paying a
  // scan for arithmetic it already had in hand.
  // Two things, and the row says which is missing. It used to vanish when there
  // was no loop set, which taught a reader who had not met this app before that
  // it does not do aggregate peak analysis — rather than that they have not
  // loaded the loops yet.
  availability: (context) => {
    if (!context.hasMap) return waitingFor(NEEDS_MAP)
    const anchors = context.entries.some(
      (entry) => entry.kind === 'pairs' || isIntervalSet(entry.kind),
    )
    return anchors
      ? READY
      : waitingFor('Load a loop set (BEDPE) to pile up off the diagonal, or a feature set (BED, GTF) to pile up on it.')
  },
  params: PARAMS,
  outputs: ['matrix', 'table', 'curve'],
  estimate,
}

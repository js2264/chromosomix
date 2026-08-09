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

/** Half-width of a fixed window, in bins. */
export function windowBins(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : 25
  return Math.max(1, Math.min(200, Math.round(value)))
}

export function isScaled(params: Params): boolean {
  return params.mode === 'scaled'
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
      { value: 'pairs', label: 'Loop set', hint: 'Off the diagonal, between two anchors.' },
      { value: 'features', label: 'Feature set', hint: 'On the diagonal, at each feature.' },
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
  },
  {
    kind: 'number',
    key: 'window',
    label: 'Half-width',
    hint: 'Bins either side of the centre. The classic APA square is 25.',
    default: 25,
    min: 1,
    max: 200,
    integer: true,
    unit: 'bins',
    when: (params) => !isScaled(params),
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
    ],
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
  {
    kind: 'number',
    key: 'maxAnchors',
    label: 'Most anchors to use',
    hint: 'A cap on the read, not on the science: the drawer says how many were left out.',
    default: 5000,
    min: 10,
    integer: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'Minimum coverage of a window',
    hint: 'A window with less than this fraction of usable cells is dropped.',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    section: 'Quality',
  },
  {
    kind: 'toggle',
    key: 'balance',
    label: 'Use balancing weights',
    default: false,
    section: 'Quality',
  },
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
  const side = windowSide(params)
  const cells = side * side
  const controls = params.norm === 'matched' ? Math.round(Number(params.controls ?? 5)) : 0
  const windows = anchors === null ? null : Math.min(anchors, Number(params.maxAnchors ?? 5000)) * (1 + controls)

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
  appliesTo: (context) =>
    context.nBins > 0 &&
    context.entries.some(
      (entry) => entry.kind === 'pairs' || entry.kind === 'gtf' || entry.kind === 'segments',
    ),
  params: PARAMS,
  outputs: ['matrix', 'table'],
  estimate,
}

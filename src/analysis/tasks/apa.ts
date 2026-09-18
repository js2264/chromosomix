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
import { ANNOTATION_KINDS, isIntervalSet } from '../../annotations/types'

/**
 * The kinds an anchor option that wants intervals can be filled from.
 *
 * Derived rather than listed, and that is the whole point of it being here at
 * all: this was `['gtf', 'segments', 'variants']` written out twice, which is
 * the fourth and fifth copies of a rule `isIntervalSet` exists to be the only
 * one of — and it is the copy the guard in `annotation-kinds.test.ts` could not
 * see, because an array of literals is not the `kind === 'x' || kind === 'y'`
 * shape it looks for. A barChart found it: the availability gate below opened
 * for one and this list then refused the anchors control that gate had just
 * promised, which is exactly the failure §8.14 describes.
 */
const INTERVAL_KINDS = ANNOTATION_KINDS.filter(isIntervalSet)

/**
 * Which point of a feature a window is cut about.
 *
 * The same three the 1D metaplot offers, spelled the same way, because they are
 * the same question asked of a different picture — and a reader who has set a
 * metaplot to *start* and a pileup to *centre* is comparing two aggregates that
 * are not of the same places. Defaulted to the centre, which is what this task
 * did before there was a choice.
 */
export function anchorAt(params: Params): 'start' | 'centre' | 'end' {
  const value = params.at
  return value === 'start' || value === 'end' ? value : 'centre'
}

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

/** The flank a scaled window carries each side, as a fraction of its body. */
export function flankFractionOf(params: Params): number {
  const value = typeof params.flankFraction === 'number' ? params.flankFraction : 0.5
  return Math.max(0, Math.min(4, value))
}

/**
 * Whether this run is a **domain** pileup: intervals, scaled, on the diagonal.
 *
 * The three settings together, because none of them means it alone. It is what
 * decides the shape of the window, the statistic under the picture, the axis
 * labels, and how far a control has to be shifted to be a control — so it is
 * worth one name that the descriptor and the runner both use rather than the
 * same conjunction spelled out five times.
 */
export function isDomainPileup(params: Params): boolean {
  return isScaled(params) && onDiagonal(params)
}

/**
 * Whether the windows sit **on** the diagonal.
 *
 * Three anchor modes and only one of them does. A loop set is two anchors and a
 * feature set is one, which is the distinction this used to be — and *all pairs*
 * is a third thing that reads like the second and behaves like the first: its
 * input is one feature set and its windows are off the diagonal, between every
 * two features of it. So the question the rest of the task asks has to be *is
 * this on the diagonal* rather than *did the reader choose a feature set*, and
 * the two stopped being the same answer when the third mode arrived.
 */
export function onDiagonal(params: Params): boolean {
  return params.anchors !== 'pairs' && params.anchors !== 'allpairs'
}

/** Whether the input is a loaded pair set, rather than a feature set. */
export function usesPairSet(params: Params): boolean {
  return params.anchors === 'pairs'
}

/**
 * Whether the pairs are **made** from one feature set rather than loaded.
 *
 * The question behind it is the one a loop set cannot answer: *do these places
 * contact each other more than places like them would?* A loaded BEDPE is
 * somebody's claim about which pairs matter, so a pileup over one measures the
 * claim. Every pair of a peak set inside a separation range is not a claim about
 * anything, which is what makes it a test — and it is the shape of the figure
 * behind a great many papers about a factor clustering in three dimensions.
 */
export function allPairs(params: Params): boolean {
  return params.anchors === 'allpairs'
}

/** How many separation bins the run splits its pairs into; 1 is a single pileup. */
export function distanceBins(params: Params): number {
  if (onDiagonal(params)) return 1
  const asked = typeof params.byDistance === 'number' ? Math.round(params.byDistance) : 0
  return asked > 1 ? Math.min(MAX_DISTANCE_BINS, asked) : 1
}

/**
 * The most separation bins worth drawing, and the most pairs worth generating.
 *
 * Six panels is already a figure that needs a caption; past that the pileups are
 * thumbnails. The pair cap is the one that matters: every pair of a set inside a
 * window is quadratic in how densely the set packs, so a 40,000-peak set at a
 * 2 Mb reach is tens of millions of windows — which is not a long run, it is a
 * run that never finishes. Past the cap the pairs are **sampled**, with the
 * task's own seed, and the run says so.
 */
export const MAX_DISTANCE_BINS = 6
export const MAX_GENERATED_PAIRS = 200_000

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
        needsKinds: INTERVAL_KINDS,
        hint: 'On the diagonal, at each feature.',
      },
      {
        value: 'allpairs',
        label: 'Every pair of a feature set',
        needsKinds: INTERVAL_KINDS,
        hint:
          'Off the diagonal, between every two features within a separation range — the test of ' +
          'whether a set of places contacts itself.',
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
    key: 'at',
    label: 'Anchor on',
    default: 'centre',
    hint:
      'Which point of each feature the window is cut about. Strand is respected, so the start of ' +
      'a minus-strand gene is its 5′ end — the same rule the 1D aggregate follows.',
    // **The same control the 1D metaplot has, and it was missing here alone.** A
    // pileup at a set of genes centred on their midpoints is a pileup at
    // whatever is half way along a gene, which is a different question from the
    // one anybody asks of a gene set: what the contact map looks like at the
    // TSS. Hidden where there is no point to choose — a loaded loop set brings
    // its own two anchors, and a domain pileup's window *is* the feature, start
    // to end, with a flank each side.
    when: (params) => params.anchors !== 'pairs' && !isDomainPileup(params),
    options: [
      { value: 'centre', label: 'Centre', hint: 'Half way along the feature.' },
      { value: 'start', label: 'Start', hint: 'Its 5′ end — a TSS, on a gene model.' },
      { value: 'end', label: 'End', hint: 'Its 3′ end.' },
    ],
  },
  {
    kind: 'choice',
    key: 'mode',
    label: 'Mode',
    default: 'fixed',
    options: [
      { value: 'fixed', label: 'Fixed window', hint: 'Centre plus or minus a number of bins.' },
      {
        value: 'scaled',
        label: 'Scaled',
        hint:
          'Flank, the feature, flank — every window on one grid. Over a set of domains this is ' +
          'the domain pileup: the TAD in the middle and its two boundaries as the cross through it.',
      },
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
    hint:
      'Every window resampled to this many cells a side. A multiple of four puts the feature’s ' +
      'two ends exactly on axis ticks at the default flank.',
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
    hint:
      'As a fraction of the feature’s own length, each side. At 0.5 the feature is the middle ' +
      'half of the picture; at 1 it is the middle third.',
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
  // **The shift is asked for in two units, and which one is offered follows the
  // mode.** A fixed window is a couple of dozen bins wide, so *how far away*
  // is a length in base pairs and 100 kb is a long way. A scaled window is as
  // wide as whatever it is piling up — a megabase-long TAD with its flanks is
  // two megabases of window — and a control 100 kb from it is ninety per cent
  // the same cells as the thing it is supposed to be the denominator of. The
  // ratio that comes out is 1 everywhere, the domain washes out of the picture,
  // and nothing on screen says why. So the scaled mode asks in **multiples of
  // the window**, where 1 is the first shift that cannot overlap at all.
  {
    kind: 'number',
    key: 'minShift',
    label: 'Smallest shift',
    default: 100_000,
    min: 0,
    unit: 'bp',
    when: (params) => params.norm === 'matched' && !isScaled(params),
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'maxShift',
    label: 'Largest shift',
    default: 1_000_000,
    min: 1,
    unit: 'bp',
    when: (params) => params.norm === 'matched' && !isScaled(params),
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'minShiftScale',
    label: 'Smallest shift',
    hint: 'As a multiple of the window’s own width. Below 1 a control overlaps the feature.',
    default: 1,
    min: 0,
    max: 20,
    step: 0.5,
    when: (params) => params.norm === 'matched' && isScaled(params),
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'maxShiftScale',
    label: 'Largest shift',
    hint: 'As a multiple of the window’s own width.',
    default: 3,
    min: 0.5,
    max: 50,
    step: 0.5,
    when: (params) => params.norm === 'matched' && isScaled(params),
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
    kind: 'number',
    key: 'minSep',
    label: 'Nearest two features may be',
    unit: 'bp',
    hint: 'Below this a pair is mostly the diagonal it sits on rather than a contact between two places.',
    default: 20_000,
    min: 0,
    integer: true,
    when: (params) => params.anchors === 'allpairs',
    section: 'Separation',
  },
  {
    kind: 'number',
    key: 'maxSep',
    label: 'Furthest two features may be',
    unit: 'bp',
    default: 2_000_000,
    min: 1,
    integer: true,
    when: (params) => params.anchors === 'allpairs',
    section: 'Separation',
  },
  {
    kind: 'number',
    key: 'byDistance',
    label: 'Split by separation into',
    hint:
      'Log-spaced bins, each piled up on its own with its own control. 0 or 1 is one pileup over ' +
      'the lot — which averages a 30 kb contact and a 2 Mb one into a picture of neither.',
    default: 0,
    min: 0,
    max: MAX_DISTANCE_BINS,
    integer: true,
    slider: true,
    when: (params) => params.anchors === 'pairs' || params.anchors === 'allpairs',
    section: 'Separation',
  },
  {
    kind: 'column',
    key: 'rankBy',
    label: 'Rank by',
    from: 'features',
    optional: true,
    noneLabel: 'Do not rank',
    // **Only the on-diagonal mode**, and the reason is that ranking is about
    // *features* while the other two modes pile up *pairs*. A loop set's own
    // score already ranks it; every pair of a feature set has two features and
    // therefore two scores, and there is no one right way to combine them.
    when: (params) => params.anchors === 'features',
    section: 'Ranking',
  },
  {
    kind: 'choice',
    key: 'subset',
    label: 'Then',
    default: 'all',
    when: (params) =>
      params.anchors === 'features' && typeof params.rankBy === 'string' && params.rankBy !== '',
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
    kind: 'track',
    key: 'tracks',
    label: 'Track aggregates',
    multiple: true,
    hint:
      'bigWigs, and anything this panel has already computed. Each is averaged over the same ' +
      'windows the pileup is taken from and drawn along its two edges — the aggregate signal ' +
      'above and beside the aggregate map.',
    // **The figure this task could not draw.** A pileup says *these places
    // touch*; the marginal profiles say *and this is what is bound where they
    // do*, which is the figure behind most of the literature APA is used in.
    // Until this a reader had to run the 1D metaplot separately, over anchors
    // they had to re-derive, and lay the two pictures out by hand — and the two
    // aggregates were over different windows unless they got every setting to
    // agree.
    //
    // Off the chromosight path, which reads whole sequences and answers with its
    // own three outputs rather than with this runner's pileups.
    when: (params) => params.norm !== 'chromosight',
    section: 'Tracks',
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
  // Which **input**, which is no longer the same question as which side of the
  // diagonal: *every pair* reads a feature set and draws off the diagonal.
  const usingPairs = usesPairSet(params)
  const chosen = usingPairs ? params.pairs : params.features
  if (typeof chosen !== 'string' || chosen === '') {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: usingPairs
        ? 'Choose a loop set. A BEDPE dropped on the Annotations panel becomes one.'
        : allPairs(params)
          ? 'Choose the feature set to pair with itself.'
          : 'Choose a feature set to pile up on the diagonal.',
    }
  }

  const entry = context.entries.find((row) => row.id === chosen)
  const features = anchorCount(entry?.summary)
  // **Pairs, not features**, once the pairs are made rather than loaded — and
  // the count is genuinely unknown here, since it depends on how the set packs
  // rather than on how big it is. What can be said before the run is the cap and
  // the fact that it exists, which is the honest half of the estimate; the run
  // itself reports the number it actually generated.
  const anchors = allPairs(params) ? null : features

  // **Refused in the form rather than at Run.** One cell of a scaled pileup is
  // fed by windows at a dozen different separations — that is what scaling is —
  // so it has no one diagonal offset for a P(s) to be looked up at, and
  // dividing by one anyway is a plausible picture of nothing. The other three
  // normalisations all apply; the distance-matched one is drawn at the same
  // separations by construction and is the right answer here.
  if (isScaled(params) && params.norm === 'oe') {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        'Observed / expected needs one diagonal offset per cell, and a scaled window has a ' +
        'different one in every feature. Use the distance-matched control, or turn the scaled ' +
        'mode off.',
    }
  }

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
  // The grid is what comes *out* of a scaled window, never what goes into it:
  // the read is the feature's own bins plus its flanks, which on a domain set is
  // as many bins as the domain is long. Priced as the grid it would understate a
  // megabase-long TAD by two orders of magnitude, so the note says so in words —
  // the number cannot be known here, since the estimate deliberately carries the
  // entries and not their megabytes.
  const scaledNote = isScaled(params)
    ? ' Each window is read at the feature’s own size, flanks included, and resampled onto the ' +
      'grid afterwards — so a long feature is a large read whatever the grid says.'
    : ''
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
  const pairsNote = allPairs(params)
    ? `Every pair of ${features === null ? 'the set' : `${features.toLocaleString()} features`} ` +
      `within the separation range, up to ${MAX_GENERATED_PAIRS.toLocaleString()} of them and ` +
      'sampled with the run’s own seed past that. How many that is depends on how the set packs ' +
      'rather than on how large it is, so the run reports the number rather than the button. ' +
      `One small block per pair of ${side}×${side} cells, at the file’s own resolution, coalesced ` +
      'where the pairs cluster. Cancellable at any point.'
    : null
  return {
    class: 'scan',
    requests,
    bytes: windows === null ? null : windows * cells * 4,
    note:
      (pairsNote ??
        (windows === null
          ? 'One small block per anchor, at the file’s own resolution.'
          : `${windows.toLocaleString()} windows of ${side}×${side} cells, one small block each at ` +
            `the file’s own resolution — at most ${(windows * 2).toLocaleString()} range requests ` +
            'before nearby anchors are read together. Cancellable at any point.')) + scaledNote,
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
  version: 2,
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
      : waitingFor(
          'Load a loop set (BEDPE) to pile up off the diagonal, or a feature set (BED, GTF) to ' +
            'pile up on it — or to pair with itself.',
        )
  },
  params: PARAMS,
  outputs: ['matrix', 'table', 'curve'],
  estimate,
}

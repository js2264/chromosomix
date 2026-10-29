/**
 * Aggregate peak analysis, as a descriptor.
 *
 * The task whose *cost model* is the interesting part, and it is the one place
 * in this catalogue where the expensive choice is the correct one (§18.6).
 *
 * A pileup could be taken from one big read covering every anchor. It must not
 * be: a bounding-box read is pooled at `POOLED_CELL_CAP` (§7.2), so on any
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
  const value = typeof params.window === 'number' ? params.window : 21
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

/**
 * How many diagonals, the main one and those beside it, a window leaves out.
 *
 * coolpuppy's `min_diag`, at its default, and the reason is that this task's
 * pileups are held to coolpuppy's cell for cell (§18.10). The first two
 * diagonals of a map are mostly what ligation could not separate — undigested
 * fragments and self-circles — so a window that reaches the diagonal piles up
 * the protocol as well as the contacts.
 */
export const MIN_DIAG_DEFAULT = 2

/** The diagonals left out of every window; see {@link MIN_DIAG_DEFAULT}. */
export function minDiagOf(params: Params): number {
  const value = typeof params.minDiag === 'number' ? params.minDiag : MIN_DIAG_DEFAULT
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : MIN_DIAG_DEFAULT
}

/**
 * The nearest a loop may be to the diagonal and still be piled up, in bins, when
 * nobody has said. Five: a loop nearer than that is mostly the diagonal's own
 * contacts. coolpuppy's default is further out ({@link autoMinDist}), and the
 * validation, which holds the two to each other, passes that one (§18.10).
 */
export const MIN_DIST_DEFAULT = 5

/**
 * coolpuppy's `mindist='auto'`, in bins: twice the flank and two, the separation
 * at which a window stops reaching the two diagonals {@link MIN_DIAG_DEFAULT}
 * leaves out — so at that floor no window of a loop set has a gap cut in it.
 */
export function autoMinDist(params: Params): number {
  return 2 * windowBins(params) + 2
}

/** The nearest loop piled up, in bins: as typed, or {@link MIN_DIST_DEFAULT}. */
export function minDistOf(params: Params): number {
  const value = params.minDist
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : MIN_DIST_DEFAULT
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
 * Whether a domain pileup's windows are **stretched evenly** onto the grid by
 * interpolation, rather than resampled with every domain's two ends pinned to
 * the same two grid lines: a domain pileup over the expected.
 *
 * Over the expected because that normalisation draws nothing at random, so it
 * is the one scaled pileup that can be held to coolpuppy's (`rescale=True`,
 * `ooe=True`) cell for cell — and it is, in § 24 of the validation notebook
 * (§18.10) — and held to it, it has to be cut and resampled as coolpuppy cuts
 * and resamples it: the domain scaled about its middle, stretched evenly, every
 * grid cell a dropped bin reaches left a gap (`zoomWindow` in analysis/apa.ts).
 * The pinned layout is the better picture of a set of boundaries and stays with
 * the distance-matched control and the raw pileup, which no other tool draws
 * cell for cell anyway.
 */
export function stretchesEvenly(params: Params): boolean {
  return isDomainPileup(params) && params.norm === 'oe'
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
  return params.anchors !== 'pairs' && params.anchors !== 'allpairs' && params.anchors !== 'consecutive'
}

/**
 * Whether one marginal profile is drawn along **both** edges of the pileup.
 *
 * Which anchor of a loop is written first in a BEDPE is whichever sits further
 * left on the sequence, and nothing else — it is not upstream in any biological
 * sense, not the cause of the contact, not the end with the factor on it.
 * Profiled apart, the top edge of the pileup is every pair's second anchor and
 * the right edge every pair's first, so the two lines differ by whatever that
 * ordering happened to sort; a reader comparing them reads a difference between
 * the two ends of a loop that the file never claimed. Pooled, both edges are one
 * mean over twice as many anchors, which is the better-estimated profile as well
 * as the honest one — so it is on.
 *
 * Off is for the file where the ordering *is* the figure: a BEDPE whose left
 * column is always the promoter, say, where what the reader came for is exactly
 * how the two ends differ.
 *
 * Never on the diagonal, where both axes cut the same window from the same
 * feature and the two profiles are already the same numbers.
 */
export function poolsAnchors(params: Params): boolean {
  return !onDiagonal(params) && params.symmetric !== false
}

/** Whether any track was picked to be profiled along the edges. */
function hasTracks(params: Params): boolean {
  const value = params.tracks
  if (Array.isArray(value)) return value.length > 0
  return typeof value === 'string' && value !== ''
}

/** Whether a feature set is ranked by one of its columns — the Ranking card's question. */
function ranked(params: Params): boolean {
  return params.anchors === 'features' && typeof params.rankBy === 'string' && params.rankBy !== ''
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

/**
 * Whether the pairs are **each feature with the next** along its sequence.
 *
 * Made from one feature set like {@link allPairs}, and read like a loaded loop
 * set once made: one pair a neighbour, no separation range of its own, and the
 * nearest loop (`minDist`) as the one floor — which is what a BEDPE of the same
 * pairs gets, here and in coolpuppy. It is the pairing a set of boundary sites
 * is asked about — are two consecutive CTCF peaks in contact — and the one no
 * range over *every* pair can give: between two neighbours lies no third site.
 */
export function consecutivePairs(params: Params): boolean {
  return params.anchors === 'consecutive'
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
    label: 'anchors',
    default: 'pairs',
    options: [
      {
        value: 'pairs',
        label: 'loop set',
        needsKinds: ['pairs'],
        hint: 'Off the diagonal, between two anchors.',
      },
      {
        value: 'features',
        label: 'feature set',
        needsKinds: INTERVAL_KINDS,
        hint: 'On the diagonal, at each feature.',
      },
      {
        value: 'allpairs',
        label: 'every pair of a feature set',
        needsKinds: INTERVAL_KINDS,
        hint:
          'Off the diagonal, between every two features within a separation range — the test of ' +
          'whether a set of places contacts itself.',
      },
      {
        value: 'consecutive',
        label: 'consecutive features',
        needsKinds: INTERVAL_KINDS,
        hint:
          'Off the diagonal, between each feature and the next one along its sequence — the pairs ' +
          'of neighbouring sites, such as consecutive CTCF peaks.',
      },
    ],
  },
  {
    kind: 'pairSet',
    key: 'pairs',
    label: 'pairs',
    when: (params) => params.anchors === 'pairs',
  },
  {
    kind: 'featureSet',
    key: 'features',
    label: 'features',
    when: (params) => params.anchors !== 'pairs',
  },
  {
    kind: 'choice',
    key: 'mode',
    label: 'mode',
    default: 'fixed',
    options: [
      { value: 'fixed', label: 'fixed window', hint: 'Centre plus or minus a number of bins.' },
      {
        value: 'scaled',
        label: 'scaled',
        hint:
          'Flank, the feature, flank — every window on one grid. Over a set of domains this is ' +
          'the domain pileup: the TAD in the middle and its two boundaries as the cross through it.',
      },
    ],
    // The chromosight pileup's window is its template's size. See {@link isScaled}.
    when: (params) => params.norm !== 'chromosight',
  },
  // **Below the mode, not above it**: whether there is a point to choose is the
  // mode's to say — a domain pileup's window is the feature, start to end — so
  // the row follows the question that opens and closes it. Above it, the form
  // grew a row between *features* and *mode* in one mode and lost it in the other.
  {
    kind: 'choice',
    key: 'at',
    label: 'anchor on',
    default: 'centre',
    // **No hint beside the label.** *Centre*, *Start* and *End* of a feature are
    // not terms a reader of this form needs explained, and the three options
    // carry one line each already — a paragraph above them about which end of a
    // minus-strand gene is its 5′ end was three lines of the card spent saying
    // what the options say.
    //
    // **The same control the 1D metaplot has, and it was missing here alone.** A
    // pileup at a set of genes centred on their midpoints is a pileup at
    // whatever is half way along a gene, which is a different question from the
    // one anybody asks of a gene set: what the contact map looks like at the
    // TSS. Hidden where there is no point to choose — a loaded loop set brings
    // its own two anchors, and a domain pileup's window *is* the feature, start
    // to end, with a flank each side.
    when: (params) => params.anchors !== 'pairs' && !isDomainPileup(params),
    options: [
      { value: 'centre', label: 'centre', hint: 'Half way along the feature.' },
      { value: 'start', label: 'start', hint: 'Its 5′ end — a TSS, on a gene model.' },
      { value: 'end', label: 'end', hint: 'Its 3′ end.' },
    ],
  },
  {
    kind: 'number',
    key: 'window',
    label: 'half-width',
    // Twenty-one bins a side, so the picture is 43 across. Twelve was narrow
    // enough that a loop filled it: the corners a P2LL divides by were a couple
    // of bins from the peak rather than background, and a reader had nowhere to
    // see the pileup sit back down to it.
    default: 21,
    min: 1,
    max: 200,
    integer: true,
    unit: 'bins',
    when: (params) => !isScaled(params) && params.norm !== 'chromosight',
  },
  {
    kind: 'number',
    key: 'grid',
    label: 'grid',
    hint:
      'Every window resampled to this many cells a side; a multiple of four puts the feature’s ' +
      'two ends on axis ticks.',
    default: 51,
    min: 11,
    max: 201,
    integer: true,
    when: (params) => isScaled(params),
  },
  {
    kind: 'number',
    key: 'flankFraction',
    label: 'flank',
    hint:
      'As a fraction of the feature’s own length each side: at 0.5 the feature is the middle ' +
      'half of the picture, at 1 the middle third.',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.1,
    slider: true,
    when: (params) => isScaled(params),
  },
  {
    kind: 'number',
    key: 'minDiag',
    label: 'diagonals left out',
    // **And nothing is ever taken from below the diagonal**, which is not a
    // setting because it is not a choice: a window that crosses the diagonal
    // holds the same contacts twice there, once above it and once mirrored
    // below, and coolpuppy cuts its windows from the upper triangle for that
    // reason. On the diagonal the window is its own mirror and is drawn whole.
    hint: 'The main diagonal and the ones beside it, left out of every window; 0 keeps every one.',
    default: MIN_DIAG_DEFAULT,
    min: 0,
    max: 50,
    integer: true,
    // The chromosight pileup detrends the map first and keeps chromosight's own
    // rule about the diagonal, which is part of the score it reports.
    when: (params) => params.norm !== 'chromosight',
  },
  {
    kind: 'choice',
    key: 'norm',
    label: 'normalisation',
    default: 'oe',
    options: [
      {
        value: 'matched',
        label: 'distance-matched',
        hint: 'Against shifted anchors at the same separations. Controls for local background too.',
      },
      {
        value: 'oe',
        label: 'observed / expected',
        hint: 'Each window over its sequence’s own P(s). Controls for the distance decay only.',
      },
      { value: 'none', label: 'none', hint: 'The raw pileup.' },
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
    label: 'template',
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
    label: 'controls per pair',
    default: 5,
    min: 1,
    max: 25,
    integer: true,
    slider: true,
    when: (params) => params.norm === 'matched',
    section: 'Control',
  },
  // **The shift is asked for in two units, and which one is offered follows the
  // mode.** A fixed window is a couple of dozen bins wide, so *how far away* is
  // a number of bins and the window's own half-width is the scale to think in. A
  // scaled window is as wide as whatever it is piling up — a megabase-long TAD
  // with its flanks is two megabases of window — so a shift in bins there would
  // mean something different for every domain in the set, and it asks in
  // **multiples of the window** instead, where 1 is the first shift that cannot
  // overlap at all.
  //
  // In bins rather than base pairs, and the fixed mode is the case that makes
  // the rule: the default window is 21 bins each side, 43 across, and the
  // nearest control has to clear it or it is ninety per cent the same cells as
  // the thing it is supposed to be the denominator of. `100 kb` cleared it on a
  // 1 kb map and was ten bins — inside the window — on a 10 kb one, so the same
  // typed number was a sound control at one resolution and a copy of the signal
  // at the next, with nothing on screen saying which. 50 bins clears the default
  // window at every resolution there is.
  {
    kind: 'number',
    key: 'minShift',
    label: 'smallest shift',
    hint: 'A control nearer than the window’s own width overlaps the anchors it stands in for.',
    default: 50,
    min: 0,
    integer: true,
    unit: 'bins',
    when: (params) => params.norm === 'matched' && !isScaled(params),
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'maxShift',
    label: 'largest shift',
    default: 500,
    min: 1,
    integer: true,
    unit: 'bins',
    when: (params) => params.norm === 'matched' && !isScaled(params),
    section: 'Control',
  },
  {
    kind: 'number',
    key: 'minShiftScale',
    label: 'smallest shift',
    hint: 'As a multiple of the window’s own width; below 1 a control overlaps the feature.',
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
    label: 'largest shift',
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
    label: 'seed',
    hint: 'The same seed gives the same control twice.',
    default: 1,
    when: (params) => params.norm === 'matched',
    section: 'Control',
  },
  // **The nearest loop, coolpuppy's `mindist`**, five bins by default
  // ({@link MIN_DIST_DEFAULT}). A loop set, or the neighbours of a feature set,
  // and the fixed mode only: *every pair* has a separation range of its own just
  // below, and a scaled window is a fraction of its separation, which never
  // reaches the diagonal. Measured
  // between the two anchors' centres, in base pairs against this many bins of
  // the file, which is how coolpuppy measures it.
  {
    kind: 'number',
    key: 'minDist',
    label: 'nearest loop',
    hint:
      'Loops nearer the diagonal than this are left out, 0 keeping every one; from twice the ' +
      'half-width and two, no window reaches the first two diagonals.',
    default: MIN_DIST_DEFAULT,
    min: 0,
    integer: true,
    unit: 'bins',
    when: (params) =>
      (usesPairSet(params) || consecutivePairs(params)) && !isScaled(params) && params.norm !== 'chromosight',
    section: 'Separation',
  },
  // **The range two features may be apart is a range of bin offsets**, which is
  // what the pileup itself is a picture of: a pair's separation is `col − row`,
  // the split-by-separation bands are bin offsets, and the near-diagonal a pair
  // is dropped for sitting on is one or two bins wide whatever the resolution.
  // In base pairs the floor was 20 kb, which is twenty bins of a 1 kb map — most
  // of the short-range contacts a peak set is run for — and none at all of a
  // 50 kb one.
  {
    kind: 'number',
    key: 'minSep',
    label: 'nearest two features may be',
    unit: 'bins',
    hint: 'Below this a pair is mostly the diagonal it sits on rather than a contact between two places.',
    default: 2,
    min: 0,
    integer: true,
    when: (params) => params.anchors === 'allpairs',
    section: 'Separation',
  },
  {
    kind: 'number',
    key: 'maxSep',
    label: 'furthest two features may be',
    unit: 'bins',
    default: 200,
    min: 1,
    integer: true,
    when: (params) => params.anchors === 'allpairs',
    section: 'Separation',
  },
  {
    kind: 'number',
    key: 'byDistance',
    label: 'split by separation into',
    hint:
      'Log-spaced bands, each piled up on its own with its own control; one band averages a ' +
      '30 kb contact and a 2 Mb one into a picture of neither.',
    default: 0,
    min: 0,
    max: MAX_DISTANCE_BINS,
    integer: true,
    slider: true,
    when: (params) => !onDiagonal(params),
    section: 'Separation',
  },
  {
    kind: 'column',
    key: 'rankBy',
    label: 'rank by',
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
    label: 'then',
    default: 'all',
    when: ranked,
    options: [
      { value: 'all', label: 'one pileup' },
      { value: 'top', label: 'top N' },
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
    when: (params) => ranked(params) && params.subset === 'top',
    section: 'Ranking',
  },
  {
    kind: 'number',
    key: 'groups',
    label: 'groups',
    default: 4,
    min: 2,
    max: 6,
    integer: true,
    slider: true,
    when: (params) => ranked(params) && params.subset === 'groups',
    section: 'Ranking',
  },
  {
    kind: 'track',
    key: 'tracks',
    label: 'track aggregates',
    multiple: true,
    // Optional, because a pileup with no profile on its edges is a pileup: the
    // reader who unticks every track has answered, and a required list would
    // tick the starred one back on the next run.
    optional: true,
    hint:
      'Each is averaged over the same windows the pileup is taken from and drawn along its two ' +
      'edges — the aggregate signal above and beside the aggregate map.',
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
  {
    kind: 'toggle',
    key: 'symmetric',
    label: 'same profile both sides',
    hint:
      'One aggregate over every anchor, drawn identically above and beside. Untick to keep each ' +
      'pair’s two anchors apart — the second along the top, the first down the right.',
    default: true,
    // See {@link poolsAnchors}, which is where the argument for the default is.
    // Offered only where it changes something: on the diagonal both axes cut
    // the same window, and a tickbox that does nothing is worse than no tickbox.
    when: (params) => params.norm !== 'chromosight' && !onDiagonal(params) && hasTracks(params),
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
          : consecutivePairs(params)
            ? 'Choose the feature set whose neighbours to pair.'
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

  // **Refused in the form rather than at Run, for scaled pairs only.** A window
  // is divided by the expected cell by cell, at each cell's own diagonal of the
  // map, *before* it is resampled — so a scaled window has an expected as much
  // as a fixed one does, and a domain pileup over it is coolpuppy's own and is
  // held to it ({@link stretchesEvenly}). It used to be refused on the diagonal
  // too, from when the finished pileup was divided by one expected per grid
  // cell, which on a scaled grid has no meaning. Off the diagonal the scaled
  // window is this task's own square about the loop and coolpuppy draws none
  // like it, so there is nothing to hold it to; the distance-matched control is
  // drawn at the same separations by construction.
  if (isScaled(params) && params.norm === 'oe' && !onDiagonal(params)) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        'Observed / expected on a scaled grid is for a feature set on the diagonal. For pairs, ' +
        'use the distance-matched control, or turn the scaled mode off.',
    }
  }

  // The chromosight normalisation is priced differently because it *reads*
  // differently: the distance law it detrends by is a property of a whole
  // sequence, so it reads each sequence the anchors sit on along its diagonal,
  // as far as the set reaches and a template beyond, rather than one small
  // block per anchor — and saying "k windows" here would price the wrong run.
  //
  // In words and not in numbers. How deep that band is depends on the set's
  // furthest pair, and the estimate carries the entries rather than their
  // contents, so the requests and the bytes are not known until the run reads
  // the set. This line used to price the square around every sequence instead,
  // which is what the runner read before it read a band — on a mammalian
  // chromosome a hundred times what it reads now, which is not a price.
  if (isChromosight(params)) {
    return {
      class: 'scan',
      requests: null,
      bytes: null,
      note:
        'Each sequence the anchors sit on, read as a band along its diagonal as far as the set ' +
        'reaches, detrended by its own distance law, then a window cut at each anchor and scored ' +
        'against the template. ' +
        `${anchors === null ? '' : `${anchors.toLocaleString()} anchors.`}`,
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

  // **Observed / expected reads more than its windows.** What a window is divided
  // by is its own sequence's expected — the mean of each diagonal it reaches,
  // over the whole sequence, which is the `expected_cis` coolpuppy is handed —
  // so every sequence the anchors sit on is read as a band as deep as its
  // farthest window. How deep that is depends on the set's longest pair, which
  // the estimate does not hold, so it is said in words, as the chromosight
  // pileup's band is.
  if (params.norm === 'oe') {
    return {
      class: 'scan',
      requests: null,
      bytes: null,
      note:
        (windows === null
          ? 'One small block per anchor, at the file’s own resolution'
          : `${windows.toLocaleString()} windows of ${side}×${side} cells, at the file’s own ` +
            'resolution') +
        ', and each sequence the anchors sit on read as a band along its diagonal, as deep as ' +
        'its farthest window reaches, for the expected every window is divided by.',
    }
  }

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
      'where the pairs cluster.'
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
            'before nearby anchors are read together.')) + scaledNote,
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
  keywords: ['APA', 'pileup', 'aggregate', 'loops', 'coolpup'],
  group: '2d',
  venue: 'analysis',
  // 3: windows cut as coolpuppy cuts them, observed / expected divided window by
  // window over the sequence's own expected, and the nearest loop (§18.8).
  version: 3,
  // **Not** `requires: ['expected']`, though §18.8 describes the O/E path as
  // needing it. `requires` is static and the runner resolves it before every
  // run, so declaring it would compute a whole-file P(s) on every APA — while
  // O/E is not the default and most runs never look at it. And the expected an
  // APA needs is a narrower question than the task's: the diagonals its own
  // windows reach, on the sequences its own anchors sit on, which the runner
  // reads as one band per sequence and never deeper than the farthest window.
  // It is *not* the windows' own cells, which is what it once was: an expected
  // taken from squares about a loop set is the mean of the places the set
  // picked, enriched by construction, and not the sequence's.
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
      : waitingFor('Load a loop set (BEDPE), or a feature set (BED, GTF).')
  },
  params: PARAMS,
  outputs: ['matrix', 'table', 'curve'],
  estimate,
}

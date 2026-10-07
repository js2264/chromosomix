/**
 * Diamond insulation, as a descriptor.
 *
 * The task that produces the app's first *called* object: a boundary set, drawn
 * as a 1D track or on the map and exported as a BED. Everything before it produced
 * a picture or a track, which are readings; a call is a claim, and the two
 * parameters that decide how many claims it makes — the window and the
 * prominence — are therefore the two the form puts first (§18.2).
 *
 * **The window is a ladder rather than a list.** A reader comparing scales wants
 * `w`, `2w`, `4w`, and the alternative — a free-text list of widths — needs a
 * text control this form does not have and a parser with its own failure modes,
 * to express something a base and a count express exactly. So the base is
 * settable in bins (below), the count is settable, and the ladder doubles. Where a
 * genuinely irregular set of widths is wanted, running the task twice is the
 * honest way to get it and leaves two provenance lines rather than one.
 */

import { extentOf, framingCovers, tickedContigs } from '../context'
import { diagonalTiles } from '../tiles'
import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * The base window in **bins**, at least one.
 *
 * Bins rather than base pairs, and for the reason the diamond itself gives: the
 * window is a count of cells on each side of the bin being scored, so the number
 * that decides what the track measures has always been this one — the form asked
 * for base pairs and then divided. A reader who wanted a ten-bin diamond had to
 * know their own resolution to ask for it, and the same typed number was a
 * different diamond at every resolution of an `.mcool`.
 *
 * The 10-bin default is what the old `10 × binsize` resolved to, so a form left
 * alone computes what it always did.
 */
export function windowBinsOf(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : 10
  return Math.max(1, Math.round(value))
}

/** How many doublings of the base window to compute. */
export function scalesOf(params: Params): number {
  const value = typeof params.scales === 'number' ? params.scales : 1
  return Math.max(1, Math.min(4, Math.trunc(value)))
}

/** The ladder, in bins, one entry per scale. */
export function windowLadder(params: Params): number[] {
  const base = windowBinsOf(params)
  const out: number[] = []
  for (let i = 0; i < scalesOf(params); i++) out.push(base * 2 ** i)
  return out
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'number',
    key: 'window',
    label: 'window',
    hint: 'The diamond is a square this many bins on a side, cornered on the bin it scores.',
    default: 10,
    min: 1,
    integer: true,
    unit: 'bins',
  },
  {
    kind: 'number',
    key: 'scales',
    label: 'scales',
    hint: 'One track per scale, each twice the width of the last.',
    default: 1,
    min: 1,
    max: 4,
    integer: true,
    slider: true,
  },
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  {
    kind: 'number',
    key: 'ignoreDiags',
    label: 'diagonals to ignore',
    /**
     * cooltools' `ignore_diags`, and the same rule the compartment chain applies:
     * `0` counts every cell, `1` drops the main diagonal, `2` drops it and the
     * two beside it.
     *
     * The diamond is cornered on the bin's own diagonal pixel, so what this trims
     * is that **corner** — the pixel and the cells one bin of separation from it,
     * where self-ligation and unligated fragments land. They are the largest in
     * the matrix, so at a small window the corner can be most of the mean, and a
     * track carried by it is a picture of how deep the near-diagonal is rather
     * than of what crosses the bin.
     *
     * Two by default, which is cooltools' default and what the numbers a reader
     * compares against were computed with.
     */
    hint: '0 counts every cell; 2 leaves out the corner of the diamond on the diagonal.',
    default: 2,
    min: 0,
    integer: true,
    section: 'Quality',
  },
  BALANCE_PARAM,
  {
    kind: 'toggle',
    key: 'call',
    label: 'call boundaries',
    hint: 'Adds the calls as a set of their own, a 1D track under the score to begin with.',
    default: true,
    section: 'Boundaries',
  },
  {
    kind: 'number',
    key: 'prominence',
    label: 'minimum prominence',
    hint: 'How far the track must climb from a minimum before it falls lower, in log2 units.',
    default: 0.2,
    min: 0,
    max: 3,
    step: 0.05,
    slider: true,
    when: (params) => params.call === true,
    section: 'Boundaries',
  },
  /**
   * cooltools' `min_frac_valid_pixels`, and only for the calls.
   *
   * Every bin is scored — a diamond that runs off the end of its sequence or
   * over a dropped row averages the cells it holds — but a mean of a handful of
   * cells is a noisy one, and a minimum in it is not a boundary. So the bins
   * whose diamond holds less than this share of the fullest diamond of the run
   * are left out of the track the minima are found on, as cooltools leaves them.
   */
  {
    kind: 'number',
    key: 'minValid',
    label: 'diamond coverage to call',
    hint: 'Bins whose diamond holds less than this share of the fullest one’s cells are not called.',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    when: (params) => params.call === true,
    section: 'Boundaries',
  },
  {
    kind: 'number',
    key: 'spacing',
    label: 'minimum spacing',
    // In bins, like the window above it. One form asking for one distance in
    // bins and another in base pairs is a form a reader has to read twice, and
    // both of these are distances along the same track.
    hint: 'Two calls closer than this many bins keep only the stronger.',
    default: 0,
    min: 0,
    integer: true,
    unit: 'bins',
    when: (params) => params.call === true,
    section: 'Boundaries',
  },
  /**
   * The domains between the calls, as a second called set (§18.7).
   *
   * **On by default, because a boundary set is half an answer.** What a reader
   * wants from insulation is nearly always the *domains* — the spans a boundary
   * set implies — and everything downstream takes an interval rather than a
   * point: a scaled pileup over them is the domain APA, an overlap counts how
   * many genes sit inside one, and a BED of them is what leaves for another
   * tool. Producing only the calls left every one of those a script away, and
   * the script is the same eight lines every time: sort per sequence, pair the
   * neighbours.
   *
   * It costs nothing — the calls are already in hand, and this is arithmetic
   * over a few thousand of them — so it is a tickbox rather than a second run,
   * and it is ticked. A reader who wants only the points unticks it.
   */
  {
    kind: 'toggle',
    key: 'domains',
    label: 'domains between them',
    hint: 'A second set, the span from each call to the next, drawn as corners along the diagonal to begin with.',
    default: true,
    when: (params) => params.call === true,
    section: 'Boundaries',
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const balance = params.balance === true
  const windows = windowLadder(params)
  const widest = windows[windows.length - 1]
  const chosen = tickedContigs(context, params, 'sequences')
  if (chosen.length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Tick at least one sequence.',
    }
  }

  // Every ticked sequence is read, however short: a diamond that runs off the
  // end of one averages the cells it has, as cooltools' does, so no sequence is
  // too short to score.
  const extent = extentOf(chosen)

  const framing = context.framing
  if (
    context.blockLoaded &&
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === balance &&
    framingCovers(framing, extent)
  ) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Computed from the block already on screen. No reads.',
    }
  }

  // **Per tile, not per sequence.** The diamond reaches `widest` bins each side
  // of the bin it scores, so a sequence is read as a run of squares along its
  // diagonal rather than as the whole square — which is what lets a mammalian
  // chromosome be scored at 5 kb at all. The estimate has to count the same
  // reads: one square over a chromosome was four requests and the truth is four
  // per tile, which on mouse chr1 is off by two orders of magnitude.
  const each = balance ? 5 : 4
  if (chosen.length === 1) {
    const contig = chosen[0]
    const tiles = diagonalTiles(contig.bins, widest)
    const requests = tiles * each
    return {
      class: 'bounded',
      requests,
      bytes: null,
      note:
        `About ${requests.toLocaleString()} range requests: ${contig.name} is read as ` +
        `${tiles.toLocaleString()} ${tiles === 1 ? 'square' : 'squares'} along its diagonal, ` +
        'never as the whole square.',
    }
  }

  // Every ticked sequence, tile by tile. Bounded per contig and unbounded in the
  // count of them, which on a metagenome is the expensive shape — so it is
  // priced as a scan and gated like one, with the count named.
  const tiles = chosen.reduce((sum, entry) => sum + diagonalTiles(entry.bins, widest), 0)
  return {
    class: 'scan',
    requests: tiles * each,
    bytes: null,
    note:
      `${chosen.length.toLocaleString()} sequences, read as ` +
      `${tiles.toLocaleString()} ${tiles === 1 ? 'square' : 'squares'} along their diagonals.`,
  }
}

export const INSULATION_TASK: AnalysisTask = {
  id: 'insulation',
  title: 'Diamond insulation',
  blurb: 'How much contact crosses each bin, and where the boundaries are.',
  group: '2d',
  venue: 'analysis',
  // 2: cooltools' definition — the mean of the diamond's valid cells over the
  // sequence's median, and its boundaries — where 1 summed a diamond half a bin
  // along and divided by the mean.
  version: 2,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile', 'intervals'],
  estimate,
}

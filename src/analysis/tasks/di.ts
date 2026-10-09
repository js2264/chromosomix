/**
 * The directionality index, as a descriptor.
 *
 * It sits directly after the diamond because it is the *other* answer to the
 * question the diamond asks, and a reader who has one wants the other. Both are
 * per-bin readings of a domain edge; they disagree about what an edge is, and the
 * disagreement is informative rather than a nuisance. Insulation says *little
 * contact crosses here* and finds the boundary whatever is on either side of it.
 * The directionality index says *this bin looks one way* and finds the boundary
 * from the asymmetry, which means it also marks the **inside** edges of a domain
 * and gives the sign flip that Dixon's HMM segmented on. A boundary both agree
 * about is a boundary.
 *
 * ## The window is in bins, like the diamond's
 *
 * Both tasks look a bounded distance up the diagonal and down it, and both are
 * read side by side against the same map — so a reader comparing them is
 * comparing two windows, and a form that asks for one in bins and the other in
 * base pairs makes that comparison arithmetic. The diamond's argument for bins
 * applies here unchanged: the window is a count of cells the statistic sums, so
 * the number that decides what it measures has always been this one, and a
 * reader who wants the two tasks at the same scale can now type the same number
 * into both.
 *
 * The cost is the one bins always carry: **the default is a different genomic
 * distance on every rung of an `.mcool`**, where Dixon's 2 Mb was the same
 * distance everywhere. {@link DEFAULT_DI_WINDOW_BINS} is 50, which is that 2 Mb
 * at the 40 kb the 2012 paper worked at, and the runner says in a note what the
 * window came to in base pairs on the file actually open — because a 50-bin
 * window on a 1 kb bacterial map is 50 kb and is a different reading of the
 * genome, and that is worth being told once rather than inferring from a track.
 *
 * ## Borders and domains
 *
 * The same two outputs the diamond produces, called from the same kernel: see
 * `analysis/di.ts` for why the index is integrated first and what the prominence
 * is measured in. A border here is a **sign flip** — the bin where the track
 * stops looking upstream and starts looking downstream — where the diamond's is
 * a minimum, so the two sets are independent readings of the same edges and a
 * border both agree on is worth more than either.
 */

import { extentOf, framingCovers, tickedContigs } from '../context'
import { bandTiles } from '../tiles'
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
 * Dixon et al. 2012's 2 Mb, in bins of the 40 kb map the paper computed it on.
 *
 * A default has to be a number rather than a distance now that the form asks in
 * bins, and this is the number that reproduces the published reading on a
 * mammalian map opened at its usual resolution.
 */
export const DEFAULT_DI_WINDOW_BINS = 50

/** The window in bins, at least one. */
export function windowBinsOf(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : DEFAULT_DI_WINDOW_BINS
  return Math.max(1, Math.round(value))
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'number',
    key: 'window',
    label: 'window',
    hint:
      'Contacts are summed this many bins each way of every bin, 50 being Dixon et al.’s 2 Mb ' +
      'at the 40 kb they worked at.',
    default: DEFAULT_DI_WINDOW_BINS,
    min: 1,
    integer: true,
    unit: 'bins',
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
     * `0`, where the diamond's is `2`, and `analysis/di.ts` argues the
     * difference: the index differences two sums that both contain the
     * near-diagonal, so it largely cancels, and Dixon's own numbers were
     * computed with every cell in.
     */
    hint: '0 counts every cell; the bin’s contact with itself is never in either sum.',
    default: 0,
    min: 0,
    integer: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'minimum coverage of each side',
    hint: 'Below this fraction of usable cells — on either side — the bin gets no score.',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    section: 'Quality',
  },
  BALANCE_PARAM,
  /**
   * The borders, and the domains between them.
   *
   * On by default, for the reason the diamond's are: the index is a reading and
   * a reader almost always wants the call under it, the calls cost nothing once
   * the track exists, and producing only the track left the same eight lines of
   * script to be written every time. A reader who wants the curve alone unticks
   * it.
   */
  {
    kind: 'toggle',
    key: 'call',
    label: 'call borders',
    hint: 'Adds the borders as a set of their own, a 1D track under the index to begin with.',
    default: true,
    section: 'Borders',
  },
  {
    kind: 'number',
    key: 'prominence',
    label: 'minimum prominence',
    /**
     * In bins of ordinary directional bias, which is the unit
     * `integratedDirection` standardises the curve into and is not the index's
     * own. A χ² grows with how deep the library was sequenced, so a
     * threshold in χ² is a different threshold on every file and a reader who
     * found a good one on one map would look for it again from scratch on the
     * next. This one is a property of the structure: *how many bins of typical
     * bias does the arm on each side of this border carry*.
     *
     * Ten by default — a domain arm of about ten bins at full strength, which at
     * the 50-bin window above is a modest domain and calls a set a reader can
     * then thin rather than one they have to go looking for.
     */
    hint: 'How many bins of steady bias the track must carry on both sides of a flip.',
    default: 10,
    min: 0,
    max: 200,
    step: 1,
    slider: true,
    when: (params) => params.call === true,
    section: 'Borders',
  },
  {
    kind: 'number',
    key: 'spacing',
    label: 'minimum spacing',
    hint: 'Two calls closer than this many bins keep only the stronger.',
    default: 0,
    min: 0,
    integer: true,
    unit: 'bins',
    when: (params) => params.call === true,
    section: 'Borders',
  },
  {
    kind: 'toggle',
    key: 'domains',
    label: 'domains between them',
    hint: 'A second set, the span from each border to the next, drawn as corners along the diagonal to begin with.',
    default: true,
    when: (params) => params.call === true,
    section: 'Borders',
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const balance = params.balance === true
  const window = windowBinsOf(params)
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

  // **Priced over the sequences that can carry the window, not over the ticks.**
  // A bin needs a whole window each side, so a sequence no longer than the
  // window contributes nothing at any cost — and the run says so rather than
  // reading it. With one ticked that is a refusal naming it, which is the same
  // sentence the single dropdown used to produce; with several it counts them,
  // since a metagenome's short contigs are the ordinary case and not a mistake.
  const long = chosen.filter((entry) => entry.bins > window)
  if (long.length === 0) {
    const one = chosen.length === 1 ? chosen[0] : null
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        one !== null
          ? `${one.name} is ${one.bins.toLocaleString()} bins and the window is ` +
            `${window.toLocaleString()}, so no bin on it has a whole window either side. Use a ` +
            'narrower window, or a longer sequence.'
          : `No ticked sequence is longer than a ${window.toLocaleString()}-bin window, so no ` +
            'bin on any of them has a whole window either side. Use a narrower window, or tick ' +
            'a longer sequence.',
    }
  }

  const extent = extentOf(long)

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

  // **A band, not a square**, which is what makes a 2 Mb window on a mammalian
  // chromosome a sane thing to ask for at all: the index reaches `window` bins
  // each way and no further, so what is read is `(window + 1) × n` cells rather
  // than `n²`. `bandFor` tiles it; the count below is that walk's, and it is the
  // same arithmetic `analysis/run/blocks.ts` does.
  const perTile = balance ? 5 : 4
  if (long.length === 1) {
    const contig = long[0]
    const tiles = bandTiles(contig.bins, window)
    const requests = tiles * perTile
    return {
      class: 'bounded',
      requests,
      bytes: null,
      note:
        `About ${requests.toLocaleString()} range requests: ${contig.name} is read as a band ` +
        `${window.toLocaleString()} bins deep, in ${tiles.toLocaleString()} ` +
        `${tiles === 1 ? 'strip' : 'strips'}, never as the whole square.`,
    }
  }

  const tiles = long.reduce((sum, entry) => sum + bandTiles(entry.bins, window), 0)
  return {
    class: 'scan',
    requests: tiles * perTile,
    bytes: null,
    note:
      `${long.length.toLocaleString()} sequences are long enough for this window, read as ` +
      `${tiles.toLocaleString()} ${tiles === 1 ? 'strip' : 'strips'} along their diagonals.`,
  }
}

export const DI_TASK: AnalysisTask = {
  id: 'di',
  title: 'Directionality index',
  blurb: 'Which way each bin looks, and the domains the sign flips call.',
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile', 'intervals'],
  estimate,
}

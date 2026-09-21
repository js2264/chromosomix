/**
 * Diamond insulation, as a descriptor.
 *
 * The task that produces the app's first *called* object: a boundary set, drawn
 * on the map as an overlay and exported as a BED. Everything before it produced
 * a picture or a track, which are readings; a call is a claim, and the two
 * parameters that decide how many claims it makes — the window and the
 * prominence — are therefore the two the form puts first (§18.2).
 *
 * **The window is a ladder rather than a list.** A reader comparing scales wants
 * `w`, `2w`, `4w`, and the alternative — a free-text list of widths — needs a
 * text control this form does not have and a parser with its own failure modes,
 * to express something a base and a count express exactly. So the base is
 * settable in base pairs, the count is settable, and the ladder doubles. Where a
 * genuinely irregular set of widths is wanted, running the task twice is the
 * honest way to get it and leaves two provenance lines rather than one.
 */

import { contigNamed, framingCovers } from '../context'
import { diagonalTiles } from '../tiles'
import type {
  AnalysisContext,
  AnalysisTask,
  ContextContig,
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

function regionOf(params: Params): string {
  return typeof params.region === 'string' ? params.region.trim() : ''
}

function regionContig(context: AnalysisContext, region: string): ContextContig | undefined {
  const name = region.split(':')[0].trim()
  return name === '' ? undefined : contigNamed(context, name)
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'number',
    key: 'window',
    label: 'window',
    hint: 'The diamond is this many bins wide on each side of the bin it scores.',
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
    kind: 'region',
    key: 'region',
    label: 'sequence',
    sequences: true,
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
     * The diamond never touches the main diagonal, so what this trims is its
     * **inner corner** — the cells one and two bins of separation from it, where
     * self-ligation and unligated fragments land. They are the largest in the
     * matrix, so at a small window that corner can be most of the sum, and a
     * track carried by it is a picture of how deep the near-diagonal is rather
     * than of what crosses the bin.
     *
     * Two by default, which is cooltools' default and what the numbers a reader
     * compares against were computed with.
     */
    hint: '0 counts every cell; 2 trims the corner of the diamond nearest the diagonal.',
    default: 2,
    min: 0,
    integer: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'minimum coverage of the diamond',
    hint: 'Below this fraction of usable cells the bin gets no score at all.',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    section: 'Quality',
  },
  BALANCE_PARAM,
  {
    kind: 'toggle',
    key: 'call',
    label: 'call boundaries',
    hint: 'Adds a BED of boundary calls, drawn on the map.',
    default: true,
    section: 'Boundaries',
  },
  {
    kind: 'number',
    key: 'prominence',
    label: 'minimum prominence',
    hint: 'How far the track must climb on both sides of a minimum, in log2 units.',
    default: 0.2,
    min: 0,
    max: 3,
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
   * The domains between the calls, as a second overlay.
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
    hint: 'A second overlay: the span from each call to the next, as a BED.',
    default: true,
    when: (params) => params.call === true,
    section: 'Boundaries',
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const balance = params.balance === true
  const windows = windowLadder(params)
  const widest = windows[windows.length - 1]
  const contig = regionContig(context, regionOf(params))

  // A window wider than the sequence it is scoring has no bin at which the whole
  // diamond fits, so every bin comes back NaN — an empty track, produced at full
  // cost. Better to say so than to draw nothing and let the reader wonder.
  if (contig !== undefined && contig.bins <= widest * 2) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `${contig.name} is ${contig.bins.toLocaleString()} bins and the widest diamond is ` +
        `${widest.toLocaleString()} on each side, so no bin on it has a whole window either ` +
        'side. Use a narrower window, fewer scales, or a longer sequence.',
    }
  }

  const extent: [number, number] =
    contig === undefined
      ? [0, context.nBins]
      : [contig.startBin, contig.startBin + contig.bins]

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
  if (contig !== undefined) {
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

  // Every sequence, tile by tile. Bounded per contig and unbounded in the count
  // of them, which on a metagenome is the expensive shape — so it is priced as a
  // scan and gated like one, with the count named.
  const long = context.contigs.filter((entry) => entry.bins > widest * 2)
  const tiles = long.reduce((sum, entry) => sum + diagonalTiles(entry.bins, widest), 0)
  return {
    class: 'scan',
    requests: tiles * each,
    bytes: null,
    note:
      `${long.length.toLocaleString()} sequences are long enough for this window, read as ` +
      `${tiles.toLocaleString()} ${tiles === 1 ? 'square' : 'squares'} along their diagonals.`,
  }
}

export const INSULATION_TASK: AnalysisTask = {
  id: 'insulation',
  title: 'Diamond insulation',
  blurb: 'How much contact crosses each bin, and where the boundaries are.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile', 'intervals'],
  estimate,
}

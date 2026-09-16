/**
 * The HiC score, as a descriptor.
 *
 * After the directionality index, and the three of them read outward from the
 * same place: the diamond asks what crosses a bin, the index asks which way it
 * leans, and this asks how much there is around it at all. The first two are
 * *ratios* and are deliberately blind to depth — that is what makes them
 * comparable between chromosomes — and this one is a **mean cell value** and is
 * not, which is the whole reason it is a separate reading rather than a third
 * smoothing of the same one. A region that has lost its local structure has a
 * smaller mean and an unremarkable insulation score, because the ratio it is
 * measured against fell with it.
 *
 * ## The window is in bins, and it is a count of diagonals
 *
 * Like the diamond's and the directionality index's, and for their reason: the
 * three are read side by side against the same map, and a form that asks for two
 * of them in bins and the third in base pairs makes comparing them arithmetic.
 * The near-diagonal is a fact about the grid rather than about the genome, and
 * the same typed number of base pairs meant three bins at one resolution and one
 * at the next.
 *
 * It is the **side of the square** rather than its reach each way, which on a
 * window centred on the diagonal is the same as **how many diagonals the
 * triangle spans, counting the main one**: a window `2x + 1` bins across holds
 * separations `0 … 2x`, and both counts are `2x + 1`. So the one number a reader
 * types is the one the method is described with.
 *
 * {@link DEFAULT_HIC_SCORE_WINDOW_BINS} is **3** — the main diagonal and the two
 * above it, six cells — which is the reading the score comes from on bacterial
 * maps, where it is run on 2 kb matrices and the feature being looked for is a
 * few kb of chromosome that has stopped folding against itself. Wider windows
 * are a different and blunter question, and a map with much larger domains wants
 * one; that is exactly the kind of thing a form control is for. The runner says
 * what the window came to in base pairs on the file actually open, because 3
 * bins is 6 kb on the 2 kb map this default was chosen against and 150 kb on a
 * 50 kb one.
 */

import { contigNamed, framingCovers } from '../context'
import { bandTiles } from '../tiles'
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
 * The main diagonal and the two above it, which is the bacterial reading.
 *
 * Three diagonals on the 2 kb matrices this score is computed on there — a 6 kb
 * square, six cells averaged — and a default has to be a number of bins rather
 * than a distance now that the form asks in bins.
 */
export const DEFAULT_HIC_SCORE_WINDOW_BINS = 3

/** The window in bins — the whole side of the square, at least one. */
export function windowBinsOf(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : DEFAULT_HIC_SCORE_WINDOW_BINS
  return Math.max(1, Math.round(value))
}

/**
 * How far the square reaches each way, in bins.
 *
 * A square centred on a bin has an odd number of bins on a side, so an even
 * window is the **largest odd square that fits inside it** rather than the next
 * one up: asking for 4 bins and being given 5 is a window wider than the one on
 * the label. The floor of one is the other half of that — a square one cell on a
 * side is the main diagonal and not a reading of anything around it — and the
 * runner says so when either bites.
 */
export function halfWidthAt(params: Params): number {
  return Math.max(1, Math.floor((windowBinsOf(params) - 1) / 2))
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
    label: 'Window',
    hint:
      'The side of the square centred on each bin, which is also how many diagonals it spans, ' +
      'counting the main one. 3 is the main diagonal and the two above it — six cells — the ' +
      'reading bacterial maps are scored with at 2 kb.',
    default: DEFAULT_HIC_SCORE_WINDOW_BINS,
    min: 1,
    integer: true,
    unit: 'bins',
  },
  {
    kind: 'region',
    key: 'region',
    label: 'Sequence',
    sequences: true,
    hint: 'Leave empty for every sequence in the file.',
  },
  {
    kind: 'number',
    key: 'ignoreDiags',
    label: 'Diagonals to ignore',
    hint: '0 counts every cell, including the bin’s contact with itself.',
    default: 0,
    min: 0,
    integer: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'Minimum coverage of the window',
    hint: 'Below this fraction of usable cells the bin gets no score at all.',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    section: 'Quality',
  },
  BALANCE_PARAM,
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const balance = params.balance === true
  const half = halfWidthAt(params)
  // The two ends of the window contact each other `2h` apart, so that is how
  // deep the band has to be read. Pricing it at `h` would quote half the reads
  // the runner makes.
  const depth = half * 2
  const contig = regionContig(context, regionOf(params))

  if (contig !== undefined && contig.bins <= depth) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `${contig.name} is ${contig.bins.toLocaleString()} bins and the window is ` +
        `${(depth + 1).toLocaleString()} across, so no bin on it has a whole square around it. ` +
        'Use a narrower window, or a longer sequence.',
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

  const perTile = balance ? 5 : 4
  if (contig !== undefined) {
    const tiles = bandTiles(contig.bins, depth)
    const requests = tiles * perTile
    return {
      class: 'bounded',
      requests,
      bytes: null,
      note:
        `About ${requests.toLocaleString()} range requests: ${contig.name} is read as a band ` +
        `${depth.toLocaleString()} bins deep, in ${tiles.toLocaleString()} ` +
        `${tiles === 1 ? 'strip' : 'strips'}, never as the whole square.`,
    }
  }

  const long = context.contigs.filter((entry) => entry.bins > depth)
  const tiles = long.reduce((sum, entry) => sum + bandTiles(entry.bins, depth), 0)
  return {
    class: 'scan',
    requests: tiles * perTile,
    bytes: null,
    note:
      `${long.length.toLocaleString()} sequences are long enough for this window, read as ` +
      `${tiles.toLocaleString()} ${tiles === 1 ? 'strip' : 'strips'} along their diagonals. ` +
      'Progress is reported per sequence and it can be cancelled at any point.',
  }
}

export const HIC_SCORE_TASK: AnalysisTask = {
  id: 'hicscore',
  title: 'HiC score',
  blurb: 'The mean contact in a window around each bin.',
  group: 'map',
  venue: 'analysis',
  // Bumped with the definition: it is the mean of the window's upper triangle
  // now and was the sum of the whole square, and the window is a bin count where
  // it used to be base pairs. A result carried in from a shared session naming
  // version 1 is a different quantity under the same title.
  version: 2,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

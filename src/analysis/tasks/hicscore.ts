/**
 * The HiC score, as a descriptor.
 *
 * After the directionality index, and the three of them read outward from the
 * same place: the diamond asks what crosses a bin, the index asks which way it
 * leans, and this asks how much there is around it at all. The first two are
 * *ratios* and are deliberately blind to depth — that is what makes them
 * comparable between chromosomes — and this one is a **sum** and is not, which
 * is the whole reason it is a separate reading rather than a third smoothing of
 * the same one. A region that has lost its local structure has a smaller sum and
 * an unremarkable insulation score, because the ratio it is measured against fell
 * with it.
 *
 * ## The window
 *
 * In base pairs, and it is the **side of the square** rather than its reach each
 * way. A reader asking for a 200 kb HiC score means a 200 kb window, which is
 * the interval the score is a statement about; halving it into a radius is
 * arithmetic the form should do and not the reader. The runner says in a note
 * what that came to in bins, for the same reason the directionality index does.
 *
 * The default is **50 kb**, which is the scale the score is a useful reading at
 * on the bacterial and phage maps it comes from — small enough that the window is
 * one structural feature rather than a whole domain, large enough that it holds
 * more than the self-ligation spike. A mammalian map wants it wider, and that is
 * exactly the kind of thing a form control is for.
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

/** The window the score is read at unless somebody says otherwise. */
export const DEFAULT_HIC_SCORE_WINDOW_BP = 50_000

/** The window in base pairs — the whole side of the square. */
export function windowBpOf(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : DEFAULT_HIC_SCORE_WINDOW_BP
  return Math.max(1, Math.round(value))
}

/**
 * How far the square reaches each way, in bins.
 *
 * Half the window, and **at least one bin**: a window narrower than two bins is
 * a square one cell on a side, which is the main diagonal and not a reading of
 * anything around it. The floor is what turns that into a small answer rather
 * than an empty one, and the runner says so when it bites.
 */
export function halfWidthAt(params: Params, binsize: number): number {
  return Math.max(1, Math.round(windowBpOf(params) / Math.max(1, binsize) / 2))
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
    hint: 'The side of the square, centred on each bin. Everything inside it is added up.',
    default: DEFAULT_HIC_SCORE_WINDOW_BP,
    min: 1,
    integer: true,
    unit: 'bp',
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
  const half = halfWidthAt(params, context.binsize)
  // The corners of the square are `2h` apart, so that is how deep the band has
  // to be read. Pricing it at `h` would quote half the reads the runner makes.
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
  blurb: 'How much contact there is in a window around each bin.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

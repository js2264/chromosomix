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
import type {
  AnalysisContext,
  AnalysisTask,
  ContextContig,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'

/** The base window in base pairs, at least one bin of this file. */
export function windowBpOf(params: Params, binsize: number): number {
  const value = typeof params.window === 'number' ? params.window : 10 * binsize
  return Math.max(binsize, value)
}

/** How many doublings of the base window to compute. */
export function scalesOf(params: Params): number {
  const value = typeof params.scales === 'number' ? params.scales : 1
  return Math.max(1, Math.min(4, Math.trunc(value)))
}

/** The ladder, in bins, one entry per scale. */
export function windowLadder(params: Params, binsize: number): number[] {
  const base = Math.max(1, Math.round(windowBpOf(params, binsize) / binsize))
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
    label: 'Window',
    hint: 'The diamond is this wide on each side of the bin it scores.',
    default: 10_000,
    min: 1,
    unit: 'bp',
  },
  {
    kind: 'number',
    key: 'scales',
    label: 'Scales',
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
    label: 'Sequence',
    sequences: true,
    hint: 'Leave empty for every sequence in the file.',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'Minimum coverage of the diamond',
    hint: 'Below this fraction of usable cells the bin gets no score at all.',
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
    hint: 'Only meaningful on a file that has been balanced.',
    default: false,
    section: 'Quality',
  },
  {
    kind: 'toggle',
    key: 'call',
    label: 'Call boundaries from the minima',
    hint: 'Adds a BED of boundary calls, drawn on the map.',
    default: true,
    section: 'Boundaries',
  },
  {
    kind: 'number',
    key: 'prominence',
    label: 'Minimum prominence',
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
    label: 'Minimum spacing',
    hint: 'Two calls closer than this keep only the stronger.',
    default: 0,
    min: 0,
    unit: 'bp',
    when: (params) => params.call === true,
    section: 'Boundaries',
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const balance = params.balance === true
  const windows = windowLadder(params, context.binsize)
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

  if (contig !== undefined) {
    const requests = balance ? 5 : 4
    return {
      class: 'bounded',
      requests,
      bytes: null,
      note: `About ${requests} range requests: one dense square over ${contig.name}.`,
    }
  }

  // Every sequence, one square at a time. Bounded per contig and unbounded in
  // the count of them, which on a metagenome is the expensive shape — so it is
  // priced as a scan and gated like one, with the count named.
  const n = context.contigs.filter((entry) => entry.bins > widest * 2).length
  return {
    class: 'scan',
    requests: n * (balance ? 5 : 4),
    bytes: null,
    note:
      `${n.toLocaleString()} sequences are long enough for this window, read one dense square ` +
      'at a time. Progress is reported per sequence and it can be cancelled at any point.',
  }
}

export const INSULATION_TASK: AnalysisTask = {
  id: 'insulation',
  title: 'Diamond insulation',
  blurb: 'How much contact crosses each bin, and where the boundaries are.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  appliesTo: (context) => context.nBins > 0,
  params: PARAMS,
  outputs: ['profile', 'intervals'],
  estimate,
}

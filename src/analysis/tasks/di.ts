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
 * ## The window, and why it is in base pairs
 *
 * The diamond's window is a count of bins and says so at length: the diamond is
 * cells on each side of the bin being scored, so bins are what it was always
 * measured in. The directionality index is the opposite case. Its window is a
 * **genomic distance** — Dixon's 2 Mb, and the number every published DI track is
 * computed at — and it means the same 2 Mb at 10 kb and at 40 kb. Asking for it
 * in bins would make the one number a reader knows depend on which rung of an
 * `.mcool` they happen to have open, and a stored session moved between two
 * resolutions would silently compute two different statistics.
 *
 * So: base pairs, defaulting to **2 Mb**, which is Dixon et al. 2012's own
 * window and the one a mammalian map should be read at. The runner divides by
 * the bin size once and says in a note how many bins that came to, because a
 * window that rounds to three bins is a window worth knowing about.
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

/** Dixon et al. 2012's window, and the default a mammalian map wants. */
export const DEFAULT_DI_WINDOW_BP = 2_000_000

/** The window in base pairs, as the form holds it. */
export function windowBpOf(params: Params): number {
  const value = typeof params.window === 'number' ? params.window : DEFAULT_DI_WINDOW_BP
  return Math.max(1, Math.round(value))
}

/** The window in bins of a file with this bin size, at least one. */
export function windowBinsAt(params: Params, binsize: number): number {
  return Math.max(1, Math.round(windowBpOf(params) / Math.max(1, binsize)))
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
      'Contacts are summed this far upstream and this far downstream of every bin. ' +
      '2 Mb is Dixon et al.’s, and what a mammalian map is normally read at.',
    default: DEFAULT_DI_WINDOW_BP,
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
    label: 'Minimum coverage of each side',
    hint: 'Below this fraction of usable cells — on either side — the bin gets no score.',
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
  const window = windowBinsAt(params, context.binsize)
  const contig = regionContig(context, regionOf(params))

  if (contig !== undefined && contig.bins <= window) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `${contig.name} is ${contig.bins.toLocaleString()} bins and the window is ` +
        `${window.toLocaleString()}, so no bin on it has a whole window either side. Use a ` +
        'narrower window, or a longer sequence.',
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

  // **A band, not a square**, which is what makes a 2 Mb window on a mammalian
  // chromosome a sane thing to ask for at all: the index reaches `window` bins
  // each way and no further, so what is read is `(window + 1) × n` cells rather
  // than `n²`. `bandFor` tiles it; the count below is that walk's, and it is the
  // same arithmetic `analysis/run/blocks.ts` does.
  const perTile = balance ? 5 : 4
  if (contig !== undefined) {
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

  const long = context.contigs.filter((entry) => entry.bins > window)
  const tiles = long.reduce((sum, entry) => sum + bandTiles(entry.bins, window), 0)
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

export const DI_TASK: AnalysisTask = {
  id: 'di',
  title: 'Directionality index',
  blurb: 'Which way each bin looks, and where the sign flips.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

/**
 * The virtual 4C profile, as a *task* — which is a different object from the
 * lane of the same name, and the panel is what makes that obvious (§18.4).
 *
 * The lane on the map is a reading of the block on screen. Its own docstring is
 * careful about it: pan, and it is recomputed over the new block, because it is
 * a summary of the pixels above it rather than a genome-wide track. That is the
 * right thing for a lane and the wrong thing for a file — a bigWig that only
 * covers whatever happened to be framed when it was written is a bigWig nobody
 * can use.
 *
 * So this reads for itself, over a scope the reader chooses, and produces a
 * track. And it is **cis by default**, because that choice is a factor of
 * several thousand in what it costs:
 *
 * - **cis** is the anchor's own sequence, which is one bounded dense read — the
 *   same four slices any square costs, and free when the map is already showing
 *   it;
 * - **with trans** is not a bounded read at all and the read planner says so. Set
 *   rows to the anchor band and columns to everything and `planRead` resolves to
 *   `symmetric` over the whole pixel table, because an upper-triangular store
 *   keeps every column *before* the anchor in other rows (§5.3, §6.2). Done
 *   properly it is one streaming pass that can stop at `bin1 >= anchor end` —
 *   on average half the file — accumulating into a band and materialising
 *   nothing large.
 *
 * One task with a toggle rather than two tasks, because they answer the same
 * question and the toggle is the honest way to show what the second one costs.
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
import { NEEDS_MAP, READY, waitingFor } from '../types'

/** The anchor as typed, trimmed. */
export function anchorOf(params: Params): string {
  return typeof params.anchor === 'string' ? params.anchor.trim() : ''
}

export function cisOnly(params: Params): boolean {
  return params.cis !== false
}

/** The contig an anchor names, or `undefined` while it is still being typed. */
function anchorContig(context: AnalysisContext, params: Params): ContextContig | undefined {
  const name = anchorOf(params).split(':')[0].trim()
  return name === '' ? undefined : contigNamed(context, name)
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'toggle',
    key: 'fromMap',
    label: 'Pick on map',
    default: true,
    hint: 'Shift-drag along either axis of the map to name the anchor. Turn off to type one.',
  },
  {
    kind: 'region',
    key: 'anchor',
    label: 'Anchor',
    fromMap: 'fromMap',
    hint: 'The locus the profile is a reading from. A whole sequence is allowed.',
  },
  {
    kind: 'toggle',
    key: 'cis',
    label: 'Cis only',
    hint:
      'On, this reads one sequence and costs a handful of requests. Off, it walks the pixel ' +
      'table to reach the contacts leaving that sequence.',
    default: true,
  },
  {
    kind: 'toggle',
    key: 'balance',
    label: 'Use balancing weights',
    default: false,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const contig = anchorContig(context, params)
  if (anchorOf(params) === '') {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        params.fromMap === false
          ? 'Name a locus to anchor the profile on.'
          : 'Shift-drag along either axis of the map to pick an anchor.',
    }
  }
  if (contig === undefined) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: `This file has no sequence called ${anchorOf(params).split(':')[0].trim()}.`,
    }
  }

  const balance = params.balance === true
  if (!cisOnly(params)) {
    return {
      class: 'scan',
      requests: null,
      bytes: null,
      note:
        'Walks the pixel table as far as the anchor, which is about half the file, to reach the ' +
        'contacts that leave this sequence. Progress is reported as it goes and it can be ' +
        'cancelled at any point.',
    }
  }

  const extent: [number, number] = [contig.startBin, contig.startBin + contig.bins]
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
  const requests = balance ? 5 : 4
  return {
    class: 'bounded',
    requests,
    bytes: null,
    note:
      `About ${requests} range requests: one dense square over ${contig.name} ` +
      `(${contig.bins.toLocaleString()} bins).`,
  }
}

export const FOURC_TASK: AnalysisTask = {
  id: 'fourc',
  title: '4C profile from an anchor',
  blurb: 'What one locus touches, as a track you can export.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

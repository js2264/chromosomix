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
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/** The anchor as typed, trimmed. */
export function anchorOf(params: Params): string {
  return typeof params.anchor === 'string' ? params.anchor.trim() : ''
}

export function cisOnly(params: Params): boolean {
  return params.cis !== false
}

/**
 * What an anchor names, as bins, whether it is a sequence or a **genome**.
 *
 * The runner has always taken both — `resolveAnchor` reads a genome's extent
 * and makes *cis* mean the whole MAG, deliberately, because on a metagenome the
 * question "what does this organism touch" is the one being asked and answering
 * for whichever contig the first bin fell in would answer a different one. This
 * side did not: the estimate resolved the name against `/contigs` alone, so
 * naming a MAG — which is what a click on a genome × genome map means, and what
 * the map's own axis is labelled with — was refused before it could run.
 *
 * A genome is checked *after* a sequence, so a file where one name is both
 * behaves as it always did.
 */
function anchorSpan(
  context: AnalysisContext,
  params: Params,
): { label: string; bins: number; extent: [number, number]; kind: 'contig' | 'genome' } | null {
  const name = anchorOf(params).split(':')[0].trim()
  if (name === '') return null
  const contig = contigNamed(context, name)
  if (contig !== undefined) {
    return {
      label: contig.name,
      bins: contig.bins,
      extent: [contig.startBin, contig.startBin + contig.bins],
      kind: 'contig',
    }
  }
  const genome = context.genomes?.find((it) => it.name === name)
  if (genome === undefined) return null
  return {
    label: genome.name,
    bins: genome.extent[1] - genome.extent[0],
    extent: [genome.extent[0], genome.extent[1]],
    kind: 'genome',
  }
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'region',
    key: 'anchor',
    label: 'Anchor',
    pickable: true,
    hint:
      'The locus the profile is a reading from. A whole sequence is allowed, and on a metagenome ' +
      'a whole genome — then cis means the MAG rather than one of its contigs. Type it, or press ' +
      '“Pick on map” and drag along either axis.',
  },
  {
    kind: 'choice',
    key: 'normalise',
    label: 'Normalisation',
    default: 'none',
    /**
     * A 4C profile is a slice of the map, and a slice of a Hi-C map is mostly
     * P(s): contact falls by orders of magnitude with distance, so the profile's
     * shape is dominated by *how far away* each bin is rather than by whether
     * anything is happening there. On a log axis that is a clean triangle with
     * the anchor at its apex, and the loops a reader ran the task to find are
     * bumps on its flanks — visible near the anchor, invisible a megabase out.
     *
     * Dividing by the decay is the standard way to see past it, and the curve is
     * taken from **the anchor's own sequence**, accumulated from the square this
     * task is already reading. Not the P(s) task's genome-wide curve: a small
     * chromosome divided by the average behaviour of the large ones comes out
     * with a slope that is a property of the *set* rather than of this locus.
     *
     * `none` stays the default because the raw profile is what a bigWig of a 4C
     * experiment holds and what a reader comparing against one expects — and
     * because a ratio is a derived quantity that should be asked for.
     */
    options: [
      {
        value: 'none',
        label: 'None',
        hint: 'Contacts as they were counted.',
      },
      {
        value: 'ps',
        label: 'By P(s)',
        hint: 'Observed over expected at that separation, from this sequence’s own decay.',
      },
    ],
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
  BALANCE_PARAM,
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const anchor = anchorSpan(context, params)
  if (anchorOf(params) === '') {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Name a locus to anchor the profile on — type one, or pick it on the map.',
    }
  }
  if (anchor === null) {
    const named = anchorOf(params).split(':')[0].trim()
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        context.genomes === null
          ? `This file has no sequence called ${named}.`
          : `This file has no sequence or genome called ${named}.`,
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

  const extent = anchor.extent
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
      `About ${requests} range requests: one dense square over ` +
      `${anchor.kind === 'genome' ? 'the whole of ' : ''}${anchor.label} ` +
      `(${anchor.bins.toLocaleString()} bins).`,
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

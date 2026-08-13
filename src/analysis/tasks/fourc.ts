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

/**
 * The anchor, and whether to balance. **Two controls that were here are not.**
 *
 * *Cis only* and *Normalisation* were both switches over what the task is for,
 * and neither earned its place in the form. The profile a reader comes here to
 * get is the one along the anchor's own sequence — that is what a 4C experiment
 * produces and what a bigWig of one holds — and the two extra rows made the
 * commonest run a three-decision form. What they did instead of helping was
 * price it: *with trans* turns a handful of range requests into a walk over
 * half the file, offered as an ordinary toggle beside the anchor.
 *
 * The arithmetic behind both is kept and still goldened (`run/fourc.ts`,
 * `test/unit/analysis-fourc.test.ts`): the runner reads `cis` and `normalise`
 * with the defaults this form used to supply, so removing the controls changed
 * what is *offered* and nothing about what is computed.
 */
const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'region',
    key: 'anchor',
    label: 'Anchor',
    pickable: true,
    hint:
      'The locus the profile is a reading from. A whole sequence is allowed, and on a metagenome ' +
      'a whole genome — then the profile is over the whole MAG rather than one of its contigs. ' +
      'Type it, or press “Pick on map” and drag along either axis.',
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
  // Priced, and no longer reachable from the form: **cis only** and
  // **normalisation** are gone from {@link PARAMS} (see its note). The branch
  // stays because the *runner* still reads both keys and the arithmetic behind
  // them is goldened, so a params object that carries one — a stored session
  // written by an older build, a test — is priced as it always was rather than
  // being run under a cost this function did not quote.
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

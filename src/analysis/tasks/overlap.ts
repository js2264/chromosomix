/**
 * Interval set overlap, as a descriptor.
 *
 * Small, and worth having for one reason: it is the question that follows every
 * run of §18.8's other tasks. *How many of my loops sit on a boundary* is what a
 * reader asks the moment CID hands them a call set, and without this they leave
 * the app to answer it.
 *
 * It reads no matrix and needs no mount, so it runs in the annotations venue
 * beside the sets themselves.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'

const PARAMS: readonly ParamSpec[] = [
  { kind: 'featureSet', key: 'a', label: 'First set' },
  { kind: 'featureSet', key: 'b', label: 'Second set' },
  {
    kind: 'number',
    key: 'minFraction',
    label: 'Least of a feature covered',
    hint: 'A feature counts as hit when this fraction of it is inside the other set.',
    default: 0.000001,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
  },
]

function estimate(_context: AnalysisContext, params: Params): CostEstimate {
  const chosen = typeof params.a === 'string' && params.a !== '' && typeof params.b === 'string' && params.b !== ''
  return chosen
    ? { class: 'free', requests: 0, bytes: 0, note: 'Both sets are already loaded. No reads.' }
    : {
        class: 'free',
        requests: 0,
        bytes: 0,
        note: 'Nothing to read.',
        refusal: 'Choose two feature sets to compare.',
      }
}

export const OVERLAP_TASK: AnalysisTask = {
  id: 'overlap',
  title: 'Interval set overlap',
  blurb: 'Jaccard, shared bases, and how many features of each touch the other.',
  group: 'tracks',
  venue: 'annotations',
  version: 1,
  // No map required: two interval sets compared against each other say nothing
  // about a matrix, and the 1D browser is where a reader most often has them.
  availability: (context) => {
    const sets = context.entries.filter(
      (entry) => entry.kind === 'gtf' || entry.kind === 'segments',
    ).length
    if (sets >= 2) return READY
    return waitingFor(
      sets === 0
        ? 'Load two interval sets — BED, narrowPeak or GTF — to compare.'
        : 'Load a second interval set; an overlap needs two.',
    )
  },
  params: PARAMS,
  outputs: ['table'],
  estimate,
}

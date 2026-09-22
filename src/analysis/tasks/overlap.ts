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
import { isIntervalSet } from '../../annotations/types'

const PARAMS: readonly ParamSpec[] = [
  { kind: 'featureSet', key: 'a', label: 'first set' },
  { kind: 'featureSet', key: 'b', label: 'second set' },
  {
    kind: 'number',
    key: 'minFraction',
    label: 'least of a feature covered',
    hint: 'A feature counts as hit when this fraction of it is inside the other set.',
    default: 0.000001,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
  },
  {
    kind: 'toggle',
    key: 'shuffle',
    label: 'shuffled null',
    hint:
      'Relocates one set at random within the sequences it already occupies, keeping its count ' +
      'and its lengths, and reports the observed overlap against that null.',
    default: false,
  },
  {
    kind: 'choice',
    key: 'shuffleWhich',
    label: 'set that moves',
    when: (params) => params.shuffle === true,
    default: 'a',
    options: [
      { value: 'a', label: 'the first', hint: '“Are the first set’s features on the second’s?”' },
      { value: 'b', label: 'the second' },
    ],
  },
  {
    kind: 'number',
    key: 'iterations',
    label: 'shuffles',
    when: (params) => params.shuffle === true,
    hint: 'The smallest p a run can report is one over this, plus one.',
    default: 1000,
    min: 20,
    max: 100000,
    integer: true,
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'seed',
    when: (params) => params.shuffle === true,
    hint: 'The same seed gives the same null twice.',
    default: 1,
  },
]

function estimate(_context: AnalysisContext, params: Params): CostEstimate {
  const chosen = typeof params.a === 'string' && params.a !== '' && typeof params.b === 'string' && params.b !== ''
  const iterations = typeof params.iterations === 'number' ? params.iterations : 1000
  // Still `free`, and the class is about **reads** rather than about wall clock
  // (§18.6): a shuffle test opens nothing and fetches nothing. What it does cost
  // is a thousand passes over sets already in memory, so the note says so —
  // a reader who types a hundred thousand shuffles should know that before
  // pressing Run rather than by watching the bar.
  return chosen
    ? {
        class: 'free',
        requests: 0,
        bytes: 0,
        note:
          params.shuffle === true
            ? `Both sets are already loaded. No reads — ${iterations.toLocaleString()} shuffles ` +
              'of one of them, with a progress bar and a cancel.'
            : 'Both sets are already loaded. No reads.',
      }
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
  blurb: 'Jaccard, shared bases, how many features touch — and whether that is more than chance.',
  group: '1d',
  venue: 'annotations',
  version: 2,
  // No map required: two interval sets compared against each other say nothing
  // about a matrix, and the 1D browser is where a reader most often has them.
  availability: (context) => {
    const sets = context.entries.filter(
      (entry) => isIntervalSet(entry.kind),
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

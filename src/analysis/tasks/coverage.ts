/**
 * Coverage and marginals, as a descriptor.
 *
 * The cheapest useful thing in the catalogue and the one most worth having under
 * the map (§18.8): a marginal is what tells a reader that the pale stretch they
 * are looking at is a depth artefact rather than a compartment, and the cis
 * fraction is the per-sequence version of the question a metagenome is being
 * read to answer.
 *
 * Its cost model is the odd one, and the reason is arithmetic rather than
 * design. A marginal sums *every* pixel touching a bin, so unlike insulation or
 * P(s) it cannot be answered from one contig's square however conveniently that
 * square happens to be on screen — a contig's own block knows nothing about the
 * contacts leaving it, and a cis fraction computed from it would be exactly
 * `1` everywhere. So this task is free only from a block that is the *whole
 * file*, and a scan otherwise. Saying that plainly in the estimate is what stops
 * a reader from expecting the free path they get everywhere else.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'

/** Which of the four vectors the run should produce. */
export function wantedTracks(params: Params): Array<'total' | 'cis' | 'trans' | 'fraction'> {
  const out: Array<'total' | 'cis' | 'trans' | 'fraction'> = []
  if (params.total !== false) out.push('total')
  if (params.cis === true) out.push('cis')
  if (params.trans === true) out.push('trans')
  if (params.fraction !== false) out.push('fraction')
  return out
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'toggle',
    key: 'total',
    label: 'Total coverage',
    hint: 'Every contact touching the bin. Flat on a correctly balanced file.',
    default: true,
  },
  {
    kind: 'toggle',
    key: 'fraction',
    label: 'Cis fraction',
    hint: 'Of the contacts a bin has, how many stay on its own sequence.',
    default: true,
  },
  {
    kind: 'toggle',
    key: 'cis',
    label: 'Cis coverage',
    default: false,
  },
  {
    kind: 'toggle',
    key: 'trans',
    label: 'Trans coverage',
    default: false,
  },
  {
    kind: 'toggle',
    key: 'balance',
    label: 'Use balancing weights',
    hint:
      'Worth turning on to check the balancing itself: a balanced file should have a flat ' +
      'total, so one that is not is a file whose weights do not fit it.',
    default: false,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  if (wantedTracks(params).length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Choose at least one of the four tracks.',
    }
  }

  const framing = context.framing
  const whole =
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === (params.balance === true) &&
    framing.rows[0] === 0 &&
    framing.rows[1] === context.nBins &&
    framing.cols[0] === 0 &&
    framing.cols[1] === context.nBins
  if (context.blockLoaded && whole) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Computed from the whole-file block already on screen. No reads.',
    }
  }

  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      'Walks the whole pixel table once. A marginal counts every contact touching a bin, so ' +
      'unlike the other tracks on this panel it cannot be taken from one sequence’s square. ' +
      'Progress is reported as it goes and it can be cancelled at any point.',
  }
}

export const COVERAGE_TASK: AnalysisTask = {
  id: 'coverage',
  title: 'Coverage and marginals',
  blurb: 'How much contact each bin carries, and how much of it stays at home.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  appliesTo: (context) => context.nBins > 0,
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

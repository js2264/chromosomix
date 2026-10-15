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
import { NEEDS_MAP, READY, waitingFor } from '../types'

/** Which of the four vectors the run should produce. */
export function wantedTracks(params: Params): Array<'total' | 'cis' | 'trans' | 'fraction'> {
  const out: Array<'total' | 'cis' | 'trans' | 'fraction'> = []
  if (params.total !== false) out.push('total')
  if (params.cis === true) out.push('cis')
  if (params.trans === true) out.push('trans')
  // `=== true`, like the other two, now that the cis fraction is off by default:
  // reading it as "anything but false" would turn it back on for a stored
  // session that predates the change, which is the opposite of what the default
  // is for.
  if (params.fraction === true) out.push('fraction')
  return out
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'toggle',
    key: 'total',
    label: 'total coverage',
    hint: 'Every contact touching the bin, and flat on a correctly balanced file.',
    default: true,
  },
  {
    kind: 'toggle',
    key: 'fraction',
    label: 'cis fraction',
    hint: 'Of the contacts a bin has, how many stay on its own sequence.',
    // Off, like the other two. **Total coverage** is what this task is opened
    // for — it is the marginal that says whether a pale stretch is a depth
    // artefact — and every extra track ticked here is another lane arriving
    // beside the map unasked. A reader who wants the cis fraction knows they
    // want it; a reader who wants the marginal was getting two.
    default: false,
  },
  {
    kind: 'toggle',
    key: 'cis',
    label: 'cis coverage',
    default: false,
  },
  {
    kind: 'toggle',
    key: 'trans',
    label: 'trans coverage',
    default: false,
  },
  {
    kind: 'toggle',
    key: 'balance',
    label: 'use balancing weights',
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
      'One pass over the whole pixel table: a marginal counts every contact touching a bin, so ' +
      'it cannot be taken from one sequence’s square.',
  }
}

export const COVERAGE_TASK: AnalysisTask = {
  id: 'coverage',
  title: 'Coverage and marginals',
  blurb: 'How much contact each bin carries, and how much of it stays at home.',
  keywords: ['depth', 'marginal', 'balancing', 'weights'],
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

/**
 * Reproducibility between the maps on screen, as a descriptor.
 *
 * The one task in the catalogue whose unit is a **pair of files**, and the
 * reason it is here is that the deck made every other way of asking the question
 * available and this one impossible. N maps open under one navigation, two
 * blended in one square, N curves on one axis: each of those answers *do these
 * look alike* with a picture, and the question people actually have — *are these
 * replicates* — has a number as its answer and no picture at all.
 *
 * ## This is not §18.9's refusal, and the distinction is precise
 *
 * §18.9 declines a *differential* APA and a *differential* insulation, and its
 * argument is exact: subtracting one track from another is a worse version of a
 * picture the reader can already make. A correlation is not a subtraction, is
 * not derived from two figures, and is not a picture at all — it is the one
 * reading of two maps that this application cannot otherwise produce.
 * `analysis/combine.ts` made the same argument for the overlay and it applies
 * here with more force.
 *
 * ## Where the other maps come from
 *
 * The deck, and nothing else: the maps already on screen, in the order they are
 * on it, under the names the reader gave them. There is no second file picker,
 * because a reproducibility coefficient against a file that is not on screen is
 * a number with nothing to look at beside it — and because the deck already
 * settles what a "second map" is, keeps it navigated to the same place, and
 * names it.
 *
 * ## The one thing the deck does not settle
 *
 * **The bin grid.** §16's navigation lock is in base pairs precisely so that a
 * 1 kb file and a 5 kb file can follow each other honestly, so a deck can
 * legitimately hold maps this task cannot compare: a stratum is a diagonal
 * offset in bins, and the k-th diagonal of two different grids is two different
 * separations. Refused by name, in the estimate, the way §5.7's triangle refuses
 * a mismatched pair — rather than silently comparing the wrong strata and
 * reporting a low coefficient that reads as a biological result.
 */

import { tickedContigs } from '../context'
import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * The largest number of strata worth correlating, and the default.
 *
 * **Part of the answer, not only of the cost.** HiCRep weighs a stratum by how
 * many positions it compares, so a far one counts about as much as a near one —
 * how far the comparison runs is the reference's own `dBPMax`, and moving it
 * moves the coefficient. It is the default as well as the cap because the 5 Mb
 * it replaces reached the cap on every file at 10 kb or finer, which is most of
 * them: a reader who typed the old default got 500 strata, and now sees that
 * that is what they are asking for.
 */
export const MAX_STRATA = 500

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
    hint: 'Each is scored on its own as well as pooled.',
  },
  {
    kind: 'number',
    key: 'maxDistance',
    label: 'furthest separation compared',
    // **Strata, which are bins**, where this was a length in base pairs divided
    // by the bin size on the way in. A stratum *is* a diagonal offset — it is
    // the reason two maps on different grids cannot be compared at all, which
    // the estimate refuses by name — so the number that decides how many of them
    // are correlated was never a distance. {@link MAX_STRATA} is both the cap
    // and the default, because 5 Mb hit that cap on every file finer than 10 kb.
    unit: 'bins',
    hint:
      'Every stratum out to here counts, weighted by the positions it compares — so this moves ' +
      'the answer, as hicrep’s dBPMax does: 5 Mb is 50 strata at 100 kb.',
    default: MAX_STRATA,
    min: 1,
    max: MAX_STRATA,
    integer: true,
  },
  {
    kind: 'number',
    key: 'smooth',
    label: 'smoothing half-width',
    unit: 'bins',
    hint:
      'The 2D mean filter HiCRep applies before correlating; 0 measures depth as much as ' +
      'structure on any sparse pair of maps.',
    default: 1,
    min: 0,
    max: 20,
    integer: true,
    slider: true,
  },
  BALANCE_PARAM,
]

/**
 * How many strata a run correlates: the reader's number, capped.
 *
 * One expression, read by the estimate and by the runner, because the two
 * disagreeing is a run that costs what the button did not say. No bin size in
 * it any more — the parameter is a count of strata (§18.2), so the arithmetic
 * that turned 5 Mb into a stratum count is gone rather than moved.
 */
export function strataOf(params: Params): number {
  const value = typeof params.maxDistance === 'number' ? params.maxDistance : MAX_STRATA
  return Math.max(1, Math.min(MAX_STRATA, Math.round(value)))
}

/** Whether two maps can be compared stratum for stratum. */
export function comparableGrid(a: number, b: number): boolean {
  return a > 0 && a === b
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const peers = (context.peers ?? []).length
  if (peers === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        'A reproducibility coefficient needs a second map. Press + along the edge of the map to ' +
        'open a cell beside it, and drop another file in.',
    }
  }
  const mismatched = (context.peers ?? []).filter(
    (peer) => !comparableGrid(context.binsize, peer.binsize),
  )
  if (mismatched.length === peers) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `A stratum is a diagonal offset in bins, so two maps can only be compared on one grid. ` +
        `This one is at ${context.binsize.toLocaleString()} bp and ` +
        `${peers === 1 ? 'the other is' : 'the others are'} not. Open them at the same ` +
        'resolution — an .mcool descends to any rung it carries.',
    }
  }
  // Nothing ticked is nothing to compare over, and refused in the sentence
  // every task that takes the list refuses it in (§18.2) rather than widened
  // into every sequence of every map on the deck.
  if (tickedContigs(context, params, 'sequences').length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Tick at least one sequence.',
    }
  }

  const maps = 1 + peers - mismatched.length
  const strata = strataOf(params)
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      `${maps.toLocaleString()} maps, each read along the diagonal of every chosen sequence out ` +
      `to ${strata.toLocaleString()} strata — a band, not a square, so the cost is the sequence ` +
      'rather than its square. The other maps are opened for the run and closed after it.',
  }
}

export const HICREP_TASK: AnalysisTask = {
  id: 'hicrep',
  title: 'Reproducibility',
  blurb: 'How much the maps on screen agree, stratum by stratum and pooled.',
  group: '2d',
  venue: 'analysis',
  // 2: the strata pooled by HiCRep's variance-stabilised weights, `(n + 1) / 12`,
  // over the positions either map has a contact at — where 1 weighted them by
  // the variance of the counts and let the diagonals nearest the main one carry
  // the answer.
  version: 2,
  needsPeers: true,
  // **Waiting rather than absent** with one map open, and the distinction is
  // §8.5's: a second map is one press of `+` away, so hiding the row would
  // teach a reader that this application does not measure reproducibility
  // rather than that they have not opened the second file yet.
  availability: (context) => {
    if (!context.hasMap) return waitingFor(NEEDS_MAP)
    return (context.peers ?? []).length > 0
      ? READY
      : waitingFor('Open a second map beside this one — press + along the edge of the map.')
  },
  params: PARAMS,
  outputs: ['table', 'matrix', 'curve'],
  estimate,
}

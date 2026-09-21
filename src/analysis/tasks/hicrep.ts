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

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * The largest separation worth stratifying to, as a share of the sequence.
 *
 * A stratum near the end of a chromosome has a handful of cells in it and a
 * correlation that is mostly noise — which the CMH weight already discounts to
 * almost nothing, so the cap is about *cost* rather than about correctness.
 */
export const MAX_STRATA = 500

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
    hint: 'Empty is every sequence the maps share. Each is scored on its own as well as pooled.',
  },
  {
    kind: 'number',
    key: 'maxDistance',
    label: 'furthest separation compared',
    unit: 'bp',
    hint:
      'Past this the strata hold a handful of cells each and contribute almost nothing — the ' +
      'weighting already knows that, so this is about what the run costs.',
    default: 5_000_000,
    min: 1,
    integer: true,
  },
  {
    kind: 'number',
    key: 'smooth',
    label: 'smoothing half-width',
    unit: 'bins',
    hint:
      'The 2D mean filter HiCRep applies before correlating. 0 is no smoothing, which measures ' +
      'depth as much as structure on any sparse pair of maps.',
    default: 1,
    min: 0,
    max: 20,
    integer: true,
    slider: true,
  },
  BALANCE_PARAM,
]

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

  const maps = 1 + peers - mismatched.length
  const strata = Math.min(
    MAX_STRATA,
    Math.max(1, Math.round(Number(params.maxDistance ?? 5_000_000) / Math.max(1, context.binsize))),
  )
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
  title: 'Reproducibility (HiCRep)',
  blurb: 'How much the maps on screen agree, stratum by stratum and pooled.',
  group: 'map',
  venue: 'analysis',
  version: 1,
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

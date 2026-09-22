/**
 * The HiC score, as a descriptor.
 *
 * After the directionality index, and the three of them read outward from the
 * same place: the diamond asks what crosses a bin, the index asks which way it
 * leans, and this asks how much contact the bin makes at all. The first two are
 * *ratios* and are deliberately blind to depth — that is what makes them
 * comparable between chromosomes — and this one is a **mean cell value** and is
 * not, which is the whole reason it is a separate reading rather than a third
 * smoothing of the same one. A region that has lost its local structure has a
 * smaller mean and an unremarkable insulation score, because the ratio it is
 * measured against fell with it.
 *
 * ## The parameter is a count of diagonals
 *
 * The score is the bin's own line across the near-diagonal, so the one number
 * that decides what it measures is **how many diagonals that line spans**,
 * counting the main one. `3` is the main diagonal and the one either side of it
 * — five cells, reaching two bins each way. It is the same number the method is
 * described with and the same number the R script this reproduces calls
 * `num_diagonals`, one greater (that one counts diagonals *beside* the main one
 * and 2 there is 3 here).
 *
 * In diagonals rather than base pairs for the reason the diamond's window and
 * the index's are in bins (§18.5): the near-diagonal is a fact about the grid
 * rather than about the genome, and the same typed number of base pairs meant
 * three diagonals at one resolution and one at the next. The runner says what
 * the reach came to in base pairs on the file actually open, because three
 * diagonals reach 4 kb either way on the 2 kb maps this default was chosen
 * against and 100 kb on a 50 kb one.
 *
 * {@link DEFAULT_HIC_SCORE_DIAGONALS} is **3**, which is the bacterial reading:
 * 2 kb matrices, the main diagonal and the two beside it, five cells averaged.
 * A map with much larger domains wants more, and that is exactly the kind of
 * thing a form control is for.
 */

import { extentOf, framingCovers, tickedContigs } from '../context'
import { bandTiles } from '../tiles'
import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * The main diagonal and the one either side, which is the bacterial reading.
 *
 * Five cells on the 2 kb matrices this score is computed on there, reaching
 * 4 kb each way — `num_diagonals = 2` in the R script this reproduces, which
 * counts the same set from the other end.
 */
export const DEFAULT_HIC_SCORE_DIAGONALS = 3

/** Diagonals the line spans, counting the main one. At least one. */
export function diagonalsOf(params: Params): number {
  const value = typeof params.diagonals === 'number' ? params.diagonals : DEFAULT_HIC_SCORE_DIAGONALS
  return Math.max(1, Math.round(value))
}

/**
 * The widest separation the line touches, in bins.
 *
 * One less than the diagonal count — the main diagonal is separation zero — and
 * it is also how far the line reaches each way, and therefore how deep the band
 * behind it has to be read.
 */
export function reachOf(params: Params): number {
  return diagonalsOf(params) - 1
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'number',
    key: 'diagonals',
    label: 'diagonals',
    hint:
      'How many diagonals the bin’s line crosses, counting the main one. 3 is the main diagonal ' +
      'and the one either side — five cells, two bins each way — the reading bacterial maps are ' +
      'scored with at 2 kb.',
    default: DEFAULT_HIC_SCORE_DIAGONALS,
    min: 1,
    integer: true,
  },
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  {
    kind: 'number',
    key: 'ignoreDiags',
    label: 'diagonals to ignore',
    hint:
      '0 counts every cell, including the bin’s contact with itself — which at three diagonals is ' +
      'most of the score, is where self-ligation lands, and on a balanced map is the one place the ' +
      'weights were never fitted. 1 cuts it out.',
    default: 0,
    min: 0,
    integer: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'minimum coverage of the line',
    hint: 'Below this fraction of usable cells the bin gets no score at all.',
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
  // The furthest cell of the line is `diagonals − 1` from the diagonal, so that
  // is how deep the band has to be read — and no deeper. The square-window
  // reading this replaced needed twice its own reach, for its corners.
  const depth = reachOf(params)
  const chosen = tickedContigs(context, params, 'sequences')
  if (chosen.length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Tick at least one sequence.',
    }
  }

  // The line spans `2 × depth + 1` bins, so a sequence no longer than that has
  // no bin with a whole line through it and is not read. One ticked gets the
  // sentence naming it; several get the count, since a metagenome of short
  // contigs is the ordinary case rather than a mistake.
  const long = chosen.filter((entry) => entry.bins > 2 * depth)
  if (long.length === 0) {
    const one = chosen.length === 1 ? chosen[0] : null
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        one !== null
          ? `${one.name} is ${one.bins.toLocaleString()} bins and the line is ` +
            `${(2 * depth + 1).toLocaleString()} across, so no bin on it has a whole line ` +
            'through it. Use fewer diagonals, or a longer sequence.'
          : `No ticked sequence is longer than the ${(2 * depth + 1).toLocaleString()} bins ` +
            'this line spans, so no bin on any of them has a whole line through it. Use fewer ' +
            'diagonals, or tick a longer sequence.',
    }
  }

  const extent = extentOf(long)

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

  const perTile = balance ? 5 : 4
  if (long.length === 1) {
    const contig = long[0]
    const tiles = bandTiles(contig.bins, depth)
    const requests = tiles * perTile
    return {
      class: 'bounded',
      requests,
      bytes: null,
      note:
        `About ${requests.toLocaleString()} range requests: ${contig.name} is read as a band ` +
        `${depth.toLocaleString()} ${depth === 1 ? 'bin' : 'bins'} deep, in ` +
        `${tiles.toLocaleString()} ${tiles === 1 ? 'strip' : 'strips'}, never as the whole square.`,
    }
  }

  const tiles = long.reduce((sum, entry) => sum + bandTiles(entry.bins, depth), 0)
  return {
    class: 'scan',
    requests: tiles * perTile,
    bytes: null,
    note:
      `${long.length.toLocaleString()} sequences are long enough for this score, read as ` +
      `${tiles.toLocaleString()} ${tiles === 1 ? 'strip' : 'strips'} along their diagonals.`,
  }
}

export const HIC_SCORE_TASK: AnalysisTask = {
  id: 'hicscore',
  title: 'HiC score',
  blurb: 'The mean contact a bin makes with its near neighbourhood.',
  group: 'map',
  venue: 'analysis',
  // Bumped twice over this cycle: version 1 summed the whole square window, 2
  // took the mean of its upper triangle, and this one is the mean of the bin's
  // own line across the near-diagonal — which is the reading the R script the
  // score comes from computes. A result carried in from a shared session naming
  // an older version is a different quantity under the same title.
  version: 3,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

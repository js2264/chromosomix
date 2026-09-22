/**
 * The scalogram, as a descriptor.
 *
 * Directly after P(s), because it is P(s) with one summation left undone. The
 * decay curve averages every bin of a sequence into one line and answers *how
 * does this genome fold*; the scalogram keeps the bins apart and answers *where
 * does this genome fold differently from itself*. A reader who has just looked
 * at a decay curve and wondered which part of the chromosome carried the bump is
 * asking for exactly this, and until now the only way to see it was to look at
 * the map and squint.
 *
 * ## Two parameters, and both are about cost
 *
 * **The quantiles** decide how many bands the picture has. Five is the default
 * and is what Cournac's figures and `HiContacts`' `scalogram()` draw: a tenth, a
 * quarter, a half, three quarters, nine tenths. They are offered as *sets*
 * rather than as a list to type, for the reason `tasks/insulation.ts` gives about
 * its window ladder — a free-text list needs a control this form has not got and
 * a parser with its own failure modes, to express something three named choices
 * express exactly.
 *
 * **The reach** decides what it costs, and it is a number of **bins**. The
 * quantity is a distribution over separation, so a quantile is only honest out
 * to the separation that was actually looked at: cut the reach at a thousand
 * bins on a 250,000-bin chromosome and the ninetieth centile is *the ninetieth
 * centile of what is within a thousand bins*, which is a different number
 * wearing the same name. So the default is **0, the whole sequence**, which is
 * the honest answer and is perfectly affordable on the bacterial and yeast maps
 * this reading comes from — and on a mammalian chromosome it is a square, which
 * {@link estimate} prices as one and says so. A reader who wants it there sets a
 * reach, and the runner puts the cut in the lane's own label so the picture
 * cannot be mistaken for the unbounded one.
 *
 * In bins rather than base pairs because the reach is the **depth of the band**
 * this task reads — `bandFor`'s `hi`, which is a count of diagonals — so a
 * number typed in base pairs was divided by the bin size on the way in and the
 * same 500 kb meant 500 diagonals at 1 kb and 50 at 10 kb. The cost of bins is
 * the one they always carry, and the runner pays it in one line: it says what
 * the cut came to in base pairs on the file actually open.
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

/** The quantile sets on offer, by the value the form stores. */
export const QUANTILE_SETS: Record<string, readonly number[]> = {
  quartiles: [0.25, 0.5, 0.75],
  standard: [0.1, 0.25, 0.5, 0.75, 0.9],
  deciles: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
}

/** The quantiles a run reports, falling back to the five-band set. */
export function quantilesOf(params: Params): readonly number[] {
  const key = typeof params.quantiles === 'string' ? params.quantiles : 'standard'
  return QUANTILE_SETS[key] ?? QUANTILE_SETS.standard
}

/** The reach in **bins**; `0` is the whole sequence. */
export function reachBinsOf(params: Params): number {
  const value = typeof params.reach === 'number' ? params.reach : 0
  return Math.max(0, Math.round(value))
}

/**
 * How deep the band has to be read for one sequence, in bins.
 *
 * The reach, or the sequence itself where none was set — and half the sequence
 * where it is circular, because past half a circle the short way round is the
 * other way and a band read wider than that holds every cell twice.
 *
 * No arithmetic left in the middle: the reach *is* a bin count now, so the
 * division by the bin size that used to be here — and the rounding that came
 * with it — is gone rather than moved. What the cut came to in base pairs is
 * said once, by the runner, on the file actually open.
 */
export function reachBinsFor(params: Params, bins: number, circular = false): number {
  const ceiling = circular ? Math.floor(bins / 2) : Math.max(1, bins - 1)
  const reach = reachBinsOf(params)
  if (reach === 0) return ceiling
  return Math.max(1, Math.min(ceiling, reach))
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'quantiles',
    label: 'quantiles',
    default: 'standard',
    hint: 'One band per quantile, nested in a single lane.',
    options: [
      {
        value: 'standard',
        label: 'five (10, 25, 50, 75, 90 %)',
        hint: 'Cournac et al.’s bands, and what HiContacts draws.',
      },
      { value: 'quartiles', label: 'three (25, 50, 75 %)', hint: 'The quartiles alone.' },
      { value: 'deciles', label: 'nine (every 10 %)', hint: 'A finer picture; nine lanes of ink.' },
    ],
  },
  {
    kind: 'number',
    key: 'reach',
    label: 'look out to',
    hint:
      '0 is the whole sequence, which is the only unbounded answer. A cut makes every quantile ' +
      'a quantile of what is within it, and the lane says so.',
    default: 0,
    min: 0,
    integer: true,
    // **Bins, where this was base pairs.** The reach is the depth of the band
    // that comes off the file — `bandFor`'s `hi`, a count of diagonals — so the
    // number that decides what the run costs and what each quantile is a
    // quantile *of* has always been this one. Asked in base pairs it was
    // divided by the bin size and rounded, so the same typed 500 kb was 500
    // diagonals on one rung of an `.mcool` and 50 on the next, and the lane's
    // own label said the distance rather than the depth.
    unit: 'bins',
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
    /**
     * `1` rather than the diamond's `2` and the index's `0`, and
     * `analysis/scalogram.ts` argues it: the bin's contact with itself is the
     * largest number in its row and is not a contact at a distance, so leaving
     * it in drags every quantile towards zero by however much self-ligation the
     * library has.
     */
    hint: '1 drops the bin’s contact with itself, which is not a contact at a distance.',
    default: 1,
    min: 0,
    integer: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minValid',
    label: 'minimum coverage of the distribution',
    hint: 'Below this fraction of usable separations the bin gets no bands at all.',
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

  const extent = extentOf(chosen)

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
  const unbounded = reachBinsOf(params) === 0
  if (chosen.length === 1) {
    const contig = chosen[0]
    const depth = reachBinsFor(params, contig.bins)
    const tiles = bandTiles(contig.bins, depth)
    const requests = tiles * perTile
    return {
      class: unbounded ? 'scan' : 'bounded',
      requests,
      bytes: null,
      note: unbounded
        ? `About ${requests.toLocaleString()} range requests: with no cut, ${contig.name} is ` +
          `read out to its own length — ${contig.bins.toLocaleString()} bins — which is the ` +
          'whole square. Set a reach to read a band instead.'
        : `About ${requests.toLocaleString()} range requests: ${contig.name} is read as a band ` +
          `${depth.toLocaleString()} bins deep, in ${tiles.toLocaleString()} ` +
          `${tiles === 1 ? 'strip' : 'strips'}.`,
    }
  }

  const tiles = chosen.reduce(
    (sum, entry) => sum + bandTiles(entry.bins, reachBinsFor(params, entry.bins)),
    0,
  )
  return {
    class: 'scan',
    requests: tiles * perTile,
    bytes: null,
    note:
      `${chosen.length.toLocaleString()} sequences, read along their diagonals in ` +
      `${tiles.toLocaleString()} ${tiles === 1 ? 'strip' : 'strips'}` +
      (unbounded ? ' — with no cut, each is read out to its own length.' : '.'),
  }
}

export const SCALOGRAM_TASK: AnalysisTask = {
  id: 'scalogram',
  title: 'Scalogram',
  blurb: 'How far each bin’s contacts reach, as nested quantile bands.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}

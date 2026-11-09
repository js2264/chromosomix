/**
 * TAD annotation, as a descriptor: Juicer's Arrowhead.
 *
 * The domain caller the insulation task is not. Insulation and the
 * directionality index read one number per bin and cut the sequence at its
 * minima or its sign flips, so the domains they give tile it: every stretch
 * between two boundaries is one, nothing nests and nothing is left over.
 * Arrowhead reads the *corners* of the squares the domains make on the map
 * (Rao et al., Cell 159:1665, 2014), so its domains can sit inside one another,
 * overlap at their edges, and leave a stretch with no structure uncalled.
 *
 * It is a caller, and §18.9 admits it on that section's terms: a port of
 * `juicer_tools arrowhead` — `juicebox.tools.utils.juicer.arrowhead`, as
 * `juicer_tools_1.22.01.jar` runs it — whose golden is that
 * program's own output (`test/golden/analysis/arrowhead.json`). Every setting
 * here is one of Juicer's, under the meaning its `-m` and its six `-t`
 * thresholds give it, and every default is Juicer's.
 *
 * **The resolution is the map's.** Juicer picks 5 or 10 kb from how deep the
 * map is when it is not told; here the map open is the resolution asked, as it
 * is for every other task, and the run notes when that is outside the 5–25 kb
 * the method was tuned at.
 */

import { ARROWHEAD_DEFAULTS, arrowheadWindows } from '../arrowhead'
import { extentOf, framingCovers, tickedContigs } from '../context'
import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/** The widest window a run may hold: at 4,000 bins one window's triangles are about 700 MB. */
export const MAX_ARROWHEAD_WINDOW = 4000

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  {
    kind: 'number',
    key: 'matrixSize',
    label: 'window',
    hint:
      'Juicer’s -m: each sequence is read as squares this many bins wide, half of one overlapping ' +
      'the next, and a domain wider than a square is not found.',
    default: ARROWHEAD_DEFAULTS.matrixSize,
    min: 30,
    max: MAX_ARROWHEAD_WINDOW,
    integer: true,
    unit: 'bins',
  },
  {
    kind: 'number',
    key: 'minBlockSize',
    label: 'smallest lenient domain',
    hint: 'A domain found only by the lenient pass is kept when it is wider than this.',
    default: ARROWHEAD_DEFAULTS.minBlockSize,
    min: 0,
    integer: true,
    unit: 'bins',
  },
  {
    kind: 'number',
    key: 'varThreshold',
    label: 'variance at most',
    hint: 'The two triangles’ variances summed; a corner above it is not kept by the strict pass.',
    default: ARROWHEAD_DEFAULTS.varThreshold,
    min: 0,
    step: 0.01,
    section: 'Strict pass',
  },
  {
    kind: 'number',
    key: 'highSignThreshold',
    label: 'sign agreement at least',
    hint: 'How consistently each triangle points the way a domain’s does, from −1 to 1.',
    default: ARROWHEAD_DEFAULTS.highSignThreshold,
    min: -1,
    max: 1,
    step: 0.05,
    section: 'Strict pass',
  },
  {
    kind: 'number',
    key: 'maxLowSignThreshold',
    label: 'sign agreement from',
    hint:
      'The lenient pass asks this much of both triangles and no variance, and asks less, a step at ' +
      'a time, until a sequence has a domain.',
    default: ARROWHEAD_DEFAULTS.maxLowSignThreshold,
    min: -1,
    max: 1,
    step: 0.05,
    section: 'Lenient pass',
  },
  {
    kind: 'number',
    key: 'minLowSignThreshold',
    label: 'down to',
    default: ARROWHEAD_DEFAULTS.minLowSignThreshold,
    min: -1,
    max: 1,
    step: 0.05,
    section: 'Lenient pass',
  },
  {
    kind: 'number',
    key: 'decrementLowSignThreshold',
    label: 'in steps of',
    default: ARROWHEAD_DEFAULTS.decrementLowSignThreshold,
    min: 0.01,
    max: 1,
    step: 0.01,
    section: 'Lenient pass',
  },
  BALANCE_PARAM,
]

/** The window, as the form answered it. */
export function matrixSizeOf(params: Params): number {
  const value = typeof params.matrixSize === 'number' ? params.matrixSize : ARROWHEAD_DEFAULTS.matrixSize
  return Math.max(30, Math.min(MAX_ARROWHEAD_WINDOW, Math.round(value)))
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
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
  const low = typeof params.maxLowSignThreshold === 'number' ? params.maxLowSignThreshold : 0.4
  const floor = typeof params.minLowSignThreshold === 'number' ? params.minLowSignThreshold : 0
  if (low < floor) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'The lenient pass starts below where it stops: its first sign agreement has to be the higher.',
    }
  }
  const size = matrixSizeOf(params)
  const windows = chosen.reduce((sum, contig) => sum + arrowheadWindows(contig.bins, size).length, 0)
  const balance = params.balance === true
  const framing = context.framing
  if (
    context.blockLoaded &&
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === balance &&
    framingCovers(framing, extentOf(chosen))
  ) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note:
        `${windows.toLocaleString()} ${windows === 1 ? 'window' : 'windows'}, cut from the block ` +
        'already on screen. No reads.',
    }
  }
  const each = balance ? 5 : 4
  const squares = `${windows.toLocaleString()} ${windows === 1 ? 'square' : 'squares'} of ` +
    `${(size + 1).toLocaleString()} bins along ${chosen.length === 1 ? 'its' : 'their'} diagonal`
  return {
    class: chosen.length === 1 ? 'bounded' : 'scan',
    requests: windows * each,
    bytes: null,
    note:
      chosen.length === 1
        ? `${chosen[0].name} is read as ${squares}`
        : `${chosen.length.toLocaleString()} sequences, read as ${squares}`,
  }
}

export const ARROWHEAD_TASK: AnalysisTask = {
  id: 'arrowhead',
  title: 'TAD annotation',
  blurb: 'Contact domains by Juicer’s Arrowhead: nested where they nest, and none where there are none.',
  keywords: ['TAD', 'Arrowhead', 'Juicer', 'contact domains', 'domains', 'corner score'],
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['intervals', 'table'],
  estimate,
}

/**
 * Inter-arm alignment, run.
 *
 * Per sequence: the square read whole, its own distance decay — the short way
 * round on a circle (§8.15) — as the expectation, and then `interArmProfile`
 * over the ratio, which is the whole of the measurement and is tested on its own
 * (`analysis/arms.ts`). What is here is the reading, the origin, and the three
 * shapes the answer is given in.
 *
 * And the control: the same square over the decay along both arms, the
 * expectation that takes the secondary diagonal in, read over the same stretch
 * as a column beside the enrichment — what is left of the alignment once the
 * map's arms or Compartments have divided it out — and drawn as a curve of its
 * own beside the measurement's, on the same axis. Last, the two expectations
 * themselves, as decay curves: the ordinary one along the diagonal, and the one
 * along both arms, within an arm and across the two.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { cisSeparation } from '../compartments'
import { ExpectedAccumulator, expectedAt, logBinCurve, type ExpectedCurve } from '../expected'
import { armDecay, armExpected, interArmProfile, interArmSummary, type ArmFrame } from '../arms'
import {
  boolParam,
  numParam,
  originOf,
  readsAsCircular,
  tickedSequences,
  type JobContext,
  type TaskRunner,
} from '../job'
import { MAX_CORRELATION_BINS } from '../tasks/compartments'
import type { CurveOutput, CurveSeries, ProfileOutput, TableOutput, TaskOutput } from '../types'
import { missingSequencesNote, tickedContigIds, usableBlock, squareOf } from './blocks'

/** One sequence's square, from the view's block where it covers it, else read. */
async function squareFor(
  job: JobContext,
  from: number,
  to: number,
  balance: boolean,
): Promise<Float32Array> {
  const span = { from, to }
  const block = usableBlock(job, [span], balance)
  if (block !== null) return squareOf(block, span).values
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const dense = await job.mc.matrix({ rows: [from, to], cols: [from, to], balance, value })
  return dense.values
}

/** This sequence's own distance decay, measured as it is read: the short way round on a circle. */
function decayOf(values: Float32Array, n: number, lap: number): ExpectedCurve {
  const accumulator = new ExpectedAccumulator(lap > 0 ? Math.floor(n / 2) : Math.max(0, n - 1), lap)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) accumulator.add(cisSeparation(Math.abs(c - r), lap), values[r * n + c])
  }
  return accumulator.finish()
}

/** Observed over this sequence's own distance decay. */
function observedOverDecay(values: Float32Array, n: number, lap: number, curve: ExpectedCurve): Float64Array {
  const out = new Float64Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const observed = values[r * n + c]
      const expected = expectedAt(curve, cisSeparation(Math.abs(c - r), lap))
      out[r * n + c] =
        Number.isFinite(observed) && Number.isFinite(expected) && expected > 0
          ? observed / expected
          : Number.NaN
    }
  }
  return out
}

/**
 * Observed over the decay along both arms (`analysis/arms.ts`), masked as the
 * map masks it: a cell with no value stays a gap, and so does one whose
 * expectation is not positive. The expectation's own array holds the ratio, so
 * a square at the cap costs one of them rather than two.
 */
function observedOverArms(values: Float32Array, n: number, frame: ArmFrame, window: number): Float64Array {
  const bins = Int32Array.from({ length: n }, (_, i) => i)
  const out = armExpected(values, bins, bins, frame, window)
  for (let i = 0; i < out.length; i++) {
    const observed = values[i]
    const expected = out[i]
    out[i] = Number.isFinite(observed) && expected > 0 ? observed / expected : Number.NaN
  }
  return out
}


/**
 * Log bins per step for the decay curves: P(s)'s own default, so the curves read
 * as that task's `expected (cooltools)` curve does.
 */
const DECAY_FACTOR = 1.1

/** Log2 of a profile by distance from the origin, at its distances in base pairs. */
function logProfile(name: string, byDistance: Float64Array, binsize: number): CurveSeries {
  const x = new Float64Array(byDistance.length)
  const y = new Float64Array(byDistance.length)
  for (let d = 0; d < byDistance.length; d++) {
    x[d] = d * binsize
    y[d] = byDistance[d] > 0 ? Math.log2(byDistance[d]) : Number.NaN
  }
  return { name, x, y }
}

/** A decay curve log-binned as P(s) bins one, from one bin away from its diagonal. */
function decaySeries(name: string, curve: ExpectedCurve, binsize: number): CurveSeries | null {
  const binned = logBinCurve(curve, binsize, DECAY_FACTOR, 1)
  if (binned.x.length === 0) return null
  let cells = 0
  for (const count of binned.n) cells += count
  return { name, x: binned.x, y: binned.y, n: cells }
}

/**
 * The finite range of every series' ordinate, out to the whole numbers either
 * side — whole `log2` steps, so the axis two figures share opens on a doubling
 * at each end rather than on whatever the noise reached — or `undefined` where
 * there is none.
 */
function rangeOf(...groups: CurveSeries[][]): [number, number] | undefined {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const group of groups) {
    for (const series of group) {
      for (const value of series.y) {
        if (!Number.isFinite(value)) continue
        low = Math.min(low, value)
        high = Math.max(high, value)
      }
    }
  }
  if (!(low <= high)) return undefined
  const floor = Math.floor(low)
  const ceiling = Math.ceil(high)
  return floor < ceiling ? [floor, ceiling] : [floor - 1, ceiling + 1]
}

export const runInterArm: TaskRunner = async (job) => {
  const { ids, missing } = tickedContigIds(job.mc, tickedSequences(job.params, 'sequences'))
  const said = missingSequencesNote(job.mc, missing, ids.length)
  if (said !== null) job.note(said)
  if (ids.length === 0) return []

  const balance = boolParam(job.params, 'balance', true)
  const band = Math.max(0, Math.min(50, Math.round(numParam(job.params, 'band', 2))))
  const armWindow = Math.max(0, Math.round(numParam(job.params, 'armWindow', 50)))
  const binsize = job.mc.binsize
  const track = new Float32Array(job.mc.nBins).fill(Number.NaN)
  const series: CurveSeries[] = []
  const detrendedSeries: CurveSeries[] = []
  const decays: CurveSeries[] = []
  const rows: Array<Record<string, string | number>> = []

  for (let k = 0; k < ids.length; k++) {
    await job.breathe()
    const cid = ids[k]
    const name = job.mc.chromnames[cid]
    const [from, to] = job.mc.contigExtent(cid)
    const n = to - from
    job.progress(k, ids.length, name)
    if (n < 8) {
      job.note(`${name}: ${n} bins is too few to have arms at this resolution; left out.`)
      continue
    }
    if (n > MAX_CORRELATION_BINS) {
      job.note(
        `${name}: ${n.toLocaleString()} bins is past the ${MAX_CORRELATION_BINS.toLocaleString()}` +
          '-bin limit on a square read whole; left out. Open the file at a coarser resolution.',
      )
      continue
    }
    const circular = readsAsCircular(job, name)
    const declared = originOf(job, name)
    const origin = Math.max(0, Math.min(n - 1, Math.floor((declared ?? 0) / binsize)))
    if (declared === undefined) {
      job.note(
        `${name}: the arms were read from the first base, the origin every sequence has until ` +
          'one is set — on the Chromosomes table, or by Origin and terminus.',
      )
    }
    const frame: ArmFrame = { n, origin, circular }

    const values = await squareFor(job, from, to, balance)
    job.throwIfCancelled()
    const lap = circular ? n : 0
    const decay = decayOf(values, n, lap)
    // Each ratio is let go once it is profiled, so the two squares of doubles
    // are not held at once.
    const { byDistance, byBin } = interArmProfile(observedOverDecay(values, n, lap, decay), frame, band)
    const summary = interArmSummary(byDistance)

    for (let i = 0; i < n; i++) track[from + i] = byBin[i] > 0 ? Math.log2(byBin[i]) : Number.NaN
    series.push(logProfile(name, byDistance, binsize))

    // The control: the same cells over the decay along both arms, which has the
    // secondary diagonal in it — so what the enrichment measured should be gone.
    // Read over the measurement's stretch, so the two average the same distances.
    await job.breathe()
    job.throwIfCancelled()
    const control = interArmProfile(observedOverArms(values, n, frame, armWindow), frame, band).byDistance
    const detrended = interArmSummary(control, summary.reach)
    detrendedSeries.push(logProfile(name, control, binsize))

    // The two expectations, as curves: the ordinary decay the enrichment is read
    // over, and the decay along both arms the control is read over — at the
    // whole sequence's window, by separation alone.
    const { within, across } = armDecay(values, frame)
    for (const line of [
      decaySeries(`${name} · along the diagonal`, decay, binsize),
      decaySeries(`${name} · within an arm`, within, binsize),
      decaySeries(`${name} · across the arms`, across, binsize),
    ]) {
      if (line !== null) decays.push(line)
    }

    // Folds over expected on the table's linear scale — two to the `log2` means
    // the summaries are read in, so enrichment and depletion still weigh alike in
    // the averaging — and the reach in base pairs. The curve and the track stay
    // on `log2`.
    rows.push({
      sequence: name,
      topology: circular ? 'circular' : 'linear',
      origin: (declared ?? 0) + 1,
      enrichment: 2 ** summary.score,
      detrended: 2 ** detrended.score,
      reach: Number.isFinite(summary.reach) ? summary.reach * binsize : Number.NaN,
      armLength: (circular ? Math.floor(n / 2) : Math.max(origin, n - 1 - origin)) * binsize,
    })
    if (!circular) {
      job.note(
        `${name} was read as linear, so an origin near either end leaves it one arm. A bacterial ` +
          'chromosome is usually circular — tick it on the Chromosomes table.',
      )
    }
  }
  job.progress(ids.length, ids.length, 'done')
  if (rows.length === 0) return []
  job.note(
    `Cells within ${band} ${band === 1 ? 'bin' : 'bins'} (${(band * binsize).toLocaleString()} bp) ` +
      'of the secondary diagonal, over each sequence’s own distance decay.',
  )
  job.note(
    'Enrichment after detrend is the same cells over the decay along both arms' +
      (armWindow === 0
        ? ', over the whole of it'
        : `, within ${armWindow.toLocaleString()} ${armWindow === 1 ? 'bin' : 'bins'} ` +
          `(${(armWindow * binsize).toLocaleString()} bp) of each cell along them`) +
      ' — the expectation the map’s arms and Compartments divide by, which takes the secondary ' +
      'diagonal in — read over the same stretch as the enrichment. It is near 1 where that works: ' +
      'it is a control on the detrending, not a second measure of the alignment.',
  )

  job.note(
    'The decay curves are the two expectations: along the diagonal, the one the enrichment is read ' +
      'over; within an arm and across the arms, the decay along both arms averaged over the whole of ' +
      'them, which the window follows along the arms. Log-binned as P(s)’s expected curve is, from ' +
      'one bin away from each diagonal.',
  )

  // The control is drawn on the measurement's own axis: a flat line read on a
  // window fitted to its noise looks like a profile, which is the one thing it
  // is there to show it is not.
  const shared = rangeOf(series, detrendedSeries)
  const outputs: TaskOutput[] = [
    {
      kind: 'profile',
      id: 'interarm-enrichment',
      label: `Inter-arm enrichment · ±${band} ${band === 1 ? 'bin' : 'bins'}`,
      values: track,
      extent: [0, job.mc.nBins],
      binsize,
      unit: 'log2',
    } satisfies ProfileOutput,
    {
      kind: 'curve',
      id: 'interarm-curve',
      label: 'Inter-arm alignment by distance from the origin',
      series,
      xLabel: 'Distance from the origin (bp)',
      yLabel: 'Secondary-diagonal enrichment (log2 O/E)',
      xScale: 'linear',
      yScale: 'linear',
      ...(shared === undefined ? {} : { yDomain: shared }),
    } satisfies CurveOutput,
    {
      kind: 'curve',
      id: 'interarm-detrended-curve',
      label: 'Inter-arm alignment after detrend, by distance from the origin',
      series: detrendedSeries,
      xLabel: 'Distance from the origin (bp)',
      yLabel: 'Enrichment over the decay along both arms (log2 O/E)',
      xScale: 'linear',
      yScale: 'linear',
      ...(shared === undefined ? {} : { yDomain: shared }),
    } satisfies CurveOutput,
    {
      kind: 'curve',
      id: 'interarm-decay',
      label: 'Contact decay along the diagonal and along both arms',
      series: decays,
      xLabel: 'Separation from the main or the secondary diagonal (bp)',
      yLabel: 'Mean contact per bin pair',
      xScale: 'log',
      yScale: 'log',
    } satisfies CurveOutput,
    {
      kind: 'table',
      id: 'interarm-table',
      label: 'Inter-arm alignment per sequence',
      columns: [
        { key: 'sequence', label: 'sequence', kind: 'text' },
        { key: 'topology', label: 'read as', kind: 'text' },
        { key: 'origin', label: 'origin', kind: 'number', hint: 'The origin the arms were read from, 1-based.' },
        {
          key: 'enrichment',
          label: 'enrichment',
          kind: 'number',
          digits: 3,
          hint:
            'How many times as often mirror images touch as expected, from the origin out to the reach — ' +
            'how strong the alignment is where it holds — or over the whole arm where nothing reaches: 1 ' +
            'is no alignment, 2 twice as often. Two to the mean log2, so enrichment and depletion weigh ' +
            'alike.',
        },
        {
          key: 'detrended',
          label: 'enrichment after detrend',
          kind: 'number',
          digits: 3,
          hint:
            'The same cells over the decay along both arms, as the map’s arms and Compartments divide ' +
            'by, read over the same stretch as the enrichment: 1 is no alignment left over — a control ' +
            'on that detrending.',
        },
        {
          key: 'reach',
          label: 'reach',
          kind: 'number',
          hint:
            'How far from the origin, in bp, the enrichment holds before it falls four-fifths of the way ' +
            'from its peak back to 1, on a log scale — where the alignment ends.',
        },
        { key: 'armLength', label: 'arm', kind: 'number', hint: 'Length of the longer arm, in bp.' },
      ],
      rows,
    } satisfies TableOutput,
  ]
  return outputs
}

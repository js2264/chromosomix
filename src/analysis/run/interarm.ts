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
 * expectation that takes the secondary diagonal in, summarised the same way as
 * a second row of the table — what is left of the alignment once the map's arms
 * or Compartments have divided it out.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { cisSeparation } from '../compartments'
import { ExpectedAccumulator, expectedAt } from '../expected'
import { armExpected, interArmProfile, interArmSummary, type ArmFrame } from '../arms'
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

/** Observed over this sequence's own distance decay, measured as it is read. */
function observedOverDecay(values: Float32Array, n: number, lap: number): Float64Array {
  const accumulator = new ExpectedAccumulator(lap > 0 ? Math.floor(n / 2) : Math.max(0, n - 1), lap)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) accumulator.add(cisSeparation(Math.abs(c - r), lap), values[r * n + c])
  }
  const curve = accumulator.finish()
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
 * What a row says of a summary, on the table's linear scale: the enrichment and
 * the peak as folds over expected — two to the `log2` means the summary is
 * read in, so enrichment and depletion still weigh alike in the averaging — and
 * the reach in base pairs. The curve and the track stay on `log2`.
 */
function rowNumbers(
  summary: { score: number; reach: number; peak: number },
  binsize: number,
): { enrichment: number; peak: number; reach: number } {
  return {
    enrichment: 2 ** summary.score,
    peak: 2 ** summary.peak,
    reach: Number.isFinite(summary.reach) ? summary.reach * binsize : Number.NaN,
  }
}

/** The rows' names for what each cell was divided by — Compartments' words for the same two. */
const BY_DECAY = 'distance decay'
const BY_ARMS = 'decay along both arms'

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
    // Each ratio is let go once it is profiled, so the two squares of doubles
    // are not held at once.
    const { byDistance, byBin } = interArmProfile(observedOverDecay(values, n, circular ? n : 0), frame, band)
    const summary = interArmSummary(byDistance)

    for (let i = 0; i < n; i++) track[from + i] = byBin[i] > 0 ? Math.log2(byBin[i]) : Number.NaN
    const x = new Float64Array(byDistance.length)
    const y = new Float64Array(byDistance.length)
    for (let d = 0; d < byDistance.length; d++) {
      x[d] = d * binsize
      y[d] = byDistance[d] > 0 ? Math.log2(byDistance[d]) : Number.NaN
    }
    series.push({ name, x, y })

    // The control: the same cells over the decay along both arms, which has the
    // secondary diagonal in it — so what the first row measured should be gone.
    // Its enrichment is read over the measurement's stretch, so the two rows
    // average the same distances; its peak and reach are its own.
    await job.breathe()
    job.throwIfCancelled()
    const detrended = interArmSummary(
      interArmProfile(observedOverArms(values, n, frame, armWindow), frame, band).byDistance,
      summary.reach,
    )

    const shared = {
      sequence: name,
      topology: circular ? 'circular' : 'linear',
      origin: (declared ?? 0) + 1,
      armLength: (circular ? Math.floor(n / 2) : Math.max(origin, n - 1 - origin)) * binsize,
    }
    rows.push({ ...shared, expected: BY_DECAY, ...rowNumbers(summary, binsize) })
    rows.push({ ...shared, expected: BY_ARMS, ...rowNumbers(detrended, binsize) })
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
    'Each sequence’s second row is the same cells over the decay along both arms' +
      (armWindow === 0
        ? ', over the whole of it'
        : `, within ${armWindow.toLocaleString()} ${armWindow === 1 ? 'bin' : 'bins'} ` +
          `(${(armWindow * binsize).toLocaleString()} bp) of each cell along them`) +
      ' — the expectation the map’s arms and Compartments divide by, which takes the secondary ' +
      'diagonal in. Its enrichment, read over the first row’s stretch, is near 1 where that works: it is a ' +
      'control on the detrending, not a second measure of the alignment. Its peak and reach are its ' +
      'own, and a peak at the terminus — where the two diagonals cross and that expectation is at its ' +
      'weakest — is the model’s edge rather than alignment left over.',
  )

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
      xLabel: 'Distance from the origin',
      yLabel: 'Secondary-diagonal enrichment (log2 O/E)',
      xScale: 'linear',
      yScale: 'linear',
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
          key: 'expected',
          label: 'expected',
          kind: 'text',
          hint:
            'What each cell was divided by: the distance decay, which leaves the secondary diagonal ' +
            'standing out — the measurement — or the decay along both arms, which takes it in, as the ' +
            'map’s arms and Compartments do — the control on that detrending.',
        },
        {
          key: 'enrichment',
          label: 'enrichment',
          kind: 'number',
          digits: 3,
          hint:
            'How many times as often mirror images touch as expected, from the origin out to the reach — ' +
            'how strong the alignment is where it holds — or over the whole arm where nothing reaches: 1 ' +
            'is no alignment, 2 twice as often. Two to the mean log2, so enrichment and depletion weigh ' +
            'alike. The detrended row is read over the first row’s stretch; 1 there is none left over.',
        },
        {
          key: 'peak',
          label: 'peak',
          kind: 'number',
          digits: 3,
          hint: 'Its highest enrichment, as a fold over expected, averaged over 2% of the arm.',
        },
        {
          key: 'reach',
          label: 'reach',
          kind: 'number',
          hint:
            'How far from the origin, in bp, the enrichment holds before it falls below the square root ' +
            'of its peak — half-way back to 1 on a log scale.',
        },
        { key: 'armLength', label: 'arm', kind: 'number', hint: 'Length of the longer arm, in bp.' },
      ],
      rows,
    } satisfies TableOutput,
  ]
  return outputs
}

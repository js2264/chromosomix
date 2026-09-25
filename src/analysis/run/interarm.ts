/**
 * Inter-arm alignment, run.
 *
 * Per sequence: the square read whole, its own distance decay — the short way
 * round on a circle (§8.15) — as the expectation, and then `interArmProfile`
 * over the ratio, which is the whole of the measurement and is tested on its own
 * (`analysis/arms.ts`). What is here is the reading, the origin, and the three
 * shapes the answer is given in.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { cisSeparation } from '../compartments'
import { ExpectedAccumulator, expectedAt } from '../expected'
import { interArmProfile, interArmSummary, type ArmFrame } from '../arms'
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

export const runInterArm: TaskRunner = async (job) => {
  const { ids, missing } = tickedContigIds(job.mc, tickedSequences(job.params, 'sequences'))
  const said = missingSequencesNote(job.mc, missing, ids.length)
  if (said !== null) job.note(said)
  if (ids.length === 0) return []

  const balance = boolParam(job.params, 'balance', true)
  const band = Math.max(0, Math.min(50, Math.round(numParam(job.params, 'band', 2))))
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
    const oe = observedOverDecay(values, n, circular ? n : 0)
    const { byDistance, byBin } = interArmProfile(oe, frame, band)
    const summary = interArmSummary(byDistance)

    for (let i = 0; i < n; i++) track[from + i] = byBin[i] > 0 ? Math.log2(byBin[i]) : Number.NaN
    const x = new Float64Array(byDistance.length)
    const y = new Float64Array(byDistance.length)
    for (let d = 0; d < byDistance.length; d++) {
      x[d] = d * binsize
      y[d] = byDistance[d] > 0 ? Math.log2(byDistance[d]) : Number.NaN
    }
    series.push({ name, x, y })
    rows.push({
      sequence: name,
      topology: circular ? 'circular' : 'linear',
      origin: (declared ?? 0) + 1,
      score: summary.score,
      peak: summary.peak,
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
          key: 'score',
          label: 'score',
          kind: 'number',
          digits: 3,
          hint: 'Mean log2 enrichment of the secondary diagonal over the arms; 0 is no alignment.',
        },
        {
          key: 'peak',
          label: 'peak',
          kind: 'number',
          digits: 3,
          hint: 'Its highest log2 enrichment, averaged over 2% of the arm.',
        },
        {
          key: 'reach',
          label: 'reach',
          kind: 'number',
          hint: 'How far from the origin, in bp, the enrichment holds before it falls below half its peak.',
        },
        { key: 'armLength', label: 'arm', kind: 'number', hint: 'Length of the longer arm, in bp.' },
      ],
      rows,
    } satisfies TableOutput,
  ]
  return outputs
}

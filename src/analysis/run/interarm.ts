/**
 * Inter-arm alignment, run.
 *
 * Per sequence: the square read whole, **as the map is drawn** — its balancing
 * and column from the framing, its normalisation, the expectation it is divided
 * by and the scale it is drawn on from the parameters the picture answers
 * (`tasks/interarm.ts`) — and then `interArmProfile` over it, which is the whole
 * of the measurement and is tested on its own (`analysis/arms.ts`). What is here
 * is the reading, the origin, and the three shapes the answer is given in.
 *
 * The scale is applied to the **means**, not to the cells before they are
 * averaged: the `log2` of a band's mean ratio, as the task always reported it,
 * which an empty pixel counts towards as the zero it is — where the mean of the
 * cells' own logarithms would have to leave every empty pixel out, and would
 * report a sparse band as richer than it is.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { balanceBlock, coverageNormalise } from '../../render/derive'
import { cisSeparation } from '../compartments'
import { ExpectedAccumulator, expectedAt } from '../expected'
import { armExpected, interArmProfile, interArmSummaryOf, type ArmFrame } from '../arms'
import { numParam, originOf, readsAsCircular, tickedSequences, type JobContext, type TaskRunner } from '../job'
import { MAX_CORRELATION_BINS } from '../tasks/compartments'
import { interArmReading, readingQuantity, readingTitle, readingWords, type InterArmReading } from '../tasks/interarm'
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
 * The square as the map draws it, before its scale: normalised as the picture
 * is, and divided by the expectation the picture is — the distance decay, the
 * short way round a circle, or the decay along both arms (§8.15) — with an empty
 * pixel kept as the zero it is.
 */
function asDrawn(values: Float32Array, n: number, frame: ArmFrame, reading: InterArmReading): Float64Array {
  const block = { nrows: n, ncols: n, values, rowExtent: [0, n] as const, colExtent: [0, n] as const }
  const counts =
    reading.normalise === 'vc'
      ? coverageNormalise(block, 1)
      : reading.normalise === 'vcsqrt'
        ? coverageNormalise(block, 0.5)
        : reading.normalise === 'ice'
          ? balanceBlock(block).values
          : values
  if (reading.expected === 'decay') return observedOverDecay(counts, n, frame.circular ? n : 0)
  if (reading.expected === 'arms') {
    // The map's own arithmetic along the arms (`render/derive.ts`), on a square
    // that is the whole sequence in order, so each row is its own bin.
    const bins = Int32Array.from({ length: n }, (_, i) => i)
    const expected = armExpected(counts, bins, bins, frame, reading.window)
    const out = new Float64Array(n * n)
    for (let i = 0; i < n * n; i++) {
      const observed = counts[i]
      out[i] = Number.isFinite(observed) && expected[i] > 0 ? observed / expected[i] : Number.NaN
    }
    return out
  }
  return Float64Array.from(counts)
}

/** A mean put on the picture's scale; `NaN` where the scale has no value for it. */
function onScale(value: number, transform: InterArmReading['transform']): number {
  switch (transform) {
    case 'log2':
      return value > 0 ? Math.log2(value) : Number.NaN
    case 'log10':
      return value > 0 ? Math.log10(value) : Number.NaN
    case 'log1p':
      return value > -1 ? Math.log1p(value) : Number.NaN
    default:
      return Number.isFinite(value) ? value : Number.NaN
  }
}

export const runInterArm: TaskRunner = async (job) => {
  const { ids, missing } = tickedContigIds(job.mc, tickedSequences(job.params, 'sequences'))
  const said = missingSequencesNote(job.mc, missing, ids.length)
  if (said !== null) job.note(said)
  if (ids.length === 0) return []

  // The view's balancing, as the picture was read, rather than the file's
  // default the other tasks ask for: a raw map is measured raw.
  const balance = job.framing.balance
  const reading = interArmReading(job.params)
  // What *no alignment* reads as on this scale, where the reading has one: a
  // ratio of one. The counts have none (`interArmSummaryOf`).
  const neutral = reading.expected === 'none' ? null : onScale(1, reading.transform)
  // Along the arms the alignment is the expectation, and what is left is how
  // far each stretch departs from it — no enrichment to follow outwards. Walked
  // anyway, the reach was wherever the model's window runs out at the terminus,
  // and on *E. coli* that was the whole arm.
  const reaches = reading.expected !== 'arms'
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
    const drawn = asDrawn(values, n, frame, reading)
    const { byDistance, byBin } = interArmProfile(drawn, frame, band)

    for (let i = 0; i < n; i++) track[from + i] = onScale(byBin[i], reading.transform)
    const x = new Float64Array(byDistance.length)
    const y = new Float64Array(byDistance.length)
    for (let d = 0; d < byDistance.length; d++) {
      x[d] = d * binsize
      y[d] = onScale(byDistance[d], reading.transform)
    }
    const summary = interArmSummaryOf(y, neutral)
    series.push({ name, x, y })
    rows.push({
      sequence: name,
      topology: circular ? 'circular' : 'linear',
      origin: (declared ?? 0) + 1,
      score: summary.score,
      peak: summary.peak,
      reach: reaches && Number.isFinite(summary.reach) ? summary.reach * binsize : Number.NaN,
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
  const words = readingWords(reading)
  const scale = reading.transform === 'none' ? '' : reading.transform
  job.note(
    `Cells within ${band} ${band === 1 ? 'bin' : 'bins'} (${(band * binsize).toLocaleString()} bp) ` +
      `of the secondary diagonal, read as the map is drawn: ${balance ? 'balanced · ' : ''}${words}.` +
      (reading.expected === 'arms'
        ? ' Divided along both arms, the secondary diagonal is part of the expectation, so what is ' +
          'left is how far each stretch departs from its own arms’ alignment.'
        : ''),
  )
  const quantity = `${balance && reading.expected === 'none' ? 'balanced ' : ''}${readingQuantity(reading)}`
  const within = `±${band} ${band === 1 ? 'bin' : 'bins'}`

  const outputs: TaskOutput[] = [
    {
      kind: 'profile',
      id: 'interarm-enrichment',
      label: `${readingTitle(reading)} · ${within}`,
      values: track,
      extent: [0, job.mc.nBins],
      binsize,
      unit: scale,
      // A logarithm of contacts has no floor for an area to be filled from: the
      // lane's is zero, which is one contact or none at all once balanced, and
      // every value is under it — a solid block with the profile along its edge.
      ...(reading.expected === 'none' && (reading.transform === 'log2' || reading.transform === 'log10')
        ? { mode: 'line' as const }
        : {}),
    } satisfies ProfileOutput,
    {
      kind: 'curve',
      id: 'interarm-curve',
      label: 'Inter-arm alignment by distance from the origin',
      series,
      xLabel: 'Distance from the origin',
      yLabel: `Secondary diagonal, ${quantity}${scale === '' ? '' : ` (${scale})`}`,
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
          hint:
            `Mean of the secondary diagonal’s ${quantity}${scale === '' ? '' : `, ${scale}`}, over the arms` +
            (neutral === null
              ? '.'
              : `; ${neutral === 0 ? '0' : neutral.toFixed(3)} is ` +
                (reading.expected === 'arms' ? 'as aligned as the arms’ own model.' : 'no alignment.')),
        },
        {
          key: 'peak',
          label: 'peak',
          kind: 'number',
          digits: 3,
          hint: 'Its highest value, averaged over 2% of the arm.',
        },
        {
          key: 'reach',
          label: 'reach',
          kind: 'number',
          hint: !reaches
            ? 'Not given along the arms: their own alignment is the expectation, so none is left to follow outwards.'
            : neutral === null
              ? 'How far from the origin, in bp, the contacts hold before they fall half-way from their level there to their lowest.'
              : neutral === 0
                ? 'How far from the origin, in bp, the enrichment holds before it falls below half its peak.'
                : `How far from the origin, in bp, the enrichment holds before it falls half-way from ${neutral.toFixed(3)} to its peak.`,
        },
        { key: 'armLength', label: 'arm', kind: 'number', hint: 'Length of the longer arm, in bp.' },
      ],
      rows,
    } satisfies TableOutput,
  ]
  return outputs
}

/**
 * Diamond insulation, run.
 *
 * One dense square per sequence, one pass per scale, and a bin vector assembled
 * over the whole assembly so the result is a lane rather than a picture (§18.5).
 * The kernels are in `analysis/insulation.ts`; what is here is the plan, the
 * reads, and the two conversions that turn contig-local answers into
 * genome-wide objects.
 *
 * Both conversions are places to be careful. A score is computed in bins local
 * to a contig and has to land at `startBin + local` in a vector over every bin
 * in the file — off by the wrong offset and the track is a plausible picture of
 * the wrong chromosome. And a boundary is called at a bin and has to be written
 * as a *base-pair interval* clamped to the sequence, because it leaves as a BED
 * and a BED that runs past the end of a chromosome is one every tool downstream
 * will complain about, or worse, will not.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import {
  callBoundaries,
  diamondSums,
  insulationScore,
  type Boundary,
} from '../insulation'
import { boolParam, numParam, strParam, type JobContext, type TaskRunner } from '../job'
import { windowLadder } from '../tasks/insulation'
import type { ProfileOutput, TaskOutput } from '../types'
import {
  displayableContigs,
  spanOfContig,
  squareFor,
  usableBlock,
  type Span,
} from './blocks'

/** One sequence this run will score. */
interface Unit {
  name: string
  span: Span
  /** Base pairs of the sequence, for clamping the last interval of a BED. */
  length: number
}

/**
 * The sequences to score, and how long each one is.
 *
 * A region names a *sequence* and not a window of one, for the reason
 * `analysis/run/expected.ts` gives about P(s): insulation is computed against
 * the mean over a whole sequence, so a score taken from whatever happened to be
 * on screen but labelled `chrIV` is a different quantity wearing the same name.
 */
function planUnits(job: JobContext, region: string): Unit[] {
  const mc = job.mc
  const lengths = mc.chromsizes
  const unitFor = (cid: number): Unit | null => {
    const span = spanOfContig(mc, cid)
    if (span === null) return null
    const name = mc.chromnames[cid]
    return { name, span, length: lengths.get(name) ?? (span.to - span.from) * mc.binsize }
  }

  if (region !== '') {
    const unit = unitFor(mc.contigId(parseRegionString(region)[0]))
    return unit === null ? [] : [unit]
  }
  const out: Unit[] = []
  for (const cid of displayableContigs(mc)) {
    const unit = unitFor(cid)
    if (unit !== null) out.push(unit)
  }
  return out
}

export const runInsulation: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))
  const windows = windowLadder(job.params)
  const widest = windows[windows.length - 1]

  const units = planUnits(job, strParam(job.params, 'region', '').trim()).filter(
    // A sequence with no bin whose whole diamond fits produces a column of NaN
    // at full cost. Dropped here and counted, rather than read and thrown away.
    (unit) => unit.span.to - unit.span.from > widest * 2,
  )
  if (units.length === 0) {
    job.note(
      'No sequence in this file is long enough for a whole diamond of this width either side ' +
        'of any bin. Use a narrower window.',
    )
    return []
  }

  const nBins = job.mc.nBins
  // One vector per scale, over every bin in the file, gaps everywhere nothing is
  // scored — which is most of it when a region was named, and is correct: a
  // track that claims a value for a sequence this run never looked at is a track
  // that lies about its own coverage.
  const scores = windows.map(() => new Float32Array(nBins).fill(Number.NaN))
  const block = usableBlock(job, units.map((unit) => unit.span), balance)
  const calls: Array<{ unit: Unit; boundaries: Boundary[]; window: number }> = []

  const call = boolParam(job.params, 'call', true)
  const prominence = numParam(job.params, 'prominence', 0.2)
  // In bins, as the form now asks for it: a spacing between two calls on a
  // track whose x axis is bins was being typed in base pairs and divided here.
  const spacing = Math.max(1, Math.round(numParam(job.params, 'spacing', 0)))

  for (let u = 0; u < units.length; u++) {
    job.throwIfCancelled()
    job.progress(u, units.length, units[u].name)
    const unit = units[u]
    const square = await squareFor(job, unit.span, { block, balance, value })
    const size = unit.span.to - unit.span.from

    for (let w = 0; w < windows.length; w++) {
      const sums = diamondSums(
        { size, values: square.values },
        { window: windows[w], minValid },
      )
      const score = insulationScore(sums)
      for (let local = 0; local < size; local++) {
        scores[w][unit.span.from + local] = score[local]
      }
      // Called from the *base* scale only. Boundaries at four widths are four
      // overlapping sets of the same features at different smoothings, and
      // merging them is a decision this task has no basis for making; the reader
      // who wants the wider set runs it again with that width as the base.
      if (call && w === 0) {
        calls.push({ unit, boundaries: callBoundaries(score, { prominence, spacing }), window: windows[w] })
      }
    }
  }
  job.progress(units.length, units.length, 'Done')

  const outputs: TaskOutput[] = windows.map((window, index) =>
    profileFor(job, scores[index], window),
  )

  if (call) {
    const total = calls.reduce((sum, entry) => sum + entry.boundaries.length, 0)
    if (total === 0) {
      job.note(
        `No minimum was prominent enough to call at a threshold of ${prominence}. ` +
          'Lower it, or widen the window.',
      )
    } else {
      outputs.push(boundaryOutput(job, calls))
      job.note(`${total.toLocaleString()} boundaries called across ${calls.length} sequences.`)
    }
  }
  return outputs
}

function profileFor(job: JobContext, values: Float32Array, window: number): ProfileOutput {
  const bp = window * job.mc.binsize
  return {
    kind: 'profile',
    id: `insulation-w${window}`,
    label: `Insulation · ${formatBp(bp)}`,
    values,
    extent: [0, job.mc.nBins],
    binsize: job.mc.binsize,
    // log2 of a ratio against the sequence mean, so zero is average and the
    // sign is the whole reading. Named rather than left blank, because a lane
    // whose axis runs −2 to 2 with no unit invites being read as a count.
    unit: 'log2 ratio',
  }
}

/**
 * The calls, as a `FeatureSet` the Annotations panel can draw.
 *
 * Each boundary is one bin wide — it is a position, and the bin is the finest
 * this file can place one at — clamped to the sequence so the last bin of a
 * contig does not produce an interval past its end. The prominence goes in the
 * score column, so the overlay can be filtered on it and a downstream BED keeps
 * the number the call was made on.
 */
function boundaryOutput(
  job: JobContext,
  calls: ReadonlyArray<{ unit: Unit; boundaries: Boundary[]; window: number }>,
): TaskOutput {
  const builder = new FeatureBuilder()
  for (const { unit, boundaries } of calls) {
    for (const boundary of boundaries) {
      const start = boundary.bin * job.mc.binsize
      builder.add(unit.name, start, Math.min(unit.length, start + job.mc.binsize), {
        score: boundary.prominence,
        name: '',
        detail: `insulation ${boundary.score.toFixed(3)} · prominence ${boundary.prominence.toFixed(3)}`,
      })
    }
  }
  return {
    kind: 'intervals',
    id: 'insulation-boundaries',
    label: 'Insulation boundaries',
    payload: { kind: 'features', data: builder.finish() },
  }
}

/** `10 kb`, for a lane label. Small enough not to be worth `format.ts`. */
function formatBp(bp: number): string {
  if (bp >= 1e6) return `${trim(bp / 1e6)} Mb`
  if (bp >= 1e3) return `${trim(bp / 1e3)} kb`
  return `${Math.round(bp)} bp`
}

function trim(value: number): string {
  return String(Number(value.toFixed(2)))
}

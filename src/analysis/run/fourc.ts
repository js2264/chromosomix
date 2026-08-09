/**
 * The 4C task, run.
 *
 * Two paths, and the difference between them is the whole design of the task
 * (`analysis/tasks/fourc.ts`). The cis path shares `bandSums` with
 * `render/viewpoint.ts` — the *same function* the lane on the map uses, imported
 * rather than reimplemented, so the exported bigWig and the strip above the
 * picture cannot disagree about what a band sum is. The trans path cannot: there
 * is no dense block over a whole metagenome to take a band out of, so it walks
 * the pixels.
 *
 * **The walk stops early, and that is the point.** Pixels are ordered by
 * `bin1`, and every pixel this profile needs has `bin1 < anchorEnd` — either
 * because `bin1` is inside the anchor, or because `bin1` is before it and `bin2`
 * lands in it. Past that point nothing can contribute, so `onChunk` returns
 * `false` and the read ends there: on average half the file rather than all of
 * it, which is exactly what §18.6 prices.
 */


import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseMetacoolerRange } from '../../metacooler/range'
import { boolParam, strParam, type JobContext, type TaskRunner } from '../job'
import type { ProfileOutput, TaskOutput } from '../types'
import { bandSums, ViewpointAccumulator } from '../viewpoint'
import { squareFor, usableBlock, validBins, type Span } from './blocks'

/** The anchor, resolved to absolute bins, and the scope "cis" means for it. */
interface Anchor {
  band: Span
  /** The sequence — or the whole MAG — a cis-only run stays inside. */
  scope: Span
  label: string
}

/**
 * The anchor, and what *cis* means around it.
 *
 * A locus names a contig, so cis is that contig. A **genome** may also be named,
 * and then cis is the whole MAG rather than whichever of its contigs the first
 * bin happens to fall in — on a metagenome the second reading would silently
 * answer a question about one contig of an organism when the reader asked about
 * the organism, which is the distinction §3.2 exists to make.
 */
function resolveAnchor(job: JobContext, text: string): Anchor {
  const mc = job.mc
  const parsed = parseMetacoolerRange(mc, text)
  const band: Span = {
    from: parsed.extent[0],
    to: Math.max(parsed.extent[0] + 1, parsed.extent[1]),
  }
  if (parsed.kind === 'genome') {
    const [from, to] = mc.genomeExtent(parsed.label)
    return { band, scope: { from, to }, label: parsed.label }
  }
  const cid = mc.coords.contigOfBin(band.from)
  const [from, to] = mc.contigExtent(cid)
  return { band, scope: { from, to }, label: mc.chromnames[cid] }
}

export const runFourC: TaskRunner = async (job) => {
  const text = strParam(job.params, 'anchor', '').trim()
  if (text === '') {
    job.note(
      'No anchor was chosen. Type a locus — `chrIV:500,000-510,000`, or a whole sequence by ' +
        'name — or press “Pick on map” and Shift-drag along either axis.',
    )
    return []
  }
  const balance = boolParam(job.params, 'balance', false)
  const cis = boolParam(job.params, 'cis', true)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const anchor = resolveAnchor(job, text)

  const values = cis
    ? await cisProfile(job, anchor, balance, value)
    : await transProfile(job, anchor, balance)

  const profile: ProfileOutput = {
    kind: 'profile',
    id: `fourc-${anchor.band.from}-${anchor.band.to}`,
    label: `4C · ${text}${cis ? '' : ' (with trans)'}`,
    values,
    extent: [0, job.mc.nBins],
    binsize: job.mc.binsize,
    unit: 'contacts',
  }
  const outputs: TaskOutput[] = [profile]
  return outputs
}

/**
 * The anchor's own sequence, from one square.
 *
 * `bandSums` takes the anchor as **block-local** indices on the axis the band is
 * taken over, which is what the lane hands it too; converting once here is what
 * keeps that function free of any idea where the block came from.
 */
async function cisProfile(
  job: JobContext,
  anchor: Anchor,
  balance: boolean,
  value: string,
): Promise<Float32Array> {
  job.progress(0, 1, `Reading ${anchor.label}`)
  const block = usableBlock(job, [anchor.scope], balance)
  const square = await squareFor(job, anchor.scope, { block, balance, value })
  job.throwIfCancelled()

  const local: [number, number] = [
    Math.max(0, anchor.band.from - anchor.scope.from),
    Math.min(anchor.scope.to - anchor.scope.from, anchor.band.to - anchor.scope.from),
  ]
  const sums = bandSums(
    {
      nrows: square.nrows,
      ncols: square.ncols,
      values: square.values,
      rowExtent: [square.rowExtent[0], square.rowExtent[1]],
      colExtent: [square.colExtent[0], square.colExtent[1]],
    },
    local,
    'cols',
  )

  // Over the whole assembly, with everything outside this sequence left as a
  // gap. Not zero: a cis-only run has said nothing at all about the other
  // sequences, and a track claiming zero contact there would be a claim it did
  // not make.
  const out = new Float32Array(job.mc.nBins).fill(Number.NaN)
  for (let i = 0; i < sums.length; i++) out[anchor.scope.from + i] = sums[i]
  return out
}

/**
 * Every contact the anchor makes, wherever it lands.
 *
 * One accumulator over every bin in the file, fed from a partial pass. A pixel
 * contributes when either of its ends is inside the anchor, and the *other* end
 * is the bin that receives it — which for a pixel with both ends inside the
 * anchor means it contributes to both, exactly as the dense band sum would count
 * it twice on a mirrored square.
 */
async function transProfile(
  job: JobContext,
  anchor: Anchor,
  balance: boolean,
): Promise<Float32Array> {
  const mc = job.mc
  const weights = validBins(mc, balance)
  if (job.framing.value !== '' && job.framing.value !== DEFAULT_COUNT_COLUMN) {
    job.note(
      `The map is drawn from the ${job.framing.value} column, but a whole-file pass reads ` +
        `${DEFAULT_COUNT_COLUMN}. This profile is of the counts.`,
    )
  }

  const accumulator = new ViewpointAccumulator(mc.nBins, anchor.band)
  let stopped = false

  await mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      for (let i = 0; i < chunk.length; i++) {
        const bin1 = chunk.bin1[i]
        if (!accumulator.reachable(bin1)) {
          stopped = true
          return false
        }
        const bin2 = chunk.bin2[i]
        const raw = chunk.count[i]
        accumulator.add(bin1, bin2, weights === null ? raw : raw * weights[bin1] * weights[bin2])
      }
      return true
    },
    onProgress: (done, total) => {
      if (!stopped) job.progress(done, total, 'Reading pixels')
    },
  })
  job.throwIfCancelled()
  job.progress(1, 1, 'Done')

  return accumulator.finish(weights === null ? null : (bin) => Number.isFinite(weights[bin]))
}

/**
 * Coverage and marginals, run.
 *
 * Either one pass over a whole-file block, or one pass over the pixel table —
 * and the accumulator in `analysis/coverage.ts` is fed identically by both,
 * which is what makes the two paths give the same answer rather than two answers
 * that are usually close.
 *
 * The scan reads `pixels/count` and nothing else, which is a real limitation
 * rather than an oversight: `MetaCooler.scanPixels` is the whole-file walk and
 * it is written against the one column every cooler has. A run on a file whose
 * map is drawn from a different score column says so instead of quietly
 * measuring something the reader did not ask about.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { binContigMap, CoverageAccumulator } from '../coverage'
import { boolParam, type TaskRunner } from '../job'
import { wantedTracks } from '../tasks/coverage'
import type { ProfileOutput, TaskOutput } from '../types'
import { validBins } from './blocks'

/** How the four vectors are labelled and coloured, in the order they are drawn. */
const TRACKS = {
  total: { label: 'Coverage · total', unit: 'contacts' },
  cis: { label: 'Coverage · cis', unit: 'contacts' },
  trans: { label: 'Coverage · trans', unit: 'contacts' },
  fraction: { label: 'Cis fraction', unit: '' },
} as const

export const runCoverage: TaskRunner = async (job) => {
  const wanted = wantedTracks(job.params)
  if (wanted.length === 0) {
    job.note('Every output was turned off, so there is nothing to compute.')
    return []
  }

  const balance = boolParam(job.params, 'balance', false)
  const mc = job.mc
  const contigs: Array<{ startBin: number; bins: number }> = []
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    contigs.push({ startBin: from, bins: Math.max(0, to - from) })
  }
  // Read before the accumulator is built, because *which bins were excluded* is
  // the one thing it cannot work out for itself: an absent pixel is a measured
  // zero, and only a dropped weight is a genuine gap.
  const weights = validBins(mc, balance)
  const accumulator = new CoverageAccumulator(
    mc.nBins,
    binContigMap(contigs, mc.nBins),
    weights === null ? null : (bin) => Number.isFinite(weights[bin]),
  )

  const block = job.inputs.block
  const wholeFileBlock =
    block !== undefined &&
    block.binsPerCell === 1 &&
    job.framing.balance === balance &&
    block.rowExtent[0] === 0 &&
    block.rowExtent[1] === mc.nBins &&
    block.colExtent[0] === 0 &&
    block.colExtent[1] === mc.nBins

  if (wholeFileBlock && block !== undefined) {
    job.progress(0, 1, 'summing the block on screen')
    accumulator.addBlock(block)
  } else {
    if (job.framing.value !== '' && job.framing.value !== DEFAULT_COUNT_COLUMN) {
      job.note(
        `The map is drawn from the ${job.framing.value} column, but a whole-file pass reads ` +
          `${DEFAULT_COUNT_COLUMN}. These marginals are of the counts.`,
      )
    }
    job.progress(0, 1, 'reading pixels')
    await mc.scanPixels({
      onChunk: (chunk) => {
        job.throwIfCancelled()
        for (let i = 0; i < chunk.length; i++) {
          const bin1 = chunk.bin1[i]
          const bin2 = chunk.bin2[i]
          const raw = chunk.count[i]
          // A balanced cell is `raw * w[i] * w[j]`, cooler's own definition
          // (§6.4). A `NaN` weight marks a bin the balancer dropped and the
          // product is `NaN`, which the accumulator skips — so a filtered bin
          // reads as absent rather than as empty, which is the opposite claim.
          accumulator.add(bin1, bin2, weights === null ? raw : raw * weights[bin1] * weights[bin2])
        }
      },
      onProgress: (done, total) => job.progress(done, total, 'reading pixels'),
    })
  }
  job.throwIfCancelled()

  const finished = accumulator.finish()
  const source: Record<string, Float64Array> = {
    total: finished.total,
    cis: finished.cis,
    trans: finished.trans,
    fraction: finished.cisFraction,
  }

  return wanted.map((which): TaskOutput => {
    const meta = TRACKS[which]
    const profile: ProfileOutput = {
      kind: 'profile',
      id: `coverage-${which}`,
      label: meta.label,
      // Narrowed to float32 here and not in the accumulator: the *sums* need
      // float64 to be right, the *track* does not, and a lane is drawn from
      // float32 everywhere else in this app.
      values: Float32Array.from(source[which]),
      extent: [0, mc.nBins],
      binsize: mc.binsize,
      unit: meta.unit,
    }
    return profile
  })
}

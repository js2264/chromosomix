/**
 * The directionality index, run.
 *
 * One band per sequence, one pass, one lane. The shape is insulation's without
 * the tiling dance: the diamond wants a *square* because its kernel is goldened
 * against cooltools cell for cell, and this kernel wants a band, so the sequence
 * is read as a band and nothing is stitched. What is left to be careful about is
 * the same two conversions insulation warns about — a score computed in bins
 * local to a contig has to land at `startBin + local` in a vector over the whole
 * file, and a window in base pairs has to become a window in bins exactly once.
 *
 * The wrap is not here. A circular sequence is read with a circular band and
 * scored by the same kernel, and the only line in this file that knows about it
 * is the one that passes the flag; see `analysis/band.ts` for why that is the
 * whole of the mechanism.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import { directionalityIndex } from '../di'
import {
  boolParam,
  contigIdFor,
  numParam,
  readsAsCircular,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { windowBinsAt, windowBpOf } from '../tasks/di'
import type { ProfileOutput, TaskOutput } from '../types'
import { bandFor, displayableContigs, spanOfContig, usableBlock, type Span } from './blocks'
import { formatBp } from './labels'

/** One sequence this run will score. */
interface Unit {
  name: string
  span: Span
  circular: boolean
}

/**
 * The sequences to score.
 *
 * A region names a *sequence* and not a window of one, for the reason
 * `run/insulation.ts` gives: the index is a sum over a window that reaches
 * outside whatever happened to be on screen, so a score taken from a sub-window
 * and labelled `chrIV` is a different quantity wearing the same name.
 */
function planUnits(job: JobContext, region: string): Unit[] {
  const mc = job.mc
  const unitFor = (cid: number): Unit | null => {
    const span = spanOfContig(mc, cid)
    if (span === null) return null
    const name = mc.chromnames[cid]
    return { name, span, circular: readsAsCircular(job, name) }
  }
  if (region !== '') {
    const cid = contigIdFor(mc, parseRegionString(region)[0])
    const unit = cid < 0 ? null : unitFor(cid)
    return unit === null ? [] : [unit]
  }
  const out: Unit[] = []
  for (const cid of displayableContigs(mc)) {
    const unit = unitFor(cid)
    if (unit !== null) out.push(unit)
  }
  return out
}

export const runDi: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))
  const ignoreDiags = Math.max(0, Math.round(numParam(job.params, 'ignoreDiags', 0)))
  const windowBp = windowBpOf(job.params)
  const window = windowBinsAt(job.params, job.mc.binsize)

  // A window that rounds to a handful of bins is a window worth knowing about:
  // the statistic is a χ² over the cells in it, and a χ² over three cells is
  // noise with a sign. Said once, at the top, rather than left to be inferred
  // from a jagged track.
  if (window < 5) {
    job.note(
      `A ${windowBp.toLocaleString()} bp window is ${window} ${window === 1 ? 'bin' : 'bins'} at ` +
        `this file’s ${job.mc.binsize.toLocaleString()} bp resolution, so each side of the ` +
        'statistic is a sum over very few cells. Widen the window, or open a finer rung.',
    )
  }

  const region = strParam(job.params, 'region', '').trim()
  const planned = planUnits(job, region)
  if (region !== '' && planned.length === 0) {
    job.note(
      `This file has no sequence called ${parseRegionString(region)[0]}, under that spelling or ` +
        `any this viewer knows of (§5.9). It has ` +
        `${job.mc.chromnames.slice(0, 6).join(', ')}${job.mc.chromnames.length > 6 ? ', …' : ''}.`,
    )
    return []
  }

  // Twice the window, on a line and on a circle alike. A linear sequence needs a
  // whole window each side of at least one bin; a circular one needs the two
  // sides not to be the same cells read twice, which is the same length — past
  // half the circle the short way round is the other way. One predicate, and the
  // reason it is one is worth the sentence.
  const units = planned.filter((unit) => unit.span.to - unit.span.from > window * 2)
  if (units.length === 0) {
    job.note(
      `No sequence in this file is longer than twice a ${windowBp.toLocaleString()} bp window, ` +
        'so no bin on any of them has a whole window either side. Use a narrower window.',
    )
    return []
  }

  const nBins = job.mc.nBins
  // Over every bin in the file, gaps everywhere nothing was scored — which is
  // most of it when a region was named, and is correct: a track that claims a
  // value for a sequence this run never looked at is a track that lies about its
  // own coverage.
  const scores = new Float32Array(nBins).fill(Number.NaN)
  const block = usableBlock(
    job,
    units.map((unit) => unit.span),
    balance,
  )

  let circularUnits = 0
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]
    await job.breathe()
    job.progress(u, units.length, unit.name)
    if (unit.circular) circularUnits++

    const band = await bandFor(job, unit.span, {
      hi: window,
      block,
      balance,
      value,
      circular: unit.circular,
      onTile: async (done, total) => {
        await job.breathe()
        job.progress(
          u,
          units.length,
          total === 1 ? unit.name : `${unit.name} · strip ${Math.min(done + 1, total)} of ${total}`,
        )
      },
    })
    const local = directionalityIndex(band, { window, minValid, ignoreDiags })
    for (let i = 0; i < local.length; i++) scores[unit.span.from + i] = local[i]
  }
  job.progress(units.length, units.length, 'Done')

  if (circularUnits > 0) {
    job.note(
      `${circularUnits.toLocaleString()} of ${units.length.toLocaleString()} ` +
        `${units.length === 1 ? 'sequence was' : 'sequences were'} read as circular, so the ` +
        'window wraps past the end and every bin is scored.',
    )
  }

  const profile: ProfileOutput = {
    kind: 'profile',
    id: `di-${windowBp}`,
    label: `DI · ${formatBp(windowBp)}`,
    values: scores,
    extent: [0, nBins],
    binsize: job.mc.binsize,
    // A signed χ², which has no unit and is not a count. Named rather than left
    // blank for the reason insulation's is: a lane running −400 to 400 with no
    // unit invites being read as contacts.
    unit: 'signed χ²',
  }
  const outputs: TaskOutput[] = [profile]
  return outputs
}

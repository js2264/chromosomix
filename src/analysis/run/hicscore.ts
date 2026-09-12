/**
 * The HiC score, run.
 *
 * The same plan as the directionality index beside it — a band per sequence, one
 * kernel, one lane — with one number different: the band is read **twice as
 * deep** as the window reaches, because the corners of a square `h` bins each
 * way from the diagonal are `2h` apart. A band read to `h` would leave those
 * corners unread, the kernel would count them as missing, and the score would
 * come back systematically low in a way no amount of staring at the track would
 * reveal.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import { hicScore } from '../hicscore'
import {
  boolParam,
  contigIdFor,
  numParam,
  readsAsCircular,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { halfWidthAt, windowBpOf } from '../tasks/hicscore'
import type { ProfileOutput, TaskOutput } from '../types'
import { bandFor, displayableContigs, spanOfContig, usableBlock, type Span } from './blocks'
import { formatBp } from './labels'

interface Unit {
  name: string
  span: Span
  circular: boolean
}

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

export const runHicScore: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))
  const ignoreDiags = Math.max(0, Math.round(numParam(job.params, 'ignoreDiags', 0)))
  const windowBp = windowBpOf(job.params)
  const half = halfWidthAt(job.params, job.mc.binsize)
  const depth = half * 2

  // The floor in `halfWidthAt` has bitten: the window asked for is narrower than
  // the three bins a square can be. Said rather than silently widened, because
  // the label on the lane will say the window the reader typed.
  if (windowBp < job.mc.binsize * 2) {
    job.note(
      `A ${windowBp.toLocaleString()} bp window is narrower than two of this file’s ` +
        `${job.mc.binsize.toLocaleString()} bp bins, so the square has been widened to the ` +
        'three bins that are the smallest one there is. Open a finer rung to ask for less.',
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

  const units = planned.filter((unit) => unit.span.to - unit.span.from > depth)
  if (units.length === 0) {
    job.note(
      `No sequence in this file is longer than a ${windowBp.toLocaleString()} bp window, so no ` +
        'bin on any of them has a whole square around it. Use a narrower window.',
    )
    return []
  }

  const nBins = job.mc.nBins
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
      hi: depth,
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
    const local = hicScore(band, { halfWidth: half, minValid, ignoreDiags })
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
    id: `hicscore-${windowBp}`,
    label: `HiC score · ${formatBp(windowBp)}`,
    values: scores,
    extent: [0, nBins],
    binsize: job.mc.binsize,
    // A sum of cells, so it carries the same unit the cells do — counts on a raw
    // map, and a balanced map's own dimensionless numbers where the run was
    // balanced. `contacts` is what every other summed track in the catalogue
    // says and what the axis should be read as.
    unit: 'contacts',
  }
  const outputs: TaskOutput[] = [profile]
  return outputs
}

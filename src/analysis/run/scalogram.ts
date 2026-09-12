/**
 * The scalogram, run.
 *
 * A band per sequence and one lane per quantile, grouped so they share an axis
 * and nest into a single picture. The two things worth being careful about are
 * the same two every banded runner has — the local-to-absolute bin conversion,
 * and reading the reach exactly once — plus a third that is this task's own:
 * **the quantiles come out of the kernel as separations in bins and leave as
 * separations in base pairs**, because a lane's axis is labelled in the units
 * the file is addressed in and a track holding bins would be a track nobody can
 * compare against anything.
 *
 * ## Why the bands are emitted innermost-first
 *
 * A ribbon fills down to the member below it in the lane (§8.17), so the order
 * the outputs are produced in is the order the bands nest in. Ascending
 * quantile: the tenth centile first, with only the lane's floor beneath it, then
 * each band resting on the one before. Emitting them the other way round would
 * draw the same five curves with every band filled to the wrong neighbour — a
 * picture that is not obviously wrong, which is the worst kind.
 *
 * That is also the opposite of what `run/insulation.ts` does with its scales,
 * and deliberately: those are *independent* readings stacked for comparison, so
 * the widest goes on top by convention. These are the edges of one shape.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import { scalogram, type ScalogramTrack } from '../scalogram'
import {
  boolParam,
  contigIdFor,
  numParam,
  readsAsCircular,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { quantilesOf, reachBinsFor, reachBpOf } from '../tasks/scalogram'
import type { ProfileOutput, TaskOutput } from '../types'
import { bandFor, displayableContigs, spanOfContig, usableBlock, type Span } from './blocks'
import { formatBp } from './labels'

interface Unit {
  name: string
  span: Span
  circular: boolean
}

/**
 * What the bands are grouped under.
 *
 * A name rather than an id, for the reason `run/insulation.ts` gives about its
 * own: it is shown to the reader and they can change it, and from the moment the
 * rows exist it is an ordinary group.
 */
const SCALOGRAM_GROUP = 'Scalogram'

/**
 * The ribbon colours, dark at the centre and pale at the edges.
 *
 * A sequential ramp rather than a categorical palette, because the bands are an
 * *ordered* set and a rainbow would invite reading the 25 % band as a different
 * kind of thing from the 75 % one. Dark innermost is the way round the picture
 * wants: the nearest contacts are the bulk of them, so a dark core with a pale
 * halo reads as *most of what this bin touches is here, and a tail reaches out
 * to there* — which is the sentence the figure is for.
 *
 * Interpolated between two ends rather than listed, so the nine-band set is the
 * same ramp at a finer step and not a second palette that has to be kept in
 * agreement with the first.
 */
function ribbonColours(count: number): string[] {
  // ColorBrewer Blues, the dark and light ends of it.
  const dark: [number, number, number] = [8, 48, 107]
  const light: [number, number, number] = [198, 219, 239]
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1)
    const channel = (a: number, b: number): number => Math.round(a + (b - a) * t)
    const [r, g, b] = [channel(dark[0], light[0]), channel(dark[1], light[1]), channel(dark[2], light[2])]
    out.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
  }
  return out
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

export const runScalogram: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))
  const ignoreDiags = Math.max(0, Math.round(numParam(job.params, 'ignoreDiags', 1)))
  const quantiles = quantilesOf(job.params)
  const reachBp = reachBpOf(job.params)

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

  // A sequence of one or two bins has no separation to distribute anything over.
  // Dropped rather than read, and counted, so a metagenome of short contigs says
  // how much of itself it could not answer for.
  const units = planned.filter((unit) => unit.span.to - unit.span.from >= 4)
  const skipped = planned.length - units.length
  if (units.length === 0) {
    job.note('No sequence in this file is long enough to have a distribution of separations.')
    return []
  }
  if (skipped > 0) {
    job.note(
      `${skipped.toLocaleString()} ${skipped === 1 ? 'sequence is' : 'sequences are'} shorter ` +
        'than four bins and were left out: there is no distribution of separations on them.',
    )
  }

  const nBins = job.mc.nBins
  // One vector per quantile over every bin in the file, gaps everywhere nothing
  // was scored. In **base pairs**, which is what the lane's axis is in.
  const distances = quantiles.map(() => new Float32Array(nBins).fill(Number.NaN))
  const block = usableBlock(
    job,
    units.map((unit) => unit.span),
    balance,
  )

  let circularUnits = 0
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]
    const bins = unit.span.to - unit.span.from
    const depth = reachBinsFor(job.params, job.mc.binsize, bins, unit.circular)
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
    const tracks: ScalogramTrack[] = scalogram(band, {
      quantiles,
      maxDistance: depth,
      ignoreDiags,
      minValid,
    })
    for (let q = 0; q < tracks.length; q++) {
      const local = tracks[q].distance
      const target = distances[q]
      for (let i = 0; i < local.length; i++) {
        // Bins out, base pairs in. `NaN` stays `NaN`: a multiplication would
        // keep it anyway, and saying so here is what stops a later reader
        // wondering whether a gap survived the conversion.
        target[unit.span.from + i] = local[i] * job.mc.binsize
      }
    }
  }
  job.progress(units.length, units.length, 'Done')

  if (circularUnits > 0) {
    job.note(
      `${circularUnits.toLocaleString()} of ${units.length.toLocaleString()} ` +
        `${units.length === 1 ? 'sequence was' : 'sequences were'} read as circular, so a ` +
        'separation is the shorter of the two ways round and reaches at most half the sequence.',
    )
  }

  const colours = ribbonColours(quantiles.length)
  const cut = reachBp === 0 ? '' : ` · within ${formatBp(reachBp)}`
  const outputs: TaskOutput[] = quantiles.map((quantile, index) => {
    const profile: ProfileOutput = {
      kind: 'profile',
      id: `scalogram-q${Math.round(quantile * 100)}${reachBp === 0 ? '' : `-${reachBp}`}`,
      // The cut is on **every** band, not on the group, because a lane can be
      // dragged out of its group and has to go on saying what it is.
      label: `Scalogram ${Math.round(quantile * 100)} %${cut}`,
      values: distances[index],
      extent: [0, nBins],
      binsize: job.mc.binsize,
      unit: 'bp',
      colour: colours[index],
      group: SCALOGRAM_GROUP,
      mode: 'ribbon',
      // One lane, shared axis: the bands are the edges of one shape and a group
      // that stacked them would draw five separate pictures of five quantiles.
      groupMode: 'overlay',
      // A separation runs from one bin to a whole chromosome, so a linear axis
      // spends the lane on whichever bin reached furthest. See
      // `ProfileOutput.scale`.
      scale: 'log2',
    }
    return profile
  })
  return outputs
}

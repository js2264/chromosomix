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
 * The calls are the diamond's, and deliberately so: the borders come out of
 * `directionBorders`, which integrates the index and hands the curve to the very
 * kernel `run/insulation.ts` calls its minima with, and the domains come out of
 * the same `domainsBetween`. So the two tasks' overlays are the same kind of
 * object, filter on the same column and tile the same way, and the one thing
 * that differs between them is the reading underneath — which is the thing a
 * reader is comparing.
 *
 * The wrap is not here. A circular sequence is read with a circular band and
 * scored by the same kernel, and the only line in this file that knows about it
 * is the one that passes the flag; see `analysis/band.ts` for why that is the
 * whole of the mechanism. What does *not* wrap is the call: the borders of a
 * circular sequence are called along it as though it were a line, so the domain
 * spanning the junction is the one domain never reported. That is the diamond's
 * behaviour too (SPECS §8.15), and saying it here is cheaper than a reader
 * discovering it from a gap in an overlay.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import { directionBorders, directionalityIndex } from '../di'
import { domainsBetween, type Boundary } from '../insulation'
import {
  boolParam,
  contigIdFor,
  numParam,
  readsAsCircular,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { windowBinsOf } from '../tasks/di'
import type { IntervalsOutput, ProfileOutput, TaskOutput } from '../types'
import { bandFor, displayableContigs, spanOfContig, usableBlock, type Span } from './blocks'
import { formatBp } from './labels'

/** One sequence this run will score. */
interface Unit {
  name: string
  span: Span
  /** Base pairs of the sequence, for clamping the last interval of a BED. */
  length: number
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
  const lengths = mc.chromsizes
  const unitFor = (cid: number): Unit | null => {
    const span = spanOfContig(mc, cid)
    if (span === null) return null
    const name = mc.chromnames[cid]
    return {
      name,
      span,
      length: lengths.get(name) ?? (span.to - span.from) * mc.binsize,
      circular: readsAsCircular(job, name),
    }
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
  const window = windowBinsOf(job.params)
  const windowBp = window * job.mc.binsize
  const call = boolParam(job.params, 'call', true)
  const prominence = Math.max(0, numParam(job.params, 'prominence', 10))
  const spacing = Math.max(0, Math.round(numParam(job.params, 'spacing', 0)))

  // What the window came to in base pairs on *this* file. The form asks in bins
  // so the two near-diagonal tasks can be set to the same scale, and the cost of
  // that is the number a reader carries between papers — Dixon's 2 Mb — no longer
  // being on screen. It is one line to put it back.
  job.note(
    `A ${window.toLocaleString()}-bin window is ${formatBp(windowBp)} at this file’s ` +
      `${job.mc.binsize.toLocaleString()} bp resolution.`,
  )

  // A window of a handful of bins is a window worth knowing about: the statistic
  // is a χ² over the cells in it, and a χ² over three cells is noise with a sign.
  if (window < 5) {
    job.note(
      `Each side of the statistic is then a sum over ${window} ` +
        `${window === 1 ? 'cell' : 'cells'} per row. Widen the window, or open a finer rung.`,
    )
  }

  const region = strParam(job.params, 'region', '').trim()
  const planned = planUnits(job, region)
  if (region !== '' && planned.length === 0) {
    job.note(
      `This file has no sequence called ${parseRegionString(region)[0]}, under that spelling or ` +
        `any this viewer knows of. It has ` +
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
      `No sequence in this file is longer than twice a ${window.toLocaleString()}-bin window, ` +
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
  const calls: Array<{ unit: Unit; borders: Boundary[] }> = []
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
    // Called on the sequence's own bins, before they are scattered into the
    // genome-wide vector — which is the same care `run/insulation.ts` takes and
    // for the same reason: a border is a local minimum of a curve, and a curve
    // assembled from every sequence in the file has a discontinuity at each join
    // that is not a domain edge.
    if (call) calls.push({ unit, borders: directionBorders(local, { prominence, spacing }) })
  }
  job.progress(units.length, units.length, 'done')

  if (circularUnits > 0) {
    job.note(
      `${circularUnits.toLocaleString()} of ${units.length.toLocaleString()} ` +
        `${units.length === 1 ? 'sequence was' : 'sequences were'} read as circular, so the ` +
        'window wraps past the end and every bin is scored.',
    )
  }

  const profile: ProfileOutput = {
    kind: 'profile',
    id: `di-w${window}`,
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
  if (!call) return outputs

  const total = calls.reduce((sum, entry) => sum + entry.borders.length, 0)
  if (total === 0) {
    job.note(
      `No sign flip carried ${prominence} bins of steady bias on both sides, so no border was ` +
        'called. Lower the prominence, or widen the window.',
    )
    return outputs
  }

  outputs.push(borderOutput(job, calls))
  job.note(
    `${total.toLocaleString()} borders called across ${calls.length.toLocaleString()} sequences.`,
  )
  if (boolParam(job.params, 'domains', true)) {
    const domains = domainOutput(job, calls)
    if (domains === null) {
      job.note(
        'No sequence had two borders, so no domain has both of its edges and none was made.',
      )
    } else {
      outputs.push(domains.output)
      job.note(
        `${domains.count.toLocaleString()} domains between them, from each border to the next.`,
      )
    }
  }
  return outputs
}

/**
 * The borders, as a `FeatureSet` the Annotations panel can draw.
 *
 * One bin wide, because a border is a position and the bin is the finest this
 * file can place one at, and clamped to the sequence so the last one does not
 * produce an interval past its end. The prominence goes in the score column so
 * the overlay can be filtered on it and a BED written from it keeps the number
 * the call was made on — the same layout the diamond's boundaries use, so the
 * two sets can be loaded side by side and sorted together.
 */
function borderOutput(
  job: JobContext,
  calls: ReadonlyArray<{ unit: Unit; borders: Boundary[] }>,
): IntervalsOutput {
  const builder = new FeatureBuilder()
  for (const { unit, borders } of calls) {
    for (const border of borders) {
      const start = border.bin * job.mc.binsize
      // The index at the border bin, where there is one. A border called from a
      // trough whose next bin the index left as a gap is still a border — the
      // curve either side is what called it — so the detail says so rather than
      // printing `NaN` at a reader.
      const at = Number.isFinite(border.score) ? `DI ${border.score.toFixed(1)}` : 'DI not scored'
      builder.add(unit.name, start, Math.min(unit.length, start + job.mc.binsize), {
        score: border.prominence,
        name: '',
        detail: `${at} · prominence ${border.prominence.toFixed(1)} bins`,
      })
    }
  }
  return {
    kind: 'intervals',
    id: 'di-borders',
    label: 'DI borders',
    payload: { kind: 'features', data: builder.finish() },
    noun: { one: 'border', many: 'borders' },
  }
}

/**
 * The spans between the borders — the domains.
 *
 * Per sequence, because *consecutive* is a property of one: the last border on
 * `chr1` and the first on `chr2` are neighbours in any sorted list and are not
 * two ends of anything. Consecutive domains tile, so the lane reads as a
 * segmentation rather than a row of boxes, and `null` where there is nothing to
 * report so the caller can say why instead of adopting an empty overlay.
 */
function domainOutput(
  job: JobContext,
  calls: ReadonlyArray<{ unit: Unit; borders: Boundary[] }>,
): { output: IntervalsOutput; count: number } | null {
  const builder = new FeatureBuilder()
  let count = 0
  for (const { unit, borders } of calls) {
    for (const domain of domainsBetween(borders)) {
      const start = domain.from * job.mc.binsize
      const end = Math.min(unit.length, domain.to * job.mc.binsize)
      if (end <= start) continue
      count++
      builder.add(unit.name, start, end, {
        // The weaker of the two edges, so a reader ranking the set is ranking on
        // how well *both* sides of each domain are held.
        score: domain.strength,
        name: '',
        detail: `${domain.to - domain.from} bins · weaker border prominence ${domain.strength.toFixed(1)} bins`,
      })
    }
  }
  if (count === 0) return null
  return {
    count,
    output: {
      kind: 'intervals',
      id: 'di-domains',
      label: 'DI domains',
      payload: { kind: 'features', data: builder.finish() },
      noun: { one: 'domain', many: 'domains' },
    },
  }
}

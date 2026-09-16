/**
 * The HiC score, run.
 *
 * The same plan as the directionality index beside it — a band per sequence, one
 * kernel, one lane — with one number different: the band is read **twice as
 * deep** as the window reaches, because the two ends of a square `h` bins each
 * way from the diagonal are `2h` apart. A band read to `h` would leave that
 * corner unread, the kernel would count it as missing, and the score would come
 * back systematically low in a way no amount of staring at the track would
 * reveal.
 *
 * What this file owns beyond that is the arithmetic between the reader's number
 * and the kernel's: a window typed in bins becomes a half-width, and the notes
 * say what that came to in base pairs on the file actually open and how many
 * cells each score is a mean of. Both are one line and both are things a reader
 * would otherwise have to work out from the label.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import { hicScore, triangleCells } from '../hicscore'
import {
  boolParam,
  contigIdFor,
  numParam,
  readsAsCircular,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { halfWidthAt, windowBinsOf } from '../tasks/hicscore'
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
  const asked = windowBinsOf(job.params)
  const half = halfWidthAt(job.params)
  const depth = half * 2
  // The square that was actually built, which is `asked` when `asked` is odd and
  // the odd one below it when it is not. Everything downstream — the label, the
  // notes, the refusals — quotes this rather than what was typed, because it is
  // what the numbers are a reading of.
  const side = depth + 1
  const windowBp = side * job.mc.binsize
  const cells = triangleCells(half, ignoreDiags)

  // What the window came to in base pairs on *this* file, and how many cells are
  // behind each point of the track. The form asks in bins so the three
  // near-diagonal tasks can be set to the same scale (see `tasks/hicscore.ts`),
  // and the cost of that is exactly this line.
  const included = ignoreDiags > 0 ? 'less the diagonals cut below' : 'its main diagonal included'
  job.note(
    `A ${side.toLocaleString()}-bin window is ${formatBp(windowBp)} at this file’s ` +
      `${job.mc.binsize.toLocaleString()} bp resolution, and each score is the mean of ` +
      `${cells.toLocaleString()} ${cells === 1 ? 'cell' : 'cells'} — the upper triangle of ` +
      `that square, ${included}.`,
  )

  // The floor and the rounding in `halfWidthAt` have bitten. Said rather than
  // silently accepted, because a reader who typed 4 and is shown a track
  // computed on 3 should be told which of the two the lane is.
  if (asked !== side) {
    job.note(
      asked < 3
        ? `A ${asked}-bin window is narrower than the three bins the smallest square there is ` +
            'has on a side, so the square has been widened to three. Open a finer rung to ask ' +
            'for less genome than that.'
        : `A square centred on a bin has an odd number of bins on a side, so a ${asked}-bin ` +
            `window is the ${side}-bin square that fits inside it rather than the ` +
            `${(side + 2).toLocaleString()}-bin one that does not.`,
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
      `No sequence in this file is longer than a ${side.toLocaleString()}-bin window, so no ` +
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
  if (circularUnits < units.length) {
    // The other half of the same fact, and the one a reader is more likely to be
    // puzzled by: a linear sequence has no whole square around its first and last
    // `h` bins, so the track begins and ends with a gap rather than a fade.
    job.note(
      `The first and last ${half.toLocaleString()} ${half === 1 ? 'bin' : 'bins'} of a linear ` +
        'sequence have no whole square around them and are left as gaps, rather than scored on ' +
        'the part of the window that fits — which would fade both ends towards zero.',
    )
  }

  const profile: ProfileOutput = {
    kind: 'profile',
    id: `hicscore-w${side}`,
    label: `HiC score · ${formatBp(windowBp)}`,
    values: scores,
    extent: [0, nBins],
    binsize: job.mc.binsize,
    // A mean of cells, so it carries the same unit one cell does — counts on a
    // raw map, and a balanced map's own dimensionless numbers where the run was
    // balanced. `contacts` is what every other lane of cell values in the
    // catalogue says and what the axis should be read as; that this one is an
    // average rather than a total is in the notes and in the label's window.
    unit: 'contacts',
  }
  const outputs: TaskOutput[] = [profile]
  return outputs
}

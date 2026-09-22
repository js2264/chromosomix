/**
 * The HiC score, run.
 *
 * The same plan as the directionality index beside it — a band per sequence, one
 * kernel, one lane — and the shallowest read of the three: the score is the
 * bin's own line across the near-diagonal, so the band is read exactly as deep
 * as the line reaches, `diagonals − 1`. At the bacterial default that is two
 * bins, which on most files is one strip and no tiling at all.
 *
 * What this file owns beyond that is the arithmetic between the reader's number
 * and the kernel's: a count of diagonals becomes a reach in bins, and the notes
 * say what that came to in base pairs on the file actually open and how many
 * cells each score is a mean of. Both are one line and both are things a reader
 * would otherwise have to work out from the label.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { hicScore, lineCells } from '../hicscore'
import {
  boolParam,
  numParam,
  readsAsCircular,
  tickedSequences,
  type JobContext,
  type TaskRunner,
} from '../job'
import { diagonalsOf, reachOf } from '../tasks/hicscore'
import type { ProfileOutput, TaskOutput } from '../types'
import {
  bandFor,
  missingSequencesNote,
  spanOfContig,
  tickedContigIds,
  usableBlock,
  type Span,
} from './blocks'
import { formatBp } from './labels'

interface Unit {
  name: string
  span: Span
  circular: boolean
}

/** The sequences to score: the ticked ones, or every one where none was. */
function planUnits(job: JobContext, names: readonly string[] | null): {
  units: Unit[]
  missing: string[]
} {
  const mc = job.mc
  const { ids, missing } = tickedContigIds(mc, names)
  const units: Unit[] = []
  for (const cid of ids) {
    const span = spanOfContig(mc, cid)
    if (span === null) continue
    const name = mc.chromnames[cid]
    units.push({ name, span, circular: readsAsCircular(job, name) })
  }
  return { units, missing }
}

export const runHicScore: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))
  const ignoreDiags = Math.max(0, Math.round(numParam(job.params, 'ignoreDiags', 0)))
  const diagonals = diagonalsOf(job.params)
  const depth = reachOf(job.params)
  const reachBp = depth * job.mc.binsize
  const cells = lineCells(diagonals, ignoreDiags)

  // What the score reaches in base pairs on *this* file, and how many cells are
  // behind each point of the track. The form asks in diagonals so the number a
  // reader types is the number the method is described with (see
  // `tasks/hicscore.ts`), and the cost of that is exactly this line.
  const included = ignoreDiags > 0 ? 'less the diagonals cut below' : 'the main diagonal included'
  job.note(
    `${diagonals.toLocaleString()} ${diagonals === 1 ? 'diagonal reaches' : 'diagonals reach'} ` +
      `${formatBp(reachBp)} either way at this file’s ` +
      `${job.mc.binsize.toLocaleString()} bp resolution, and each score is the mean of ` +
      `${cells.toLocaleString()} ${cells === 1 ? 'cell' : 'cells'} — the bin’s own line ` +
      `across them, ${included}.`,
  )

  if (cells === 0) {
    job.note(
      `Ignoring ${ignoreDiags.toLocaleString()} diagonals leaves nothing of a ` +
        `${diagonals.toLocaleString()}-diagonal line, so there is no cell left to average. ` +
        'Count more diagonals, or ignore fewer.',
    )
    return []
  }

  const ticked = tickedSequences(job.params, 'sequences')
  if (ticked !== null && ticked.length === 0) {
    job.note('No sequence is ticked, so there is nothing to score.')
    return []
  }
  const { units: planned, missing } = planUnits(job, ticked)
  const said = missingSequencesNote(job.mc, missing, planned.length)
  if (said !== null) job.note(said)
  if (planned.length === 0) return []

  // The line spans `2 × depth + 1` bins, so a sequence shorter than that has no
  // bin with a whole line through it — on a circle as on a line, because past
  // half the circle the short way round is the other way.
  const units = planned.filter((unit) => unit.span.to - unit.span.from > 2 * depth)
  if (units.length === 0) {
    job.note(
      `No sequence in this file is longer than the ${(2 * depth + 1).toLocaleString()} bins this ` +
        'line spans, so no bin on any of them has a whole line through it. Use fewer diagonals.',
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
    const local = hicScore(band, { diagonals, minValid, ignoreDiags })
    for (let i = 0; i < local.length; i++) scores[unit.span.from + i] = local[i]
  }
  job.progress(units.length, units.length, 'done')

  if (circularUnits > 0) {
    job.note(
      `${circularUnits.toLocaleString()} of ${units.length.toLocaleString()} ` +
        `${units.length === 1 ? 'sequence was' : 'sequences were'} read as circular, so the ` +
        'line wraps past the end and every bin is scored.',
    )
  }
  if (circularUnits < units.length && depth > 0) {
    // The other half of the same fact, and the one a reader is more likely to be
    // puzzled by: a linear sequence has no whole line through its first and last
    // few bins, so the track begins and ends with a gap rather than a fade.
    job.note(
      `The first and last ${depth.toLocaleString()} ${depth === 1 ? 'bin' : 'bins'} of a linear ` +
        'sequence have no whole line through them and are left as gaps, rather than scored on ' +
        'the part of it that fits — which would fade both ends towards zero.',
    )
  }

  const profile: ProfileOutput = {
    kind: 'profile',
    id: `hicscore-d${diagonals}`,
    label: `HiC score · ${diagonals} diag`,
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

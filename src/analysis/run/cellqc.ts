/**
 * Per-cell contact QC, run.
 *
 * One pass per cell, through `MetaCooler.scanCells` — which is `scanAll` with
 * the chunks told which cell they came out of, and costs exactly what summing
 * the same cells costs (§3.8).
 *
 * The arithmetic is a histogram of separations with three edges in it, and the
 * only thing worth care is *which denominator*. Nagano's percentages are of
 * **all** of a cell's contacts, trans included, rather than of its cis ones — a
 * cell whose trans fraction is enormous is a cell with a problem, and hiding
 * that by normalising it away would make the very cells the QC is for look
 * ordinary. So the bands are fractions of the total, and the cis fraction is a
 * column of its own beside them.
 */

import { binContigMap } from '../coverage'
import { boolParam, numParam, strParam, type TaskRunner } from '../job'
import { MITOTIC_TO, NEAR_FROM, NEAR_TO } from '../tasks/cellqc'
import type { CurveOutput, TableOutput, TaskOutput } from '../types'
import { validBins } from './blocks'

/** What one cell's pixels add up to. */
interface CellTotals {
  contacts: number
  nnz: number
  cis: number
  trans: number
  /** Cis contacts below the near band. */
  short: number
  near: number
  mitotic: number
  /** Cis contacts beyond the mitotic band. */
  far: number
}

export const runCellQc: TaskRunner = async (job) => {
  const mc = job.mc
  if (mc.cells.length === 0) {
    job.note('This file has no cells, so there is nothing to measure per cell.')
    return []
  }

  // **The whole file by default**, and it is restored afterwards. The reader's
  // ticked set is the thing this task exists to help them choose, so measuring
  // only what they have already ticked answers a question they have already
  // answered. The mount is this worker's own (§18.3), so re-selecting here
  // cannot disturb the map on screen — but a later task on the same mount would
  // inherit whatever was left behind, which is why it is put back.
  const everyCell = strParam(job.params, 'cells', 'all') !== 'selected'
  const ticked = mc.activeCells
  if (everyCell) mc.selectCells(null)
  try {
    return await measure(job, ticked)
  } finally {
    if (everyCell) mc.selectCells(ticked)
  }
}

async function measure(
  job: Parameters<TaskRunner>[0],
  ticked: readonly string[],
): Promise<TaskOutput[]> {
  const mc = job.mc
  const names = mc.activeCells
  const balance = boolParam(job.params, 'balance', false)
  const weights = validBins(mc, balance)

  const contigs: Array<{ startBin: number; bins: number }> = []
  let longest = 0
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    contigs.push({ startBin: from, bins: Math.max(0, to - from) })
    longest = Math.max(longest, (to - from) * mc.binsize)
  }
  const contigOf = binContigMap(contigs, mc.nBins)

  const nearFrom = Math.max(0, numParam(job.params, 'nearFrom', NEAR_FROM))
  const nearTo = Math.max(nearFrom + 1, numParam(job.params, 'nearTo', NEAR_TO))
  const mitoticTo = Math.max(nearTo + 1, numParam(job.params, 'mitoticTo', MITOTIC_TO))
  // The one thing that makes this measurement meaningless without saying so: the
  // paper's bands are mouse-sized, and on an assembly whose longest sequence is
  // shorter than the mitotic band's floor every cell scores exactly zero there —
  // which draws as a column of points on the axis and reads as a result.
  if (longest <= nearTo) {
    job.note(
      `The longest sequence here is ${Math.round(longest).toLocaleString()} bp, which is inside ` +
        'the near band — so the mitotic and far bands are empty by construction and the phasing ' +
        'plot says nothing. Set the band edges to this assembly’s own scale.',
    )
  }

  const totals: CellTotals[] = names.map(() => ({
    contacts: 0,
    nnz: 0,
    cis: 0,
    trans: 0,
    short: 0,
    near: 0,
    mitotic: 0,
    far: 0,
  }))

  job.progress(0, names.length, 'Reading cells')
  await mc.scanCells({
    onCell: (index, name) => job.progress(index, names.length, name),
    onChunk: (cell, chunk) => {
      job.throwIfCancelled()
      const into = totals[cell]
      for (let i = 0; i < chunk.length; i++) {
        const bin1 = chunk.bin1[i]
        const bin2 = chunk.bin2[i]
        const raw = chunk.count[i]
        const value = weights === null ? raw : raw * weights[bin1] * weights[bin2]
        if (!Number.isFinite(value)) continue
        into.nnz++
        into.contacts += value
        const c1 = contigOf[bin1]
        const c2 = contigOf[bin2]
        if (c1 < 0 || c2 < 0) continue
        if (c1 !== c2) {
          into.trans += value
          continue
        }
        into.cis += value
        // The separation of the **bins**, in base pairs. A contact inside one
        // bin has a separation of zero, which lands in the short band, and that
        // is the right home for it: a self-ligation and an unligated end are
        // exactly what the short band is there to hold apart from structure.
        const separation = Math.abs(bin2 - bin1) * mc.binsize
        if (separation < nearFrom) into.short += value
        else if (separation < nearTo) into.near += value
        else if (separation < mitoticTo) into.mitotic += value
        else into.far += value
      }
      return true
    },
    onProgress: () => job.throwIfCancelled(),
  })
  job.progress(names.length, names.length, 'Done')
  job.throwIfCancelled()

  const tickedSet = new Set(ticked)
  const share = (part: number, whole: number): number => (whole > 0 ? part / whole : Number.NaN)
  const rows = names.map((name, i) => {
    const cell = totals[i]
    return {
      cell: name,
      ticked: tickedSet.has(name) ? 'yes' : '',
      contacts: cell.contacts,
      nnz: cell.nnz,
      cis: share(cell.cis, cell.contacts),
      trans: share(cell.trans, cell.contacts),
      short: share(cell.short, cell.contacts),
      near: share(cell.near, cell.contacts),
      mitotic: share(cell.mitotic, cell.contacts),
      far: share(cell.far, cell.contacts),
    }
  })

  const empty = rows.filter((row) => row.contacts === 0).length
  if (empty > 0) {
    job.note(
      `${empty.toLocaleString()} cell${empty === 1 ? ' has' : 's have'} no contact at all, so ` +
        `${empty === 1 ? 'its' : 'their'} fractions are blank rather than zero.`,
    )
  }

  const outputs: TaskOutput[] = [
    {
      kind: 'table',
      id: 'cellqc',
      label: `${names.length.toLocaleString()} cells`,
      columns: [
        { key: 'cell', label: 'Cell', kind: 'text' },
        { key: 'ticked', label: 'Ticked', kind: 'text', hint: 'Whether this cell is in the set the map is drawn from.' },
        { key: 'contacts', label: 'Contacts', kind: 'number', digits: 0 },
        { key: 'nnz', label: 'Stored pixels', kind: 'number', digits: 0 },
        { key: 'cis', label: 'Cis', kind: 'number', digits: 3 },
        { key: 'trans', label: 'Trans', kind: 'number', digits: 3 },
        {
          key: 'short',
          label: `< ${short(nearFrom)}`,
          kind: 'number',
          digits: 3,
          hint: 'Self-ligation and unligated ends, mostly.',
        },
        {
          key: 'near',
          label: `${short(nearFrom)}–${short(nearTo)}`,
          kind: 'number',
          digits: 3,
          hint: 'The near band. High in G1, low just after mitosis.',
        },
        {
          key: 'mitotic',
          label: `${short(nearTo)}–${short(mitoticTo)}`,
          kind: 'number',
          digits: 3,
          hint: 'The mitotic band. The condensed chromosome’s signature.',
        },
        { key: 'far', label: `> ${short(mitoticTo)}`, kind: 'number', digits: 3 },
      ],
      rows,
    } satisfies TableOutput,
  ]

  const x = Float64Array.from(rows, (row) => row.near)
  const y = Float64Array.from(rows, (row) => row.mitotic)
  outputs.push({
    kind: 'curve',
    id: 'cellqc-phase',
    label: 'Cell-cycle phasing',
    series: [
      {
        name: `${names.length.toLocaleString()} cells`,
        x,
        y,
        n: names.length,
        // Points, because the cells have no order along x and a line through
        // them would draw a path nothing travelled.
        mark: 'points',
      },
    ],
    xLabel: `Contacts ${short(nearFrom)}–${short(nearTo)} (near)`,
    yLabel: `Contacts ${short(nearTo)}–${short(mitoticTo)} (mitotic)`,
    xScale: 'linear',
    yScale: 'linear',
  } satisfies CurveOutput)

  return outputs
}

/** `2 Mb`, `23 kb` — a band edge short enough to be a column heading. */
function short(bp: number): string {
  if (bp >= 1e6) return `${Number((bp / 1e6).toFixed(1))} Mb`
  if (bp >= 1e3) return `${Number((bp / 1e3).toFixed(1))} kb`
  return `${Math.round(bp)} bp`
}

/**
 * The map report, run.
 *
 * Three of its sections are other tasks' outputs, which arrive as `upstream`
 * results and are carried into this one under ids of their own — P(s) and its
 * slope, coverage, and cis and trans per sequence (§18.8). The fourth and the
 * first are this file's: one pass over the pixel table at the base resolution
 * counts the library's totals and every bin's contact ends, and the resolution
 * ladder is summed from those ends (`analysis/mapreport.ts`).
 *
 * **The base is the file's finest resolution**, not the one on screen, where
 * the file has a finer one and the reader did not ask otherwise: a ladder that
 * started at the 10 kb a reader happened to be looking at would say nothing
 * about the 1 kb the file holds. The finer rung is mounted beside the map for
 * the pass and closed after it (`JobContext.peer`).
 */

import { formatUri, parseUri } from '../../uri'
import { binContigMap } from '../coverage'
import { LibraryAccumulator, ladderSizes, resolutionLadder, type LadderRow, type LibraryTotals } from '../mapreport'
import { strParam, type JobContext, type TaskRunner } from '../job'
import type { MetaCooler } from '../../metacooler/MetaCooler'
import type { PairStats } from '../../pairs/stats'
import type {
  CurveOutput,
  ProfileOutput,
  TableOutput,
  TaskOutput,
  TaskResult,
} from '../types'
import { formatBp } from './labels'

/** The rungs a file stores, in base pairs; empty for a file with one. */
export function fileRungs(mc: MetaCooler): number[] {
  if (mc.entryGroup !== 'resolutions') return []
  return mc.entries
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((size) => size > 0)
}

/** Where each sequence starts and how many bins it has, in the file's order. */
function contigsOf(mc: MetaCooler): Array<{ startBin: number; bins: number }> {
  const out: Array<{ startBin: number; bins: number }> = []
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    out.push({ startBin: from, bins: Math.max(0, to - from) })
  }
  return out
}

/**
 * The map the pass reads: the file's finest rung, mounted beside this one,
 * where that is what was asked and it can be; this map otherwise.
 */
async function baseMap(job: JobContext): Promise<{ mc: MetaCooler; close: () => void }> {
  const here = { mc: job.mc, close: () => {} }
  if (strParam(job.params, 'base', 'finest') !== 'finest') return here
  const rungs = fileRungs(job.mc)
  if (rungs.length === 0) return here
  const finest = Math.min(...rungs)
  if (finest >= job.mc.binsize) return here
  const self = job.inputs.self
  if (self === undefined || job.peer === undefined) {
    job.note(
      `The file’s finest resolution is ${formatBp(finest)}, and it could not be opened beside this ` +
        `map here, so the ladder starts at this map’s ${formatBp(job.mc.binsize)}.`,
    )
    return here
  }
  const { path } = parseUri(self.uri)
  job.progress(0, 1, `opening the ${formatBp(finest)} resolution`)
  const opened = await job.peer({
    ...self,
    label: `${self.label} at ${formatBp(finest)}`,
    uri: formatUri(path, `/resolutions/${finest}`),
  })
  return opened
}

export const runMapReport: TaskRunner = async (job) => {
  const upstream = job.inputs.upstream ?? {}
  const outputs: TaskOutput[] = []

  // -- The pass: totals and contact ends at the base resolution.
  const base = await baseMap(job)
  let totals: LibraryTotals
  let ladder: LadderRow[]
  let baseBinsize: number
  try {
    const mc = base.mc
    baseBinsize = mc.binsize
    const contigs = contigsOf(mc)
    const accumulator = new LibraryAccumulator(mc.nBins, binContigMap(contigs, mc.nBins), mc.binsize)
    job.progress(0, 1, `reading pixels at ${formatBp(mc.binsize)}`)
    await mc.scanPixels({
      onChunk: (chunk) => {
        job.throwIfCancelled()
        accumulator.addPixels(chunk.bin1, chunk.bin2, chunk.count, chunk.length)
      },
      onProgress: (done, total) => job.progress(done, total, `reading pixels at ${formatBp(mc.binsize)}`),
    })
    job.throwIfCancelled()
    totals = accumulator.finish()
    let longest = 0
    for (const contig of contigs) longest = Math.max(longest, contig.bins * mc.binsize)
    const sizes = ladderSizes(mc.binsize, fileRungs(mc), longest)
    ladder = resolutionLadder(totals.ends, contigs, mc.binsize, sizes)
  } finally {
    base.close()
  }

  job.note(
    `The library and the resolutions are counted at ${formatBp(baseBinsize)}` +
      (baseBinsize === job.mc.binsize ? ', this map’s resolution' : ', the file’s finest') +
      ', from the raw counts. A contact is counted at both its ends, as Juicer’s ' +
      '`calculate_map_resolution.sh` counts it, so a coarser bin holds exactly the sum of its finer ones.',
  )
  if (baseBinsize > 1000) {
    job.note(
      `Cis contacts at least 1, 2 and 4 kb apart are of bins at least that far apart, and at ` +
        `${formatBp(baseBinsize)} a bin’s neighbour is already ${formatBp(baseBinsize)} away.`,
    )
  }

  outputs.push(summaryTable(totals, job.inputs.pairsStats))
  outputs.push(ladderTable(ladder))
  const ladderCurve = ladderFigure(ladder)
  if (ladderCurve !== null) outputs.push(ladderCurve)

  // -- P(s), as the P(s) task computed it.
  outputs.push(...carried(upstream.expected, { ps: 'report-ps', 'ps-slope': 'report-ps-slope' }))

  // -- Coverage along the genome and its spread, from the Coverage task's track.
  const coverage = upstream.coverage?.outputs.find(
    (output): output is ProfileOutput => output.kind === 'profile' && output.id === 'coverage-total',
  )
  if (coverage !== undefined) {
    outputs.push(coverageAlong(coverage))
    const spread = coverageSpread(coverage)
    if (spread !== null) {
      outputs.push(spread.curve)
      if (spread.empty > 0) {
        job.note(
          `${spread.empty.toLocaleString()} of ${spread.bins.toLocaleString()} bins at ` +
            `${formatBp(coverage.binsize)} have no contact at all and are left out of the spread of coverage, ` +
            'whose axis is logarithmic.',
        )
      }
    }
  }

  // -- Cis and trans per sequence, as that task computed them.
  outputs.push(
    ...carried(upstream.cistrans, { cistrans: 'report-cistrans', 'cistrans-fractions': 'report-cistrans-fractions' }),
  )
  return outputs
}

/** Another task's outputs, by id, under this task's ids. */
function carried(result: TaskResult | undefined, ids: Record<string, string>): TaskOutput[] {
  if (result === undefined) return []
  const out: TaskOutput[] = []
  for (const [from, to] of Object.entries(ids)) {
    const found = result.outputs.find((output) => output.id === from)
    if (found !== undefined && found.kind !== 'profile' && found.kind !== 'intervals') out.push({ ...found, id: to })
  }
  return out
}

/** The library in one table: what was counted, and its share of every contact. */
function summaryTable(totals: LibraryTotals, pairs: PairStats | undefined): TableOutput {
  const rows: Array<Record<string, string | number>> = []
  const share = (n: number, of: number): number => (of > 0 ? n / of : Number.NaN)
  const add = (group: string, measure: string, value: number, of: number | null): void => {
    rows.push({ group, measure, value, share: of === null ? Number.NaN : share(value, of) })
  }
  if (pairs !== undefined) {
    // pairtools' own counts, over the records the map was binned from (§3.7).
    add('Records', 'pairs', pairs.total, null)
    add('Records', 'mapped on both sides', pairs.totalMapped, pairs.total)
    add('Records', 'mapped on one side', pairs.totalSingleSidedMapped, pairs.total)
    add('Records', 'unmapped', pairs.totalUnmapped, pairs.total)
    add('Records', 'duplicates', pairs.totalDups, pairs.totalMapped)
    add('Records', 'unique', pairs.totalNodups, pairs.totalMapped)
    add('Records', 'cis', pairs.cis, pairs.totalNodups)
    add('Records', 'trans', pairs.trans, pairs.totalNodups)
    for (const [kb, n] of pairs.cisAtLeast) add('Records', `cis ≥ ${kb} kb`, n, pairs.totalNodups)
  }
  add('Map', 'contacts', totals.contacts, null)
  add('Map', 'cis', totals.cis, totals.contacts)
  add('Map', 'trans', totals.trans, totals.contacts)
  add('Map', 'within one bin', totals.diagonal, totals.contacts)
  for (const [kb, n] of totals.cisAtLeast) add('Map', `cis, bins ≥ ${kb} kb apart`, n, totals.contacts)
  add('Map', 'pixels with a count', totals.pixels, null)
  return {
    kind: 'table',
    id: 'report-summary',
    label: 'The library',
    columns: [
      { key: 'group', label: 'Counted from', kind: 'text' },
      { key: 'measure', label: 'Measure', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'number', digits: 0 },
      {
        key: 'share',
        label: 'Share',
        kind: 'number',
        digits: 4,
        hint: 'Of every contact; duplicates of the mapped pairs, and cis and trans of the unique ones.',
      },
    ],
    rows,
  }
}

/** The ladder as a table, coarsest first. */
function ladderTable(ladder: readonly LadderRow[]): TableOutput {
  return {
    kind: 'table',
    id: 'report-resolutions',
    label: 'Resolutions, coarsest to finest',
    columns: [
      { key: 'binsize', label: 'Bin size (bp)', kind: 'number', digits: 0 },
      { key: 'bins', label: 'Bins', kind: 'number', digits: 0 },
      { key: 'mean', label: 'Mean contacts per bin', kind: 'number', digits: 1 },
      { key: 'median', label: 'Median', kind: 'number', digits: 1 },
      {
        key: 'reached80',
        label: 'Reached by 80 % of bins',
        kind: 'number',
        digits: 0,
        hint: 'The largest count at least four bins in five hold: Rao et al.’s criterion, as a number.',
      },
      { key: 'empty', label: 'Empty bins', kind: 'number', digits: 4, hint: 'As a fraction of the bins.' },
      {
        key: 'belowTenthMedian',
        label: 'Below a tenth of the median',
        kind: 'number',
        digits: 4,
        hint: 'Bins with fewer contacts than a tenth of the median, the empty ones included, as a fraction.',
      },
    ],
    rows: ladder.map((row) => ({ ...row })),
  }
}

/** The ladder as a figure: the median and the 80 % count against the bin size. */
function ladderFigure(ladder: readonly LadderRow[]): CurveOutput | null {
  const rows = [...ladder].filter((row) => row.bins > 0).sort((a, b) => a.binsize - b.binsize)
  if (rows.length === 0) return null
  const x = Float64Array.from(rows, (row) => row.binsize)
  // A count of 0 has no logarithm; it is a gap in the line rather than a cliff.
  const positive = (value: number): number => (value > 0 ? value : Number.NaN)
  return {
    kind: 'curve',
    id: 'report-resolution-curve',
    label: 'Contacts per bin, by bin size',
    series: [
      { name: 'median', x, y: Float64Array.from(rows, (row) => positive(row.median)), mark: 'points' },
      { name: 'reached by 80 % of bins', x, y: Float64Array.from(rows, (row) => positive(row.reached80)), mark: 'points' },
    ],
    xLabel: 'Bin size (bp)',
    yLabel: 'Contacts per bin (both ends)',
    xScale: 'log',
    yScale: 'log',
  }
}

/** The most points a figure along the genome is drawn with: a mean of each run of bins past it. */
const ALONG_POINTS = 3000

/** Coverage along the genome, sequences end to end. */
function coverageAlong(profile: ProfileOutput): CurveOutput {
  const n = profile.values.length
  const step = Math.max(1, Math.ceil(n / ALONG_POINTS))
  const xs: number[] = []
  const ys: number[] = []
  for (let from = 0; from < n; from += step) {
    let sum = 0
    let count = 0
    const to = Math.min(n, from + step)
    for (let bin = from; bin < to; bin++) {
      const value = profile.values[bin]
      if (Number.isFinite(value)) {
        sum += value
        count++
      }
    }
    xs.push(((profile.extent[0] + (from + to) / 2) * profile.binsize) / 1e6)
    ys.push(count > 0 ? sum / count : Number.NaN)
  }
  return {
    kind: 'curve',
    id: 'report-coverage',
    label: step === 1 ? 'Coverage along the genome' : `Coverage along the genome, a mean of every ${step} bins`,
    series: [{ name: 'coverage', x: Float64Array.from(xs), y: Float64Array.from(ys) }],
    xLabel: 'Position, sequences end to end (Mb)',
    yLabel: `Contacts per ${formatBp(profile.binsize)} bin`,
    xScale: 'linear',
    yScale: 'linear',
  }
}

/** How many bins hold how much coverage, on log-spaced classes. */
function coverageSpread(profile: ProfileOutput): { curve: CurveOutput; empty: number; bins: number } | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = 0
  let empty = 0
  let bins = 0
  for (const value of profile.values) {
    if (!Number.isFinite(value)) continue
    bins++
    if (value <= 0) {
      empty++
      continue
    }
    lo = Math.min(lo, value)
    hi = Math.max(hi, value)
  }
  if (!(hi > 0)) return null
  const classes = 40
  const logLo = Math.log10(lo)
  const width = Math.max(1e-9, (Math.log10(hi) - logLo) / classes)
  const counts = new Float64Array(classes)
  for (const value of profile.values) {
    if (!(value > 0)) continue
    counts[Math.min(classes - 1, Math.floor((Math.log10(value) - logLo) / width))]++
  }
  const x = Float64Array.from({ length: classes }, (_, k) => 10 ** (logLo + (k + 0.5) * width))
  return {
    empty,
    bins,
    curve: {
      kind: 'curve',
      id: 'report-coverage-spread',
      label: 'Spread of coverage',
      series: [{ name: 'bins', x, y: counts, mark: 'bars' }],
      xLabel: `Contacts per ${formatBp(profile.binsize)} bin`,
      yLabel: 'Bins',
      xScale: 'log',
      yScale: 'linear',
    },
  }
}

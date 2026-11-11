/**
 * The map report's MultiQC sections: custom-content files a pipeline's
 * MultiQC picks up by their `_mqc` suffix and lays out per sample.
 *
 * Four files, each from the run's own outputs and nothing else, so a batch of
 * `chromosomix mapreport` over a hundred libraries is one MultiQC report with
 * a row each: the general statistics (`summary_mqc.tsv`), the resolution ladder
 * as a table (`resolutions_mqc.tsv`), the count 80 % of bins reach against the
 * bin size (`resolution_mqc.json`) and P(s) (`ps_mqc.json`). Their ids start
 * `chromosomix_`, so MultiQC files every sample's under one section.
 *
 * Numbers, as the report is: no column carries a colour scale that would read
 * as a pass or a fail.
 */

import type { CurveOutput, TableOutput, TaskResult } from '../types'

function table(result: TaskResult, id: string): TableOutput | undefined {
  return result.outputs.find((output): output is TableOutput => output.kind === 'table' && output.id === id)
}

function curve(result: TaskResult, id: string): CurveOutput | undefined {
  return result.outputs.find((output): output is CurveOutput => output.kind === 'curve' && output.id === id)
}

/** A cell of a TSV: a number as it is, a word without the characters TSV cannot hold. */
function cell(value: string | number | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return value.replace(/[\t\r\n]+/g, ' ')
}

/** The general statistics: one row for this library, the measures MultiQC's top table shows. */
export function multiqcSummary(result: TaskResult, sample: string): string {
  const rows = table(result, 'report-summary')?.rows ?? []
  const map = (measure: string): Record<string, string | number> | undefined =>
    rows.find((row) => row.group === 'Map' && row.measure === measure)
  const ladder = table(result, 'report-resolutions')?.rows ?? []
  const finest = ladder.length > 0 ? ladder[ladder.length - 1] : undefined
  const columns: Array<[string, string, number | undefined]> = [
    ['contacts', 'Contacts', map('contacts')?.value as number | undefined],
    ['cis_share', 'Cis share', map('cis')?.share as number | undefined],
    ['trans_share', 'Trans share', map('trans')?.share as number | undefined],
    ['cis_10kb_share', 'Cis ≥ 10 kb share', map('cis, bins ≥ 10 kb apart')?.share as number | undefined],
    ['finest_bp', 'Finest bin (bp)', finest?.binsize as number | undefined],
    ['finest_median', 'Median contacts per finest bin', finest?.median as number | undefined],
    ['finest_reached80', 'Contacts 80 % of finest bins reach', finest?.reached80 as number | undefined],
  ]
  const header = [
    "# id: 'chromosomix_mapreport_summary'",
    "# section_name: 'chromosomix map report'",
    "# description: 'The library, counted from the contact map by chromosomix mapreport.'",
    "# plot_type: 'generalstats'",
    '# pconfig:',
    ...columns.flatMap(([key, title]) => [`#     - ${key}:`, `#         title: '${title}'`]),
  ]
  return [
    ...header,
    ['Sample', ...columns.map(([key]) => key)].join('\t'),
    [cell(sample), ...columns.map(([, , value]) => cell(value))].join('\t'),
    '',
  ].join('\n')
}

/** The resolution ladder, a row per bin size, named by the sample and the size. */
export function multiqcLadder(result: TaskResult, sample: string): string {
  const ladder = table(result, 'report-resolutions')
  const columns = ladder?.columns.filter((column) => column.key !== 'binsize') ?? []
  return [
    "# id: 'chromosomix_mapreport_resolutions'",
    "# section_name: 'Resolutions, coarsest to finest'",
    "# description: 'Contact ends per bin at each bin size: a contact counts once at each of its two bins. No threshold is applied.'",
    "# plot_type: 'table'",
    ['Sample', ...columns.map((column) => column.label)].join('\t'),
    ...(ladder?.rows ?? []).map((row) =>
      [cell(`${sample} · ${row.binsize} bp`), ...columns.map((column) => cell(row[column.key]))].join('\t'),
    ),
    '',
  ].join('\n')
}

/** The count 80 % of bins reach, against the bin size: one line per library. */
export function multiqcResolution(result: TaskResult, sample: string): string {
  const rows = table(result, 'report-resolutions')?.rows ?? []
  const data: Record<string, number> = {}
  for (const row of [...rows].sort((a, b) => Number(a.binsize) - Number(b.binsize))) {
    const value = Number(row.reached80)
    if (value > 0) data[String(row.binsize)] = value
  }
  return `${JSON.stringify(
    {
      id: 'chromosomix_mapreport_resolution',
      section_name: 'Contacts per bin, by bin size',
      description:
        'The largest count at least 80 % of bins hold, at each bin size (Rao et al. 2014’s criterion, as a number).',
      plot_type: 'linegraph',
      pconfig: {
        id: 'chromosomix_mapreport_resolution_plot',
        title: 'chromosomix: contacts reached by 80 % of bins',
        xlab: 'Bin size (bp)',
        ylab: 'Contacts per bin',
        xlog: true,
        ylog: true,
      },
      data: { [sample]: data },
    },
    null,
    1,
  )}\n`
}

/** P(s), as the P(s) task computed it: one line per library, or per sequence where it drew several. */
export function multiqcPs(result: TaskResult, sample: string): string {
  const ps = curve(result, 'report-ps')
  const data: Record<string, Record<string, number>> = {}
  for (const series of ps?.series ?? []) {
    const name = (ps?.series.length ?? 0) > 1 ? `${sample} · ${series.name}` : sample
    const points: Record<string, number> = {}
    for (let k = 0; k < series.x.length; k++) {
      if (Number.isFinite(series.y[k]) && series.y[k] > 0) points[String(series.x[k])] = series.y[k]
    }
    data[name] = points
  }
  return `${JSON.stringify(
    {
      id: 'chromosomix_mapreport_ps',
      section_name: 'Contact probability P(s)',
      description: 'As the chromosomix P(s) task computes it over the whole genome.',
      plot_type: 'linegraph',
      pconfig: {
        id: 'chromosomix_mapreport_ps_plot',
        title: 'chromosomix: P(s)',
        xlab: ps?.xLabel ?? 'Genomic separation (bp)',
        ylab: ps?.yLabel ?? 'P(s)',
        xlog: true,
        ylog: true,
      },
      data,
    },
    null,
    1,
  )}\n`
}

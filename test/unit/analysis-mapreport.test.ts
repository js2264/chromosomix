/**
 * The map report: its one pass, its ladder, and the files it leaves.
 *
 * The three sections it gathers are other tasks' outputs and are tested there;
 * what is pinned here is what this task adds — that a contact is counted at
 * both its ends, that a coarser bin holds exactly the sum of its finer ones,
 * that the 80 % count is the order statistic Rao et al.'s criterion reads, and
 * that the page and the MultiQC sections are written from the run and from
 * nothing else.
 */

import { describe, expect, it } from 'vitest'

import type { JobContext } from '@/analysis/job'
import { LibraryAccumulator, ladderSizes, resolutionLadder, spreadOf } from '@/analysis/mapreport'
import { mapReportPage } from '@/analysis/report/page'
import { multiqcLadder, multiqcPs, multiqcResolution, multiqcSummary } from '@/analysis/report/multiqc'
import { runMapReport } from '@/analysis/run/mapreport'
import { MAP_REPORT_TASK } from '@/analysis/tasks/mapreport'
import type { AnalysisFraming, TableOutput, TaskOutput, TaskResult } from '@/analysis/types'

describe('the pass', () => {
  it('counts a contact at both its ends, and one within a bin twice for it', () => {
    // Two sequences of three bins each; bins 0–2 and 3–5.
    const contigOf = Int32Array.from([0, 0, 0, 1, 1, 1])
    const acc = new LibraryAccumulator(6, contigOf, 1000)
    acc.addPixels(Int32Array.from([0, 0, 1, 2]), Int32Array.from([0, 2, 4, 2]), Float64Array.from([5, 3, 2, 1]), 4)
    const totals = acc.finish()
    expect(totals.contacts).toBe(11)
    expect(totals.cis).toBe(9)
    expect(totals.trans).toBe(2)
    expect(totals.diagonal).toBe(6)
    expect(Array.from(totals.ends)).toEqual([13, 2, 5, 0, 2, 0])
    // Bins 0 and 2 are 2 kb apart: cis at ≥ 1 and ≥ 2 kb, and not at 4.
    expect(totals.cisAtLeast.slice(0, 3)).toEqual([
      [1, 3],
      [2, 3],
      [4, 0],
    ])
    expect(totals.pixels).toBe(4)
  })
})

describe('the ladder', () => {
  it('climbs from the base, doubling, with the file’s own rungs, coarsest first', () => {
    expect(ladderSizes(1000, [1000, 5000, 3333], 100_000)).toEqual([8000, 5000, 4000, 2000, 1000])
  })

  it('holds the sum of the finer bins in each coarser one, a sequence’s last bin short', () => {
    const ends = Float64Array.from([1, 2, 3, 4, 5, 10, 20])
    const rows = resolutionLadder(ends, [{ startBin: 0, bins: 5 }, { startBin: 5, bins: 2 }], 1000, [2000])
    // 1+2, 3+4, 5 | 10+20
    expect(rows[0].bins).toBe(4)
    expect(rows[0].mean).toBe((3 + 7 + 5 + 30) / 4)
    expect(rows[0].median).toBe(6)
  })

  it('reports the count four bins in five reach, and the empty and the nearly empty', () => {
    const row = spreadOf(1000, Float64Array.from([0, 0, 1, 50, 60, 70, 80, 90, 100, 110]))
    // ⌊0.2 · 10⌋ = 2: at least eight of the ten bins hold one contact or more.
    expect(row.reached80).toBe(1)
    expect(row.median).toBe(65)
    expect(row.empty).toBe(0.2)
    // Below 6.5: the two empty bins and the one with a single contact.
    expect(row.belowTenthMedian).toBe(0.3)
  })
})

/** A two-sequence map at 1 kb, its pixels in memory, and the three upstream runs. */
function job(): JobContext {
  const bin1 = Int32Array.from([0, 0, 1, 2, 3])
  const bin2 = Int32Array.from([0, 1, 3, 2, 3])
  const count = Float64Array.from([10, 4, 2, 6, 8])
  const mc = {
    nBins: 4,
    nContigs: 2,
    binsize: 1000,
    entries: [] as string[],
    entryGroup: '',
    contigExtent: (cid: number) => (cid === 0 ? [0, 2] : [2, 4]) as [number, number],
    scanPixels: async ({ onChunk }: { onChunk: (chunk: unknown) => void }) => {
      onChunk({ bin1, bin2, count, length: count.length })
    },
  }
  const upstream = (task: string, outputs: TaskOutput[]): TaskResult => ({
    outputs,
    notes: [],
    ms: 1,
    provenance: { task, taskVersion: 1, params: {}, framing: FRAMING, app: 'test', createdAt: '2026-10-30T00:00:00Z' },
  })
  return {
    mc: mc as never,
    params: { base: 'finest', balance: false },
    framing: FRAMING,
    inputs: {
      upstream: {
        expected: upstream('expected', [
          {
            kind: 'curve',
            id: 'ps',
            label: 'Contact probability P(s)',
            series: [{ name: 'whole genome', x: Float64Array.from([1000, 10000]), y: Float64Array.from([1e-3, 1e-5]) }],
            xLabel: 'Genomic separation (bp)',
            yLabel: 'P',
            xScale: 'log',
            yScale: 'log',
          },
        ]),
        coverage: upstream('coverage', [
          { kind: 'profile', id: 'coverage-total', label: 'Coverage · total', values: Float32Array.from([14, 6, 6, 10]), extent: [0, 4], binsize: 1000, unit: 'contacts' },
        ]),
        cistrans: upstream('cistrans', [
          {
            kind: 'table',
            id: 'cistrans',
            label: 'Cis and trans per sequence',
            columns: [{ key: 'sequence', label: 'Sequence', kind: 'text' }],
            rows: [{ sequence: 'I' }, { sequence: 'II' }],
          },
        ]),
      },
    } as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins) => bins * 1000,
    toBins: (bp) => Math.max(1, Math.round(bp / 1000)),
  }
}

const FRAMING: AnalysisFraming = {
  uri: '/data/sample.cool',
  label: 'whole file',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 4],
  cols: [0, 4],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

async function run(): Promise<TaskResult> {
  const outputs = await runMapReport(job())
  return {
    outputs,
    notes: ['A note with `code` in it.'],
    ms: 1,
    provenance: { task: 'mapreport', taskVersion: 1, params: { base: 'finest' }, framing: FRAMING, app: 'test', createdAt: '2026-10-30T00:00:00Z' },
  }
}

describe('the run', () => {
  it('counts the library, climbs the ladder, and carries the three tasks it gathers', async () => {
    const result = await run()
    const ids = result.outputs.map((output) => output.id)
    expect(ids).toEqual([
      'report-summary',
      'report-resolutions',
      'report-resolution-curve',
      'report-ps',
      'report-coverage',
      'report-coverage-spread',
      'report-cistrans',
    ])
    const summary = result.outputs[0] as TableOutput
    const value = (measure: string): unknown => summary.rows.find((row) => row.measure === measure)?.value
    expect(value('contacts')).toBe(30)
    expect(value('cis')).toBe(28)
    expect(value('trans')).toBe(2)
    const ladder = result.outputs[1] as TableOutput
    // Sequences of 2 kb climb no further than their base: a tenth of the longest is below it.
    expect(ladder.rows.map((row) => row.binsize)).toEqual([1000])
    // Ends: bin 0 holds 10 twice and 4, bin 1 the 4 and the 2, bin 2 the 6 twice, bin 3 the 2 and 8 twice.
    expect(ladder.rows[0].mean).toBe((24 + 6 + 12 + 18) / 4)
  })

  it('writes a page that needs nothing beside it', async () => {
    const html = mapReportPage(await run(), 'sample')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Map report · sample</title>')
    for (const heading of ['The library', 'Resolutions, coarsest to finest', 'Contact probability, P(s)', 'Coverage', 'Cis and trans per sequence', 'Provenance']) {
      expect(html).toContain(`<h2>${heading}</h2>`)
    }
    expect(html).toContain('<code>code</code>')
    // Self-contained: no script, stylesheet or image fetched from anywhere.
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//)
  })

  it('leaves MultiQC sections MultiQC can read', async () => {
    const result = await run()
    const summary = multiqcSummary(result, 'sample').split('\n')
    expect(summary).toContain("# plot_type: 'generalstats'")
    const header = summary.find((line) => line.startsWith('Sample\t'))!.split('\t')
    const row = summary.find((line) => line.startsWith('sample\t'))!.split('\t')
    expect(row[header.indexOf('contacts')]).toBe('30')
    expect(multiqcLadder(result, 'sample')).toContain('sample · 1000 bp')
    expect(JSON.parse(multiqcResolution(result, 'sample')).plot_type).toBe('linegraph')
    expect(JSON.parse(multiqcPs(result, 'sample')).data.sample).toEqual({ '1000': 0.001, '10000': 0.00001 })
  })

  it('offers the page in the drawer and the MultiQC files to the shell alone', () => {
    const documents = MAP_REPORT_TASK.documents ?? []
    expect(documents.filter((d) => d.shellOnly !== true).map((d) => `${d.id}.${d.extension}`)).toEqual(['report.html'])
    expect(documents.filter((d) => d.shellOnly === true).every((d) => d.id.endsWith('_mqc'))).toBe(true)
  })
})

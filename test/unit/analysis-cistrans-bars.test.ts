// @vitest-environment jsdom

/**
 * The cis/trans bars: the three answers, the arithmetic, and the file they export to.
 *
 * The arithmetic of the accumulator is checked in `analysis-new-kernels`, where
 * it belongs — it is a kernel with no file in it. What is checked here is
 * everything between that kernel and the reader: which series the parameter
 * produces, that a fraction is taken against the sequence's *own* total rather
 * than against the file's, that a sequence with no contact at all is a gap and
 * not a zero, that the figure the drawer builds from the output is a bar chart
 * whose abscissa says which sequence each bar is, and that the TSV under it
 * carries the names rather than the indices the bars are plotted at.
 *
 * The matrix under the test is four sequences and six pixels, and every fraction
 * in it is a number checked by hand in the comment beside it: a fixture would
 * put four seconds of HDF5 between the test and the question, and a generated
 * one would be checked against the same code it is testing.
 */

import { describe, expect, it } from 'vitest'

import { runCisTrans } from '@/analysis/run/cistrans'
import type { JobContext } from '@/analysis/job'
import { optionOf, type FigureTheme } from '@/figures/option'
import { specOf, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle } from '@/figures/style'
import { outputToTsv } from '@/analysis/write/tsv'
import type {
  AnalysisFraming,
  CurveOutput,
  Params,
  Provenance,
  TableOutput,
} from '@/analysis/types'
import type { MetaCooler } from '@/metacooler/MetaCooler'

/**
 * Four sequences over six bins: `A` and `B` two bins each, `C` and `D` one.
 *
 * `D` is the one that matters most and has no pixel anywhere: it is the sequence
 * whose fraction is zero over zero.
 */
const NAMES = ['A', 'B', 'C', 'D']
const EXTENT: Array<[number, number]> = [
  [0, 2],
  [2, 4],
  [4, 5],
  [5, 6],
]

/**
 * Every pixel of the file, upper-triangular as a cooler stores one.
 *
 * Which gives, by hand:
 *
 * | | cis | trans | total | cis share | trans share |
 * |---|---|---|---|---|---|
 * | A | 5 + 10 = 15 | 5 | 20 | 0.75 | 0.25 |
 * | B | 4 | 5 + 1 = 6 | 10 | 0.4 | 0.6 |
 * | C | 0 | 1 | 1 | 0 | 1 |
 * | D | 0 | 0 | 0 | — | — |
 */
const PIXELS: Array<[number, number, number]> = [
  [0, 0, 5], // A, on its own diagonal
  [0, 1, 10], // A, off it
  [0, 2, 5], // A–B
  [2, 3, 4], // B, on its own
  [3, 4, 1], // B–C
]

function fakeMc(): MetaCooler {
  return {
    nBins: 6,
    nContigs: NAMES.length,
    binsize: 1000,
    chromnames: NAMES,
    contigExtent: (cid: number) => EXTENT[cid],
    // Enough of the name lookup for a ticked list to be resolved: the four
    // names as they are spelled, and no other spelling of any of them.
    hasContig: (name: string) => NAMES.includes(name),
    contigId: (name: string) => NAMES.indexOf(name),
    names: { find: () => null },
    scanPixels: async (options: {
      onChunk(chunk: {
        bin1: Int32Array
        bin2: Int32Array
        count: Float64Array
        length: number
      }): boolean | void
      onProgress?(done: number, total: number): void
    }) => {
      options.onChunk({
        bin1: Int32Array.from(PIXELS, ([a]) => a),
        bin2: Int32Array.from(PIXELS, ([, b]) => b),
        count: Float64Array.from(PIXELS, ([, , count]) => count),
        length: PIXELS.length,
      })
      options.onProgress?.(PIXELS.length, PIXELS.length)
    },
  } as unknown as MetaCooler
}

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'whole file',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 6],
  cols: [0, 6],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

const PROVENANCE: Provenance = {
  task: 'cistrans',
  taskVersion: 1,
  params: { bars: 'both' },
  framing: FRAMING,
  app: 'metacooler 0.9.0 (abc1234)',
  createdAt: '2026-08-08T14:52:33',
}

/** The runner, with no block on screen, so it takes the pixel-table road. */
async function run(params: Params): Promise<{
  table: TableOutput
  bars: CurveOutput
}> {
  const context = {
    mc: fakeMc(),
    params,
    framing: FRAMING,
    inputs: {},
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * 1000,
    toBins: (bp: number) => Math.max(1, Math.round(bp / 1000)),
  } as unknown as JobContext
  const outputs = await runCisTrans(context)
  const table = outputs.find((output) => output.id === 'cistrans')
  const bars = outputs.find((output) => output.id === 'cistrans-fractions')
  if (table?.kind !== 'table' || bars?.kind !== 'curve') throw new Error('no bars')
  return { table, bars }
}

const of = (bars: CurveOutput, name: string): number[] => {
  const series = bars.series.find((entry) => entry.name === name)
  if (series === undefined) throw new Error(`no ${name} series`)
  return [...series.y]
}

describe('the cis/trans bars', () => {
  it('stands one bar per sequence, in the file’s own order, named', async () => {
    const { bars } = await run({})
    expect(bars.xTicks).toEqual(NAMES)
    expect([...bars.series[0].x]).toEqual([0, 1, 2, 3])
    expect(bars.xLabel).toBe('Sequence')
    // A fraction lives in [0, 1] whatever these fractions happen to be, so two
    // runs of the task are drawn against one ceiling.
    expect(bars.yDomain).toEqual([0, 1])
    // A share, said as a percentage — which is what the axis spelling is keyed
    // on (§26.2).
    expect(bars.yLabel).toContain('(%)')
  })

  it('shows the cis share by default, against each sequence’s own total', async () => {
    const { bars } = await run({})
    expect(bars.label).toBe('Cis fraction per sequence')
    expect(bars.series.map((series) => series.name)).toEqual(['cis'])
    const [a, b, c, d] = of(bars, 'cis')
    expect(a).toBeCloseTo(0.75, 12)
    expect(b).toBeCloseTo(0.4, 12)
    expect(c).toBe(0)
    // Zero of zero is not zero: `D` touches nothing, and a bar of height 0 would
    // say its contact is entirely trans.
    expect(d).toBeNaN()
  })

  it('shows the trans share when asked, and it is not one minus the other', async () => {
    const { bars } = await run({ bars: 'trans' })
    expect(bars.label).toBe('Trans fraction per sequence')
    expect(bars.series.map((series) => series.name)).toEqual(['trans'])
    const [a, b, c, d] = of(bars, 'trans')
    expect(a).toBeCloseTo(0.25, 12)
    expect(b).toBeCloseTo(0.6, 12)
    expect(c).toBe(1)
    // Computed against the total rather than by subtraction, which would have
    // handed the sequence with no contact a trans fraction of exactly 1.
    expect(d).toBeNaN()
  })

  it('stacks both into one full bar when asked for both', async () => {
    const { bars } = await run({ bars: 'both' })
    expect(bars.label).toBe('Cis and trans fraction per sequence')
    expect(bars.series.map((series) => series.name)).toEqual(['cis', 'trans'])
    // One stack, or they would stand side by side and the bar would not be the
    // sequence's whole contact.
    const stacks = new Set(bars.series.map((series) => series.stack))
    expect(stacks.size).toBe(1)
    expect([...stacks][0]).toBeDefined()
    const cis = of(bars, 'cis')
    const trans = of(bars, 'trans')
    for (let i = 0; i < 3; i++) expect(cis[i] + trans[i]).toBeCloseTo(1, 12)
  })

  it('leaves the two halves unstacked where only one is drawn', async () => {
    // A stack of one is a stack nobody can see, and a figure the reader restyles
    // to a line would carry it into the line (`CurveSeries.stack`).
    for (const which of ['cis', 'trans']) {
      const { bars } = await run({ bars: which })
      expect(bars.series[0].stack).toBeUndefined()
    }
  })

  it('draws the same numbers the table holds', async () => {
    const { table, bars } = await run({})
    const fractions = table.rows.map((row) => Number(row['fraction']))
    const drawn = of(bars, 'cis')
    for (let i = 0; i < fractions.length; i++) {
      if (Number.isNaN(fractions[i])) expect(drawn[i]).toBeNaN()
      else expect(drawn[i]).toBeCloseTo(fractions[i], 12)
    }
  })
})

const THEME: FigureTheme = {
  ink: '#16181d',
  muted: '#5b6169',
  grid: '#dcdfe3',
  background: '#ffffff',
  series: ['#0072B2', '#D55E00', '#009E73'],
  fontFamily: 'system-ui, sans-serif',
}

/** The chart the drawer builds from the output, as `figure-option` asserts one. */
function chart(bars: CurveOutput): {
  spec: XyFigureSpec
  option: Record<string, unknown>
} {
  const spec = specOf(bars) as XyFigureSpec
  return { spec, option: optionOf(spec, defaultStyle(spec), THEME) }
}

function seriesOf(option: Record<string, unknown>): Array<Record<string, unknown>> {
  return option['series'] as Array<Record<string, unknown>>
}

describe('the figure the bars become', () => {
  it('opens as bars, with an axis that starts at zero', async () => {
    const { bars } = await run({})
    const { spec, option } = chart(bars)
    expect(spec.mark).toBe('bars')
    expect(seriesOf(option).map((entry) => entry['type'])).toEqual(['bar'])
    // A bar is read as its own area, so a floor above zero is a lie about it.
    expect((option['yAxis'] as Record<string, unknown>)['scale']).toBe(false)
  })

  it('names the sequence under each bar and nothing between two', async () => {
    const { bars } = await run({})
    const { option } = chart(bars)
    const axis = option['xAxis'] as {
      minInterval: number
      axisLabel: { formatter: (value: number) => string; hideOverlap: boolean }
    }
    expect(axis.axisLabel.formatter(0)).toBe('A')
    expect(axis.axisLabel.formatter(3)).toBe('D')
    // There is no sequence between the first and the second, so the tick that
    // would land there says nothing.
    expect(axis.axisLabel.formatter(1.5)).toBe('')
    expect(axis.axisLabel.formatter(9)).toBe('')
    // Ticks on whole numbers, thinned rather than overprinted.
    expect(axis.minInterval).toBe(1)
    expect(axis.axisLabel.hideOverlap).toBe(true)
  })

  it('spells the ordinate as a percentage, with no idle zeros', async () => {
    const { bars } = await run({})
    const { option } = chart(bars)
    const label = (option['yAxis'] as { axisLabel: { formatter: (v: number) => string } })
      .axisLabel
    expect(label.formatter(0)).toBe('0%')
    expect(label.formatter(0.25)).toBe('25%')
    expect(label.formatter(1)).toBe('100%')
    // And a place where the tick has one to spend.
    expect(label.formatter(0.755)).toBe('75.5%')
  })

  it('carries the stack onto the bars and no further', async () => {
    const { bars } = await run({ bars: 'both' })
    const { spec, option } = chart(bars)
    const stacks = seriesOf(option).map((entry) => entry['stack'])
    expect(stacks[0]).toBeDefined()
    expect(stacks[0]).toBe(stacks[1])
    // Restyled to lines, the two series are the two quantities again rather than
    // one of them and their sum.
    const lines = optionOf(spec, { ...defaultStyle(spec), mark: 'line' }, THEME)
    expect(seriesOf(lines).map((entry) => entry['type'])).toEqual(['line', 'line'])
    expect(seriesOf(lines).every((entry) => entry['stack'] === undefined)).toBe(true)
  })
})

describe('the TSV under the bars', () => {
  /** The rows, with the provenance and the per-output `#` lines dropped. */
  const body = (text: string): string[][] =>
    text
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t'))

  it('names the sequence in the first column and leaves a gap as a gap', async () => {
    const { bars } = await run({ bars: 'both' })
    const text = outputToTsv(bars, PROVENANCE)
    expect(text).not.toContain('NaN')
    expect(body(text)).toEqual([
      ['Sequence', 'cis', 'trans'],
      ['A', '0.75', '0.25'],
      ['B', '0.4', '0.6'],
      ['C', '0', '1'],
      // `D` touches nothing, so both cells are empty rather than zero.
      ['D', '', ''],
    ])
  })

  it('holds the fractions the axis prints as percentages', async () => {
    // §26.2's *a table cell is not a summary*: the figure reads `75%` and the
    // file a reader checks it against holds `0.75`.
    const { bars } = await run({})
    expect(body(outputToTsv(bars, PROVENANCE))[1]).toEqual(['A', '0.75'])
  })

  it('carries the provenance every other export carries', async () => {
    const { bars } = await run({ bars: 'both' })
    const text = outputToTsv(bars, PROVENANCE)
    expect(text).toContain('# param bars: both')
    expect(text).toContain('cistrans v1')
    expect(text).toContain('# output: Cis and trans fraction per sequence')
  })
})

/**
 * Which sequences the rows are of (§18.2): every one where the run was never
 * asked, the ticked ones where it was — and none at all, said rather than read,
 * where the reader pressed **none**. That last used to come back as every
 * sequence, which is the one thing nothing ticked must not become.
 */
describe('the sequences a run reports', () => {
  async function report(
    params: Params,
  ): Promise<{ rows: string[]; notes: string[]; scans: number; outputs: number }> {
    const notes: string[] = []
    let scans = 0
    const mc = fakeMc() as unknown as { scanPixels(options: unknown): Promise<void> }
    const read = mc.scanPixels.bind(mc)
    mc.scanPixels = async (options) => {
      scans++
      await read(options)
    }
    const outputs = await runCisTrans({
      mc,
      params,
      framing: FRAMING,
      inputs: {},
      cancelled: () => false,
      throwIfCancelled: () => {},
      progress: () => {},
      note: (text: string) => notes.push(text),
      toBp: (bins: number) => bins * 1000,
      toBins: (bp: number) => Math.max(1, Math.round(bp / 1000)),
    } as unknown as JobContext)
    const table = outputs.find((output): output is TableOutput => output.kind === 'table')
    return {
      rows: (table?.rows ?? []).map((row) => String(row['sequence'])),
      notes,
      scans,
      outputs: outputs.length,
    }
  }

  it('reads every sequence when it was never asked', async () => {
    const { rows } = await report({})
    expect(rows).toEqual(NAMES)
  })

  it('reports the ticked ones and only those', async () => {
    const { rows, notes } = await report({ sequences: ['B', 'D'] })
    expect(rows).toEqual(['B', 'D'])
    expect(notes).toEqual([])
  })

  it('answers nothing ticked with nothing, and does not read the file for it', async () => {
    const { outputs, notes, scans } = await report({ sequences: [] })
    expect(outputs).toBe(0)
    expect(notes).toEqual(['No sequence is ticked, so there is nothing to report.'])
    expect(scans).toBe(0)
  })

  it('names a ticked sequence this file has not got, and says so when none is left', async () => {
    const some = await report({ sequences: ['B', 'chrX'] })
    expect(some.rows).toEqual(['B'])
    expect(some.notes).toEqual(['1 ticked sequence is not in this file and is left out: chrX.'])
    // Every name missing is a fact about the pair of files, not a reader who
    // pressed none — so it is not said as one.
    const none = await report({ sequences: ['chrX'] })
    expect(none.outputs).toBe(0)
    expect(none.notes).toHaveLength(1)
    expect(none.notes[0]).toMatch(/^This file has no sequence called chrX/)
  })
})

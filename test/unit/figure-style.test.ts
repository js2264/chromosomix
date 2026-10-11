// @vitest-environment jsdom

/**
 * The figure model: what a plot is of, and what the reader has decided about it.
 *
 * The two halves are tested together because the whole point of splitting them
 * is the boundary — a spec that carried a colour or a style that carried data
 * would break the property the dialog depends on, which is that restyling a
 * figure never rewrites what it is a figure of.
 *
 * The validation gets the most attention, and deserves it: a stored style
 * outlives the build that wrote it, so everything read back is untrusted input
 * in exactly the sense the URL hash is. A style that came back with a log axis
 * and a domain of `[NaN, NaN]` is a blank figure nobody can get back from.
 */

import { describe, expect, it } from 'vitest'

import {
  distributionOfTable,
  leastSquares,
  numberIn,
  numberedColumns,
  numericColumns,
  specOf,
  xyOfTable,
  type XyFigureSpec,
} from '@/figures/spec'
import {
  defaultStyle,
  figureKey,
  forgetStyle,
  recallStyle,
  rememberStyle,
  sanitiseStyle,
} from '@/figures/style'
import type { CurveOutput, ProfileOutput, TableOutput } from '@/analysis/types'

function curve(): CurveOutput {
  return {
    kind: 'curve',
    id: 'ps',
    label: 'Contact probability',
    xLabel: 'separation (bp)',
    yLabel: 'P(s)',
    xScale: 'log',
    yScale: 'log',
    xDomain: [1000, 1e6],
    series: [
      { name: 'chrI', x: new Float64Array([1, 2, 3]), y: new Float64Array([9, 4, 1]) },
      { name: 'chrII', x: new Float64Array([1, 2, 3]), y: new Float64Array([8, 3, 2]) },
    ],
  }
}

function table(): TableOutput {
  return {
    kind: 'table',
    id: 'mags',
    label: 'Genome bins',
    columns: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'completeness', label: 'Completeness', kind: 'number', digits: 1 },
      { key: 'contamination', label: 'Contamination', kind: 'number', digits: 1 },
    ],
    rows: [
      { name: 'bin.1', completeness: 98.2, contamination: 1.1 },
      { name: 'bin.2', completeness: 71.0, contamination: 4.5 },
      // A row missing a number is a row with no point on the picture.
      { name: 'bin.3', completeness: 'n/a', contamination: 0.2 },
    ],
  }
}

describe('specOf', () => {
  it('carries the task’s axes and window, and none of its colours', () => {
    const spec = specOf(curve()) as XyFigureSpec
    expect(spec.kind).toBe('xy')
    expect(spec.xScale).toBe('log')
    expect(spec.xDomain).toEqual([1000, 1e6])
    expect(spec.series.map((series) => series.id)).toEqual(['chrI', 'chrII'])
    expect(spec.series[0].x).toEqual([1, 2, 3])
  })

  it('gives two series of the same name two keys, so a style names one of them', () => {
    const output = curve()
    output.series[1].name = 'chrI'
    const spec = specOf(output) as XyFigureSpec
    expect(spec.series.map((series) => series.id)).toEqual(['chrI', 'chrI#2'])
  })

  it('opens on points when every series the task drew was points', () => {
    const output = curve()
    for (const series of output.series) series.mark = 'points'
    expect((specOf(output) as XyFigureSpec).mark).toBe('points')
  })

  it('turns a profile into a curve over its bins and keeps the bin size', () => {
    const profile: ProfileOutput = {
      kind: 'profile',
      id: 'ins',
      label: 'Insulation',
      values: new Float32Array([1, 2, Number.NaN, 4]),
      extent: [10, 14],
      binsize: 5000,
      unit: '',
    }
    const spec = specOf(profile) as XyFigureSpec
    expect(spec.kind).toBe('xy')
    expect(spec.binsize).toBe(5000)
    expect(spec.series[0].x[0]).toBeGreaterThanOrEqual(10)
  })

  it('keeps a matrix as the output it was, for the rasteriser that draws it', () => {
    const spec = specOf({
      kind: 'matrix',
      id: 'apa',
      label: 'APA',
      nrows: 2,
      ncols: 2,
      values: new Float32Array([1, 2, 3, 4]),
      xLabel: '',
      yLabel: '',
      xTicks: [],
      yTicks: [],
      colormap: 'fall',
    })
    expect(spec?.kind).toBe('matrix')
    expect(spec?.kind === 'matrix' && spec.output.values.length).toBe(4)
  })

  it('has nothing to draw for a set of intervals', () => {
    expect(
      specOf({
        kind: 'intervals',
        id: 'loops',
        label: 'Loops',
        payload: { kind: 'pairs', pairs: [] } as never,
      }),
    ).toBeNull()
  })
})

describe('a table as a chart', () => {
  it('offers only the columns that could be an axis', () => {
    const spec = specOf(table())
    expect(spec?.kind).toBe('table')
    expect(
      numericColumns(spec as never).map((column) => column.key),
    ).toEqual(['completeness', 'contamination'])
  })

  it('drops a row that has no number in one of the two columns', () => {
    const spec = specOf(table())
    const xy = xyOfTable(spec as never, 'completeness', 'contamination', 'points')
    expect(xy.series[0].x).toEqual([98.2, 71])
    expect(xy.series[0].y).toEqual([1.1, 4.5])
    expect(xy.xLabel).toBe('Completeness')
  })

  it('summarises one column without inventing an x axis', () => {
    const spec = specOf(table())
    const dist = distributionOfTable(spec as never, 'contamination', 'histogram')
    expect(dist.series[0].y).toEqual([1.1, 4.5, 0.2])
    expect(dist.mark).toBe('histogram')
    // The column names the *ordinate*, since that is what a histogram counts;
    // the abscissa is the row index and says nothing.
    expect(dist.yLabel).toBe('Contamination')
    expect(dist.xLabel).toBe('row')
  })
})

/** An all-maps table of a time course: named maps, one of them with no time. */
function course(): TableOutput {
  return {
    kind: 'table',
    id: 'interarm-table__all',
    label: 'Inter-arm alignment per sequence — all maps',
    columns: [
      { key: 'map', label: 'Map', kind: 'text' },
      { key: 'sequence', label: 'sequence', kind: 'text' },
      { key: 'reach', label: 'reach', kind: 'number' },
    ],
    rows: [
      { map: 'WT', sequence: 'chr', reach: 2_000_000 },
      { map: '+parB 15 min', sequence: 'chr', reach: 35 },
      { map: '+parB 30 min', sequence: 'chr', reach: 65 },
      { map: '+parB 45 min', sequence: 'chr', reach: 95 },
      { map: '+parB 60 min', sequence: 'chr', reach: Number.NaN },
    ],
  }
}

describe('a table’s names as an axis, and a line through it', () => {
  it('reads the first number a name writes, and nothing from a name with none', () => {
    expect(numberIn('+parB 15 min')).toBe(15)
    expect(numberIn('2.5 µM')).toBe(2.5)
    expect(numberIn('rep-2')).toBe(2)
    expect(numberIn('WT')).toBeNaN()
  })

  it('offers a column of names once two of its rows carry a number', () => {
    const spec = specOf(course()) as never
    expect(numberedColumns(spec).map((column) => column.key)).toEqual(['map'])
  })

  it('plots each row at the number in its name, leaving out a name with none', () => {
    const xy = xyOfTable(specOf(course()) as never, 'map', 'reach', 'points')
    expect(xy.series).toHaveLength(1)
    expect(xy.series[0].x).toEqual([15, 30, 45])
    expect(xy.series[0].y).toEqual([35, 65, 95])
    expect(xy.xLabel).toBe('number in Map')
  })

  it('fits the least-squares line through what is drawn, named by its equation', () => {
    const xy = xyOfTable(specOf(course()) as never, 'map', 'reach', 'points', true)
    expect(xy.series).toHaveLength(2)
    const line = xy.series[1]
    expect(line.id).toBe('least-squares')
    expect(line.mark).toBe('line')
    // reach = 2·t + 5, exactly.
    expect(line.x).toEqual([15, 45])
    expect(line.y[0]).toBeCloseTo(35, 9)
    expect(line.y[1]).toBeCloseTo(95, 9)
    expect(line.name).toBe('least squares: y = 2·x + 5 · r² = 1.000 · n = 3')
  })

  it('fits the points inside the window and no others', () => {
    // A time point before anything has started, whose reach is noise.
    const early = course()
    early.rows.unshift({ map: '+parB 0 min', sequence: 'chr', reach: 80 })
    const everything = xyOfTable(specOf(early) as never, 'map', 'reach', 'points', true)
    expect(everything.series[1].name).toMatch(/n = 4$/)
    const under = xyOfTable(specOf(early) as never, 'map', 'reach', 'points', true, [10, 50])
    // Every point is still drawn; the line is the three in the window's.
    expect(under.series[0].x).toEqual([0, 15, 30, 45])
    expect(under.series[1].x).toEqual([15, 45])
    expect(under.series[1].name).toBe('least squares: y = 2·x + 5 · r² = 1.000 · n = 3')
  })

  it('has no line through one abscissa, and says how well a line fits', () => {
    expect(leastSquares([3, 3], [1, 2])).toBeNull()
    expect(leastSquares([1], [1])).toBeNull()
    const fit = leastSquares([0, 1, 2, 3], [0, 2, 1, 3])!
    expect(fit.slope).toBeCloseTo(0.8, 9)
    expect(fit.intercept).toBeCloseTo(0.3, 9)
    expect(fit.r2).toBeCloseTo(0.64, 9)
    expect(fit.n).toBe(4)
  })
})

describe('defaultStyle', () => {
  it('opens the figure the way the task meant it', () => {
    const spec = specOf(curve())!
    const style = defaultStyle(spec)
    expect(style.x.scale).toBe('log')
    expect(style.x.domain).toEqual([1000, 1e6])
    expect(style.mark).toBe('line')
    expect(style.legend).toBe('right')
  })

  it('spends no width on a legend that names one line', () => {
    const output = curve()
    output.series = [output.series[0]]
    expect(defaultStyle(specOf(output)!).legend).toBe('none')
  })

  it('takes a matrix’s colormap and its fixed scale from the task', () => {
    const spec = specOf({
      kind: 'matrix',
      id: 'apa',
      label: 'APA',
      nrows: 1,
      ncols: 1,
      values: new Float32Array([1]),
      xLabel: '',
      yLabel: '',
      xTicks: [],
      yTicks: [],
      colormap: 'seismic',
      range: [0, 2],
    })!
    const style = defaultStyle(spec)
    expect(style.colormap).toBe('seismic')
    expect([style.vmin, style.vmax]).toEqual([0, 2])
  })
})

describe('sanitiseStyle', () => {
  const spec = specOf(curve())!

  it('takes what is valid and defaults the rest', () => {
    const style = sanitiseStyle(
      { mark: 'points', lineWidth: 3, hidden: ['chrII'], legend: 'bottom' },
      spec,
    )
    expect(style.mark).toBe('points')
    expect(style.lineWidth).toBe(3)
    expect(style.hidden).toEqual(['chrII'])
    expect(style.legend).toBe('bottom')
    // Untouched fields are the task's, not the last build's.
    expect(style.x.scale).toBe('log')
  })

  it('refuses a domain that would blank the figure', () => {
    expect(sanitiseStyle({ x: { domain: [Number.NaN, 5] } }, spec).x.domain).toBeNull()
    expect(sanitiseStyle({ x: { domain: [5, 5] } }, spec).x.domain).toBeNull()
    expect(sanitiseStyle({ x: { domain: [9, 1] } }, spec).x.domain).toBeNull()
    expect(sanitiseStyle({ x: { domain: [1, 9] } }, spec).x.domain).toEqual([1, 9])
  })

  it('clamps a size rather than drawing an invisible or enormous mark', () => {
    expect(sanitiseStyle({ lineWidth: 0 }, spec).lineWidth).toBe(0.25)
    expect(sanitiseStyle({ lineWidth: 1e6 }, spec).lineWidth).toBe(8)
    expect(sanitiseStyle({ fontSize: -4 }, spec).fontSize).toBe(7)
  })

  it('refuses a mark, a colormap or a colour it does not know', () => {
    expect(sanitiseStyle({ mark: 'wobble' }, spec).mark).toBe('line')
    expect(sanitiseStyle({ colormap: 'not-a-map' }, spec).colormap).toBeNull()
    expect(sanitiseStyle({ colours: { chrI: 'rebeccapurple' } }, spec).colours).toEqual({})
    expect(sanitiseStyle({ colours: { chrI: '#ff0000' } }, spec).colours).toEqual({
      chrI: '#ff0000',
    })
  })

  it('drops a sort, a column list and a plot naming columns this table lacks', () => {
    const tableSpec = specOf(table())!
    expect(sanitiseStyle({ sortKey: 'gone' }, tableSpec).sortKey).toBeNull()
    expect(sanitiseStyle({ sortKey: 'name' }, tableSpec).sortKey).toBe('name')
    expect(sanitiseStyle({ columns: ['gone'] }, tableSpec).columns).toBeNull()
    expect(sanitiseStyle({ plot: { y: 'gone', mark: 'points' } }, tableSpec).plot).toBeNull()
    expect(
      sanitiseStyle({ plot: { x: 'gone', y: 'completeness', mark: 'points' } }, tableSpec).plot,
    ).toEqual({ x: null, y: 'completeness', mark: 'points', fit: false })
    expect(
      sanitiseStyle({ plot: { x: 'name', y: 'completeness', mark: 'points', fit: true } }, tableSpec).plot,
    ).toEqual({ x: 'name', y: 'completeness', mark: 'points', fit: true })
    expect(
      sanitiseStyle({ plot: { y: 'completeness', mark: 'points', fit: 'yes' } }, tableSpec).plot?.fit,
    ).toBe(false)
  })

  it('is the default for anything that is not a record', () => {
    expect(sanitiseStyle(null, spec)).toEqual(defaultStyle(spec))
    expect(sanitiseStyle([1, 2], spec)).toEqual(defaultStyle(spec))
    expect(sanitiseStyle('style', spec)).toEqual(defaultStyle(spec))
  })
})

describe('the memory', () => {
  const spec = specOf(curve())!

  it('keeps a style per file, task and output, and hands it back', () => {
    const style = defaultStyle(spec)
    style.mark = 'points'
    style.hidden = ['chrII']
    rememberStyle('file://a.mcool', 'ps', spec.id, style)

    expect(recallStyle('file://a.mcool', 'ps', spec).mark).toBe('points')
    // Another task, another output and another file each keep their own.
    expect(recallStyle('file://a.mcool', 'saddle', spec).mark).toBe('line')
    expect(recallStyle('file://b.mcool', 'ps', spec).mark).toBe('line')
  })

  it('does not drop the other figures when one is written', () => {
    const style = defaultStyle(spec)
    style.smooth = true
    rememberStyle('file://c.mcool', 'ps', spec.id, style)
    const other = defaultStyle(spec)
    other.smooth = false
    other.lineWidth = 4
    rememberStyle('file://c.mcool', 'saddle', spec.id, other)

    expect(recallStyle('file://c.mcool', 'ps', spec).smooth).toBe(true)
    expect(recallStyle('file://c.mcool', 'saddle', spec).lineWidth).toBe(4)
  })

  it('forgets one figure on a reset', () => {
    const style = defaultStyle(spec)
    style.mark = 'bars'
    rememberStyle('file://d.mcool', 'ps', spec.id, style)
    forgetStyle('file://d.mcool', 'ps', spec.id)
    expect(recallStyle('file://d.mcool', 'ps', spec).mark).toBe('line')
  })

  it('names a figure by its task and its output', () => {
    expect(figureKey('ps', 'curve')).toBe('ps::curve')
  })
})

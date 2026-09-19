// @vitest-environment jsdom

/**
 * The option a figure becomes, and the summaries three of the marks are.
 *
 * Kept away from the library on purpose. Every decision about what the picture
 * *is* — which colour a series takes, whether a zero survives a log axis, how
 * wide a histogram's bins are — is made in a pure function here, because a
 * decision made inside a renderer is a decision nobody can test. What ECharts
 * then does with the object is ECharts' business, and the end-to-end check at
 * the bottom is the one place the two meet.
 */

import { describe, expect, it } from 'vitest'

import { markOf, optionOf, seriesColour, type FigureTheme } from '@/figures/option'
import { boxSummary, density, histogram, quantile, sorted } from '@/figures/stats'
import { specOf, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle, type FigureStyle } from '@/figures/style'
import type { CurveOutput } from '@/analysis/types'

const THEME: FigureTheme = {
  ink: '#16181d',
  muted: '#5b6169',
  grid: '#dcdfe3',
  background: '#ffffff',
  series: ['#0072B2', '#D55E00', '#009E73'],
  fontFamily: 'system-ui, sans-serif',
}

function curve(overrides: Partial<CurveOutput> = {}): CurveOutput {
  return {
    kind: 'curve',
    id: 'ps',
    label: 'P(s)',
    xLabel: 'separation',
    yLabel: 'probability',
    xScale: 'linear',
    yScale: 'linear',
    series: [
      { name: 'a', x: new Float64Array([1, 2, 3]), y: new Float64Array([4, 5, 6]) },
      { name: 'b', x: new Float64Array([1, 2, 3]), y: new Float64Array([1, 0, 2]) },
    ],
    ...overrides,
  }
}

function build(output = curve(), edit: (style: FigureStyle) => void = () => {}): {
  spec: XyFigureSpec
  style: FigureStyle
  option: Record<string, unknown>
} {
  const spec = specOf(output) as XyFigureSpec
  const style = defaultStyle(spec)
  edit(style)
  return { spec, style, option: optionOf(spec, style, THEME) }
}

function seriesOf(option: Record<string, unknown>): Array<Record<string, unknown>> {
  return option['series'] as Array<Record<string, unknown>>
}

describe('seriesColour', () => {
  const spec = specOf(curve()) as XyFigureSpec
  const style = defaultStyle(spec)

  it('prefers what the reader set, then the task, then the palette', () => {
    expect(seriesColour(spec.series[1], 1, style, THEME)).toBe('#D55E00')
    const withTask = { ...spec.series[1], colour: '#123456' }
    expect(seriesColour(withTask, 1, style, THEME)).toBe('#123456')
    const chosen = { ...style, colours: { b: '#abcdef' } }
    expect(seriesColour(withTask, 1, chosen, THEME)).toBe('#abcdef')
  })

  // The bug this exists to prevent: hiding the first series used to shift every
  // remaining line one place up the palette, silently, into the PDF as well.
  it('reads the index into the full list, not a filtered one', () => {
    const hidden = { ...style, hidden: ['a'] }
    const option = optionOf(spec, hidden, THEME)
    const b = seriesOf(option).find((entry) => entry['name'] === 'b')
    expect(b?.['color']).toBe('#D55E00')
  })
})

describe('optionOf', () => {
  it('keeps a hidden series on the picture and off in the legend', () => {
    const { option } = build(curve(), (style) => {
      style.hidden = ['b']
    })
    const legend = option['legend'] as { selected: Record<string, boolean> }
    expect(legend.selected).toEqual({ a: true, b: false })
    expect(seriesOf(option).map((entry) => entry['name'])).toContain('b')
  })

  it('drops a non-positive value on a log axis rather than clamping it', () => {
    const { option } = build(curve(), (style) => {
      style.y.scale = 'log'
    })
    const b = seriesOf(option).find((entry) => entry['name'] === 'b')
    // The middle point of `b` is zero, which a log axis has no place for.
    expect(b?.['data']).toEqual([[1, 1], null, [3, 2]])
  })

  it('puts the window in the zoom, so a wheel and a typed number are one thing', () => {
    const { option } = build(curve(), (style) => {
      style.x.domain = [1.5, 2.5]
    })
    const zooms = option['dataZoom'] as Array<Record<string, unknown>>
    expect(zooms[0]['startValue']).toBe(1.5)
    expect(zooms[0]['endValue']).toBe(2.5)
    expect((option['xAxis'] as Record<string, unknown>)['min']).toBeUndefined()
    // The ordinate, untouched, is the whole of the data.
    expect(zooms[1]['start']).toBe(0)
    expect(zooms[1]['end']).toBe(100)
  })

  it('draws each mark as the chart type it is', () => {
    const kinds = (mark: FigureStyle['mark']): string[] =>
      seriesOf(build(curve(), (style) => (style.mark = mark)).option).map(
        (entry) => entry['type'] as string,
      )
    expect(kinds('line')).toEqual(['line', 'line'])
    expect(kinds('points')).toEqual(['scatter', 'scatter'])
    expect(kinds('bars')).toEqual(['bar', 'bar'])
    expect(kinds('histogram')).toEqual(['bar', 'bar'])
    expect(kinds('box')).toEqual(['boxplot', 'scatter'])
    expect(kinds('violin')).toEqual(['custom', 'custom'])
  })

  it('steps a step chart and smooths only when asked', () => {
    const stepped = seriesOf(build(curve(), (style) => (style.mark = 'step')).option)[0]
    expect(stepped['step']).toBe('middle')
    expect(stepped['smooth']).toBe(false)
    const smooth = seriesOf(build(curve(), (style) => (style.smooth = true)).option)[0]
    expect(smooth['smooth']).toBe(true)
  })

  it('draws a band as a silent stacked pair under its own line', () => {
    const banded = curve()
    banded.series[0].low = new Float64Array([3, 4, 5])
    banded.series[0].high = new Float64Array([5, 6, 7])
    const { option } = build(banded)
    const names = seriesOf(option).map((entry) => entry['id'])
    expect(names.slice(0, 3)).toEqual(['band-a-low', 'band-a-high', 'a'])
    // The upper edge carries the fill and the span, not the absolute height.
    const span = seriesOf(option)[1]['data'] as Array<[number, number]>
    expect(span.map((point) => point[1])).toEqual([2, 2, 2])
    expect(seriesOf(option)[1]['areaStyle']).toBeDefined()
  })

  it('leaves the band out when the reader turns it off', () => {
    const banded = curve()
    banded.series[0].low = new Float64Array([3, 4, 5])
    banded.series[0].high = new Float64Array([5, 6, 7])
    const { option } = build(banded, (style) => (style.bands = false))
    expect(seriesOf(option).map((entry) => entry['id'])).toEqual(['a', 'b'])
  })

  it('makes the series the categories when the mark is a distribution', () => {
    const { option } = build(curve(), (style) => (style.mark = 'box'))
    const x = option['xAxis'] as Record<string, unknown>
    expect(x['type']).toBe('category')
    expect(x['data']).toEqual(['a', 'b'])
    // And no zoom, because there is no abscissa to slide along.
    expect(option['dataZoom']).toBeUndefined()
  })

  it('labels a profile’s abscissa in base pairs rather than in bin numbers', () => {
    const spec = specOf(curve()) as XyFigureSpec
    spec.binsize = 5000
    const option = optionOf(spec, defaultStyle(spec), THEME)
    const label = (option['xAxis'] as { axisLabel: { formatter: (v: number) => string } }).axisLabel
    expect(label.formatter(400)).toBe('2.00 Mb')
  })

  it('shows a title only once the reader has typed one', () => {
    expect(build().option['title']).toBeUndefined()
    expect(build(curve(), (style) => (style.title = 'Yeast')).option['title']).toBeDefined()
  })

  it('lets a series keep its own mark under a figure-wide one', () => {
    const spec = specOf(curve()) as XyFigureSpec
    spec.series[0].mark = 'points'
    const style = defaultStyle(spec)
    expect(markOf(spec.series[0], style)).toBe('points')
    expect(markOf(spec.series[1], style)).toBe('line')
    // Unless the figure-wide mark is a summary, which has no per-series form.
    expect(markOf(spec.series[0], { ...style, mark: 'box' })).toBe('box')
  })
})

describe('the distribution summaries', () => {
  it('quantiles the way R and numpy do', () => {
    const values = sorted([1, 2, 3, 4])
    expect(quantile(values, 0.5)).toBe(2.5)
    expect(quantile(values, 0.25)).toBe(1.75)
    expect(quantile(values, 0)).toBe(1)
    expect(quantile(values, 1)).toBe(4)
  })

  it('puts the whiskers on observed values and the rest outside', () => {
    const box = boxSummary([1, 2, 3, 4, 5, 100])
    expect(box.median).toBe(3.5)
    expect(box.outliers).toEqual([100])
    // The whisker stops at 5, not at the fence beyond it.
    expect(box.high).toBe(5)
  })

  it('ignores what is not a number rather than counting it as zero', () => {
    expect(boxSummary([1, Number.NaN, 3]).median).toBe(2)
    expect(histogram([1, Number.NaN, 3]).counts.reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('chooses its own bins when it is not told, and never more than it can draw', () => {
    const values = Array.from({ length: 400 }, (_, i) => Math.sin(i) * 10)
    const auto = histogram(values)
    expect(auto.counts.length).toBeGreaterThan(3)
    expect(auto.counts.length).toBeLessThanOrEqual(400)
    expect(auto.edges.length).toBe(auto.counts.length + 1)
    expect(auto.counts.reduce((a, b) => a + b, 0)).toBe(400)
    expect(histogram(values, 12).counts.length).toBe(12)
    expect(histogram(values, 100000).counts.length).toBe(400)
  })

  it('has one bin for one value, rather than dividing by a zero range', () => {
    expect(histogram([7, 7, 7])).toEqual({ edges: [7, 8], counts: [3] })
  })

  it('estimates a density that integrates to about one', () => {
    const values = Array.from({ length: 300 }, (_, i) => Math.cos(i * 1.7) * 2)
    const { at, y } = density(values, 128)
    expect(at.length).toBe(128)
    const step = at[1] - at[0]
    const area = y.reduce((sum, value) => sum + value * step, 0)
    expect(area).toBeGreaterThan(0.9)
    expect(area).toBeLessThan(1.1)
  })

  it('has no shape to draw for fewer than two values', () => {
    expect(density([4]).at).toEqual([])
  })
})

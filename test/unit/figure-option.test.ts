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

import { figureFit, fitOf, logTicks, markOf, optionOf, paperOption, seriesColour, wrapName, type FigureTheme } from '@/figures/option'
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

  it('keeps a hidden series hidden with the legend off', () => {
    // The chart hides a series through its legend's selection; a legend that is
    // switched off drew every hidden series again.
    const { option } = build(curve(), (style) => {
      style.hidden = ['b']
      style.legend = 'none'
    })
    const legend = option['legend'] as { show: boolean; selected: Record<string, boolean> }
    expect(legend.show).toBe(false)
    expect(legend.selected).toEqual({ a: true, b: false })
  })

  it('leaves a hidden series out of the legend an export draws', () => {
    const { option } = build(curve(), (style) => {
      style.hidden = ['b']
    })
    // On screen the greyed name is the control that brings the series back.
    expect((option['legend'] as { data: string[] }).data).toEqual(['a', 'b'])
    expect((paperOption(option)['legend'] as { data: string[] }).data).toEqual(['a'])
    // The rest of the option is the screen's.
    expect(paperOption(option)['series']).toBe(option['series'])
    // No legend, nothing to leave out.
    const bare = build(curve(), (style) => {
      style.legend = 'none'
    }).option
    expect(paperOption(bare)).toBe(bare)
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
    // The axis still holds the whole fit, so the zoom answers for every window
    // inside it: along a curve, the first sample to the last.
    expect((option['xAxis'] as Record<string, unknown>)['min']).toBe(1)
    expect((option['xAxis'] as Record<string, unknown>)['max']).toBe(3)
    // The ordinate, untouched, is the whole of the data.
    expect(zooms[1]['start']).toBe(0)
    expect(zooms[1]['end']).toBe(100)
  })

  it('stretches an axis to a window wider than the data, on that side alone', () => {
    // The task opens two figures on one ordinate; the zoom alone would clamp the
    // window to this figure's own data.
    const { option } = build(curve(), (style) => {
      style.y.domain = [-10, 2]
    })
    const axis = option['yAxis'] as Record<string, unknown>
    expect(axis['min']).toBe(-10)
    // The data reach past 2 on the top, so that side is the fit's own: the
    // highest value drawn, 6, and a twentieth of the span (0 to 6) above it.
    expect(axis['max']).toBeCloseTo(6.3, 12)
    // Both ends are numbers a reader would write, and are labelled.
    const labels = axis['axisLabel'] as Record<string, unknown>
    expect(labels['showMinLabel']).toBeUndefined()
    expect(labels['showMaxLabel']).toBeUndefined()
    const zooms = option['dataZoom'] as Array<Record<string, unknown>>
    expect(zooms[1]['startValue']).toBe(-10)
    expect(zooms[1]['endValue']).toBe(2)
  })

  it('thins tick labels that would print over each other, on both axes', () => {
    // A distance spelled `300.0 kb` at a type size raised for print ran into the
    // next one; only a named axis was thinned.
    const { option } = build(curve(), (style) => {
      style.fontSize = 22
    })
    const x = (option['xAxis'] as Record<string, unknown>)['axisLabel'] as Record<string, unknown>
    const y = (option['yAxis'] as Record<string, unknown>)['axisLabel'] as Record<string, unknown>
    expect(x['hideOverlap']).toBe(true)
    expect(y['hideOverlap']).toBe(true)
  })

  it('leaves an end where a box put it unlabelled, inside the data or past it', () => {
    // A box drawn by hand from just inside the first point to past the last:
    // its ends would print as `1.0372` and `3.4518` over the ticks beside them.
    const { option } = build(curve(), (style) => {
      style.x.domain = [1.0372, 3.4518]
    })
    const axis = option['xAxis'] as Record<string, unknown>
    // The fit's own on the left, where the window does not reach past it.
    expect(axis['min']).toBe(1)
    expect(axis['max']).toBe(3.4518)
    const labels = axis['axisLabel'] as Record<string, unknown>
    expect(labels['showMinLabel']).toBe(false)
    expect(labels['showMaxLabel']).toBe(false)
  })

  it('labels the round ends of a window, a tenth of its span or a whole decade', () => {
    const typed = build(curve(), (style) => {
      style.x.domain = [1.5, 3.5]
    }).option['xAxis'] as Record<string, unknown>
    expect(typed['max']).toBe(3.5)
    expect((typed['axisLabel'] as Record<string, unknown>)['showMinLabel']).toBeUndefined()
    expect((typed['axisLabel'] as Record<string, unknown>)['showMaxLabel']).toBeUndefined()
    // On a log axis only a power of ten is round: 0.5 is a stretch, 10 a decade.
    const log = build(curve({ xScale: 'log' }), (style) => {
      style.x.domain = [0.5, 10]
    }).option['xAxis'] as Record<string, unknown>
    expect(log['min']).toBe(0.5)
    expect(log['max']).toBe(10)
    expect((log['axisLabel'] as Record<string, unknown>)['showMinLabel']).toBe(false)
    expect((log['axisLabel'] as Record<string, unknown>)['showMaxLabel']).toBeUndefined()
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

  it('fills an area down to zero, not to the bottom of the axis', () => {
    // ECharts' `auto`: to zero where the axis holds it, else the edge nearest it.
    const { option } = build(curve(), (style) => (style.mark = 'area'))
    for (const entry of seriesOf(option)) {
      expect((entry['areaStyle'] as Record<string, unknown>)['origin']).toBe('auto')
    }
    const filled = build(curve(), (style) => (style.fillArea = true))
    expect((seriesOf(filled.option)[0]['areaStyle'] as Record<string, unknown>)['origin']).toBe('auto')
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

  it('stacks a band below zero on its own lower edge, not on zero', () => {
    // ECharts stacks only values of one sign unless told otherwise: a negative
    // lower edge with a positive width put the band between 0 and its width.
    const banded = curve()
    banded.series[0].low = new Float64Array([-0.05, -0.06, -0.04])
    banded.series[0].high = new Float64Array([-0.01, -0.02, 0.01])
    const { option } = build(banded)
    for (const edge of seriesOf(option).slice(0, 2)) expect(edge['stackStrategy']).toBe('all')
  })

  it('leaves the band out when the reader turns it off', () => {
    const banded = curve()
    banded.series[0].low = new Float64Array([3, 4, 5])
    banded.series[0].high = new Float64Array([5, 6, 7])
    const { option } = build(banded, (style) => (style.bands = false))
    expect(seriesOf(option).map((entry) => entry['id'])).toEqual(['a', 'b'])
  })

  /**
   * The bug: a violin's `custom` series hung on one datum at y = 0, so the
   * ordinate was sized to nothing and the shapes — computed from a Gaussian
   * density three bandwidths below the smallest value, which on a log axis is
   * a negative number — were drawn outside the grid and clipped. Sixteen
   * violins came out as an empty plot with its axes drawn neatly around them.
   *
   * Both halves are here: the data is the density's whole support, so the axis
   * fits it, and on a log ordinate the density is estimated on `log10` of the
   * values, so every point of that support is a number the axis can hold.
   */
  it('gives a violin its whole support, in units the axis can hold', () => {
    const { option } = build(curve(), (style) => {
      style.mark = 'violin'
      style.y.scale = 'log'
    })
    for (const entry of seriesOf(option)) {
      const data = entry['data'] as Array<[number, number]>
      expect(data.length).toBeGreaterThan(8)
      expect(data.every(([, y]) => y > 0)).toBe(true)
    }
    // And on a linear axis it is the plain estimate, whose support runs past
    // the sample in both directions — the series’ own values are 4, 5 and 6.
    const linear = build(curve(), (style) => (style.mark = 'violin')).option
    const first = seriesOf(linear)[0]['data'] as Array<[number, number]>
    expect(Math.min(...first.map(([, y]) => y))).toBeLessThan(4)
    expect(Math.max(...first.map(([, y]) => y))).toBeGreaterThan(6)
  })

  it('names the categories on the axis rather than in a legend', () => {
    for (const mark of ['box', 'violin'] as const) {
      const { option } = build(curve(), (style) => (style.mark = mark))
      expect((option['legend'] as { show: boolean }).show).toBe(false)
    }
  })

  // The bug: a violin's support runs three bandwidths past its sample, and on a
  // figure whose ordinate was set — peak calling sets it to whole decades — the
  // tail was drawn on below the axis, through the category names.
  it('cuts a violin at the grid rather than drawing it over the names', () => {
    const { option } = build(curve(), (style) => (style.mark = 'violin'))
    expect(seriesOf(option).map((entry) => entry['clip'])).toEqual([true, true])
  })

  // The bug: a distribution drops its legend, but the grid still kept the
  // legend's strip, so two violins sat beside an empty band down the right.
  it('keeps no room for a legend a distribution does not draw', () => {
    const right = (mark: FigureStyle['mark']): unknown =>
      (build(curve(), (style) => {
        style.mark = mark
        style.legend = 'right'
      }).option['grid'] as Record<string, unknown>)['right']
    expect(right('violin')).toBe(16)
    expect(right('box')).toBe(16)
    expect(right('line')).toBeGreaterThan(16)
  })

  it('frames the plot in the ink, its two axes on the frame and no gridline over it', () => {
    const { option } = build(curve({ series: [{ name: 'a', x: new Float64Array([-2, 0, 2]), y: new Float64Array([-1, 0, 1]) }] }))
    const grid = option['grid'] as Record<string, unknown>
    expect(grid['show']).toBe(true)
    expect(grid['borderColor']).toBe(THEME.ink)
    // Over the series, which sit at the library's 2, so the frame closes over
    // the ends of a curve that starts on it.
    expect(grid['z']).toBeGreaterThan(2)
    for (const name of ['xAxis', 'yAxis']) {
      const axis = option[name] as Record<string, Record<string, unknown>>
      // On the frame, not through the other axis's zero — which this profile
      // has in the middle of both.
      expect(axis['axisLine']['onZero']).toBe(false)
      expect((axis['axisLine']['lineStyle'] as Record<string, unknown>)['color']).toBe(THEME.ink)
      // The dashed grey at the two ends was the old border.
      expect(axis['splitLine']['showMinLine']).toBe(false)
      expect(axis['splitLine']['showMaxLine']).toBe(false)
      // Solid, as every line in a plot is, and thinner than the frame.
      expect(axis['splitLine']['lineStyle']).toMatchObject({ type: 'solid', width: 0.5 })
    }
  })

  it('fits a curve from its first sample to its last, with room above and below', () => {
    // A P(s): 5 kb to 2.1 Mb, used to be drawn from 1 kb to 10 Mb.
    const ps = curve({
      xScale: 'log',
      yScale: 'log',
      series: [
        { name: 'a', x: new Float64Array([0, 5000, 50_000, 2_100_000]), y: new Float64Array([1, 7.3e-6, 1e-6, 7e-8]) },
      ],
    })
    const { option } = build(ps)
    const x = option['xAxis'] as Record<string, unknown>
    // The zero separation is a gap on a log axis, and its value is no end.
    expect(x['min']).toBe(5000)
    expect(x['max']).toBe(2_100_000)
    // Neither end is a decade, so neither is labelled: the ticks inside are.
    expect((x['axisLabel'] as Record<string, unknown>)['showMinLabel']).toBe(false)
    expect((x['axisLabel'] as Record<string, unknown>)['showMaxLabel']).toBe(false)
    const y = option['yAxis'] as Record<string, unknown>
    const span = Math.log10(7.3e-6) - Math.log10(7e-8)
    expect(Math.log10(y['min'] as number)).toBeCloseTo(Math.log10(7e-8) - span * 0.05, 12)
    expect(Math.log10(y['max'] as number)).toBeCloseTo(Math.log10(7.3e-6) + span * 0.05, 12)
  })

  it('fits the ordinate to what is drawn in the abscissa’s window', () => {
    // A P(s) a task opens from x = 2.5: the 100 at x = 1 is off the picture to
    // the left, and the line from x = 2 to 3 enters the window at 7.5.
    const decay = curve({ series: [{ name: 'a', x: new Float64Array([1, 2, 3, 4, 5]), y: new Float64Array([100, 10, 5, 4, 3]) }] })
    const { option } = build(decay, (style) => {
      style.x.domain = [2.5, 5]
    })
    const y = option['yAxis'] as Record<string, unknown>
    expect(y['min']).toBeCloseTo(3 - 4.5 * 0.05, 12)
    expect(y['max']).toBeCloseTo(7.5 + 4.5 * 0.05, 12)
    // Points are not joined, so only the ones inside count.
    const points = build(decay, (style) => {
      style.mark = 'points'
      style.x.domain = [2.5, 5]
    }).option['yAxis'] as Record<string, unknown>
    expect(points['max']).toBeCloseTo(5 + 2 * 0.05, 12)
  })

  it('keeps the first and last ticks it gives a log axis whose ends are not round', () => {
    // A loop spectrum, 12 to 82 kb: the fit runs from under 11 kb, an end that
    // is not labelled, and the library hid the first *given* tick for it —
    // 20 kb, with its grid line — and the last, 80 kb, for the other end.
    const spectrum = curve({
      xScale: 'log',
      series: [{ name: 'a', x: new Float64Array([12_000, 30_000, 82_000]), y: new Float64Array([2, 3, 6]) }],
    })
    const x = build(spectrum).option['xAxis'] as Record<string, Record<string, unknown>>
    expect(x['axisLabel']['customValues']).toEqual([20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000])
    expect(x['axisLabel']['showMinLabel']).toBeUndefined()
    expect(x['axisLabel']['showMaxLabel']).toBeUndefined()
  })

  it('labels a log axis of a dozen decades every few, on whole decades', () => {
    const wide = curve({
      yScale: 'log',
      series: [{ name: 'a', x: new Float64Array([1, 2, 3]), y: new Float64Array([1e-12, 1e-6, 1]) }],
    })
    const y = build(wide).option['yAxis'] as Record<string, Record<string, unknown>>
    // Thirteen decades and a bit with the room: every third, from a multiple
    // of three — never counted from the axis's own end, which is no decade.
    const ticks = y['axisLabel']['customValues'] as number[]
    expect(ticks.map((tick) => Math.round(Math.log10(tick)))).toEqual([-12, -9, -6, -3, 0])
    expect(y['axisTick']['customValues']).toEqual(ticks)
    // Under ten decades the library's own, one a decade, stands.
    const narrow = build(curve({ yScale: 'log', series: [{ name: 'a', x: new Float64Array([1, 2]), y: new Float64Array([1e-6, 1e-3]) }] }))
    expect(((narrow.option['yAxis'] as Record<string, Record<string, unknown>>)['axisLabel'])['customValues']).toBeUndefined()
    expect(logTicks(1e-6, 1e-3)).toBeNull()
  })

  it('labels a log window narrower than a few decades between the decades too', () => {
    // A P(s) zoomed to 221 kb – 783 kb: no decade inside, so no label at all.
    expect(logTicks(221_000, 783_300)).toEqual([300_000, 400_000, 500_000, 600_000, 700_000])
    // Two decades inside: 1, 2 and 5 of each; three are the library's own.
    expect(logTicks(2000, 150_000)).toEqual([2000, 5000, 10_000, 20_000, 50_000, 100_000])
    expect(logTicks(800, 150_000)).toBeNull()
    // Inside a single digit's step, an ordinary ladder.
    expect(logTicks(310_000, 340_000)).toEqual([310_000, 320_000, 330_000, 340_000])
  })

  it('spells the crosshair’s numbers as the axes do', () => {
    const ps = curve({ xLabel: 'Genomic separation (bp)', xScale: 'log', yScale: 'log' })
    const { option } = build(ps)
    const x = (option['xAxis'] as Record<string, Record<string, Record<string, (p: { value: number }) => string>>>)['axisPointer']['label']['formatter']
    const y = (option['yAxis'] as Record<string, Record<string, Record<string, (p: { value: number }) => string>>>)['axisPointer']['label']['formatter']
    expect(x({ value: 387_269 })).toBe('387.3 kb')
    expect(y({ value: 2.24e-8 })).toBe('2.24e-8')
  })

  it('draws the crosshair solid, as every line in a plot is', () => {
    const tooltip = build().option['tooltip'] as Record<string, Record<string, Record<string, unknown>>>
    expect(tooltip['axisPointer']['lineStyle']['type']).toBe('solid')
    expect(tooltip['axisPointer']['crossStyle']['type']).toBe('solid')
  })

  it('names its two zooms, so a gesture can say which it moved', () => {
    const zooms = build().option['dataZoom'] as Array<Record<string, unknown>>
    expect(zooms.map((zoom) => zoom['id'])).toEqual(['zoom-x', 'zoom-y'])
  })

  it('keeps room along the abscissa for points, and leaves bars to the library', () => {
    const points = build(curve(), (style) => (style.mark = 'points')).option['xAxis'] as Record<string, unknown>
    expect(points['min']).toBeCloseTo(0.9, 12)
    expect(points['max']).toBeCloseTo(3.1, 12)
    const bars = build(curve(), (style) => (style.mark = 'bars')).option
    expect((bars['xAxis'] as Record<string, unknown>)['min']).toBeUndefined()
    expect((bars['yAxis'] as Record<string, unknown>)['min']).toBeUndefined()
    // A histogram's abscissa runs over its bins, with the room; its count is
    // the library's, from zero.
    const histo = build(curve(), (style) => (style.mark = 'histogram'))
    const edges = histogram([4, 5, 6, 1, 0, 2], histo.style.bins).edges
    const span = edges[edges.length - 1] - edges[0]
    expect((histo.option['xAxis'] as Record<string, unknown>)['min']).toBeCloseTo(edges[0] - span * 0.05, 12)
    // …and the library does not widen it again to hold the bars it already holds.
    expect((histo.option['xAxis'] as Record<string, unknown>)['containShape']).toBe(false)
    expect((histo.option['yAxis'] as Record<string, unknown>)['min']).toBeUndefined()
  })

  it('fits a violin to its whole support and a box to its whiskers and outliers', () => {
    const { spec, style } = build(curve(), (style) => (style.mark = 'violin'))
    const fit = figureFit(spec, style, 'y')
    // Past the sample at both ends, as the violin's tails are.
    expect(fit?.[0]).toBeLessThan(0)
    expect(fit?.[1]).toBeGreaterThan(6)
    const option = optionOf(spec, style, THEME)
    expect((option['yAxis'] as Record<string, unknown>)['min']).toBe(fit?.[0])
    const box = figureFit(spec, { ...style, mark: 'box' }, 'y')
    expect(box?.[0]).toBeCloseTo(0 - 0.3, 12)
    expect(box?.[1]).toBeCloseTo(6 + 0.3, 12)
    expect(figureFit(spec, style, 'x')).toBeNull()
  })

  it('keeps the room a legend down the right takes, so it is never over the plot', () => {
    const long = curve({
      series: [
        { name: 'T4-infection.0min.mcool::5000', x: new Float64Array([1, 2]), y: new Float64Array([1, 2]) },
        { name: 'T4dNDD-infection.10min.mcool::5000', x: new Float64Array([1, 2]), y: new Float64Array([2, 1]) },
      ],
    })
    // Seven pixels a character, so the widths can be checked by hand.
    const measured: FigureTheme = { ...THEME, measure: (text) => text.length * 7 }
    const spec = specOf(long) as XyFigureSpec
    const style = { ...defaultStyle(spec), legend: 'right' as const }
    const wide = optionOf(spec, style, measured, { width: 2000, height: 800 })
    // The edge's 8, the padding's 5 a side, the swatch's 25 and its 5, the
    // longest name's 34 characters, and a gap of the type size.
    expect((wide['grid'] as Record<string, unknown>)['right']).toBe(8 + 10 + 25 + 5 + 34 * 7 + style.fontSize)
    const legend = wide['legend'] as Record<string, unknown>
    expect(legend['itemWidth']).toBe(25)
    expect(legend['padding']).toBe(5)
    expect((legend['formatter'] as (name: string) => string)('T4dNDD-infection.10min.mcool::5000')).toBe(
      'T4dNDD-infection.10min.mcool::5000',
    )
    // In a narrow figure the names wrap, rather than the legend taking the plot.
    const narrow = optionOf(spec, style, measured, { width: 500, height: 400 })
    const room = (narrow['grid'] as Record<string, unknown>)['right'] as number
    expect(room).toBeLessThanOrEqual(500 * 0.35)
    const wrapped = (narrow['legend'] as Record<string, (name: string) => string>)['formatter']('T4dNDD-infection.10min.mcool::5000')
    expect(wrapped.split('\n').length).toBeGreaterThan(1)
    expect(wrapped.replaceAll('\n', '')).toBe('T4dNDD-infection.10min.mcool::5000')
  })

  it('gives a violin the series colour, so its swatch is not the library’s', () => {
    const { option } = build(curve(), (style) => (style.mark = 'violin'))
    expect(seriesOf(option).map((entry) => entry['color'])).toEqual(['#0072B2', '#D55E00'])
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

  it('names the members of an abscissa that is a list, and nothing between two', () => {
    // A curve whose x is a list carries the names (`CurveOutput.xTicks`), and the
    // axis stays a number line so that it keeps its wheel, its marquee and its
    // two typed bounds.
    const { option } = build(curve({ xTicks: ['I', 'II', 'III'] }))
    const axis = option['xAxis'] as {
      minInterval: number
      axisLabel: { formatter: (value: number) => string; hideOverlap: boolean }
    }
    expect(axis.axisLabel.formatter(1)).toBe('II')
    expect(axis.axisLabel.formatter(1.5)).toBe('')
    expect(axis.axisLabel.formatter(7)).toBe('')
    expect(axis.minInterval).toBe(1)
    expect(axis.axisLabel.hideOverlap).toBe(true)
  })

  it('spells an ordinate named in per cent as one', () => {
    const { option } = build(curve({ yLabel: 'Share of the contacts (%)' }))
    const label = (option['yAxis'] as { axisLabel: { formatter: (v: number) => string } }).axisLabel
    // §26.2's *a fraction takes `fmt.pct`*, on the surface that summarises it —
    // and with no idle zeros, which is `axisNumber`'s own complaint one order of
    // magnitude up.
    expect(label.formatter(0.25)).toBe('25%')
    expect(label.formatter(0.933)).toBe('93.3%')
  })

  it('stacks bars that share a stack, and never lines', () => {
    const stacked = curve()
    stacked.series[0].stack = 'contacts'
    stacked.series[1].stack = 'contacts'
    const bars = build(stacked, (style) => (style.mark = 'bars')).option
    expect(seriesOf(bars).map((entry) => entry['stack'])).toEqual(['contacts', 'contacts'])
    // Restyled to lines, the two are the two quantities again rather than one of
    // them and their sum.
    const lines = build(stacked, (style) => (style.mark = 'line')).option
    expect(seriesOf(lines).every((entry) => entry['stack'] === undefined)).toBe(true)
  })

  it('starts a bar’s axis at zero and fits a curve’s to the data', () => {
    const axis = (mark: FigureStyle['mark']): boolean =>
      (build(curve(), (style) => (style.mark = mark)).option['yAxis'] as Record<string, unknown>)[
        'scale'
      ] as boolean
    // A bar is read as its own area, so a floor above zero is a lie about it.
    expect(axis('bars')).toBe(false)
    expect(axis('histogram')).toBe(false)
    // A curve is read as a shape, and a forced zero under a P(s) spends the
    // whole height on empty space.
    expect(axis('line')).toBe(true)
  })

  it('names a histogram’s axes after the quantity and the count', () => {
    const spec = specOf(curve()) as XyFigureSpec
    spec.xLabel = 'rank'
    spec.yLabel = 'completeness'
    const option = optionOf(spec, { ...defaultStyle(spec), mark: 'histogram' }, THEME)
    expect((option['xAxis'] as Record<string, unknown>)['name']).toBe('completeness')
    expect((option['yAxis'] as Record<string, unknown>)['name']).toBe('count')
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

describe('wrapName', () => {
  const measure = (text: string): number => text.length * 7

  it('keeps a name that fits on one line', () => {
    expect(wrapName('P(s)', 100, measure)).toEqual(['P(s)'])
  })

  it('breaks a file name after its own separators, not mid-word', () => {
    expect(wrapName('T4dNDD-infection.10min.mcool::5000', 23 * 7, measure)).toEqual([
      'T4dNDD-infection.10min.',
      'mcool::5000',
    ])
  })

  it('cuts a run with no separator by the letter, as a last resort', () => {
    expect(wrapName('abcdefghij', 4 * 7, measure)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('leaves no space at the end of a line it broke after one', () => {
    expect(wrapName('micro C replicate', 9 * 7, measure)).toEqual(['micro C', 'replicate'])
  })
})

describe('fitOf', () => {
  it('fits a linear span with a twentieth of it at each end', () => {
    expect(fitOf([0, 10], false, 0.05)).toEqual([-0.5, 10.5])
  })

  it('fits a log span in decades, and leaves out what a log axis cannot hold', () => {
    const fit = fitOf([0, -1, 10, 1000], true, 0.05)
    expect(Math.log10(fit?.[0] ?? Number.NaN)).toBeCloseTo(0.9, 12)
    expect(Math.log10(fit?.[1] ?? Number.NaN)).toBeCloseTo(3.1, 12)
  })

  it('is exact with no room, so a first sample is not a hair off the axis', () => {
    expect(fitOf([5000, 2_100_000], true, 0)).toEqual([5000, 2_100_000])
  })

  it('has no fit for one value or none', () => {
    expect(fitOf([3, 3], false, 0.05)).toBeNull()
    expect(fitOf([Number.NaN], false, 0.05)).toBeNull()
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

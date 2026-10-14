/**
 * What the pointer says over a chart, read as the markup it becomes.
 *
 * The chart library writes a tooltip with `innerHTML`, so every string a
 * formatter returns is parsed on every hover — and what a tooltip names is the
 * file's own: a cis/trans square's ticks are its sequences, a correlation's are
 * its tracks, a curve is named after either. A sequence called
 * `<img src=x onerror=…>` ran script the moment the pointer crossed its row.
 *
 * Two properties are pinned here, for every formatter that returns markup:
 * nothing from outside reaches it unescaped, and nothing in it carries a
 * `style=` attribute, which the site's Content-Security-Policy refuses (§11,
 * §15). The second is why the xy figures have a formatter at all: the
 * library's own markup escapes its text and styles itself with attributes.
 *
 * `test/dom/figure-tooltip.test.ts` drives the same formatters through a real
 * chart, which is where the markup is actually parsed.
 */

import { describe, expect, it } from 'vitest'

import { cellTooltip, matrixOptionOf } from '@/figures/matrixOption'
import { optionOf, type FigureTheme } from '@/figures/option'
import { specOf, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle, type FigureStyle } from '@/figures/style'
import { escapeHtml, tipHead, tipRow } from '@/figures/tooltip'
import type { CurveOutput, MatrixOutput } from '@/analysis/types'

/** A name that runs script wherever it is parsed as markup. */
const HOSTILE = '<img src=x onerror="window.pwned=1">'

const THEME: FigureTheme = {
  ink: '#16181d',
  muted: '#5b6169',
  grid: '#dcdfe3',
  background: '#ffffff',
  series: ['#0072B2', '#D55E00', '#009E73'],
  fontFamily: 'system-ui, sans-serif',
}

/** The tags the formatters write themselves; anything else came from outside. */
const OWN_TAGS = /^<\/?(?:div|span|svg|circle|br|b)\b/

/**
 * No tag but the formatters' own, and none carrying a handler or a style.
 *
 * Read tag by tag, with every quoted value emptied first, rather than searched
 * for `onerror=` — which an escaped name still contains *as text*, between two
 * tags or inside a quoted `fill`. The point is that it is no longer an
 * attribute.
 */
function expectInert(markup: string): void {
  for (const [tag] of markup.matchAll(/<[^>]*>/g)) {
    expect(tag).toMatch(OWN_TAGS)
    expect(tag.replace(/"[^"]*"/g, '""')).not.toMatch(/\s(?:on\w+|style)=/i)
  }
}

describe('escapeHtml', () => {
  it('escapes the five characters that open a tag or close an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })

  it('leaves every other character as it was', () => {
    // The names a tooltip is full of: sequences, loci, a separation, a dash.
    for (const text of ['chrIV', 'IV:1,000,001-1,400,000', '84.3 kb', 'MAG_1 · MAG_2', '−0.25', 'αβ']) {
      expect(escapeHtml(text)).toBe(text)
    }
  })

  it('escapes an ampersand once, so an entity in a name is printed as written', () => {
    expect(escapeHtml('a &lt; b')).toBe('a &amp;lt; b')
  })
})

describe('the pieces every tooltip is built from', () => {
  it('escapes a head and both halves of a row', () => {
    expect(tipHead(HOSTILE)).toContain('&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt;')
    const row = tipRow('#0072B2', HOSTILE, HOSTILE)
    expectInert(row)
    expect(row.match(/&lt;img/g)).toHaveLength(2)
  })

  it('draws a series’ colour as an SVG fill, never a style attribute', () => {
    const row = tipRow('#0072B2', 'chrI', '0.25')
    expect(row).toContain('fill="#0072B2"')
    expectInert(row)
  })

  it('cannot be closed out of by a colour, which a workspace file carries', () => {
    const row = tipRow('red"/><img src=x onerror=alert(1)>', 'chrI', '1')
    expectInert(row)
    expect(row).toContain('fill="red&quot;/&gt;&lt;img src=x onerror=alert(1)&gt;"')
  })

  it('draws no swatch where the library hands over no colour string', () => {
    // A gradient arrives as an object; a box's median is about no one series.
    expect(tipRow({ type: 'linear' }, 'median', '2')).not.toContain('<svg')
    expect(tipRow(null, 'median', '2')).not.toContain('<svg')
  })
})

function matrix(overrides: Partial<MatrixOutput> = {}): MatrixOutput {
  return {
    kind: 'matrix',
    id: 'cistrans',
    label: 'Cis/trans',
    nrows: 2,
    ncols: 2,
    values: new Float64Array([1, 0.5, 0.5, 1]),
    xLabel: '',
    yLabel: '',
    xTicks: [],
    yTicks: [],
    colormap: 'fall',
    ...overrides,
  } as MatrixOutput
}

describe('the pointer over a matrix', () => {
  // A cis/trans square names its rows and columns after the file's sequences
  // (`analysis/run/cistrans.ts`, up to forty of them), and a correlation after
  // its tracks.
  const hostile = matrix({ xTicks: [HOSTILE, 'chrII'], yTicks: ['chrI', `${HOSTILE}&`] })

  it('escapes the sequence names it is labelled with', () => {
    const say = cellTooltip(hostile)
    // Column 0, flipped row 0 — which is the last row, the hostile one.
    const markup = say({ value: [0, 0, 0.5] })
    expectInert(markup)
    expect(markup).toContain('&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt;&amp; · &lt;img')
    expect(markup).toContain('<b>0.500</b>')
  })

  it('is the formatter the option hands the library', () => {
    const style = defaultStyle(specOf(hostile) as never) as FigureStyle
    const option = matrixOptionOf(hostile, style, THEME, { width: 400, height: 300 })
    const tooltip = option['tooltip'] as { formatter: (params: { value?: unknown }) => string }
    expectInert(tooltip.formatter({ value: [0, 1, 1] }))
    expect(tooltip.formatter({ value: [0, 1, 1] })).toContain('chrI · &lt;img')
  })
})

function curve(overrides: Partial<CurveOutput> = {}): CurveOutput {
  return {
    kind: 'curve',
    id: 'cistrans-bars',
    label: 'Cis fraction',
    xLabel: 'sequence',
    yLabel: 'contacts',
    xScale: 'linear',
    yScale: 'linear',
    series: [
      { name: HOSTILE, x: new Float64Array([0, 1, 2]), y: new Float64Array([0.25, 0.5, 0.75]) },
      { name: 'trans', x: new Float64Array([0, 1, 2]), y: new Float64Array([0.75, 0.5, 0.25]) },
    ],
    ...overrides,
  }
}

type Formatter = (params: unknown) => string

function formatterOf(output: CurveOutput, edit: (style: FigureStyle) => void = () => {}): Formatter {
  const spec = specOf(output) as XyFigureSpec
  const style = defaultStyle(spec)
  edit(style)
  const tooltip = optionOf(spec, style, THEME)['tooltip'] as { formatter?: Formatter; show?: boolean }
  if (tooltip.formatter === undefined) throw new Error('no formatter')
  return tooltip.formatter
}

/** What the library hands an `axis` formatter: one entry per series under the pointer. */
function axisParams(x: number, rows: Array<[string, number | null, string]>): unknown[] {
  return rows.map(([seriesName, y, color]) => ({
    seriesName,
    seriesType: 'line',
    value: y === null ? null : [x, y],
    color,
    axisValue: x,
  }))
}

describe('the pointer over an xy figure', () => {
  it('has a formatter of its own, so the library’s styled markup is never used', () => {
    const say = formatterOf(curve())
    const markup = say(axisParams(1, [[HOSTILE, 0.5, '#0072B2'], ['trans', 0.5, '#D55E00']]))
    expectInert(markup)
    expect(markup).toContain('&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt;')
  })

  it('names the abscissa as its axis does: a sequence over its bar', () => {
    // The library's own header printed `1.00` for the second sequence.
    const named = curve({ xTicks: ['chrI', HOSTILE, 'chrIII'] })
    const markup = formatterOf(named)(axisParams(1, [['cis', 0.5, '#0072B2']]))
    expect(markup).toMatch(/^<div class="figure-tip-head">&lt;img src=x/)
    expectInert(markup)
  })

  it('spells a separation in base pairs where the axis does', () => {
    const ps = curve({ xLabel: 'Genomic separation (bp)', xTicks: undefined })
    const markup = formatterOf(ps)(axisParams(84281, [['chrI', 2.24e-7, '#0072B2']]))
    expect(markup).toContain('<div class="figure-tip-head">84.3 kb</div>')
  })

  it('spells a probability as its log axis does, not as a run of zeros', () => {
    // The library printed `2.2399771321471442e-7`, and a readout's fixed point
    // `0.000000224`; the axis beside it reads `1e-7`.
    const ps = curve({ xLabel: 'Genomic separation (bp)' })
    const say = formatterOf(ps, (style) => {
      style.y.scale = 'log'
    })
    expect(say(axisParams(84281, [['chrI', 2.2399771321471442e-7, '#0072B2']]))).toContain(
      '<span class="figure-tip-value">2.24e-7</span>',
    )
  })

  it('spells a fraction in per cent where the axis does', () => {
    const shares = curve({ yLabel: 'Share of the sequence’s contacts (%)' })
    const markup = formatterOf(shares)(axisParams(0, [['cis', 0.8758, '#0072B2']]))
    expect(markup).toContain('87.6%')
  })

  it('leaves out a series with no value under the pointer', () => {
    const markup = formatterOf(curve())(axisParams(2, [['a', null, '#0072B2'], ['b', 3, '#D55E00']]))
    expect(markup.match(/figure-tip-row/g)).toHaveLength(1)
  })

  it('names the series and its pair over a point', () => {
    const say = formatterOf(curve(), (style) => {
      style.mark = 'points'
    })
    const markup = say({ seriesName: HOSTILE, seriesType: 'scatter', value: [2, 0.75], color: '#0072B2' })
    expectInert(markup)
    expect(markup).toContain('0.75')
  })

  it('gives a histogram’s bar its count', () => {
    const say = formatterOf(curve(), (style) => {
      style.mark = 'histogram'
    })
    const markup = say({ seriesName: 'trans', seriesType: 'bar', value: [0.5, 12], color: '#D55E00' })
    expect(markup).toContain('<span class="figure-tip-value">12</span>')
  })

  it('reads a box as the five numbers it is drawn from, under the series it summarises', () => {
    const say = formatterOf(curve(), (style) => {
      style.mark = 'box'
    })
    // The library puts the category's index in front of the five.
    const markup = say({ seriesName: 'box', seriesType: 'boxplot', name: HOSTILE, value: [0, 1, 2, 3, 4, 5] })
    expectInert(markup)
    expect(markup).toMatch(/^<div class="figure-tip-head">&lt;img/)
    const values = [...markup.matchAll(/figure-tip-value">([^<]*)</g)].map((match) => match[1])
    expect(values).toEqual(['5', '4', '3', '2', '1'])
  })

  it('names a violin and nothing else, since the shape is the answer', () => {
    const say = formatterOf(curve(), (style) => {
      style.mark = 'violin'
    })
    expect(say({ seriesName: HOSTILE, seriesType: 'custom', value: [0, 0.3] })).toBe(
      tipHead(HOSTILE),
    )
  })

  it('is off with the tooltip, rather than formatting for a box nobody sees', () => {
    const spec = specOf(curve()) as XyFigureSpec
    const style = { ...defaultStyle(spec), tooltip: false }
    expect(optionOf(spec, style, THEME)['tooltip']).toEqual({ show: false })
  })
})

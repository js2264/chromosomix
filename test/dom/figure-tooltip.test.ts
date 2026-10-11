// @vitest-environment jsdom
/**
 * A chart's tooltip, shown by the real library: the one place its markup is
 * actually parsed.
 *
 * `test/unit/figure-tooltip.test.ts` holds the formatters to their strings.
 * This holds the strings to what they become, because the sink is not ours:
 * ECharts writes a tooltip with `innerHTML` (`TooltipHTMLContent.setContent`),
 * and the question that matters is what is in the document afterwards — a
 * sequence's name as text, or an `<img>` whose `onerror` the browser is about
 * to run.
 *
 * The other half is the site's Content-Security-Policy (§11): no element the
 * formatter produced may carry a `style` attribute, because the policy refuses
 * every one of them. The library's own box is styled through the CSSOM and is
 * exempt, which is why only what is *inside* it is checked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { echarts } from '@/figures/echartsBundle'
import { matrixOptionOf } from '@/figures/matrixOption'
import { optionOf, type FigureTheme } from '@/figures/option'
import { specOf, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle } from '@/figures/style'
import type { CurveOutput, MatrixOutput } from '@/analysis/types'
import { setUpDom, type DomTeardown } from '../support/dom'

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

let teardown: DomTeardown
const charts: Array<{ dispose(): void }> = []

beforeEach(() => {
  teardown = setUpDom()
  delete (window as unknown as { pwned?: number }).pwned
})

afterEach(() => {
  for (const chart of charts.splice(0)) chart.dispose()
  teardown()
})

/**
 * A chart of this option, mounted, with the tooltip shown where a pointer over
 * this datum would show it.
 *
 * By **position**, the road a hover takes. Shown by data index instead, the
 * library places the box below the datum and draws it a little arrow with a
 * `style=` of its own — a road nothing in this application takes, since no
 * code here dispatches a tip, and one a pointer never reaches.
 */
function shown(option: Record<string, unknown>, datum: [number, number]): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const chart = echarts.init(host, null, { renderer: 'svg', width: 480, height: 360 })
  charts.push(chart)
  chart.setOption(option, true)
  const [x, y] = chart.convertToPixel({ seriesIndex: 0 }, datum) as number[]
  chart.dispatchAction({ type: 'showTip', x, y })
  // The library's box is the child of the host that holds our markup once the
  // tip is up; the other is the chart's own drawing surface.
  const box = [...host.querySelectorAll('div')].find(
    (div) => div.innerHTML.includes('figure-tip') || div.innerHTML.includes('<b>'),
  )
  if (box === undefined) throw new Error('the tooltip did not show')
  return box
}

/** What came from outside is text, and nothing inside the box is styled by attribute. */
function expectInert(box: HTMLElement): void {
  expect(box.querySelector('img')).toBeNull()
  expect(box.textContent).toContain(HOSTILE)
  expect(box.querySelectorAll('[style]')).toHaveLength(0)
  expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
}

describe('a tooltip shown by the library', () => {
  it('keeps a matrix’s sequence names as text', () => {
    const output = {
      kind: 'matrix',
      id: 'cistrans',
      label: 'Cis/trans',
      nrows: 2,
      ncols: 2,
      values: new Float64Array([1, 0.5, 0.5, 1]),
      xLabel: '',
      yLabel: '',
      xTicks: [HOSTILE, 'chrII'],
      yTicks: [HOSTILE, 'chrII'],
      colormap: 'fall',
    } as unknown as MatrixOutput
    const style = defaultStyle(specOf(output) as never)
    // Column 0 of the top row, which the chart numbers 1 because its ordinate
    // runs upward: both of its names are the hostile one.
    const box = shown(matrixOptionOf(output, style, THEME, { width: 480, height: 360 }), [0, 1])
    expectInert(box)
    expect(box.textContent).toBe(`${HOSTILE} · ${HOSTILE}1.000`)
  })

  it('keeps a curve’s series and abscissa names as text, without the library’s styled markup', () => {
    const output: CurveOutput = {
      kind: 'curve',
      id: 'bars',
      label: 'Cis fraction',
      xLabel: 'sequence',
      yLabel: 'fraction',
      xScale: 'linear',
      yScale: 'linear',
      xTicks: [HOSTILE, 'chrII'],
      series: [
        { name: HOSTILE, x: new Float64Array([0, 1]), y: new Float64Array([0.25, 0.75]) },
        { name: 'trans', x: new Float64Array([0, 1]), y: new Float64Array([0.75, 0.25]) },
      ],
    }
    const spec = specOf(output) as XyFigureSpec
    const box = shown(optionOf(spec, defaultStyle(spec), THEME), [0, 0.25])
    expectInert(box)
    // The series' swatch is a fill, so its colour survives a policy that
    // refuses every `style=` the library's own markup would have carried.
    expect(box.querySelector('.figure-tip-swatch circle')?.getAttribute('fill')).toBe('#0072B2')
    // And the abscissa is named as its axis names it: the hostile name over the
    // first bar, as text, where the library printed `0.00`.
    expect(box.querySelector('.figure-tip-head')?.textContent).toBe(HOSTILE)
  })
})

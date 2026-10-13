// @vitest-environment jsdom
/**
 * A window typed into a figure's axes card while the axis is on *auto*.
 *
 * One end typed is a window: the end not typed is the data's own on that side.
 * It used to wait for the other end, so `x from 5000` sat in its box with the
 * picture still drawn over the whole of the data, and so did `to` after it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CurveOutput } from '@/analysis/types'
import type { FigureTheme } from '@/figures/option'
import { figureSettings } from '@/figures/settings'
import { specOf, type XyFigureSpec } from '@/figures/spec'
import { defaultStyle, type FigureStyle } from '@/figures/style'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  teardown()
})

function ps(): XyFigureSpec {
  const output: CurveOutput = {
    kind: 'curve',
    id: 'ps',
    label: 'P(s)',
    xLabel: 'separation',
    yLabel: 'probability',
    xScale: 'log',
    yScale: 'log',
    series: [
      { name: 'a', x: new Float64Array([0, 2500, 25_000, 250_000, 2_500_000]), y: new Float64Array([1, 1e-4, 1e-5, 1e-6, 1e-8]) },
      { name: 'b', x: new Float64Array([2500, 25_000, 250_000, 5_000_000]), y: new Float64Array([2e-4, 2e-5, 2e-6, 2e-9]) },
    ],
  }
  return specOf(output) as XyFigureSpec
}

/** The axes card, with the style it is given kept as the reader changes it. */
function card(): { el: HTMLElement; style: () => FigureStyle } {
  const spec = ps()
  let style = defaultStyle(spec)
  const view = figureSettings({
    spec,
    style: () => style,
    onChange: (next) => {
      style = next
    },
    onReset: () => {},
    theme: () => ({ series: ['#0072B2', '#D55E00'] }) as FigureTheme,
  })
  return { el: view.el, style: () => style }
}

function type(el: HTMLElement, axis: 'x' | 'y', at: 0 | 1, value: string): void {
  const row = [...el.querySelectorAll<HTMLElement>('.figure-range')].find((range) =>
    range.textContent?.startsWith(`${axis} from`),
  )
  const box = row?.querySelectorAll<HTMLInputElement>('input')[at]
  if (box === undefined) throw new Error(`no ${axis} box`)
  box.value = value
  box.dispatchEvent(new Event('change'))
}

describe('a window typed on an axis that fits the data', () => {
  it('takes one end typed, and the data’s own at the other', () => {
    const { el, style } = card()
    type(el, 'x', 0, '5000')
    // The highest x drawn; a zero on a log axis is a gap, never an end.
    expect(style().x.domain).toEqual([5000, 5_000_000])
  })

  it('takes the high end alone, with the lowest positive value under it on a log axis', () => {
    const { el, style } = card()
    type(el, 'y', 1, '1e-3')
    expect(style().y.domain).toEqual([2e-9, 1e-3])
  })

  it('leaves out the series that are hidden', () => {
    const { el, style } = card()
    const spec = ps()
    style().hidden = [spec.series[1].id]
    type(el, 'x', 0, '5000')
    expect(style().x.domain).toEqual([5000, 2_500_000])
  })
})

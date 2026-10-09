// @vitest-environment jsdom
/**
 * A table drawn as a chart (§18.13): the style its chart is given, and the axes
 * card its scatter has.
 *
 * The chart a table becomes is built with a style of its own — the plot's mark,
 * and a legend only for a fitted line — and an update in place used to hand it
 * the reader's style instead, so a title or a type size set on a time course's
 * scatter drew it as the table's default line with its fitted line's legend
 * moved aside. And its axes took the columns' names, `number in Map`, with no
 * card to call them anything else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TableOutput } from '@/analysis/types'
import { drawnStyle, tableChart } from '@/figures/FigureBlock'
import type { FigureTheme } from '@/figures/option'
import { figureSettings } from '@/figures/settings'
import { specOf, type TableFigureSpec } from '@/figures/spec'
import { defaultStyle, type FigureStyle } from '@/figures/style'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  teardown()
})

function course(): TableFigureSpec {
  const output: TableOutput = {
    kind: 'table',
    id: 'interarm-table__all',
    label: 'Inter-arm alignment per sequence — all maps',
    columns: [
      { key: 'map', label: 'Map', kind: 'text' },
      { key: 'reach', label: 'reach', kind: 'number' },
    ],
    rows: [
      { map: 'WT', reach: 2_000_000 },
      { map: '+parB 15 min', reach: 35 },
      { map: '+parB 30 min', reach: 65 },
      { map: '+parB 45 min', reach: 95 },
    ],
  }
  const spec = specOf(output)
  if (spec === null || spec.kind !== 'table') throw new Error('not a table')
  return spec
}

/** The table's own style — a line, its legend at the right — drawn as a scatter of the reach in time. */
function scatter(fit: boolean, legend: FigureStyle['legend'] = 'right'): FigureStyle {
  return { ...defaultStyle(course()), legend, plot: { x: 'map', y: 'reach', mark: 'points', fit } }
}

describe('the style a table’s chart is drawn with', () => {
  it('is the plot’s mark, with a legend only for a fitted line, over the picture', () => {
    const fitted = tableChart(course(), scatter(true))
    expect(fitted?.style.mark).toBe('points')
    expect(fitted?.style.legend).toBe('top')
    expect(fitted?.spec.series.map((series) => series.id)).toEqual(['reach', 'least-squares'])
    expect(tableChart(course(), scatter(true, 'none'))?.style.legend).toBe('none')
    expect(tableChart(course(), scatter(false))?.style.legend).toBe('none')
    // The table itself is not a chart.
    expect(tableChart(course(), defaultStyle(course()))).toBeNull()
  })

  it('is what an update in place hands the chart, as the build did', () => {
    // A type size raised on the scatter: the reader's style still says `line` and `right`.
    const raised = { ...scatter(true), fontSize: 22 }
    expect(drawnStyle(course(), raised)).toMatchObject({ mark: 'points', legend: 'top', fontSize: 22 })
  })
})

describe('the settings beside a table drawn as a scatter', () => {
  function column(style: FigureStyle): HTMLElement {
    return figureSettings({
      spec: course(),
      style: () => style,
      onChange: () => {},
      onReset: () => {},
      theme: () => ({}) as FigureTheme,
    }).el
  }

  it('offer its axes, named by the columns until the reader names them', () => {
    const el = column(scatter(true))
    expect(textsOf(el, '.figure-group-head')).toContain('axes')
    expect(textsOf(el, '.field-label')).toEqual(expect.arrayContaining(['x name', 'y name']))
    const names = [...el.querySelectorAll<HTMLInputElement>('input[type="text"]')].map((box) => box.placeholder)
    expect(names).toEqual(expect.arrayContaining(['number in Map', 'reach']))
  })

  it('offer none to the table itself, or to a column drawn on its own', () => {
    expect(textsOf(column(defaultStyle(course())), '.figure-group-head')).not.toContain('axes')
    const alone = { ...defaultStyle(course()), plot: { x: null, y: 'reach', mark: 'histogram' as const, fit: false } }
    expect(textsOf(column(alone), '.figure-group-head')).not.toContain('axes')
  })
})

/**
 * A result matrix, as the chart library's option object (§18.13).
 *
 * The module is pure by design — a spec, a style and a theme in, a plain object
 * out — so the whole of *what the picture is* can be checked without a browser,
 * which is the argument `option.ts` already makes for the curves.
 *
 * Four things are worth pinning and none of them is visible in a screenshot:
 *
 * - the **ordinate runs down**, so the first row of the output is the top row of
 *   the picture, as it is in every contact map in this application;
 * - the **colour scale** is the painter's rule, symmetric about a declared
 *   centre, with what the reader typed above everything;
 * - a **gap is a gap**: a non-finite cell is left out rather than drawn, so the
 *   background shows through where nothing was measured;
 * - the **ticks** are spread onto the cells they name, because `MatrixOutput`
 *   states five labels for a forty-three-column axis and a category axis wants
 *   one per category.
 */

import { describe, expect, it } from 'vitest'

import {
  cellTooltip,
  drawnAsChart,
  matrixScale,
  matrixOptionOf,
  MATRIX_CHART_CELLS,
  rampOf,
  spreadTicks,
} from '@/figures/matrixOption'
import { defaultStyle } from '@/figures/style'
import type { FigureTheme } from '@/figures/option'
import type { MatrixOutput } from '@/analysis/types'

const THEME: FigureTheme = {
  ink: '#111',
  muted: '#666',
  grid: '#ddd',
  background: '#fff',
  series: ['#1f77b4', '#ff7f0e'],
  fontFamily: 'sans-serif',
}

function matrix(over: Partial<MatrixOutput> = {}): MatrixOutput {
  const nrows = over.nrows ?? 3
  const ncols = over.ncols ?? 3
  return {
    kind: 'matrix',
    id: 'm',
    label: 'a matrix',
    nrows,
    ncols,
    values: over.values ?? Float32Array.from({ length: nrows * ncols }, (_, i) => i),
    xLabel: 'columns',
    yLabel: 'rows',
    xTicks: [],
    yTicks: [],
    colormap: 'viridis',
    ...over,
  }
}

const STYLE = defaultStyle({ kind: 'matrix', id: 'm', label: 'a matrix', output: matrix() })

/** A box the size of a figure in the drawer. */
const BOX = { width: 620, height: 480 }

/** The heatmap series out of a built option. */
function cells(option: Record<string, unknown>): Array<[number, number, number]> {
  const series = option['series'] as Array<Record<string, unknown>>
  const heat = series.find((one) => one['type'] === 'heatmap')
  return (heat?.['data'] ?? []) as Array<[number, number, number]>
}

describe('which matrices the chart draws', () => {
  it('takes the ones this was asked for — a pileup, a saddle, a cis/trans square', () => {
    expect(drawnAsChart(matrix({ nrows: 43, ncols: 43 }))).toBe(true)
    expect(drawnAsChart(matrix({ nrows: 51, ncols: 51 }))).toBe(true)
    expect(drawnAsChart(matrix({ nrows: 17, ncols: 17 }))).toBe(true)
  })

  it('leaves the per-feature heatmap to the painter, which is thousands of rows', () => {
    // One rect per cell in an SVG is what makes a heatmap hoverable and what
    // puts a ceiling on it. Half a million is not a picture anybody can point
    // at, so the interaction it would buy does not exist at that size either.
    expect(drawnAsChart(matrix({ nrows: 5_000, ncols: 100 }))).toBe(false)
    expect(drawnAsChart(matrix({ nrows: 1, ncols: MATRIX_CHART_CELLS + 1 }))).toBe(false)
    expect(drawnAsChart(matrix({ nrows: 1, ncols: MATRIX_CHART_CELLS }))).toBe(true)
  })

  it('leaves a list to the painter, however few its cells — one picture, not a grid to point at', () => {
    // The metaplot's per-feature heatmap: its rows are features read as a
    // density, so a rect per cell with a seam, a hover border and a tooltip made
    // a grid of squares of it (§18.8).
    expect(drawnAsChart(matrix({ nrows: 40, ncols: 8, aspect: 'fill' }))).toBe(false)
    expect(drawnAsChart(matrix({ nrows: 40, ncols: 8 }))).toBe(true)
  })

  it('leaves a picture read like a map to the painter, however few its cells', () => {
    // A dot plot's axes are its sequences end to end, which the painter marks
    // and a category axis cannot (§28).
    expect(drawnAsChart(matrix({ nrows: 60, ncols: 60, large: true }))).toBe(false)
  })

  it('refuses an empty one rather than drawing an empty chart', () => {
    expect(drawnAsChart(matrix({ nrows: 0, ncols: 0, values: new Float32Array(0) }))).toBe(false)
  })
})

describe('the cells', () => {
  it('puts the output’s first row at the top of the picture', () => {
    // A category axis numbers upward from the bottom, so the row index is
    // flipped once — here — rather than everywhere that reads it. Row 0 of a
    // 3-row matrix is category 2, which is the top.
    const option = matrixOptionOf(matrix(), STYLE, THEME, BOX)
    const top = cells(option).filter(([, y]) => y === 2)
    expect(top.map(([, , value]) => value)).toEqual([0, 1, 2])
    const bottom = cells(option).filter(([, y]) => y === 0)
    expect(bottom.map(([, , value]) => value)).toEqual([6, 7, 8])
  })

  it('leaves a gap out rather than drawing it', () => {
    const values = Float32Array.from([1, Number.NaN, 3, 4, 5, 6, 7, 8, 9])
    const option = matrixOptionOf(matrix({ values }), STYLE, THEME, BOX)
    expect(cells(option)).toHaveLength(8)
    expect(cells(option).some(([, , value]) => Number.isNaN(value))).toBe(false)
  })

  it('reverses the ordinate’s labels with its cells, so a tick names its own row', () => {
    const option = matrixOptionOf(matrix({ yTicks: ['top', 'middle', 'bottom'] }), STYLE, THEME, BOX)
    const y = (option['yAxis'] as Array<Record<string, unknown>>)[0]
    expect(y['data']).toEqual(['bottom', 'middle', 'top'])
  })
})

describe('the colour scale', () => {
  it('is fitted to the data where nothing says otherwise', () => {
    expect(matrixScale(matrix())).toEqual({ vmin: 0, vmax: 8 })
  })

  it('stays symmetric about a declared centre', () => {
    // A scale fitted to the extremes of a ratio moves its own white point with
    // the data, which is the one thing a diverging scale must not do.
    const values = Float32Array.from([0.5, 1, 1, 3])
    expect(matrixScale(matrix({ nrows: 2, ncols: 2, values, centre: 1 }))).toEqual({
      vmin: -1,
      vmax: 3,
    })
  })

  it('gives a constant matrix a readable span rather than dividing by zero', () => {
    const values = Float32Array.from([1, 1, 1, 1])
    expect(matrixScale(matrix({ nrows: 2, ncols: 2, values, centre: 1 }))).toEqual({
      vmin: 0,
      vmax: 2,
    })
  })

  it('keeps a range the task fixed, so two pileups are the same picture', () => {
    expect(matrixScale(matrix({ range: [0, 2] }))).toEqual({ vmin: 0, vmax: 2 })
  })

  it('puts what the reader typed above both', () => {
    const fixed = matrix({ range: [0, 2], centre: 1 })
    expect(matrixScale(fixed, { vmin: -5, vmax: 5 })).toEqual({ vmin: -5, vmax: 5 })
    // One end alone is the reader's; the other comes off the data.
    expect(matrixScale(matrix(), { vmin: null, vmax: 4 })).toEqual({ vmin: 0, vmax: 4 })
  })

  it('ignores a pair that is not a scale rather than drawing nothing', () => {
    expect(matrixScale(matrix(), { vmin: 8, vmax: 2 })).toEqual({ vmin: 0, vmax: 8 })
  })

  it('has nothing to say about a matrix with no finite cell', () => {
    const values = Float32Array.from([Number.NaN, Number.NaN])
    expect(matrixScale(matrix({ nrows: 1, ncols: 2, values }))).toBeNull()
  })
})

describe('the colour bar', () => {
  it('is this application’s ramp, not the library’s palette', () => {
    // The same tables matplotlib ships and the contact map draws with: a saddle
    // plot in the drawer and one in a paper have to be the same picture.
    const stops = rampOf('viridis')
    expect(stops).toHaveLength(32)
    expect(stops[0]).toMatch(/^rgb\(/)
    expect(stops[0]).not.toBe(stops[stops.length - 1])
  })

  it('falls back to the default rather than throwing on a name nobody knows', () => {
    expect(rampOf('not-a-colormap')).toEqual(rampOf('afmhot_r'))
  })

  it('is drawn, and only about the matrix’s own series', () => {
    const option = matrixOptionOf(matrix(), STYLE, THEME, BOX) as Record<string, Record<string, unknown>>
    expect(option['visualMap']['calculable']).toBe(true)
    // The marginal profiles are a second quantity in their own units; colouring
    // them by the matrix's scale would be a claim nobody made.
    expect(option['visualMap']['seriesIndex']).toBe(0)
  })

  it('is absent where there is no scale to draw', () => {
    const values = Float32Array.from([Number.NaN, Number.NaN])
    const option = matrixOptionOf(matrix({ nrows: 1, ncols: 2, values }), STYLE, THEME, BOX)
    expect(option['visualMap']).toBeUndefined()
  })
})

describe('the ticks', () => {
  it('puts the two end labels on the two end cells', () => {
    // A pileup's ticks are a scale laid across the axis — `-100 kb`, `0`,
    // `+100 kb` — and a first label that landed four cells in would be naming a
    // window the picture is not drawing.
    expect(spreadTicks(['a', 'b'], 4)).toEqual(['a', '', '', 'b'])
    expect(spreadTicks(['-100 kb', '0', '+100 kb'], 5)).toEqual([
      '-100 kb',
      '',
      '0',
      '',
      '+100 kb',
    ])
  })

  it('leaves one label per cell alone, which names its own cell', () => {
    expect(spreadTicks(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c'])
  })

  it('puts a lone label in the middle, since it is about the whole axis', () => {
    expect(spreadTicks(['all of it'], 3)).toEqual(['', 'all of it', ''])
  })

  it('answers a blank per cell where the output gave none', () => {
    expect(spreadTicks([], 3)).toEqual(['', '', ''])
  })

  it('keeps both ends where there are more labels than cells', () => {
    expect(spreadTicks(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'd'])
  })
})

describe('the pointer', () => {
  it('names the row, the column and the value', () => {
    const out = matrix({ xTicks: ['left', 'mid', 'right'], yTicks: ['top', 'middle', 'bottom'] })
    const say = cellTooltip(out)
    // Category 2 on the ordinate is row 0 — the top.
    expect(say({ value: [0, 2, 1.25] })).toContain('top')
    expect(say({ value: [0, 2, 1.25] })).toContain('left')
    expect(say({ value: [0, 2, 1.25] })).toContain('1.250')
  })

  it('falls back to a row and column number where the axis has no labels', () => {
    const say = cellTooltip(matrix())
    expect(say({ value: [1, 1, 4] })).toContain('row 2')
    expect(say({ value: [1, 1, 4] })).toContain('column 2')
  })

  it('says nothing about something that is not a cell', () => {
    expect(cellTooltip(matrix())({ value: undefined })).toBe('')
  })
})

describe('the marginal profiles', () => {
  const withMargins = matrix({
    margins: {
      top: [{ name: 'CTCF', values: Float64Array.from([1, 2, 3]) }],
      right: [{ name: 'CTCF', values: Float64Array.from([3, 2, 1]) }],
    },
  })

  it('ride on grids of their own, above and beside the picture', () => {
    const option = matrixOptionOf(withMargins, STYLE, THEME, BOX)
    expect((option['grid'] as unknown[]).length).toBe(3)
    const series = option['series'] as Array<Record<string, unknown>>
    expect(series.filter((one) => one['type'] === 'line')).toHaveLength(2)
  })

  it('leave the frame to the picture, being its margins rather than plots of their own', () => {
    const grids = matrixOptionOf(withMargins, STYLE, THEME, BOX)['grid'] as Array<Record<string, unknown>>
    // The picture framed in the ink, over its cells (§18.13)…
    expect(grids[0]['show']).toBe(true)
    expect(grids[0]['borderColor']).toBe(THEME.ink)
    expect(grids[0]['z']).toBeGreaterThan(2)
    // …and the two bands not.
    expect(grids[1]['show']).toBeUndefined()
    expect(grids[2]['show']).toBeUndefined()
  })

  it('zoom with the picture, since a marginal that stayed put is of somewhere else', () => {
    const option = matrixOptionOf(withMargins, STYLE, THEME, BOX)
    const zooms = option['dataZoom'] as Array<Record<string, unknown>>
    expect(zooms[0]['xAxisIndex']).toEqual([0, 1])
    expect(zooms[1]['yAxisIndex']).toEqual([0, 2])
  })

  it('stay out of the tooltip, which is about the cell under the pointer', () => {
    const option = matrixOptionOf(withMargins, STYLE, THEME, BOX)
    const lines = (option['series'] as Array<Record<string, unknown>>).filter(
      (one) => one['type'] === 'line',
    )
    for (const line of lines) expect(line['silent']).toBe(true)
  })

  it('are drawn against their own extent, so a doubling looks like a doubling', () => {
    // A ChIP aggregate whose baseline is 45 and whose anchor is 92. Drawn from
    // zero it is a line across the top of a band three lines tall with a nick
    // in it; drawn against itself it is the peak the same numbers make as a
    // curve two blocks down the drawer.
    const chip = matrix({
      margins: { top: [{ name: 'Scc1', values: Float64Array.from([45, 92, 45]) }] },
    })
    const option = matrixOptionOf(chip, STYLE, THEME, BOX)
    const line = (option['series'] as Array<Record<string, unknown>>).find(
      (one) => one['type'] === 'line',
    )
    expect(line?.['data']).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
    ])
  })

  it('share one ruler between the two edges, being one measurement', () => {
    const both = matrix({
      margins: {
        top: [{ name: 'Scc1', values: Float64Array.from([45, 92, 45]) }],
        // Half the height in its own units, and half as tall on the picture.
        right: [{ name: 'Scc1', values: Float64Array.from([45, 68.5, 45]) }],
      },
    })
    const option = matrixOptionOf(both, STYLE, THEME, BOX)
    const lines = (option['series'] as Array<Record<string, unknown>>).filter(
      (one) => one['type'] === 'line',
    )
    const beside = lines[1]?.['data'] as Array<[number, number]>
    // The right band runs down with the rows, so its profile is reversed.
    expect(beside.map(([height]) => height)).toEqual([0, 0.5, 0])
  })

  it('carry a key naming each track and the range it is drawn against', () => {
    const option = matrixOptionOf(
      matrix({ margins: { top: [{ name: 'Scc1', values: Float64Array.from([45, 92, 45]) }] } }),
      STYLE,
      THEME,
      BOX,
    )
    const legend = option['legend'] as Record<string, unknown>
    expect((legend['data'] as Array<{ name: string }>)[0].name).toBe('Scc1')
    const formatter = legend['formatter'] as (name: string) => string
    expect(formatter('Scc1')).toContain('45')
    expect(formatter('Scc1')).toContain('92')
    // A name nobody has a scale for is still a name, not a crash.
    expect(formatter('nobody')).toBe('nobody')
  })

  it('are absent, with their grids, where the output has none', () => {
    const option = matrixOptionOf(matrix(), STYLE, THEME, BOX)
    expect((option['grid'] as unknown[]).length).toBe(1)
    expect((option['series'] as unknown[]).length).toBe(1)
  })
})

describe('which tick labels the axis draws', () => {
  /** The abscissa of a built option. */
  function abscissa(option: Record<string, unknown>): Record<string, Record<string, unknown>> {
    return (option['xAxis'] as Array<Record<string, Record<string, unknown>>>)[0]
  }

  it('draws every one of a scale laid across the axis, blanks and all', () => {
    // Five distances over forty-three columns, spread onto the cells they
    // name. The library thins by counting *categories* — the blanks included —
    // so left to itself a pileup shows two of the five numbers there were to
    // read, and which two depends on how wide the card happens to be.
    const pileup = matrix({
      nrows: 43,
      ncols: 43,
      values: new Float32Array(43 * 43),
      xTicks: ['-21 kb', '-10.5 kb', '0', '+10.5 kb', '+21 kb'],
      yTicks: ['-21 kb', '-10.5 kb', '0', '+10.5 kb', '+21 kb'],
    })
    const option = matrixOptionOf(pileup, STYLE, THEME, BOX)
    expect(abscissa(option)['axisLabel']['interval']).toBe(0)
    const ordinate = (option['yAxis'] as Array<Record<string, Record<string, unknown>>>)[0]
    expect(ordinate['axisLabel']['interval']).toBe(0)
  })

  it('leaves one label per cell to the library, which thins a wall of them', () => {
    // A saddle's fifty quantile groups or a cis/trans square's sequences: each
    // label names its own cell, and drawing all fifty is a row of numbers on
    // top of each other rather than an axis.
    const saddle = matrix({ xTicks: ['a', 'b', 'c'], yTicks: ['a', 'b', 'c'] })
    const option = matrixOptionOf(saddle, STYLE, THEME, BOX)
    expect(abscissa(option)['axisLabel']['interval']).toBeUndefined()
  })

  it('says nothing about an axis with no labels at all', () => {
    const option = matrixOptionOf(matrix(), STYLE, THEME, BOX)
    expect(abscissa(option)['axisLabel']['interval']).toBeUndefined()
  })
})

describe('the shape of the picture', () => {
  /** The main grid, which is the picture itself. */
  function picture(option: Record<string, unknown>): Record<string, number> {
    return (option['grid'] as Array<Record<string, number>>)[0]
  }

  it('is square where both axes are the same quantity, whatever the box is', () => {
    // A saddle is read by comparing its two corners. Left to stretch with the
    // box, a corner 40% wider than the one opposite it looks stronger than it
    // is, which is a claim the numbers do not make.
    const square = matrix({ nrows: 20, ncols: 20 })
    for (const box of [
      { width: 900, height: 400 },
      { width: 400, height: 900 },
      { width: 620, height: 480 },
    ]) {
      const grid = picture(matrixOptionOf(square, STYLE, THEME, box))
      expect(Math.round(grid['width'])).toBe(Math.round(grid['height']))
      expect(grid['width']).toBeLessThanOrEqual(box.width)
      expect(grid['height']).toBeLessThanOrEqual(box.height)
    }
  })

  it('centres the slack rather than pooling it against the colour bar', () => {
    // Three hundred more pixels of box, with the height still binding: the
    // picture is the same size and has moved half of them to the right.
    const narrow = picture(matrixOptionOf(matrix(), STYLE, THEME, { width: 600, height: 400 }))
    const wide = picture(matrixOptionOf(matrix(), STYLE, THEME, { width: 900, height: 400 }))
    expect(wide['width']).toBeCloseTo(narrow['width'], 5)
    expect(wide['left'] - narrow['left']).toBeCloseTo(150, 5)
  })

  it('gives the whole box to a matrix whose rows are a list', () => {
    // One row per feature against distance from the anchor: no diagonal, so
    // nothing is compared across one, and the picture is the block every
    // metaplot tool draws rather than a ribbon down the middle of the card.
    const tall = matrix({ nrows: 40, ncols: 8, aspect: 'fill' })
    const grid = picture(matrixOptionOf(tall, STYLE, THEME, { width: 900, height: 400 }))
    const square = picture(matrixOptionOf(matrix({ nrows: 40, ncols: 8 }), STYLE, THEME, {
      width: 900,
      height: 400,
    }))
    expect(grid['width']).toBeGreaterThan(square['width'] * 4)
    expect(grid['height']).toBeCloseTo(square['height'], 5)
  })

  it('puts the marginal bands against the picture’s own edges', () => {
    const option = matrixOptionOf(
      matrix({
        margins: {
          top: [{ name: 'CTCF', values: Float64Array.from([1, 2, 3]) }],
          right: [{ name: 'CTCF', values: Float64Array.from([3, 2, 1]) }],
        },
      }),
      STYLE,
      THEME,
      { width: 900, height: 400 },
    )
    const grids = option['grid'] as Array<Record<string, number>>
    const [main, top, right] = grids
    // A profile that shared the abscissa's range but not its pixels would be a
    // curve of somewhere else.
    expect(top['left']).toBe(main['left'])
    expect(top['width']).toBe(main['width'])
    expect(top['top'] + top['height']).toBeLessThanOrEqual(main['top'])
    expect(right['left']).toBeGreaterThanOrEqual(main['left'] + main['width'])
    expect(right['top']).toBe(main['top'])
    expect(right['height']).toBe(main['height'])
  })
})

describe('the numbers under the picture', () => {
  it('are a subtitle, because they are about the whole of it', () => {
    const option = matrixOptionOf(
      matrix({ stats: [{ label: 'P2LL', value: 1.324, digits: 2 }] }),
      STYLE,
      THEME,
      BOX,
    )
    const titles = option['title'] as Array<Record<string, unknown>>
    expect(titles.some((one) => String(one['text']).includes('P2LL 1.32'))).toBe(true)
  })
})

// @vitest-environment jsdom
/**
 * Where a matrix figure puts its marginal profiles.
 *
 * The arithmetic behind them is checked where it happens (`analysis-apa-margins`);
 * what is checked here is the *layout*, which is the half a reader notices and
 * the half that goes wrong silently. Two bands are added to a figure that has
 * always fitted exactly into the height it asked for, so the two failures are a
 * band drawn over the picture and a band drawn off the end of the canvas —
 * neither of which any assertion about the profile's values could see.
 */

import { describe, expect, it } from 'vitest'

import { drawMatrix, plotTheme } from '@/ui/analysisPlots'
import type { MatrixOutput } from '@/analysis/types'

interface Stroke {
  from: [number, number]
  to: [number, number]
  style: string
}

/**
 * A context that records the strokes and the filled rectangles.
 *
 * The profiles are strokes — a line over a translucent area — so the lines are
 * what says where a band landed.
 */
function recorder(): {
  ctx: CanvasRenderingContext2D
  strokes: Stroke[]
  rects: Array<{ x: number; y: number; w: number; h: number; fill: string }>
} {
  const strokes: Stroke[] = []
  const rects: Array<{ x: number; y: number; w: number; h: number; fill: string }> = []
  let path: Array<[number, number]> = []
  const state = { fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1 }
  const ctx = {
    canvas: { width: 0, height: 0 },
    get fillStyle() {
      return state.fillStyle
    },
    set fillStyle(v: string) {
      state.fillStyle = v
    },
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v
    },
    get globalAlpha() {
      return state.globalAlpha
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v
    },
    lineWidth: 1,
    font: '11px sans-serif',
    textAlign: '',
    textBaseline: '',
    save: () => {},
    restore: () => {},
    beginPath: () => {
      path = []
    },
    closePath: () => {},
    moveTo: (x: number, y: number) => path.push([x, y]),
    lineTo: (x: number, y: number) => path.push([x, y]),
    rect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) =>
      rects.push({ x, y, w, h, fill: String(state.fillStyle) }),
    strokeRect: () => {},
    clearRect: () => {},
    stroke: () => {
      for (let i = 1; i < path.length; i++) {
        strokes.push({ from: path[i - 1], to: path[i], style: String(state.strokeStyle) })
      }
      path = []
    },
    fill: () => {
      path = []
    },
    fillText: () => {},
    strokeText: () => {},
    measureText: (text: string) => ({ width: text.length * 5, actualBoundingBoxAscent: 7 }),
    translate: () => {},
    rotate: () => {},
    setLineDash: () => {},
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop: () => {} }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, rects }
}

const SIDE = 9

function matrix(over: Partial<MatrixOutput> = {}): MatrixOutput {
  const values = new Float32Array(SIDE * SIDE)
  for (let i = 0; i < values.length; i++) values[i] = i / values.length
  return {
    kind: 'matrix',
    id: 'pileup',
    label: 'APA',
    nrows: SIDE,
    ncols: SIDE,
    values,
    xLabel: 'Distance from the centre',
    yLabel: 'Distance from the centre',
    xTicks: [],
    yTicks: [],
    colormap: 'default',
    ...over,
  }
}

/** A profile with a single peak in the middle, like a real anchor aggregate. */
function peak(): Float64Array {
  return Float64Array.from({ length: SIDE }, (_, i) => (i === (SIDE - 1) / 2 ? 1 : 0))
}

const BOX = { width: 420, height: 420 }

function theme(): ReturnType<typeof plotTheme> {
  return plotTheme(document.createElement('div'))
}

function draw(output: MatrixOutput): ReturnType<typeof recorder> {
  const made = recorder()
  drawMatrix(made.ctx, output, BOX, theme())
  return made
}

/**
 * The matrix's own cells, told from everything else this figure fills.
 *
 * A cell is **square** — that is the rule `squareCell` exists to keep — and it
 * is smaller than the box. The background is the box, the colour bar's segments
 * are a thin column, and the key's chips are a short dash; none of the three is
 * a square smaller than the figure.
 */
function cells(
  made: ReturnType<typeof recorder>,
): Array<{ x: number; y: number; w: number; h: number }> {
  return made.rects.filter((rect) => rect.w === rect.h && rect.w > 1 && rect.w < BOX.width)
}

describe('a matrix with no margins', () => {
  it('draws no profile strokes at all', () => {
    const { strokes } = draw(matrix())
    // Only the axis ticks and the colour bar's, none of which are diagonal runs
    // of many points.
    expect(strokes.every((stroke) => stroke.from[0] === stroke.to[0] || stroke.from[1] === stroke.to[1])).toBe(
      true,
    )
  })
})

describe('the top band', () => {
  it('is drawn above the picture, never over it', () => {
    const plain = draw(matrix())
    const withTop = draw(matrix({ margins: { top: [{ name: 'CTCF', values: peak() }] } }))
    // The picture is pushed down by the band, so its cells start lower.
    const firstCell = (made: ReturnType<typeof recorder>): number =>
      Math.min(...cells(made).map((rect) => rect.y))
    expect(cells(plain).length).toBeGreaterThan(0)
    expect(firstCell(withTop)).toBeGreaterThan(firstCell(plain))
  })

  it('keeps every stroke inside the canvas', () => {
    const { strokes } = draw(matrix({ margins: { top: [{ name: 'CTCF', values: peak() }] } }))
    for (const stroke of strokes) {
      for (const [x, y] of [stroke.from, stroke.to]) {
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(BOX.height)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(BOX.width)
      }
    }
  })
})

describe('the right band', () => {
  it('narrows the picture rather than overlapping the colour bar', () => {
    const plain = draw(matrix())
    const withRight = draw(matrix({ margins: { right: [{ name: 'CTCF', values: peak() }] } }))
    const widest = (made: ReturnType<typeof recorder>): number =>
      Math.max(...cells(made).map((rect) => rect.x + rect.w))
    expect(widest(withRight)).toBeLessThan(widest(plain))
  })
})

describe('the ruler a band is drawn against', () => {
  /** The colour a profile with none of its own is drawn in. */
  const INK = theme().series[0]

  /** How tall the profile's own strokes run, as a share of the band. */
  function reach(made: ReturnType<typeof recorder>): number {
    // The profile is the only thing drawn in a *series* colour; the ticks, the
    // frame and the band's baseline are the theme's grey.
    const ink = made.strokes.filter((stroke) => stroke.style === INK)
    const ys = ink.flatMap((stroke) => [stroke.from[1], stroke.to[1]])
    return ys.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys)
  }

  /**
   * A ChIP aggregate: a baseline well above zero, doubling at the anchor. The
   * shape is the thing the band exists to show, and drawn from zero it is a
   * line across the top of the band with a nick in it.
   */
  function chip(): Float64Array {
    return Float64Array.from({ length: SIDE }, (_, i) => (i === (SIDE - 1) / 2 ? 92 : 45))
  }

  it('is the profile’s own extent, so a doubling looks like a doubling', () => {
    const high = draw(matrix({ margins: { top: [{ name: 'Scc1', values: chip() }] } }))
    const zeroed = draw(matrix({ margins: { top: [{ name: 'Scc1', values: peak() }] } }))
    // The same shape drawn from its own floor covers the same band, whether the
    // numbers run 0–1 or 45–92.
    expect(reach(high)).toBeCloseTo(reach(zeroed), 5)
    expect(reach(high)).toBeGreaterThan(0)
  })

  it('is shared by the two edges, so a bump above means what a bump beside does', () => {
    // The right-hand profile is half the height of the top one in its own
    // units; on one ruler it must be drawn half as tall, not stretched to the
    // same band.
    const made = draw(
      matrix({
        margins: {
          top: [{ name: 'Scc1', values: chip() }],
          right: [
            {
              name: 'Scc1',
              values: Float64Array.from({ length: SIDE }, (_, i) =>
                i === (SIDE - 1) / 2 ? 68.5 : 45,
              ),
            },
          ],
        },
      }),
    )
    const ink = made.strokes.filter((stroke) => stroke.style === INK)
    // Which band a stroke belongs to is *where it is*: the top band is above
    // the picture and the right band is beside it.
    const picture = cells(made)
    const above = Math.min(...picture.map((rect) => rect.y))
    const beside = Math.max(...picture.map((rect) => rect.x + rect.w))
    const spread = (list: Stroke[], axis: 0 | 1): number => {
      const all = list.flatMap((stroke) => [stroke.from[axis], stroke.to[axis]])
      return all.length === 0 ? 0 : Math.max(...all) - Math.min(...all)
    }
    const isTop = (stroke: Stroke): boolean => stroke.from[1] <= above && stroke.to[1] <= above
    const top = ink.filter(isTop)
    const right = ink.filter(
      (stroke) => !isTop(stroke) && stroke.from[0] >= beside && stroke.to[0] >= beside,
    )
    expect(spread(top, 1)).toBeGreaterThan(0)
    expect(spread(right, 0)).toBeCloseTo(spread(top, 1) / 2, 0)
  })
})

describe('both bands at once', () => {
  it('draws a line for each profile on each side', () => {
    const made = draw(
      matrix({
        margins: {
          top: [
            { name: 'CTCF', values: peak() },
            { name: 'Rad21', values: peak() },
          ],
          right: [{ name: 'CTCF', values: peak() }],
        },
      }),
    )
    // A profile of nine cells is eight segments; three profiles is at least
    // twenty-four, over and above the ticks and the frame.
    expect(made.strokes.length).toBeGreaterThanOrEqual(24)
  })

  it('survives a profile that is all gaps', () => {
    expect(() =>
      draw(
        matrix({
          margins: { top: [{ name: 'empty', values: new Float64Array(SIDE).fill(Number.NaN) }] },
        }),
      ),
    ).not.toThrow()
  })

  it('survives a profile of the wrong length rather than drawing off the edge', () => {
    const { strokes } = draw(
      matrix({ margins: { top: [{ name: 'short', values: Float64Array.from([1, 2, 3]) }] } }),
    )
    for (const stroke of strokes) {
      expect(stroke.from[0]).toBeLessThanOrEqual(BOX.width)
      expect(stroke.to[0]).toBeLessThanOrEqual(BOX.width)
    }
  })
})

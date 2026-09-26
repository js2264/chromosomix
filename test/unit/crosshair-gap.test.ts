// @vitest-environment jsdom
/**
 * The guide lines stop short of the hand (§5.8).
 *
 * Over the map, with the crosshair on, the pointer is a ring — Lucide's `locate`
 * — and what it is for is what is inside it: the cell under the hand and the
 * cells round it, with nothing drawn over them. The guide lines used to run
 * straight through its middle, putting back exactly the ink over the answer the
 * ring was drawn to take away. Now every line is cut where it passes within the
 * pointer's reach of the hand (`LOCATE_REACH`, the ends of the icon's ticks):
 * the cross on a square map, the rays and the span guide on a turned one.
 *
 * The gap is round the *hand*, not the cell, because the two are not the same
 * point — the lines go through the middle of the cell the view resolved, and a
 * zoomed-in cell is wider than the ring — and that has a cost this also pins:
 * a hand that moves inside one cell moves the gap, so it is a frame, unless the
 * move changes nothing drawn.
 *
 * Asserted off the strokes, as `turn-guide.test.ts` does: the crosshair has a
 * colour of its own, so what was drawn in it can be picked out of a frame.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CROSSHAIR_COLOR, HeatmapView, LOCATE_REACH, outsideCircle } from '@/render/heatmap'
import type { DenseMatrix } from '@/types'

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g['ImageData'] = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  g['OffscreenCanvas'] = class {
    width = 0
    height = 0
    getContext(): unknown {
      return { putImageData: () => {}, drawImage: () => {}, imageSmoothingEnabled: false }
    }
  }
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

type Point = [number, number]

interface Stroke {
  colour: string
  from: Point
  to: Point
}

interface Harness {
  heatmap: HeatmapView
  fire(type: string, event: Record<string, unknown>): void
  /** Every piece stroked in the crosshair's colour on one frame. */
  guide(): Stroke[]
  /** How many frames the view has asked for since the count was last read. */
  frames(): number
}

function square(bins: number): DenseMatrix {
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins),
    rowExtent: [0, bins],
    colExtent: [0, bins],
  }
}

/** A band as a turned `bins`-bin square gives: `2n − 1` half-bin columns. */
function band(bins: number, separation: number): DenseMatrix {
  const ncols = 2 * bins - 1
  const nrows = separation + 1
  return {
    nrows,
    ncols,
    values: new Float32Array(nrows * ncols),
    rowExtent: [0, nrows],
    colExtent: [0, ncols],
  }
}

function harness(matrix: DenseMatrix, turned = false, size = 400): Harness {
  const strokes: Stroke[] = []
  let at: Point = [0, 0]
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    measureText: (text: string) => ({ width: text.length * 7 }),
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    moveTo: (x: number, y: number) => {
      at = [x, y]
    },
    lineTo: (x: number, y: number) => {
      strokes.push({ colour: String(ctx.strokeStyle), from: at, to: [x, y] })
      at = [x, y]
    },
    stroke: () => {},
    fill: () => {},
    fillText: () => {},
    strokeText: () => {},
    clip: () => {},
    rect: () => {},
    roundRect: () => {},
    setTransform: () => {},
    drawImage: () => {},
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: size,
    clientHeight: size,
    tabIndex: 0,
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size }),
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement

  let frames = 0
  const heatmap = new HeatmapView(canvas, {
    devicePixelRatio: 1,
    // Everything but the guide off, so the strokes on the page are the subject.
    plotOptions: { crosshair: true, dividers: false, breaks: false, labels: false, ticks: false },
    onChange: () => {
      frames++
    },
  })
  if (turned) {
    heatmap.setSpanGestures(true)
    heatmap.setAnchor('end')
    heatmap.setFitAxis('cols')
    heatmap.setMatrix(matrix, { rows: [], cols: [] })
    heatmap.setTurn({ maxSeparation: matrix.nrows - 1, direction: 'up' })
  } else {
    heatmap.setMatrix(matrix, { rows: [], cols: [] })
  }
  heatmap.attach()
  return {
    heatmap,
    fire: (type, event) => listeners.get(type)?.(event),
    guide: () => {
      strokes.length = 0
      heatmap.draw()
      return strokes.filter((stroke) => stroke.colour === CROSSHAIR_COLOR)
    },
    frames: () => {
      const seen = frames
      frames = 0
      return seen
    },
  }
}

/** How close a stroke comes to a point. */
function distance(stroke: Stroke, point: Point): number {
  const [x0, y0] = stroke.from
  const [x1, y1] = stroke.to
  const dx = x1 - x0
  const dy = y1 - y0
  const length = dx * dx + dy * dy
  const along = length === 0 ? 0 : ((point[0] - x0) * dx + (point[1] - y0) * dy) / length
  const t = Math.max(0, Math.min(1, along))
  return Math.hypot(x0 + t * dx - point[0], y0 + t * dy - point[1])
}

/** Whether a stroke stays out of the pointer's reach of the hand. */
function clearance(stroke: Stroke, hand: Point): boolean {
  return distance(stroke, hand) >= LOCATE_REACH - 1e-6
}

/** The middle of a cell of a square map, in canvas pixels. */
function cellMiddle(fit: Harness, row: number, col: number): Point {
  const plot = fit.heatmap.plotRect
  return [
    plot.x + fit.heatmap.scaleX.toPixel(col + 0.5),
    plot.y + fit.heatmap.scaleY.toPixel(row + 0.5),
  ]
}

function move(fit: Harness, point: Point, modifiers: Record<string, unknown> = {}): void {
  fit.fire('mousemove', { clientX: point[0], clientY: point[1], button: 0, ...modifiers })
}

describe('a segment outside a circle', () => {
  const centre: Point = [0, 0]

  it('loses exactly the part inside, and keeps both ends', () => {
    expect(outsideCircle([-10, 0], [10, 0], centre, 3)).toEqual([
      [
        [-10, 0],
        [-3, 0],
      ],
      [
        [3, 0],
        [10, 0],
      ],
    ])
  })

  it('is whole where it misses the circle, or only touches it', () => {
    expect(outsideCircle([-10, 5], [10, 5], centre, 3)).toEqual([
      [
        [-10, 5],
        [10, 5],
      ],
    ])
    expect(outsideCircle([-10, 3], [10, 3], centre, 3)).toHaveLength(1)
  })

  it('keeps the one end that is outside when the other is in', () => {
    expect(outsideCircle([0, 0], [10, 0], centre, 3)).toEqual([
      [
        [3, 0],
        [10, 0],
      ],
    ])
    expect(outsideCircle([-10, 0], [1, 0], centre, 3)).toEqual([
      [
        [-10, 0],
        [-3, 0],
      ],
    ])
  })

  it('is nothing when the circle holds all of it, and whole when it stops short', () => {
    expect(outsideCircle([-1, 0], [1, 0], centre, 3)).toEqual([])
    expect(outsideCircle([4, 0], [10, 0], centre, 3)).toHaveLength(1)
    expect(outsideCircle([-10, 0], [-4, 0], centre, 3)).toHaveLength(1)
  })

  it('answers for a point as for a segment', () => {
    expect(outsideCircle([1, 1], [1, 1], centre, 3)).toEqual([])
    expect(outsideCircle([5, 5], [5, 5], centre, 3)).toHaveLength(1)
  })
})

describe('the cross on a square map', () => {
  it('stops short of the hand on every side', () => {
    const fit = harness(square(40))
    const hand = cellMiddle(fit, 20, 20)
    move(fit, hand)
    const drawn = fit.guide()
    // Two lines, each in two pieces round the hand.
    expect(drawn).toHaveLength(4)
    for (const stroke of drawn) expect(clearance(stroke, hand)).toBe(true)
  })

  it('still runs from edge to edge of the data, and nowhere else is cut', () => {
    const fit = harness(square(40))
    const hand = cellMiddle(fit, 20, 20)
    move(fit, hand)
    const drawn = fit.guide()
    const data = fit.heatmap.dataRect
    const length = (stroke: Stroke): number =>
      Math.hypot(stroke.to[0] - stroke.from[0], stroke.to[1] - stroke.from[1])
    const covered = drawn.reduce((sum, stroke) => sum + length(stroke), 0)
    // The two whole lines, less one gap as wide as the pointer in each — a hair
    // narrower, since snapping a line onto the device grid can put it up to half
    // a pixel off the hand's own middle, and the gap is then a chord of the
    // circle rather than its diameter.
    const whole = data.width + data.height
    expect(covered).toBeGreaterThanOrEqual(whole - 4 * LOCATE_REACH - 1e-6)
    expect(covered).toBeLessThan(whole - 4 * LOCATE_REACH + 0.1)
    const ends = drawn.flatMap((stroke) => [stroke.from, stroke.to])
    expect(ends.some(([, y]) => Math.abs(y - data.y) < 1e-6)).toBe(true)
    expect(ends.some(([, y]) => Math.abs(y - (data.y + data.height)) < 1e-6)).toBe(true)
    expect(ends.some(([x]) => Math.abs(x - data.x) < 1e-6)).toBe(true)
    expect(ends.some(([x]) => Math.abs(x - (data.x + data.width)) < 1e-6)).toBe(true)
  })

  it('cuts round the hand, not the cell, where a cell is wider than the pointer', () => {
    // Four bins across four hundred pixels: a cell is about a hundred wide.
    const fit = harness(square(4))
    const [cx, cy] = cellMiddle(fit, 1, 2)
    const hand: Point = [cx + 6, cy - 4]
    move(fit, hand)
    for (const stroke of fit.guide()) {
      expect(clearance(stroke, hand)).toBe(true)
    }
  })

  it('moves the gap with a hand that moves inside one cell, which is a frame', () => {
    const fit = harness(square(4))
    const [cx, cy] = cellMiddle(fit, 1, 2)
    move(fit, [cx + 6, cy - 4])
    fit.guide()
    fit.frames()
    const hand: Point = [cx - 5, cy + 3]
    move(fit, hand)
    expect(fit.frames()).toBe(1)
    for (const stroke of fit.guide()) {
      expect(clearance(stroke, hand)).toBe(true)
    }
  })

  it('asks for no frame when the hand moves clear of both lines', () => {
    const fit = harness(square(4))
    const [cx, cy] = cellMiddle(fit, 1, 2)
    // Well into a corner of the cell, farther from both lines than the pointer reaches.
    move(fit, [cx + 30, cy + 30])
    fit.frames()
    move(fit, [cx + 32, cy + 31])
    expect(fit.frames()).toBe(0)
  })

  it('draws the cross whole for a tap, where there is no pointer to keep clear', () => {
    const fit = harness(square(40))
    const [x, y] = cellMiddle(fit, 20, 20)
    fit.fire('touchstart', { touches: [{ clientX: x, clientY: y }], preventDefault: () => {} })
    fit.fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 10_000 })
    expect(fit.guide()).toHaveLength(2)
  })
})

describe('the guide on a turned map', () => {
  it('cuts the rays round the hand', () => {
    const fit = harness(band(40, 9), true)
    const data = fit.heatmap.dataRect
    const hand: Point = [data.x + data.width / 2, data.y + data.height / 2]
    move(fit, hand)
    const drawn = fit.guide()
    expect(drawn.length).toBeGreaterThan(0)
    for (const stroke of drawn) expect(clearance(stroke, hand)).toBe(true)
  })

  it('cuts the span guide the same way while Shift is held', () => {
    const fit = harness(band(40, 9), true)
    const data = fit.heatmap.dataRect
    const hand: Point = [data.x + data.width / 2, data.y + data.height / 2]
    move(fit, hand, { shiftKey: true })
    const drawn = fit.guide()
    // One vertical line, in two pieces.
    expect(drawn).toHaveLength(2)
    for (const stroke of drawn) expect(clearance(stroke, hand)).toBe(true)
  })
})

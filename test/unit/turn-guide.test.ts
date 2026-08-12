// @vitest-environment jsdom
/**
 * The guide under the pointer on a **turned** map, and the one gesture that
 * changes its shape.
 *
 * At rest a turned map's guide is a pair of 45° rays: the picture's two
 * directions are not its two axes, so the cells sharing a place with the contact
 * under the pointer are a ray rather than a column (`render/rotate.ts`). That is
 * the right answer to *what is this cell*, and the wrong one to *where shall this
 * interval start* — which is the question the moment a modifier is down, or a
 * form has asked to be pointed at. Then the press is going to draw a band across
 * the genomic axis, and the mark that says where a band begins is the edge it
 * begins on.
 *
 * Asserted off the strokes rather than off a flag, because the flag is not what
 * a reader sees. The crosshair has a colour of its own (`CROSSHAIR_COLOR`), so
 * the segments drawn in it can be picked out of a frame that also carries a
 * border and a raster.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CROSSHAIR_COLOR, HeatmapView } from '@/render/heatmap'
import { BIN_FRACTION } from '@/render/rotate'
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

interface Segment {
  colour: string
  from: [number, number]
  to: [number, number]
}

interface Harness {
  heatmap: HeatmapView
  fire(type: string, event: Record<string, unknown>): void
  /** Every line stroked in the crosshair's colour on one frame. */
  guide(): Segment[]
}

/** How many bins the square block behind the band has. */
const BINS = 40
/** The deepest separation the band shows, in bins. */
const SEPARATION = 9

/** The square the band was turned out of, for the case that is not turned. */
function square(): DenseMatrix {
  return {
    nrows: BINS,
    ncols: BINS,
    values: new Float32Array(BINS * BINS),
    rowExtent: [0, BINS],
    colExtent: [0, BINS],
  }
}

/** The band a `BINS`-bin square turns into: `2n − 1` half-bin columns. */
function band(): DenseMatrix {
  const ncols = 2 * BINS - 1
  const nrows = SEPARATION + 1
  return {
    nrows,
    ncols,
    values: new Float32Array(nrows * ncols),
    rowExtent: [0, nrows],
    colExtent: [0, ncols],
  }
}

function harness(size = 400): Harness {
  const segments: Segment[] = []
  let at: [number, number] = [0, 0]
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
      segments.push({ colour: String(ctx.strokeStyle), from: at, to: [x, y] })
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

  const heatmap = new HeatmapView(canvas, {
    devicePixelRatio: 1,
    // Everything but the guide off, so the strokes on the page are the subject.
    plotOptions: { crosshair: true, dividers: false, breaks: false, labels: false, ticks: false },
  })
  // The order the panel uses, and the same four calls: the presentation first,
  // then the block it was chosen for (`ui/MatrixPanel.setData`).
  heatmap.setSpanGestures(true)
  heatmap.setAnchor('end')
  heatmap.setFitAxis('cols')
  heatmap.setMatrix(band(), { rows: [], cols: [] })
  heatmap.setTurn({ maxSeparation: SEPARATION, direction: 'up' })
  heatmap.attach()
  return {
    heatmap,
    fire: (type, event) => listeners.get(type)?.(event),
    guide: () => {
      segments.length = 0
      heatmap.draw()
      return segments.filter((segment) => segment.colour === CROSSHAIR_COLOR)
    },
  }
}

/** A segment at 45°, which is what a ray off a turned contact is. */
function diagonal(segment: Segment): boolean {
  const dx = Math.abs(segment.to[0] - segment.from[0])
  const dy = Math.abs(segment.to[1] - segment.from[1])
  return dy > 0.5 && Math.abs(dx - dy) < 0.5
}

function vertical(segment: Segment): boolean {
  return Math.abs(segment.to[0] - segment.from[0]) < 0.5 && Math.abs(segment.to[1] - segment.from[1]) > 1
}

/** The middle of the data, wherever the fit put it — a cell in every case. */
function middle(fit: Harness): [number, number] {
  const data = fit.heatmap.dataRect
  return [data.x + data.width / 2, data.y + data.height / 2]
}

/** Put the pointer over the band, well away from every edge. */
function hover(fit: Harness, modifiers: Record<string, unknown> = {}): void {
  const [x, y] = middle(fit)
  fit.fire('mousemove', { clientX: x, clientY: y, button: 0, ...modifiers })
}

describe('the guide on a turned map', () => {
  it('is a pair of 45° rays through the contact under the pointer', () => {
    const fit = harness()
    hover(fit)
    const drawn = fit.guide()
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.every(diagonal)).toBe(true)
  })

  it('becomes one vertical line while Shift is held', () => {
    const fit = harness()
    hover(fit)
    hover(fit, { shiftKey: true })
    const drawn = fit.guide()
    expect(drawn).toHaveLength(1)
    expect(vertical(drawn[0] as Segment)).toBe(true)
  })

  it('becomes one vertical line while Option is held — the same band, drawn', () => {
    const fit = harness()
    hover(fit, { altKey: true })
    const drawn = fit.guide()
    expect(drawn).toHaveLength(1)
    expect(vertical(drawn[0] as Segment)).toBe(true)
  })

  it('answers a Shift pressed with the hand standing still', () => {
    const fit = harness()
    hover(fit)
    expect(fit.guide().every(diagonal)).toBe(true)
    // On the window, which is where the key listener lives: hovering takes no
    // focus, so the canvas would only hear this after a click.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
    expect(fit.guide().every(vertical)).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }))
    expect(fit.guide().every(diagonal)).toBe(true)
  })

  it('is vertical for as long as a form is waiting to be pointed at', () => {
    const fit = harness()
    hover(fit)
    fit.heatmap.setBandMode('pick')
    const drawn = fit.guide()
    expect(drawn).toHaveLength(1)
    expect(vertical(drawn[0] as Segment)).toBe(true)
    // …and back to the rays once the pick has been made and the mode disarmed.
    fit.heatmap.setBandMode('zoom')
    expect(fit.guide().every(diagonal)).toBe(true)
  })

  it('stands on the column under the pointer, which is where the band starts', () => {
    const fit = harness()
    hover(fit, { shiftKey: true })
    const drawn = fit.guide()
    const [x, y] = middle(fit)
    const cell = fit.heatmap.cellAt(x, y)
    expect(cell).not.toBeNull()
    const plot = fit.heatmap.plotRect
    const want = plot.x + fit.heatmap.scaleX.toPixel((cell?.col ?? 0) + BIN_FRACTION)
    // Within a pixel: the line is snapped onto the device grid, and a half-pixel
    // offset is what puts a one-pixel rule on a pixel rather than across two.
    expect(Math.abs((drawn[0]?.from[0] ?? -1) - want)).toBeLessThanOrEqual(1)
  })

  it('leaves the square map’s cross alone — there is no band gesture to announce', () => {
    const fit = harness()
    fit.heatmap.setTurn(null)
    fit.heatmap.setSpanGestures(false)
    fit.heatmap.setFitAxis('both')
    fit.heatmap.setAnchor('middle')
    fit.heatmap.setMatrix(square(), { rows: [], cols: [] })
    hover(fit, { shiftKey: true })
    const drawn = fit.guide()
    // A cross: one line down the column, one across the row.
    expect(drawn).toHaveLength(2)
    expect(drawn.filter(vertical)).toHaveLength(1)
  })
})

/**
 * The mark another panel's *track* pointer leaves — §16.3's echo, for the
 * gesture it did not have one for.
 *
 * A pointer on a stack names one place, not a contact, so there is no cell to
 * mark: the mark goes where a place stands on a contact map, which is the
 * diagonal. On a turned map that is the picture's own bottom edge and the two
 * directions leaving it are 45° rays, so the mark is two short tilted arms —
 * the small form of the V the panel under the pointer is drawing across its own
 * band. A cross there would be two arms pointing at nothing.
 */
describe('a place pointed at from a track beside another map', () => {
  it('is two short 45° arms standing on the diagonal', () => {
    const fit = harness()
    fit.heatmap.setLaneEcho(60)
    const drawn = fit.guide()
    expect(drawn).toHaveLength(2)
    expect(drawn.every(diagonal)).toBe(true)
    // They meet, and they meet on the axis: the apex is the shared end, and the
    // two far ends are the same distance above it on a band that grows upward.
    const [left, right] = drawn as [Segment, Segment]
    expect(left.to[0]).toBeCloseTo(right.from[0], 6)
    expect(left.to[1]).toBeCloseTo(right.from[1], 6)
    expect(left.from[1]).toBeLessThan(left.to[1])
    expect(right.to[1]).toBeLessThan(right.from[1])
  })

  it('stands on the column it was given', () => {
    const fit = harness()
    fit.heatmap.setLaneEcho(60)
    const drawn = fit.guide()
    const plot = fit.heatmap.plotRect
    const want = plot.x + fit.heatmap.scaleX.toPixel(60)
    // The apex, which is the shared end of the two arms.
    expect(Math.abs((drawn[0]?.to[0] ?? -1) - want)).toBeLessThanOrEqual(1)
  })

  it('hangs the other way under a mirrored band, where the diagonal is on top', () => {
    const fit = harness()
    fit.heatmap.setAnchor('start')
    fit.heatmap.setTurn({ maxSeparation: SEPARATION, direction: 'down' })
    fit.heatmap.setLaneEcho(60)
    const drawn = fit.guide()
    expect(drawn).toHaveLength(2)
    const [left] = drawn as [Segment]
    // Separation grows downward, so the arms leave the apex downward too.
    expect(left.from[1]).toBeGreaterThan(left.to[1])
  })

  it('is a small cross on a square map, where the diagonal is the diagonal', () => {
    const fit = harness()
    fit.heatmap.setTurn(null)
    fit.heatmap.setSpanGestures(false)
    fit.heatmap.setFitAxis('both')
    fit.heatmap.setAnchor('middle')
    fit.heatmap.setMatrix(square(), { rows: [], cols: [] })
    fit.heatmap.setLaneEcho(20)
    const drawn = fit.guide()
    expect(drawn).toHaveLength(2)
    expect(drawn.filter(vertical)).toHaveLength(1)
    // On the diagonal: the same unit read off both axes.
    const plot = fit.heatmap.plotRect
    expect(Math.abs((drawn[0]?.from[1] ?? -1) - (plot.y + fit.heatmap.scaleY.toPixel(20))))
      .toBeLessThanOrEqual(1)
  })

  it('draws nothing off the end of a block, and nothing once it is taken away', () => {
    const fit = harness()
    fit.heatmap.setLaneEcho(10_000)
    expect(fit.guide()).toHaveLength(0)
    fit.heatmap.setLaneEcho(60)
    expect(fit.guide()).toHaveLength(2)
    fit.heatmap.setLaneEcho(null)
    expect(fit.guide()).toHaveLength(0)
  })

  it('goes with the crosshair, which is the preference it is an echo of', () => {
    const fit = harness()
    fit.heatmap.setLaneEcho(60)
    expect(fit.guide()).toHaveLength(2)
    fit.heatmap.setPlotOptions({ crosshair: false })
    expect(fit.guide()).toHaveLength(0)
  })
})

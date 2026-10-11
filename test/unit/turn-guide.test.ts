// @vitest-environment jsdom
/**
 * The guide under the pointer on a **turned** map, the one gesture that changes
 * its shape, and what the readout beside it is told.
 *
 * The two halves are here together because they were what came apart: the
 * crosshair stood up as a single vertical line the moment a modifier went down,
 * saying "the next drag names a stretch of the genome", while the card beside it
 * went on printing a pair of loci and the distance between them — a fact about
 * the cell, which is not what the gesture is about to select. A picture and a
 * caption describing two different gestures is worse than either one alone.
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

import { CROSSHAIR_COLOR, HeatmapView, type DrawnBox } from '@/render/heatmap'
import { alongAxis } from '@/render/turnGeometry'
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
  /** What the last hover told the readout, which is the card's whole input. */
  told(): { cell: { row: number; col: number } | null; span: boolean } | null
  /** Every box a drag drew, in cells of the square the band came from. */
  boxes: DrawnBox[]
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
    setLineDash: () => {},
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

  let hover: { cell: { row: number; col: number } | null; span: boolean } | null = null
  const boxes: DrawnBox[] = []
  const heatmap = new HeatmapView(canvas, {
    devicePixelRatio: 1,
    // Everything but the guide off, so the strokes on the page are the subject.
    plotOptions: { crosshair: true, dividers: false, breaks: false, labels: false, ticks: false },
    onHover: (cell, at) => {
      hover = {
        cell: cell === null ? null : { row: cell.row, col: cell.col },
        span: at?.span === true,
      }
    },
    onDrawn: (box) => boxes.push(box),
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
      return joined(segments.filter((segment) => segment.colour === CROSSHAIR_COLOR))
    },
    told: () => hover,
    boxes,
  }
}

/** The middle of a turned cell, in canvas pixels. */
function pointAt(fit: Harness, row: number, column: number): [number, number] {
  const plot = fit.heatmap.plotRect
  return [
    plot.x + fit.heatmap.scaleX.toPixel(column + 0.5),
    plot.y + fit.heatmap.scaleY.toPixel(row + 0.5),
  ]
}

/**
 * Press, travel and release, as a hand draws a box.
 *
 * The press goes to the canvas and the rest to the **window**, which is where a
 * drag in progress is followed: a gesture belongs to the hand that started it,
 * so the view stops listening at the canvas the moment the button goes down
 * (`HeatmapView.follow`). Under jsdom that host exists, unlike in the node
 * tests, so a move dispatched at the canvas would be the one handler that steps
 * aside.
 */
function dragOn(fit: Harness, from: [number, number], to: [number, number], shift = false): void {
  const modifiers = shift ? { shiftKey: true } : {}
  fit.fire('mousedown', { clientX: from[0], clientY: from[1], button: 0, ...modifiers })
  for (const type of ['mousemove', 'mouseup']) {
    window.dispatchEvent(
      new MouseEvent(type, { clientX: to[0], clientY: to[1], button: 0, ...modifiers }),
    )
  }
  // Drawn here rather than on the frame the release scheduled: that one runs
  // after the file's `afterAll` has taken the canvas stubs away, and a raster
  // built against jsdom's own canvas throws.
  fit.heatmap.draw()
}

/**
 * The guide's lines, each one whole however many pieces it was stroked in.
 *
 * A line through the hand is stroked in two, stopping short of the pointer on
 * either side (`HeatmapView.guideFor`, pinned in `crosshair-gap.test.ts`). These
 * tests are about which lines there are, so the pieces of one line — stroked
 * one after the other, and all on it — count as the line.
 */
function joined(segments: Segment[]): Segment[] {
  const lines: Segment[] = []
  for (const piece of segments) {
    const last = lines[lines.length - 1]
    if (last !== undefined && onLine(last, piece.from) && onLine(last, piece.to)) {
      lines[lines.length - 1] = { colour: last.colour, from: last.from, to: piece.to }
    } else {
      lines.push(piece)
    }
  }
  return lines
}

/** Whether a point is on the line through a segment, to a hundredth of a pixel. */
function onLine(segment: Segment, point: [number, number]): boolean {
  const [x0, y0] = segment.from
  const [x1, y1] = segment.to
  const length = Math.hypot(x1 - x0, y1 - y0)
  if (length === 0) return false
  return Math.abs((x1 - x0) * (point[1] - y0) - (y1 - y0) * (point[0] - x0)) / length < 0.01
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

/**
 * A bead of the structure cell, echoed on a turned map (§25.4).
 *
 * It was a dashed line straight up the band, which on a turned map runs through
 * contacts between two *other* places the whole height of it. The place's own
 * contacts leave the diagonal along two 45° rays, so the echo is that V — the
 * full-size form of what a pointer on a track draws — dashed as the echo always
 * is, and a cross of full lines on a square map as before.
 */
describe('a bead echoed on a turned map', () => {
  it('is the V its place makes, standing on the diagonal and reaching the far edge', () => {
    const fit = harness()
    fit.heatmap.setLocusEcho({ rows: null, cols: 40 })
    const drawn = fit.guide()
    expect(drawn).toHaveLength(2)
    expect(drawn.every(diagonal)).toBe(true)
    const plot = fit.heatmap.plotRect
    const apexX = plot.x + fit.heatmap.scaleX.toPixel(40)
    const apexY = plot.y + fit.heatmap.scaleY.toPixel(SEPARATION + 0.5)
    for (const ray of drawn) {
      expect(ray.from[0]).toBeCloseTo(apexX, 6)
      expect(ray.from[1]).toBeCloseTo(apexY, 6)
      // To the band's far edge — its top, on a band that grows upward.
      expect(ray.to[1]).toBeCloseTo(plot.y + fit.heatmap.scaleY.toPixel(0), 6)
    }
    const ends = drawn.map((ray) => ray.to[0]).sort((a, b) => a - b)
    expect(ends[0]).toBeLessThan(apexX)
    expect(ends[1]).toBeGreaterThan(apexX)
  })

  it('draws no vertical line through the band', () => {
    const fit = harness()
    fit.heatmap.setLocusEcho({ rows: null, cols: 40 })
    expect(fit.guide().filter(vertical)).toHaveLength(0)
  })

  it('stands one V in each band of a mirrored pair', () => {
    const fit = harness()
    fit.heatmap.setMatrix({ ...band(), nrows: 2 * (SEPARATION + 1), values: new Float32Array(2 * (SEPARATION + 1) * (2 * BINS - 1)), rowExtent: [0, 2 * (SEPARATION + 1)] }, { rows: [], cols: [] })
    fit.heatmap.setTurn({ maxSeparation: SEPARATION, direction: 'up', fold: SEPARATION + 1 })
    fit.heatmap.setLocusEcho({ rows: null, cols: 40 })
    const drawn = fit.guide()
    expect(drawn).toHaveLength(4)
    expect(drawn.every(diagonal)).toBe(true)
  })

  it('is still a cross of full lines on a square map', () => {
    const fit = harness()
    fit.heatmap.setTurn(null)
    fit.heatmap.setSpanGestures(false)
    fit.heatmap.setFitAxis('both')
    fit.heatmap.setAnchor('middle')
    fit.heatmap.setMatrix(square(), { rows: [], cols: [] })
    fit.heatmap.setLocusEcho({ rows: 20, cols: 20 })
    const drawn = fit.guide()
    expect(drawn).toHaveLength(2)
    expect(drawn.filter(vertical)).toHaveLength(1)
    expect(drawn.some(diagonal)).toBe(false)
  })
})

/**
 * The other half of the same modifier: what the card is told.
 *
 * The guide's shape and the readout's contents are one answer to one question —
 * *what am I about to select* — and a reader looking at a vertical line over a
 * card describing a contact has been given two.
 */
describe('what a turned map tells the readout', () => {
  it('names a cell at rest, as every map always has', () => {
    const fit = harness()
    hover(fit)
    // Drawn as well as told: the two are one answer, and the assertions below
    // are that they agree. (It also flushes the frame the hover scheduled.)
    expect(fit.guide().every(diagonal)).toBe(true)
    expect(fit.told()?.span).toBe(false)
    expect(fit.told()?.cell).not.toBeNull()
  })

  it('says a place is being named while Shift is held', () => {
    const fit = harness()
    hover(fit, { shiftKey: true })
    expect(fit.guide().filter(vertical)).toHaveLength(1)
    expect(fit.told()?.span).toBe(true)
  })

  it('says the same while Option is held, which draws the same guide', () => {
    const fit = harness()
    hover(fit, { altKey: true })
    expect(fit.guide().filter(vertical)).toHaveLength(1)
    expect(fit.told()?.span).toBe(true)
  })

  it('goes back to naming a cell when the modifier is let go', () => {
    const fit = harness()
    hover(fit, { shiftKey: true })
    hover(fit)
    expect(fit.guide().every(diagonal)).toBe(true)
    expect(fit.told()?.span).toBe(false)
  })

  /**
   * Where along the bottom that place is: the midpoint of the pair the cell
   * under the pointer is a contact between, which is what a turned column
   * stands over. Either end of the pair would be a coordinate the reader is not
   * pointing at — on a band nine bins deep, up to nine bins away from the line
   * the guide is drawn on.
   */
  it('puts the position half way between the contact’s two ends', () => {
    expect(alongAxis({ row: 10, col: 30 })).toBe(20)
    // On the diagonal the two ends are one place, and the midpoint is it.
    expect(alongAxis({ row: 7, col: 7 })).toBe(7)
    // Half-integers are ordinary here — a turned column is half a bin — and are
    // passed on rather than rounded to a bin the reader did not point at.
    expect(alongAxis({ row: 10, col: 11 })).toBe(10.5)
  })
})

/**
 * Drawing a rectangle on a turned map.
 *
 * The one thing a band *selection* cannot say there, and the reason a drawn box
 * is not one: a selection over a turned map is a stretch of the genome opened on
 * both axes, which is always the on-diagonal square. A mark is about the data
 * rather than about the picture, so the drag is taken back to the square it was
 * rotated out of — press over one contact, release over another, and the two are
 * opposite corners of the rectangle those two contacts span.
 */
describe('a box drawn on a turned map', () => {
  it('names the rectangle its two contacts span, off the diagonal', () => {
    const fit = harness()
    fit.heatmap.setDrawMode(true)
    // Row 4 column 40 is the contact (17, 22); row 1 column 60 is (26, 34).
    // Both well off the diagonal, and the two spans are different lengths —
    // which is the whole of what "off the diagonal, at any ratio" means.
    dragOn(fit, pointAt(fit, 4, 40), pointAt(fit, 1, 60))
    expect(fit.boxes).toHaveLength(1)
    expect(fit.boxes[0]?.rows).toEqual([17, 27])
    expect(fit.boxes[0]?.cols).toEqual([22, 35])
  })

  it('is the on-diagonal square while Shift is held', () => {
    // The pixel snap is off on a turned map — the diagonal is the bottom edge of
    // the picture — so the lock is done in the data: each end collapses onto its
    // own midpoint, which is the place on the genome the contact is *at*.
    const fit = harness()
    fit.heatmap.setDrawMode(true)
    dragOn(fit, pointAt(fit, 4, 40), pointAt(fit, 1, 60), true)
    expect(fit.boxes).toHaveLength(1)
    expect(fit.boxes[0]?.rows).toEqual([20, 31])
    expect(fit.boxes[0]?.cols).toEqual([20, 31])
  })

  it('draws no rubber band, the mark being drawn instead', () => {
    // A rectangle of rows against columns leans at 45° here, so a box on screen
    // would be a box drawn around a shape that is not one. The owner previews
    // the mark itself; see `MatrixPanel.previewRect`.
    const fit = harness()
    fit.heatmap.setDrawMode(true)
    const [x0, y0] = pointAt(fit, 4, 40)
    const [x, y] = pointAt(fit, 1, 60)
    fit.fire('mousedown', { clientX: x0, clientY: y0, button: 0 })
    fit.fire('mousemove', { clientX: x, clientY: y, button: 0 })
    expect(fit.guide().filter((segment) => !diagonal(segment) && !vertical(segment))).toHaveLength(0)
    fit.fire('mouseup', { clientX: x, clientY: y, button: 0 })
  })
})

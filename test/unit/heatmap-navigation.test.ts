/**
 * Navigation: drag-to-zoom, and the wall at the edge of the data.
 *
 * Both are arithmetic over the view transform, and both are the kind of thing
 * that looks right in a screenshot taken at one zoom level and is wrong at
 * another. Asserted through `cellAt`, which is what the app itself uses to turn
 * a pixel into a bin — so these tests fail if the transform and the hit testing
 * ever disagree, which is the failure that actually matters.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HeatmapView, type SelectionBox } from '@/render/heatmap'
import type { DenseMatrix } from '@/types'

/**
 * The pointer handlers repaint, and repainting rasterises through an
 * `OffscreenCanvas` Node does not have. Two stubs are enough, and they make the
 * drag tests exercise the real `draw()` rather than a version of it that skips
 * the part where a mistake would land.
 */
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
      // `drawImage` as well as `putImageData`: a minified draw halves the raster
      // into canvases of this kind (`HeatmapView.rasterFor`).
      return { putImageData: () => {}, drawImage: () => {}, imageSmoothingEnabled: false }
    }
  }
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

function fakeCanvas(size: number): HTMLCanvasElement {
  return harness(size).canvas
}

/** A canvas that also hands back the listeners, so a drag can be driven. */
function harness(size: number): {
  canvas: HTMLCanvasElement
  fire(type: string, event: Record<string, unknown>): void
} {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
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
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillText: () => {},
    strokeText: () => {},
    clip: () => {},
    rect: () => {},
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
    // `remove` as well as `toggle`: the view clears its own state classes on
    // the way out, and a stub that only knows how to toggle throws there.
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size }),
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
  return { canvas, fire: (type, event) => listeners.get(type)?.(event) }
}

/** A press, a move and a release, with whatever modifiers. */
function dragWith(
  fire: (type: string, event: Record<string, unknown>) => void,
  from: [number, number],
  to: [number, number],
  modifiers: Record<string, unknown> = {},
): void {
  fire('mousedown', { clientX: from[0], clientY: from[1], button: 0, ...modifiers })
  fire('mousemove', { clientX: to[0], clientY: to[1], button: 0, ...modifiers })
  fire('mouseup', { clientX: to[0], clientY: to[1], button: 0, ...modifiers })
}

function block(n: number): DenseMatrix {
  return { nrows: n, ncols: n, values: new Float32Array(n * n), rowExtent: [0, n], colExtent: [0, n] }
}

function view(size = 400, n = 100): HeatmapView {
  const heatmap = new HeatmapView(fakeCanvas(size), { devicePixelRatio: 1 })
  heatmap.setMatrix(block(n), [])
  return heatmap
}

describe('drag to zoom', () => {
  it('zooms to the selected box and centres it', () => {
    const heatmap = view()
    const before = heatmap.zoomLevel
    // Cells 20–40 on both axes, at the fitted zoom of 4 px per cell.
    heatmap.zoomToBox(80, 80, 160, 160)
    expect(heatmap.zoomLevel).toBeGreaterThan(before)
    const plot = heatmap.plotRect
    const centre = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(centre?.row).toBeCloseTo(30, 0)
    expect(centre?.col).toBeCloseTo(30, 0)
  })

  it('does not care which corner the drag started from', () => {
    const forward = view()
    const backward = view()
    forward.zoomToBox(80, 80, 160, 160)
    backward.zoomToBox(160, 160, 80, 80)
    expect(backward.zoomLevel).toBe(forward.zoomLevel)
    const plot = forward.plotRect
    const a = forward.cellAt(plot.x + 5, plot.y + 5)
    const b = backward.cellAt(plot.x + 5, plot.y + 5)
    expect(b?.row).toBe(a?.row)
    expect(b?.col).toBe(a?.col)
  })

  it('ignores a slip: a two-pixel drag is a click, not a selection', () => {
    const heatmap = view()
    const before = heatmap.zoomLevel
    heatmap.zoomToBox(100, 100, 102, 103)
    expect(heatmap.zoomLevel).toBe(before)
  })
})

describe('the edge of the data is a wall', () => {
  it('cannot be panned past the first row or column', () => {
    const heatmap = view()
    heatmap.zoomToBox(80, 80, 160, 160)
    // Shove it far past the top-left corner, several viewports' worth.
    heatmap.panBy(5000, 5000)
    const plot = heatmap.plotRect
    const corner = heatmap.cellAt(plot.x + 1, plot.y + 1)
    expect(corner?.row).toBe(0)
    expect(corner?.col).toBe(0)
  })

  it('cannot be panned past the last row or column', () => {
    const heatmap = view()
    heatmap.zoomToBox(80, 80, 160, 160)
    heatmap.panBy(-5000, -5000)
    const plot = heatmap.plotRect
    const corner = heatmap.cellAt(plot.x + plot.width - 2, plot.y + plot.height - 2)
    expect(corner?.row).toBe(99)
    expect(corner?.col).toBe(99)
  })

  it('keeps the matrix centred when it is smaller than the plot', () => {
    const heatmap = view()
    // Fitted, then zoomed out below the fit: nothing to pan, so it stays put.
    heatmap.fit()
    const plot = heatmap.plotRect
    const before = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    heatmap.panBy(300, -300)
    const after = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(after?.row).toBe(before?.row)
    expect(after?.col).toBe(before?.col)
  })
})

describe('what a drag does', () => {
  it('pans by default, without changing the zoom', () => {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    heatmap.zoomToBox(80, 80, 160, 160)
    const zoom = heatmap.zoomLevel
    const plot = heatmap.plotRect
    const before = heatmap.cellAt(plot.x + 5, plot.y + 5)

    dragWith(fire, [200, 200], [140, 140])

    expect(heatmap.zoomLevel).toBe(zoom)
    const after = heatmap.cellAt(plot.x + 5, plot.y + 5)
    expect(after?.col).toBeGreaterThan(before?.col ?? 0)
  })

  it('selects and zooms when Option is held', () => {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    const zoom = heatmap.zoomLevel

    dragWith(fire, [80, 80], [160, 160], { altKey: true })

    expect(heatmap.zoomLevel).toBeGreaterThan(zoom)
  })

  it('puts the view back on a double click', () => {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    const fitted = heatmap.zoomLevel
    heatmap.zoomToBox(80, 80, 160, 160)
    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)

    fire('dblclick', { clientX: 200, clientY: 200, preventDefault: () => {} })

    expect(heatmap.zoomLevel).toBeCloseTo(fitted, 6)
  })
})

/**
 * *Pick on map*: a drag that names a stretch of genome for a form and does
 * nothing else.
 *
 * The mode disarms itself the moment it has an answer (`ui/mapPick.ts` — one
 * pick per arming), and it disarms by calling back into `setBandMode('zoom')`.
 * So the report and the decision to zoom are not independent, and the order they
 * are read in is the whole feature: a mode consulted after the report is the
 * mode the gesture has just left. That is asserted here with the real callback
 * shape — the listener disarms, exactly as the module does — because a test that
 * merely set the mode and dragged passes against either ordering.
 */
describe('naming a locus rather than zooming', () => {
  function armed(): {
    heatmap: HeatmapView
    fire: (type: string, event: Record<string, unknown>) => void
    bands: Array<{ axis: string; span: [number, number] }>
  } {
    const { canvas, fire } = harness(400)
    const bands: Array<{ axis: string; span: [number, number] }> = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onBand: (axis, span) => {
        bands.push({ axis, span })
        // What the real listener does: one pick per arming, and the disarm
        // reaches straight back in here.
        heatmap.setBandMode('zoom')
      },
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    heatmap.setBandMode('pick')
    return { heatmap, fire, bands }
  }

  it('reports the band and leaves the picture where it is', () => {
    const { heatmap, fire, bands } = armed()
    const zoom = heatmap.zoomLevel
    const plot = heatmap.plotRect
    const corner = heatmap.cellAt(plot.x + 5, plot.y + 5)

    dragWith(fire, [80, 200], [160, 200])

    expect(bands).toHaveLength(1)
    expect(bands[0]?.axis).toBe('cols')
    expect(heatmap.zoomLevel).toBe(zoom)
    const after = heatmap.cellAt(plot.x + 5, plot.y + 5)
    expect(after?.row).toBe(corner?.row)
    expect(after?.col).toBe(corner?.col)
  })

  it('zooms again on the next drag, the mode having disarmed itself', () => {
    const { heatmap, fire } = armed()
    dragWith(fire, [80, 200], [160, 200])
    const zoom = heatmap.zoomLevel

    dragWith(fire, [80, 200], [160, 200], { shiftKey: true })

    expect(heatmap.zoomLevel).toBeGreaterThan(zoom)
  })
})

describe('chrome stops at the data', () => {
  it('shrinks the data rect when the matrix no longer fills the plot', () => {
    const heatmap = view()
    const plot = heatmap.plotRect
    expect(heatmap.dataRect.width).toBeCloseTo(plot.width, 6)
    // Zoom out below the fit: the matrix is now smaller than the area for it.
    heatmap.handleKeyDown({ key: '-', preventDefault: () => {} } as KeyboardEvent)
    expect(heatmap.dataRect.width).toBeLessThan(plot.width)
    expect(heatmap.dataRect.height).toBeLessThan(plot.height)
  })
})

/**
 * Touch, which is a separate path from the mouse rather than a rewrite of it:
 * pinch has no mouse equivalent, and the modifier that turns a mouse drag into a
 * zoom selection does not exist on a phone. What has to hold is that the same
 * three things happen — pan, zoom, open a cell — through gestures a hand makes.
 */
function touches(...points: Array<[number, number]>): Record<string, unknown> {
  const list = points.map(([clientX, clientY]) => ({ clientX, clientY }))
  return { touches: list, preventDefault: () => {}, timeStamp: 0 }
}

describe('touch', () => {
  function attached(): {
    heatmap: HeatmapView
    fire: (type: string, event: Record<string, unknown>) => void
    opened: Array<{ row: number; col: number }>
  } {
    const { canvas, fire } = harness(400)
    const opened: Array<{ row: number; col: number }> = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onCellClick: (cell) => opened.push({ row: cell.row, col: cell.col }),
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    return { heatmap, fire, opened }
  }

  it('pans with one finger', () => {
    const { heatmap, fire } = attached()
    heatmap.zoomToBox(80, 80, 160, 160)
    const before = heatmap.cellAt(heatmap.plotRect.x + 5, heatmap.plotRect.y + 5)
    fire('touchstart', touches([200, 200]))
    fire('touchmove', touches([260, 200]))
    fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 0 })
    const after = heatmap.cellAt(heatmap.plotRect.x + 5, heatmap.plotRect.y + 5)
    // Dragging right brings earlier columns into view; the rows do not move.
    expect(after?.col).toBeLessThan(before?.col ?? 0)
    expect(after?.row).toBe(before?.row)
  })

  it('zooms on a pinch, about the middle of the two fingers', () => {
    const { heatmap, fire } = attached()
    const before = heatmap.zoomLevel
    fire('touchstart', touches([180, 200], [220, 200]))
    fire('touchmove', touches([120, 200], [280, 200]))
    fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 0 })
    // Fingers four times as far apart, so four times the zoom — up to the clamp.
    expect(heatmap.zoomLevel).toBeGreaterThan(before * 3)
  })

  it('opens the tapped cell, and only after the double-tap window', async () => {
    const { heatmap, fire, opened } = attached()
    const cell = heatmap.cellAt(200, 200)
    fire('touchstart', touches([200, 200]))
    fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 0 })
    expect(opened).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(opened).toEqual([{ row: cell?.row ?? -1, col: cell?.col ?? -1 }])
  })

  it('refits on a double tap, and the first tap does not navigate', async () => {
    const { heatmap, fire, opened } = attached()
    const fitted = heatmap.zoomLevel
    heatmap.zoomToBox(80, 80, 160, 160)
    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)

    fire('touchstart', touches([200, 200]))
    fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 0 })
    fire('touchstart', touches([202, 201]))
    fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 10 })

    expect(heatmap.zoomLevel).toBeCloseTo(fitted, 6)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(opened).toEqual([])
  })

  it('does not treat a drag as a tap', async () => {
    const { fire, opened } = attached()
    fire('touchstart', touches([200, 200]))
    fire('touchmove', touches([260, 240]))
    fire('touchend', { touches: [], preventDefault: () => {}, timeStamp: 0 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(opened).toEqual([])
  })
})

describe('a selection is a square, and it is handed over', () => {
  /** A view with somewhere for the box to go, and its listeners. */
  function selectable(): {
    fire: (type: string, event: Record<string, unknown>) => void
    boxes: SelectionBox[]
    heatmap: HeatmapView
  } {
    const { canvas, fire } = harness(400)
    const boxes: SelectionBox[] = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onSelect: (box) => boxes.push(box),
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    return { fire, boxes, heatmap }
  }

  it('squares a rectangle rather than quietly reinterpreting it', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    // A wide, short drag. It used to resolve to a square zoom anyway, which is
    // what made drawing a rectangle misleading; now the square is what is drawn
    // *and* what is acted on.
    dragWith(fire, [plot.x + 10, plot.y + 10], [plot.x + 210, plot.y + 50], { altKey: true })
    expect(boxes).toHaveLength(1)
    expect(boxes[0].cols[1] - boxes[0].cols[0]).toBe(boxes[0].rows[1] - boxes[0].rows[0])
  })

  it('anchors on the corner the drag began at, in any direction', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    dragWith(fire, [plot.x + 200, plot.y + 200], [plot.x + 100, plot.y + 120], { altKey: true })
    expect(boxes).toHaveLength(1)
    expect(boxes[0].rows[1] - boxes[0].rows[0]).toBe(boxes[0].cols[1] - boxes[0].cols[0])
    // The anchor is the press, not a corner of the normalised box: it is what
    // says which contig the selection belongs to.
    const anchor = heatmap.cellAt(plot.x + 200, plot.y + 200)
    expect(boxes[0].anchor.row).toBe(anchor?.row)
    expect(boxes[0].anchor.col).toBe(anchor?.col)
  })

  it('does not zoom when the box is handed over', () => {
    const { fire, heatmap } = selectable()
    const plot = heatmap.plotRect
    const before = heatmap.zoomLevel
    dragWith(fire, [plot.x + 10, plot.y + 10], [plot.x + 120, plot.y + 120], { altKey: true })
    expect(heatmap.zoomLevel).toBe(before)
  })

  it('still zooms when nobody is listening', () => {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    const before = heatmap.zoomLevel
    dragWith(fire, [50, 50], [250, 250], { altKey: true })
    expect(heatmap.zoomLevel).toBeGreaterThan(before)
  })

  it('ignores a slip: a drag under the threshold selects nothing', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    dragWith(fire, [plot.x + 30, plot.y + 30], [plot.x + 33, plot.y + 32], { altKey: true })
    expect(boxes).toEqual([])
  })

  it('clamps to the block, so a drag off the edge names cells that exist', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    dragWith(fire, [plot.x + 20, plot.y + 20], [plot.x + 2000, plot.y + 2000], { altKey: true })
    expect(boxes).toHaveLength(1)
    expect(boxes[0].rows[0]).toBeGreaterThanOrEqual(0)
    expect(boxes[0].rows[1]).toBeLessThanOrEqual(100)
    expect(boxes[0].cols[1]).toBeLessThanOrEqual(100)
  })

  // A corner taken off the plot and *left* there — the gesture that used to end
  // with nothing selected, because leaving the canvas abandoned the drag. The
  // release is off the plot too, so the box has to come from where the marquee
  // was drawn rather than from where the button came up.
  it('survives a corner dragged off the plot and released outside it', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    fire('mousedown', { clientX: plot.x + 40, clientY: plot.y + 40, button: 0, altKey: true })
    fire('mousemove', { clientX: plot.x + 300, clientY: plot.y + 300, button: 0, altKey: true })
    fire('mousemove', { clientX: plot.x + 4000, clientY: plot.y + 4000, button: 0, altKey: true })
    fire('mouseleave', {})
    fire('mouseup', { clientX: plot.x + 4000, clientY: plot.y + 4000, button: 0, altKey: true })
    expect(boxes).toHaveLength(1)
    expect(boxes[0].cols[1]).toBeLessThanOrEqual(100)
    expect(boxes[0].rows[1]).toBeLessThanOrEqual(100)
  })
})

/**
 * Shift, with the modifier that starts a selection, pins the box to the
 * diagonal.
 *
 * The property worth asserting is not "the box is square" — every box is, since
 * `squareFrom` sees to that — but that both of its corners name the *same* bin
 * on the two axes. A drag nowhere near the diagonal must still produce one, from
 * the nearest point on it, which is the whole of "fetch the nearest coordinate
 * along the diagonal to initiate the box".
 */
describe('a diagonal selection', () => {
  function selectable(): {
    fire: (type: string, event: Record<string, unknown>) => void
    boxes: SelectionBox[]
    heatmap: HeatmapView
  } {
    const { canvas, fire } = harness(400)
    const boxes: SelectionBox[] = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onSelect: (box) => boxes.push(box),
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    return { fire, boxes, heatmap }
  }

  it('lands on the diagonal from a press that is nowhere near it', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    // Press at cell (row 40, col 20) — twenty cells off the diagonal — and
    // release at (row 50, col 90), which is sixty off it in the other direction.
    dragWith(
      fire,
      [plot.x + 80, plot.y + 160],
      [plot.x + 360, plot.y + 200],
      { altKey: true, shiftKey: true },
    )
    expect(boxes).toHaveLength(1)
    expect(boxes[0].rows).toEqual(boxes[0].cols)
  })

  it('leaves a plain Option drag off the diagonal, where it was drawn', () => {
    const { fire, boxes, heatmap } = selectable()
    const plot = heatmap.plotRect
    dragWith(fire, [plot.x + 80, plot.y + 160], [plot.x + 200, plot.y + 280], { altKey: true })
    expect(boxes).toHaveLength(1)
    expect(boxes[0].rows).not.toEqual(boxes[0].cols)
  })
})

/**
 * Shift-drag: a band of one axis, zoomed to and reported.
 *
 * The gesture used to name a 4C anchor for a lane that no longer exists (§18.9).
 * What replaces it is the 1D half of the marquee — drag across the stretch you
 * want and the view goes there — and the report is what puts the same stretch on
 * the clipboard, which the renderer knows nothing about.
 *
 * Two things are worth pinning here and neither is visible in a screenshot:
 * which axis a drag is taken to name, and that the *pick* mode reports without
 * moving the picture. A pick that zoomed would take the thing the reader was
 * pointing at out from under the pointer.
 */
describe('a band along one axis', () => {
  function banded(): {
    fire: (type: string, event: Record<string, unknown>) => void
    bands: Array<{ axis: 'rows' | 'cols'; span: [number, number] }>
    heatmap: HeatmapView
  } {
    const { canvas, fire } = harness(400)
    const bands: Array<{ axis: 'rows' | 'cols'; span: [number, number] }> = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onBand: (axis, span) => bands.push({ axis, span }),
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    return { fire, bands, heatmap }
  }

  it('reads a mostly-horizontal drag as columns and zooms in', () => {
    const { fire, bands, heatmap } = banded()
    const plot = heatmap.plotRect
    const fitted = heatmap.zoomLevel
    // Four pixels a cell at the fitted zoom, so 80 → 160 is cells 20 to 40.
    dragWith(fire, [plot.x + 80, plot.y + 200], [plot.x + 160, plot.y + 210], { shiftKey: true })
    expect(bands).toEqual([{ axis: 'cols', span: [20, 40] }])
    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)
    const centre = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(centre?.col).toBeCloseTo(30, 0)
  })

  // The same stretch of genome on a map read about its diagonal, so insisting on
  // one direction would be insisting on a gesture rather than on an answer.
  it('reads a mostly-vertical drag as rows', () => {
    const { fire, bands, heatmap } = banded()
    const plot = heatmap.plotRect
    dragWith(fire, [plot.x + 200, plot.y + 80], [plot.x + 210, plot.y + 160], { shiftKey: true })
    expect(bands).toEqual([{ axis: 'rows', span: [20, 40] }])
    const centre = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(centre?.row).toBeCloseTo(30, 0)
  })

  // One scalar drives both axes, which is what keeps a cell square. So a 1D
  // gesture has a 2D consequence, and the axis nobody dragged keeps its centre.
  it('keeps the other axis where it was', () => {
    const { fire, heatmap } = banded()
    const plot = heatmap.plotRect
    const before = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    dragWith(fire, [plot.x + 80, plot.y + 200], [plot.x + 160, plot.y + 210], { shiftKey: true })
    const after = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(after?.row).toBeCloseTo(before?.row ?? -1, 0)
  })

  it('reports without moving the picture while a form is waiting for a locus', () => {
    const { fire, bands, heatmap } = banded()
    heatmap.setBandMode('pick')
    const plot = heatmap.plotRect
    const fitted = heatmap.zoomLevel
    dragWith(fire, [plot.x + 80, plot.y + 200], [plot.x + 160, plot.y + 210], { shiftKey: true })
    expect(bands).toEqual([{ axis: 'cols', span: [20, 40] }])
    expect(heatmap.zoomLevel).toBe(fitted)
  })

  // Option with Shift is the diagonal-locked marquee and has been since before
  // this gesture existed; Shift must not steal it.
  it('stands aside for a diagonal selection', () => {
    const { fire, bands, heatmap } = banded()
    const plot = heatmap.plotRect
    dragWith(
      fire,
      [plot.x + 80, plot.y + 160],
      [plot.x + 200, plot.y + 280],
      { altKey: true, shiftKey: true },
    )
    expect(bands).toEqual([])
  })

  /**
   * The conversion the lane stacks share (§8.4 glues their pixels to the map's
   * along the axis they have in common), so a band dragged out beside the map
   * names the same stretch as the same band dragged out on it.
   */
  it('converts pixels to cells the same way for a caller beside the map', () => {
    const { heatmap } = banded()
    const plot = heatmap.plotRect
    expect(heatmap.bandAt('cols', plot.x + 80, plot.x + 160)).toEqual([20, 40])
    expect(heatmap.bandAt('cols', plot.x + 160, plot.x + 80)).toEqual([20, 40])
    // A tap is a band of the one bin it landed on: the finest locus this
    // resolution can express, and a perfectly good thing to point at.
    expect(heatmap.bandAt('rows', plot.y + 80, plot.y + 80)).toEqual([20, 21])
    // Clamped to the block rather than run off it.
    expect(heatmap.bandAt('rows', plot.y - 500, plot.y + 5000)).toEqual([0, 100])
  })
})

/**
 * The wheel's two axes, which mean two different things.
 *
 * Up and down is the zoom, and sideways **slides along the picture** — which is
 * what two fingers mean over every genome browser there is, and what they
 * already meant over this app's own 1D tracks. It used to be left to the page,
 * so the platform's back-and-forward swipe would work over the map as it does
 * everywhere else; that is the wrong trade over the one element a reader
 * navigates *by* sliding, and the swipe still works outside the picture.
 */
describe('the two axes of a wheel', () => {
  function wheeled(): {
    heatmap: HeatmapView
    wheel: (deltaX: number, deltaY: number) => void
    prevented: () => number
  } {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()
    let count = 0
    return {
      heatmap,
      prevented: () => count,
      wheel: (deltaX, deltaY) =>
        fire('wheel', {
          clientX: 200,
          clientY: 200,
          deltaX,
          deltaY,
          preventDefault: () => {
            count++
          },
        }),
    }
  }

  it('zooms on a vertical wheel', () => {
    const { heatmap, wheel, prevented } = wheeled()
    const fitted = heatmap.zoomLevel
    wheel(0, -200)
    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)
    expect(prevented()).toBe(1)
  })

  it('slides along the picture on a horizontal one, without zooming', () => {
    const { heatmap, wheel, prevented } = wheeled()
    // Zoomed in first, or there is nowhere to slide to: a fitted block already
    // shows every column, and a pan is clamped to the data.
    wheel(0, -400)
    const zoom = heatmap.zoomLevel
    const plot = heatmap.plotRect
    const columnAt = (): number | undefined =>
      heatmap.cellAt(plot.x + 1, plot.y + plot.height / 2)?.col
    const before = columnAt()
    wheel(-180, 4)
    expect(heatmap.zoomLevel).toBe(zoom)
    expect(columnAt()).not.toBe(before)
    // Taken from the page, which is the half of this that keeps the map from
    // sliding *and* the tab from going back at the same time.
    expect(prevented()).toBe(2)
  })
})

/**
 * A turned map, whose y axis is a distance rather than a place (§17).
 *
 * Two things follow and neither is cosmetic. A band shorter than the plot has to
 * stand on the edge its diagonal is on, because the tracks under the map are
 * drawn against that same axis and a centred band floats away from them. And
 * both drags have to collapse onto the x axis, because the other one bounds no
 * window: the box a marquee used to commit named rows that are separations, and
 * a mostly-vertical 4C drag named a band of them, which resolved to nothing at
 * all — silently, because the axis it asked for does not exist.
 */
describe('a band, not a square', () => {
  /** A block far wider than it is tall — the shape a turn produces. */
  function band(rows: number, cols: number): DenseMatrix {
    return {
      nrows: rows,
      ncols: cols,
      values: new Float32Array(rows * cols),
      rowExtent: [0, rows],
      colExtent: [0, cols],
    }
  }

  function turned(size = 400): HeatmapView {
    const heatmap = new HeatmapView(fakeCanvas(size), { devicePixelRatio: 1 })
    heatmap.setAnchor('end')
    heatmap.setSpanGestures(true)
    // 20 rows over 200 columns: fitted on the width, it uses a tenth of the
    // height, which is the gap this exists to close.
    heatmap.setMatrix(band(20, 200), [])
    return heatmap
  }

  it('stands the diagonal on the bottom edge of the plot', () => {
    const heatmap = turned()
    const plot = heatmap.plotRect
    const bottom = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height - 1)
    expect(bottom?.row).toBe(19)
    // …and there is paper above the apex rather than under the axis.
    expect(heatmap.cellAt(plot.x + plot.width / 2, plot.y + 1)).toBeNull()
  })

  it('stands it on the top edge when separation grows downward', () => {
    const heatmap = turned()
    heatmap.setAnchor('start')
    const plot = heatmap.plotRect
    expect(heatmap.cellAt(plot.x + plot.width / 2, plot.y + 1)?.row).toBe(0)
    expect(heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height - 1)).toBeNull()
  })

  it('centres it again once nothing is asking for an edge', () => {
    const heatmap = turned()
    heatmap.setAnchor('middle')
    const plot = heatmap.plotRect
    // Half the slack above and half below, which is the square map's rule and
    // the one a turn is the exception to.
    expect(heatmap.cellAt(plot.x + plot.width / 2, plot.y + 1)).toBeNull()
    expect(heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height - 1)).toBeNull()
    expect(heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)?.row).toBe(10)
  })

  it('zooms to a horizontal span, which a square marquee could not', () => {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setAnchor('end')
    heatmap.setSpanGestures(true)
    heatmap.setMatrix(band(20, 200), [])
    heatmap.attach()
    const fitted = heatmap.zoomLevel

    // Flat: no vertical travel at all, which is exactly what a drag across a
    // band looks like. As a square it is a zero-height box and does nothing.
    dragWith(fire, [100, 300], [200, 300], { altKey: true })

    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)
    // 100 px of a 400 px plot: a quarter of the columns, so four times the zoom.
    expect(heatmap.zoomLevel).toBeCloseTo(fitted * 4, 6)
  })

  it('names columns for a band drag whichever way the hand went', () => {
    const { canvas, fire } = harness(400)
    const asked: Array<{ axis: string; span: [number, number] }> = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onBand: (axis, span) => asked.push({ axis, span }),
    })
    heatmap.setAnchor('end')
    heatmap.setSpanGestures(true)
    heatmap.setMatrix(band(20, 200), [])
    heatmap.attach()

    // Mostly vertical. On a square map this is a band of rows; on a turned one
    // rows are separations, and the answer has to be a stretch of the genome.
    dragWith(fire, [200, 260], [210, 380], { shiftKey: true })

    expect(asked).toHaveLength(1)
    expect(asked[0].axis).toBe('cols')
    expect(asked[0].span[1]).toBeGreaterThan(asked[0].span[0])
  })

  it('still asks the hand on a square map', () => {
    const { canvas, fire } = harness(400)
    const asked: string[] = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onBand: (axis) => asked.push(axis),
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()

    dragWith(fire, [200, 100], [210, 300], { shiftKey: true })

    expect(asked).toEqual(['rows'])
  })
})

/**
 * The automatic colour range follows the **block that was read**, not the part
 * of it on screen.
 *
 * Already true of a square map — the range is measured once per read, and a pan
 * or a zoom does not move it — and a turned band is where it stopped being true:
 * a band is a *crop*, holding the near-diagonal separations and dropping the
 * rest, so measuring it re-scaled the picture the moment the map was turned and
 * again on every drag of the depth handle. On a diverging field the dropped
 * separations are exactly where the extremes live, which is why the range
 * roughly halved. A turn is a change of geometry; it must not recolour anything.
 *
 * Stated over a crop of rows rather than over a real rotation, because the
 * mechanism is the renderer's and has nothing to do with the geometry that
 * produced the crop: a quarter of this block carries the only large values in
 * it, and the picture drawn is three rows that carry none.
 */
describe('what the auto range is measured on', () => {
  const N = 64
  /** A block whose last quarter holds every large value in it. */
  function withExtremes(): DenseMatrix {
    const values = new Float32Array(N * N).fill(1)
    values.fill(1000, (N - N / 4) * N)
    return { nrows: N, ncols: N, values, rowExtent: [0, N], colExtent: [0, N] }
  }

  /** The first three rows of it: a crop with none of them in it. */
  function head(square: DenseMatrix): DenseMatrix {
    return {
      nrows: 3,
      ncols: N,
      values: square.values.slice(0, 3 * N),
      rowExtent: [0, 3],
      colExtent: [0, N],
    }
  }

  function vmaxOf(view: HeatmapView): number {
    view.draw()
    return view.effectiveScale.vmax
  }

  it('takes the crop\u2019s own range when nothing says otherwise', () => {
    const square = withExtremes()
    const whole = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    whole.setMatrix(square, [])
    const crop = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    crop.setMatrix(head(square), [])
    expect(vmaxOf(whole)).toBeCloseTo(Math.log1p(1000), 4)
    // The crop holds none of the large values, so on its own it scales to the
    // background — a different picture of the very same cells.
    expect(vmaxOf(crop)).toBeCloseTo(Math.log1p(1), 4)
  })

  it('takes the gauge\u2019s range when the picture is a crop of it', () => {
    const square = withExtremes()
    const crop = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    crop.setMatrix(head(square), [], square)
    expect(vmaxOf(crop)).toBeCloseTo(Math.log1p(1000), 4)
  })

  it('re-measures the gauge when the values under it are recomputed', () => {
    const square = withExtremes()
    const view = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    view.setMatrix(head(square), [], square)
    expect(vmaxOf(view)).toBeCloseTo(Math.log1p(1000), 4)
    // A derivation recomputes both the picture and the block it was cut from;
    // handing over only the first would scale a ratio by the counts\u2019 range.
    view.setValues(new Float32Array(3 * N).fill(1), new Float32Array(N * N).fill(1))
    expect(vmaxOf(view)).toBeCloseTo(Math.log1p(1), 4)
  })
})

/**
 * A band is drawn in a box, and the box does not move when the reader zooms.
 *
 * The renderer's half of §17.2. A turned map used to be fitted like any other
 * matrix — the zoom that puts the whole block on screen, whichever axis is
 * tighter — so zooming in grew the band's height along with its width until it
 * filled the panel and stopped being a band at all. Its rows are not a thing to
 * fit: the block is *cut* to the height of the box it is drawn in, so fitting
 * them is a tautology at every zoom, and asking for it makes the zoom a function
 * of a number that was derived from the zoom.
 */
describe('fitting a band', () => {
  /** A block far wider than it is tall, as a rotation produces. */
  function band(rows: number, cols: number): DenseMatrix {
    return {
      nrows: rows,
      ncols: cols,
      values: new Float32Array(rows * cols),
      rowExtent: [0, rows],
      colExtent: [0, cols],
    }
  }

  it('takes the zoom from the columns alone', () => {
    const heatmap = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    heatmap.setFitAxis('cols')
    heatmap.setAnchor('end')
    heatmap.setMatrix(band(20, 200), [])
    // 400 px over 200 columns. Fitted on both axes it would have been 400/200
    // against 400/20 — the rows would have won nothing, but a *deeper* band
    // would have, and that is the case that stopped the picture being a band.
    expect(heatmap.zoomLevel).toBeCloseTo(2, 6)
    const deeper = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    deeper.setFitAxis('cols')
    deeper.setAnchor('end')
    deeper.setMatrix(band(300, 200), [])
    expect(deeper.zoomLevel).toBeCloseTo(2, 6)
  })

  it('keeps the diagonal on the floor, with no vertical pan to lose it', () => {
    const heatmap = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    heatmap.setFitAxis('cols')
    heatmap.setAnchor('end')
    // Deeper than the box: at 2 px a cell a 400 px plot holds 200 rows.
    heatmap.setMatrix(band(300, 200), [])
    const plot = heatmap.plotRect
    const floor = (): number | undefined =>
      heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height - 1)?.row
    expect(floor()).toBe(299)
    // A drag up the picture would pan a square map. Up the side of a band there
    // is nothing to pan to: the diagonal is the floor at every zoom.
    heatmap.panBy(0, -300)
    expect(floor()).toBe(299)
    heatmap.panBy(0, 300)
    expect(floor()).toBe(299)
  })

  it('re-cuts without moving the window', () => {
    const heatmap = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    heatmap.setFitAxis('cols')
    heatmap.setAnchor('end')
    heatmap.setMatrix(band(60, 200), [])
    heatmap.zoomAt(200, 200, 4)
    const zoom = heatmap.zoomLevel
    const plot = heatmap.plotRect
    const leftEdge = heatmap.cellAt(plot.x + 1, plot.y + plot.height - 1)?.col

    // Zooming out asks for a deeper band; the panel hands one over.
    heatmap.reshape(band(240, 200))

    expect(heatmap.zoomLevel).toBeCloseTo(zoom, 6)
    expect(heatmap.cellAt(plot.x + 1, plot.y + plot.height - 1)?.col).toBe(leftEdge)
    // …and the deeper band still stands on its own diagonal.
    expect(heatmap.cellAt(plot.x + 1, plot.y + plot.height - 1)?.row).toBe(239)
  })

  /**
   * A derivation is *the same grid with new numbers*, and the length is what
   * says so.
   *
   * The one caller that can break that is a turned map: its band is re-cut
   * behind the picture as the zoom moves, so a derivation computed for the depth
   * the box wants now can arrive at a grid of another depth. Swapped in blind,
   * it is read with the grid's stride — every row a different separation from
   * the one it is drawn at, and a tail of memory nothing wrote beneath them,
   * which colours as a solid block of the scale's floor. A convincing picture of
   * data that does not exist is the worst thing this class can produce, so a
   * length that does not fit is treated as the reshape it is.
   */
  it('reshapes rather than swaps when the values are a different shape', () => {
    const heatmap = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    heatmap.setFitAxis('cols')
    heatmap.setAnchor('end')
    heatmap.setMatrix(band(60, 200), [])
    const deeper = band(240, 200)
    heatmap.setValues(deeper.values)
    expect(heatmap.block?.nrows).toBe(240)
    expect(heatmap.block?.values.length).toBe(240 * 200)
    // …and it is still a band standing on its own diagonal.
    const plot = heatmap.plotRect
    expect(heatmap.cellAt(plot.x + 1, plot.y + plot.height - 1)?.row).toBe(239)
  })

  /**
   * **A band deeper than the box is the same picture**, and this is the licence
   * for the panel not to re-cut one on the way in. Zooming in asks for less
   * distance at every notch; re-cutting for each of them is a rotation and a
   * fresh pooling of the whole band per wheel event, which on a chromosome-wide
   * view at a fine resolution is seconds of blocked main thread for a picture
   * that was already correct. It is only correct because of what is asserted
   * here: the band stands on the box's floor either way, so the rows on screen
   * are the same rows and the ones the extra depth adds are off the top, where
   * the same clip that takes the columns past either end takes them.
   */
  it('shows the same rows however much deeper than the box the band was cut', () => {
    const shallow = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    const deep = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    for (const view of [shallow, deep]) {
      view.setFitAxis('cols')
      view.setAnchor('end')
    }
    // 200 columns in 400 px is 2 px a cell, so the box holds 200 rows. One band
    // is cut to exactly that and the other to four times it.
    shallow.setMatrix(band(200, 200), [])
    deep.setMatrix(band(800, 200), [])
    expect(shallow.zoomLevel).toBeCloseTo(deep.zoomLevel, 6)

    const plot = shallow.plotRect
    // Separation is counted from the floor up, which is what makes the two
    // comparable: row indices differ by the extra depth and distances do not.
    const separationAt = (view: HeatmapView, y: number): number | undefined => {
      const cell = view.cellAt(plot.x + plot.width / 2, y)
      return cell === null ? undefined : view.block!.nrows - 1 - cell.row
    }
    for (const dy of [1, 20, 100, 199]) {
      const y = plot.y + plot.height - dy
      expect(separationAt(deep, y)).toBe(separationAt(shallow, y))
    }
  })
})

/**
 * Being *told* where to stand, in cells (§8.10).
 *
 * A bookmark names a stretch of genome, the panel turns it into cells, and this
 * is what the view does with them. The two shapes are different questions and
 * that is the whole of what is asserted here.
 *
 * A **square** map takes a row window and a column window, because an on-diagonal
 * locus is a square and both axes mean position. A **band** cannot: up its side is
 * distance from the diagonal, its height in cells is chosen so the cut fills the
 * box at fit zoom, and so asking for "these rows" asks for fit zoom whatever
 * window was named. So a band is given the column span alone and the vertical
 * follows — which is `zoomToSpan`'s rule, reached from a caller that has cells
 * rather than pixels.
 */
describe('showing a window that came from outside', () => {
  it('stands a square map on the window, both axes', () => {
    const heatmap = view(400, 100)
    heatmap.showCellWindow([20, 40], [20, 40])
    const plot = heatmap.plotRect
    const centre = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(centre?.row).toBeCloseTo(30, 0)
    expect(centre?.col).toBeCloseTo(30, 0)
    // 20 cells across 400 px, so the whole window is on screen at 20 px a cell.
    expect(heatmap.zoomLevel).toBeCloseTo(20, 6)
  })

  it('stands a band on a column span, and does not ask its rows for one', () => {
    // A band 200 rows deep in a 400 px box is at fit zoom already; a row window
    // would therefore cap the zoom at the fit and the bookmark would never arrive.
    const heatmap = new HeatmapView(fakeCanvas(400), { devicePixelRatio: 1 })
    heatmap.setFitAxis('cols')
    heatmap.setAnchor('end')
    heatmap.setMatrix(
      { nrows: 200, ncols: 200, values: new Float32Array(200 * 200), rowExtent: [0, 200], colExtent: [0, 200] },
      [],
    )
    const fitted = heatmap.zoomLevel
    heatmap.showCellSpan([80, 100])
    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)
    const plot = heatmap.plotRect
    const centre = heatmap.cellAt(plot.x + plot.width / 2, plot.y + plot.height / 2)
    expect(centre?.col).toBeCloseTo(90, 0)
  })

  it('reports the window it actually reached, not the one asked for', () => {
    // `clampView` is what stops a span near the end of a block from sliding into
    // empty space, and the honest answer afterwards is where the picture is.
    const heatmap = view(400, 100)
    heatmap.showCellSpan([95, 115])
    const shown = heatmap.cellWindow()
    expect(shown.cols[1]).toBeLessThanOrEqual(100)
    expect(shown.cols[0]).toBeGreaterThanOrEqual(0)
  })

  it('leaves a frozen view alone, as every other gesture does', () => {
    // Held while a finer block is being read: the picture must be exactly where
    // the reader left it when the swap happens.
    const heatmap = view(400, 100)
    const before = heatmap.cellWindow()
    heatmap.setFrozen(true)
    heatmap.showCellSpan([20, 40])
    expect(heatmap.cellWindow()).toEqual(before)
    heatmap.setFrozen(false)
  })

  it('refuses a span of nothing rather than dividing by it', () => {
    const heatmap = view(400, 100)
    const before = heatmap.zoomLevel
    heatmap.showCellSpan([50, 50])
    // A zero-width window is a point, and the zoom it asks for is the ceiling
    // rather than infinity — which is what a bookmark of one base pair is.
    expect(Number.isFinite(heatmap.zoomLevel)).toBe(true)
    expect(heatmap.zoomLevel).toBeGreaterThanOrEqual(before)
  })
})

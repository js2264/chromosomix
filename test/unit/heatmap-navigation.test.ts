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
      return { putImageData: () => {} }
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

describe('a sideways gesture belongs to the browser', () => {
  it('zooms on a vertical wheel and stands aside for a horizontal one', () => {
    const { canvas, fire } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()

    let prevented = 0
    const wheel = (deltaX: number, deltaY: number): void =>
      fire('wheel', {
        clientX: 200,
        clientY: 200,
        deltaX,
        deltaY,
        preventDefault: () => {
          prevented++
        },
      })

    const fitted = heatmap.zoomLevel
    wheel(0, -200)
    expect(heatmap.zoomLevel).toBeGreaterThan(fitted)
    expect(prevented).toBe(1)

    // Two fingers sideways is the browser's back gesture. It works everywhere
    // else on the page, so it must not die on the one element that fills it.
    const zoomed = heatmap.zoomLevel
    wheel(-180, 4)
    expect(heatmap.zoomLevel).toBe(zoomed)
    expect(prevented).toBe(1)
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

  it('names columns for a 4C drag whichever way the hand went', () => {
    const { canvas, fire } = harness(400)
    const asked: Array<{ axis: string; span: [number, number] }> = []
    const heatmap = new HeatmapView(canvas, {
      devicePixelRatio: 1,
      onAnchor: (axis, span) => asked.push({ axis, span }),
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
      onAnchor: (axis) => asked.push(axis),
    })
    heatmap.setMatrix(block(100), [])
    heatmap.attach()

    dragWith(fire, [200, 100], [210, 300], { shiftKey: true })

    expect(asked).toEqual(['rows'])
  })
})

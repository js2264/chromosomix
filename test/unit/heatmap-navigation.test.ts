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

import { HeatmapView } from '@/render/heatmap'
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
    classList: { toggle: () => {} },
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

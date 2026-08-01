/**
 * Navigation: drag-to-zoom, and the wall at the edge of the data.
 *
 * Both are arithmetic over the view transform, and both are the kind of thing
 * that looks right in a screenshot taken at one zoom level and is wrong at
 * another. Asserted through `cellAt`, which is what the app itself uses to turn
 * a pixel into a bin — so these tests fail if the transform and the hit testing
 * ever disagree, which is the failure that actually matters.
 */

import { describe, expect, it } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import type { DenseMatrix } from '@/types'

function fakeCanvas(size: number): HTMLCanvasElement {
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
  return {
    width: 0,
    height: 0,
    clientWidth: size,
    clientHeight: size,
    tabIndex: 0,
    classList: { toggle: () => {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size }),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
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

/**
 * How often the picture is rebuilt, and what is allowed to rebuild it.
 *
 * `render/heatmap.ts` opens by naming the three events that re-rasterise — a new
 * matrix, a new colour scale, a new colormap — and the three that must not: a
 * pan, a zoom, a resize. That rule is the whole reason the app needs no tile
 * server: a wheel notch costs a `setTransform` and a `drawImage`, and never a
 * pass over a hundred million cells.
 *
 * It had nothing behind it. Every canvas stub in this suite makes `putImageData`
 * a no-op, so a change that re-coloured the block on every frame would have gone
 * green everywhere, and the first sign of it would have been a dropped frame on
 * somebody's machine. `HeatmapView.rasterisations` is a counter incremented
 * where the work actually happens, which is what lets the rule be asserted
 * rather than restated.
 *
 * It is checked here before `regrid` (the zoom-to-refine swap) starts handing
 * this class new blocks under a live transform: the one thing a refine must not
 * do is turn a gesture into a re-colour, and the last two cases pin the halves
 * of that — a swap rasterises exactly once, and the zoom that provoked it
 * rasterises not at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
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
      // `drawImage` is what a halving of the raster costs — the blocks below are
      // magnified, so no level is built, but a stub that could not take one
      // would fail on a block size rather than on a rasterisation count.
      return { putImageData: () => {}, drawImage: () => {}, imageSmoothingEnabled: false }
    }
  }
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

function stubCanvas(size = 400): HTMLCanvasElement {
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
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size }),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
}

function block(n: number, fill = 1): DenseMatrix {
  const values = new Float32Array(n * n)
  values.fill(fill)
  return { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] }
}

function view(size = 400): HeatmapView {
  return new HeatmapView(stubCanvas(size), { devicePixelRatio: 1 })
}

describe('what rebuilds the raster', () => {
  it('builds one for a new block, and only when it is drawn', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    // `setMatrix` marks it dirty; the work is deferred to the draw, so a caller
    // that sets a matrix and a scale before the first frame pays once.
    expect(heatmap.rasterisations).toBe(0)
    heatmap.draw()
    expect(heatmap.rasterisations).toBe(1)
    heatmap.draw()
    expect(heatmap.rasterisations).toBe(1)
  })

  it('does not build one for a pan, a zoom or a resize', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.draw()
    const after = heatmap.rasterisations

    for (let i = 0; i < 20; i++) {
      heatmap.zoomAt(200, 200, 1.1)
      heatmap.draw()
    }
    heatmap.panBy(37, -14)
    heatmap.draw()
    heatmap.resize()
    heatmap.draw()
    heatmap.fit()
    heatmap.draw()

    expect(heatmap.rasterisations, 'a gesture must never re-colour the block').toBe(after)
  })

  it('builds one for a new colour scale', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.draw()
    const after = heatmap.rasterisations
    heatmap.setScale({ vmin: 0, vmax: 5, transform: 'log1p', colormap: 'afmhot_r' })
    heatmap.draw()
    expect(heatmap.rasterisations).toBe(after + 1)
  })

  it('refuses gestures while frozen, and takes them again after', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.draw()
    heatmap.zoomAt(200, 200, 2)
    const held = { zoom: heatmap.zoomLevel, window: heatmap.cellWindow() }

    heatmap.setFrozen(true)
    expect(heatmap.isFrozen).toBe(true)
    // Everything a reader can do to move the picture, refused. The block that
    // is about to arrive was asked for against *this* window, so a zoom that
    // ran on underneath would land it against one that had moved — the reader
    // would see a jump, and the jump would be the app catching up.
    heatmap.zoomAt(200, 200, 4)
    heatmap.panBy(50, 50)
    heatmap.fit()
    heatmap.showCellWindow([0, 8], [0, 8])
    expect(heatmap.zoomLevel).toBe(held.zoom)
    expect(heatmap.cellWindow()).toEqual(held.window)
    // …and no re-colouring for any of it, frozen or not.
    heatmap.draw()

    heatmap.setFrozen(false)
    heatmap.zoomAt(200, 200, 2)
    expect(heatmap.zoomLevel).toBeGreaterThan(held.zoom)
  })

  it('lets Escape out of a freeze, and refuses other keys while held', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.draw()
    let cancelled = 0
    heatmap.setFrozen(true, () => {
      cancelled += 1
    })
    const held = heatmap.cellWindow()

    // An arrow key is a pan, and a pan is refused like every other gesture.
    heatmap.handleKeyDown({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent)
    expect(heatmap.cellWindow()).toEqual(held)
    expect(cancelled).toBe(0)

    heatmap.handleKeyDown({ key: 'Escape', preventDefault: () => {} } as KeyboardEvent)
    expect(cancelled, 'a held map must always have a way out').toBe(1)
  })

  it('a new block ends a freeze', () => {
    // A navigation is a different question from the one the freeze was waiting
    // on; leaving the map held for a read nobody is waiting for any more is how
    // an app looks broken.
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.setFrozen(true)
    heatmap.setMatrix(block(32))
    expect(heatmap.isFrozen).toBe(false)
  })

  it('does not re-rasterise while a freeze is drawn', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.draw()
    const after = heatmap.rasterisations
    heatmap.setFrozen(true)
    for (let i = 0; i < 10; i++) heatmap.draw()
    heatmap.setFrozen(false)
    heatmap.draw()
    // The spinner turns on a `requestAnimationFrame` loop that calls `draw`, so
    // a spinner that cost a raster would cost one sixty times a second while
    // the reader waits — on the very block a slow read says is large.
    expect(heatmap.rasterisations).toBe(after)
  })

  it('builds exactly one for a block swapped in under a live transform', () => {
    const heatmap = view()
    heatmap.setMatrix(block(64))
    heatmap.draw()
    heatmap.zoomAt(200, 200, 4)
    heatmap.draw()
    const after = heatmap.rasterisations

    // The refine's shape: a finer block over the window the reader is holding.
    heatmap.regrid(block(256), { rows: [10, 42], cols: [10, 42] })
    heatmap.draw()
    expect(heatmap.rasterisations, 'one swap is one raster').toBe(after + 1)

    // And the zoom that follows it is free again.
    heatmap.zoomAt(200, 200, 1.5)
    heatmap.draw()
    expect(heatmap.rasterisations).toBe(after + 1)
  })
})

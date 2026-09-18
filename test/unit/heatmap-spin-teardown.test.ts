/**
 * What a view stops doing when it is taken off the page.
 *
 * `HeatmapView.setStreaming(true)` starts a `requestAnimationFrame` chain that
 * turns the spinner: `tick` re-arms itself and calls `draw()` for as long as
 * `frozen` is true. The only thing that ever stopped it was `setStreaming(false)`,
 * and no teardown path calls that — the ladder holding the freeze is
 * *destroyed* rather than aborted, so the `onBusy(false)` that would have
 * released it never runs, and `detach()` cancelled only the view's own deferred
 * redraw. A panel closed while a refine read was in flight therefore went on
 * blitting its raster once per vsync for the life of the tab, holding that
 * view's matrix, raster and offscreen canvas alive behind the `tick` closure.
 *
 * Which is invisible in the ordinary suite: under Node there is no
 * `requestAnimationFrame`, so `frameLoop` returns `null` and the chain never
 * starts (see its comment). The frame clock below is what makes the leak
 * observable at all, and is the reason this is its own file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import type { DenseMatrix } from '@/types'

/** Callbacks waiting on the next frame, by handle. */
const queued = new Map<number, FrameRequestCallback>()
let nextHandle = 1
/** How many times the view blitted its raster to the canvas. */
let blits = 0

/**
 * Run every callback currently waiting, once.
 *
 * Drained first, so a callback that re-arms itself lands in the *next* frame
 * rather than in this one — which is what a real animation loop does, and what
 * lets `queued.size` after a pump mean "still turning".
 */
function pump(frames = 1): void {
  for (let i = 0; i < frames; i++) {
    const due = [...queued.values()]
    queued.clear()
    for (const run of due) run(i)
  }
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g['requestAnimationFrame'] = (run: FrameRequestCallback): number => {
    const handle = nextHandle++
    queued.set(handle, run)
    return handle
  }
  g['cancelAnimationFrame'] = (handle: number): void => {
    queued.delete(handle)
  }
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
  delete g['requestAnimationFrame']
  delete g['cancelAnimationFrame']
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

afterEach(() => {
  queued.clear()
  blits = 0
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
    arc: () => {},
    stroke: () => {},
    fill: () => {},
    fillText: () => {},
    strokeText: () => {},
    clip: () => {},
    rect: () => {},
    setTransform: () => {},
    putImageData: () => {},
    drawImage: () => {
      blits += 1
    },
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

function block(n: number): DenseMatrix {
  const values = new Float32Array(n * n)
  values.fill(1)
  return { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] }
}

function streamingView(): HeatmapView {
  const heatmap = new HeatmapView(stubCanvas(), { devicePixelRatio: 1 })
  heatmap.setMatrix(block(64))
  heatmap.draw()
  heatmap.setStreaming(true)
  return heatmap
}

describe('a view torn down while a read is out for it', () => {
  it('turns its spinner for as long as it is on the page', () => {
    // The control: without this the assertions below would pass against a view
    // that had simply never started a loop.
    const heatmap = streamingView()
    expect(heatmap.isStreaming).toBe(true)
    pump(30)
    expect(queued.size, 'the loop re-arms itself every frame').toBe(1)
    expect(blits).toBeGreaterThan(0)
  })

  it('stops turning it on detach', () => {
    const heatmap = streamingView()
    pump(5)
    expect(queued.size).toBe(1)

    heatmap.detach()
    expect(queued.size, 'nothing left waiting on a frame').toBe(0)

    blits = 0
    pump(60)
    expect(queued.size).toBe(0)
    // A second of vsyncs on a canvas that is no longer in the document.
    expect(blits, 'a detached view must not draw').toBe(0)
  })

  it('ends the streaming state itself, not just the timer it scheduled', () => {
    // Cancelling `spinTimer` alone would leave `frozen` true, and any later
    // `draw()` on the same instance would take the frozen branch and paint a
    // spinner — so the flag has to go with it.
    const heatmap = streamingView()
    heatmap.detach()
    expect(heatmap.isStreaming).toBe(false)

    heatmap.draw()
    pump(30)
    expect(queued.size, 'a draw after detach must not restart the loop').toBe(0)
  })

  it('is idempotent, as its docblock says', () => {
    const heatmap = streamingView()
    heatmap.detach()
    heatmap.detach()
    expect(queued.size).toBe(0)
    expect(heatmap.isStreaming).toBe(false)
  })

  it('leaves a quiet view’s teardown exactly as it was', () => {
    const heatmap = new HeatmapView(stubCanvas(), { devicePixelRatio: 1 })
    heatmap.setMatrix(block(64))
    heatmap.draw()
    // A gesture defers its redraw to a frame; `detach` has always cancelled
    // that one, and still must.
    heatmap.panBy(20, 20)
    expect(queued.size).toBe(1)
    heatmap.detach()
    expect(queued.size).toBe(0)
    expect(heatmap.isStreaming).toBe(false)
  })
})

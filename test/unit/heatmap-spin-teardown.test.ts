/**
 * What a view stops doing when it is taken off the page.
 *
 * `HeatmapView.setWaiting(true)` starts a `requestAnimationFrame` chain that
 * turns the spinner: `tick` re-arms itself and calls `draw()` for as long as
 * the wait lasts. The only thing that ever stopped it was ending the wait, and
 * no teardown path does that — the ladder whose read started it is *destroyed*
 * rather than finished, so the `onBusy(false)` that would have ended it never
 * runs, and `detach()` cancelled only the view's own deferred redraw. A panel
 * closed while a refine read was in flight therefore went on blitting its
 * raster once per vsync for the life of the tab, holding that view's matrix,
 * raster and offscreen canvas alive behind the `tick` closure. (The wait was a
 * freeze then, which also held the gestures; the leak was the spinner's.)
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

/** What the stub context was asked to draw, for the spinner's placement. */
interface Drawn {
  arcs: Array<{ x: number; y: number; r: number }>
  texts: Array<{ text: string; x: number; y: number; align: string }>
}

function stubCanvas(size = 400, drawn: Drawn | null = null): HTMLCanvasElement {
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
    arc: (x: number, y: number, r: number) => {
      drawn?.arcs.push({ x, y, r })
    },
    stroke: () => {},
    fill: () => {},
    fillText(this: { textAlign: string }, text: string, x: number, y: number) {
      drawn?.texts.push({ text, x, y, align: this.textAlign })
    },
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

function waitingView(): HeatmapView {
  const heatmap = new HeatmapView(stubCanvas(), { devicePixelRatio: 1 })
  heatmap.setMatrix(block(64))
  heatmap.draw()
  heatmap.setWaiting(true)
  return heatmap
}

describe('a view torn down while it waits', () => {
  it('turns its spinner for as long as it is on the page', () => {
    // The control: without this the assertions below would pass against a view
    // that had simply never started a loop.
    const heatmap = waitingView()
    expect(heatmap.isWaiting).toBe(true)
    pump(30)
    expect(queued.size, 'the loop re-arms itself every frame').toBe(1)
    expect(blits).toBeGreaterThan(0)
  })

  it('stops turning it on detach', () => {
    const heatmap = waitingView()
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

  it('ends the wait itself, not just the timer it scheduled', () => {
    // Cancelling `spinTimer` alone would leave the wait standing, and any later
    // `draw()` on the same instance would paint a spinner — so the flag has to
    // go with it.
    const heatmap = waitingView()
    heatmap.detach()
    expect(heatmap.isWaiting).toBe(false)

    heatmap.draw()
    pump(30)
    expect(queued.size, 'a draw after detach must not restart the loop').toBe(0)
  })

  it('is idempotent, as its docblock says', () => {
    const heatmap = waitingView()
    heatmap.detach()
    heatmap.detach()
    expect(queued.size).toBe(0)
    expect(heatmap.isWaiting).toBe(false)
  })

  it('stops the spinner when the wait ends, and again on detach', () => {
    // A stand-in on screen while its block reads (§7.2), or a sharper block
    // read for the window on screen (§2): the loop must end with the wait, and
    // with the view.
    const heatmap = new HeatmapView(stubCanvas(), { devicePixelRatio: 1 })
    heatmap.setMatrix(block(64))
    heatmap.draw()
    heatmap.setWaiting(true)
    pump(5)
    expect(queued.size, 'the loop re-arms itself every frame').toBe(1)
    heatmap.setWaiting(false)
    pump(2)
    expect(queued.size, 'a wait that ended stops the loop').toBe(0)

    heatmap.setWaiting(true)
    pump(2)
    heatmap.detach()
    expect(queued.size).toBe(0)
    expect(heatmap.isWaiting).toBe(false)
    heatmap.draw()
    pump(30)
    expect(queued.size, 'a draw after detach must not restart the loop').toBe(0)
  })

  it('stands the spinner clear of the axis labels drawn inside the plot', async () => {
    // A preview spins while the reader zooms it (§7.2), and the first label on
    // each axis is the one they read. Each label is boxed as the stub measures
    // it, 7 px a character, 12 px tall above its baseline for a column label
    // and centred on its row for a row label; the spinner's disc must meet none.
    const drawn: Drawn = { arcs: [], texts: [] }
    const heatmap = new HeatmapView(stubCanvas(400, drawn), { devicePixelRatio: 1 })
    heatmap.setMatrix(block(64))
    heatmap.setAxisCoords({ rows: { bpPerCell: 1000, bpAtOrigin: 0 }, cols: { bpPerCell: 1000, bpAtOrigin: 0 } })
    heatmap.setWaiting(true)
    // Past the grace period, so the spinner is drawn at all.
    await new Promise((resolve) => setTimeout(resolve, 180))
    drawn.arcs.length = 0
    drawn.texts.length = 0
    heatmap.draw()
    expect(drawn.texts.length).toBeGreaterThan(2)
    const disc = drawn.arcs.at(0)
    expect(disc, 'the spinner was drawn').toBeDefined()
    if (disc === undefined) return
    const reach = disc.r
    for (const label of drawn.texts) {
      const width = label.text.length * 7
      const box =
        label.align === 'center'
          ? { left: label.x - width / 2, right: label.x + width / 2, top: label.y - 12, bottom: label.y }
          : { left: label.x, right: label.x + width, top: label.y - 6, bottom: label.y + 6 }
      const nearX = Math.max(box.left, Math.min(disc.x, box.right))
      const nearY = Math.max(box.top, Math.min(disc.y, box.bottom))
      expect(Math.hypot(disc.x - nearX, disc.y - nearY), `the spinner over “${label.text}”`).toBeGreaterThan(reach)
    }
    heatmap.setWaiting(false)
  })

  it('leaves the teardown of a view with no wait exactly as it was', () => {
    const heatmap = new HeatmapView(stubCanvas(), { devicePixelRatio: 1 })
    heatmap.setMatrix(block(64))
    heatmap.draw()
    // A gesture defers its redraw to a frame; `detach` has always cancelled
    // that one, and still must.
    heatmap.panBy(20, 20)
    expect(queued.size).toBe(1)
    heatmap.detach()
    expect(queued.size).toBe(0)
    expect(heatmap.isWaiting).toBe(false)
  })
})

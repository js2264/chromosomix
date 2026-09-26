// @vitest-environment jsdom
/**
 * *Copy this* copies the picture and nothing else (§7.2).
 *
 * The right-click menu on the map, on a lane beside it and on a lane of the
 * 1D browser carries a row that puts the data object under the pointer on the
 * clipboard as a PNG — as it is drawn on screen, at the screen's own density,
 * and with none of what is drawn round it: no axis or tick, no key, no frame,
 * no track name or range, no pointer's line. The Export card's copy is a
 * *figure*, labelled and captioned; this is the object, for a reader pasting it
 * into their own figure.
 *
 * Asserted off what each drawing pass does into the canvas it is handed: the
 * cells, drawn once, on the page's colour, and not a letter of text.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CROSSHAIR_COLOR, HeatmapView } from '@/render/heatmap'
import type { DenseMatrix } from '@/types'

interface Recorded {
  images: number
  text: string[]
  strokes: string[]
  fills: Array<{ style: string; composite: string }>
}

function recorder(): { ctx: CanvasRenderingContext2D; seen: Recorded } {
  const seen: Recorded = { images: 0, text: [], strokes: [], fills: [] }
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    measureText: (text: string) => ({ width: text.length * 7 }),
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    clearRect: () => {},
    fillRect: () => {
      seen.fills.push({ style: String(ctx.fillStyle), composite: String(ctx.globalCompositeOperation) })
    },
    strokeRect: () => {
      seen.strokes.push(String(ctx.strokeStyle))
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    closePath: () => {},
    stroke: () => {
      seen.strokes.push(String(ctx.strokeStyle))
    },
    fill: () => {},
    fillText: (text: string) => {
      seen.text.push(text)
    },
    strokeText: () => {},
    clip: () => {},
    rect: () => {},
    roundRect: () => {},
    setTransform: () => {},
    setLineDash: () => {},
    drawImage: () => {
      seen.images++
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, seen }
}

let made: Array<{ width: number; height: number; seen: Recorded }> = []
let createElement: typeof document.createElement

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
  // Every canvas the copy makes answers with a recorder of its own.
  createElement = document.createElement.bind(document)
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    if (tag !== 'canvas') return createElement(tag, options)
    const { ctx, seen } = recorder()
    const canvas = { width: 0, height: 0, getContext: () => ctx }
    const entry = { get width() { return canvas.width }, get height() { return canvas.height }, seen }
    made.push(entry)
    return canvas as unknown as HTMLCanvasElement
  }) as typeof document.createElement
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
  document.createElement = createElement
})

function square(bins: number): DenseMatrix {
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins).fill(1),
    rowExtent: [0, bins],
    colExtent: [0, bins],
  }
}

/** A map drawn on screen with everything it can draw round the cells turned on. */
function onScreen(dpr: number): HeatmapView {
  const { ctx } = recorder()
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 400,
    clientHeight: 400,
    tabIndex: 0,
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
  const heatmap = new HeatmapView(canvas, {
    devicePixelRatio: dpr,
    plotOptions: { crosshair: true, dividers: true, breaks: true, labels: true, ticks: true },
  })
  heatmap.setMatrix(square(40), {
    rows: [{ label: 'IV', start: 0, end: 40 }],
    cols: [{ label: 'IV', start: 0, end: 40 }],
  } as never)
  heatmap.attach()
  return heatmap
}

describe('copying the map under the pointer', () => {
  it('is the cells the plot shows, at the screen’s density', () => {
    made = []
    const heatmap = onScreen(2)
    const data = heatmap.dataRect
    const out = heatmap.dataImage('#fdfdfd')
    expect(out).not.toBeNull()
    const canvas = made.at(-1)
    expect(canvas?.width).toBe(Math.round(data.width * 2))
    expect(canvas?.height).toBe(Math.round(data.height * 2))
  })

  it('draws the cells once, on the page’s colour, and nothing round them', () => {
    made = []
    const heatmap = onScreen(1)
    heatmap.dataImage('#fdfdfd')
    const seen = made.at(-1)?.seen
    expect(seen?.images).toBe(1)
    // No label, tick or key: not a letter of text.
    expect(seen?.text).toEqual([])
    // No frame, divider or guide line.
    expect(seen?.strokes).toEqual([])
    expect(seen?.strokes).not.toContain(CROSSHAIR_COLOR)
    // The page under the cells, laid *behind* them, so a cell the colormap
    // leaves clear is the page's colour and not a hole in the PNG.
    expect(seen?.fills).toContainEqual({ style: '#fdfdfd', composite: 'destination-over' })
  })

  it('leaves the map on screen drawing everything it did', () => {
    const heatmap = onScreen(1)
    const { ctx: before, seen: was } = recorder()
    heatmap.renderTo(before, 1)
    heatmap.dataImage('#ffffff')
    const { ctx, seen } = recorder()
    heatmap.renderTo(ctx, 1)
    // The frame and whatever else is drawn round the cells are back on the
    // next pass: the copy borrowed the renderer and gave it back.
    expect(was.strokes.length).toBeGreaterThan(0)
    expect(seen.strokes).toEqual(was.strokes)
    expect(seen.text).toEqual(was.text)
  })

  it('answers nothing where nothing is drawn', () => {
    const { ctx } = recorder()
    const canvas = {
      width: 0,
      height: 0,
      clientWidth: 400,
      clientHeight: 400,
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      getContext: () => ctx,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
      addEventListener: () => {},
      removeEventListener: () => {},
      style: {},
    } as unknown as HTMLCanvasElement
    const empty = new HeatmapView(canvas, { devicePixelRatio: 1 })
    expect(empty.dataImage('#ffffff')).toBeNull()
  })
})

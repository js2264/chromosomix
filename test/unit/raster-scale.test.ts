/**
 * When the browser is allowed to filter the raster, and when it is not.
 *
 * Filtering exists for one job: while the image is *minified*, point sampling
 * drops most of a sparse contact map's non-zero cells, and a dimmed pixel is a
 * better lie than a missing one. While it is magnified there is nothing to drop,
 * and filtering only blurs — across contig boundaries, which is where it turns
 * "these two sequences do not touch" into a smear that says they do.
 *
 * The test that matters is which pixels the question is asked about. The image
 * is placed at `zoom × stride × dpr`, so on a 2× display everything between one
 * and two raster pixels per device pixel is magnified — and was being smoothed,
 * because the predicate was written in CSS pixels. The same slip made every
 * export smooth: `renderTo` puts the DPI scale in `dpr`, so a 300 dpi figure was
 * asked the screen's question.
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
      return { putImageData: () => {} }
    }
  }
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

function harness(size: number): { canvas: HTMLCanvasElement; ctx: { imageSmoothingEnabled: boolean } } {
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
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
  return { canvas, ctx }
}

function block(n: number): DenseMatrix {
  return { nrows: n, ncols: n, values: new Float32Array(n * n), rowExtent: [0, n], colExtent: [0, n] }
}

/** Whether the browser filtered, for a block of `n` cells at `dpr`. */
function smoothed(n: number, dpr: number, size = 400): boolean {
  const { canvas, ctx } = harness(size)
  const heatmap = new HeatmapView(canvas, { devicePixelRatio: dpr })
  heatmap.setMatrix(block(n))
  heatmap.draw()
  return ctx.imageSmoothingEnabled
}

describe('raster filtering', () => {
  it('filters while the picture is smaller than the data', () => {
    // 4,000 cells in 400 CSS px at dpr 1 is one device pixel per ten cells:
    // point sampling would drop nine of every ten.
    expect(smoothed(4000, 1)).toBe(true)
  })

  it('does not filter a block with a device pixel or more per cell', () => {
    // 100 cells in 400 px is four pixels a cell at dpr 1 — nothing to drop.
    expect(smoothed(100, 1)).toBe(false)
    expect(smoothed(100, 2)).toBe(false)
  })

  it('asks the question in device pixels, not CSS pixels', () => {
    // 600 cells in 400 CSS px: 0.67 CSS px per cell, so the CSS test says
    // "minifying". At dpr 2 it is 1.33 *device* pixels per cell, which is
    // magnification, and filtering there blurs an image nothing was dropping
    // from. This is the case that made a 2× display softer than a 1× one.
    expect(smoothed(600, 1)).toBe(true)
    expect(smoothed(600, 2)).toBe(false)
  })
})

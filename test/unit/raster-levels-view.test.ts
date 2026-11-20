/**
 * A large block on screen, drawn level by level (`render/levels.ts`): what the
 * first frame makes, what a zoom draws while a finer level is painted between
 * frames, and what an export waits for.
 *
 * The rules a reader feels rather than sees. The first frame makes one level,
 * the one it draws, and nothing it does not — that is the whole of the first
 * picture's cost. A zoom never re-colours the block and never waits: it draws the
 * nearest level made, and the one it wants lands a few frames later. And a figure
 * is never the stand-in: an export makes its exact level there and then.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HeatmapView, autoRangeOfPooled, poolDisplay } from '@/render/heatmap'
import type { ColorScale, DenseMatrix } from '@/types'

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
    static made = 0
    width: number
    height: number
    constructor(width = 0, height = 0) {
      this.width = width
      this.height = height
      ;(g['OffscreenCanvas'] as { made: number }).made++
    }
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

/** One `drawImage` of the raster: the size of what was sampled. */
interface Blit {
  source: { width: number; height: number }
}

function context(): { blits: Blit[] } & Record<string, unknown> {
  const ctx = {
    blits: [] as Blit[],
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: false,
    globalCompositeOperation: '',
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
    drawImage: (source: { width: number; height: number }) => {
      ctx.blits.push({ source: { width: source.width, height: source.height } })
    },
  }
  return ctx
}

function view(size = 400): { heatmap: HeatmapView; ctx: ReturnType<typeof context> } {
  const ctx = context()
  const canvas = {
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
  return { heatmap: new HeatmapView(canvas, { devicePixelRatio: 1 }), ctx }
}

/**
 * A block past `LEVEL_MIN_CELLS`, dense enough to be read whole — so a level of
 * it takes more than one slice to paint and a zoom has a stand-in to draw — or,
 * `sparse`, a bright diagonal alone, whose levels are painted from its listed
 * cells (`listCells`).
 */
function block(n = 4000, sparse = false): DenseMatrix {
  const values = new Float32Array(n * n)
  if (sparse) {
    for (let i = 0; i < n; i++) {
      values[i * n + i] = 50
      if (i + 1 < n) values[i * n + i + 1] = values[(i + 1) * n + i] = 7
    }
  } else {
    for (let i = 0; i < values.length; i++) values[i] = 1 + (i % 7)
  }
  return { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] }
}

const made = (): number => (globalThis as unknown as Record<string, { made: number }>)['OffscreenCanvas'].made

/** Hand the event loop back until the view stops sharpening, as the frames between would. */
async function settled(heatmap: HeatmapView): Promise<void> {
  for (let turns = 0; heatmap.sharpening && turns < 10_000; turns++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('a large block’s first frame', () => {
  it('makes the one level it draws, and colours the block once', () => {
    const { heatmap, ctx } = view()
    heatmap.setMatrix(block())
    const before = made()
    heatmap.draw()
    expect(made() - before).toBe(1)
    expect(heatmap.levelsMade).toBe(1)
    expect(heatmap.rasterisations).toBe(1)
    expect(heatmap.sharpening).toBe(false)
    expect(ctx.blits[ctx.blits.length - 1].source.width).toBe(500)
  })

  it('reads the colour range the whole-image path read', () => {
    const matrix = block()
    const { heatmap } = view()
    const scale: ColorScale = { vmin: Number.NaN, vmax: Number.NaN, transform: 'log1p', colormap: 'default' }
    heatmap.setScale(scale)
    heatmap.setMatrix(matrix)
    heatmap.draw()
    const expected = autoRangeOfPooled(poolDisplay(matrix, scale))
    expect(heatmap.effectiveScale.vmin).toBe(expected.vmin)
    expect(heatmap.effectiveScale.vmax).toBe(expected.vmax)
  })
})

describe('a zoom on a large block', () => {
  it('draws the nearest level while the one it wants is painted between frames, then that one', async () => {
    const { heatmap, ctx } = view()
    heatmap.setMatrix(block())
    heatmap.draw()
    // Sixteen times in: more than a device pixel a cell, so level 0 is wanted.
    heatmap.zoomAt(200, 200, 16)
    heatmap.draw()
    expect(ctx.blits[ctx.blits.length - 1].source.width, 'the level in hand stands in').toBe(500)
    expect(heatmap.sharpening).toBe(true)
    await settled(heatmap)
    expect(heatmap.sharpening).toBe(false)
    heatmap.draw()
    expect(ctx.blits[ctx.blits.length - 1].source.width).toBe(4000)
    expect(heatmap.levelsMade).toBe(2)
    expect(heatmap.rasterisations, 'a gesture must never re-colour the block').toBe(1)
  })

  it('makes a level once per colouring, however often the zoom comes back to it', async () => {
    const { heatmap } = view()
    heatmap.setMatrix(block())
    heatmap.draw()
    heatmap.zoomAt(200, 200, 16)
    heatmap.draw()
    await settled(heatmap)
    heatmap.fit()
    heatmap.draw()
    heatmap.zoomAt(200, 200, 16)
    heatmap.draw()
    expect(heatmap.sharpening).toBe(false)
    expect(heatmap.levelsMade).toBe(2)
  })

  it('draws a sparse block’s level in the frame that wants it, when one slice paints it', () => {
    const { heatmap, ctx } = view()
    heatmap.setMatrix(block(4000, true))
    heatmap.draw()
    heatmap.zoomAt(200, 200, 16)
    heatmap.draw()
    // Painted from the listed cells, the whole level fits the first slice: no stand-in.
    expect(ctx.blits[ctx.blits.length - 1].source.width).toBe(4000)
    expect(heatmap.sharpening).toBe(false)
    expect(heatmap.levelsMade).toBe(2)
    expect(heatmap.rasterisations).toBe(1)
  })

  it('gives up a level it no longer wants for the one it does', async () => {
    const { heatmap, ctx } = view()
    heatmap.setMatrix(block())
    heatmap.draw()
    heatmap.zoomAt(200, 200, 16)
    heatmap.draw()
    // Back out before level 0 lands, to a level between: that is the one made.
    heatmap.fit()
    heatmap.zoomAt(200, 200, 3)
    heatmap.draw()
    await settled(heatmap)
    heatmap.draw()
    expect(ctx.blits[ctx.blits.length - 1].source.width).toBe(2000)
    expect(heatmap.levelsMade).toBe(2)
  })
})

describe('an export of a large block', () => {
  it('makes its exact level at once rather than drawing a stand-in', () => {
    const { heatmap } = view()
    heatmap.setMatrix(block())
    heatmap.draw()
    const out = context()
    // Four device pixels to the CSS pixel: a 2.5-fold reduction, so level 1.
    heatmap.renderTo(out as unknown as CanvasRenderingContext2D, 4)
    expect(out.blits[out.blits.length - 1].source.width).toBe(2000)
    expect(heatmap.sharpening).toBe(false)
    expect(heatmap.levelsMade).toBe(2)
  })
})

describe('what keeps the whole-image path', () => {
  it('draws a field read about a middle whole, and halves it', () => {
    const { heatmap } = view()
    heatmap.setScale({ vmin: Number.NaN, vmax: Number.NaN, transform: 'log2', colormap: 'default', neutral: 1 })
    heatmap.setMatrix(block())
    const before = made()
    heatmap.draw()
    // The raster, and the three halvings a tenfold reduction asks for.
    expect(made() - before).toBe(4)
    expect(heatmap.levelsMade).toBe(0)
  })
})

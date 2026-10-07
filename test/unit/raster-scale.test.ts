/**
 * When the browser is allowed to filter the raster, what it filters, and when it
 * is not allowed to at all.
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
 *
 * The second half of the file is about the *pyramid*, and it is the half that
 * makes the first half true. A canvas filter reads a 2 × 2 neighbourhood per
 * destination pixel, which is a filter down to a halving and a lie past it: a
 * whole chromosome at 1 kb in 460 px left seven cells of every eight unread, and
 * on a turned map — whose lattice is half a bin and shifts parity row by row —
 * what was drawn instead was a moiré of diagonal stripes. So the view keeps
 * halved copies of the raster and samples the one nearest the size it is drawing,
 * which is never more than a halving away from the pixels it lands in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HeatmapView, poolDisplay } from '@/render/heatmap'
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
  // Honours its constructor, unlike the shorter stubs elsewhere in the suite:
  // the sizes are what the pyramid is *about*, so a stub that came up 0 × 0
  // would answer every question below with the same number. `made` counts them,
  // which is how "built on demand" is stated as a test rather than as a comment.
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
      // The pyramid is built into canvases of this kind, so this stub has to be
      // able to take a `drawImage` as well as the `putImageData` that fills
      // level 0. Blank levels are fine: what is asserted below is which pixels
      // were sampled, not what colour they were.
      return { putImageData: () => {}, drawImage: () => {}, imageSmoothingEnabled: false }
    }
  }
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

/** One `drawImage` of the raster: what was sampled, and onto what. */
interface Blit {
  source: { width: number; height: number }
  args: number[]
}

function harness(size: number): {
  canvas: HTMLCanvasElement
  ctx: { imageSmoothingEnabled: boolean; blits: Blit[] }
} {
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
    drawImage: (source: { width: number; height: number }, ...args: number[]) => {
      ctx.blits.push({ source: { width: source.width, height: source.height }, args })
    },
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

/** The raster copy a draw sampled, and how far it was then shrunk. */
function sampled(n: number, dpr: number, size = 400): { width: number; residual: number } {
  const { canvas, ctx } = harness(size)
  const heatmap = new HeatmapView(canvas, { devicePixelRatio: dpr })
  heatmap.setMatrix(block(n))
  heatmap.draw()
  const blit = ctx.blits[ctx.blits.length - 1]
  // The plot is the canvas less its margins, so the scale is read off the blit
  // rather than assumed: `dw / sw` is what the level is stretched by, and the
  // transform then puts `n` cells across the plot.
  const plot = (size - 1) * dpr
  return { width: blit.source.width, residual: (plot / n) * (blit.args[6] / blit.args[2]) }
}

describe('the raster pyramid', () => {
  it('samples a level whose pixels land within a halving of the destination', () => {
    // 4,000 cells in ~400 px is a tenfold reduction: three halvings take the
    // raster to 500 pixels, which is then shrunk by 0.8 — one bilinear tap over
    // a real average of every cell, instead of one tap over one cell in eight.
    const at = sampled(4000, 1)
    expect(at.width).toBe(500)
    expect(at.residual).toBeGreaterThanOrEqual(0.5)
    expect(at.residual).toBeLessThan(1)
  })

  it('leaves a mild reduction to the filter, which is what it is good at', () => {
    // 600 cells in 400 px is 0.67 — a halving would over-blur an image the tap
    // can resample honestly, so the raster itself is what gets drawn.
    expect(sampled(600, 1).width).toBe(600)
  })

  it('draws the raster itself while the picture is magnified', () => {
    expect(sampled(100, 1).width).toBe(100)
    expect(sampled(100, 2).width).toBe(100)
  })

  it('stretches whichever level it samples over the whole raster', () => {
    // The transform is the matrix's, so a level has to cover the block it
    // summarises: registration against the ticks, the separators and the
    // overlays is the only thing keeping a mark on the pixel it names.
    const { canvas, ctx } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(4000))
    heatmap.draw()
    const blit = ctx.blits[ctx.blits.length - 1]
    expect(blit.args.slice(4)).toEqual([0, 0, 4000, 4000])
  })

  it('builds levels once, not per frame, and drops them with the raster', () => {
    const g = globalThis as unknown as Record<string, { made: number }>
    const { canvas } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    heatmap.setMatrix(block(4000))
    g['OffscreenCanvas'].made = 0
    heatmap.draw()
    // The raster, and the three levels the reduction asks for.
    const first = g['OffscreenCanvas'].made
    expect(first).toBe(4)
    // A second frame over the same pixels: a pan, a crosshair, a hover.
    heatmap.draw()
    expect(g['OffscreenCanvas'].made).toBe(first)
    // A colour change rewrites the raster, so every level is a summary of pixels
    // that are no longer there.
    heatmap.setScale({ transform: 'log10', colormap: 'default', vmin: 0, vmax: 5 })
    heatmap.draw()
    expect(g['OffscreenCanvas'].made).toBeGreaterThan(first)
  })
})

/**
 * The other half of "what is being filtered": the *shape* of a raster pixel.
 *
 * Pooling caps each axis on its own, which is right for a genome pair — the two
 * axes are two different sequences, and halving the short one to match the long
 * one loses resolution nothing asked for. It is wrong for a **turned band**,
 * whose two axes are one measure: the rotation is isometric, so a raster pixel
 * four cells across and two up is drawn as a rectangle where the geometry
 * promises a square. Everything downstream then has one decision to make about
 * two different scales — one filter flag, one pyramid level — so at the crossover
 * x is magnified through a blur while y is still point-sampled, and past it
 * nearest neighbour lays cells down two device pixels wide and one tall. On a
 * picture whose structure runs at 45° that is a staircase of smeared diagonals.
 */
describe('the shape of a raster pixel', () => {
  const scale = { vmin: Number.NaN, vmax: Number.NaN, transform: 'log10' as const, colormap: 'default' }

  /** A band as a turn produces one: twice as wide as the square, and shallow. */
  function band(cols: number, rows: number): DenseMatrix {
    return {
      nrows: rows,
      ncols: cols,
      values: new Float32Array(rows * cols),
      rowExtent: [0, rows],
      colExtent: [0, cols],
    }
  }

  it('is square when the caller says the two axes are one measure', () => {
    // 9,281 × 4,039 is E. coli at 1 kb, turned: the width needs pooling by three
    // and the height by one, and a raster of 4 × 2 cells per pixel is what the
    // reader saw as aliasing while scrolling into it — under the 4,096 cap it
    // was measured at, which is named here because the shape is what is tested.
    const pooled = poolDisplay(band(9281, 4039), scale, { isotropic: true, maxDim: 4096 })
    expect(pooled.strideX).toBe(pooled.strideY)
    expect(pooled.strideX).toBe(3)
    expect(pooled.isotropic).toBe(true)
  })

  it('is per-axis otherwise, because a genome pair has two sequences in it', () => {
    // 600 × 8,141 — the shape of every pair involving a large MAG. One stride
    // would halve the 600-bin axis to suit the axis that needed pooling.
    const pooled = poolDisplay(band(600, 8141), scale, { maxDim: 4096 })
    expect(pooled.strideX).toBe(1)
    expect(pooled.strideY).toBe(2)
    expect(pooled.isotropic).toBe(false)
  })

  it('leaves a block that fits alone, whichever rule is asked for', () => {
    for (const isotropic of [true, false]) {
      const pooled = poolDisplay(band(1000, 400), scale, { isotropic })
      expect([pooled.strideX, pooled.strideY]).toEqual([1, 1])
    }
  })

  it('draws a band with one scale on both axes, so one filter flag serves both', () => {
    // The property the picture actually depends on: `a` and `d` of the draw
    // transform are `zoom × stride × dpr`, so equal strides are what make the
    // two equal — and what makes "is this magnified?" a question with one
    // answer. Asserted here rather than through a draw because the transform is
    // the stylesheet-free half: `HeatmapView.draw` multiplies these by one zoom.
    const pooled = poolDisplay(band(9281, 4039), scale, { isotropic: true })
    const zoom = 0.31
    expect(zoom * pooled.strideX).toBeCloseTo(zoom * pooled.strideY, 12)
  })
})

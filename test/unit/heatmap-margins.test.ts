/**
 * Label gutters are measured, not guessed (`HeatmapOptions.autoMargin`).
 *
 * The bug this pins down was visible rather than incorrect: with a fixed
 * `{ left: 78, top: 6 }` margin, a real contig name (`NODE_7431_len_134871`)
 * was clipped on the left, every column label was drawn upward into a 6 px
 * gutter and so off the top of the canvas, and a genome with more contigs than
 * `maxLabels` still reserved the full gutter for labels it never drew — the
 * dead space under every heatmap.
 *
 * These tests drive `HeatmapView` through a fake 2-D context whose `measureText`
 * is a known function of the string, so the expected gutter is arithmetic rather
 * than a screenshot.
 */

import { describe, expect, it } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import type { DenseMatrix, Separator } from '@/types'

/** Width per character, in the fake font. */
const CHAR_W = 7

/** Mirrors the module's own constants; asserted against, not imported. */
const LABEL_GAP = 8
const EDGE_PAD = 6

/**
 * The slice of `CanvasRenderingContext2D` `HeatmapView` actually touches.
 * Everything is a no-op except `measureText`, which is the whole point.
 */
function fakeCanvas(cssWidth: number, cssHeight: number): HTMLCanvasElement {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: false,
    measureText: (text: string) => ({ width: text.length * CHAR_W }),
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
    setTransform: () => {},
    drawImage: () => {},
    putImageData: () => {},
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  }
  return {
    width: 0,
    height: 0,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    getContext: () => ctx,
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
}

function block(nrows: number, ncols: number): DenseMatrix {
  return {
    nrows,
    ncols,
    values: new Float32Array(nrows * ncols),
    rowExtent: [0, nrows],
    colExtent: [0, ncols],
  }
}

/** `count` evenly spaced boundaries over `n` cells. */
function separators(count: number, n: number, prefix: string): Separator[] {
  const step = Math.floor(n / count)
  return Array.from({ length: count }, (_, i) => ({ at: i * step, label: `${prefix}_${i}` }))
}

describe('measured label gutters', () => {
  it('sizes the left gutter to the widest row label', () => {
    const view = new HeatmapView(fakeCanvas(800, 800), {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 50,
    })
    // Labels `contig_0` … `contig_5`, so the widest is 8 characters.
    view.setMatrix(block(120, 120), separators(6, 120, 'contig'))
    expect(view.margin.left).toBeCloseTo('contig_0'.length * CHAR_W + LABEL_GAP, 5)
  })

  it('gives the top gutter the same width, because column labels are rotated', () => {
    const view = new HeatmapView(fakeCanvas(800, 800), {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 50,
    })
    view.setMatrix(block(120, 120), separators(6, 120, 'contig'))
    // A quarter turn means the label's text *width* becomes the gutter's height.
    expect(view.margin.top).toBeCloseTo(view.margin.left, 5)
  })

  it('grows the gutter for a long real-world contig name', () => {
    const view = new HeatmapView(fakeCanvas(1000, 1000), {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 50,
    })
    const long = 'NODE_7431_len_134871'
    view.setMatrix(block(100, 100), [{ at: 0, label: long }])
    expect(view.margin.left).toBeCloseTo(long.length * CHAR_W + LABEL_GAP, 5)
    // The old fixed margin was 78 px; this name needs more, which is precisely
    // why it used to be clipped.
    expect(view.margin.left).toBeGreaterThan(78)
  })

  it('collapses both gutters when the axis has more blocks than maxLabels', () => {
    const view = new HeatmapView(fakeCanvas(800, 800), {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 10,
    })
    // 40 contigs, over the threshold: `ops/show.py` draws no labels here, so no
    // gutter should be reserved for them.
    view.setMatrix(block(400, 400), separators(40, 400, 'contig'))
    expect(view.margin.left).toBe(EDGE_PAD)
    expect(view.margin.top).toBe(EDGE_PAD)
  })

  it('never lets one pathological label take more than a third of the canvas', () => {
    const view = new HeatmapView(fakeCanvas(300, 300), {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 50,
    })
    view.setMatrix(block(50, 50), [{ at: 0, label: 'x'.repeat(200) }])
    expect(view.margin.left).toBeLessThanOrEqual(300 * 0.34)
    // And the plot survives it.
    expect(view.plotRect.width).toBeGreaterThan(150)
  })

  it('keeps right and bottom at the edge pad, so no dead band sits under the plot', () => {
    const view = new HeatmapView(fakeCanvas(800, 600), {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 50,
    })
    view.setMatrix(block(120, 120), separators(6, 120, 'contig'))
    expect(view.margin.right).toBe(EDGE_PAD)
    expect(view.margin.bottom).toBe(EDGE_PAD)
  })

  it('leaves a fixed margin alone when autoMargin is off', () => {
    const view = new HeatmapView(fakeCanvas(800, 800), {
      devicePixelRatio: 1,
      margin: { left: 78, top: 6, right: 6, bottom: 60 },
    })
    view.setMatrix(block(120, 120), separators(6, 120, 'contig'))
    expect(view.margin).toEqual({ left: 78, top: 6, right: 6, bottom: 60 })
  })
})

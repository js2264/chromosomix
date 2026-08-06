/**
 * Which axis labels are drawn, and what clicking one does.
 *
 * Three rules, and each exists because the one before it is not enough on its
 * own:
 *
 * 1. **The count is of the blocks *in view*.** `MAX_CATEGORICAL_TICKS` asks
 *    "would these names be a smear", and past the first zoom step they would
 *    not. Counting the whole axis instead meant a 20,000-contig overview stayed
 *    unlabelled however far you zoomed into it — the names were never available
 *    at any magnification, which is not what the threshold is for.
 * 2. **A long block is labelled whatever the count.** A real MAG is a few
 *    hundred contigs of which a handful are megabases; those are the ones a
 *    reader is looking for, and rule 1 refuses them along with the rest.
 * 3. **The gutter is measured from the whole labelled set, not the visible
 *    part of it.** Otherwise the widest name scrolling into view resizes the
 *    margin, and the plot shifts under the pointer through every pan.
 *
 * The boundary ticks at the bottom of the file are the other half of the same
 * furniture: the marks a name would have carried, at counts no name survives.
 *
 * `draw()` is never called — it needs an `OffscreenCanvas` Node does not have —
 * so what is asserted is the state the view computes before painting.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { HeatmapView, type LabelBlock } from '@/render/heatmap'
import type { DenseMatrix, Separator } from '@/types'

/** A double click repaints, and repainting rasterises; two stubs are enough. */
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

const CHAR_W = 7
const LABEL_GAP = 8
const EDGE_PAD = 6

/** As in `plot-options.test.ts`. */
function fakeCanvas(cssWidth: number, cssHeight: number): {
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
    rect: () => {},
    setTransform: () => {},
    drawImage: () => {},
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    tabIndex: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight }),
    // `remove` as well as `toggle`: the view clears its own state classes on
    // the way out, and a stub that only knows how to toggle throws there.
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
  // `button: 0` unless a test says otherwise: a real primary press carries it,
  // and the handlers under test now read it — a synthetic event without one is
  // a press from a button that does not exist.
  return {
    canvas,
    fire: (type, event) => listeners.get(type)?.({ button: 0, ...event }),
  }
}

function block(n: number): DenseMatrix {
  return {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n),
    rowExtent: [0, n],
    colExtent: [0, n],
  }
}

/** `count` equal blocks over `n` cells. */
function evenSeparators(count: number, n: number): Separator[] {
  const step = n / count
  return Array.from({ length: count }, (_, i) => ({
    at: Math.round(i * step),
    label: `contig_${i}`,
  }))
}

const labels = (blocks: LabelBlock[]): string[] => blocks.map((b) => b.label)

describe('the count rule is about what is in view', () => {
  it('labels nothing when 200 blocks are on screen, and labels them once fifty are', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(2000), evenSeparators(200, 2000))
    expect(view.labelBlocks('rows')).toEqual([])
    // ... and reserves no gutter for them, which is what removed the dead band.
    expect(view.margin.left).toBe(EDGE_PAD)

    // Zoom to the first 200 cells: 20 blocks, comfortably under the threshold.
    const plot = view.plotRect
    view.zoomToBox(plot.x, plot.y, plot.x + plot.width / 10, plot.y + plot.height / 10)
    const shown = view.labelBlocks('rows')
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThanOrEqual(50)
    expect(shown[0].label).toBe('contig_0')
    // The gutter came back with them.
    expect(view.margin.left).toBeGreaterThan(EDGE_PAD)
  })

  it('goes quiet again on the way back out', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(2000), evenSeparators(200, 2000))
    const plot = view.plotRect
    view.zoomToBox(plot.x, plot.y, plot.x + plot.width / 10, plot.y + plot.height / 10)
    expect(view.labelBlocks('rows').length).toBeGreaterThan(0)
    view.fit()
    expect(view.labelBlocks('rows')).toEqual([])
    expect(view.margin.left).toBe(EDGE_PAD)
  })
})

describe('a long block is labelled whatever the count', () => {
  /** 199 short contigs and one 500-cell one, as a real MAG is shaped. */
  function unevenSeparators(): Separator[] {
    const seps: Separator[] = [{ at: 0, label: 'big_contig' }]
    for (let i = 0; i < 199; i++) seps.push({ at: 500 + i * 5, label: `small_${i}` })
    return seps
  }

  it('labels only the long ones, and only when the count rule refuses', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
      labelMinSpan: 50,
    })
    view.setMatrix(block(1500), unevenSeparators())
    expect(labels(view.labelBlocks('rows'))).toEqual(['big_contig'])
    // The last block runs from 1490 to the end of the axis, so it is long too.
    expect(labels(view.labelBlocks('cols'))).toEqual(['big_contig'])
    // The gutter fits the name it will draw.
    expect(view.margin.left).toBeCloseTo('big_contig'.length * CHAR_W + LABEL_GAP, 5)
  })

  it('is set per matrix, and 0 turns it off', () => {
    // What the panel does above bin level, where a cell *is* a contig or a
    // genome: every block is one cell wide, so the rule has nothing to read.
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(2000), evenSeparators(200, 2000))
    expect(view.labelBlocks('rows')).toEqual([])
    // Each of the 200 blocks is 10 cells wide: at this floor, all of them
    // qualify, and "regardless of their number" is exactly the rule. All 200
    // stay in view because a fitted view is re-fitted to the plot the new
    // gutter leaves, rather than losing its last blocks to the margin.
    view.setLabelMinSpan(10)
    expect(view.labelBlocks('rows')).toHaveLength(200)
    view.setLabelMinSpan(0)
    expect(view.labelBlocks('rows')).toEqual([])
  })
})

describe('clicking a label', () => {
  it('reports the block under a point in either gutter', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(100), evenSeparators(4, 100))
    const plot = view.plotRect
    // A quarter of the way down the left gutter is the second row block.
    const rows = view.labelAt(plot.x / 2, plot.y + plot.height * 0.3)
    expect(rows?.axis).toBe('rows')
    expect(rows?.block.label).toBe('contig_1')
    // Three quarters along the top gutter is the fourth column block.
    const cols = view.labelAt(plot.x + plot.width * 0.8, plot.y / 2)
    expect(cols?.axis).toBe('cols')
    expect(cols?.block.label).toBe('contig_3')
    // Inside the plot is a cell, not a label.
    expect(view.labelAt(plot.x + 10, plot.y + 10)).toBeNull()
  })

  it('reports nothing where no label is drawn', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(2000), evenSeparators(200, 2000))
    const plot = view.plotRect
    expect(view.labelAt(plot.x / 2, plot.y + 100)).toBeNull()
  })

  it('fires on a press that did not travel, after the double-click window', () => {
    vi.useFakeTimers()
    try {
      const fake = fakeCanvas(600, 600)
      const seen: Array<[string, string]> = []
      const view = new HeatmapView(fake.canvas, {
        devicePixelRatio: 1,
        autoMargin: true,
        maxLabels: 50,
        onLabelClick: (axis, hit) => seen.push([axis, hit.label]),
      })
      view.setMatrix(block(100), evenSeparators(4, 100))
      view.attach()
      const plot = view.plotRect
      const x = plot.x / 2
      const y = plot.y + plot.height * 0.3
      fake.fire('mousedown', { clientX: x, clientY: y })
      fake.fire('mouseup', { clientX: x, clientY: y })
      expect(seen).toEqual([])
      vi.advanceTimersByTime(300)
      expect(seen).toEqual([['rows', 'contig_1']])

      // A double click is "put it back", not "go there and put it back".
      fake.fire('mousedown', { clientX: x, clientY: y })
      fake.fire('mouseup', { clientX: x, clientY: y })
      fake.fire('dblclick', { clientX: x, clientY: y, preventDefault: () => {} })
      vi.advanceTimersByTime(300)
      expect(seen).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('boundary breaks', () => {
  it('marks every interior boundary in view, at counts no label survives', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(2000), evenSeparators(200, 2000))
    // No labels at this zoom — that is the case the ticks exist for.
    expect(view.labelBlocks('rows')).toEqual([])
    // 200 blocks, 199 interior boundaries; the axis edges are the plot frame.
    expect(view.breakPositions('rows')).toHaveLength(199)
    expect(view.breakPositions('rows')[0]).toBe(10)
    expect(view.breakPositions('rows').at(-1)).toBe(1990)
  })

  it('costs the boundaries on screen, not the ones behind them', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, {
      devicePixelRatio: 1,
      autoMargin: true,
      maxLabels: 50,
    })
    view.setMatrix(block(2000), evenSeparators(200, 2000))
    const plot = view.plotRect
    view.zoomToBox(plot.x, plot.y, plot.x + plot.width / 10, plot.y + plot.height / 10)
    const shown = view.breakPositions('cols')
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(199)
    // In order, and inside the tenth of the axis that is on screen.
    expect(shown[0]).toBeLessThan(shown.at(-1) as number)
    expect(shown.at(-1)).toBeLessThan(400)
  })

  it('has nothing to mark on an axis of one block', () => {
    const view = new HeatmapView(fakeCanvas(600, 600).canvas, { devicePixelRatio: 1 })
    view.setMatrix(block(100), [{ at: 0, label: 'only' }])
    expect(view.breakPositions('rows')).toEqual([])
    expect(view.breakPositions('cols')).toEqual([])
  })
})

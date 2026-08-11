/**
 * What the renderer is allowed to *spend* per frame.
 *
 * Everything here is a cost property rather than a picture property: the
 * pictures are pinned by `render.test.ts` against matplotlib, and these guard
 * the things that were making the app slow without changing what it drew.
 * Each one is a property that is easy to reintroduce by accident — an
 * unconditional `stroke()` in a loop, a missing memo — and invisible in a
 * screenshot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HeatmapView, type SeparatorSet } from '@/render/heatmap'
import type { DenseMatrix, Separator } from '@/types'

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
      // `drawImage` because the raster is halved into canvases of this kind on
      // the way to a minified draw (`HeatmapView.rasterFor`); a no-op leaves the
      // levels blank, which nothing here reads.
      return { putImageData: () => {}, drawImage: () => {}, imageSmoothingEnabled: false }
    }
  }
})

afterAll(() => {
  const g = globalThis as Record<string, unknown>
  delete g['ImageData']
  delete g['OffscreenCanvas']
})

/** Counts the calls that cost a submission to the rasteriser. */
interface Counters {
  stroke: number
  beginPath: number
  moveTo: number
  fillText: number
}

function harness(size: number): { canvas: HTMLCanvasElement; counts: Counters } {
  const counts: Counters = { stroke: 0, beginPath: 0, moveTo: 0, fillText: 0 }
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
    beginPath: () => void counts.beginPath++,
    moveTo: () => void counts.moveTo++,
    lineTo: () => {},
    stroke: () => void counts.stroke++,
    fillText: () => void counts.fillText++,
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
  return { canvas, counts }
}

function block(n: number): DenseMatrix {
  return { nrows: n, ncols: n, values: new Float32Array(n * n), rowExtent: [0, n], colExtent: [0, n] }
}

/** One separator per unit, as every aggregated view produces. */
function perUnit(n: number): Separator[] {
  return Array.from({ length: n }, (_, i) => ({ at: i, label: `u${i}` }))
}

describe('separator stroking', () => {
  it('submits one path per axis, not one per line', () => {
    const draws = (n: number): { stroke: number; beginPath: number } => {
      const { canvas, counts } = harness(400)
      const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
      const seps = perUnit(n)
      heatmap.setMatrix(block(n), { rows: seps, cols: seps })
      heatmap.setPlotOptions({ crosshair: false, dividers: true, labels: false, ticks: false })
      counts.stroke = 0
      counts.beginPath = 0
      heatmap.draw()
      return { stroke: counts.stroke, beginPath: counts.beginPath }
    }

    // Stated as invariance rather than as a bound, because the bound is a
    // moving target: every decoration the renderer gains — breaks, ticks, the
    // frame — is one more legitimate `beginPath`/`stroke` pair, and pinning the
    // total makes this test fail for the wrong reason. What must not change is
    // that quadrupling the separators changes neither count. Anything
    // proportional to the separator count means the per-line pair is back.
    const small = draws(2_048)
    expect(draws(8_192)).toEqual(small)
    // …and it is a handful of submissions, not thousands.
    expect(small.stroke).toBeLessThan(10)
    expect(small.beginPath).toBeLessThan(10)
  })

  it('draws at most one line per device pixel, however many boundaries collide', () => {
    const { canvas, counts } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    // 4,000 units across a 400 px canvas: ten boundaries per pixel, and only the
    // plot's own width is distinguishable.
    const seps = perUnit(4_000)
    heatmap.setMatrix(block(4_000), { rows: seps, cols: seps })
    heatmap.setPlotOptions({ crosshair: false, dividers: true, labels: false, ticks: false })
    counts.moveTo = 0
    heatmap.draw()

    expect(counts.moveTo).toBeLessThan(2 * 400 + 8)
  })

  it('culls to the visible domain, so zooming in does less work rather than the same', () => {
    const { canvas, counts } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    const seps = perUnit(4_000)
    heatmap.setMatrix(block(4_000), { rows: seps, cols: seps })
    heatmap.setPlotOptions({ crosshair: false, dividers: true, labels: false, ticks: false })
    counts.moveTo = 0
    heatmap.draw()
    const fitted = counts.moveTo

    // All the way in: the zoom clamps at a few cells across the plot, so only a
    // handful of boundaries can be inside the domain.
    heatmap.zoomAt(200, 200, 1e6)
    const visible = heatmap.scaleX.span
    counts.moveTo = 0
    heatmap.draw()

    expect(visible).toBeLessThan(50)
    expect(counts.moveTo).toBeLessThanOrEqual(2 * Math.ceil(visible + 2))
    expect(counts.moveTo).toBeLessThan(fitted)
  })

  it('does not stroke the fine set twice when it is the super-group set', () => {
    const { canvas, counts } = harness(400)
    const heatmap = new HeatmapView(canvas, { devicePixelRatio: 1 })
    const seps = perUnit(300)
    // Exactly what `separatorsFor` builds for a whole-metagenome view: one array
    // serving as both the labelled set and the heavier one.
    const set: SeparatorSet = { rows: seps, cols: seps, groupRows: seps, groupCols: seps }
    heatmap.setMatrix(block(300), set)
    heatmap.setPlotOptions({ crosshair: false, dividers: true, labels: false, ticks: false })
    counts.moveTo = 0
    heatmap.draw()
    const shared = counts.moveTo

    // The same coordinates in two distinct arrays: both sets are stroked.
    const copy = seps.map((s) => ({ ...s }))
    heatmap.setMatrix(block(300), { rows: seps, cols: seps, groupRows: copy, groupCols: copy })
    counts.moveTo = 0
    heatmap.draw()

    expect(counts.moveTo).toBeGreaterThan(shared)
  })
})

describe('label blocks', () => {
  it('builds nothing for an axis with more separators than it can label', () => {
    const heatmap = new HeatmapView(harness(400).canvas, { devicePixelRatio: 1 })
    const seps = perUnit(4_000)
    heatmap.setMatrix(block(4_000), { rows: seps, cols: seps })
    heatmap.setPlotOptions({ crosshair: false, dividers: false, labels: true, ticks: false })

    expect(heatmap.labelBlocks('rows')).toEqual([])
    expect(heatmap.labelBlocks('cols')).toEqual([])
  })

  it('does not rebuild the blocks on repeated calls, so a frame does not pay for them', () => {
    const heatmap = new HeatmapView(harness(400).canvas, { devicePixelRatio: 1 })
    const seps = perUnit(8)
    heatmap.setMatrix(block(8), { rows: seps, cols: seps })
    heatmap.setPlotOptions({ crosshair: false, dividers: false, labels: true, ticks: false })

    // Element identity rather than array identity: the block list is built and
    // cached once per separator set, and `labelBlocks` slices the visible run
    // out of it per call. The slice is two binary searches; it is
    // `separatorBlocks` — filter, copy, sort, one object per block — that must
    // not run again, and shared elements are what proves it did not.
    const first = heatmap.labelBlocks('rows')
    expect(first).toHaveLength(8)
    const second = heatmap.labelBlocks('rows')
    expect(second).toHaveLength(first.length)
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i])

    // A new matrix is a new set of blocks.
    const next = perUnit(4)
    heatmap.setMatrix(block(4), { rows: next, cols: next })
    expect(heatmap.labelBlocks('rows')[0]).not.toBe(first[0])
  })
})

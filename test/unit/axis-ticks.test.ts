/**
 * Base-pair ticks on a bin-level axis (spec §7.1; `_bin_axis` in `ops/show.py`).
 *
 * Three properties, and they are the whole feature:
 *
 * 1. A tick marks a **genomic position**, not an offset into the picture. So
 *    the positions are multiples of the step in absolute coordinates, and a
 *    sub-contig region reports where it really is — the same arithmetic, from
 *    the same `unitStart`, as the hover readout (`axis-position.test.ts`).
 * 2. They **stay on their base pair** through a pan and a zoom, because they
 *    are recomputed from the axis scale on the frame they are drawn. Asserted
 *    here through `Scale.toPixel`, the conversion the canvas itself uses, so the
 *    test fails if the ticks and the transform ever disagree.
 * 3. An axis with **no single coordinate system** — more than one contig, or a
 *    cell that *is* a contig — draws none, which is Python's rule.
 *
 * `draw()` is never called: it needs `OffscreenCanvas`, which Node does not
 * have. Everything asserted here is state the view computes before painting.
 */

import { describe, expect, it } from 'vitest'

import { HeatmapView, bpTicks, chooseBpStep, formatBpTick } from '@/render/heatmap'
import { axisCoordsFor } from '@/ui/MatrixPanel'
import type { DenseMatrix } from '@/types'
import type { AxisGroup } from '@/worker/protocol'

const BIN = 1000

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
    measureText: (text: string) => ({ width: text.length * 7 }),
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    clearRect: () => {},
    fillRect: () => {},
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
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    tabIndex: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight }),
    // `remove` as well as `toggle`: the view clears its own state classes on
    // the way out, and a stub that only knows how to toggle throws there.
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
}

function block(n: number, offset = 0): DenseMatrix {
  return {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n),
    rowExtent: [offset, offset + n],
    colExtent: [offset, offset + n],
  }
}

describe('formatBpTick', () => {
  it('writes a position the way `_format_bp` does', () => {
    expect(formatBpTick(0)).toBe('0 bp')
    expect(formatBpTick(500)).toBe('500 bp')
    expect(formatBpTick(120_000)).toBe('120 kb')
    expect(formatBpTick(1_500_000)).toBe('1.5 Mb')
    expect(formatBpTick(2_000_000)).toBe('2 Mb')
    expect(formatBpTick(10_000_000)).toBe('10 Mb')
    expect(formatBpTick(1_050_000)).toBe('1.05 Mb')
  })
})

describe('chooseBpStep', () => {
  it('climbs the 1–2–5 ladder', () => {
    expect(chooseBpStep(600_000, 6)).toBe(100_000)
    expect(chooseBpStep(1_200_000, 6)).toBe(200_000)
    expect(chooseBpStep(3_000_000, 6)).toBe(500_000)
    expect(chooseBpStep(6_000_000, 6)).toBe(1_000_000)
  })

  it('never goes finer than a bin, which no cell could show', () => {
    expect(chooseBpStep(4_000, 6, 1000)).toBe(1000)
  })
})

describe('bpTicks', () => {
  it('lands on round genomic positions, not on the edge of the view', () => {
    // A 4 Mb contig at 1 kb bins, viewed from bin 1,234.
    const coords = { bpPerCell: BIN, bpAtOrigin: 0 }
    const ticks = bpTicks(coords, [1234, 2234], 5)
    expect(ticks.map((t) => t.bp)).toEqual([1_400_000, 1_600_000, 1_800_000, 2_000_000, 2_200_000])
    // And each one is where its base pair is: bp / binsize, in cells.
    for (const tick of ticks) expect(tick.unit).toBe(tick.bp / BIN)
  })

  it('reports the contig position of a sub-contig block, not the block offset', () => {
    // `contig:139005-199005` at 1 kb: the block's first cell is 139 kb in.
    const coords = { bpPerCell: BIN, bpAtOrigin: 139_000 }
    const ticks = bpTicks(coords, [0, 60], 4)
    expect(ticks[0].bp).toBe(140_000)
    expect(ticks[0].unit).toBe(1)
    expect(ticks.map((t) => t.bp)).toEqual([140_000, 160_000, 180_000])
  })

  it('is empty for an empty range', () => {
    expect(bpTicks({ bpPerCell: BIN, bpAtOrigin: 0 }, [5, 5], 6)).toEqual([])
  })
})

describe('axisCoordsFor', () => {
  const whole: AxisGroup = { label: 'NODE_1', start: 0, end: 279, unitStart: 0 }

  it('maps a whole contig from its own first bin', () => {
    expect(axisCoordsFor([whole], [0, 279], 'bin', BIN)).toEqual({
      bpPerCell: BIN,
      bpAtOrigin: 0,
    })
  })

  it('carries the offset of a sub-contig region', () => {
    const group: AxisGroup = { label: 'NODE_1', start: 0, end: 61, unitStart: 0 }
    expect(axisCoordsFor([group], [139, 200], 'bin', BIN)).toEqual({
      bpPerCell: BIN,
      bpAtOrigin: 139_000,
    })
  })

  /**
   * The turned map's ruler, which counts in half bins and starts where the
   * block does.
   *
   * Two numbers, and only one of them is a cell size. Folding the half into the
   * origin as well put the ruler half of the way into the block: on a window
   * opening 120 bins in, every tick read 60 kb short of the position under it,
   * and the tooltip — which never goes through here — disagreed with the axis
   * beneath the very cell it was describing.
   */
  it('counts in half bins under a turn without halving where the block starts', () => {
    const group: AxisGroup = { label: 'NODE_1', start: 0, end: 61, unitStart: 0 }
    expect(axisCoordsFor([group], [139, 200], 'bin', BIN, 0.5)).toEqual({
      bpPerCell: BIN / 2,
      bpAtOrigin: 139_000,
    })
  })

  it('refuses an axis with no single coordinate system', () => {
    const two: AxisGroup[] = [
      { label: 'c1', start: 0, end: 10, unitStart: 0 },
      { label: 'c2', start: 10, end: 20, unitStart: 10 },
    ]
    // Several contigs: the ticks are the contig names, and they already are.
    expect(axisCoordsFor(two, [0, 20], 'bin', BIN)).toBeNull()
    // Above bin level a cell *is* a contig; a position inside one is invented.
    expect(axisCoordsFor([whole], [0, 279], 'contig', BIN)).toBeNull()
  })
})

describe('HeatmapView position ticks', () => {
  function view(n: number, offset = 0): HeatmapView {
    const v = new HeatmapView(fakeCanvas(600, 600), { devicePixelRatio: 1, autoMargin: true })
    v.setMatrix(block(n, offset), [{ at: 0, label: 'NODE_1' }])
    v.setAxisCoords({
      rows: { bpPerCell: BIN, bpAtOrigin: 0 },
      cols: { bpPerCell: BIN, bpAtOrigin: 0 },
    })
    return v
  }

  it('draws none until an axis says what it measures', () => {
    const v = new HeatmapView(fakeCanvas(600, 600), { devicePixelRatio: 1 })
    v.setMatrix(block(400), [])
    expect(v.positionTicks('cols')).toEqual([])
  })

  it('forgets the previous block rather than reusing its coordinates', () => {
    const v = view(400)
    expect(v.positionTicks('cols').length).toBeGreaterThan(0)
    v.setMatrix(block(400, 9000), [])
    expect(v.coordinateAxes).toEqual({ rows: null, cols: null })
    expect(v.positionTicks('cols')).toEqual([])
  })

  it('keeps every tick on its base pair through a zoom and a pan', () => {
    const v = view(400)
    const plot = v.plotRect
    const pixelOf = (bp: number): number => plot.x + v.scaleX.toPixel(bp / BIN)

    const fitted = v.positionTicks('cols')
    expect(fitted.length).toBeGreaterThan(1)
    for (const tick of fitted) {
      expect(pixelOf(tick.bp)).toBeCloseTo(plot.x + v.scaleX.toPixel(tick.unit), 6)
    }

    // Zoom in on the middle, then drag. Both are transform-only, and a tick has
    // to follow the cell it names — checked against the same conversion
    // `cellAt` inverts, so a disagreement between the two fails here.
    v.zoomAt(plot.x + plot.width / 2, plot.y + plot.height / 2, 8)
    v.panBy(-40, 0)
    const zoomed = v.positionTicks('cols')
    expect(zoomed.length).toBeGreaterThan(0)
    // Finer step, since less of the contig is on screen.
    const stepOf = (t: Array<{ bp: number }>): number => t[1].bp - t[0].bp
    expect(stepOf(zoomed)).toBeLessThan(stepOf(fitted))
    for (const tick of zoomed) {
      const px = pixelOf(tick.bp)
      expect(px).toBeGreaterThanOrEqual(-1)
      expect(px).toBeLessThanOrEqual(plot.width + 1)
      const cell = v.cellAt(px + 0.5, plot.y + 4)
      // The cell under the tick is the bin that base pair falls in.
      expect(cell?.col).toBe(Math.floor(tick.bp / BIN))
    }
  })

  it('spaces them over the data, not over the empty margin around it', () => {
    const v = view(400)
    // Zoomed out, the domain runs past the last bin on both sides. Ticks placed
    // across *that* would put one or two on the picture and the rest on nothing.
    v.zoomAt(300, 300, 0.4)
    const ticks = v.positionTicks('cols')
    const data = v.dataRect
    expect(ticks.length).toBeGreaterThan(1)
    for (const tick of ticks) {
      const px = v.plotRect.x + v.scaleX.toPixel(tick.unit)
      expect(px).toBeGreaterThanOrEqual(data.x - 1)
      expect(px).toBeLessThanOrEqual(data.x + data.width + 1)
    }
  })
})

describe('the range a figure is framed at', () => {
  function view(n: number, bpAtOrigin = 0): HeatmapView {
    const v = new HeatmapView(fakeCanvas(600, 600), { devicePixelRatio: 1, autoMargin: true })
    v.setMatrix(block(n), [{ at: 0, label: 'NODE_1' }])
    v.setAxisCoords({
      rows: { bpPerCell: BIN, bpAtOrigin },
      cols: { bpPerCell: BIN, bpAtOrigin },
    })
    return v
  }

  it('is the whole sequence when the whole of it is on screen from base zero', () => {
    const range = view(400).framedRange('rows')
    expect(range).toEqual({ start: 0, end: 400 * BIN, whole: true })
  })

  it('is not "whole" when the block starts part-way along the sequence', () => {
    // `contig:200000-600000`: every bin is on screen, but the picture is not
    // the contig, and a caption saying so would be wrong.
    const range = view(400, 200_000)?.framedRange('rows')
    expect(range?.start).toBe(200_000)
    expect(range?.whole).toBe(false)
  })

  it('follows a zoom, bin-aligned', () => {
    const v = view(400)
    const plot = v.plotRect
    v.zoomToBox(plot.x, plot.y, plot.x + plot.width / 4, plot.y + plot.height / 4)
    const range = v.framedRange('rows')
    expect(range).not.toBeNull()
    expect(range?.whole).toBe(false)
    expect(range?.start).toBe(0)
    expect(range?.end).toBeLessThan(400 * BIN)
    // A bin boundary, not a fraction of one.
    expect((range as { end: number }).end % BIN).toBe(0)
  })

  it('has nothing to report on an axis with no coordinates', () => {
    const v = new HeatmapView(fakeCanvas(600, 600), { devicePixelRatio: 1 })
    v.setMatrix(block(400), [])
    expect(v.framedRange('rows')).toBeNull()
  })
})

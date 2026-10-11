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
 * 3. An axis with **no single coordinate system** draws none *of these*, which
 *    is Python's rule — and an axis of several contigs is then ruled one contig
 *    at a time instead, each measured from its own first base. Above bin level
 *    there is still nothing to draw: a cell there *is* a contig.
 *
 * `draw()` is never called: it needs `OffscreenCanvas`, which Node does not
 * have. Everything asserted here is state the view computes before painting.
 */

import { describe, expect, it } from 'vitest'

import { HeatmapView, bpTicks, chooseBpStep, formatBpTick } from '@/render/heatmap'
import { separationCoords } from '@/render/rotate'
import { axisCoordsFor, axisSpansFor } from '@/ui/blockAxes'
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

describe('axisSpansFor', () => {
  const two: AxisGroup[] = [
    { label: 'c1', start: 0, end: 10, unitStart: 0 },
    { label: 'c2', start: 10, end: 30, unitStart: 10 },
  ]

  it('gives every sequence a ruler of its own, in the block\u2019s own frame', () => {
    // The second contig's line reads zero at cell 10, which is where it starts:
    // stated at cell 0 of the *block* that is -10 kb, so a tick's `unit` is a
    // matrix coordinate like any other and needs no offsetting.
    expect(axisSpansFor(two, [0, 30], 'bin', BIN)).toEqual([
      { from: 0, to: 10, coords: { bpPerCell: BIN, bpAtOrigin: 0 } },
      { from: 10, to: 30, coords: { bpPerCell: BIN, bpAtOrigin: -10_000 } },
    ])
  })

  it('carries the offset of a block that opens part-way into a contig', () => {
    const groups: AxisGroup[] = [
      { label: 'c1', start: 0, end: 10, unitStart: 0 },
      { label: 'c2', start: 10, end: 20, unitStart: 149 },
    ]
    const spans = axisSpansFor(groups, [139, 159], 'bin', BIN)
    // The block opens at bin 139 of `c1` and `c2` itself begins at bin 149, so
    // the second ruler reads 0 at cell 10 — `(139 - 149) * 1000` at cell 0.
    expect(spans[0].coords).toEqual({ bpPerCell: BIN, bpAtOrigin: 139_000 })
    expect(spans[1].coords).toEqual({ bpPerCell: BIN, bpAtOrigin: -10_000 })
  })

  it('leaves an axis that already has one ruler to it', () => {
    // One contig is `axisCoordsFor`'s case, and the two must never both draw.
    expect(axisSpansFor([two[0]], [0, 10], 'bin', BIN)).toEqual([])
  })

  it('refuses above bin level, where a cell is a whole sequence', () => {
    expect(axisSpansFor(two, [0, 30], 'contig', BIN)).toEqual([])
    expect(axisSpansFor(two, [0, 30], 'genome', BIN)).toEqual([])
  })

  it('skips a cell several sequences share, which has no position in any', () => {
    const merged: AxisGroup[] = [
      { label: 'c1', start: 0, end: 10, unitStart: 0 },
      {
        label: 'c2',
        start: 10,
        end: 11,
        unitStart: 10,
        merged: [
          { label: 'c2', unitLength: 400 },
          { label: 'c3', unitLength: 300 },
        ],
      },
      { label: 'c4', start: 11, end: 30, unitStart: 11 },
    ]
    expect(axisSpansFor(merged, [0, 30], 'bin', BIN).map((span) => span.from)).toEqual([0, 11])
  })

  it('draws no ruler at all for an axis of thousands of contigs', () => {
    // A metagenome: every stretch is a pixel or less, there is no room for a
    // position on any of them, and the names are already elided for the reason.
    const many: AxisGroup[] = Array.from({ length: 4000 }, (_unused, i) => ({
      label: `NODE_${i}`,
      start: i,
      end: i + 1,
      unitStart: i,
    }))
    expect(axisSpansFor(many, [0, 4000], 'bin', BIN)).toEqual([])
  })
})

describe('HeatmapView per-sequence ticks', () => {
  /** Four contigs of 100 bins each, on one 400-bin axis. */
  const groups: AxisGroup[] = Array.from({ length: 4 }, (_unused, i) => ({
    label: `c${i + 1}`,
    start: i * 100,
    end: (i + 1) * 100,
    unitStart: i * 100,
  }))

  function view(): HeatmapView {
    const v = new HeatmapView(fakeCanvas(600, 600), { devicePixelRatio: 1, autoMargin: true })
    v.setMatrix(block(400), groups.map((g) => ({ at: g.start, label: g.label })))
    // No single ruler on either axis: this is precisely the case.
    v.setAxisCoords({ rows: null, cols: null })
    v.setAxisSpans({
      rows: axisSpansFor(groups, [0, 400], 'bin', BIN),
      cols: axisSpansFor(groups, [0, 400], 'bin', BIN),
    })
    return v
  }

  it('restarts the coordinates at every sequence', () => {
    const v = view()
    const ticks = v.positionTicks('cols')
    expect(ticks.length).toBeGreaterThan(1)
    // Every tick is a position inside the contig it stands on, so none of them
    // is past the 100 kb that contig is long — which is exactly what a ruler
    // running across the whole axis would have produced.
    for (const tick of ticks) {
      expect(tick.bp).toBeGreaterThan(0)
      expect(tick.bp).toBeLessThan(100 * BIN)
    }
  })

  it('names a position rather than repeating the boundary', () => {
    // A stretch with room for one tick gets a step at least as long as itself
    // from the 1-2-5 ladder, whose only multiples inside the stretch are the
    // ones on its two edges — which the contig breaks already draw.
    const v = view()
    for (const tick of v.positionTicks('cols')) {
      for (const group of groups) {
        expect(tick.unit).not.toBeCloseTo(group.start, 6)
        expect(tick.unit).not.toBeCloseTo(group.end, 6)
      }
    }
  })

  it('keeps every tick on the cell its own contig puts it in', () => {
    const v = view()
    for (const tick of v.positionTicks('cols')) {
      const span = groups.find((g) => tick.unit > g.start && tick.unit <= g.end)
      expect(span).toBeDefined()
      // `bpWithin`'s arithmetic, from the same `unitStart`: the readout and the
      // ruler cannot be allowed to disagree about where a base pair is.
      expect(tick.unit).toBeCloseTo((span as AxisGroup).start + tick.bp / BIN, 6)
    }
  })

  it('draws none on an axis that has neither ruler', () => {
    const v = view()
    v.setAxisSpans({ rows: [], cols: [] })
    expect(v.positionTicks('cols')).toEqual([])
  })

  it('gives a finer ruler to a sequence with more of the picture', () => {
    const stepOf = (t: Array<{ bp: number }>): number =>
      Math.min(...t.slice(1).map((tick, i) => Math.abs(tick.bp - t[i].bp)).filter((d) => d > 0))
    const v = view()
    const fitted = v.positionTicks('cols')
    expect(fitted.length).toBeGreaterThan(1)
    v.zoomAt(v.plotRect.x + v.plotRect.width / 2, v.plotRect.y + v.plotRect.height / 2, 6)
    const zoomed = v.positionTicks('cols')
    expect(zoomed.length).toBeGreaterThan(1)
    expect(stepOf(zoomed)).toBeLessThan(stepOf(fitted))
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

  /**
   * A turned map's rows are a **separation**, and a separation is not a place.
   *
   * The line draws the same either way — that is why nothing caught this — but
   * everything that asks *where is this picture* gets an answer made of gaps.
   * An `up` band runs backwards, so the range came back with its end below its
   * start and often below zero, and `MatrixPanel.framedSubject` printed the pair
   * as a locus: `16:49,540,000--20,000` went onto the exported figure's caption
   * and into the provenance line of every track computed from that view, where
   * it is a chromosome coordinate with a negative end in the record of what a
   * result is a measurement of.
   */
  it('refuses an axis that measures separation rather than position', () => {
    const v = new HeatmapView(fakeCanvas(600, 600), { devicePixelRatio: 1, autoMargin: true })
    v.setMatrix(block(400), [{ at: 0, label: 'NODE_1' }])
    v.setAxisCoords({
      rows: separationCoords({ maxSeparation: 200, direction: 'up' }, BIN),
      cols: { bpPerCell: BIN / 2, bpAtOrigin: 0 },
    })
    expect(v.framedRange('rows')).toBeNull()

    // The other direction is the same refusal for the same reason, and it is
    // the one a `bpPerCell < 0` guard would have missed: `down` counts upwards
    // from a negative half-bin, so it produced a locus starting before base
    // zero rather than one running backwards.
    v.setAxisCoords({
      rows: separationCoords({ maxSeparation: 200, direction: 'down' }, BIN),
      cols: { bpPerCell: BIN / 2, bpAtOrigin: 0 },
    })
    expect(v.framedRange('rows')).toBeNull()

    // The genomic axis of a turned band is its columns, and that one answers —
    // which is what lets a caption name the region instead of merely not
    // naming it wrong.
    expect(v.framedRange('cols')).not.toBeNull()
  })
})

/**
 * A ruler that runs out of digits.
 *
 * Two decimals of a megabase is ten kilobases, so on a chromosome measured in
 * megabases every tick of a window narrower than that came out as the same
 * number — a column of `4.60 Mb` under a picture zoomed in to answer the one
 * question the axis is there for. The gap between two ticks is what says how
 * many digits each of them needs, and the unit gives way before the precision
 * does: nobody reads `4.6015 Mb` off an axis.
 */
describe('formatBpTick, given the gap between two ticks', () => {
  it('keeps the megabase where two decimals can still tell ticks apart', () => {
    expect(formatBpTick(4_600_000, 100_000)).toBe('4.6 Mb')
    expect(formatBpTick(4_650_000, 50_000)).toBe('4.65 Mb')
    expect(formatBpTick(5_000_000, 1_000_000)).toBe('5 Mb')
  })

  // …and a four-digit kilobase is grouped like every other number on screen
  // (§26.1). It was the one ungrouped four-digit figure in the app, sitting on
  // the axis directly under a locus box reading `IV:1,246,215`.
  it('steps down to the kilobase rather than to a third decimal', () => {
    expect(formatBpTick(4_605_000, 5_000)).toBe('4,605 kb')
    expect(formatBpTick(4_601_520, 10)).toBe('4,601.52 kb')
  })

  it('steps down to the base pair when even that is not enough', () => {
    expect(formatBpTick(4_601_523, 1)).toBe('4601523 bp')
  })

  it('tells one tick from the next, which is the whole of the rule', () => {
    for (const step of [1, 10, 100, 1_000, 5_000, 100_000]) {
      const here = formatBpTick(4_600_000, step)
      const next = formatBpTick(4_600_000 + step, step)
      expect(here).not.toBe(next)
    }
  })

  it('leaves a lone position spelled the way `ops/show.py` spells it', () => {
    expect(formatBpTick(1_500_000)).toBe('1.5 Mb')
    expect(formatBpTick(120_000)).toBe('120 kb')
    // …and a round number keeps its zeros, which a blanket strip would eat: a
    // 4600 with no decimal point in it is not four thousand six hundred with
    // trailing zeros to spare. Grouped, because a step was given and the number
    // is therefore a tick of an axis rather than a lone position.
    expect(formatBpTick(4_600_000, 1_000)).toBe('4,600 kb')
  })
})

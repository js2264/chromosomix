/**
 * Marks on a map that has been turned 45°.
 *
 * The turn takes the row axis away — y is distance from the diagonal, which is
 * not a place — so a mark can no longer be put down by asking both axes where a
 * locus is. What is tested here is the arithmetic that replaces it: a mark names
 * one locus or two, and the turn is a function of those two.
 *
 * The failure this guards against is quiet. Every draw call here used to bail
 * out at `rows === null`, so a turned map simply had no overlays on it — the
 * reader's own marks vanished when they pressed the toggle and came back when
 * they pressed it again, which reads as a rendering glitch rather than as a
 * missing feature. Nothing in a screenshot says a mark is *absent*, so the
 * assertions below are about where each shape lands rather than about whether
 * anything was drawn at all.
 *
 * Geometry, not appearance: the recording context keeps the path, and the tests
 * ask where the path went. Colour, opacity and line width are the same code the
 * square map has always run.
 */

import { describe, expect, it } from 'vitest'

import {
  drawArrowheads,
  drawDiagonalFeatures,
  drawManualLines,
  drawManualRects,
  drawPairs,
  type OverlayAxes,
  type OverlayFrame,
} from '@/render/overlays'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { BIN_FRACTION, cellLoci } from '@/render/rotate'
import { emptyFeatureSet } from '@/annotations/featureset'
import type { FeatureSet, PairSet } from '@/annotations/types'
import type { ManualArrowhead, ManualLine, ManualRect } from '@/annotations/manual'

const BINSIZE = 1000
/** Deepest separation the band shows, in bins. */
const MAX_SEPARATION = 40
/** Columns of the turned block: half a bin each. */
const NCOLS = 200
const PLOT = 400

/** A recording 2D context: enough of one for a path to be read back off it. */
class Recorder {
  readonly moves: Array<[number, number]> = []
  readonly lines: Array<[number, number]> = []
  readonly arcs: Array<[number, number, number]> = []
  readonly rects: Array<[number, number, number, number]> = []
  strokeStyle = ''
  fillStyle = ''
  lineWidth = 0
  lineJoin = ''
  globalAlpha = 1
  private clipped = false

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  stroke(): void {}
  fill(): void {}
  clip(): void {
    this.clipped = true
    // The clip's own rect is not part of the drawing; drop it so the assertions
    // below read the marks rather than the frame around them.
    this.rects.length = 0
  }
  get didClip(): boolean {
    return this.clipped
  }
  moveTo(x: number, y: number): void {
    this.moves.push([x, y])
  }
  lineTo(x: number, y: number): void {
    this.lines.push([x, y])
  }
  arc(x: number, y: number, r: number): void {
    this.arcs.push([x, y, r])
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.rects.push([x, y, w, h])
  }
}

const ctx = (): Recorder => new Recorder()
const as2d = (recorder: Recorder): CanvasRenderingContext2D =>
  recorder as unknown as CanvasRenderingContext2D

/** The genomic axis under a turned block: one contig, half a bin per column. */
const turnedCols = (): LocusAxis =>
  new LocusAxis([
    {
      contig: 'chrI',
      unitStart: 0,
      unitEnd: NCOLS,
      bpStart: 0,
      bpPerUnit: BINSIZE * BIN_FRACTION,
      contigLength: NCOLS * BINSIZE * BIN_FRACTION,
    },
  ])

const frameFor = (rows: number): OverlayFrame => ({
  plot: { x: 0, y: 0, width: PLOT, height: PLOT },
  data: { x: 0, y: 0, width: PLOT, height: PLOT },
  colScale: new Scale([0, NCOLS], PLOT),
  rowScale: new Scale([0, rows], PLOT),
  dpr: 1,
})

const turnedAxes = (direction: 'up' | 'down' = 'up'): OverlayAxes => ({
  rows: null,
  cols: turnedCols(),
  turn: { maxSeparation: MAX_SEPARATION, direction, binsize: BINSIZE, nrows: MAX_SEPARATION + 1 },
})

/** The turned block is `maxSeparation + 1` rows tall. */
const frame = (): OverlayFrame => frameFor(MAX_SEPARATION + 1)

/** Canvas y of the diagonal itself, which everything turned stands on. */
const axisY = (direction: 'up' | 'down' = 'up'): number => {
  const rows = MAX_SEPARATION + 1
  const row = direction === 'up' ? MAX_SEPARATION + 0.5 : 0.5
  return (row / rows) * PLOT
}

/** Canvas x of a genomic position on the turned axis. */
const xOf = (bp: number): number => (bp / (BINSIZE * BIN_FRACTION) / NCOLS) * PLOT

const features = (spans: Array<[number, number]>): FeatureSet => ({
  ...emptyFeatureSet(),
  contigs: ['chrI'],
  length: spans.length,
  contig: Int32Array.from(spans.map(() => 0)),
  start: Int32Array.from(spans.map(([s]) => s)),
  end: Int32Array.from(spans.map(([, e]) => e)),
  strand: Int8Array.from(spans.map(() => 0)),
  score: Float32Array.from(spans.map(() => Number.NaN)),
  name: spans.map((_, i) => `f${i}`),
  detail: spans.map(() => ''),
  exonAt: Int32Array.from(spans.map(() => 0).concat([0])),
  cdsStart: Int32Array.from(spans.map(() => -1)),
  cdsEnd: Int32Array.from(spans.map(() => -1)),
  contigAt: Int32Array.from([0, spans.length]),
  maxSpan: Int32Array.from([Math.max(0, ...spans.map(([s, e]) => e - s))]),
})

describe('a domain on a turned map', () => {
  it('is a triangle standing on the axis, apex over its own midpoint', () => {
    // 10 kb wide, so 10 bins of separation: the apex is ten rows off the axis
    // and directly over 15 kb, which is where the domain's middle is.
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), frame(), turnedAxes(), features([[10_000, 20_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'element',
    })
    expect(rec.moves).toHaveLength(1)
    const [startX, startY] = rec.moves[0]
    expect(startX).toBeCloseTo(xOf(10_000), 6)
    expect(startY).toBeCloseTo(axisY(), 6)

    const [apex, end] = rec.lines
    expect(apex[0]).toBeCloseTo(xOf(15_000), 6)
    expect(end[0]).toBeCloseTo(xOf(20_000), 6)
    // Both feet on the axis, and the apex ten bins above it.
    expect(end[1]).toBeCloseTo(axisY(), 6)
    const perBin = PLOT / (MAX_SEPARATION + 1)
    expect(axisY() - apex[1]).toBeCloseTo(10 * perBin, 6)
  })

  it('grows downward on the mirrored half of a comparison', () => {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), frame(), turnedAxes('down'), features([[10_000, 20_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'element',
    })
    const apex = rec.lines[0]
    expect(apex[1]).toBeGreaterThan(axisY('down'))
  })

  it('is clipped, because a domain can be wider than the band on screen', () => {
    // 100 bins apart against a band of 40: unclipped the apex is drawn well
    // above the plot, over the ruler.
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), frame(), turnedAxes(), features([[0, 100_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'element',
    })
    expect(rec.didClip).toBe(true)
    expect(rec.lines[0][1]).toBeLessThan(0)
  })

  it('draws no square, which is what the untuned path draws', () => {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), frame(), turnedAxes(), features([[10_000, 20_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'element',
    })
    expect(rec.rects).toHaveLength(0)
  })
})

describe('a boundary on a turned map', () => {
  it('is a tick standing on the axis at the feature’s midpoint', () => {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), frame(), turnedAxes(), features([[10_000, 12_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'border',
    })
    const [x, y] = rec.moves[0]
    expect(x).toBeCloseTo(xOf(11_000), -0.5)
    expect(y).toBeCloseTo(axisY(), 6)
    // Away from the diagonal, which is up the screen.
    expect(rec.lines[0][0]).toBeCloseTo(x, 6)
    expect(rec.lines[0][1]).toBeLessThan(y)
  })

  it('points the other way on the mirrored half', () => {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), frame(), turnedAxes('down'), features([[10_000, 12_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'border',
    })
    expect(rec.lines[0][1]).toBeGreaterThan(rec.moves[0][1])
  })
})

describe('a loop on a turned map', () => {
  const pairs = (a: number, b: number): PairSet => ({
    contigs: ['chrI'],
    contig1: Int32Array.from([0]),
    contig2: Int32Array.from([0]),
    start1: Int32Array.from([a]),
    end1: Int32Array.from([a]),
    start2: Int32Array.from([b]),
    end2: Int32Array.from([b]),
    length: 1,
    score: Float32Array.from([Number.NaN]),
    name: [''],
    detail: [''],
  })

  it('is one dot at the height of its own span', () => {
    const rec = ctx()
    drawPairs(as2d(rec), frame(), turnedAxes(), pairs(10_000, 30_000), {
      colour: '#f00',
      opacity: 1,
      radius: 4,
    })
    // The pair and its mirror rotate to the same point, so there is one circle
    // rather than the two the square map has to choose between.
    expect(rec.arcs).toHaveLength(1)
    const [x, y] = rec.arcs[0]
    expect(x).toBeCloseTo(xOf(20_000), 6)
    const perBin = PLOT / (MAX_SEPARATION + 1)
    expect(axisY() - y).toBeCloseTo(20 * perBin, 6)
  })

  it('is not drawn for a call further out than the band shows', () => {
    // 60 kb apart against a band of 40 bins. Not "off the edge of the picture" —
    // outside the data, and a dot pinned to the top would claim a depth the map
    // is not showing.
    const rec = ctx()
    drawPairs(as2d(rec), frame(), turnedAxes(), pairs(10_000, 70_000), {
      colour: '#f00',
      opacity: 1,
      radius: 4,
    })
    expect(rec.arcs).toHaveLength(0)
  })

  it('is not drawn between two sequences, which have no separation', () => {
    const set = pairs(10_000, 30_000)
    const across: PairSet = { ...set, contigs: ['chrI', 'chrII'], contig2: Int32Array.from([1]) }
    const rec = ctx()
    drawPairs(as2d(rec), frame(), turnedAxes(), across, { colour: '#f00', opacity: 1, radius: 4 })
    expect(rec.arcs).toHaveLength(0)
  })
})

describe('a hand-drawn line on a turned map', () => {
  const line = (axis: ManualLine['axis']): ManualLine => ({
    id: 'm1',
    kind: 'line',
    axis,
    at: { contig: 'chrI', bp: 25_000 },
    colour: '#f00',
  })

  /** Canvas y of a row of the turned block. */
  const yOf = (row: number, rows = MAX_SEPARATION + 1): number => (row / rows) * PLOT
  /** Canvas x of a column of the turned block. */
  const xAt = (col: number): number => (col / NCOLS) * PLOT
  /** The place, in columns: 25 kb is 50 half-bins along. */
  const PLACE = 25_000 / (BINSIZE * BIN_FRACTION)

  // It was drawn straight up the band, as it is on the square. A column of a
  // turned picture is not a place: it is contacts between two *other* places
  // the whole height of it, and a reader's line named one — whose contacts on a
  // turned map are the two 45° rays leaving it, the V a pointer on a track
  // draws. The line carries on, vertical, down the lanes from the V's apex.
  it('is the V its place makes, standing on the axis', () => {
    const rec = ctx()
    drawManualLines(as2d(rec), frame(), turnedAxes(), [line('vertical')])
    expect(rec.moves).toHaveLength(2)
    for (const [x, y] of rec.moves) {
      expect(x).toBeCloseTo(xOf(25_000), 6)
      expect(y).toBeCloseTo(axisY(), 6)
    }
    // To the far edge, one each way along the genome: a row further from the
    // diagonal is a column further along, so the rays reach as far across as
    // the apex is deep.
    const ends = [...rec.lines].sort((a, b) => a[0] - b[0])
    expect(ends[0][0]).toBeCloseTo(xAt(PLACE - (MAX_SEPARATION + 0.5)), 6)
    expect(ends[1][0]).toBeCloseTo(xAt(PLACE + (MAX_SEPARATION + 0.5)), 6)
    expect(ends.map(([, y]) => y)).toEqual([0, 0])
    expect(rec.didClip).toBe(true)
  })

  it('is the same V for a mark that was horizontal, and for a crosshair', () => {
    // The axis it was drawn against is gone; the locus is not. And one place is
    // one V, however many axes the mark was drawn against on the square.
    for (const axis of ['horizontal', 'both'] as const) {
      const rec = ctx()
      drawManualLines(as2d(rec), frame(), turnedAxes(), [line(axis)])
      expect(rec.moves, axis).toHaveLength(2)
      expect(rec.moves[0][0]).toBeCloseTo(xOf(25_000), 6)
    }
  })

  it('opens downwards on a band turned the other way', () => {
    const rec = ctx()
    drawManualLines(as2d(rec), frame(), turnedAxes('down'), [line('vertical')])
    expect(rec.moves[0][1]).toBeCloseTo(axisY('down'), 6)
    expect(rec.lines.map(([, y]) => y)).toEqual([PLOT, PLOT])
  })

  it('stands in each band of a mirrored pair, the same place in two maps', () => {
    const rows = 2 * (MAX_SEPARATION + 1)
    const rec = ctx()
    drawManualLines(
      as2d(rec),
      frameFor(rows),
      {
        ...turnedAxes(),
        turn: {
          maxSeparation: MAX_SEPARATION,
          direction: 'up',
          binsize: BINSIZE,
          nrows: rows,
          fold: MAX_SEPARATION + 1,
        },
      },
      [line('vertical')],
    )
    expect(rec.moves).toHaveLength(4)
    const apexes = rec.moves.map(([, y]) => y)
    expect(apexes.filter((y) => Math.abs(y - yOf(MAX_SEPARATION + 0.5, rows)) < 1e-6)).toHaveLength(2)
    expect(apexes.filter((y) => Math.abs(y - yOf(MAX_SEPARATION + 1.5, rows)) < 1e-6)).toHaveLength(2)
    expect(rec.lines.map(([, y]) => y).sort((a, b) => a - b)).toEqual([0, 0, PLOT, PLOT])
  })

  it('still draws the arm that reaches in when its place is off the side', () => {
    // Columns 60 to 200 on screen: the place, at 50, is off the left edge, and
    // its right arm runs into the picture. Culled on the apex, the whole V went.
    const rec = ctx()
    const view: OverlayFrame = { ...frame(), colScale: new Scale([60, NCOLS], PLOT) }
    drawManualLines(as2d(rec), view, turnedAxes(), [line('vertical')])
    expect(rec.moves).toHaveLength(1)
    expect(rec.lines[0][0]).toBeGreaterThan(0)
  })

  it('draws the arm of a place outside the block, where it reaches in', () => {
    // A window from 50 kb: the place, at 45 kb, is not on the block at all —
    // ten columns left of its first — and its right arm crosses the band.
    const rec = ctx()
    const windowed: OverlayAxes = {
      ...turnedAxes(),
      cols: new LocusAxis([
        {
          contig: 'chrI',
          unitStart: 0,
          unitEnd: NCOLS,
          bpStart: 50_000,
          bpPerUnit: BINSIZE * BIN_FRACTION,
          contigLength: 400_000,
        },
      ]),
    }
    drawManualLines(as2d(rec), frame(), windowed, [{ ...line('vertical'), at: { contig: 'chrI', bp: 45_000 } }])
    expect(rec.moves).toHaveLength(1)
    expect(rec.moves[0][0]).toBeCloseTo(xAt(-10), 6)
    expect(rec.lines[0][0]).toBeCloseTo(xAt(-10 + MAX_SEPARATION + 0.5), 6)
  })

  it('draws nothing for a place the axis does not reach', () => {
    const rec = ctx()
    drawManualLines(as2d(rec), frame(), turnedAxes(), [
      { ...line('vertical'), at: { contig: 'chrI', bp: 400_000 } },
    ])
    expect(rec.moves).toHaveLength(0)
  })
})

describe('an arrowhead on a turned map', () => {
  const mark = (a: number, b: number): ManualArrowhead => ({
    id: 'a1',
    kind: 'arrowhead',
    a: { contig: 'chrI', bp: a },
    b: { contig: 'chrI', bp: b },
    colour: '#f00',
  })

  it('stands over the dot it names, tip pointing back at it', () => {
    const rec = ctx()
    drawArrowheads(as2d(rec), frame(), turnedAxes(), [mark(10_000, 30_000)], '#fff')
    expect(rec.moves).toHaveLength(1)
    const perBin = PLOT / (MAX_SEPARATION + 1)
    const dotY = axisY() - 20 * perBin
    const [tipX, tipY] = rec.moves[0]
    expect(tipX).toBeCloseTo(xOf(20_000), 6)
    // The tip is just clear of the dot, on the far side from the diagonal, and
    // the base is further out still — so the glyph never covers the cell.
    expect(tipY).toBeLessThan(dotY)
    expect(rec.lines[0][1]).toBeLessThan(tipY)
    // A flat base, square to the axis, rather than the square map's 45°.
    expect(rec.lines[0][1]).toBeCloseTo(rec.lines[1][1], 6)
  })

  it('hangs below the axis on the mirrored half', () => {
    const rec = ctx()
    drawArrowheads(as2d(rec), frame(), turnedAxes('down'), [mark(10_000, 30_000)], '#fff')
    const perBin = PLOT / (MAX_SEPARATION + 1)
    expect(rec.moves[0][1]).toBeGreaterThan(axisY('down') + 20 * perBin)
  })

  it('marks a cell on the diagonal on the axis itself', () => {
    const rec = ctx()
    drawArrowheads(as2d(rec), frame(), turnedAxes(), [mark(25_000, 25_000)], '#fff')
    expect(rec.moves).toHaveLength(1)
    expect(rec.moves[0][0]).toBeCloseTo(xOf(25_000), 6)
  })

  it('is stood a whole pixel clear of the dot, and only upwards', () => {
    // The 45° gap is four pixels along the glyph's own axis; turned, that axis
    // is vertical, and one more pixel is what puts the tip off the cell rather
    // than on its last row. Sideways it stays put — a nudge in x on a turned map
    // is a nudge to a different separation, which is a different pair of loci.
    const rec = ctx()
    drawArrowheads(as2d(rec), frame(), turnedAxes(), [mark(10_000, 30_000)], '#fff')
    const perBin = PLOT / (MAX_SEPARATION + 1)
    const dotY = axisY() - 20 * perBin
    const [tipX, tipY] = rec.moves[0]
    expect(dotY - tipY).toBeCloseTo(4 + 1, 6)
    expect(tipX).toBeCloseTo(xOf(20_000), 6)
  })
})

describe('a hand-drawn box on a turned map', () => {
  const box = (a: [number, number], b: [number, number]): ManualRect => ({
    id: 'r1',
    kind: 'rect',
    a: { contig: 'chrI', from: a[0], to: a[1] },
    b: { contig: 'chrI', from: b[0], to: b[1] },
    colour: '#f00',
  })
  const perBin = PLOT / (MAX_SEPARATION + 1)
  /** Every corner of a drawn polygon, in the order the path was walked. */
  const path = (rec: Recorder): Array<[number, number]> => [...rec.moves, ...rec.lines]

  it('is the domain triangle when it sits on the diagonal', () => {
    // An on-diagonal box *is* a domain drawn by hand, so it had better be the
    // shape a domain out of a BED gets: two corners on the axis, and the two off
    // it meeting over the midpoint at the height of the box's own width.
    const rec = ctx()
    drawManualRects(as2d(rec), frame(), turnedAxes(), [box([10_000, 20_000], [10_000, 20_000])])
    expect(rec.moves).toHaveLength(1)
    expect(path(rec)).toHaveLength(3)
    const feet = path(rec).filter(([, y]) => Math.abs(y - axisY()) < 1e-6)
    expect(feet.map(([x]) => x)).toEqual([xOf(10_000), xOf(20_000)])
    const apex = path(rec).find(([, y]) => y < axisY() - 1)
    expect(apex?.[0]).toBeCloseTo(xOf(15_000), 6)
    expect(axisY() - (apex?.[1] ?? 0)).toBeCloseTo(10 * perBin, 6)
  })

  it('is one parallelogram, leaning, when it sits off the diagonal', () => {
    // 10 kb of rows against 10 kb of columns 30 kb away. Its four corners are at
    // four different separations, which is exactly what the turn is for: the
    // near corner is 20 bins off the axis and the far one 40.
    const rec = ctx()
    drawManualRects(as2d(rec), frame(), turnedAxes(), [box([10_000, 20_000], [40_000, 50_000])])
    expect(rec.moves).toHaveLength(1)
    const corners = path(rec)
    expect(corners).toHaveLength(4)
    const depths = corners.map(([, y]) => Math.round((axisY() - y) / perBin)).sort((a, b) => a - b)
    expect(depths).toEqual([20, 30, 30, 40])
    // The mirror of a box wholly above the diagonal is wholly below it, and a
    // turned map draws one of those halves. One outline, not two.
    expect(corners.map(([x]) => Math.round(x))).toEqual(
      [25_000, 30_000, 35_000, 30_000].map((bp) => Math.round(xOf(bp))),
    )
  })

  it('drops the half that folds inside the other', () => {
    // A box drawn a little off the diagonal straddles it, so both halves turn
    // into a shape — and the smaller lands wholly inside the larger. Drawing it
    // would put an outline in there that is not the edge of anything.
    const rec = ctx()
    drawManualRects(as2d(rec), frame(), turnedAxes(), [box([10_000, 30_000], [12_000, 34_000])])
    expect(rec.moves).toHaveLength(1)
    expect(path(rec)).toHaveLength(5)
  })

  it('keeps both halves when they fold apart', () => {
    // 100 kb of rows against 20 kb of columns inside them: the part above the
    // diagonal and the part below rotate into two separate stripes leaning
    // opposite ways, and neither is inside the other. Drawing one of them would
    // be drawing half the contacts the reader boxed.
    const rec = ctx()
    drawManualRects(as2d(rec), frame(), turnedAxes(), [box([0, 100_000], [40_000, 60_000])])
    expect(rec.moves).toHaveLength(2)
    expect(path(rec)).toHaveLength(8)
    expect(rec.didClip).toBe(true)
  })

  it('is not drawn between two sequences, which have no separation', () => {
    const rec = ctx()
    const across: ManualRect = {
      ...box([10_000, 20_000], [40_000, 50_000]),
      b: { contig: 'chrII', from: 40_000, to: 50_000 },
    }
    drawManualRects(as2d(rec), frame(), turnedAxes(), [across])
    expect(path(rec)).toHaveLength(0)
  })
})

describe('the square map, unchanged', () => {
  const squareAxes = (): OverlayAxes => {
    const axis = new LocusAxis([
      {
        contig: 'chrI',
        unitStart: 0,
        unitEnd: 100,
        bpStart: 0,
        bpPerUnit: BINSIZE,
        contigLength: 100 * BINSIZE,
      },
    ])
    return { rows: axis, cols: axis }
  }
  const squareFrame = (): OverlayFrame => ({
    plot: { x: 0, y: 0, width: PLOT, height: PLOT },
    data: { x: 0, y: 0, width: PLOT, height: PLOT },
    colScale: new Scale([0, 100], PLOT),
    rowScale: new Scale([0, 100], PLOT),
    dpr: 1,
  })

  it('still draws a domain as the square it occupies on both axes', () => {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), squareFrame(), squareAxes(), features([[10_000, 20_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'element',
    })
    expect(rec.rects).toHaveLength(1)
    expect(rec.didClip).toBe(false)
  })

  it('still draws both arms of a crosshair', () => {
    const rec = ctx()
    drawManualLines(as2d(rec), squareFrame(), squareAxes(), [
      { id: 'm', kind: 'line', axis: 'both', at: { contig: 'chrI', bp: 25_000 }, colour: '#f00' },
    ])
    expect(rec.moves).toHaveLength(2)
  })

  /** Four canvas pixels per bin: 100 bins of 1 kb across a 400 px plot. */
  const pxOf = (bp: number): number => (bp / BINSIZE) * 4

  // The one square-map shape nothing covered. `border` is the point-like call —
  // an insulation minimum, a TAD boundary — and its docstring asks for "a short
  // rule *across* the diagonal". It was drawn from `(x - reach, y - reach)` to
  // `(x + reach, y + reach)`, which on a symmetric block is slope +1: the map
  // diagonal itself. The mark lay over the brightest row in the picture, and a
  // run of adjacent calls merged into a stripe down the diagonal rather than
  // reading as a row of ticks crossing it.
  it('rules a boundary across the diagonal, not along it', () => {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), squareFrame(), squareAxes(), features([[40_000, 42_000]]), {
      colour: '#f00',
      opacity: 1,
      shape: 'border',
    })
    expect(rec.moves).toHaveLength(1)
    expect(rec.lines).toHaveLength(1)
    const [mx, my] = rec.moves[0]
    const [lx, ly] = rec.lines[0]
    // Perpendicular to `row == col`, which is pixel slope +1 here.
    expect((ly - my) / (lx - mx)).toBeCloseTo(-1, 6)
    // Centred on the feature's own midpoint, which is on the diagonal — half a
    // pixel off exact because a hairline is snapped to the device-pixel grid.
    expect((mx + lx) / 2).toBeCloseTo(pxOf(41_000), -0.5)
    expect((mx + lx) / 2).toBeCloseTo((my + ly) / 2, 6)
    // …and it genuinely crosses: one end above the diagonal, one below, and
    // neither end on it.
    expect(Math.sign(my - mx)).toBe(-Math.sign(ly - lx))
    expect(Math.sign(my - mx)).not.toBe(0)
  })

  it('draws a box as the rows and columns it was drawn across', () => {
    const rec = ctx()
    drawManualRects(as2d(rec), squareFrame(), squareAxes(), [
      {
        id: 'r1',
        kind: 'rect',
        a: { contig: 'chrI', from: 10_000, to: 20_000 },
        b: { contig: 'chrI', from: 40_000, to: 60_000 },
        colour: '#f00',
      },
    ])
    expect(rec.rects).toHaveLength(1)
    const [x, y, width, height] = rec.rects[0]
    // Any ratio: twice as wide as it is tall, which is a thing no on-diagonal
    // mark can say. Half a pixel off exact because an outline is snapped to the
    // device-pixel grid, as every hairline here is.
    expect(x).toBeCloseTo(pxOf(40_000), -0.5)
    expect(y).toBeCloseTo(pxOf(10_000), -0.5)
    expect(width).toBeCloseTo(pxOf(20_000), 6)
    expect(height).toBeCloseTo(pxOf(10_000), 6)
    // Clipped, unlike the lines: a box is very often bigger than the view it is
    // read in, and its edges must not be drawn over the rulers.
    expect(rec.didClip).toBe(true)
  })

  it('draws no box for one whose sequences are off this view', () => {
    const rec = ctx()
    drawManualRects(as2d(rec), squareFrame(), squareAxes(), [
      {
        id: 'r1',
        kind: 'rect',
        a: { contig: 'chrI', from: 10_000, to: 20_000 },
        b: { contig: 'chrIII', from: 40_000, to: 60_000 },
        colour: '#f00',
      },
    ])
    expect(rec.rects).toHaveLength(0)
  })

  it('stands an arrowhead a pixel clear of the cell’s corner, both ways', () => {
    // The gap is measured along the glyph's 45° axis, so it clears the cell's
    // *centre* — where the mark is anchored — and not its corner. One pixel on
    // each axis, square to them, is what takes the tip off the cell it names.
    const gap = 4 * Math.SQRT1_2
    const upper = ctx()
    drawArrowheads(
      as2d(upper),
      squareFrame(),
      squareAxes(),
      [
        {
          id: 'a1',
          kind: 'arrowhead',
          a: { contig: 'chrI', bp: 20_000 },
          b: { contig: 'chrI', bp: 60_000 },
          colour: '#f00',
        },
      ],
      '#fff',
    )
    const [tipX, tipY] = upper.moves[0]
    expect(tipX - pxOf(60_000)).toBeCloseTo(gap + 1, 6)
    expect(tipY - pxOf(20_000)).toBeCloseTo(-(gap + 1), 6)

    // And the other way in the lower triangle, where the glyph is mirrored: away
    // from the diagonal is down and to the left, so the nudge is too.
    const lower = ctx()
    drawArrowheads(
      as2d(lower),
      squareFrame(),
      squareAxes(),
      [
        {
          id: 'a2',
          kind: 'arrowhead',
          a: { contig: 'chrI', bp: 60_000 },
          b: { contig: 'chrI', bp: 20_000 },
          colour: '#f00',
        },
      ],
      '#fff',
    )
    expect(lower.moves[0][0] - pxOf(20_000)).toBeCloseTo(-(gap + 1), 6)
    expect(lower.moves[0][1] - pxOf(60_000)).toBeCloseTo(gap + 1, 6)
  })
})

// ---------------------------------------------------------------------------
// Placing one, which is the other direction through the same geometry
// ---------------------------------------------------------------------------

/**
 * Where a click lands, in loci.
 *
 * The drawing above is only half the feature: a reader who cannot *put* a mark
 * on a turned map has no use for one that would be drawn correctly. Both ways in
 * that involve pointing — `pick on map`, and the right-click menu — end at one
 * conversion from a cell to a pair of loci, and it used to read the loci off the
 * axes the *picture* is drawn against. On a turned map the row axis of that pair
 * is deliberately `null`, so the conversion answered `null`, so the click placed
 * nothing and the menu never opened. Silently, both of them, in the presentation
 * a region view opens in.
 */
describe('a mark placed by pointing at a turned map', () => {
  /** The square block the band was rotated out of: 100 bins of `chrI`. */
  const squarePair = (): { rows: LocusAxis; cols: LocusAxis } => {
    const axis = new LocusAxis([
      {
        contig: 'chrI',
        unitStart: 0,
        unitEnd: 100,
        bpStart: 0,
        bpPerUnit: BINSIZE,
        contigLength: 100 * BINSIZE,
      },
    ])
    return { rows: axis, cols: axis }
  }
  const turnedBlock = {
    nrows: MAX_SEPARATION + 1,
    ncols: NCOLS,
    maxSeparation: MAX_SEPARATION,
    direction: 'up' as const,
    originBin: 0,
  }

  it('names the two ends of the contact under the pointer', () => {
    // The bottom row is separation zero and column 50 is bin 25, so this is the
    // diagonal cell at 25 kb: one place, named twice, which is what a line or a
    // crosshair dropped on the diagonal is.
    const onDiagonal = cellLoci(squarePair(), turnedBlock, { row: MAX_SEPARATION, col: 50 })
    expect(onDiagonal?.rows).toEqual({ contig: 'chrI', bp: 25_500 })
    expect(onDiagonal?.cols).toEqual({ contig: 'chrI', bp: 25_500 })

    // Ten rows up is ten bins of separation: the two ends are 10 kb apart and
    // straddle the column the pointer is over, which is the loop that dot *is*.
    const aLoop = cellLoci(squarePair(), turnedBlock, { row: MAX_SEPARATION - 10, col: 50 })
    expect(aLoop?.rows).toEqual({ contig: 'chrI', bp: 20_500 })
    expect(aLoop?.cols).toEqual({ contig: 'chrI', bp: 30_500 })
  })

  it('is the middle of the cell, not its left edge', () => {
    // Half a bin in, because a click lands inside a cell: reporting the edge
    // would put every hand-placed mark half a bin before where it was aimed.
    const at = cellLoci(squarePair(), turnedBlock, { row: MAX_SEPARATION, col: 0 })
    expect(at?.cols.bp).toBe(BINSIZE / 2)
  })

  it('answers nothing off the end of the band', () => {
    expect(cellLoci(squarePair(), turnedBlock, { row: MAX_SEPARATION + 5, col: 50 })).toBeNull()
    expect(cellLoci(squarePair(), turnedBlock, { row: 0, col: NCOLS + 1 })).toBeNull()
  })

  it('is two axis lookups on a square map, cell for cell', () => {
    const at = cellLoci(squarePair(), null, { row: 3, col: 7 })
    expect(at?.rows).toEqual({ contig: 'chrI', bp: 3_500 })
    expect(at?.cols).toEqual({ contig: 'chrI', bp: 7_500 })
  })
})

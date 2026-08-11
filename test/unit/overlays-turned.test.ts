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
  drawPairs,
  type OverlayAxes,
  type OverlayFrame,
} from '@/render/overlays'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { BIN_FRACTION, cellLoci } from '@/render/rotate'
import { emptyFeatureSet } from '@/annotations/featureset'
import type { FeatureSet, PairSet } from '@/annotations/types'
import type { ManualArrowhead, ManualLine } from '@/annotations/manual'

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
  turn: { maxSeparation: MAX_SEPARATION, direction, binsize: BINSIZE },
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

  it('stays where it is on the genome, so it joins the lane below it', () => {
    const rec = ctx()
    drawManualLines(as2d(rec), frame(), turnedAxes(), [line('vertical')])
    // Half a pixel off exact: a hairline is snapped to the device-pixel grid.
    expect(rec.moves[0][0]).toBeCloseTo(xOf(25_000), -0.5)
    expect(rec.moves).toHaveLength(1)
  })

  it('is drawn for a mark that was horizontal, at the locus it names', () => {
    // The axis it was drawn against is gone; the locus is not. A horizontal
    // silently dropped is a mark the reader put down and cannot find.
    const rec = ctx()
    drawManualLines(as2d(rec), frame(), turnedAxes(), [line('horizontal')])
    expect(rec.moves).toHaveLength(1)
    expect(rec.moves[0][0]).toBeCloseTo(xOf(25_000), -0.5)
  })

  it('draws a crosshair once rather than twice at the same x', () => {
    const rec = ctx()
    drawManualLines(as2d(rec), frame(), turnedAxes(), [line('both')])
    expect(rec.moves).toHaveLength(1)
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

/**
 * What an overlay drops for being off screen — and, more to the point, what it
 * must not.
 *
 * A mark on the matrix is one of two kinds of thing, and they cannot be culled
 * the same way. A `point` or a `border` is a *place*: its midpoint is the mark,
 * and a midpoint off screen is a mark off screen. A `corner` is drawn for an
 * *extent*: a domain, a compartment, and an extent is very often bigger than
 * the window it is read in — zoom into a domain and the square it claims
 * surrounds the view on all four sides.
 *
 * `drawDiagonalFeatures` used to guard both with the point test. On the square
 * map an extent was kept only if its *bottom-right corner* was inside the data
 * rect, so the mark vanished at exactly the zoom the reader reached for to
 * inspect the block it was claiming — and asymmetrically, since `locusToUnit`
 * grows with bp: a pan that kept only the domain's start drew nothing, while
 * the mirror pan kept drawing. On the turned map the same test was applied to a
 * triangle's midpoint, dropping a domain panned so that only one foot is in
 * view. Every domain set is drawn as corners, so neither was a corner case.
 *
 * Nothing here is a claim about clipping: `HeatmapView.drawOverlay` clips the
 * painter to the data rect, so a mark that overlaps the view may be emitted
 * with coordinates well outside it. What is asserted is that it is emitted.
 * The sibling painter `drawManualRects` has always done it this way, and the
 * last case pins the two against each other.
 */

import { describe, expect, it } from 'vitest'

import {
  drawDiagonalFeatures,
  drawManualRects,
  type OverlayAxes,
  type OverlayFrame,
} from '@/render/overlays'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { BIN_FRACTION } from '@/render/rotate'
import { emptyFeatureSet } from '@/annotations/featureset'
import type { FeatureSet } from '@/annotations/types'

const BINSIZE = 1000
/** Bins of `chrI`, which is the whole genome here. */
const NBINS = 200
const PLOT = 400
/** Deepest separation a turned band shows, in bins. */
const MAX_SEPARATION = 40

/** A recording 2D context: enough of one for a path to be read back off it. */
class Recorder {
  readonly moves: Array<[number, number]> = []
  readonly lines: Array<[number, number]> = []
  readonly rects: Array<[number, number, number, number]> = []
  strokeStyle = ''
  lineWidth = 0
  lineJoin = ''
  globalAlpha = 1

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  stroke(): void {}
  clip(): void {
    // The clip's own rect is not part of the drawing; drop it so the assertions
    // below read the marks rather than the frame around them.
    this.rects.length = 0
  }
  moveTo(x: number, y: number): void {
    this.moves.push([x, y])
  }
  lineTo(x: number, y: number): void {
    this.lines.push([x, y])
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.rects.push([x, y, w, h])
  }
}

const ctx = (): Recorder => new Recorder()
const as2d = (recorder: Recorder): CanvasRenderingContext2D =>
  recorder as unknown as CanvasRenderingContext2D

/** One contig, one bin per unit, as a square block of it is drawn. */
const squareAxis = (): LocusAxis =>
  new LocusAxis([
    {
      contig: 'chrI',
      unitStart: 0,
      unitEnd: NBINS,
      bpStart: 0,
      bpPerUnit: BINSIZE,
      contigLength: NBINS * BINSIZE,
    },
  ])

const squareAxes = (): OverlayAxes => {
  const axis = squareAxis()
  return { rows: axis, cols: axis }
}

/**
 * The view, in bins: what the reader has panned and zoomed to.
 *
 * `rows` defaults to the same window as the columns, which is the on-diagonal
 * case every test below but the last one is about; passing a different one is
 * a map panned off its own diagonal.
 */
const squareFrame = (from: number, to: number, rows?: [number, number]): OverlayFrame => ({
  plot: { x: 0, y: 0, width: PLOT, height: PLOT },
  data: { x: 0, y: 0, width: PLOT, height: PLOT },
  colScale: new Scale([from, to], PLOT),
  rowScale: new Scale(rows ?? [from, to], PLOT),
  dpr: 1,
})

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

/** The domain every case below is about: `chrI:100,000-120,000`, 20 bins wide. */
const domain = (): FeatureSet => features([[100_000, 120_000]])

const corner = { colour: '#f00', opacity: 1, shape: 'corner' } as const

/**
 * Draw the domain against a view of `[from, to]` bins and hand back the square
 * each corner stands for, as `[x, y, width, height]`.
 *
 * A corner is one move and two strokes — from the diagonal at the start along
 * the top edge, then down the right edge — so its square is read off those.
 */
function boxesFor(from: number, to: number): Array<[number, number, number, number]> {
  const rec = ctx()
  drawDiagonalFeatures(as2d(rec), squareFrame(from, to), squareAxes(), domain(), corner)
  expect(rec.rects).toHaveLength(0)
  expect(rec.lines).toHaveLength(rec.moves.length * 2)
  return rec.moves.map(([x, y], i) => {
    const [right] = rec.lines[2 * i]
    const [, bottom] = rec.lines[2 * i + 1]
    return [x, y, right - x, bottom - y]
  })
}

describe('a domain on the square map, against the edges of the view', () => {
  it('is drawn when the whole of it is in view', () => {
    // The case that always worked, kept as the control: 20 bins of a 200-bin
    // view, 2 px per bin, so the square is 40 px on a side at (200, 200) — half
    // a pixel off exact where a rule is snapped to the device-pixel grid.
    const boxes = boxesFor(0, NBINS)
    expect(boxes).toHaveLength(1)
    const [x, y, width, height] = boxes[0]
    expect(x).toBeCloseTo(200, -0.5)
    expect(y).toBeCloseTo(200, -0.5)
    expect(width).toBeCloseTo(40, -0.5)
    expect(height).toBeCloseTo(40, -0.5)
  })

  // The reported failure, and the one that matters most: the reader zooms into
  // the block the call is claiming, and the mark saying which block that is
  // disappears. Nothing on screen says a mark is *absent*, so this read as the
  // domain not being there.
  it('is still drawn when the view is inside it', () => {
    const boxes = boxesFor(105, 115)
    expect(boxes).toHaveLength(1)
    const [x, y, width, height] = boxes[0]
    // The square it stands for surrounds the view on all four sides, which is
    // the whole point: the corner's arms are its top and right edges, both
    // outside the window, and the clip decides what is seen of them.
    expect(x).toBeLessThan(0)
    expect(y).toBeLessThan(0)
    expect(x + width).toBeGreaterThan(PLOT)
    expect(y + height).toBeGreaterThan(PLOT)
  })

  it('is drawn when only its start is in view', () => {
    expect(boxesFor(95, 110)).toHaveLength(1)
  })

  it('is drawn when only its end is in view, as it always was', () => {
    // The mirror of the case above. This one survived the old guard — the far
    // corner was on screen — which is what made the bug asymmetric as well as
    // wrong, and is why both pans are pinned rather than one.
    expect(boxesFor(115, 130)).toHaveLength(1)
  })

  it('is dropped when the view is wholly past it', () => {
    // Culling still happens; what was wrong was the predicate, not the idea of
    // having one. A view 30 bins clear of the domain either way emits nothing.
    expect(boxesFor(150, 190)).toHaveLength(0)
    expect(boxesFor(20, 60)).toHaveLength(0)
  })

  it('is dropped when only its columns are in view, never half-drawn', () => {
    // Off the diagonal: the columns show the domain, the rows are forty bins
    // away, so the box is below the plot entirely. The cull that was too eager
    // above must not become no cull at all — a box the view does not reach on
    // *either* axis is not a box to draw, and under a clip it would be an
    // invisible path costing a stroke on every frame.
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), squareFrame(100, 140, [0, 40]), squareAxes(), domain(), corner)
    expect(rec.moves).toHaveLength(0)
  })

  it('is kept on exactly the same terms as the box a reader draws by hand', () => {
    // A domain out of a BED and a box drawn over the same block are the same
    // assertion about the same pixels (see `drawManualRects`), so the two
    // painters must agree about when it is on screen.
    for (const [from, to] of [
      [0, NBINS],
      [105, 115],
      [95, 110],
      [115, 130],
      [150, 190],
      [20, 60],
    ] as Array<[number, number]>) {
      const manual = ctx()
      drawManualRects(as2d(manual), squareFrame(from, to), squareAxes(), [
        {
          id: 'r1',
          kind: 'rect',
          a: { contig: 'chrI', from: 100_000, to: 120_000 },
          b: { contig: 'chrI', from: 100_000, to: 120_000 },
          colour: '#f00',
        },
      ])
      expect(boxesFor(from, to).length, `view ${from}-${to}`).toBe(manual.rects.length)
    }
  })
})

describe('a domain on a turned map, against the edges of the view', () => {
  /** The genomic axis under a turned block: half a bin per column. */
  const turnedAxes = (): OverlayAxes => ({
    rows: null,
    cols: new LocusAxis([
      {
        contig: 'chrI',
        unitStart: 0,
        unitEnd: NBINS / BIN_FRACTION,
        bpStart: 0,
        bpPerUnit: BINSIZE * BIN_FRACTION,
        contigLength: NBINS * BINSIZE,
      },
    ]),
    turn: { maxSeparation: MAX_SEPARATION, direction: 'up', binsize: BINSIZE, nrows: MAX_SEPARATION + 1 },
  })

  /** A turned view showing columns `[from, to]`; the band is as deep as always. */
  const turnedFrame = (from: number, to: number): OverlayFrame => ({
    plot: { x: 0, y: 0, width: PLOT, height: PLOT },
    data: { x: 0, y: 0, width: PLOT, height: PLOT },
    colScale: new Scale([from, to], PLOT),
    rowScale: new Scale([0, MAX_SEPARATION + 1], PLOT),
    dpr: 1,
  })

  /** How many triangles were drawn: one `moveTo` per foot-to-apex-to-foot path. */
  function trianglesFor(from: number, to: number): number {
    const rec = ctx()
    drawDiagonalFeatures(as2d(rec), turnedFrame(from, to), turnedAxes(), domain(), corner)
    return rec.moves.length
  }

  it('is drawn when the whole of it is in view', () => {
    expect(trianglesFor(0, NBINS / BIN_FRACTION)).toBe(1)
  })

  // The turned form of the same mistake: the triangle's apex is a consequence
  // of the domain's own width, so its midpoint is not the mark and culling on
  // it dropped a domain with a foot still on screen.
  it('is still drawn when only its left foot is in view', () => {
    // Columns are half-bins, so the domain runs from column 200 to column 240
    // and its midpoint is column 220.
    expect(trianglesFor(180, 210)).toBe(1)
  })

  it('is still drawn when only its right foot is in view', () => {
    expect(trianglesFor(230, 260)).toBe(1)
  })

  it('is dropped when neither foot is anywhere near', () => {
    expect(trianglesFor(300, 340)).toBe(0)
  })
})

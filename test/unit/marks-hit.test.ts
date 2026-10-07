/**
 * Which of the reader's marks the hand is on, on a map (§8.1).
 *
 * The map's right-click menu offers to hide the marks under the pointer, and
 * the answer is measured on the ink: each mark is drawn again into a context
 * that keeps the path rather than painting it. What is asserted is that the
 * answer is the picture's on both presentations — a rule within a few pixels,
 * an arrowhead's glyph and the cell it names, a box's outline and its inside,
 * the turned map's V on either arm — and that the nearest comes first.
 */

import { describe, expect, it } from 'vitest'

import { drawManualLines, manualMarksAt, MARK_REACH, type OverlayAxes, type OverlayFrame } from '@/render/overlays'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { BIN_FRACTION } from '@/render/rotate'
import type { ManualArrowhead, ManualLine, ManualRect } from '@/annotations/manual'

const PLOT = 400
const BINS = 100
const BINSIZE = 1000

/** One sequence of a hundred 1 kb bins, four pixels each. */
const axis = (): LocusAxis =>
  new LocusAxis([
    { contig: 'chrI', unitStart: 0, unitEnd: BINS, bpStart: 0, bpPerUnit: BINSIZE, contigLength: BINS * BINSIZE },
  ])

const square: OverlayAxes = { rows: axis(), cols: axis() }
const frame: OverlayFrame = {
  plot: { x: 0, y: 0, width: PLOT, height: PLOT },
  data: { x: 0, y: 0, width: PLOT, height: PLOT },
  colScale: new Scale([0, BINS], PLOT),
  rowScale: new Scale([0, BINS], PLOT),
  dpr: 1,
}

const vertical: ManualLine = { id: 'v', kind: 'line', axis: 'vertical', at: { contig: 'chrI', bp: 25_000 }, colour: '#000' }
const horizontal: ManualLine = { id: 'h', kind: 'line', axis: 'horizontal', at: { contig: 'chrI', bp: 30_000 }, colour: '#000' }
const loop: ManualArrowhead = {
  id: 'a',
  kind: 'arrowhead',
  a: { contig: 'chrI', bp: 20_000 },
  b: { contig: 'chrI', bp: 70_000 },
  colour: '#000',
}
const domain: ManualRect = {
  id: 'big',
  kind: 'rect',
  a: { contig: 'chrI', from: 10_000, to: 40_000 },
  b: { contig: 'chrI', from: 10_000, to: 40_000 },
  colour: '#000',
}
const inner: ManualRect = {
  id: 'small',
  kind: 'rect',
  a: { contig: 'chrI', from: 20_000, to: 30_000 },
  b: { contig: 'chrI', from: 20_000, to: 30_000 },
  colour: '#000',
}

const marks = { lines: [vertical, horizontal], arrowheads: [loop], rects: [domain, inner] }
const at = (x: number, y: number): string[] => manualMarksAt(frame, square, marks, { x, y }).map((mark) => mark.id)

describe('the marks under the pointer on a square map', () => {
  it('finds a rule within reach of it, and not past it', () => {
    // The vertical line is the column at 25 kb, x = 100; the horizontal one the row at 30 kb, y = 120.
    expect(at(100 + MARK_REACH - 1, 300)).toEqual(['v'])
    expect(at(100 + MARK_REACH + 2, 300)).toEqual([])
    expect(at(300, 118)).toEqual(['h'])
  })

  it('finds an arrowhead on its glyph and on the cell it names, a few pixels off its tip', () => {
    // The cell at 20 kb × 70 kb is centred at (280, 80); above the diagonal, so
    // the glyph stands off it up and to the right.
    expect(at(288, 72)).toEqual(['a'])
    expect(at(280, 80)).toEqual(['a'])
    expect(at(250, 80)).toEqual([])
  })

  it('finds a box on its outline, and inside it after anything whose line the pointer is on — the smaller box first', () => {
    expect(at(41, 70)).toEqual(['big'])
    // Inside both boxes and off every line: the inner box, then the outer one.
    expect(at(110, 110)).toEqual(['small', 'big'])
    // On the vertical rule and inside both: the rule is what the hand is on.
    expect(at(100, 110)).toEqual(['v', 'small', 'big'])
  })

  it('finds nothing where nothing is drawn', () => {
    expect(at(350, 350)).toEqual([])
  })
})

describe('the marks under the pointer on a turned map', () => {
  const NCOLS = 200
  const MAX_SEPARATION = 40
  const turned: OverlayAxes = {
    rows: null,
    cols: new LocusAxis([
      {
        contig: 'chrI',
        unitStart: 0,
        unitEnd: NCOLS,
        bpStart: 0,
        bpPerUnit: BINSIZE * BIN_FRACTION,
        contigLength: NCOLS * BINSIZE * BIN_FRACTION,
      },
    ]),
    turn: { maxSeparation: MAX_SEPARATION, direction: 'up', binsize: BINSIZE, nrows: MAX_SEPARATION + 1 },
  }
  const band: OverlayFrame = {
    plot: { x: 0, y: 0, width: PLOT, height: PLOT },
    data: { x: 0, y: 0, width: PLOT, height: PLOT },
    colScale: new Scale([0, NCOLS], PLOT),
    rowScale: new Scale([0, MAX_SEPARATION + 1], PLOT),
    dpr: 1,
  }
  const line: ManualLine = { id: 'v', kind: 'line', axis: 'vertical', at: { contig: 'chrI', bp: 50_000 }, colour: '#000' }

  /** The V the line is drawn as: each arm's two ends, read back off a recording context. */
  const arms = (): Array<[[number, number], [number, number]]> => {
    const moves: Array<[number, number]> = []
    const ends: Array<[number, number]> = []
    const recorder = {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      stroke() {},
      moveTo: (x: number, y: number) => moves.push([x, y]),
      lineTo: (x: number, y: number) => ends.push([x, y]),
    }
    drawManualLines(recorder as unknown as CanvasRenderingContext2D, band, turned, [line])
    return moves.map((from, index) => [from, ends[index]])
  }

  it('finds a line on either arm of its V, and not between them', () => {
    const [left, right] = arms()
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    for (const [from, to] of [left, right]) {
      const middle = { x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2 }
      expect(manualMarksAt(band, turned, { lines: [line], arrowheads: [], rects: [] }, middle).map((mark) => mark.id)).toEqual(['v'])
    }
    // Straight up from the apex, which a square map's vertical rule would be:
    // between the arms, and on neither.
    const apex = left[0]
    expect(manualMarksAt(band, turned, { lines: [line], arrowheads: [], rects: [] }, { x: apex[0], y: apex[1] - 120 })).toEqual([])
  })

  it('finds a domain inside the triangle it is drawn as', () => {
    const triangle: ManualRect = {
      id: 'd',
      kind: 'rect',
      a: { contig: 'chrI', from: 20_000, to: 40_000 },
      b: { contig: 'chrI', from: 20_000, to: 40_000 },
      colour: '#000',
    }
    // Over the domain's middle, 30 kb, half way up its twenty bins of height.
    const x = (30_000 / (BINSIZE * BIN_FRACTION) / NCOLS) * PLOT
    const y = ((MAX_SEPARATION + 0.5 - 10) / (MAX_SEPARATION + 1)) * PLOT
    expect(manualMarksAt(band, turned, { lines: [], arrowheads: [], rects: [triangle] }, { x, y }).map((mark) => mark.id)).toEqual(['d'])
  })
})

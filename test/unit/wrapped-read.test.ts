/**
 * Splitting a window that runs off the end of a circle.
 *
 * Every property here is one an off-by-one would break silently. A wrapped block
 * whose two halves are a bin apart draws a discontinuity at exactly the junction
 * the flag was turned on to remove, and it looks like data.
 */

import { describe, expect, it } from 'vitest'

import { needsWrapping, stitch, wrapPieces, wrapUnitStarts, type Sub } from '@/worker/wrap'

/** A sequence of 1,000 bins starting at absolute bin 200 — an offset one, on purpose. */
const WRAP: [number, number] = [200, 1200]

describe('wrapPieces', () => {
  it('leaves a window inside the sequence in one piece, unshifted', () => {
    expect(wrapPieces([300, 500], WRAP)).toEqual([{ from: 300, to: 500, at: 0, shift: 0 }])
    expect(needsWrapping([300, 500], WRAP)).toBe(false)
  })

  it('splits a window that runs off the end', () => {
    // The last 100 bins and the first 100, in that order.
    expect(wrapPieces([1100, 1300], WRAP)).toEqual([
      { from: 1100, to: 1200, at: 0, shift: 0 },
      { from: 200, to: 300, at: 100, shift: 1000 },
    ])
    expect(needsWrapping([1100, 1300], WRAP)).toBe(true)
  })

  it('splits a window that opens before the sequence begins', () => {
    // 100 bins before the origin is the last 100 bins of the circle, and the
    // lap it belongs to is the one *before* the stored sequence — so the second
    // piece, which is the stored beginning, carries no shift at all.
    expect(wrapPieces([100, 300], WRAP)).toEqual([
      { from: 1100, to: 1200, at: 0, shift: -1000 },
      { from: 200, to: 300, at: 100, shift: 0 },
    ])
  })

  it('reads a window several laps along as the same two pieces, further out', () => {
    const once = wrapPieces([1100, 1300], WRAP)
    const thrice = wrapPieces([1100 + 2000, 1300 + 2000], WRAP)
    expect(thrice.map((piece) => ({ from: piece.from, to: piece.to, at: piece.at }))).toEqual(
      once.map((piece) => ({ from: piece.from, to: piece.to, at: piece.at })),
    )
    expect(thrice.map((piece) => piece.shift)).toEqual([2000, 3000])
  })

  it('covers exactly the window it was given, once', () => {
    for (const start of [200, 640, 1199, 1200, 1201, -3, 5000]) {
      for (const span of [1, 7, 250, 999, 1000]) {
        const pieces = wrapPieces([start, start + span], WRAP)
        const covered = pieces.reduce((sum, piece) => sum + (piece.to - piece.from), 0)
        expect(covered).toBe(span)
        // Contiguous in the block, with no gap and no overlap.
        let at = 0
        for (const piece of pieces) {
          expect(piece.at).toBe(at)
          at += piece.to - piece.from
          expect(piece.from).toBeGreaterThanOrEqual(WRAP[0])
          expect(piece.to).toBeLessThanOrEqual(WRAP[1])
        }
        // And the unwrapped position of every piece is the window's own.
        for (const piece of pieces) {
          expect(piece.from + piece.shift).toBe(start + piece.at)
        }
      }
    }
  })

  it('caps a window wider than the sequence at one lap', () => {
    const pieces = wrapPieces([600, 600 + 4000], WRAP)
    const covered = pieces.reduce((sum, piece) => sum + (piece.to - piece.from), 0)
    expect(covered).toBe(1000)
    // Two pieces, because a lap-wide window starting mid-sequence still crosses
    // the junction once — and never three, which would mean a bin drawn twice.
    expect(pieces).toHaveLength(2)
  })

  it('has nothing to say about an empty window', () => {
    expect(wrapPieces([500, 500], WRAP)).toEqual([])
    expect(wrapPieces([500, 400], WRAP)).toEqual([])
    expect(wrapPieces([500, 700], [200, 200])).toEqual([])
  })
})

/**
 * Laying the pieces out as one block.
 *
 * The arithmetic that goes silently wrong: a block assembled with the strides
 * confused still has a bright diagonal and still has structure, and it is
 * shuffled. Checked against sub-blocks whose every cell is a distinct number,
 * which is the only way to see it.
 */
describe('stitch', () => {
  /** A rectangle whose cell `(r, c)` is `tag + r * 100 + c`. */
  function sub(nrows: number, ncols: number, tag: number): Sub {
    const values = new Float32Array(nrows * ncols)
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) values[r * ncols + c] = tag + r * 100 + c
    }
    return { nrows, ncols, values }
  }

  it('writes each piece into its own quadrant', () => {
    // Two row pieces of 3 and 2 rows, two column pieces of 4 and 5 columns.
    const grid = [
      [sub(3, 4, 1_000_000), sub(3, 5, 2_000_000)],
      [sub(2, 4, 3_000_000), sub(2, 5, 4_000_000)],
    ]
    const out = stitch(grid)
    expect(out.nrows).toBe(5)
    expect(out.ncols).toBe(9)
    const at = (r: number, c: number): number => out.values[r * out.ncols + c]
    // Top-left, top-right, bottom-left, bottom-right — each cell from its own
    // piece, at its own offset inside it.
    expect(at(0, 0)).toBe(1_000_000)
    expect(at(2, 3)).toBe(1_000_000 + 2 * 100 + 3)
    expect(at(0, 4)).toBe(2_000_000)
    expect(at(2, 8)).toBe(2_000_000 + 2 * 100 + 4)
    expect(at(3, 0)).toBe(3_000_000)
    expect(at(4, 3)).toBe(3_000_000 + 1 * 100 + 3)
    expect(at(3, 4)).toBe(4_000_000)
    expect(at(4, 8)).toBe(4_000_000 + 1 * 100 + 4)
  })

  it('leaves a one-piece read exactly as it was', () => {
    const only = sub(4, 4, 7)
    const out = stitch([[only]])
    expect(out.nrows).toBe(4)
    expect(out.ncols).toBe(4)
    expect(Array.from(out.values)).toEqual(Array.from(only.values))
  })
})

/**
 * Where a wrapped axis says the sequence itself begins.
 *
 * The one number in a wrapped read that takes thought, and the one whose failure
 * is invisible: get it wrong on the second stretch and every tick, track and
 * annotation past the junction is drawn a whole chromosome away — which looks
 * like an empty half of the picture rather than like a bug.
 *
 * The property checked is the one `render/locus.ts` actually inverts: a cell at
 * block offset `o` must report `(blockStart + o − unitStart) × cellSize` as its
 * distance from the sequence's own first cell.
 */
describe('wrapUnitStarts', () => {
  const LAP = 1000
  const CONTIG_START = 200

  it('puts the second stretch at the sequence’s own beginning', () => {
    // The last 120 bins of the sequence, then its first 80.
    const starts = wrapUnitStarts({
      starts: [CONTIG_START + LAP - 120, CONTIG_START],
      cells: [120, 80],
      blockStart: CONTIG_START + LAP - 120,
      contigStart: CONTIG_START,
      binsPerCell: 1,
    })
    const bpAt = (offset: number, unitStart: number): number =>
      CONTIG_START + LAP - 120 + offset - unitStart
    // The block's first cell is 120 bins from the end.
    expect(bpAt(0, starts[0])).toBe(LAP - 120)
    // The cell just past the junction is the sequence's own first bin.
    expect(bpAt(120, starts[1])).toBe(0)
    expect(bpAt(150, starts[1])).toBe(30)
  })

  it('holds at a coarser grid, where the arithmetic is in cells', () => {
    const k = 10
    // Snapped to the cell grid: 120 bins from the end is cell 88 of 100.
    const starts = wrapUnitStarts({
      starts: [CONTIG_START + LAP - 120, CONTIG_START],
      cells: [12, 8],
      blockStart: CONTIG_START + LAP - 120,
      contigStart: CONTIG_START,
      binsPerCell: k,
    })
    const cellsAt = (offset: number, unitStart: number): number =>
      CONTIG_START + LAP - 120 + offset - unitStart
    expect(cellsAt(0, starts[0])).toBe((LAP - 120) / k)
    expect(cellsAt(12, starts[1])).toBe(0)
    expect(cellsAt(15, starts[1])).toBe(3)
  })

  it('is the ordinary answer for a read that does not wrap', () => {
    const starts = wrapUnitStarts({
      starts: [CONTIG_START + 40],
      cells: [60],
      blockStart: CONTIG_START + 40,
      contigStart: CONTIG_START,
      binsPerCell: 1,
    })
    // One stretch, opening 40 bins into the sequence.
    expect(CONTIG_START + 40 + 0 - starts[0]).toBe(40)
  })
})

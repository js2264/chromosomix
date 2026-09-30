/**
 * A saddle is a square, whatever the reader did to the drawer.
 *
 * The two cell sizes were computed independently, each filling its own axis, so
 * the aspect of a saddle or a correlation heatmap was decided by how wide the
 * panel had been dragged. That is a picture whose shape carries no information
 * and reads as one whose shape does: a saddle is read by comparing its two
 * corners, and a corner stretched 40% along one axis looks stronger than the one
 * opposite it. A correlation heatmap over eight tracks is the same argument with
 * its diagonal as the giveaway.
 *
 * The rule is one line — square cells — and everything worth asserting about it
 * follows from that rather than from any particular box.
 */

import { describe, expect, it } from 'vitest'

import { matrixCells, squareCell } from '@/ui/analysisPlots'

describe('the cell a matrix figure is drawn with', () => {
  /**
   * One number for both axes is the whole mechanism, so what a test can add is
   * the *consequence*: a 50 × 50 saddle comes out the same width and height in
   * every box, and it fits inside the box it was given.
   */
  it('draws a square matrix as a square, however the box is shaped', () => {
    const sides = new Set<number>()
    for (const [w, h] of [
      [300, 300],
      [900, 300],
      [300, 900],
      [640, 400],
    ] as const) {
      const cell = squareCell(w, h, 50, 50)
      const width = cell * 50
      const height = cell * 50
      expect(width).toBe(height)
      expect(width).toBeLessThanOrEqual(w)
      expect(height).toBeLessThanOrEqual(h)
      sides.add(width)
    }
    // …and the sizes genuinely differ between those boxes, so the equality above
    // is not being satisfied by a constant.
    expect(sides.size).toBeGreaterThan(1)
  })

  it('fills the smaller axis, so the figure is as large as it can be', () => {
    // 900 x 300, 50 cells: the height is the binding constraint at 6 px a cell.
    expect(squareCell(900, 300, 50, 50)).toBe(6)
    // …and the width when it is the smaller one.
    expect(squareCell(300, 900, 50, 50)).toBe(6)
  })

  /**
   * A non-square matrix keeps its own aspect *exactly*, which is the same rule
   * said once: the cells are square, so the picture is as tall as it is many.
   */
  it('leaves a non-square matrix its own aspect', () => {
    const cell = squareCell(800, 400, 40, 20)
    expect(cell * 40).toBe(2 * (cell * 20))
  })

  it('does not divide by zero on an empty matrix', () => {
    expect(Number.isFinite(squareCell(400, 400, 0, 0))).toBe(true)
  })

  // Below a pixel a cell stops being snapped to whole pixels, or a 4,000-cell
  // matrix in a 300-pixel box would round every cell to zero and draw nothing.
  it('keeps a fractional cell where a whole one would be nothing', () => {
    expect(squareCell(300, 300, 4000, 4000)).toBeGreaterThan(0)
    expect(squareCell(300, 300, 4000, 4000)).toBeLessThan(1)
  })
})

/**
 * …and the one picture that must *not* be square.
 *
 * The metaplot's per-feature heatmap is three thousand features down and a
 * thousand bins across. Square cells make it a ribbon a fifth of the card wide,
 * which is what a reader sees instead of the block every metaplot tool draws —
 * and there is nothing to compare across its diagonal, because a row is a
 * feature and a column is a distance.
 */
describe('a matrix whose rows are a list', () => {
  const shape = { nrows: 3_000, ncols: 1_000 }

  it('takes the whole box, where a square one would be a ribbon', () => {
    const fill = matrixCells(900, 600, { ...shape, aspect: 'fill' })
    expect(fill.width * shape.ncols).toBeCloseTo(900, 5)
    expect(fill.height * shape.nrows).toBeCloseTo(600, 5)
    const square = matrixCells(900, 600, { ...shape, aspect: 'square' })
    expect(square.width * shape.ncols).toBeLessThan(900 / 4)
  })

  it('is the square rule where nothing says otherwise', () => {
    const cell = matrixCells(900, 600, { nrows: 50, ncols: 50 })
    expect(cell.width).toBe(cell.height)
    expect(cell.width).toBe(squareCell(900, 600, 50, 50))
  })
})

/**
 * …and the picture read like a map: a dot plot's two assemblies end to end
 * (§28), four hundred cells a side, which whole pixels would leave four
 * hundred pixels wide in a card three times that.
 */
describe('a matrix read like a map', () => {
  it('fills the box with square cells a fraction of a pixel wide', () => {
    const cell = matrixCells(900, 600, { nrows: 400, ncols: 380, large: true })
    expect(cell.width).toBe(cell.height)
    expect(cell.height * 400).toBeCloseTo(600, 5)
    // Whole pixels would have been one each: two thirds of the room.
    expect(matrixCells(900, 600, { nrows: 400, ncols: 380 }).width).toBe(1)
  })
})

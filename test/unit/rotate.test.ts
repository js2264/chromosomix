/**
 * The map turned 45°.
 *
 * Every failure here draws a picture that looks like a Hi-C figure and is one of
 * something else, which is why the tests below are arithmetic rather than
 * snapshots:
 *
 * - a lattice filled on one parity only is a checkerboard, and at fit zoom the
 *   pooling hides it — so it looks like a slightly dim map until somebody
 *   measures one;
 * - a row order taken from the array rather than from the direction puts the
 *   diagonal along the *top*, which is a picture of the same data upside down
 *   and reads as a completely different genome;
 * - an inverse that ignores the half-bin column width names the wrong pair for
 *   every second column, so the readout disagrees with the picture by one bin
 *   half the time;
 * - and a gate that lets an off-diagonal block through draws "distance from the
 *   diagonal" for a block that has no diagonal.
 *
 * The identity used throughout: a matrix whose value *is* the separation of its
 * two bins. Turned, every row of the result must then be constant and equal to
 * the separation that row stands for — one assertion that pins the geometry, the
 * row order and the lattice fill at once.
 */

import { describe, expect, it } from 'vitest'

import {
  BIN_FRACTION,
  anchorColumns,
  anchorRays,
  binsForColumns,
  cellAt,
  isTurnable,
  positionAt,
  reachForRows,
  rotateBlock,
  rowForSeparation,
  rowsForReach,
  separationAt,
  separationBp,
  separationCoords,
  turnDepthFor,
  turnedCentre,
  type RotatableBlock,
} from '@/render/rotate'
import { bpTicks } from '@/render/heatmap'

function block(
  n: number,
  fill: (row: number, col: number) => number,
  extent: [number, number] = [0, n],
): RotatableBlock {
  const values = new Float32Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) values[r * n + c] = fill(r, c)
  }
  return { nrows: n, ncols: n, values, rowExtent: extent, colExtent: extent }
}

/** A matrix whose every cell holds the separation of its own two bins. */
function separationMatrix(n: number): RotatableBlock {
  return block(n, (r, c) => Math.abs(r - c))
}

/** One row of a turned block, as a plain array. */
function rowOf(rotated: { ncols: number; values: Float32Array }, row: number): number[] {
  return [...rotated.values.subarray(row * rotated.ncols, (row + 1) * rotated.ncols)]
}

describe('the turned lattice', () => {
  it('fills every column, rather than half of them', () => {
    // `b1 + b2` and `b2 - b1` share parity, so the natural rotated grid is a
    // checkerboard. A gap every other column is invisible at fit zoom — the
    // pooling covers it — and is a comb of blank stripes as soon as anybody
    // zooms in.
    const turned = rotateBlock(separationMatrix(8), { maxSeparation: 3 })
    // The band's own row: separation 0 reaches every column of the block.
    const axis = rowOf(turned, rowForSeparation(turned, 0))
    expect(axis.every((value) => Number.isFinite(value))).toBe(true)
  })

  it('gives each row the separation it stands for', () => {
    // The whole geometry in one assertion: a matrix of separations, turned, must
    // be constant along every row and equal to that row's own distance.
    const turned = rotateBlock(separationMatrix(10), { maxSeparation: 5 })
    for (let separation = 0; separation <= 5; separation++) {
      const values = rowOf(turned, rowForSeparation(turned, separation)).filter((v) =>
        Number.isFinite(v),
      )
      expect(values.length).toBeGreaterThan(0)
      for (const value of values) expect(value).toBe(separation)
    }
  })

  it('is half a bin per column, so a cell is square', () => {
    // Both axes advance by half a bin, which is what lets the result be handed
    // to a renderer that assumes uniform square cells.
    expect(BIN_FRACTION).toBe(0.5)
    const turned = rotateBlock(separationMatrix(6), { maxSeparation: 2 })
    expect(turned.ncols).toBe(2 * 6 - 1)
    expect(positionAt(turned, 2) - positionAt(turned, 0)).toBeCloseTo(1, 10)
  })
})

describe('which way is up', () => {
  it('puts the diagonal along the bottom by default', () => {
    // Rows are emitted in draw order, so a top-to-bottom raster needs no notion
    // of which way up this is. Upside down it is a picture of the same data that
    // reads as a different genome entirely.
    const turned = rotateBlock(separationMatrix(6), { maxSeparation: 3 })
    expect(turned.direction).toBe('up')
    expect(separationAt(turned, turned.nrows - 1)).toBe(0)
    expect(separationAt(turned, 0)).toBe(3)
  })

  it('mirrors for the second file of a comparison', () => {
    const turned = rotateBlock(separationMatrix(6), { maxSeparation: 3, direction: 'down' })
    expect(separationAt(turned, 0)).toBe(0)
    expect(separationAt(turned, turned.nrows - 1)).toBe(3)
  })

  it('reads the same data whichever way it is drawn', () => {
    const up = rotateBlock(separationMatrix(7), { maxSeparation: 4 })
    const down = rotateBlock(separationMatrix(7), { maxSeparation: 4, direction: 'down' })
    for (let separation = 0; separation <= 4; separation++) {
      expect(rowOf(up, rowForSeparation(up, separation))).toEqual(
        rowOf(down, rowForSeparation(down, separation)),
      )
    }
  })
})

describe('reading a position back out', () => {
  it('names the pair of bins a cell came from', () => {
    // A matrix that encodes its own coordinates, so the inverse can be checked
    // against the value rather than against a second copy of the arithmetic.
    const n = 9
    const coded = block(n, (r, c) => Math.min(r, c) * 100 + Math.max(r, c))
    const turned = rotateBlock(coded, { maxSeparation: 4 })
    for (let row = 0; row < turned.nrows; row++) {
      for (let column = 0; column < turned.ncols; column++) {
        const value = turned.values[row * turned.ncols + column]
        if (!Number.isFinite(value)) continue
        const cell = cellAt(turned, row, column)
        expect(cell).not.toBeNull()
        expect(cell!.row * 100 + cell!.col).toBe(value)
      }
    }
  })

  it('gives the two columns of one cell the same answer', () => {
    // A column is half a bin, so a cell covers two of them and which one the
    // pointer is over is not a fact about the data.
    const turned = rotateBlock(separationMatrix(8), { maxSeparation: 3 })
    const row = rowForSeparation(turned, 2)
    const a = cellAt(turned, row, 4)
    const b = cellAt(turned, row, 5)
    expect(a).toEqual(b)
  })

  it('reports the separation the row stands for', () => {
    const turned = rotateBlock(separationMatrix(8), { maxSeparation: 3 })
    const cell = cellAt(turned, rowForSeparation(turned, 3), 5)
    expect(cell?.separation).toBe(3)
    expect(Math.abs((cell?.col ?? 0) - (cell?.row ?? 0))).toBe(3)
  })

  it('places column 0 at the block’s own first bin', () => {
    const turned = rotateBlock(separationMatrix(5), { maxSeparation: 2 })
    expect(turned.originBin).toBe(0)
    const shifted = rotateBlock(
      block(5, (r, c) => Math.abs(r - c), [1000, 1005]),
      { maxSeparation: 2 },
    )
    expect(shifted.originBin).toBe(1000)
    expect(positionAt(shifted, 0)).toBeCloseTo(1000.25, 10)
  })
})

describe('the corners nothing reaches', () => {
  it('leaves them empty rather than calling them zero', () => {
    // A cell at the left edge and high up needs a partner off the end of the
    // block, which was never read. Drawn as paper, not as an absence of
    // contacts — the two are different findings.
    const turned = rotateBlock(separationMatrix(8), { maxSeparation: 5 })
    const top = rowOf(turned, rowForSeparation(turned, 5))
    expect(Number.isNaN(top[0])).toBe(true)
    expect(Number.isNaN(top[top.length - 1])).toBe(true)
    // …and the middle of that row is real.
    expect(Number.isFinite(top[Math.floor(top.length / 2)])).toBe(true)
  })

  it('never asks for a separation the block cannot hold', () => {
    const turned = rotateBlock(separationMatrix(4), { maxSeparation: 999 })
    expect(turned.maxSeparation).toBe(3)
    expect(turned.nrows).toBe(4)
  })

  it('survives a block with one cell in it', () => {
    const turned = rotateBlock(separationMatrix(1), { maxSeparation: 4 })
    expect(turned.maxSeparation).toBe(0)
    expect(turned.nrows).toBe(1)
    expect(turned.ncols).toBe(1)
  })

  /**
   * The band is *not* blanked before it is filled — a second pass over the
   * largest array a turned map allocates, to set values the loop is about to
   * overwrite — so the emptiness of the corners is arithmetic rather than a
   * fallback. Which makes this the assertion that arithmetic has to earn: a
   * `Float32Array` arrives zeroed, so a corner the fill misses does not come out
   * blank, it comes out as a **contact count of nothing**, in the one place on a
   * contact map where "no data" and "no contacts" look most alike.
   */
  it('has no cell it neither filled nor emptied, at any depth or either way up', () => {
    const n = 11
    // Every value non-zero, so a zero in the output can only be a cell that was
    // never written at all.
    const ones = block(n, () => 1)
    for (const direction of ['up', 'down'] as const) {
      for (let depth = 0; depth < n; depth++) {
        const turned = rotateBlock(ones, { maxSeparation: depth, direction })
        for (let row = 0; row < turned.nrows; row++) {
          const separation = separationAt(turned, row)
          for (let column = 0; column < turned.ncols; column++) {
            const value = turned.values[row * turned.ncols + column]
            // The reach of a row, from `rotateBlock`: a cell `s` apart at the
            // left edge needs a partner `s` before the block began.
            const inside = column >= separation && column <= 2 * n - separation - 1
            expect(inside ? value === 1 : Number.isNaN(value)).toBe(true)
          }
        }
      }
    }
  })
})

describe('what may be turned at all', () => {
  const square = { level: 'bin' as const, rowExtent: [0, 100] as const, colExtent: [0, 100] as const }

  it('accepts one sequence against itself', () => {
    expect(isTurnable(square)).toBe(true)
    expect(isTurnable({ ...square, rowGroups: [{}] })).toBe(true)
  })

  it('refuses a block between two different stretches', () => {
    // No diagonal, so no distance from one.
    expect(isTurnable({ ...square, colExtent: [100, 200] as const })).toBe(false)
  })

  it('refuses a block spanning more than one sequence', () => {
    // A boundary between two sequences is a discontinuity in the x axis, and the
    // "distance" across it is not a distance.
    expect(isTurnable({ ...square, rowGroups: [{}, {}] })).toBe(false)
  })

  it('refuses a level where a cell is a whole sequence', () => {
    expect(isTurnable({ ...square, level: 'contig' })).toBe(false)
    expect(isTurnable({ ...square, level: 'genome' })).toBe(false)
  })
})

describe('the ruler up the side', () => {
  it('reads zero on the diagonal and grows towards the top', () => {
    // The gradient is negative because separation grows up the picture while a
    // row index grows down it — the one thing about this ruler that is not the
    // same as every other one.
    const coords = separationCoords({ maxSeparation: 40, direction: 'up' }, 1000)
    expect(coords.bpPerCell).toBe(-1000)
    // Row 40 is the diagonal, and its centre is at 40.5.
    expect(coords.bpAtOrigin + 40.5 * coords.bpPerCell).toBeCloseTo(0, 9)
    // Row 0 is the top of the band: 40 bins of separation, in base pairs.
    expect(coords.bpAtOrigin + 0.5 * coords.bpPerCell).toBeCloseTo(40_000, 9)
  })

  it('grows downward on the mirrored half of a comparison', () => {
    const coords = separationCoords({ maxSeparation: 40, direction: 'down' }, 1000)
    expect(coords.bpPerCell).toBe(1000)
    expect(coords.bpAtOrigin + 0.5 * coords.bpPerCell).toBeCloseTo(0, 9)
    expect(coords.bpAtOrigin + 40.5 * coords.bpPerCell).toBeCloseTo(40_000, 9)
  })

  it('agrees with the separation the readout names, row for row', () => {
    // Two answers to "how far from the diagonal is this row", derived
    // separately: the ruler's line and `separationAt`'s index arithmetic. A
    // ruler that disagreed with the readout under the pointer would be the
    // worst kind of wrong, because each on its own looks right.
    const rotated = { maxSeparation: 25, direction: 'up' as const }
    const coords = separationCoords(rotated, 2000)
    for (const row of [0, 1, 7, 24, 25]) {
      expect(coords.bpAtOrigin + (row + 0.5) * coords.bpPerCell).toBeCloseTo(
        separationBp(separationAt(rotated, row), 2000),
        9,
      )
    }
  })
})

describe('ticks on a descending axis', () => {
  it('are the same round steps as on an ascending one', () => {
    const up = separationCoords({ maxSeparation: 40, direction: 'up' }, 1000)
    const down = separationCoords({ maxSeparation: 40, direction: 'down' }, 1000)
    const ofUp = bpTicks(up, [0, 41], 6).map((t) => t.bp).sort((a, b) => a - b)
    const ofDown = bpTicks(down, [0, 41], 6).map((t) => t.bp).sort((a, b) => a - b)
    expect(ofUp).toEqual(ofDown)
    expect(ofUp[0]).toBe(0)
  })

  it('puts each tick back on the row that carries it', () => {
    const coords = separationCoords({ maxSeparation: 40, direction: 'up' }, 1000)
    for (const tick of bpTicks(coords, [0, 41], 6)) {
      expect(coords.bpAtOrigin + tick.unit * coords.bpPerCell).toBeCloseTo(tick.bp, 6)
      // …and inside the band, rather than off the top of it.
      expect(tick.unit).toBeGreaterThanOrEqual(0)
      expect(tick.unit).toBeLessThanOrEqual(41)
    }
  })
})

describe('how deep the band opens', () => {
  it('is a quarter of the block until somebody says otherwise', () => {
    expect(turnDepthFor({ nrows: 500, ncols: 500 }, null)).toBe(125)
    // A fraction, not a distance: the same rule has to serve a 4.6 Mb bacterial
    // chromosome and a 250 Mb human one.
    expect(turnDepthFor({ nrows: 40, ncols: 40 }, null)).toBe(10)
  })

  it('takes the shorter axis, so a rectangle cannot ask for rows it has not got', () => {
    expect(turnDepthFor({ nrows: 500, ncols: 60 }, null)).toBe(15)
  })

  it('gives the reader what they dragged to, inside the block', () => {
    expect(turnDepthFor({ nrows: 500, ncols: 500 }, 300)).toBe(300)
    expect(turnDepthFor({ nrows: 500, ncols: 500 }, 9_000)).toBe(499)
  })

  it('bottoms out at one row rather than at none', () => {
    // Dragging the edge onto the diagonal means "as shallow as it goes", not
    // "gone" — and a band of zero rows is a picture with no picture in it.
    expect(turnDepthFor({ nrows: 500, ncols: 500 }, 0)).toBe(1)
    expect(turnDepthFor({ nrows: 500, ncols: 500 }, -40)).toBe(1)
  })

  it('has something to draw even for a block two bins across', () => {
    expect(turnDepthFor({ nrows: 2, ncols: 2 }, null)).toBe(1)
    expect(turnDepthFor({ nrows: 1, ncols: 1 }, null)).toBe(1)
  })

  /**
   * The currency a **deck** shares, and why it is a distance rather than a
   * depth.
   *
   * A band is cut as deep as the box it is drawn in has rows for, which is the
   * right rule for one map and cannot work for several: a grid lays its cells
   * out over more than one frame, so two panels asking their own boxes at their
   * own moments cut two different bands — and the deck's lock then refused to
   * move them together, in a sentence blaming the files' resolutions for what
   * was a layout race. The fix is the one the lock itself already makes: share
   * the *distance*, and let each panel convert it through its own bin size.
   */
  describe('as a distance every panel can convert', () => {
    it('is the row count in bins, which is the lattice’s own identity', () => {
      // A row is half a bin of height and a whole bin of separation
      // (`separationForRows`), so a band of 400 rows on a 9 kb grid reaches
      // 3.6 Mb from the diagonal.
      expect(reachForRows(400, 9000)).toBe(3_600_000)
      expect(rowsForReach(3_600_000, 9000)).toBe(400)
    })

    it('round-trips at whatever bin size the panel is on', () => {
      for (const binsize of [1000, 5000, 9000, 250_000]) {
        expect(rowsForReach(reachForRows(137, binsize), binsize)).toBe(137)
      }
    })

    it('puts two panels of unequal resolution at the same distance', () => {
      // The case the shared *depth* could never serve: 400 rows means 3.6 Mb on
      // one grid and 400 kb on the other, so a deck that shared the row count
      // would have drawn the two bands to wildly different reaches and called it
      // one navigation.
      const reach = reachForRows(400, 9000)
      expect(rowsForReach(reach, 1000)).toBe(3600)
      expect(reachForRows(rowsForReach(reach, 1000), 1000)).toBe(reach)
    })

    it('rounds rather than floors, so neither side loses a bin', () => {
      // The two panels are converting the same number through different sizes,
      // and a floor on both would drift them apart by up to a bin each.
      expect(rowsForReach(3_599_999, 9000)).toBe(400)
      expect(rowsForReach(3_604_000, 9000)).toBe(400)
    })

    it('is never nothing, on `turnDepthFor`’s rule', () => {
      expect(rowsForReach(0, 9000)).toBe(1)
      expect(rowsForReach(-1, 9000)).toBe(1)
      // A bin size that never arrived must not divide by zero.
      expect(rowsForReach(12, 0)).toBe(12)
      expect(reachForRows(3, 0)).toBe(3)
    })
  })

  it('produces a block whose rows are the depth, plus the diagonal', () => {
    // The join between the two: `watchDepth` reads a band's depth back as
    // `maxSeparation + 1`, and a drag that did not agree with what the rotation
    // produced would creep by a row per press.
    const depth = turnDepthFor({ nrows: 40, ncols: 40 }, 12)
    expect(rotateBlock(block(40, () => 1), { maxSeparation: depth }).nrows).toBe(depth + 1)
  })
})

/**
 * A drag across a turned map, read back as bins.
 *
 * The gesture's half of the inverse. `cellAt` answers for one cell and this
 * answers for a *band*, which is what a selection and a 4C anchor both are — and
 * the two have to agree, or the region a marquee opens is not the region its
 * chips were written for.
 */
describe('the bins a band of turned columns covers', () => {
  it('halves the columns, because a column is half a bin', () => {
    expect(binsForColumns([20, 40], 100)).toEqual([10, 20])
  })

  it('rounds outward, so a band names every bin it touched', () => {
    // Columns 21–39 lie inside bins 10–20: a reader who dragged across them
    // meant those bins, not the ones the band wholly covered.
    expect(binsForColumns([21, 39], 100)).toEqual([10, 20])
  })

  it('is at least one bin, however small the drag', () => {
    expect(binsForColumns([20, 20], 100)).toEqual([10, 11])
    expect(binsForColumns([21, 21], 100)).toEqual([10, 11])
  })

  it('stops at the block, since a drag is clamped to the plot and not to the data', () => {
    expect(binsForColumns([0, 4_000], 100)).toEqual([0, 100])
    // …and still hands back a band when the whole drag is past the end.
    expect(binsForColumns([500, 600], 100)).toEqual([99, 100])
  })

  it('agrees with the cell inverse about where a column is', () => {
    // The band from one column, against `cellAt`'s answer for the same column on
    // the diagonal row: both must name the bin the reader is pointing at.
    const rotated = rotateBlock(block(16, (r, c) => Math.abs(r - c)), { maxSeparation: 6 })
    for (const column of [0, 1, 8, 9, 20, 21]) {
      const cell = cellAt(rotated, rowForSeparation(rotated, 0), column)
      expect(binsForColumns([column, column + 1], 16)[0]).toBe(cell?.row)
    }
  })
})

/**
 * The guides on a turned map, as geometry rather than as canvas calls.
 *
 * What the picture must not do is answer "which two places is this?" with a
 * cross. A turned map's two directions are not its two axes: hold one anchor
 * still and the contact walks *diagonally* as the separation grows, so a
 * vertical rule through the pointer crosses contacts between two other places
 * at every row but its own. The assertions below are the two that make the
 * difference visible — a ray must land on the anchor's own column when it
 * reaches the axis, and the two rays must leave the pointer in opposite
 * directions.
 */
describe('the rays a guide follows', () => {
  it('meets the axis at each of the two anchors', () => {
    const rotated = rotateBlock(separationMatrix(16), { maxSeparation: 6 })
    const row = rowForSeparation(rotated, 4)
    // Bins 3 and 7: the cell fills columns 10 and 11, so the pointer is over
    // either of them and the answer must not depend on which.
    for (const column of [10, 11]) {
      const at = turnedCentre(rotated, row, column)
      // The diagonal's own row, where separation is nothing and the picture's
      // two anchors have become one place.
      const axis = rowForSeparation(rotated, 0) + 0.5
      const met = anchorRays(at, [axis]).map((ray) => ray.to.col)
      expect(met.sort((a, b) => a - b)).toEqual(anchorColumns(rotated, row, column))
    }
  })

  it('names the pair the readout names', () => {
    const rotated = rotateBlock(separationMatrix(16), { maxSeparation: 6 })
    const row = rowForSeparation(rotated, 4)
    const cell = cellAt(rotated, row, 10)
    // A bin is two columns wide, so its middle is `2b + 1` — the coordinate a
    // track under the map is drawn in.
    expect(anchorColumns(rotated, row, 10)).toEqual([2 * cell!.row + 1, 2 * cell!.col + 1])
  })

  it('answers a contact with itself with one line, not two', () => {
    const rotated = rotateBlock(separationMatrix(16), { maxSeparation: 6 })
    expect(anchorColumns(rotated, rowForSeparation(rotated, 0), 8)).toHaveLength(1)
  })

  it('leaves the point in both directions, at one column per row', () => {
    const rays = anchorRays({ col: 20, row: 6.5 }, [0])
    expect(rays.map((ray) => ray.to.col).sort((a, b) => a - b)).toEqual([13.5, 26.5])
    for (const ray of rays) {
      expect(Math.abs(ray.to.col - ray.from.col)).toBeCloseTo(Math.abs(ray.to.row - ray.from.row), 10)
    }
  })

  it('reaches both edges of the band, so the X is whatever part of one fits', () => {
    const rotated = rotateBlock(separationMatrix(16), { maxSeparation: 6 })
    const at = turnedCentre(rotated, rowForSeparation(rotated, 3), 12)
    const rows = anchorRays(at, [0, rotated.nrows]).map((ray) => ray.to.row)
    expect(rows.filter((row) => row === 0)).toHaveLength(2)
    expect(rows.filter((row) => row === rotated.nrows)).toHaveLength(2)
  })

  it('puts the contact’s middle between the two columns it fills', () => {
    const rotated = rotateBlock(separationMatrix(16), { maxSeparation: 6 })
    const row = rowForSeparation(rotated, 4)
    expect(turnedCentre(rotated, row, 10)).toEqual(turnedCentre(rotated, row, 11))
    expect(turnedCentre(rotated, row, 10).col).toBe(11)
  })
})

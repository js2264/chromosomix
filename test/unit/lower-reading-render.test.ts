/**
 * Two readings of one map, one each side of the diagonal, on two scales (§5.10).
 *
 * What is pinned is what is silent when wrong. A pixel astride the diagonal that
 * is pooled over both readings is the brightest of a count and an O/E — a stripe
 * of saturated colour along the diagonal that is a property of nothing. A split
 * that disagrees with the merge by one cell colours the second reading's cell on
 * the first's ramp. And a range measured over the merged block instead of each
 * reading's own square moves the first reading's colours the moment a second is
 * put beside it.
 */

import { describe, expect, it } from 'vitest'

import { blendAcrossDiagonal, diagonalSplit, foldSplit } from '@/render/compare'
import { colorize, joinAcrossDiagonal, poolDisplay, type Raster } from '@/render/heatmap'
import { rotateBlock } from '@/render/rotate'
import type { ColorScale, DenseMatrix } from '@/types'

function block(
  nrows: number,
  ncols: number,
  fill: (row: number, col: number) => number,
  rowExtent: [number, number] = [0, nrows],
  colExtent: [number, number] = [0, ncols],
): DenseMatrix {
  const values = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) values[r * ncols + c] = fill(r, c)
  return { nrows, ncols, values, rowExtent, colExtent }
}

const linear: ColorScale = { vmin: 0, vmax: 10, transform: 'none', colormap: 'Reds' }

describe('diagonalSplit', () => {
  it('is the row index on a square block: the diagonal stays above', () => {
    expect([...diagonalSplit(block(4, 4, () => 0))]).toEqual([0, 1, 2, 3])
  })

  it('agrees with the merge cell for cell, on a block whose axes are other stretches', () => {
    // Rows from bin 10, columns from bin 7: an off-diagonal rectangle that
    // crosses the diagonal part of the way along.
    const a = block(5, 8, () => 1, [10, 15], [7, 15])
    const b = block(5, 8, () => 2, [10, 15], [7, 15])
    const merged = blendAcrossDiagonal(a, b).values
    const split = diagonalSplit(a)
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 8; c++) {
        expect(merged[r * 8 + c] === 2).toBe(c < split[r])
      }
    }
    // Row 0 is bin 10, whose cells below the diagonal are columns of bins 7–9.
    expect(split[0]).toBe(3)
  })

  it('gives nothing to the lower side of a block wholly above the diagonal', () => {
    const above = block(3, 3, () => 0, [0, 3], [10, 13])
    expect([...diagonalSplit(above)]).toEqual([0, 0, 0])
  })

  it('folds a mirrored pair at its second band', () => {
    expect([...foldSplit(4, 5, 2)]).toEqual([0, 0, 5, 5])
  })
})

describe('pooling one side of the diagonal', () => {
  it('leaves the other reading out of a pixel astride the diagonal', () => {
    // Above the diagonal and on it a count of 1, below it an O/E of 9: pooled by
    // 2, the four pixels on the diagonal each hold one cell from below.
    const merged = block(8, 8, (r, c) => (r > c ? 9 : 1))
    const split = diagonalSplit(merged)
    const upper = poolDisplay(merged, linear, { maxDim: 4, keep: { split, lower: false } })
    const lower = poolDisplay(merged, linear, { maxDim: 4, keep: { split, lower: true } })
    expect(upper.strideX).toBe(2)
    for (let i = 0; i < 4; i++) {
      // The diagonal pixel, read for the upper side, is the count — not the 9.
      expect(upper.values[i * 4 + i]).toBe(1)
      // …and read for the lower side it is the one cell of the lower reading in it.
      expect(lower.values[i * 4 + i]).toBe(9)
    }
    // A pixel wholly above the diagonal has nothing of the lower reading in it.
    expect(Number.isNaN(lower.values[0 * 4 + 3])).toBe(true)
    expect(Number.isNaN(upper.values[3 * 4 + 0])).toBe(true)
  })

  it('blanks the other side at a stride of one, so a range read off it is this reading’s', () => {
    const merged = block(3, 3, (r, c) => (r > c ? 9 : 1))
    const split = diagonalSplit(merged)
    const upper = poolDisplay(merged, linear, { keep: { split, lower: false } })
    const lower = poolDisplay(merged, linear, { keep: { split, lower: true } })
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const below = r > c
        expect(Number.isNaN(upper.values[r * 3 + c])).toBe(below)
        expect(Number.isNaN(lower.values[r * 3 + c])).toBe(!below)
      }
    }
  })

  it('pools exactly as before with nothing kept apart', () => {
    const merged = block(8, 8, (r, c) => (r * 8 + c) % 7)
    const plain = poolDisplay(merged, linear, { maxDim: 4 })
    const again = poolDisplay(merged, linear, { maxDim: 4, keep: undefined })
    expect([...again.values]).toEqual([...plain.values])
  })
})

describe('joinAcrossDiagonal', () => {
  function solid(width: number, height: number, word: number, stride = 1): Raster {
    const data = new Uint8ClampedArray(width * height * 4)
    new Uint32Array(data.buffer).fill(word)
    return { width, height, data, scale: linear, strideX: stride, strideY: stride }
  }

  it('takes the lower raster below the diagonal and keeps the diagonal for the upper', () => {
    const top = solid(4, 4, 0x11111111)
    const bottom = solid(4, 4, 0x22222222)
    joinAcrossDiagonal(top, bottom, diagonalSplit(block(4, 4, () => 0)), 4)
    const words = new Uint32Array(top.data.buffer)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) expect(words[r * 4 + c]).toBe(r > c ? 0x22222222 : 0x11111111)
    }
  })

  it('gives a pooled pixel astride the diagonal to the upper side, and the next one down to the lower', () => {
    const top = solid(4, 4, 1, 2)
    const bottom = solid(4, 4, 2, 2)
    joinAcrossDiagonal(top, bottom, diagonalSplit(block(8, 8, () => 0)), 8)
    const words = new Uint32Array(top.data.buffer)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) expect(words[r * 4 + c]).toBe(r > c ? 2 : 1)
    }
  })

  it('colours each side on its own ramp end to end', () => {
    const merged = block(3, 3, (r, c) => (r > c ? 1 : 0))
    const split = diagonalSplit(merged)
    const upperScale: ColorScale = { vmin: 0, vmax: 1, transform: 'none', colormap: 'Reds' }
    // The lower reading's 1 is the *bottom* of its own clip, so it is drawn as
    // that ramp's low end, though on the upper scale it would be the top.
    const lowerScale: ColorScale = { vmin: 1, vmax: 2, transform: 'none', colormap: 'Reds' }
    const top = colorize(poolDisplay(merged, upperScale, { keep: { split, lower: false } }), upperScale)
    const bottom = colorize(poolDisplay(merged, lowerScale, { keep: { split, lower: true } }), lowerScale)
    const lowEnd = colorize(poolDisplay(block(1, 1, () => 0), upperScale), upperScale)
    joinAcrossDiagonal(top, bottom, split, 3)
    const words = new Uint32Array(top.data.buffer)
    const low = new Uint32Array(lowEnd.data.buffer)[0]
    // Every cell, above and below, sits at the low end of its own ramp.
    for (let i = 0; i < 9; i++) expect(words[i]).toBe(low)
  })
})

describe('a mirrored band read from a second square', () => {
  it('draws its own diagonal in the second band', () => {
    const first = block(3, 3, () => 1)
    const second = new Float32Array(9).fill(2)
    const turned = rotateBlock(first, { maxSeparation: 2, mirror: true, below: second })
    const fold = turned.fold as number
    for (let row = 0; row < turned.nrows; row++) {
      for (let col = 0; col < turned.ncols; col++) {
        const value = turned.values[row * turned.ncols + col]
        if (Number.isNaN(value)) continue
        expect(value).toBe(row >= fold ? 2 : 1)
      }
    }
  })

  it('reads the block itself without one, as the two-file split always has', () => {
    const merged = block(3, 3, (r, c) => (r > c ? 2 : 1))
    const turned = rotateBlock(merged, { maxSeparation: 2, mirror: true })
    const fold = turned.fold as number
    // The second band's diagonal row is the first file's: the merge gave it away.
    const diagonal = turned.values.subarray(fold * turned.ncols, (fold + 1) * turned.ncols)
    expect([...diagonal].filter((v) => !Number.isNaN(v)).every((v) => v === 1)).toBe(true)
  })
})

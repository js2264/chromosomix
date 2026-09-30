/**
 * When a sideways scroll slides a map along its diagonal (SPECS §7): wherever
 * the diagonal is in the picture — its rows and columns share a stretch of
 * bins — and the block is square; not over a turned band, whose diagonal runs
 * across the screen already, nor over two stretches that share none.
 */

import { describe, expect, it } from 'vitest'

import type { RotatedBlock } from '@/render/rotate'
import { slidesAlongDiagonal } from '@/ui/MatrixPanel'

describe('a sideways scroll along the diagonal', () => {
  it('slides along it where the rows and columns share bins', () => {
    expect(slidesAlongDiagonal({ rowExtent: [0, 500], colExtent: [0, 500] }, null)).toBe(true)
    // A cis window panned off the diagonal, still crossing it.
    expect(slidesAlongDiagonal({ rowExtent: [100, 300], colExtent: [250, 450] }, null)).toBe(true)
  })

  it('slides the columns alone over a block of two stretches that share none, and over a turned band', () => {
    expect(slidesAlongDiagonal({ rowExtent: [0, 100], colExtent: [400, 600] }, null)).toBe(false)
    expect(slidesAlongDiagonal({ rowExtent: [0, 500], colExtent: [0, 500] }, {} as RotatedBlock)).toBe(false)
  })
})

/**
 * How many cells a picture is worth reading at.
 *
 * `POOLED_CELL_CAP` is the raster's ceiling and was, until this, the only
 * answer: every block was read at 4,096 cells per axis whatever it was going to
 * be drawn in. On a 650 px plot that is six cells behind every pixel, and the
 * five nobody sees are paid for three times — in the accumulator, whose output
 * array stops fitting in cache; in `poolDisplay`; and in `colorize`, the last
 * two on the main thread.
 *
 * The rules worth pinning are the three that make it safe to lower: it never
 * exceeds the raster's ceiling, it never collapses to nothing, and it leaves
 * one doubling of zoom headroom in the block so that a zoom inside a rung costs
 * no read at all.
 */

import { describe, expect, it } from 'vitest'

import { RASTER_MAX_DIM, displayCellCap, firstReadCellCap } from '@/render/heatmap'
import { POOLED_CELL_CAP } from '@/metacooler/pooling'
import { REFINE_FACTOR, REFINE_REACH, gridFor } from '@/ui/refine'

describe('the cap a picture asks for', () => {
  it('is two cells per device pixel — one doubling of zoom in hand', () => {
    // The factor is `REFINE_FACTOR`, and that is not a coincidence: the ladder
    // leaves a block alone until its grid is off by that much, so a block with
    // exactly one spare doubling in it is a block a reader can zoom into once
    // without waiting for anything.
    expect(displayCellCap(800, 1)).toBe(1600)
    expect(displayCellCap(800, 2)).toBe(3200)
    expect(displayCellCap(400, 1) * REFINE_FACTOR).toBe(displayCellCap(800, 1))
  })

  it('never asks for more than the raster can draw', () => {
    // Past the ceiling the block would be pooled a second time on the way to
    // the screen — flat and contig-blind, which is the straddling the read goes
    // to the trouble of avoiding.
    expect(displayCellCap(4000, 2)).toBe(RASTER_MAX_DIM)
    expect(displayCellCap(100_000, 1)).toBe(RASTER_MAX_DIM)
    expect(POOLED_CELL_CAP).toBe(RASTER_MAX_DIM)
  })

  it('has a floor, because a cell of a deck is still a map', () => {
    expect(displayCellCap(10, 1)).toBe(512)
    expect(displayCellCap(0, 1)).toBe(512)
    expect(displayCellCap(-5, 1)).toBe(512)
  })

  it('treats a nonsense device ratio as one rather than as a divisor', () => {
    expect(displayCellCap(800, 0)).toBe(displayCellCap(800, 1))
    expect(displayCellCap(800, -2)).toBe(displayCellCap(800, 1))
  })

  it('answers before there is a plot to measure, and stays inside the ceiling', () => {
    // A view reads and *then* draws, so its first block — the one that walks
    // every stored pixel — is planned when the panel has no size. Node has no
    // `innerWidth`, which is the branch this exercises.
    const first = firstReadCellCap()
    expect(first).toBeGreaterThanOrEqual(512)
    expect(first).toBeLessThanOrEqual(RASTER_MAX_DIM)
  })
})

describe('the cap and the ladder agree', () => {
  it('leaves a freshly read block satisfied, and one doubling later not', () => {
    // The loop this rules out: a read that comes back already too coarse for
    // the window it was made for would be re-read on the very next frame, for
    // ever. The read is planned for the window *padded* (`REFINE_REACH`), so
    // that is the span the grid has to be judged on.
    const cap = displayCellCap(650, 1)
    const span = 40_000
    const read = gridFor([0, span * REFINE_REACH], [0, span * REFINE_REACH], cap)
    expect(read * REFINE_FACTOR).toBeGreaterThanOrEqual(read)
    // Half the window, so twice the resolution is now wanted: the block that
    // answered the wider one is exactly at the edge of being replaced.
    const closer = gridFor([0, (span / 2) * REFINE_REACH], [0, (span / 2) * REFINE_REACH], cap)
    expect(read).toBeGreaterThan(closer)
    expect(read).toBeLessThanOrEqual(closer * REFINE_FACTOR)
  })

  it('reads coarser for a smaller picture, which is the whole point', () => {
    const span = 40_000
    const wide = gridFor([0, span], [0, span], displayCellCap(1600, 1))
    const small = gridFor([0, span], [0, span], displayCellCap(400, 1))
    expect(small).toBeGreaterThan(wide)
  })
})

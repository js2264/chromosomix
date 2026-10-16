/**
 * A map read at a resolution the reader added (SPECS §3.4, §18.4): the stored
 * rung's bins summed, behind the seams an ordinary map is read through, so that
 * a task handed it measures the map at that resolution.
 *
 * Held to the file rather than to the code: an `.mcool` written by `cooler
 * zoomify` stores coarser rungs that are its finest one's counts summed on the
 * same grid, so the finest rung coarsened here must read, window for window and
 * pixel for pixel, as the rung the file stores — on the diagonal, off it,
 * between two sequences, and in a pass over every pixel.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CoarseGrid, offsetsOf } from '../../src/metacooler/coarsen'
import { coarseColumn } from '../../src/metacooler/coarseMap'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import type { Extent } from '../../src/types'

const MCOOL = new URL('../../demo/yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool', import.meta.url).pathname
const ECOLI = new URL('../../demo/ecoli/Ecoli.mcool', import.meta.url).pathname

describe('the grid of a resolution the reader added', () => {
  // Three sequences of 5, 0 and 7 bins, three to a coarse bin.
  const grid = CoarseGrid.of([0, 5, 5, 12], 3)

  it('starts every sequence afresh and keeps what is left at its end', () => {
    expect([...grid.chromOffset]).toEqual([0, 2, 2, 5])
    expect(grid.nBins).toBe(5)
    expect(grid.fineBins).toBe(12)
    expect([...grid.coarseIndex()]).toEqual([0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 4])
  })

  it('carries a bin both ways, past the end included', () => {
    expect(grid.coarseBin(4)).toBe(1)
    expect(grid.coarseBin(5)).toBe(2)
    expect(grid.coarseBin(11)).toBe(4)
    expect(grid.coarseBin(12)).toBe(5)
    expect(grid.fineBin(2)).toBe(5)
    expect(grid.fineBin(4)).toBe(11)
    expect(grid.fineBin(5)).toBe(12)
  })

  it('reads a coarse extent from its fine bins, and covers a fine one with the fewest', () => {
    expect(grid.toFine([1, 3])).toEqual([3, 8])
    expect(grid.toCoarse([4, 9])).toEqual([1, 4])
    expect(grid.toCoarse([3, 3])).toEqual([1, 1])
    expect(grid.toCoarse([0, 12])).toEqual([0, 5])
  })

  it('is the grid a cooler lays a sequence table out on, one bin size up', () => {
    const lengths = [10_500, 0, 7_000]
    expect([...CoarseGrid.of(offsetsOf(lengths, 1000), 3).chromOffset]).toEqual([...offsetsOf(lengths, 3000)])
  })
})

describe('the bin columns at the coarse bins', () => {
  const grid = CoarseGrid.of([0, 4], 2)

  it('weights a bin by the harmonic mean of the weights the balancer kept', () => {
    const coarse = coarseColumn('weight', [1, 0.25, Number.NaN, Number.NaN], grid)
    expect(coarse[0]).toBeCloseTo(2 / (1 + 4), 12)
    // None kept: dropped, as a fine bin is.
    expect(coarse[1]).toBeNaN()
  })

  it('starts where its first bin starts, ends where its last ends, and averages the rest', () => {
    expect([...coarseColumn('start', [0, 10, 20, 30], grid)]).toEqual([0, 20])
    expect([...coarseColumn('end', [10, 20, 30, 35], grid)]).toEqual([20, 35])
    expect([...coarseColumn('GC', [0.4, 0.6, 0.5, Number.NaN], grid)]).toEqual([0.5, 0.5])
  })
})

const suite = existsSync(MCOOL) ? describe : describe.skip

async function rung(path: string, binsize: number): Promise<MetaCooler> {
  const uri = `${path}::resolutions/${binsize}`
  return MetaCooler.open(uri, await LocalFileSource.open(path))
}

/** Every stored pixel of a map, summed by cell — the pixels, whatever order they came in. */
async function cells(mc: MetaCooler): Promise<{ map: Map<number, number>; chunks: number; pixels: number }> {
  const map = new Map<number, number>()
  let chunks = 0
  let pixels = 0
  await mc.scanPixels({
    onChunk: (chunk) => {
      chunks++
      for (let i = 0; i < chunk.length; i++) {
        pixels++
        const key = chunk.bin1[i] * mc.nBins + chunk.bin2[i]
        map.set(key, (map.get(key) ?? 0) + chunk.count[i])
      }
    },
  })
  return { map, chunks, pixels }
}

suite('the finest rung summed, against the rung the file stores', () => {
  it('has the stored rung’s bins: its sequences’ offsets, starts and ends', async () => {
    const fine = await rung(MCOOL, 1000)
    const stored = await rung(MCOOL, 4000)
    try {
      const { map, refusal } = MetaCooler.coarsened(fine, 4)
      expect(refusal).toBeNull()
      expect(map.binsize).toBe(4000)
      expect(map.nBins).toBe(stored.nBins)
      expect(map.chromnames).toEqual(stored.chromnames)
      for (let cid = 0; cid < stored.nContigs; cid++) expect(map.contigExtent(cid)).toEqual(stored.contigExtent(cid))
      expect([...(map.binColumn('start', 0, map.nBins) as Float64Array)]).toEqual([
        ...(stored.binColumn('start', 0, stored.nBins) as Float64Array),
      ])
      expect([...(map.binColumn('end', 0, map.nBins) as Float64Array)]).toEqual([
        ...(stored.binColumn('end', 0, stored.nBins) as Float64Array),
      ])
    } finally {
      fine.close()
      stored.close()
    }
  })

  it('reads every window as the stored rung does: on the diagonal, off it, and between two sequences', async () => {
    const fine = await rung(MCOOL, 1000)
    const stored = await rung(MCOOL, 2000)
    try {
      const { map } = MetaCooler.coarsened(fine, 2)
      const [a0, a1] = stored.contigExtent(0)
      const [b0, b1] = stored.contigExtent(stored.nContigs - 1)
      const windows: Array<[Extent, Extent]> = [
        [[a0, a1], [a0, a1]],
        [[a0 + 3, a0 + 40], [a0 + 20, a0 + 90]],
        // Below the diagonal: read transposed.
        [[a0 + 60, a0 + 90], [a0 + 5, a0 + 30]],
        [[a0, a0 + 50], [b0, Math.min(b1, b0 + 50)]],
      ]
      for (const [rows, cols] of windows) {
        const got = await map.matrix({ rows, cols, balance: false })
        const want = await stored.matrix({ rows, cols, balance: false })
        expect(got.nrows).toBe(want.nrows)
        expect(got.ncols).toBe(want.ncols)
        expect([...got.values]).toEqual([...want.values])
      }
    } finally {
      fine.close()
      stored.close()
    }
  })

  it('hands every coarse pixel over once, summed, in a pass over the whole map', async () => {
    const fine = await rung(MCOOL, 1000)
    const stored = await rung(MCOOL, 4000)
    try {
      const { map } = MetaCooler.coarsened(fine, 4)
      const got = await cells(map)
      const want = await cells(stored)
      // Once each: a cooler's rows arrive in order, so no row is summed twice.
      expect(got.pixels).toBe(stored.nnz)
      expect(got.map).toEqual(want.map)
    } finally {
      fine.close()
      stored.close()
    }
  })

  it('balances a coarse bin by its fine bins’ weights, kept ones only', async () => {
    const fine = await rung(MCOOL, 1000)
    try {
      const { map } = MetaCooler.coarsened(fine, 4)
      const weights = fine.binColumn('weight', 0, fine.nBins) as Float64Array
      const coarse = map.binColumn('weight', 0, map.nBins) as Float64Array
      const [lo] = fine.contigExtent(0)
      const kept = [...weights.slice(lo, lo + 4)].filter((w) => Number.isFinite(w) && w > 0)
      const expected = kept.length === 0 ? Number.NaN : kept.length / kept.reduce((sum, w) => sum + 1 / w, 0)
      expect(coarse[map.contigExtent(0)[0]]).toBeCloseTo(expected, 12)
      // And a balanced read multiplies by exactly those.
      const extent: Extent = [0, 40]
      const raw = await map.matrix({ rows: extent, balance: false })
      const balanced = await map.matrix({ rows: extent, balance: true })
      const i = 10
      const j = 12
      const value = raw.values[i * raw.ncols + j] * coarse[i] * coarse[j]
      if (Number.isFinite(value)) expect(balanced.values[i * raw.ncols + j]).toBeCloseTo(value, 4)
    } finally {
      fine.close()
    }
  })

  it('reaches a factor that is not a power of two: 1 kb summed five at a time is the stored 5 kb', async () => {
    if (!existsSync(ECOLI)) return
    const fine = await rung(ECOLI, 1000)
    const stored = await rung(ECOLI, 5000)
    try {
      const { map } = MetaCooler.coarsened(fine, 5)
      expect(map.nBins).toBe(stored.nBins)
      const rows: Extent = [100, 180]
      const cols: Extent = [140, 260]
      const got = await map.matrix({ rows, cols, balance: false })
      const want = await stored.matrix({ rows, cols, balance: false })
      expect([...got.values]).toEqual([...want.values])
    } finally {
      fine.close()
      stored.close()
    }
  })

  it('is the map itself at a factor of one, and refuses what is not a whole number of bins', async () => {
    const fine = await rung(MCOOL, 1000)
    try {
      expect(MetaCooler.coarsened(fine, 1).map).toBe(fine)
      expect(MetaCooler.coarsened(fine, 2.5).refusal).toMatch(/whole number/)
    } finally {
      fine.close()
    }
  })
})

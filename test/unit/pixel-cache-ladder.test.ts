/**
 * The ladder, over a real file, paid for once.
 *
 * `pixel-cache.test.ts` holds the cache's own arithmetic; this holds the thing
 * it was built for. A zoom that changes resolution re-reads the same window at
 * a finer grid, and before this the whole of that cost was HDF5 turning the
 * same compressed chunks back into the same numbers — measured on this file at
 * 2,026 ms of a 2,930 ms whole-genome read, and paid again on every rung.
 *
 * Two claims, and the second is the one that could go silently wrong:
 *
 * - **one inflation serves the staircase.** The ladder reads nested row bands,
 *   and nested bands are nested pixel ranges, so the widest read populates
 *   every read after it — including the way back out.
 * - **a replayed block is the block the file holds.** A cache that is fast and
 *   subtly wrong is worse than no cache, so the same window is read twice,
 *   once served and once from cold, and compared cell for cell.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { pixelCacheStats, resetPixelCache } from '@/metacooler/pixelCache'
import { LocalFileSource } from '@/sources/LocalFileSource'
import type { Extent } from '@/types'

const FILE = decodeURIComponent(
  new URL('../../demo/yeast/Yeast_microC_G2M_1kb.cool', import.meta.url).pathname,
)

const suite = existsSync(FILE) ? describe : describe.skip

async function open(): Promise<MetaCooler> {
  return MetaCooler.open(FILE, await LocalFileSource.open(FILE))
}

/** A pooled block, planned the way a view of this width would plan one. */
async function read(mc: MetaCooler, rows: Extent, cap = 4096) {
  const k = Math.max(1, Math.ceil((rows[1] - rows[0]) / cap))
  return mc.pooledMatrix({ rows, cols: rows }, { binsPerCell: k, contigsPerCell: 1 }, { cellCap: cap })
}

suite('a zoom down a real file', () => {
  it('inflates the pixels once and serves every rung from them', async () => {
    resetPixelCache()
    const mc = await open()
    try {
      const n = mc.nBins
      // Fit, in, in, in, and back out — the staircase §2 describes, both ways.
      const walk: Extent[] = [
        [0, n],
        [0, Math.round(n / 2)],
        [Math.round(n * 0.25), Math.round(n * 0.5)],
        [Math.round(n * 0.25), Math.round(n * 0.375)],
        [0, Math.round(n / 2)],
        [0, n],
      ]
      for (const rows of walk) await read(mc, rows)
      const stats = pixelCacheStats()
      expect(stats.misses, 'the first read, and nothing after it').toBe(1)
      expect(stats.hits).toBe(walk.length - 1)
      expect(stats.runs, 'one run: the nested bands are all inside the widest').toBe(1)
    } finally {
      mc.close()
    }
  }, 300_000)

  it('gives back the numbers the file holds, cell for cell', async () => {
    const window: Extent = [3000, 6000]
    resetPixelCache()
    const warm = await open()
    let served: Float64Array
    let cold: Float64Array
    try {
      // The whole file first, so the narrower window below is answered from the
      // cache rather than from HDF5.
      await read(warm, [0, warm.nBins])
      expect(pixelCacheStats().misses).toBe(1)
      served = (await read(warm, window)).values as Float64Array
      expect(pixelCacheStats().misses, 'served, not read').toBe(1)
    } finally {
      warm.close()
    }

    // …and the same window with nothing held, which is the read this replaces.
    resetPixelCache()
    const fresh = await open()
    try {
      cold = (await read(fresh, window)).values as Float64Array
      expect(pixelCacheStats().hits).toBe(0)
    } finally {
      fresh.close()
    }

    expect(served.length).toBe(cold.length)
    let differing = 0
    for (let i = 0; i < served.length; i++) if (served[i] !== cold[i]) differing++
    expect(differing, 'a fast cache that is subtly wrong is worse than none').toBe(0)
  }, 300_000)

  it('lets the pixels go when the file is closed', async () => {
    resetPixelCache()
    const mc = await open()
    await read(mc, [0, mc.nBins])
    expect(pixelCacheStats().bytes).toBeGreaterThan(0)
    mc.close()
    expect(pixelCacheStats().bytes, 'the one invalidation there is').toBe(0)
  }, 300_000)

  it('reads a coarser block for a smaller picture, and the same pixels answer both', async () => {
    resetPixelCache()
    const mc = await open()
    try {
      const whole: Extent = [0, mc.nBins]
      const big = await read(mc, whole, 4096)
      const small = await read(mc, whole, 512)
      expect(small.nrows, 'a smaller cap is a coarser grid').toBeLessThan(big.nrows)
      expect(small.binsPerCell).toBeGreaterThan(big.binsPerCell)
      expect(pixelCacheStats().misses, 'and the second picture costs no read').toBe(1)
    } finally {
      mc.close()
    }
  }, 300_000)
})

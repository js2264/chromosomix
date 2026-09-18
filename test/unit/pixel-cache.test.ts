/**
 * The pixels, kept after they have been inflated.
 *
 * `metacooler/pixelCache.ts` is a cache in front of the one operation that
 * dominates every read in this application, so the properties worth pinning are
 * the two a cache can get wrong — *it answers with the numbers the file holds*
 * and *it lets go of them* — plus the two this one exists for: a nested window
 * is a hit, and a span read to the end is what gets kept.
 *
 * Driven through a fake handle rather than through a cooler, because what is
 * being asserted is the cache's own arithmetic; `test/unit/pooled-equivalence`
 * and the golden battery are what hold the read itself to the file.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  BYTES_PER_PIXEL,
  keepPixels,
  pixelCacheStats,
  releasePixels,
  replayPixels,
  resetPixelCache,
} from '@/metacooler/pixelCache'
import type { Hdf5Handle } from '@/h5/api'
import type { PixelChunk } from '@/types'

/** Two distinct objects to key by; nothing is read off them. */
const A = { uri: 'a' } as unknown as Hdf5Handle
const B = { uri: 'b' } as unknown as Hdf5Handle

/** A window of `n` pixels whose ids and counts say where they came from. */
function window(from: number, n: number): PixelChunk {
  const bin1 = new Int32Array(n)
  const bin2 = new Int32Array(n)
  const count = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    bin1[i] = from + i
    bin2[i] = (from + i) * 2
    count[i] = (from + i) * 10
  }
  return { bin1, bin2, count, length: n }
}

/** Everything a replay hands back, flattened. */
function replay(handle: Hdf5Handle, from: number, to: number): number[] | null {
  const out: number[] = []
  const served = replayPixels(handle, 'count', from, to, (chunk) => {
    for (let i = 0; i < chunk.length; i++) out.push(chunk.bin1[i])
  })
  return served ? out : null
}

beforeEach(() => {
  resetPixelCache()
})

describe('what the cache answers with', () => {
  it('replays exactly the pixels that were kept', () => {
    keepPixels(A, 'count', 100, [window(100, 4), window(104, 4)])
    expect(replay(A, 100, 108)).toEqual([100, 101, 102, 103, 104, 105, 106, 107])
  })

  it('carries all three columns, not just the ids it is keyed by', () => {
    keepPixels(A, 'count', 0, [window(0, 3)])
    const seen: Array<[number, number, number]> = []
    replayPixels(A, 'count', 0, 3, (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        seen.push([chunk.bin1[i], chunk.bin2[i], chunk.count[i]])
      }
    })
    expect(seen).toEqual([
      [0, 0, 0],
      [1, 2, 10],
      [2, 4, 20],
    ])
  })

  it('serves a window **inside** a run, clipped at both ends', () => {
    // The whole point: a ladder reads nested row bands, so the first read is
    // what every read after it is served from.
    keepPixels(A, 'count', 0, [window(0, 10)])
    expect(replay(A, 3, 7)).toEqual([3, 4, 5, 6])
  })

  it('clips across a part boundary, which is where an off-by-one would live', () => {
    keepPixels(A, 'count', 0, [window(0, 4), window(4, 4), window(8, 4)])
    expect(replay(A, 2, 10)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('hands out windows no larger than the ones it was given', () => {
    keepPixels(A, 'count', 0, [window(0, 4), window(4, 4)])
    const sizes: number[] = []
    replayPixels(A, 'count', 0, 8, (chunk) => sizes.push(chunk.length))
    expect(sizes).toEqual([4, 4])
  })
})

describe('what the cache refuses', () => {
  it('misses a window it does not hold whole', () => {
    keepPixels(A, 'count', 0, [window(0, 10)])
    expect(replay(A, 5, 15), 'past the end of the run').toBeNull()
    expect(replay(A, -1, 5), 'before the start of it').toBeNull()
  })

  it('misses another handle, and another value column', () => {
    keepPixels(A, 'count', 0, [window(0, 10)])
    expect(replay(B, 0, 10)).toBeNull()
    expect(
      replayPixels(A, 'expected', 0, 10, () => {}),
      'a different `/pixels` column is different data',
    ).toBe(false)
  })

  it('keeps nothing for an empty span', () => {
    keepPixels(A, 'count', 0, [])
    expect(pixelCacheStats().runs).toBe(0)
  })

  it('refuses a span larger than the whole budget rather than evicting for it', () => {
    keepPixels(A, 'count', 0, [window(0, 100)], BYTES_PER_PIXEL * 10)
    expect(pixelCacheStats().runs, 'read and forgotten, as before this file existed').toBe(0)
  })
})

describe('what it lets go of', () => {
  it('drops the least recently used run when the budget is passed', () => {
    const budget = BYTES_PER_PIXEL * 25
    keepPixels(A, 'count', 0, [window(0, 10)], budget)
    keepPixels(A, 'count', 100, [window(100, 10)], budget)
    // Touch the first, so the second is the one that has waited longest.
    expect(replay(A, 0, 10)).not.toBeNull()
    keepPixels(A, 'count', 200, [window(200, 10)], budget)

    expect(replay(A, 0, 10), 'the one that was wanted most recently').not.toBeNull()
    expect(replay(A, 100, 110), 'the one that was not').toBeNull()
  })

  it('replaces a run a wider one now covers, rather than holding both', () => {
    keepPixels(A, 'count', 10, [window(10, 5)])
    expect(pixelCacheStats().runs).toBe(1)
    keepPixels(A, 'count', 0, [window(0, 40)])
    expect(pixelCacheStats().runs, 'the narrow one is the same bytes twice').toBe(1)
    expect(replay(A, 10, 15)).toEqual([10, 11, 12, 13, 14])
  })

  it('forgets everything read through a handle when it closes', () => {
    keepPixels(A, 'count', 0, [window(0, 10)])
    keepPixels(B, 'count', 0, [window(0, 10)])
    releasePixels(A)
    expect(replay(A, 0, 10)).toBeNull()
    expect(replay(B, 0, 10), 'and nothing else').not.toBeNull()
    expect(pixelCacheStats().bytes).toBe(BYTES_PER_PIXEL * 10)
    releasePixels(B)
    expect(pixelCacheStats().bytes, 'and the accounting goes with them').toBe(0)
  })
})

describe('the parts of it a caller can see', () => {
  it('stops a replay the caller calls off', () => {
    keepPixels(A, 'count', 0, [window(0, 4), window(4, 4), window(8, 4)])
    const seen: number[] = []
    let calls = 0
    replayPixels(
      A,
      'count',
      0,
      12,
      (chunk) => seen.push(chunk.length),
      () => ++calls <= 1,
    )
    expect(seen, 'one window, then the cancel').toEqual([4])
  })

  it('counts hits and misses, which is what a budget test reads', () => {
    keepPixels(A, 'count', 0, [window(0, 10)])
    replay(A, 0, 10)
    replay(A, 2, 5)
    replay(A, 50, 60)
    expect(pixelCacheStats()).toMatchObject({ hits: 2, misses: 1 })
  })
})

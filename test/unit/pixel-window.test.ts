/**
 * The windowed pixel read.
 *
 * `readPixelSpan` used to pull a block's whole row band into memory in three
 * calls, which for a whole-genome selection is the whole file: 32 B per stored
 * pixel live at once on the JS heap, and each column staged whole inside
 * h5wasm's 2 GiB linear memory, where a span past ~2.7e8 pixels simply fails.
 * Windowing is what makes the cost a constant instead, and these are the
 * properties that has to keep: the same pixels, in order, and no window larger
 * than asked for.
 *
 * Driven through a fake handle rather than a fixture, so it runs on a fresh
 * clone with no Python.
 */

import { describe, expect, it } from 'vitest'

import type { Hdf5Handle } from '@/h5/api'
import {
  forEachPixelSpan,
  planRead,
  readPixelSpan,
  scatterDense,
  spanPixelCount,
} from '@/metacooler/matrix'
import type { PixelChunk } from '@/types'

interface Pixel {
  bin1: number
  bin2: number
  count: number
}

/**
 * A handle over an in-memory pixel table, counting the reads it serves.
 *
 * The pixels must be sorted by `bin1` for `bin1_offset` to describe them, which
 * is the file format's own invariant.
 */
function fakeHandle(
  nBins: number,
  pixels: Pixel[],
): { handle: Hdf5Handle; reads: { path: string; lo: number; hi: number }[] } {
  const offsets = new Float64Array(nBins + 1)
  for (const p of pixels) offsets[p.bin1 + 1]++
  for (let i = 1; i <= nBins; i++) offsets[i] += offsets[i - 1]
  const reads: { path: string; lo: number; hi: number }[] = []

  const column = (path: string): ArrayLike<number> => {
    switch (path) {
      case 'indexes/bin1_offset':
        return offsets
      case 'pixels/bin1_id':
        return pixels.map((p) => p.bin1)
      case 'pixels/bin2_id':
        return pixels.map((p) => p.bin2)
      case 'pixels/count':
        return pixels.map((p) => p.count)
      default:
        throw new Error(`unexpected read of ${path}`)
    }
  }
  const slice = (path: string, lo?: number, hi?: number): number[] => {
    const all = column(path)
    const start = lo ?? 0
    const stop = hi ?? all.length
    reads.push({ path, lo: start, hi: stop })
    const out: number[] = []
    for (let i = start; i < stop; i++) out.push(all[i])
    return out
  }
  const handle = {
    readNumeric: (path: string, lo?: number, hi?: number) => Float64Array.from(slice(path, lo, hi)),
    readInt32: (path: string, lo?: number, hi?: number) => Int32Array.from(slice(path, lo, hi)),
  } as unknown as Hdf5Handle
  return { handle, reads }
}

/** A sorted pixel table with a known total, deterministic. */
function table(nBins: number, per: number): Pixel[] {
  const out: Pixel[] = []
  for (let b = 0; b < nBins; b++) {
    for (let k = 0; k < per; k++) {
      out.push({ bin1: b, bin2: Math.min(nBins - 1, b + k), count: b * 10 + k + 1 })
    }
  }
  return out
}

describe('forEachPixelSpan', () => {
  it('delivers every pixel of the span exactly once, in file order', () => {
    const pixels = table(20, 3)
    const { handle } = fakeHandle(20, pixels)
    const seen: Pixel[] = []
    forEachPixelSpan(handle, 4, 12, (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        seen.push({ bin1: chunk.bin1[i], bin2: chunk.bin2[i], count: chunk.count[i] })
      }
    }, 5)
    expect(seen).toEqual(pixels.filter((p) => p.bin1 >= 4 && p.bin1 < 12))
  })

  it('never hands out a window wider than the chunk size', () => {
    const { handle } = fakeHandle(20, table(20, 3))
    const widths: number[] = []
    forEachPixelSpan(handle, 0, 20, (chunk) => void widths.push(chunk.length), 7)
    expect(widths.length).toBeGreaterThan(1)
    for (const w of widths) expect(w).toBeLessThanOrEqual(7)
    expect(widths.reduce((a, b) => a + b, 0)).toBe(60)
  })

  it('reads one index slice and then only pixel columns', () => {
    const { handle, reads } = fakeHandle(20, table(20, 3))
    forEachPixelSpan(handle, 0, 20, () => {}, 1000)
    expect(reads.filter((r) => r.path === 'indexes/bin1_offset')).toHaveLength(1)
    // bin2_id and the value: each pixel's row is the index's own answer
    // (`RowIndex`), so bin1_id is never read, as cooler's range query never reads it.
    expect(reads.filter((r) => r.path.startsWith('pixels/')).map((r) => r.path)).toEqual([
      'pixels/bin2_id',
      'pixels/count',
    ])
    // And never `/bins` — the §3.3 rule, which windowing must not have broken.
    expect(reads.some((r) => r.path.startsWith('bins/'))).toBe(false)
  })

  it('reads nothing at all for an empty span', () => {
    const { handle, reads } = fakeHandle(20, table(20, 3))
    forEachPixelSpan(handle, 5, 5, () => expect.unreachable(), 4)
    expect(reads).toHaveLength(0)
  })

  it('reads the index but no pixels when the span holds none', () => {
    const { handle, reads } = fakeHandle(20, [{ bin1: 0, bin2: 1, count: 1 }])
    forEachPixelSpan(handle, 5, 10, () => expect.unreachable(), 4)
    expect(reads.every((r) => r.path === 'indexes/bin1_offset')).toBe(true)
  })
})

describe('readPixelSpan still answers in one piece', () => {
  it('joins the windows back into a single chunk, whatever the chunking', () => {
    const pixels = table(16, 4)
    const { handle } = fakeHandle(16, pixels)
    const whole = readPixelSpan(handle, 2, 14)
    const expected = pixels.filter((p) => p.bin1 >= 2 && p.bin1 < 14)
    expect(whole.length).toBe(expected.length)
    expect(Array.from(whole.bin1)).toEqual(expected.map((p) => p.bin1))
    expect(Array.from(whole.bin2)).toEqual(expected.map((p) => p.bin2))
    expect(Array.from(whole.count)).toEqual(expected.map((p) => p.count))
  })

  it('is empty for an empty span', () => {
    const { handle } = fakeHandle(16, table(16, 2))
    expect(readPixelSpan(handle, 3, 3).length).toBe(0)
  })
})

describe('scattering a windowed span equals scattering it whole', () => {
  it('agrees cell for cell, at every chunk size', () => {
    const nBins = 24
    const pixels = table(nBins, 3)
    const { handle } = fakeHandle(nBins, pixels)
    const rows: [number, number] = [0, nBins]
    const cols: [number, number] = [0, nBins]
    const plan = planRead(rows, cols, 'symmetric-upper')

    const reference = new Float32Array(nBins * nBins)
    scatterDense(readPixelSpan(handle, plan.span[0], plan.span[1]), rows, cols, plan, reference)

    for (const chunkSize of [1, 2, 7, 1000]) {
      const values = new Float32Array(nBins * nBins)
      forEachPixelSpan(
        handle,
        plan.span[0],
        plan.span[1],
        (chunk: PixelChunk) => scatterDense(chunk, rows, cols, plan, values),
        chunkSize,
      )
      expect(Array.from(values)).toEqual(Array.from(reference))
    }
  })
})

describe('spanPixelCount', () => {
  it('is the number of stored pixels in the row band, from two index reads', () => {
    const { handle, reads } = fakeHandle(20, table(20, 3))
    expect(spanPixelCount(handle, 0, 20)).toBe(60)
    expect(spanPixelCount(handle, 4, 12)).toBe(24)
    expect(spanPixelCount(handle, 7, 7)).toBe(0)
    // Two one-element reads per non-empty query, and no pixel column touched.
    expect(reads.every((r) => r.path === 'indexes/bin1_offset')).toBe(true)
    expect(reads.every((r) => r.hi - r.lo === 1)).toBe(true)
  })
})

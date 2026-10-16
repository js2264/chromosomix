/**
 * Each stored pixel's row, answered from the index; and the rows a block's read
 * is cut to.
 *
 * `RowIndex` answers what `pixels/bin1_id` stores from `indexes/bin1_offset`,
 * which on a valid cooler is the same numbers — cooler's own range query reads
 * the column no more than this does. These hold it to the stored column over
 * every shape of index there is: empty rows at the start, in the middle and at
 * the end, windows that start inside a row, and walks that jump.
 *
 * `planRead`'s overlapping span now ends at the lower of the two ends rather
 * than the higher; these hold every rectangle's scatter to the one made from
 * the whole table, which is the claim that no row past it could have
 * contributed.
 *
 * Driven through fake handles, so they run on a fresh clone with no Python.
 */

import { describe, expect, it } from 'vitest'

import type { Hdf5Handle } from '@/h5/api'
import {
  RowIndex,
  forEachPixelRangesAsync,
  forEachPixelSpanAsync,
  planRead,
  readPixelWindow,
  scatterDense,
} from '@/metacooler/matrix'
import { CoolerStore } from '@/metacooler/store'
import type { Extent, PixelChunk } from '@/types'

interface Pixel {
  bin1: number
  bin2: number
  count: number
}

/** A seeded generator, so a failure names a table that can be rebuilt. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/**
 * An upper-triangular pixel table, sorted by `(bin1, bin2)`, with rows of very
 * different lengths and a share of them empty — the first and last always.
 */
function table(nBins: number, seed: number): Pixel[] {
  const rng = random(seed)
  const out: Pixel[] = []
  for (let b = 1; b < nBins - 1; b++) {
    if (rng() < 0.25) continue
    const width = Math.floor(rng() * 9)
    const columns = new Set<number>()
    for (let k = 0; k < width; k++) columns.add(b + Math.floor(rng() * (nBins - b)))
    for (const c of [...columns].sort((x, y) => x - y)) out.push({ bin1: b, bin2: c, count: 1 + Math.floor(rng() * 50) })
  }
  return out
}

/** A handle over an in-memory table that records which datasets were read. */
function fakeHandle(
  nBins: number,
  pixels: Pixel[],
  storedBin1: (p: Pixel, i: number) => number = (p) => p.bin1,
): { handle: Hdf5Handle; read: Set<string>; offsets: Float64Array } {
  const offsets = new Float64Array(nBins + 1)
  for (const p of pixels) offsets[p.bin1 + 1]++
  for (let i = 1; i <= nBins; i++) offsets[i] += offsets[i - 1]
  const read = new Set<string>()
  const column = (path: string): ArrayLike<number> => {
    read.add(path)
    switch (path) {
      case 'indexes/bin1_offset':
        return offsets
      case 'pixels/bin1_id':
        return pixels.map(storedBin1)
      case 'pixels/bin2_id':
        return pixels.map((p) => p.bin2)
      case 'pixels/count':
        return pixels.map((p) => p.count)
      default:
        throw new Error(`unexpected read of ${path}`)
    }
  }
  const slice = (path: string, lo = 0, hi?: number): number[] => {
    const all = column(path)
    return Array.from({ length: (hi ?? all.length) - lo }, (_, i) => all[lo + i])
  }
  const handle = {
    readNumeric: (path: string, lo?: number, hi?: number) => Float64Array.from(slice(path, lo, hi)),
    readInt32: (path: string, lo?: number, hi?: number) => Int32Array.from(slice(path, lo, hi)),
    datasetLength: (path: string) => column(path).length,
  } as unknown as Hdf5Handle
  return { handle, read, offsets }
}

describe('RowIndex', () => {
  it('answers pixels/bin1_id for every window of a table with empty rows', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const nBins = 60
      const pixels = table(nBins, seed)
      const { offsets } = fakeHandle(nBins, pixels)
      const stored = pixels.map((p) => p.bin1)
      for (const width of [1, 2, 3, 7, 50, 10_000]) {
        const rows = new RowIndex(offsets, 0)
        const got: number[] = []
        for (let at = 0; at < pixels.length; at += width) {
          got.push(...rows.bin1(at, Math.min(pixels.length, at + width)))
        }
        expect(got, `seed ${seed}, windows of ${width}`).toEqual(stored)
      }
    }
  })

  it('answers over a slice of the index, from the bin it starts at', () => {
    const nBins = 40
    const pixels = table(nBins, 11)
    const { offsets } = fakeHandle(nBins, pixels)
    const [lo, hi] = [9, 31]
    const rows = new RowIndex(offsets.slice(lo, hi + 1), lo)
    const [p0, p1] = [offsets[lo], offsets[hi]]
    expect(Array.from(rows.bin1(p0, p1))).toEqual(pixels.slice(p0, p1).map((p) => p.bin1))
  })

  it('finds its place again after a jump back or ahead', () => {
    const nBins = 50
    const pixels = table(nBins, 21)
    const { offsets } = fakeHandle(nBins, pixels)
    const rows = new RowIndex(offsets, 0)
    const rng = random(5)
    for (let k = 0; k < 200; k++) {
      const at = Math.floor(rng() * pixels.length)
      const end = Math.min(pixels.length, at + 1 + Math.floor(rng() * 20))
      // A jump ahead walks there; a jump back has to be sought.
      if (rng() < 0.5) rows.seek(at)
      expect(Array.from(rows.bin1(at, end))).toEqual(pixels.slice(at, end).map((p) => p.bin1))
    }
  })
})

describe('a window of pixels', () => {
  it('reads bin2_id and the value, and never bin1_id, when the index is in hand', () => {
    const nBins = 30
    const pixels = table(nBins, 7)
    const { handle, read, offsets } = fakeHandle(nBins, pixels)
    const chunk = readPixelWindow(handle, 3, pixels.length - 2, 'count', new RowIndex(offsets, 0))
    expect(read.has('pixels/bin1_id')).toBe(false)
    expect(Array.from(chunk.bin1)).toEqual(pixels.slice(3, -2).map((p) => p.bin1))
    expect(Array.from(chunk.bin2)).toEqual(pixels.slice(3, -2).map((p) => p.bin2))
    expect(Array.from(chunk.count)).toEqual(pixels.slice(3, -2).map((p) => p.count))
  })

  it('reads bin1_id as stored when it is given no index', () => {
    const nBins = 30
    const pixels = table(nBins, 8)
    const { handle, read } = fakeHandle(nBins, pixels, (_, i) => 1000 + i)
    const chunk = readPixelWindow(handle, 0, pixels.length)
    expect(read.has('pixels/bin1_id')).toBe(true)
    expect(Array.from(chunk.bin1)).toEqual(pixels.map((_, i) => 1000 + i))
  })

  it('walks a span and a set of bands with rows from the index', async () => {
    const nBins = 80
    const pixels = table(nBins, 9)
    const { handle, read, offsets } = fakeHandle(nBins, pixels)
    const seen: Pixel[] = []
    const keep = (chunk: PixelChunk): void => {
      for (let i = 0; i < chunk.length; i++) seen.push({ bin1: chunk.bin1[i], bin2: chunk.bin2[i], count: chunk.count[i] })
    }
    await forEachPixelSpanAsync(handle, 10, 70, keep, { chunkSize: 7 })
    expect(seen).toEqual(pixels.filter((p) => p.bin1 >= 10 && p.bin1 < 70))

    seen.length = 0
    const bands: Extent[] = [
      [offsets[5], offsets[12]],
      [offsets[30], offsets[44]],
      [offsets[60], offsets[nBins]],
    ]
    await forEachPixelRangesAsync(handle, bands, keep, { chunkSize: 5 }, offsets)
    const wanted = pixels.filter((p) => (p.bin1 >= 5 && p.bin1 < 12) || (p.bin1 >= 30 && p.bin1 < 44) || p.bin1 >= 60)
    expect(seen).toEqual(wanted)
    expect(read.has('pixels/bin1_id')).toBe(false)
  })
})

describe('CoolerStore.scanAll', () => {
  it('takes rows from the index, or as stored where it is asked to', async () => {
    const nBins = 40
    const pixels = table(nBins, 13)
    // A file whose column disagrees with its own index: what the deep check has
    // to be able to see, and the one walk that must read the column to see it.
    const { handle } = fakeHandle(nBins, pixels, (p, i) => (i === 5 ? p.bin1 + 1 : p.bin1))
    const store = new CoolerStore(handle, nBins, 'i')
    const rowsOf = async (storedRows: boolean): Promise<number[]> => {
      const out: number[] = []
      await store.scanAll({
        chunkSize: 6,
        storedRows,
        onChunk: (chunk) => {
          for (let i = 0; i < chunk.length; i++) out.push(chunk.bin1[i])
        },
      })
      return out
    }
    expect(await rowsOf(false)).toEqual(pixels.map((p) => p.bin1))
    expect(await rowsOf(true)).toEqual(pixels.map((p, i) => (i === 5 ? p.bin1 + 1 : p.bin1)))
  })
})

describe('planRead', () => {
  it('ends an overlapping read at the lower of the two ends', () => {
    expect(planRead([10, 20], [10, 30], 'symmetric-upper')).toEqual({ span: [10, 20], mode: 'symmetric' })
    expect(planRead([10, 30], [10, 20], 'symmetric-upper')).toEqual({ span: [10, 20], mode: 'symmetric' })
    expect(planRead([12, 30], [5, 20], 'symmetric-upper')).toEqual({ span: [5, 20], mode: 'symmetric' })
    expect(planRead([0, 100], [20, 50], 'symmetric-upper')).toEqual({ span: [0, 50], mode: 'symmetric' })
    expect(planRead([10, 20], [10, 20], 'symmetric-upper')).toEqual({ span: [10, 20], mode: 'symmetric' })
  })

  it('scatters every rectangle as the whole table does', async () => {
    const nBins = 48
    const pixels = table(nBins, 17)
    const { handle } = fakeHandle(nBins, pixels)
    const everything: PixelChunk = {
      bin1: Int32Array.from(pixels.map((p) => p.bin1)),
      bin2: Int32Array.from(pixels.map((p) => p.bin2)),
      count: Float64Array.from(pixels.map((p) => p.count)),
      length: pixels.length,
    }
    const rng = random(3)
    for (let k = 0; k < 300; k++) {
      const a = Math.floor(rng() * nBins)
      const b = a + 1 + Math.floor(rng() * (nBins - a))
      const c = Math.floor(rng() * nBins)
      const d = c + 1 + Math.floor(rng() * (nBins - c))
      const rows: Extent = [a, Math.min(nBins, b)]
      const cols: Extent = [c, Math.min(nBins, d)]
      const plan = planRead(rows, cols, 'symmetric-upper')
      const size = (rows[1] - rows[0]) * (cols[1] - cols[0])
      const expected = new Float32Array(size)
      scatterDense(everything, rows, cols, plan, expected)
      const got = new Float32Array(size)
      await forEachPixelSpanAsync(handle, plan.span[0], plan.span[1], (chunk) => scatterDense(chunk, rows, cols, plan, got))
      expect(Array.from(got), `rows ${rows}, cols ${cols}`).toEqual(Array.from(expected))
    }
  })
})

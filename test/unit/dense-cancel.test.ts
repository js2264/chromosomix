/**
 * A dense read that can be called off (§2, §12).
 *
 * The zoom calls off a read it has outrun and fires the next one
 * (`ui/refine.ts`), and the worker hands the dense read its cancel. The read
 * itself only ever checked it on the pooled path: the dense one — every read a
 * zoom makes at a rung the file stores — went on to its last window, and the
 * read the zoom was waiting for queued behind it. On the 4DN map of K562 from
 * S3, one called-off read of chr5 at 100 kb was 28 MB.
 */

import { describe, expect, it } from 'vitest'

import type { Hdf5Handle } from '@/h5/api'
import { DENSE_WINDOW, PIXEL_CHUNK, readDenseMatrix, type MatrixSource } from '@/metacooler/matrix'

/**
 * A map of `n` bins with one pixel on each diagonal cell, its store walking a
 * window a pixel as the cooler store does: the cancel polled before each one.
 */
function walking(n: number): { source: MatrixSource; seen: { windows: number; chunkSize?: number } } {
  const seen: { windows: number; chunkSize?: number } = { windows: 0 }
  // Raw counts are asked for, so nothing may touch the file's weights.
  const handle = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`a raw read touches no dataset (h5.${String(property)})`)
      },
    },
  ) as Hdf5Handle
  const source: MatrixSource = {
    handle,
    nBins: n,
    storageMode: 'symmetric-upper',
    store: {
      async forEachWindow(_rows, _cols, _plan, onChunk, options = {}) {
        if (options.chunkSize !== undefined) seen.chunkSize = options.chunkSize
        for (let bin = 0; bin < n; bin++) {
          if (options.cancelled?.() === true) return false
          seen.windows += 1
          onChunk({ bin1: Int32Array.of(bin), bin2: Int32Array.of(bin), count: Float64Array.of(1), length: 1 })
          await Promise.resolve()
        }
        return true
      },
    },
  }
  return { source, seen }
}

describe('a dense read called off', () => {
  it('stops at the next window and says it was cancelled', async () => {
    const { source, seen } = walking(10)
    const read = readDenseMatrix(source, { rows: [0, 10] }, 'hint', () => seen.windows >= 3)
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen.windows, 'no window read after the cancel').toBe(3)
  })

  it('reads every window where nobody calls it off', async () => {
    const { source, seen } = walking(6)
    const block = await readDenseMatrix(source, { rows: [0, 6] }, 'hint', () => false)
    expect(seen.windows).toBe(6)
    expect(Array.from({ length: 6 }, (_, i) => block.values[i * 6 + i])).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('walks in windows a quarter of the scan’s, as long as a cancel waits', async () => {
    const { source, seen } = walking(2)
    await readDenseMatrix(source, { rows: [0, 2] }, 'hint')
    expect(seen.chunkSize).toBe(DENSE_WINDOW)
    expect(DENSE_WINDOW).toBe(PIXEL_CHUNK / 4)
  })
})

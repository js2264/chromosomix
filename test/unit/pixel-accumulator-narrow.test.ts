/**
 * The narrowing accumulator is the full-square one, in less memory.
 *
 * The whole-file read at bin level sums every stored pixel into a block the
 * raster's size, and the full-square `Float64` plus its `Float32` copy was
 * 12 B a cell — the allocation a browser refused. The narrowing form keeps the
 * upper triangle and finishes straight into `Float32`; what has to hold is that
 * it is the same map, cell for cell, in every placement the store can ask for.
 */

import { describe, expect, it } from 'vitest'

import { groupRuns, pixelAccumulator } from '@/metacooler/aggregate'
import type { PlacementMode } from '@/metacooler/matrix'
import type { Extent } from '@/types'

/** A deterministic scatter of upper-triangular pixels over `n` bins. */
function pixels(n: number, count: number): Array<[number, number, number]> {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
    return seed / 2 ** 31
  }
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < count; i++) {
    const a = Math.floor(next() * n)
    const b = Math.floor(next() * n)
    out.push([Math.min(a, b), Math.max(a, b), 1 + Math.floor(next() * 50)])
  }
  // A bin the balancer dropped: contributes nothing in either form.
  out.push([1, 2, Number.NaN])
  return out
}

describe('the narrowing accumulator', () => {
  const n = 40
  // Bins pooled three to a cell, so a cell sums pixels from several bins and the
  // fold happens in group space as well as bin space.
  const grouping = groupRuns(Int32Array.from({ length: n }, (_, bin) => Math.floor(bin / 3)))
  const whole: Extent = [0, n]

  for (const mode of ['direct', 'symmetric', 'transpose'] as PlacementMode[]) {
    it(`sums to the same map as the full square — ${mode}`, () => {
      const wide = pixelAccumulator(whole, whole, grouping, grouping, mode, true)
      const narrow = pixelAccumulator(whole, whole, grouping, grouping, mode, true, true)
      for (const [a, b, v] of pixels(n, 2_000)) {
        wide.place(a, b, v)
        narrow.place(a, b, v)
      }
      const expected = wide.finish()
      const actual = narrow.finish()
      expect(actual.values).toBeInstanceOf(Float32Array)
      expect(actual.nrows).toBe(expected.nrows)
      expect(Array.from(actual.values)).toEqual(Array.from(Float32Array.from(expected.values)))
    })
  }

  it('leaves an off-diagonal block as the ordinary Float64 square', () => {
    const rows: Extent = [0, 20]
    const cols: Extent = [20, 40]
    const half = groupRuns(Int32Array.from({ length: 20 }, (_, bin) => bin))
    const acc = pixelAccumulator(rows, cols, half, half, 'direct', true, true)
    acc.place(3, 25, 4)
    const block = acc.finish()
    expect(block.values).toBeInstanceOf(Float64Array)
    expect(block.values[3 * 20 + 5]).toBe(4)
  })
})

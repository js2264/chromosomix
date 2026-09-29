/**
 * The stage's whole-genome picture (SPECS §27.9): read a band at a time, one
 * byte a cell, and a pyramid of means over it.
 *
 * Checked against a map small enough to hold whole in a test: every cell of the
 * picture decodes to within one step of the byte scale of the sum it should
 * hold, whatever the band size — which is the claim that reading in bands
 * changes nothing but the memory it takes.
 */

import { describe, expect, it } from 'vitest'

import { Coords } from '../../src/metacooler/coords'
import type { ReadPlan, SpanScanOptions } from '../../src/metacooler/matrix'
import {
  decodeTable,
  displayRange,
  encode,
  pictureLayout,
  pictureStride,
  pyramid,
  readPicture,
  triangleIndex,
} from '../../src/metacooler/picture'
import type { PixelStore, ScanAllOptions } from '../../src/metacooler/store'
import type { Extent, PixelChunk } from '../../src/types'

class MemoryStore implements PixelStore {
  readonly countKind = 'i' as const
  constructor(
    readonly bin1: Int32Array,
    readonly bin2: Int32Array,
    readonly count: Float64Array,
    readonly nBins: number,
  ) {}
  get nnz(): number {
    return this.count.length
  }
  scoreColumns(): string[] {
    return ['count']
  }
  binOffsets(): Float64Array {
    const offsets = new Float64Array(this.nBins + 1)
    for (let i = 0; i < this.bin1.length; i++) offsets[this.bin1[i] + 1]++
    for (let b = 0; b < this.nBins; b++) offsets[b + 1] += offsets[b]
    return offsets
  }
  private rows(lo: number, hi: number): PixelChunk {
    const keep: number[] = []
    for (let i = 0; i < this.bin1.length; i++) if (this.bin1[i] >= lo && this.bin1[i] < hi) keep.push(i)
    return {
      bin1: Int32Array.from(keep, (i) => this.bin1[i]),
      bin2: Int32Array.from(keep, (i) => this.bin2[i]),
      count: Float64Array.from(keep, (i) => this.count[i]),
      length: keep.length,
    }
  }
  async forEachWindow(_r: Extent, _c: Extent, plan: ReadPlan, onChunk: (c: PixelChunk) => void): Promise<boolean> {
    onChunk(this.rows(plan.span[0], plan.span[1]))
    return true
  }
  async forEachBands(bands: readonly Extent[], onChunk: (c: PixelChunk) => void, _o?: SpanScanOptions): Promise<boolean> {
    for (const [lo, hi] of bands) onChunk(this.rows(lo, hi))
    return true
  }
  async scanAll(options: ScanAllOptions): Promise<void> {
    options.onChunk(this.rows(0, this.nBins))
  }
}

/** Two sequences of 40 and 25 bins at 1 kb, every pair with a count that falls with distance. */
function map(): { coords: Coords; store: MemoryStore; value: (i: number, j: number) => number } {
  const coords = new Coords(1000, Float64Array.from([0, 40, 65]), Float64Array.from([39_500, 25_000]))
  const seq = (bin: number): number => (bin < 40 ? 0 : 1)
  const value = (i: number, j: number): number => (seq(i) === seq(j) ? Math.floor(1000 / (1 + Math.abs(j - i))) : 1)
  const b1: number[] = []
  const b2: number[] = []
  const c: number[] = []
  for (let i = 0; i < 65; i++) {
    for (let j = i; j < 65; j++) {
      b1.push(i)
      b2.push(j)
      c.push(value(i, j))
    }
  }
  return { coords, store: new MemoryStore(Int32Array.from(b1), Int32Array.from(b2), Float64Array.from(c), 65), value }
}

describe('the grid', () => {
  it('is the map’s own bins where they fit, and starts afresh at every sequence', () => {
    const { coords } = map()
    expect(pictureStride(coords, 100)).toBe(1)
    // 40 and 25 bins in 20 cells: three bins a cell makes 14 + 9 = 23, four 10 + 7 = 17.
    expect(pictureStride(coords, 20)).toBe(4)
    const layout = pictureLayout(coords, 4)
    expect(layout.n).toBe(17)
    expect(Array.from(layout.offsets)).toEqual([0, 10, 17])
    expect(layout.slot[39]).toBe(9)
    expect(layout.slot[40]).toBe(10)
  })

  it('has no picture for more sequences than cells', () => {
    const coords = new Coords(1000, Float64Array.from([0, 1, 2, 3]), Float64Array.from([10, 10, 10]))
    expect(pictureStride(coords, 2)).toBeNull()
  })
})

describe('reading it', () => {
  it('holds every cell to within a step of its value, in bands of any size', async () => {
    const { coords, store, value } = map()
    const layout = pictureLayout(coords, 1)
    for (const bandBytes of [4 * 65, 4 * 65 * 7, 1 << 20]) {
      const read = await readPicture({ store, coords, layout, weights: null, bandBytes })
      expect(read).not.toBeNull()
      if (read === null) return
      const { cells, quantizer } = read
      const step = (quantizer.high - quantizer.low) / 254
      for (const [i, j] of [
        [0, 0],
        [3, 17],
        [39, 39],
        [10, 50],
        [40, 64],
      ]) {
        const byte = cells[triangleIndex(i, j, 65)]
        const expected = Math.log10(value(i, j))
        expect(Math.abs(quantizer.low + (byte - 1) * step - expected)).toBeLessThanOrEqual(step / 2 + 1e-9)
      }
    }
  })

  it('leaves a bin the balancer dropped empty', async () => {
    const { coords, store } = map()
    const weights = new Float64Array(65).fill(1)
    weights[5] = Number.NaN
    const read = await readPicture({ store, coords, layout: pictureLayout(coords, 1), weights })
    expect(read?.cells[triangleIndex(5, 9, 65)]).toBe(0)
    expect(read?.cells[triangleIndex(4, 9, 65)]).toBeGreaterThan(0)
  })

  it('sums a pooled cell on the diagonal as the square it is', async () => {
    const { coords, store, value } = map()
    const read = await readPicture({ store, coords, layout: pictureLayout(coords, 2), weights: null })
    if (read === null) throw new Error('cancelled')
    // Cell 0 is bins 0 and 1: the square (0,0) (0,1) (1,0) (1,1).
    const square = value(0, 0) + 2 * value(0, 1) + value(1, 1)
    const table = decodeTable(read.quantizer)
    const got = table[read.cells[triangleIndex(0, 0, pictureLayout(coords, 2).n)]]
    expect(Math.abs(Math.log10(got) - Math.log10(square))).toBeLessThan((read.quantizer.high - read.quantizer.low) / 254)
  })
})

describe('the pyramid', () => {
  it('means four cells into one, down to the floor', () => {
    const q = { low: 0, high: 4 }
    const n = 5
    const cells = new Uint8Array((n * (n + 1)) / 2)
    for (let a = 0; a < n; a++) for (let b = a; b < n; b++) cells[triangleIndex(a, b, n)] = encode(a === b ? 1000 : 10, q)
    const levels = pyramid({ n, cells }, q, 2)
    expect(levels.map((level) => level.n)).toEqual([5, 3, 2])
    const table = decodeTable(q)
    // Within a step and a half of the byte scale: the four cells were bytes
    // before they were means, and the mean is a byte again.
    const near = (byte: number, expected: number): void =>
      expect(Math.abs(Math.log10(table[byte]) - Math.log10(expected))).toBeLessThanOrEqual(1.5 * (4 / 254))
    // The diagonal cell of level 1 is the mean of 1000, 10, 10, 1000.
    near(levels[1].cells[triangleIndex(0, 0, 3)], 505)
    // Off it, four cells of 10.
    near(levels[1].cells[triangleIndex(0, 1, 3)], 10)
  })
})

describe('the range it opens at', () => {
  it('is the first and ninety-ninth percentiles of the cells that hold anything', () => {
    const q = { low: -2, high: 2 }
    const histogram = new Float64Array(256)
    histogram[0] = 1e6
    for (let b = 1; b <= 100; b++) histogram[b] = 1
    const { vmin, vmax } = displayRange(histogram, q)
    const step = 4 / 254
    expect(vmin).toBeCloseTo(-2, 5)
    expect(vmax).toBeCloseTo(-2 + 98 * step, 5)
  })
})

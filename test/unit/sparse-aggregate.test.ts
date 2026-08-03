/**
 * The sparse roll-up equals the dense one.
 *
 * `aggregateMatrix` walks a materialised block; `sparseAggregator` walks the
 * stored pixels. They must agree exactly — the dense version is what
 * `metacooler aggregate` and `show --level contig` are pinned against, and the
 * sparse one is what the app now runs. The interesting cases are the ones where
 * the two could plausibly diverge: the on-diagonal fold, the transposed pair,
 * and a NaN weight.
 *
 * No fixture: the grouping comes from a `Coords` built by hand, so this runs on
 * a fresh clone.
 */

import { describe, expect, it } from 'vitest'

import { aggregateMatrix, sparseAggregator, type AggregationLevel } from '@/metacooler/aggregate'
import { Coords } from '@/metacooler/coords'
import { planRead, scatterDense } from '@/metacooler/matrix'
import type { StorageMode } from '@/constants'
import type { DenseMatrix, Extent, PixelChunk } from '@/types'

interface Pixel {
  bin1: number
  bin2: number
  count: number
}

/** Three contigs of 4, 3 and 5 bins, in two genomes. */
function fixture(): { coords: Coords; genomeIds: Int32Array; nBins: number } {
  const lengths = [4, 3, 5]
  const chromOffset = Float64Array.from([0, 4, 7, 12])
  const coords = new Coords(1, chromOffset, Float64Array.from(lengths))
  return { coords, genomeIds: Int32Array.from([0, 0, 1]), nBins: 12 }
}

/** Upper-triangular pixels, sorted, covering the diagonal and both off-blocks. */
function pixels(nBins: number): Pixel[] {
  const out: Pixel[] = []
  let v = 1
  for (let a = 0; a < nBins; a++) {
    for (let b = a; b < nBins; b++) {
      if ((a * 7 + b * 3) % 4 !== 0) continue
      out.push({ bin1: a, bin2: b, count: v++ })
    }
  }
  return out
}

/** The dense route: scatter into a block, then roll it up. */
function denseAnswer(
  rows: Extent,
  cols: Extent,
  all: Pixel[],
  storage: StorageMode,
  level: AggregationLevel,
  coords: Coords,
  genomeIds: Int32Array,
): Float64Array {
  const plan = planRead(rows, cols, storage)
  const inSpan = all.filter((p) => p.bin1 >= plan.span[0] && p.bin1 < plan.span[1])
  const chunk: PixelChunk = {
    bin1: Int32Array.from(inSpan.map((p) => p.bin1)),
    bin2: Int32Array.from(inSpan.map((p) => p.bin2)),
    count: Float64Array.from(inSpan.map((p) => p.count)),
    length: inSpan.length,
  }
  const values = new Float32Array((rows[1] - rows[0]) * (cols[1] - cols[0]))
  scatterDense(chunk, rows, cols, plan, values)
  const dense: DenseMatrix = {
    nrows: rows[1] - rows[0],
    ncols: cols[1] - cols[0],
    values,
    rowExtent: rows,
    colExtent: cols,
  }
  return aggregateMatrix(dense, coords, genomeIds, level, storage === 'symmetric-upper').values
}

/** The sparse route: place each stored pixel once. */
function sparseAnswer(
  rows: Extent,
  cols: Extent,
  all: Pixel[],
  storage: StorageMode,
  level: AggregationLevel,
  coords: Coords,
  genomeIds: Int32Array,
): Float64Array {
  const plan = planRead(rows, cols, storage)
  const aggregator = sparseAggregator(
    rows,
    cols,
    coords,
    genomeIds,
    level,
    plan.mode,
    storage === 'symmetric-upper',
  )
  for (const p of all) {
    if (p.bin1 < plan.span[0] || p.bin1 >= plan.span[1]) continue
    aggregator.place(p.bin1, p.bin2, p.count)
  }
  return aggregator.finish().values
}

describe('sparse and dense roll-ups agree', () => {
  const { coords, genomeIds, nBins } = fixture()
  const all = pixels(nBins)

  const SELECTIONS: Array<{ name: string; rows: Extent; cols: Extent }> = [
    { name: 'the whole file, on the diagonal', rows: [0, 12], cols: [0, 12] },
    { name: 'one contig with itself', rows: [4, 7], cols: [4, 7] },
    { name: 'a forward pair (rows before cols)', rows: [0, 4], cols: [7, 12] },
    { name: 'a transposed pair (cols before rows)', rows: [7, 12], cols: [0, 4] },
    { name: 'adjacent blocks', rows: [0, 4], cols: [4, 7] },
    // Overlapping but not identical: `symmetric` placement without the fold,
    // which is the case that distinguishes the two conditions on `placeFlipped`.
    { name: 'a partial overlap', rows: [0, 7], cols: [4, 12] },
    { name: 'a partial overlap, the other way', rows: [4, 12], cols: [0, 7] },
    { name: 'an empty row range', rows: [5, 5], cols: [0, 12] },
  ]

  for (const storage of ['symmetric-upper', 'square'] as StorageMode[]) {
    for (const level of ['contig', 'genome'] as AggregationLevel[]) {
      for (const { name, rows, cols } of SELECTIONS) {
        it(`${storage} · ${level} · ${name}`, () => {
          const dense = denseAnswer(rows, cols, all, storage, level, coords, genomeIds)
          const sparse = sparseAnswer(rows, cols, all, storage, level, coords, genomeIds)
          expect(Array.from(sparse)).toEqual(Array.from(dense))
        })
      }
    }
  }

  it('drops a NaN rather than poisoning its group, as the dense path does', () => {
    const rows: Extent = [0, 12]
    const withNaN = all.map((p, i) => (i === 3 ? { ...p, count: Number.NaN } : p))
    const dense = denseAnswer(rows, rows, withNaN, 'symmetric-upper', 'contig', coords, genomeIds)
    const sparse = sparseAnswer(rows, rows, withNaN, 'symmetric-upper', 'contig', coords, genomeIds)
    expect(Array.from(sparse)).toEqual(Array.from(dense))
    expect(Array.from(sparse).some(Number.isNaN)).toBe(false)
  })

  it('is symmetric on the diagonal, which is what the fold is for', () => {
    const rows: Extent = [0, 12]
    const sparse = sparseAnswer(rows, rows, all, 'symmetric-upper', 'contig', coords, genomeIds)
    const n = 3
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) expect(sparse[a * n + b]).toBe(sparse[b * n + a])
    }
  })

  it('does not double the diagonal — the defect the fold exists to prevent', () => {
    // One stored pixel between two bins of the same contig contributes once.
    const rows: Extent = [0, 4]
    const one: Pixel[] = [{ bin1: 0, bin2: 2, count: 10 }]
    const sparse = sparseAnswer(rows, rows, one, 'symmetric-upper', 'contig', coords, genomeIds)
    expect(sparse[0]).toBe(10)
  })
})

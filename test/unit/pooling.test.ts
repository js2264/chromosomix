/**
 * Reading a block at a coarser bin size than the file stores.
 *
 * One property carries this whole feature: **the pooled block is the dense
 * block, summed in squares**. If that holds, the whole-genome view of a large
 * cooler is the same map it always was at a resolution it can be drawn at; if
 * it does not, it is a plausible-looking picture of nothing, and a Hi-C map is
 * exactly the kind of picture whose being wrong is invisible.
 *
 * So the tests below compare against the *dense* read of the same fixture rather
 * than against a stored oracle, cell for cell and with no tolerance. The dense
 * read is itself pinned to Python (`matrix.test.ts`), so agreeing with it is
 * agreeing with `cooler.Cooler.matrix`, one step removed.
 *
 * The trap it is guarding is the diagonal. An on-diagonal block of an
 * upper-triangular file carries both triangles, so a stored pixel off the
 * diagonal appears twice; summing without folding double-counts exactly the
 * cells where a coarsened map has its largest values, where the error reads as
 * "the diagonal is strong" rather than as a bug.
 */

import { describe, expect, it } from 'vitest'

import { aggregateDense } from '@/metacooler/aggregate'
import {
  binPooling,
  flatBinPooling,
  poolStride,
  selectionPooling,
  POOLED_CELL_CAP,
} from '@/metacooler/pooling'
import type { MetaCooler } from '@/metacooler/MetaCooler'
import { fixtureCases, openCase, type FixtureCase } from '../support/goldens'

describe('poolStride', () => {
  it('is the identity while the block already fits', () => {
    expect(poolStride(10, 4096)).toBe(1)
    expect(poolStride(4096, 4096)).toBe(1)
  })

  it('is the smallest stride that brings the axis under the cap', () => {
    expect(poolStride(4097, 4096)).toBe(2)
    expect(poolStride(8192, 4096)).toBe(2)
    expect(poolStride(8193, 4096)).toBe(3)
    // A whole yeast genome at 500 bp — the case this exists for. 24,228 bins
    // into 4,096 cells is six 500 bp bins each, a 3 kb map.
    expect(poolStride(24_228, 4096)).toBe(6)
  })

  it('defaults to the cap the renderer draws at', () => {
    expect(poolStride(24_228)).toBe(poolStride(24_228, POOLED_CELL_CAP))
  })
})

describe('binPooling', () => {
  // Three contigs of 10, 7 and 3 bins, laid out as the reader sees them.
  const coords = {
    contigsOfBins: (lo: number, hi: number): Int32Array => {
      const out = new Int32Array(hi - lo)
      for (let i = lo; i < hi; i++) out[i - lo] = i < 10 ? 0 : i < 17 ? 1 : 2
      return out
    },
  } as unknown as Parameters<typeof binPooling>[0]

  it('starts a fresh cell at every contig, so a cell is one sequence', () => {
    const pooled = binPooling(coords, 0, 20, 4)
    // 10 bins → 3 cells (4, 4, 2); 7 → 2 (4, 3); 3 → 1. Never 5 cells of 4
    // bins straddling the boundary at bin 10.
    expect(Array.from(pooled.slot)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5,
    ])
    expect(Array.from(pooled.ids)).toEqual([0, 0, 0, 1, 1, 2])
    expect(pooled.snapped).toBe(true)
  })

  it('is the identity at stride 1, one cell per bin', () => {
    const pooled = binPooling(coords, 0, 20, 1)
    expect(Array.from(pooled.slot)).toEqual([...Array(20).keys()])
    expect(pooled.ids.length).toBe(20)
  })

  it('gives up the boundaries only when told to, and says so', () => {
    const flat = flatBinPooling(coords, 0, 20, 4)
    // Cell 2 holds bins 8..11 — the end of contig 0 and the start of contig 1.
    expect(Array.from(flat.slot)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
    ])
    expect(flat.snapped).toBe(false)
    // Named by the contig its first bin is in — cell 4 opens on the last bin of
    // contig 1 and is called that, though three of its four bins are contig 2.
    // No rule names a straddling cell correctly; this one keeps the labels
    // monotone, so the axis still reads in file order.
    expect(Array.from(flat.ids)).toEqual([0, 0, 0, 1, 1])
  })

  it('covers every bin exactly once, in order', () => {
    for (const stride of [1, 2, 3, 4, 7, 20]) {
      const pooled = binPooling(coords, 0, 20, stride)
      let previous = -1
      for (const slot of pooled.slot) {
        expect(slot === previous || slot === previous + 1).toBe(true)
        previous = slot
      }
      expect(previous + 1).toBe(pooled.ids.length)
    }
  })
})

describe('the pooled read against the dense one', () => {
  const cases = fixtureCases()

  for (const c of cases) {
    for (const stride of [2, 3]) {
      it(`sums to the same map on ${c.label}, at ${stride} bins per cell`, async () => {
        const mc = await openCase(c as FixtureCase)
        try {
          await comparePooled(mc, stride)
        } finally {
          mc.close()
        }
      })
    }
  }
})

/**
 * The oracle: the same squares summed out of the materialised block, by the
 * roll-up that `metacooler aggregate` pins.
 *
 * Not a hand-written double loop over the dense block — that was the first
 * version of this and it disagreed on every diagonal cell, correctly. An
 * on-diagonal block of an upper-triangular file carries both triangles, so
 * summing it whole counts each within-cell pair twice; a coarser resolution
 * stores each pair once, which is what `aggregateDense`'s fold reproduces and
 * what `cooler zoomify` writes. The grouping is the only thing that differs from
 * a contig roll-up, so the same function answers both.
 */
function expectedFromDense(
  dense: Parameters<typeof aggregateDense>[0],
  grouping: ReturnType<typeof binPooling>,
): Float64Array {
  // `'contig'` names nothing here; the level is carried through to a field this
  // comparison does not read.
  return aggregateDense(dense, grouping, grouping, 'contig', true).values
}

async function comparePooled(mc: MetaCooler, stride: number): Promise<void> {
  const n = mc.nBins
  // Every fixture is small enough to materialise whole, which is the point:
  // the dense block is the oracle here.
  const dense = await mc.matrix({ rows: [0, n] })
  const pooled = await mc.pooledMatrix({ rows: [0, n] }, stride)
  const grouping = binPooling(mc.coords, 0, n, stride)

  expect(pooled.binsPerCell).toBe(stride)
  expect(pooled.snapped).toBe(true)
  expect(pooled.nrows).toBe(grouping.ids.length)
  expect(pooled.ncols).toBe(grouping.ids.length)

  const expected = expectedFromDense(dense, grouping)
  expect(expected.length).toBe(pooled.values.length)
  for (let i = 0; i < expected.length; i++) {
    const row = Math.floor(i / pooled.ncols)
    const col = i % pooled.ncols
    // Exact: counts are integers, both sums are `Float64`, and the pixels being
    // summed are the same pixels. A tolerance here would let a double-counted
    // diagonal through, which is the failure worth catching.
    expect(pooled.values[i], `cell ${row},${col}`).toBe(expected[i])
  }
}

/**
 * The same arithmetic over a *chosen* set of sequences.
 *
 * A selection is the whole-file read with most of the file left out, so the
 * oracle is the same one: the dense block rolled up by the folded aggregation,
 * over a grouping that keeps only the chosen bins. If the two agree, ticking
 * four MAGs shows the same numbers as looking at all of them and reading four
 * rows — which is the only thing a reader can check by eye.
 */
describe('the selection read', () => {
  for (const c of fixtureCases()) {
    it(`matches the dense block on ${c.label}`, async () => {
      const mc = await openCase(c as FixtureCase)
      try {
        // Every other contig, so the selection is scattered rather than a range
        // — the case a bin extent cannot express and this exists for.
        const chosen = Array.from({ length: mc.nContigs }, (_, id) => id).filter(
          (id) => id % 2 === 0,
        )
        if (chosen.length === 0) return
        const units = chosen.map((id) => ({ id, extent: mc.contigExtent(id) }))
        const pooled = await mc.selectionMatrix(units, 1)
        const dense = await mc.matrix({ rows: [0, mc.nBins] })
        const grouping = selectionPooling(mc.nBins, units, 1)

        // One cell per selected bin at stride 1, in the order chosen.
        const bins = units.reduce((sum, u) => sum + (u.extent[1] - u.extent[0]), 0)
        expect(pooled.nrows).toBe(bins)
        expect(pooled.ncols).toBe(bins)

        const expected = aggregateDense(dense, grouping, grouping, 'contig', true).values
        for (let i = 0; i < expected.length; i++) {
          expect(pooled.values[i], `cell ${Math.floor(i / pooled.ncols)},${i % pooled.ncols}`).toBe(
            expected[i],
          )
        }
      } finally {
        mc.close()
      }
    })
  }
})

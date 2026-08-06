/**
 * Reading a block at a coarser grid than the file stores.
 *
 * Two properties carry this whole feature.
 *
 * **The pooled block is the dense block, summed in squares.** If that holds, the
 * whole-genome view of a large cooler is the same map it always was at a
 * resolution it can be drawn at; if it does not, it is a plausible-looking
 * picture of nothing, and a Hi-C map is exactly the kind of picture whose being
 * wrong is invisible. So the tests below compare against the *dense* read of the
 * same fixture rather than against a stored oracle, cell for cell and with no
 * tolerance. The dense read is itself pinned to Python (`matrix.test.ts`), so
 * agreeing with it is agreeing with `cooler.Cooler.matrix`, one step removed.
 *
 * The trap it is guarding is the diagonal. An on-diagonal block of an
 * upper-triangular file carries both triangles, so a stored pixel off the
 * diagonal appears twice; summing without folding double-counts exactly the
 * cells where a coarsened map has its largest values, where the error reads as
 * "the diagonal is strong" rather than as a bug.
 *
 * **No cell straddles a contig, and there are never more cells than the cap.**
 * The first is what makes a cell a thing that can be named and hovered; the
 * second is what stops the renderer coarsening a second time, contig-blind,
 * behind the reader's back. They are one property in two places: a picture is
 * honest only if the grid that was read is the grid that is drawn.
 */

import { describe, expect, it } from 'vitest'

import { aggregateDense, coarsenGrouping } from '@/metacooler/aggregate'
import {
  IDENTITY_PLAN,
  partitionAxis,
  poolBins,
  poolPlan,
  runStarts,
  selectionPooling,
  POOLED_CELL_CAP,
  type PoolPlan,
} from '@/metacooler/pooling'
import type { MetaCooler } from '@/metacooler/MetaCooler'
import { fixtureCases, openCase, type FixtureCase } from '../support/goldens'

describe('poolPlan', () => {
  it('is the identity while the block already fits', () => {
    expect(poolPlan(10, 3, 4096)).toEqual(IDENTITY_PLAN)
    expect(poolPlan(4096, 24, 4096)).toEqual(IDENTITY_PLAN)
  })

  it('leaves room for the cell every sequence starts', () => {
    // A cooler: 24 chromosomes, so the cap is 4,096 − 24 and the stride is one
    // step coarser than the bin count alone would suggest. That step is the
    // whole point — 4,096 was the aim before, and the overshoot was pooled again
    // by the renderer.
    expect(poolPlan(24_228, 24, 4096).binsPerCell).toBe(Math.ceil(24_228 / (4096 - 24)))
    expect(poolPlan(8192, 1, 4096).binsPerCell).toBe(3)
  })

  it('switches to whole sequences per cell once they outnumber the cells', () => {
    // The reported file: 4,885 bins across 4,882 contigs. No stride gives every
    // contig a cell, because every contig starts one.
    expect(poolPlan(4885, 4882, 4096)).toEqual({ binsPerCell: 1, contigsPerCell: 2 })
    expect(poolPlan(2_000_000, 500_000, 4096).contigsPerCell).toBe(123)
  })
})

describe('partitionAxis', () => {
  // Three contigs of 10, 7 and 3 bins, laid out as the reader sees them.
  const ids = Int32Array.from([...Array(10).fill(0), ...Array(7).fill(1), ...Array(3).fill(2)])
  const starts = runStarts(ids)

  it('starts a fresh cell at every contig, so a cell is one sequence', () => {
    const part = partitionAxis(20, starts, 6)
    // 10 bins → 3 cells (4, 4, 2); 7 → 2 (4, 3); 3 → 1. Never 5 cells of 4
    // bins straddling the boundary at bin 10.
    expect(part.plan).toEqual({ binsPerCell: 4, contigsPerCell: 1 })
    expect(Array.from(part.slot)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5,
    ])
    expect(Array.from(part.cellStart)).toEqual([0, 4, 8, 10, 14, 17, 20])
  })

  it('never exceeds the cap, at any cap, and never splits a contig', () => {
    for (let cap = 1; cap <= 24; cap++) {
      const part = partitionAxis(20, starts, cap)
      expect(part.cells, `cap ${cap}`).toBeLessThanOrEqual(cap)
      // Every cell lies inside one contig, or holds whole ones: either way the
      // set of contigs it touches is a set of *complete* contigs unless it is
      // one contig's own run.
      for (let c = 0; c < part.cells; c++) {
        const from = part.cellStart[c]
        const to = part.cellStart[c + 1]
        const first = ids[from]
        const last = ids[to - 1]
        if (first === last) continue
        // Spans several: it must start one contig and end another completely.
        expect(from === 0 || ids[from - 1] !== first, `cap ${cap} cell ${c}`).toBe(true)
        expect(to === 20 || ids[to] !== last, `cap ${cap} cell ${c}`).toBe(true)
      }
    }
  })

  it('takes the smallest stride that fits rather than a bound', () => {
    // `ceil(20 / (7 - 3))` is 5; the exact answer is 4, and a fifth of the
    // resolution the screen was going to show is worth twenty lines of search.
    expect(partitionAxis(20, starts, 7).plan.binsPerCell).toBe(4)
  })

  it('honours a floor the caller has already labelled its axis with', () => {
    const part = partitionAxis(20, starts, 20, { binsPerCell: 5, contigsPerCell: 1 })
    expect(part.plan.binsPerCell).toBe(5)
  })

  it('keeps a cell of whole sequences inside one genome', () => {
    // Six contigs of two bins, in three genomes of two contigs. At three cells
    // the flat answer is two contigs each — which here happens to align — so
    // make it awkward: five cells over genomes of 1, 3 and 2 contigs.
    const contig = Int32Array.from([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
    const runs = runStarts(contig)
    const genome = Int32Array.from([0, 1, 1, 1, 2, 2])
    const part = partitionAxis(12, runs, 4, IDENTITY_PLAN, genome)
    expect(part.cells).toBeLessThanOrEqual(4)
    for (let c = 0; c < part.cells; c++) {
      const from = part.cellStart[c]
      const to = part.cellStart[c + 1]
      const genomes = new Set<number>()
      for (let i = from; i < to; i++) genomes.add(genome[contig[i]])
      expect(genomes.size, `cell ${c}`).toBe(1)
    }
  })
})

describe('poolBins', () => {
  const coords = {
    contigsOfBins: (lo: number, hi: number): Int32Array => {
      const out = new Int32Array(hi - lo)
      for (let i = lo; i < hi; i++) out[i - lo] = i
      return out
    },
  } as unknown as Parameters<typeof poolBins>[0]

  it('groups whole sequences where one per cell will not fit', () => {
    // 5,000 one-bin contigs against the renderer's cap: two contigs a cell.
    const pooled = poolBins(coords, 0, 5000, poolPlan(5000, 5000, POOLED_CELL_CAP))
    expect(pooled.contigsPerCell).toBe(2)
    expect(pooled.ids.length).toBeLessThanOrEqual(POOLED_CELL_CAP)
    // A cell is named by the first sequence in it, and the names stay in file
    // order, so the axis still reads as the file does.
    expect(pooled.ids[0]).toBe(0)
    expect(pooled.ids[1]).toBe(2)
  })

  it('never hands the renderer more cells than it draws', () => {
    for (const bins of [4097, 5119, 5120, 8191, 24_228]) {
      const pooled = poolBins(coords, 0, bins, poolPlan(bins, bins, POOLED_CELL_CAP))
      expect(pooled.ids.length, `${bins} bins`).toBeLessThanOrEqual(POOLED_CELL_CAP)
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
          await comparePooled(mc, { binsPerCell: stride, contigsPerCell: 1 })
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
  grouping: ReturnType<typeof poolBins>,
): Float64Array {
  // `'contig'` names nothing here; the level is carried through to a field this
  // comparison does not read.
  return aggregateDense(dense, grouping, grouping, 'contig', true).values
}

async function comparePooled(mc: MetaCooler, plan: PoolPlan): Promise<void> {
  const n = mc.nBins
  // Every fixture is small enough to materialise whole, which is the point:
  // the dense block is the oracle here.
  const dense = await mc.matrix({ rows: [0, n] })
  const pooled = await mc.pooledMatrix({ rows: [0, n] }, plan)
  const grouping = poolBins(mc.coords, 0, n, plan, POOLED_CELL_CAP, mc.contigGenomeIds)

  expect(pooled.binsPerCell).toBe(plan.binsPerCell)
  expect(pooled.contigsPerCell).toBe(1)
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
        const pooled = await mc.selectionMatrix(units, IDENTITY_PLAN)
        const dense = await mc.matrix({ rows: [0, mc.nBins] })
        const grouping = selectionPooling(mc.nBins, units, IDENTITY_PLAN)

        // One cell per selected bin at the identity plan, in the order chosen.
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

/**
 * A selection of more sequences than the picture has pixels.
 *
 * It used to be a refusal — "past the 5120 one picture holds. Select fewer
 * sequences" — which is a strange thing to say to someone who has just ticked
 * "select all". The axis is named sequences either way; the only question is how
 * many share a cell, and that is a number the summary can state.
 */
describe('a selection larger than the cap', () => {
  it('groups whole sequences rather than refusing', () => {
    const units = Array.from({ length: 6000 }, (_, id) => ({
      id,
      extent: [id, id + 1] as [number, number],
    }))
    const plan = poolPlan(6000, 6000, POOLED_CELL_CAP)
    const pooling = selectionPooling(6000, units, plan)
    expect(pooling.contigsPerCell).toBe(2)
    expect(pooling.ids.length).toBe(3000)
    // Cell 0 is contigs 0 and 1; cell 1 is 2 and 3.
    expect(pooling.slot[0]).toBe(0)
    expect(pooling.slot[1]).toBe(0)
    expect(pooling.slot[2]).toBe(1)
  })
})

/**
 * The contig-level roll-up, bounded by the same number as everything else.
 *
 * It used to have no bound at all: one cell per contig on each axis, so a genome
 * of 4,882 contigs was a 190 MB accumulator for a picture 4,096 pixels wide, and
 * the renderer then pooled it flat — two contigs to a pixel, blind to which was
 * which. That is the straddling the bin path was fixed for, reached through the
 * level toggle instead.
 */
describe('coarsening a roll-up', () => {
  const grouping = (n: number): { slot: Int32Array; ids: Int32Array } => ({
    slot: Int32Array.from({ length: n }, (_, i) => i),
    ids: Int32Array.from({ length: n }, (_, i) => i),
  })

  it('leaves an axis that already fits exactly alone', () => {
    const before = grouping(100)
    const after = coarsenGrouping(before, 4096)
    expect(after.perCell).toBe(1)
    expect(after.grouping).toBe(before)
  })

  it('collapses whole contigs until the axis fits the picture', () => {
    const after = coarsenGrouping(grouping(4882), 4096)
    expect(after.perCell).toBe(2)
    expect(after.grouping.ids.length).toBeLessThanOrEqual(4096)
    // A cell is named after the first contig in it, so the axis keeps file order.
    expect(after.grouping.ids[0]).toBe(0)
    expect(after.grouping.ids[1]).toBe(2)
    // Every contig lands somewhere; none is dropped.
    expect(after.grouping.slot.length).toBe(4882)
    expect(Math.max(...after.grouping.slot)).toBe(after.grouping.ids.length - 1)
  })

  it('keeps a cell inside one genome', () => {
    // Genomes of 1, 3 and 2 contigs, into at most four cells.
    const genome = [0, 1, 1, 1, 2, 2]
    const after = coarsenGrouping(grouping(6), 4, (id) => genome[id])
    expect(after.grouping.ids.length).toBeLessThanOrEqual(4)
    const seen = new Map<number, Set<number>>()
    for (let contig = 0; contig < 6; contig++) {
      const cell = after.grouping.slot[contig]
      const set = seen.get(cell) ?? new Set<number>()
      set.add(genome[contig])
      seen.set(cell, set)
    }
    for (const [cell, genomes] of seen) expect(genomes.size, `cell ${cell}`).toBe(1)
  })
})

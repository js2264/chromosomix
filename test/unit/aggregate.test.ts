/**
 * Contig and genome roll-up of an already-loaded matrix (spec §4, §6.2; M2).
 *
 * Two independent things are asserted here, and they fail for different
 * reasons:
 *
 * 1. **Parity with Python.** The roll-up must equal `metacooler aggregate` —
 *    which is what `show --level contig` draws — cell for cell. That is not the
 *    same as summing the loaded block: the block carries *both* triangles of an
 *    upper-triangular store, so a naive sum counts every within-group
 *    off-diagonal pixel twice and inflates precisely the diagonal of the
 *    result. `_aggregate_sparse` maps each stored pixel once and only then
 *    symmetrises (`agg + agg.T - diag(agg)`).
 * 2. **Float64 accumulation.** The on-disk format widens counts to int64
 *    because summation overflows int32 — a genome pair can exceed 2^31
 *    contacts on real metagenomic data. The last two tests construct exactly
 *    that overflow and assert it does not wrap, and a second case that a
 *    `Float32Array` accumulator would silently round.
 *
 * Nothing in this file performs I/O, and one test proves it.
 */

import { describe, expect, it } from 'vitest'

import { aggregateMatrix, groupRuns } from '@/metacooler/aggregate'
import { Coords } from '@/metacooler/coords'
import type { DenseMatrix, Extent } from '@/types'
import {
  expectMatrixEquals,
  fixtureCase,
  fixtureCases,
  openCase,
  total,
  type Golden,
} from '../support/goldens'

/** The sub-block of a golden aggregate covering one group range. */
function submatrix(values: number[][], rows: Extent, cols: Extent): number[][] {
  return values.slice(rows[0], rows[1]).map((row) => row.slice(cols[0], cols[1]))
}

/** Contig id range of a genome, from the golden's own `genome_offset`. */
function contigRange(golden: Golden, genome: string): Extent {
  const index = golden.genomes.rows.findIndex((row) => row.name === genome)
  return [golden.indexes.genome_offset[index], golden.indexes.genome_offset[index + 1]]
}

/** Sum of the inclusive upper triangle of a square roll-up. */
function upperTriangleSum(values: ArrayLike<number>, n: number): number {
  let sum = 0
  for (let r = 0; r < n; r++) for (let c = r; c < n; c++) sum += values[r * n + c]
  return sum
}

/** A synthetic symmetric block: `fill(r, c)` is evaluated for `r <= c`. */
function symmetricBlock(n: number, fill: (r: number, c: number) => number): DenseMatrix {
  const values = new Float32Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++) {
      const v = fill(r, c)
      values[r * n + c] = v
      values[c * n + r] = v
    }
  }
  return { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] }
}

describe('groupRuns', () => {
  it('collapses runs in first-appearance order', () => {
    const grouping = groupRuns(Int32Array.from([7, 7, 7, 9, 9, 12]))
    expect(Array.from(grouping.ids)).toEqual([7, 9, 12])
    expect(Array.from(grouping.slot)).toEqual([0, 0, 0, 1, 1, 2])
  })

  it('stays total on an unsorted id vector', () => {
    // Bins arrive sorted by contig under the accepted ordering, so this never
    // happens in a real file; the function is written to be total anyway so a
    // caller that hands it a permutation gets a sensible answer, not a wrong one.
    const grouping = groupRuns(Int32Array.from([5, 2, 5, 2]))
    expect(Array.from(grouping.ids)).toEqual([5, 2])
    expect(Array.from(grouping.slot)).toEqual([0, 1, 0, 1])
  })

  it('handles an empty axis', () => {
    const grouping = groupRuns(new Int32Array(0))
    expect(grouping.ids.length).toBe(0)
    expect(grouping.slot.length).toBe(0)
  })
})

describe.each(fixtureCases())('$label', (fixture) => {
  const goldenAggregate = (level: 'contig' | 'genome'): number[][] =>
    fixture.golden.matrices.find((m) => m.id === `aggregate:${level}`)!.values

  it('rolls a loaded genome block up to its slice of the Python aggregate', async () => {
    const mc = await openCase(fixture)
    try {
      const genomes = fixture.golden.displayable_genomes
      expect(genomes.length).toBeGreaterThan(0)
      for (const genome of genomes) {
        const block = await mc.genomeMatrix(genome)
        if (block.nrows === 0) continue
        const contigs = contigRange(fixture.golden, genome)

        // Contig level: exactly the block of the whole-file contig aggregate
        // that belongs to this genome. Restriction and aggregation commute
        // only if the folding is right.
        const byContig = mc.aggregate(block, 'contig')
        expectMatrixEquals(
          byContig,
          submatrix(goldenAggregate('contig'), contigs, contigs),
          `${fixture.label} ${genome} contig roll-up`,
        )

        // Genome level: a 1×1 block whose single value is the genome's own
        // diagonal entry in the genome-level aggregate.
        const genomeIndex = fixture.golden.genomes.rows.findIndex((r) => r.name === genome)
        const byGenome = mc.aggregate(block, 'genome')
        expect([byGenome.nrows, byGenome.ncols]).toEqual([1, 1])
        expect(byGenome.values[0], `${genome} self-contacts`).toBe(
          goldenAggregate('genome')[genomeIndex][genomeIndex],
        )

        // The invariant behind the fold: the inclusive upper triangle of a
        // symmetric roll-up is the number of *stored* pixels in the block, and
        // the naive sum of the block is strictly larger whenever any group has
        // more than one bin.
        expect(upperTriangleSum(byContig.values, byContig.nrows)).toBe(byGenome.values[0])
        expect(total(block.values)).toBeGreaterThan(total(byContig.values))
      }
    } finally {
      mc.close()
    }
  })

  it('rolls a genome-pair block up without folding it', async () => {
    const mc = await openCase(fixture)
    try {
      const pairs = fixture.golden.matrices.filter((m) => m.id.startsWith('pair:'))
      for (const entry of pairs) {
        const [rowGenome, colGenome] = entry.id.slice('pair:'.length).split('|')
        const block = await mc.genomePairMatrix(rowGenome, colGenome)

        // A rectangular block holds each stored pixel once, so the direct sum
        // is the right one — folding it would halve the answer.
        const byGenome = mc.aggregate(block, 'genome')
        expect([byGenome.nrows, byGenome.ncols]).toEqual([1, 1])
        const rowIndex = fixture.golden.genomes.rows.findIndex((r) => r.name === rowGenome)
        const colIndex = fixture.golden.genomes.rows.findIndex((r) => r.name === colGenome)
        expect(byGenome.values[0], `${rowGenome}×${colGenome} contacts`).toBe(
          goldenAggregate('genome')[rowIndex][colIndex],
        )

        expectMatrixEquals(
          mc.aggregate(block, 'contig'),
          submatrix(
            goldenAggregate('contig'),
            contigRange(fixture.golden, rowGenome),
            contigRange(fixture.golden, colGenome),
          ),
          `${fixture.label} ${entry.id} contig roll-up`,
        )
      }
    } finally {
      mc.close()
    }
  })
})

describe('cost', () => {
  it('performs no I/O at all', async () => {
    const fixture = fixtureCase('basic.metacool')
    const mc = await openCase(fixture)
    const block = await mc.genomeMatrix('MAG_09')
    const reads: string[] = []
    const handle = mc.handle as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const method of ['readNumeric', 'readStrings', 'readTable', 'datasetLength', 'dtype']) {
      const original = handle[method].bind(mc.handle)
      handle[method] = (...args: unknown[]) => {
        reads.push(`${method}(${String(args[0])})`)
        return original(...args)
      }
    }
    try {
      mc.aggregate(block, 'contig')
      mc.aggregate(block, 'genome')
      // §4's cost table calls this operation "free"; that is a claim about I/O
      // and this is the assertion behind it.
      expect(reads).toEqual([])
    } finally {
      mc.close()
    }
  })
})

describe('accumulation width', () => {
  /** One genome of two contigs, two bins each — enough to group by either. */
  const coords = new Coords(1000, Float64Array.from([0, 2, 4]), Float64Array.from([2000, 2000]))
  const genomeIds = Int32Array.from([0, 0])

  it('does not wrap where int32 would', () => {
    // 2^30 is exact in Float32, so the *input* is faithful and the only thing
    // under test is the accumulator. Ten upper-triangle cells of 2^30 sum to
    // 10737418240 — over 2^32, let alone 2^31.
    const block = symmetricBlock(4, () => 2 ** 30)

    const byGenome = aggregateMatrix(block, coords, genomeIds, 'genome')
    expect(byGenome.values).toBeInstanceOf(Float64Array)
    expect(byGenome.values[0]).toBe(10_737_418_240)
    // What an Int32Array accumulator would have produced, spelled out so the
    // test says what it is defending against.
    expect(Int32Array.of(10_737_418_240)[0]).toBe(-2_147_483_648)

    const byContig = aggregateMatrix(block, coords, genomeIds, 'contig')
    expect([byContig.nrows, byContig.ncols]).toEqual([2, 2])
    // 3 cells on each diagonal block, 4 in the off-diagonal one.
    expect(Array.from(byContig.values)).toEqual([
      3 * 2 ** 30,
      4 * 2 ** 30,
      4 * 2 ** 30,
      3 * 2 ** 30,
    ])
    expect(Int32Array.of(3 * 2 ** 30)[0]).toBeLessThan(0) // 3221225472 → −1073741824
    expect(Int32Array.of(4 * 2 ** 30)[0]).toBe(0) // 4294967296 → 0
  })

  it('does not round where Float32 would', () => {
    // 2^24 is the last integer Float32 can hold exactly; 2^24 + 1 is not. A
    // Float32 accumulator therefore absorbs the next twenty single contacts
    // into nothing at all.
    const n = 7
    let ones = 0
    const block = symmetricBlock(n, (r, c) => {
      if (r === 0 && c === 0) return 2 ** 24
      if (r !== c && ones < 20) {
        ones += 1
        return 1
      }
      return 0
    })
    expect(ones).toBe(20)

    const rolled = aggregateMatrix(
      block,
      new Coords(1000, Float64Array.from([0, n]), Float64Array.from([n * 1000])),
      Int32Array.from([0]),
      'genome',
    )
    expect(rolled.values[0]).toBe(2 ** 24 + 20)
    // The same sum in Float32, for contrast: every one of the twenty is lost.
    const f32 = new Float32Array(1)
    f32[0] = 2 ** 24
    for (let i = 0; i < 20; i++) f32[0] += 1
    expect(f32[0]).toBe(2 ** 24)
  })

  it('sums a rectangular block directly, in Float64', () => {
    // Rows and columns cover different bins, so nothing is folded: all 4 cells
    // count, and 4 × 2^30 is 2^32 exactly.
    const values = new Float32Array(4).fill(2 ** 30)
    const block: DenseMatrix = {
      nrows: 2,
      ncols: 2,
      values,
      rowExtent: [0, 2],
      colExtent: [2, 4],
    }
    const rolled = aggregateMatrix(block, coords, genomeIds, 'contig')
    expect([rolled.nrows, rolled.ncols]).toEqual([1, 1])
    expect(rolled.values[0]).toBe(4 * 2 ** 30)
    expect(Array.from(rolled.rowIds)).toEqual([0])
    expect(Array.from(rolled.colIds)).toEqual([1])
  })
})

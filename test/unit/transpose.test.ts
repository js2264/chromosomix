/**
 * The transpose (spec §5.3) — M2's real deliverable.
 *
 * Storage is upper-triangular: every stored pixel has `bin1_id <= bin2_id`. So
 * for a genome pair whose **column** genome precedes its **row** genome in bin
 * space, there is not one stored pixel in the row band the naive query would
 * read. The block must be queried transposed and flipped.
 *
 * Getting this wrong does not throw and does not look broken from the inside:
 * it returns a correctly-shaped block of zeros, and the app draws a blank
 * inter-genome panel — silently deleting the phage–host / plasmid–host / HGT
 * view, which is the one thing no other browser does. That is why the
 * `blank-without-the-flip` test below exists and why it asserts the failure
 * mode explicitly rather than only the success case.
 *
 * Every number is Python's: `MetaCooler.pixels_for_genome_pair` for the COO
 * triplets, `cooler.Cooler.matrix(balance=False)` for the dense blocks.
 */

import { describe, expect, it } from 'vitest'

import { planRead, readPixelSpan, scatterDense } from '@/metacooler/matrix'
import type { Extent } from '@/types'
import {
  expectMatrixEquals,
  fixtureCase,
  fixtureCases,
  openCase,
  total,
  type GoldenPairPixels,
} from '../support/goldens'

/**
 * Build the dense block a pair of genomes *should* have, from the raw stored
 * pixels alone.
 *
 * Deliberately dumb: for each stored `(bin1, bin2, count)` it tries both
 * placements and takes whichever lands inside the block. That is the whole
 * symmetry rule stated once, independently of `matrix.ts`, so the two can
 * disagree. On the diagonal both placements land, and the `bin1 === bin2`
 * guard is what keeps the diagonal from being counted twice.
 */
function denseFromPixels(record: GoldenPairPixels, rows: Extent, cols: Extent): number[][] {
  const [r0, r1] = rows
  const [c0, c1] = cols
  const out = Array.from({ length: r1 - r0 }, () => new Array<number>(c1 - c0).fill(0))
  for (const { bin1_id: b1, bin2_id: b2, count } of record.pixels) {
    if (b1 >= r0 && b1 < r1 && b2 >= c0 && b2 < c1) out[b1 - r0][b2 - c0] += count
    if (b1 !== b2 && b2 >= r0 && b2 < r1 && b1 >= c0 && b1 < c1) out[b2 - r0][b1 - c0] += count
  }
  return out
}

describe.each(fixtureCases())('$label', (fixture) => {
  const pairs = fixture.golden.matrices.filter((m) => m.id.startsWith('pair:'))

  it('loads both orientations of every off-diagonal pair', async () => {
    const mc = await openCase(fixture)
    try {
      // Both orientations of at least one pair, which is the M2 exit criterion.
      expect(pairs.length).toBeGreaterThanOrEqual(2)
      for (const entry of pairs) {
        const [row, col] = entry.id.slice('pair:'.length).split('|')
        const block = await mc.genomePairMatrix(row, col)
        expectMatrixEquals(block, entry.values, `${fixture.label} ${entry.id}`)
      }
    } finally {
      mc.close()
    }
  })

  it('agrees with pixels_for_genome_pair in both orientations', async () => {
    const mc = await openCase(fixture)
    try {
      const records = fixture.golden.pixels_for_genome_pair
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        const rows = mc.genomeExtent(record.g1)
        const cols = mc.genomeExtent(record.g2)
        const block = await mc.genomePairMatrix(record.g1, record.g2)
        expectMatrixEquals(
          block,
          denseFromPixels(record, rows, cols),
          `${fixture.label} pixels_for_genome_pair(${record.g1}, ${record.g2})`,
        )

        // `pixels_for_genome_pair` is symmetric in its arguments — it returns
        // the same stored triplets either way round — so the two blocks must
        // be exact transposes of each other, off-diagonal and on.
        const flipped = await mc.genomePairMatrix(record.g2, record.g1)
        expect([flipped.nrows, flipped.ncols]).toEqual([block.ncols, block.nrows])
        for (let r = 0; r < block.nrows; r++) {
          for (let c = 0; c < block.ncols; c++) {
            const a = block.values[r * block.ncols + c]
            const b = flipped.values[c * flipped.ncols + r]
            if (a !== b) {
              expect.fail(
                `${record.g1}×${record.g2}[${r}, ${c}] is ${a} but ` +
                  `${record.g2}×${record.g1}[${c}, ${r}] is ${b}`,
              )
            }
          }
        }

        // The stored sum is the invariant that separates "mirrored correctly"
        // from "mirrored and double-counted": an off-diagonal block holds each
        // stored pixel once, an on-diagonal one holds every off-diagonal pixel
        // twice and the diagonal once.
        const diagonal =
          record.g1 === record.g2
            ? (() => {
                let d = 0
                for (let i = 0; i < block.nrows; i++) d += block.values[i * block.ncols + i]
                return d
              })()
            : 0
        expect(
          (total(block.values) + diagonal) / (record.g1 === record.g2 ? 2 : 1),
          `stored sum of ${record.g1}×${record.g2}`,
        ).toBe(record.sum)
      }
    } finally {
      mc.close()
    }
  })
})

describe('the transposed orientation, in detail', () => {
  // MAG_10 occupies bins [636, 661) and MAG_04 bins [306, 330): the column
  // range precedes the row range, so this is the §5.3 case. The numbers are
  // Python's, from `basic.metacool`'s golden.
  const label = 'basic.metacool'
  const ROW_GENOME = 'MAG_10'
  const COL_GENOME = 'MAG_04'

  it('plans a transposed read when the columns precede the rows', async () => {
    const mc = await openCase(fixtureCase(label))
    try {
      const rows = mc.genomeExtent(ROW_GENOME)
      const cols = mc.genomeExtent(COL_GENOME)
      expect(cols[1]).toBeLessThanOrEqual(rows[0])
      // The plan reads the *column* band, not the row band, and places every
      // pixel flipped. Deleting the `cols[1] <= rows[0]` branch from planRead
      // turns this red.
      expect(planRead(rows, cols, 'symmetric-upper')).toEqual({ span: cols, mode: 'transpose' })
      // The other orientation of the same pair is stored as written.
      expect(planRead(cols, rows, 'symmetric-upper')).toEqual({ span: cols, mode: 'direct' })
      // Under `square` storage both triangles exist, so the row band is always
      // enough and nothing is ever flipped.
      expect(planRead(rows, cols, 'square')).toEqual({ span: rows, mode: 'direct' })
    } finally {
      mc.close()
    }
  })

  /**
   * **This test exists to fail if the flip is removed.**
   *
   * It asserts both halves of the claim in one place: that the block the
   * reader returns is non-empty and matches Python exactly, *and* that the
   * same pixels placed without the flip are all zero — which is precisely what
   * `scatterDense` produces if `placeFlipped` is dropped, and what a reader
   * that queried the row band would see. Delete the flipped placement in
   * `scatterDense` and `MAG_10 × MAG_04` becomes a blank panel; this test, and
   * every `pixels_for_genome_pair` comparison above it, turns red.
   *
   * Deleting the `transpose` branch of `planRead` instead is a *different*
   * failure and is caught by the two tests either side of this one: the block
   * still comes out correct, because the plan falls through to `symmetric` and
   * mirrors — but the span read grows from one genome's bins to everything
   * between the two genomes, which on a real file is most of the pixel table.
   * The transpose branch buys the bounded read; `placeFlipped` buys the data.
   */
  it('is blank without the flip, and correct with it', async () => {
    const fixture = fixtureCase(label)
    const mc = await openCase(fixture)
    try {
      const rows = mc.genomeExtent(ROW_GENOME)
      const cols = mc.genomeExtent(COL_GENOME)
      const golden = fixture.golden.matrices.find(
        (m) => m.id === `pair:${ROW_GENOME}|${COL_GENOME}`,
      )!

      const block = await mc.genomePairMatrix(ROW_GENOME, COL_GENOME)
      expectMatrixEquals(block, golden.values, `${label} pair:${ROW_GENOME}|${COL_GENOME}`)
      // Non-empty, so "all zeros" cannot pass as agreement with the golden.
      expect(total(block.values)).toBe(103)
      expect(Array.from(block.values).filter((v) => v !== 0).length).toBeGreaterThan(0)

      // What a reader without the transpose would return: read the row band
      // [636, 661) and place directly. Storage is upper-triangular and MAG_10
      // is the *last* genome, so nothing in that band has a column below 636.
      const rowBand = readPixelSpan(mc.handle, rows[0], rows[1])
      const naive = new Float32Array((rows[1] - rows[0]) * (cols[1] - cols[0]))
      scatterDense(rowBand, rows, cols, { span: rows, mode: 'direct' }, naive)
      expect(total(naive), 'the blank panel the transpose exists to prevent').toBe(0)

      // And the same for dropping only the flipped *placement* while keeping
      // the transposed span: the pixels are read, and then discarded.
      const colBand = readPixelSpan(mc.handle, cols[0], cols[1])
      expect(colBand.length).toBeGreaterThan(0)
      const unflipped = new Float32Array(naive.length)
      scatterDense(colBand, rows, cols, { span: cols, mode: 'direct' }, unflipped)
      expect(total(unflipped), 'pixels read but never flipped into place').toBe(0)
    } finally {
      mc.close()
    }
  })

  it('reads the column band, not the row band', async () => {
    const fixture = fixtureCase(label)
    const mc = await openCase(fixture)
    const spans: [number, number][] = []
    const handle = mc.handle as unknown as {
      readNumeric: (p: string, lo?: number, hi?: number) => Float64Array
    }
    const original = handle.readNumeric.bind(mc.handle)
    handle.readNumeric = (path: string, lo?: number, hi?: number) => {
      if (path === 'indexes/bin1_offset' && lo !== undefined && hi !== undefined) {
        spans.push([lo, hi])
      }
      return original(path, lo, hi)
    }
    try {
      await mc.genomePairMatrix(ROW_GENOME, COL_GENOME)
      // One slice, over MAG_04's bins — the transposed span. `hi + 1` is the
      // offset array's terminator, not an extra bin.
      expect(spans).toEqual([[306, 331]])
    } finally {
      mc.close()
    }
  })
})

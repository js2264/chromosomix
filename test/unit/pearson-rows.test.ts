/**
 * The correlation matrix's arithmetic (`analysis/pearsonRows.ts`), held to the
 * statistic it replaced.
 *
 * `stats.ts`'s `pearson` is the definition: two passes over the cells both rows
 * have, `NaN` for fewer than three of them or a row with no spread. The fast path
 * gets there differently — one product for every pair, and each row's totals
 * corrected for what the other row lacks, or a masked pass where the rows lack a
 * lot — so every road is compared against the definition, pair by pair, on
 * squares chosen to exercise it: no gaps, a few, most of a block, flat rows,
 * sizes that are not a multiple of the kernel's steps.
 *
 * Both engines are held to it: the WebAssembly kernel, and the same loops in
 * JavaScript that stand in where the kernel cannot load.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { gramKernelAvailable, pearsonRows, type PearsonEngine } from '@/analysis/pearsonRows'
import { pearson } from '@/analysis/stats'
import { GRAM_SOURCE_SHA256 } from '@/analysis/wasm/gram.generated'

/** A seeded square, O/E-like: centred on one, with a checkerboard in it. */
function square(m: number, seed = 1): Float64Array {
  let s = seed
  const next = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const out = new Float64Array(m * m)
  for (let r = 0; r < m; r++) {
    for (let c = r; c < m; c++) {
      const value = 1 + ((r % 7 < 3) === (c % 7 < 3) ? 0.4 : -0.3) + (next() - 0.5) * 0.8
      out[r * m + c] = value
      out[c * m + r] = value
    }
  }
  return out
}

/** Every pair's `r`, by the fast path, as `NaN` where it has none. */
async function fast(values: Float64Array, m: number, engine: PearsonEngine): Promise<Float64Array> {
  const out = new Float64Array(m * m).fill(Number.NaN)
  await pearsonRows(
    { m, row: (r, into) => into.set(values.subarray(r * m, (r + 1) * m)) },
    (a, line) => {
      for (let b = a + 1; b < m; b++) out[a * m + b] = line[b]
    },
    undefined,
    { engine },
  )
  return out
}

/** The largest disagreement with `pearson` over every pair, and whether `NaN` fell in the same places. */
async function against(values: Float64Array, m: number, engine: PearsonEngine) {
  const got = await fast(values, m, engine)
  let worst = 0
  let nanMismatch = 0
  for (let a = 0; a < m; a++) {
    const row = values.subarray(a * m, (a + 1) * m)
    for (let b = a + 1; b < m; b++) {
      const want = pearson(row, values.subarray(b * m, (b + 1) * m))
      const have = got[a * m + b]
      if (Number.isNaN(want) !== Number.isNaN(have)) {
        nanMismatch++
        continue
      }
      if (!Number.isNaN(want)) worst = Math.max(worst, Math.abs(want - have))
    }
  }
  return { worst, nanMismatch }
}

const ENGINES: PearsonEngine[] = ['wasm', 'simd', 'js']
const ENGINE_NAMES: Record<PearsonEngine, string> = {
  wasm: 'WebAssembly kernel with relaxed SIMD',
  simd: 'WebAssembly kernel with SIMD alone',
  js: 'JavaScript loops',
}

describe('the correlation of every pair of rows', () => {
  it('loads both builds of the WebAssembly kernel here, so both fast roads are the ones tested', () => {
    expect(gramKernelAvailable('relaxed')).toBe(true)
    expect(gramKernelAvailable('simd')).toBe(true)
  })

  for (const engine of ENGINES) {
    describe(`by the ${ENGINE_NAMES[engine]}`, () => {
      it('agrees with the two-pass statistic on a square with no gaps', async () => {
        // 67: not a multiple of four, of a band, or of a block.
        const m = 67
        const { worst, nanMismatch } = await against(square(m), m, engine)
        expect(nanMismatch).toBe(0)
        expect(worst).toBeLessThan(2e-6)
      })

      it('agrees over the cells both rows have, where a few are missing', async () => {
        // The compartment chain's shape: the diagonal and the two beside it
        // missing, and here and there a cell with no expectation.
        const m = 150
        const values = square(m, 7)
        for (let r = 0; r < m; r++) {
          for (let c = Math.max(0, r - 1); c <= Math.min(m - 1, r + 1); c++) values[r * m + c] = Number.NaN
        }
        for (let i = 0; i < 40; i++) {
          const r = (i * 37) % m
          const c = (i * 91 + 13) % m
          values[r * m + c] = Number.NaN
          values[c * m + r] = Number.NaN
        }
        const { worst, nanMismatch } = await against(values, m, engine)
        expect(nanMismatch).toBe(0)
        expect(worst).toBeLessThan(2e-6)
      })

      it('agrees where rows are missing whole blocks — the masked pass', async () => {
        // A trans-only square: every sequence's own block blanked, so each row
        // shares with another only the columns neither sequence covers.
        const m = 130
        const values = square(m, 11)
        const groupOf = (i: number): number => (i < 40 ? 0 : i < 95 ? 1 : 2)
        for (let r = 0; r < m; r++) {
          for (let c = 0; c < m; c++) if (groupOf(r) === groupOf(c)) values[r * m + c] = Number.NaN
        }
        const { worst, nanMismatch } = await against(values, m, engine)
        expect(nanMismatch).toBe(0)
        expect(worst).toBeLessThan(2e-6)
      })

      it('gives no correlation for a flat row, or for a pair with fewer than three cells in common', async () => {
        const m = 24
        const values = square(m, 3)
        // Row 5 is the same number everywhere: no spread, so no r with anything.
        for (let c = 0; c < m; c++) values[5 * m + c] = 1.25
        // Rows 8 and 9 share exactly two cells.
        for (let c = 0; c < m; c++) {
          if (c >= 2) values[8 * m + c] = Number.NaN
          if (c !== 0 && c !== 1 && c !== 20) values[9 * m + c] = Number.NaN
        }
        values[9 * m + 20] = 3
        const got = await fast(values, m, engine)
        for (let b = 6; b < m; b++) expect(got[5 * m + b], `r(5, ${b})`).toBeNaN()
        expect(got[8 * m + 9]).toBeNaN()
        const { nanMismatch } = await against(values, m, engine)
        expect(nanMismatch).toBe(0)
      })

      it('finds a perfect checkerboard perfectly', async () => {
        const m = 20
        const values = new Float64Array(m * m)
        for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) values[r * m + c] = r % 2 === c % 2 ? 2 : 0.5
        const got = await fast(values, m, engine)
        for (let a = 0; a < m; a++) {
          for (let b = a + 1; b < m; b++) expect(got[a * m + b]).toBeCloseTo(a % 2 === b % 2 ? 1 : -1, 6)
        }
      })
    })
  }

  it('gives the three engines the same answers', async () => {
    const m = 90
    const values = square(m, 21)
    for (let i = 0; i < 60; i++) values[((i * 53) % m) * m + ((i * 17) % m)] = Number.NaN
    const b = await fast(values, m, 'js')
    for (const engine of ['wasm', 'simd'] as const) {
      const a = await fast(values, m, engine)
      let worst = 0
      for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) worst = Math.max(worst, Math.abs(a[i] - b[i]))
      expect(worst).toBeLessThan(2e-6)
    }
  })

  it('asks after every row, in order, and stops when the question throws', async () => {
    const m = 150
    const asked: number[] = []
    await expect(
      pearsonRows(
        { m, row: (r, into) => into.fill(r % 3) },
        () => {},
        async (row) => {
          asked.push(row)
          await Promise.resolve()
          if (row === 70) throw new Error('stopped')
        },
      ),
    ).rejects.toThrow('stopped')
    expect(asked).toEqual([...Array(71).keys()])
  })

  it('runs the kernel built from the C beside it', () => {
    // `npm run wasm` records the hash of the source it compiled. A change to
    // `gram.c` that was not rebuilt fails here rather than shipping the old
    // kernel under the new source.
    const source = readFileSync(new URL('../../src/analysis/wasm/gram.c', import.meta.url))
    expect(createHash('sha256').update(source).digest('hex')).toBe(GRAM_SOURCE_SHA256)
  })
})

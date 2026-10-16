/**
 * Values the file does not contain.
 *
 * Every function under test produces a picture that looks entirely plausible
 * when it is wrong, which is the reason for pinning each of them to arithmetic
 * done by hand rather than to a snapshot:
 *
 * - a coverage normalisation that divides by raw marginals instead of
 *   mean-normalised ones still flattens the map, and only the *numbers* — every
 *   one of them a thousand times smaller — say so;
 * - a balancing pass that alternates row and column updates over a symmetric
 *   matrix converges to flat marginals too, and draws a seam down the diagonal
 *   that reads as structure;
 * - an expected model that measures separation in row and column *indices*
 *   rather than in absolute bins is correct on every on-diagonal block and wrong
 *   on every other one;
 * - and a ratio that folds `x / 0` to zero rather than to infinity turns "only
 *   in this file" into "in neither", which is the opposite reading.
 *
 * The outer-product identity does most of the work below. A matrix `v[i][j] =
 * a[i] * b[j]` is exactly what a pure coverage bias looks like — every cell is
 * the product of two per-bin factors and nothing else — so a correct correction
 * must flatten it to a constant, and the constant is computable in one line.
 */

import { describe, expect, it } from 'vitest'

import {
  BALANCE_TOLERANCE,
  balanceBlock,
  coverageNormalise,
  deriveBlock,
  expectedModel,
  expectedValues,
  isNormalisation,
  marginalsOf,
  observedOverExpected,
  paperZeros,
  type AxisRun,
  type BlockValues,
} from '@/render/derive'
import { armOffsets } from '@/analysis/arms'
import { autoSymmetricRange, transformValues } from '@/render/scale'
import { poolDisplay } from '@/render/heatmap'
import { combine, blendAcrossDiagonal } from '@/render/compare'

function block(
  nrows: number,
  ncols: number,
  fill: (row: number, col: number) => number,
  rowExtent: [number, number] = [0, nrows],
  colExtent: [number, number] = [0, ncols],
): BlockValues {
  const values = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) values[r * ncols + c] = fill(r, c)
  }
  return { nrows, ncols, values, rowExtent, colExtent }
}

/** `v[i][j] = a[i] * b[j]` — a matrix whose every cell is pure per-bin bias. */
function outerProduct(a: readonly number[], b: readonly number[]): BlockValues {
  return block(a.length, b.length, (r, c) => a[r] * b[c])
}

function rowSums(values: ArrayLike<number>, nrows: number, ncols: number): number[] {
  const out: number[] = []
  for (let r = 0; r < nrows; r++) {
    let sum = 0
    for (let c = 0; c < ncols; c++) {
      const value = values[r * ncols + c]
      if (Number.isFinite(value)) sum += value
    }
    out.push(sum)
  }
  return out
}

function colSums(values: ArrayLike<number>, nrows: number, ncols: number): number[] {
  const out: number[] = []
  for (let c = 0; c < ncols; c++) {
    let sum = 0
    for (let r = 0; r < nrows; r++) {
      const value = values[r * ncols + c]
      if (Number.isFinite(value)) sum += value
    }
    out.push(sum)
  }
  return out
}

describe('marginals', () => {
  it('sums each axis', () => {
    const { rows, cols } = marginalsOf(block(2, 3, (r, c) => r * 3 + c))
    expect([...rows]).toEqual([3, 12])
    expect([...cols]).toEqual([3, 5, 7])
  })

  it('skips non-finite cells rather than propagating them', () => {
    // One discarded bin would otherwise turn the marginal of every bin it
    // touches into NaN, and every normalisation below divides by a marginal —
    // so a single NaN would blank the whole map.
    const b = block(2, 2, (r, c) => (r === 0 && c === 1 ? Number.NaN : 2))
    const { rows, cols } = marginalsOf(b)
    expect([...rows]).toEqual([2, 4])
    expect([...cols]).toEqual([4, 2])
  })
})

describe('coverage normalisation', () => {
  it('flattens a pure outer product, which is what a coverage bias is', () => {
    const out = coverageNormalise(outerProduct([1, 2, 4], [1, 2, 4]), 1)
    // mean(a) * mean(b) — the constant a correct VC leaves behind.
    const expected = (7 / 3) * (7 / 3)
    for (const value of out) expect(value).toBeCloseTo(expected, 5)
  })

  it('stays in the units it started in, rather than collapsing towards 1/total', () => {
    // The failure this pins is dividing by *raw* marginals: the map still comes
    // out flat, but every value is smaller by a factor of the library depth, so
    // a stored colour clip and the readout both silently change meaning.
    const counts = outerProduct([10, 20, 40], [10, 20, 40])
    const scaled = outerProduct([1000, 2000, 4000], [1000, 2000, 4000])
    const a = coverageNormalise(counts, 1)
    const b = coverageNormalise(scaled, 1)
    // Ten thousand times the counts is ten thousand times the corrected value —
    // a scalar on the whole library survives, only the per-bin part is removed.
    for (let i = 0; i < a.length; i++) expect(b[i] / a[i]).toBeCloseTo(1e4, 3)
  })

  it('halves the correction under the square-root convention', () => {
    const b = block(2, 2, (r, c) => [1, 2][r] * [1, 2][c])
    // Marginals [3, 6] on both axes, mean 4.5, so the scales are [2/3, 4/3].
    const full = coverageNormalise(b, 1)
    const half = coverageNormalise(b, 0.5)
    expect(full[0]).toBeCloseTo(1 / ((2 / 3) * (2 / 3)), 5)
    expect(half[0]).toBeCloseTo(1 / Math.sqrt((2 / 3) * (2 / 3)), 5)
    // Every cell of the half-strength result is the geometric mean of the raw
    // value and the fully corrected one, which is what "half the correction" is.
    for (let i = 0; i < half.length; i++) {
      expect(half[i]).toBeCloseTo(Math.sqrt(b.values[i] * full[i]), 4)
    }
  })

  it('gives a bin with no coverage no value at all', () => {
    const out = coverageNormalise(block(2, 2, (r, c) => (r === 1 || c === 1 ? 0 : 5)), 1)
    expect(out[0]).toBeGreaterThan(0)
    expect(Number.isNaN(out[1])).toBe(true)
    expect(Number.isNaN(out[2])).toBe(true)
    expect(Number.isNaN(out[3])).toBe(true)
  })
})

describe('iterative balancing', () => {
  it('flattens the marginals of a matrix a single pass cannot', () => {
    // Not an outer product, so VC leaves a residue and only the fixed point
    // gets there. The asymmetric entries are what make the two differ.
    const b = block(4, 4, (r, c) => 1 + ((r * 7 + c * 3) % 5) + (r === c ? 20 : 0))
    const balanced = balanceBlock(b).values
    const sums = rowSums(balanced, 4, 4)
    const mean = sums.reduce((a, x) => a + x, 0) / sums.length
    for (const sum of sums) expect(Math.abs(sum / mean - 1)).toBeLessThan(BALANCE_TOLERANCE * 10)
  })

  it('keeps a symmetric matrix symmetric to the bit', () => {
    // Alternating row and column updates converges to flat marginals too, but
    // leaves the two triangles subtly different — which draws a seam along the
    // diagonal that a reader takes for structure.
    const b = block(5, 5, (r, c) => 1 + ((r * c) % 4) + (r === c ? 9 : 0))
    const balanced = balanceBlock(b).values
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        expect(balanced[r * 5 + c]).toBe(balanced[c * 5 + r])
      }
    }
  })

  it('agrees with coverage normalisation where the bias really is an outer product', () => {
    // The one case both methods have an exact answer for, so they must give the
    // same picture: both flatten it completely, and they can differ only by the
    // overall scalar each chooses.
    const b = outerProduct([1, 3, 9, 27], [1, 3, 9, 27])
    const balanced = balanceBlock(b).values
    const first = balanced[0]
    // To the convergence tolerance rather than to a decimal count, and to a
    // small multiple of it rather than to the number itself: the loop stops when
    // the *marginals* are flat to `BALANCE_TOLERANCE`, and every cell carries
    // the residual error of the two weights that scale it, so the cell-level
    // bound is a couple of times the marginal one by construction.
    for (const value of balanced) {
      expect(Math.abs(value / first - 1)).toBeLessThan(4 * BALANCE_TOLERANCE)
    }
  })

  it('drops empty bins instead of dragging every other bin towards them', () => {
    const b = block(3, 3, (r, c) => (r === 1 || c === 1 ? 0 : 4))
    const balanced = balanceBlock(b).values
    for (let i = 0; i < 3; i++) {
      expect(Number.isNaN(balanced[1 * 3 + i])).toBe(true)
      expect(Number.isNaN(balanced[i * 3 + 1])).toBe(true)
    }
    expect(balanced[0]).toBeGreaterThan(0)
  })

  it('balances a rectangular block on both axes independently', () => {
    const b = block(2, 4, (r, c) => (r + 1) * (c + 1), [0, 2], [10, 14])
    const balanced = balanceBlock(b).values
    const rows = rowSums(balanced, 2, 4)
    const cols = colSums(balanced, 2, 4)
    expect(rows[0]).toBeCloseTo(rows[1], 6)
    for (const sum of cols) expect(sum).toBeCloseTo(cols[0], 6)
  })
})

describe('expected, and observed over it', () => {
  const runs = (label: string, end: number): AxisRun[] => [{ label, start: 0, end }]

  it('averages each bin separation over the whole block', () => {
    const decay = [10, 5, 2, 1]
    const b = block(4, 4, (r, c) => decay[Math.abs(r - c)])
    const model = expectedModel(b, { rows: runs('c', 4), cols: runs('c', 4) })
    expect([...model.cis]).toEqual(decay)
    // Nothing is trans, so there is no scalar to report.
    expect(Number.isNaN(model.trans)).toBe(true)
  })

  it('reports a cell as its multiple of what its distance predicts', () => {
    const decay = [10, 5, 2, 1]
    const b = block(4, 4, (r, c) => (r === 0 && c === 2 ? 4 : decay[Math.abs(r - c)]))
    const oe = observedOverExpected(b, { rows: runs('c', 4), cols: runs('c', 4) })
    // Separation 2 holds [0][2]=4 and three cells of 2, so expected is 2.5.
    expect(oe[0 * 4 + 2]).toBeCloseTo(4 / 2.5, 5)
    expect(oe[2 * 4 + 0]).toBeCloseTo(2 / 2.5, 5)
    // Every other separation is uniform, so it is exactly its own expectation.
    expect(oe[0]).toBeCloseTo(1, 6)
    expect(oe[1]).toBeCloseTo(1, 6)
  })

  it('sizes the curve by the block, not by how far apart its two windows are', () => {
    // A 2 × 2 block covering two windows of one contig three million bins apart.
    // Indexed by absolute separation the curve would need three million entries
    // — 24 MB, for four cells — so it is indexed from the block's own smallest
    // separation instead.
    const b = block(2, 2, () => 1, [0, 2], [3_000_000, 3_000_002])
    const model = expectedModel(b, { rows: runs('c', 2), cols: runs('c', 2) })
    expect(model.cis.length).toBeLessThanOrEqual(2 + 2)
    expect(model.base).toBe(2_999_999)
    // And it still answers at the right separations.
    const oe = observedOverExpected(b, { rows: runs('c', 2), cols: runs('c', 2) }, model)
    for (const value of oe) expect(value).toBeCloseTo(1, 6)
  })

  it('measures separation in absolute bins, not in row and column indices', () => {
    // A block covering two distant windows of one contig. Judged by indices,
    // cell [0][0] would be separation 0 — the brightest cell in any map — when
    // it is in fact a hundred bins apart and should be nowhere near the diagonal.
    const b = block(2, 2, () => 1, [0, 2], [100, 102])
    const model = expectedModel(b, { rows: runs('c', 2), cols: runs('c', 2) })
    // The closest any two ends of this block come is 99 bins, so nothing in it
    // sits on the diagonal — which is the whole point. Judged by row and column
    // index, cell [0][0] would be separation 0, the brightest cell in any map.
    expect(model.base).toBe(99)
    // Separations 99, 100 and 101, and nothing else: `cis[0]` is 99 apart here,
    // not 0 apart.
    expect(model.cis).toHaveLength(3)
    for (const value of model.cis) expect(value).toBeCloseTo(1, 6)
  })

  it('separates sequences: one curve within, one scalar between', () => {
    const rowRuns: AxisRun[] = [
      { label: 'a', start: 0, end: 2 },
      { label: 'b', start: 2, end: 4 },
    ]
    // 8 within a sequence at every separation, 1 between them.
    const b = block(4, 4, (r, c) => (r < 2 === c < 2 ? 8 : 1))
    const model = expectedModel(b, { rows: rowRuns, cols: rowRuns })
    expect(model.cis[0]).toBeCloseTo(8, 6)
    expect(model.cis[1]).toBeCloseTo(8, 6)
    expect(model.trans).toBeCloseTo(1, 6)
    // Which makes every cell exactly its own expectation, in both regimes — a
    // pooled model that ignored the run boundary would put the trans cells far
    // below 1 and invent a checkerboard.
    const oe = observedOverExpected(b, { rows: rowRuns, cols: rowRuns })
    for (const value of oe) expect(value).toBeCloseTo(1, 5)
  })

  it('treats an unlabelled axis as one sequence', () => {
    // A plain cooler read as a single span has no runs, and every cell of it is
    // within one sequence.
    const b = block(3, 3, (r, c) => (r === c ? 9 : 3))
    const model = expectedModel(b, { rows: [], cols: [] })
    expect(model.cis[0]).toBeCloseTo(9, 6)
    expect(model.cis[1]).toBeCloseTo(3, 6)
    expect(Number.isNaN(model.trans)).toBe(true)
  })

  it('has no ratio to a baseline that does not exist', () => {
    const b = block(2, 2, () => 0)
    const oe = observedOverExpected(b, { rows: [], cols: [] })
    for (const value of oe) expect(Number.isNaN(value)).toBe(true)
  })

  it('leaves a cell of nothing observed as paper, not as maximum depletion', () => {
    // Zero over anything is zero, and on a scale centred at 1 that is the far
    // end of the ramp — so a sparse block came out as a wall of "maximally
    // depleted" over every empty pixel, which is the loudest possible statement
    // of the one thing the file does not say. `NaN` draws as paper, which is
    // what an unmeasured cell already looks like everywhere else in the app.
    const far = (r: number, c: number): boolean => Math.abs(r - c) === 2
    const b = block(3, 3, (r, c) => (r === c ? 10 : far(r, c) ? 0 : 4))
    const oe = observedOverExpected(b, { rows: [], cols: [] })
    expect(Number.isNaN(oe[0 * 3 + 2])).toBe(true)
    // …and its mirror, which is the same missing observation.
    expect(Number.isNaN(oe[2 * 3 + 0])).toBe(true)
    // Everything measured is still a number, including the cells at the same
    // separation that pulled the baseline down.
    expect(oe[0 * 3 + 1]).toBeGreaterThan(0)
    expect(oe[1 * 3 + 1]).toBeCloseTo(1, 6)
  })

  it('leaves an infinite ratio as paper too', () => {
    // The same claim from the other end: a baseline too small to divide by is a
    // fact about the baseline, not a measurement of anything.
    const b = block(2, 2, (r, c) => (r === c ? 1 : Number.MAX_VALUE))
    const model = expectedModel(b, { rows: [], cols: [] })
    // Force the pathological case rather than waiting for a file to produce it.
    model.cis[1] = Number.MIN_VALUE
    const oe = observedOverExpected(b, { rows: [], cols: [] }, model)
    expect(Number.isNaN(oe[0 * 2 + 1])).toBe(true)
    expect(oe[0]).toBeCloseTo(1, 6)
  })

  it('keeps a negative ratio, which an extra column may legitimately hold', () => {
    // `/pixels` can carry any float column the creator wrote, and blanking the
    // negatives would be this rule deciding what a file is allowed to contain.
    // Separation 1 holds −2 and 6, so its baseline is 2 and the two cells are
    // −1× and 3× it.
    const b = block(2, 2, (r, c) => (r === c ? 4 : r === 0 ? -2 : 6))
    const oe = observedOverExpected(b, { rows: [], cols: [] })
    expect(oe[0 * 2 + 1]).toBeCloseTo(-1, 6)
    expect(oe[1 * 2 + 0]).toBeCloseTo(3, 6)
    expect(oe[0]).toBeCloseTo(1, 6)
  })
})

describe('the O/E the correlation reads', () => {
  // A sparse block: every cell a third of the way round is empty, and the rest
  // fall off with distance. Two sequences, so there are trans cells too.
  const runs: AxisRun[] = [
    { label: 'a', start: 0, end: 5 },
    { label: 'b', start: 5, end: 9 },
  ]
  const axes = { rows: runs, cols: runs }
  const sparse = block(9, 9, (r, c) => ((r * 9 + c) % 3 === 0 && r !== c ? 0 : 12 / (1 + Math.abs(r - c))))

  it('keeps a cell of nothing observed as the zero it is', () => {
    const drawn = observedOverExpected(sparse, axes)
    const read = observedOverExpected(sparse, axes, undefined, true)
    let zeros = 0
    for (let i = 0; i < read.length; i++) {
      if (sparse.values[i] !== 0) continue
      zeros++
      // Paper in the picture, an observation of no contacts in the correlation.
      expect(Number.isNaN(drawn[i])).toBe(true)
      expect(read[i]).toBe(0)
    }
    expect(zeros).toBeGreaterThan(10)
  })

  it('still has no ratio where there is no baseline, or no observation', () => {
    const empty = block(2, 2, () => 0)
    for (const value of observedOverExpected(empty, { rows: [], cols: [] }, undefined, true)) {
      expect(Number.isNaN(value)).toBe(true)
    }
    const gap = block(3, 3, (r) => (r === 1 ? Number.NaN : 5))
    const read = observedOverExpected(gap, { rows: [], cols: [] }, undefined, true)
    expect(Number.isNaN(read[1 * 3 + 2])).toBe(true)
    expect(read[0]).toBeCloseTo(1, 6)
  })

  /** The picture, derived as it always was, and the correlation's ratio made paper. */
  const both = (derivation: Parameters<typeof deriveBlock>[1], target = sparse, on = axes) => ({
    drawn: deriveBlock(target, derivation, on),
    read: deriveBlock(target, { ...derivation, keepZeros: true }, on),
  })

  it('differs from the picture in its zeros and nowhere else, whichever way the ratio is taken', () => {
    const N = 12
    const frame = { n: N, origin: 0, circular: true }
    const bins = Int32Array.from({ length: N }, (_, i) => i)
    const circle = block(N, N, (r, c) => ((r + 2 * c) % 5 === 0 && r !== c ? 0 : 30 / (1 + Math.abs(r - c))))
    const chr = { rows: [{ label: 'chr', start: 0, end: N }], cols: [{ label: 'chr', start: 0, end: N }] }
    for (const [name, pair] of [
      ['the decay', both({ expected: true })],
      ['a despeckle first', both({ expected: true, smooth: '1' })],
      ['both arms', both({ expected: true, arms: { frame, rowBins: bins, colBins: bins, window: 0 } }, circle, chr)],
    ] as const) {
      const { drawn, read } = pair
      expect(read.label, name).toBe(drawn.label)
      expect(read.neutral, name).toBe(drawn.neutral)
      const made = paperZeros(read.values, { expected: true })
      expect(made, name).not.toBe(read.values)
      for (let i = 0; i < made.length; i++) {
        if (Number.isNaN(drawn.values[i])) expect(Number.isNaN(made[i]), `${name} at ${i}`).toBe(true)
        else expect(made[i], `${name} at ${i}`).toBe(drawn.values[i])
      }
    }
  })

  it('leaves a field that was not divided exactly as it came', () => {
    const counts = deriveBlock(sparse, {}, axes).values
    expect(paperZeros(counts, {})).toBe(counts)
    const baseline = deriveBlock(sparse, { expected: true, baseline: true }, axes).values
    expect(paperZeros(baseline, { expected: true, baseline: true })).toBe(baseline)
  })
})

describe('the O/E, cell by cell', () => {
  /** The definition, one cell at a time, as the loops it is checked against once were. */
  function reference(b: BlockValues, rows: readonly AxisRun[], cols: readonly AxisRun[]) {
    const label = (axis: readonly AxisRun[], i: number): string | null =>
      axis.find((run) => i >= run.start && i < run.end)?.label ?? null
    const sums = new Map<number, number>()
    const counts = new Map<number, number>()
    let transSum = 0
    let transCount = 0
    for (let r = 0; r < b.nrows; r++) {
      for (let c = 0; c < b.ncols; c++) {
        const value = b.values[r * b.ncols + c]
        if (!Number.isFinite(value)) continue
        if (label(rows, r) === label(cols, c)) {
          const d = Math.abs(b.rowExtent[0] + r - (b.colExtent[0] + c))
          sums.set(d, (sums.get(d) ?? 0) + value)
          counts.set(d, (counts.get(d) ?? 0) + 1)
        } else {
          transSum += value
          transCount++
        }
      }
    }
    const trans = transCount > 0 ? transSum / transCount : Number.NaN
    const oe = new Float32Array(b.nrows * b.ncols)
    for (let r = 0; r < b.nrows; r++) {
      for (let c = 0; c < b.ncols; c++) {
        const value = b.values[r * b.ncols + c]
        const d = Math.abs(b.rowExtent[0] + r - (b.colExtent[0] + c))
        const expected = label(rows, r) === label(cols, c) ? (sums.get(d) ?? Number.NaN) / (counts.get(d) ?? Number.NaN) : trans
        const ratio = Number.isFinite(value) && expected > 0 ? value / expected : Number.NaN
        oe[r * b.ncols + c] = ratio !== 0 && Number.isFinite(ratio) ? ratio : Number.NaN
      }
    }
    return { oe, trans }
  }

  it('agrees with the definition over several sequences, off the diagonal and across it', () => {
    let seed = 11
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const cases: { rows: AxisRun[]; cols: AxisRun[]; rowExtent: [number, number]; colExtent: [number, number] }[] = [
      // Three sequences on both axes, over the diagonal.
      {
        rows: [
          { label: 'a', start: 0, end: 7 },
          { label: 'b', start: 7, end: 11 },
          { label: 'c', start: 11, end: 20 },
        ],
        cols: [
          { label: 'a', start: 0, end: 7 },
          { label: 'b', start: 7, end: 11 },
          { label: 'c', start: 11, end: 20 },
        ],
        rowExtent: [0, 20],
        colExtent: [0, 20],
      },
      // Two windows that overlap, so the diagonal crosses the block partway.
      { rows: [{ label: 'x', start: 0, end: 13 }], cols: [{ label: 'x', start: 0, end: 17 }], rowExtent: [40, 53], colExtent: [46, 63] },
      // A window wholly to one side of the other, with a sequence change on the columns.
      {
        rows: [{ label: 'x', start: 0, end: 9 }],
        cols: [
          { label: 'x', start: 0, end: 6 },
          { label: 'y', start: 6, end: 15 },
        ],
        rowExtent: [100, 109],
        colExtent: [0, 15],
      },
      // And no runs at all.
      { rows: [], cols: [], rowExtent: [5, 21], colExtent: [9, 20] },
    ]
    for (const { rows, cols, rowExtent, colExtent } of cases) {
      const nrows = rowExtent[1] - rowExtent[0]
      const ncols = colExtent[1] - colExtent[0]
      const b = block(
        nrows,
        ncols,
        () => {
          const x = noise()
          return x < 0.1 ? 0 : x < 0.15 ? Number.NaN : x < 0.17 ? -x : 50 * x
        },
        rowExtent,
        colExtent,
      )
      const want = reference(b, rows, cols)
      const got = observedOverExpected(b, { rows, cols })
      for (let i = 0; i < got.length; i++) {
        if (Number.isNaN(want.oe[i])) expect(Number.isNaN(got[i])).toBe(true)
        else expect(got[i]).toBe(want.oe[i])
      }
      const model = expectedModel(b, { rows, cols })
      if (Number.isNaN(want.trans)) expect(Number.isNaN(model.trans)).toBe(true)
      else expect(model.trans).toBeCloseTo(want.trans, 12)
    }
  })
})

describe('the baseline, drawn instead of divided by', () => {
  const runs = (label: string, end: number): AxisRun[] => [{ label, start: 0, end }]

  it('replaces every cell by what its own O/E would divide it by', () => {
    const decay = [10, 5, 2, 1]
    const b = block(4, 4, (r, c) => (r === 0 && c === 2 ? 4 : decay[Math.abs(r - c)]))
    const axes = { rows: runs('c', 4), cols: runs('c', 4) }
    const baseline = expectedValues(b, axes)
    const oe = observedOverExpected(b, axes)
    // Separation 2 holds [0][2]=4 and three cells of 2, so its baseline is 2.5 —
    // the same 2.5 the ratio above it was taken against, at every cell.
    expect(baseline[0 * 4 + 2]).toBeCloseTo(2.5, 6)
    expect(baseline[2 * 4 + 0]).toBeCloseTo(2.5, 6)
    for (let i = 0; i < baseline.length; i++) {
      expect(b.values[i] / baseline[i]).toBeCloseTo(oe[i], 5)
    }
    // Constant along each diagonal, which is the whole content of the picture.
    expect(baseline[0]).toBeCloseTo(10, 6)
    expect(baseline[1 * 4 + 1]).toBeCloseTo(10, 6)
  })

  it('carries the trans scalar onto every cell between two sequences', () => {
    const axes: { rows: AxisRun[]; cols: AxisRun[] } = {
      rows: [
        { label: 'a', start: 0, end: 2 },
        { label: 'b', start: 2, end: 4 },
      ],
      cols: [
        { label: 'a', start: 0, end: 2 },
        { label: 'b', start: 2, end: 4 },
      ],
    }
    const b = block(4, 4, (r, c) => (r < 2 === c < 2 ? 8 : 1))
    const baseline = expectedValues(b, axes)
    expect(baseline[0 * 4 + 3]).toBeCloseTo(1, 6)
    expect(baseline[3 * 4 + 0]).toBeCloseTo(1, 6)
    expect(baseline[0]).toBeCloseTo(8, 6)
  })

  it('is absent exactly where the ratio has no denominator', () => {
    // A cell the block has no value for stays absent — painting a model over a
    // balancer-dropped row would put colour where every other map shows paper —
    // and so does a separation whose baseline is not positive.
    const b = block(3, 3, (r, c) => (r === 1 || c === 1 ? Number.NaN : Math.abs(r - c) === 2 ? 0 : 5))
    const baseline = expectedValues(b, { rows: [], cols: [] })
    expect(Number.isNaN(baseline[1 * 3 + 1])).toBe(true)
    // Separation 2 is the two zero cells and nothing else, so its mean is 0 and
    // there is nothing to divide by.
    expect(Number.isNaN(baseline[0 * 3 + 2])).toBe(true)
    expect(baseline[0]).toBeCloseTo(5, 6)
  })

  it('keeps a cell of nothing observed, which is a fact about the numerator', () => {
    // `observedOverExpected` blanks this one — zero over anything is zero, which
    // on a ramp centred at 1 is maximum depletion — but the *baseline* there is
    // measured and real, so it is drawn.
    const b = block(3, 3, (r, c) => (r === c ? 10 : Math.abs(r - c) === 1 && r === 0 ? 0 : 4))
    const baseline = expectedValues(b, { rows: [], cols: [] })
    expect(Number.isNaN(observedOverExpected(b, { rows: [], cols: [] })[0 * 3 + 1])).toBe(true)
    // Separation 1 is that zero and three fours, so the baseline it was divided
    // by is 3 — measured, and drawn, at the very cell the ratio abandoned.
    expect(baseline[0 * 3 + 1]).toBeCloseTo(3, 6)
  })

  it('overrides the ratio rather than composing with it, and says so', () => {
    const decay = [10, 5, 2, 1]
    const b = block(4, 4, (r, c) => decay[Math.abs(r - c)])
    const axes = { rows: runs('c', 4), cols: runs('c', 4) }
    // Both asked for, which is what a reader who left the toggle on and then
    // picked the baseline produces. O/E of the baseline is 1 in every cell, so
    // honouring both would answer a question nobody asked.
    const both = deriveBlock(b, { baseline: true, expected: true }, axes)
    expect(both.label).toBe('expected')
    expect(both.values[0]).toBeCloseTo(10, 6)
    // And it is count-like, so it stays on a sequential ramp: a neutral of 1
    // would centre a diverging scale where nothing in this picture lives.
    expect(both.neutral).toBeNull()
    expect(deriveBlock(b, { expected: true }, axes).neutral).toBe(1)
  })

  it('is measured after the normalisation, like the ratio it comes out of', () => {
    const b = outerProduct([1, 4], [1, 4])
    const axes = { rows: runs('c', 2), cols: runs('c', 2) }
    const plain = deriveBlock(b, { baseline: true }, axes)
    const corrected = deriveBlock(b, { baseline: true, normalise: 'vc' }, axes)
    expect(corrected.label).toBe('VC · expected')
    // The block is pure per-bin bias and nothing else, so its true decay is
    // flat. Raw, the baseline is not: separation 0 averages 1 and 16 to 8.5
    // while separation 1 averages 4 and 4. VC takes the bias out, and the
    // baseline measured after it says what is really there.
    expect(plain.values[0] / plain.values[1]).toBeCloseTo(8.5 / 4, 5)
    expect(corrected.values[0]).toBeCloseTo(corrected.values[1], 6)
  })
})

/**
 * The baseline along a bacterial chromosome's two arms (§7.5, §8.15).
 *
 * A circle of 40 bins with its origin at bin 0 and its two arms zipped: a locus
 * touches its mirror image on the other arm half as often as a neighbour on
 * its own arm the same distance from the origin. Divided by the distance decay
 * the mirror cells stand out — the X a correlation then draws; divided along
 * the arms they are 1 like every other cell.
 */
describe('the baseline along both arms', () => {
  const N = 40
  const frame = { n: N, origin: 0, circular: true }
  const u = armOffsets(frame)
  const decay = (s: number): number => 100 / (1 + s)
  const cell = (r: number, c: number): number => {
    const delta = Math.abs(Math.abs(u[r]) - Math.abs(u[c]))
    const sameArm = u[r] >= 0 === u[c] >= 0
    return sameArm ? decay(delta) : 0.5 * decay(delta)
  }
  const b = block(N, N, cell)
  const axes = { rows: [{ label: 'chr', start: 0, end: N }], cols: [{ label: 'chr', start: 0, end: N }] }
  const bins = Int32Array.from({ length: N }, (_, i) => i)
  const arms = { frame, rowBins: bins, colBins: bins, window: 0 }
  // Bin 10 and its mirror, bin 30: far apart round the circle, level with each
  // other along the arms.
  const mirror = 10 * N + 30

  it('leaves the secondary diagonal standing when only the decay is divided out', () => {
    const plain = deriveBlock(b, { expected: true }, axes)
    expect(plain.values[mirror]).toBeGreaterThan(2)
    expect(plain.label).toBe('O/E')
  })

  it('divides it out along the arms, and says so', () => {
    const along = deriveBlock(b, { expected: true, arms }, axes)
    expect(along.values[mirror]).toBeCloseTo(1, 5)
    expect(along.values[3 * N + 7]).toBeCloseTo(1, 5)
    expect(along.label).toBe('O/E along the arms')
    expect(along.neutral).toBe(1)
  })

  // What the score picker's `arm decay` draws (§7.5, §8.15): the denominator
  // above, shown — both diagonals, where the plain baseline has one.
  it('draws the baseline along the arms as both diagonals, every cell of the square', () => {
    const drawn = deriveBlock(b, { baseline: true, arms }, axes)
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) expect(drawn.values[r * N + c], `${r},${c}`).toBeCloseTo(cell(r, c), 3)
    }
    // The secondary diagonal is in it — the mirror cell holds its own decay —
    // where the plain baseline puts the mean of its separation there.
    expect(drawn.values[mirror]).toBeCloseTo(0.5 * decay(0), 3)
    expect(deriveBlock(b, { baseline: true }, axes).values[mirror]).not.toBeCloseTo(0.5 * decay(0), 1)
    expect(drawn.label).toBe('expected along the arms')
    // A mean of counts, like every baseline: no middle, a sequential ramp.
    expect(drawn.neutral).toBeNull()
  })
})

describe('two files reduced to one number', () => {
  const a = block(2, 2, (r, c) => [[4, 2], [8, 1]][r][c])
  const b = block(2, 2, (r, c) => [[2, 2], [2, 0]][r][c])

  it('divides where both files have contacts, and nowhere else', () => {
    const out = combine(a, b, { op: 'ratio' })
    expect(out.neutral).toBe(1)
    expect(out.values[0]).toBeCloseTo(2, 6)
    expect(out.values[1]).toBeCloseTo(1, 6)
    expect(out.values[2]).toBeCloseTo(4, 6)
    // A zero in the second file: no ratio (§6), where it used to be `Infinity`
    // at the top of the scale.
    expect(Number.isNaN(out.values[3])).toBe(true)
    // …and a zero in the first, where it used to be `0`, the bottom.
    expect(Number.isNaN(combine(b, a, { op: 'ratio' }).values[3])).toBe(true)
  })

  it('has no ratio between two empty cells', () => {
    const empty = block(1, 1, () => 0)
    expect(Number.isNaN(combine(empty, empty, { op: 'ratio' }).values[0])).toBe(true)
  })

  it('subtracts, with the neutral point at zero', () => {
    const out = combine(a, b, { op: 'difference' })
    expect(out.neutral).toBe(0)
    expect([...out.values]).toEqual([2, 0, 6, 1])
  })

  it('takes each file as read: a depth difference is the total’s to remove, not a gain’s', () => {
    // Two libraries at different depth have a constant ratio. Nothing here
    // divides it out — the contacts box draws both to one total first (§6.5).
    const deep = block(1, 1, () => 10)
    const shallow = block(1, 1, () => 5)
    expect(combine(deep, shallow, { op: 'ratio' }).values[0]).toBeCloseTo(2, 6)
    expect(combine(deep, shallow, { op: 'difference' }).values[0]).toBeCloseTo(5, 6)
  })

  it('leaves the split exactly as it was', () => {
    const split = combine(a, b, { op: 'split' })
    const legacy = blendAcrossDiagonal(a, b)
    expect(split.neutral).toBeNull()
    expect([...split.values]).toEqual([...legacy.values])
    expect(split.lower).toBe(legacy.lower)
  })

  it('carries a discarded bin through as no comparison rather than as agreement', () => {
    const withNaN = block(1, 1, () => Number.NaN)
    const ok = block(1, 1, () => 4)
    expect(Number.isNaN(combine(ok, withNaN, { op: 'ratio' }).values[0])).toBe(true)
    expect(Number.isNaN(combine(withNaN, ok, { op: 'difference' }).values[0])).toBe(true)
  })
})

describe('the log2 scale', () => {
  it('puts twice and half the same distance either side of neutral', () => {
    const out = transformValues(Float32Array.from([0.25, 0.5, 1, 2, 4]), 'log2')
    expect([...out]).toEqual([-2, -1, 0, 1, 2])
  })

  it('sends an empty numerator to the bottom of the scale, not to its middle', () => {
    // `log10`'s numpy clamp folds zero to 0, which on a ratio map is the colour
    // that means "these two agree" — the single most misleading output possible.
    expect(transformValues(Float32Array.from([0]), 'log2')[0]).toBe(Number.NEGATIVE_INFINITY)
    expect(transformValues(Float32Array.from([0]), 'log10')[0]).toBe(0)
  })

  it('keeps a comparison that could not be made out of the picture entirely', () => {
    expect(Number.isNaN(transformValues(Float32Array.from([Number.NaN]), 'log2')[0])).toBe(true)
  })
})

describe('the symmetric auto range', () => {
  it('centres on neutral even when the data are lopsided', () => {
    // Everything above neutral. An asymmetric range would put "these agree"
    // at the very bottom of the ramp and draw the whole map in one arm of it.
    const range = autoSymmetricRange(Float32Array.from([0.5, 1, 1.5, 2, 3]), 0)
    expect(range.vmin).toBeCloseTo(-range.vmax, 10)
    expect(range.vmax).toBeGreaterThan(0)
  })

  it('ignores the infinities a ratio produces', () => {
    const finite = autoSymmetricRange(Float32Array.from([-1, 0, 1]), 0)
    const withInfinities = autoSymmetricRange(
      Float32Array.from([-1, 0, 1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
      0,
    )
    expect(withInfinities.vmax).toBeCloseTo(finite.vmax, 10)
  })

  it('gives a map of two identical files a range rather than a point', () => {
    const range = autoSymmetricRange(new Float32Array(16), 0)
    expect(range.vmax).toBeGreaterThan(0)
    expect(range.vmin).toBeCloseTo(-range.vmax, 10)
  })

  it('respects a neutral point that is not zero', () => {
    const range = autoSymmetricRange(Float32Array.from([3, 5, 7]), 5)
    expect((range.vmin + range.vmax) / 2).toBeCloseTo(5, 10)
  })
})

describe('the normalisation names', () => {
  it('accepts only what it can serve, so a shared link cannot ask for more', () => {
    expect(isNormalisation('vc')).toBe(true)
    expect(isNormalisation('ice')).toBe(true)
    expect(isNormalisation('KR')).toBe(false)
    expect(isNormalisation('')).toBe(false)
  })
})

describe('drawing a diverging field at fit zoom', () => {
  /** A sparse ratio field: mostly empty, a few real ratios — a Hi-C map's shape. */
  function sparseRatios(rows: number, cols: number): Float32Array {
    const values = new Float32Array(rows * cols)
    for (let i = 0; i < values.length; i += 37) values[i] = 2
    return values
  }

  it('does not let one empty cell erase the block it is pooled with', () => {
    // An empty cell of a ratio field is 0, whose `log2` is -Infinity, and a
    // contact map is mostly empty — so a reduction that ranked by raw distance
    // from neutral put an infinity in *every* pooled block and drew the whole
    // map as one colour. This is the regression: 0 of 32,768 pooled pixels came
    // back finite.
    const rows = 8192
    const cols = 8
    const pooled = poolDisplay(
      { nrows: rows, ncols: cols, values: sparseRatios(rows, cols), rowExtent: [0, rows], colExtent: [0, cols] },
      { vmin: Number.NaN, vmax: Number.NaN, transform: 'log2', colormap: 'RdBu_r', neutral: 1 },
      // The raster cap this was measured under; the reduction is what is tested.
      { maxDim: 4096 },
    )
    // Something must actually have been pooled, or the test proves nothing.
    expect(pooled.strideY).toBeGreaterThan(1)
    let finite = 0
    for (const value of pooled.values) if (Number.isFinite(value)) finite++
    expect(finite).toBeGreaterThan(0)
  })

  it('still draws a block that has nothing but an infinity in it', () => {
    // "Off the end in one direction" is a real reading where there is no other,
    // and dropping it would blank a genuinely empty region instead of flooring it.
    const values = new Float32Array(16 * 16)
    const pooled = poolDisplay(
      { nrows: 16, ncols: 16, values, rowExtent: [0, 16], colExtent: [0, 16] },
      { vmin: Number.NaN, vmax: Number.NaN, transform: 'log2', colormap: 'RdBu_r', neutral: 1 },
      { maxDim: 4 },
    )
    expect(pooled.values.every((v) => v === Number.NEGATIVE_INFINITY)).toBe(true)
  })

  it('falls back to the ordinary rules where neutral is not on the scale', () => {
    // `log2` is offered on every map, and a difference map's neutral is 0 —
    // whose log2 is -Infinity. Treated as a centre it makes every distance
    // infinite and the range `[-Infinity, -Infinity]`.
    const range = autoSymmetricRange(Float32Array.from([-1, 0, 1]), Number.NEGATIVE_INFINITY)
    expect(Number.isFinite(range.vmin)).toBe(true)
    expect(Number.isFinite(range.vmax)).toBe(true)
  })
})

/**
 * The compartment chain, on a matrix built to have a known answer.
 *
 * A two-compartment matrix is easy to construct and hard to get wrong by
 * accident: two interleaved sets of bins, each contacting its own set more than
 * the other. The first eigenvector of its correlation matrix must separate them,
 * and that is a check on the whole chain — observed/expected, correlation, and
 * the solver — in one assertion.
 *
 * The rest is what breaks in practice: dropped bins, the sign, and a phasing
 * decision that should not have been made.
 */

import { describe, expect, it } from 'vitest'

import {
  COOLTOOLS_CLIP_PERCENTILE,
  contactShares,
  cooltoolsExpected,
  cooltoolsMatrix,
  cooltoolsPlan,
  cooltoolsSeparationGroups,
  correlationMatrix,
  observedOverExpected,
  singleGroupPlan,
  phaseComponent,
  saddle,
  usableBins,
} from '@/analysis/compartments'
import { ExpectedAccumulator, type ExpectedCurve } from '@/analysis/expected'
import { fiedlerSplit, leadingEigenpairs } from '@/analysis/linalg'

/** Which compartment a bin belongs to: alternating blocks of five. */
function compartmentOf(bin: number): number {
  return Math.floor(bin / 5) % 2
}

/**
 * Two interleaved compartments, each contacting its own twice as often.
 *
 * Blocks of five rather than alternating single bins, and the difference is the
 * whole reason this fixture is written down rather than reached for. At period
 * two, *same compartment* is exactly *even offset* — the compartment signal is
 * entirely confounded with the diagonal offset, so observed/expected removes it
 * and the chain correctly finds nothing. That is O/E doing its job, and a test
 * built on it would read as a broken solver. At period ten the two are
 * independent: same-compartment pairs occur at many offsets and different-
 * compartment pairs at the same ones.
 */
function blocks(n: number): Float32Array {
  const values = new Float32Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const same = compartmentOf(r) === compartmentOf(c)
      // A distance decay on top, so the O/E step has something to remove.
      const decay = 1 / (1 + Math.abs(r - c))
      values[r * n + c] = decay * (same ? 2 : 1)
    }
  }
  return values
}

async function chainOf(
  values: Float32Array,
  n: number,
): Promise<{ component: Float64Array; index: Int32Array }> {
  const accumulator = new ExpectedAccumulator(n)
  accumulator.addBlock({
    nrows: n,
    ncols: n,
    values,
    rowExtent: [0, n],
    colExtent: [0, n],
  })
  const index = usableBins(values, n, 0.1)
  const oe = observedOverExpected(values, n, index, singleGroupPlan(n, accumulator.finish()))
  const correlation = await correlationMatrix(oe, index.length)
  const pairs = leadingEigenpairs(correlation, index.length, 1)
  return { component: pairs[0].vector, index }
}

describe('the compartment chain', () => {
  it('separates two compartments with its first component', async () => {
    const n = 40
    const { component, index } = await chainOf(blocks(n), n)
    // One compartment on each side of zero. Which side is which is arbitrary
    // until phasing, so the test asks only that the two groups are split.
    const even: number[] = []
    const odd: number[] = []
    for (let i = 0; i < index.length; i++) {
      ;(compartmentOf(index[i]) === 0 ? even : odd).push(component[i])
    }
    const evenMean = even.reduce((a, b) => a + b, 0) / even.length
    const oddMean = odd.reduce((a, b) => a + b, 0) / odd.length
    expect(Math.sign(evenMean)).not.toBe(Math.sign(oddMean))
    // The vector is unit length over `index.length` bins, so a typical entry is
    // about 1/sqrt(n). The two group means must be separated by a real fraction
    // of that rather than by a fixed number that would only hold at one size.
    const typical = 1 / Math.sqrt(index.length)
    expect(Math.abs(evenMean - oddMean)).toBeGreaterThan(typical)
  })

  it('gives the same component twice, so a figure is reproducible', async () => {
    // S16.4. Power iteration from an arbitrary start converges to the same
    // vector up to sign, and the sign is what a compartment track *means* — so
    // the start is seeded rather than random.
    const n = 30
    const a = (await chainOf(blocks(n), n)).component
    const b = (await chainOf(blocks(n), n)).component
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

/**
 * The other road to the eigenvectors (§18.8): observed/expected decomposed as it
 * is, the way cooltools' `eigs_cis` prepares it. The numbers below are NumPy's —
 * `np.clip(oe, 0, np.percentile(finite, p)) - 1` with every gap zero — and the
 * eigenvalues are `cooltools.lib.numutils.get_eig`'s on the same matrix.
 */
describe('cooltoolsMatrix', () => {
  const nan = Number.NaN

  it('clips at the percentile, subtracts one, and reads every gap as expected', () => {
    const oe = Float64Array.from([
      nan, 1.2, 0.8, 1.0,
      1.2, nan, 2.5, 0.5,
      0.8, 2.5, nan, 9.0,
      1.0, 0.5, 9.0, nan,
    ])
    // The 90th percentile of the twelve finite cells is 8.35, between 2.5 and 9.
    const prepared = cooltoolsMatrix(oe, 4, 90)
    const expected = [
      0, 0.2, -0.2, 0,
      0.2, 0, 1.5, -0.5,
      -0.2, 1.5, 0, 7.35,
      0, -0.5, 7.35, 0,
    ]
    for (let i = 0; i < expected.length; i++) expect(prepared[i]).toBeCloseTo(expected[i], 12)
    // …and at cooltools' own 99.9th the ceiling is the brightest cell itself.
    expect(cooltoolsMatrix(oe, 4)[11]).toBeCloseTo(8, 12)
    // The observed/expected is left as it was: the saddle reads it afterwards.
    expect(oe[11]).toBe(9)
    expect(Number.isNaN(oe[0])).toBe(true)
  })

  it('takes NumPy’s percentile, linear between ranks, over the finite cells alone', () => {
    // Two thousand values in a scrambled order, and 25 gaps that must not count.
    const m = 45
    const oe = new Float64Array(m * m).fill(nan)
    for (let i = 0; i < 2000; i++) oe[i] = ((i * 7919) % 1009) / 97
    const ceiling = (percentile: number): number => Math.max(...cooltoolsMatrix(oe, m, percentile)) + 1
    expect(ceiling(COOLTOOLS_CLIP_PERCENTILE)).toBeCloseTo(10.381453608247424, 10)
    expect(ceiling(97.5)).toBeCloseTo(10.134278350515462, 10)
    expect(ceiling(50)).toBeCloseTo(5.195876288659794, 10)
  })

  it('gives cooltools’ eigenvalues, and a first component that separates the compartments', () => {
    const n = 40
    const values = blocks(n)
    const accumulator = new ExpectedAccumulator(n)
    accumulator.addBlock({ nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] })
    const index = usableBins(values, n, 0.1)
    const oe = observedOverExpected(values, n, index, singleGroupPlan(n, accumulator.finish()))
    const pairs = leadingEigenpairs(cooltoolsMatrix(oe, index.length), index.length, 3)
    // Ranked by size, sign kept: the second and third are negative.
    expect(pairs.map((pair) => pair.value)).toEqual([
      expect.closeTo(8.794928356553529, 6),
      expect.closeTo(-5.610452250317817, 6),
      expect.closeTo(-1.7935906495302383, 6),
    ])
    const first = pairs[0].vector
    const sign = Math.sign(first[0])
    for (let i = 0; i < index.length; i++) {
      expect(Math.sign(first[i])).toBe(compartmentOf(index[i]) === 0 ? sign : -sign)
    }
  })
})

/**
 * The expectation cooltools' `eigs_cis` divides by, which is its own and not
 * `expected_cis`: `observed_over_expected` pools the diagonals past about the
 * thirty-fifth in groups at most 3% wide. The numbers are cooltools 0.7.1's —
 * `numutils._logbins_numba(1, n, 1.03)` for the groups, and
 * `cis_eig(A, n_eigs=3, ignore_diags=2, clip_percentile=99.9)` for the square.
 */
describe('cooltools’ own expectation', () => {
  it('groups the separations where `_logbins_numba` puts its edges', () => {
    const upTo = (n: number): number[] => Array.from({ length: n + 1 }, (_, k) => k)
    expect(Array.from(cooltoolsSeparationGroups(2))).toEqual([0, 1, 2])
    expect(Array.from(cooltoolsSeparationGroups(6))).toEqual(upTo(6))
    expect(Array.from(cooltoolsSeparationGroups(40))).toEqual([...upTo(35), 37, 38, 39, 40])
    expect(Array.from(cooltoolsSeparationGroups(80))).toEqual([
      ...upTo(40), 42, 43, 44, 45, 47, 48, 50, 51, 53, 54, 56, 58, 59, 61, 63, 65, 67, 69, 71, 73, 75,
      78, 80,
    ])
    // A mouse chromosome 1 at 100 kb: 170 groups, the first pair at 36 and 37.
    const chr1 = cooltoolsSeparationGroups(1955)
    expect(chr1).toHaveLength(171)
    expect(Array.from(chr1.subarray(35, 38))).toEqual([35, 36, 38])
    expect(Array.from(chr1.subarray(-3))).toEqual([1842, 1898, 1955])
  })

  /** A curve over the 40 separations of a 40-bin square, `cells` at each separation `k`. */
  function curveOf(cells: (k: number) => number[]): ExpectedCurve {
    const accumulator = new ExpectedAccumulator(39)
    for (let k = 0; k < 40; k++) for (const value of cells(k)) accumulator.add(k, value)
    return accumulator.finish()
  }

  it('divides a group by its cells’ mean, not by the mean of its separations’ means', () => {
    // 35 and 36 are one group at 40 bins: one cell of 4 and three of 2.
    const curve = curveOf((k) => (k === 35 ? [4] : k === 36 ? [2, 2, 2] : [k + 1, k + 1]))
    const pooled = cooltoolsExpected(curve, 2)
    expect(pooled.mean[35]).toBe(2.5)
    expect(pooled.mean[36]).toBe(2.5)
    // Below the first group of two, every separation is its own — the near
    // diagonal's ones, which is what cooltools sets it to, and then the curve's.
    expect([pooled.mean[0], pooled.mean[1]]).toEqual([1, 1])
    for (let k = 2; k < 35; k++) expect(pooled.mean[k]).toBe(k + 1)
    // The curve's own sums and counts are left as they were.
    expect(pooled.count[35]).toBe(1)
    expect(curve.mean[35]).toBe(4)
  })

  it('pools the near diagonal as ones, and leaves a group with no contacts undivided', () => {
    const curve = curveOf((k) => (k === 35 ? [4] : k === 36 ? [2, 2, 2] : k >= 37 ? [0, 0] : [k + 1]))
    // Thirty-six ignored diagonals reach into the group of 35 and 36.
    expect(cooltoolsExpected(curve, 36).mean[35]).toBe((1 + 6) / 4)
    // 37, 38 and 39 are each a group, all zeros: divided by nothing, so by 1.
    const pooled = cooltoolsExpected(curve, 2)
    for (const k of [37, 38, 39]) expect(pooled.mean[k]).toBe(1)
    // …where a separation nothing was read at is no expectation at all.
    expect(Number.isNaN(cooltoolsExpected(curveOf((k) => (k === 38 ? [] : [1])), 2).mean[38])).toBe(true)
  })

  /** The two-compartment square, every cell `far` or more bins apart empty. */
  function emptyCorner(n: number, far: number): Float32Array {
    const values = blocks(n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (Math.abs(r - c) >= far) values[r * n + c] = 0
    return values
  }

  /** The chain as the runner takes it under cooltools' method, scaled as cooltools writes it. */
  function decomposed(values: Float32Array, n: number): { value: number; vector: Float64Array }[] {
    const accumulator = new ExpectedAccumulator(n - 1)
    accumulator.addBlock({ nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] })
    const index = usableBins(values, n, 0.1)
    const plan = { ...singleGroupPlan(n, accumulator.finish()), ignoreDiags: 2 }
    const own = observedOverExpected(values, n, index, cooltoolsPlan(plan))
    const prepared = cooltoolsMatrix(own, index.length, COOLTOOLS_CLIP_PERCENTILE, own)
    return leadingEigenpairs(prepared, index.length, 3).map(({ value, vector }) => ({
      value,
      vector: vector.map((x) => x * Math.sqrt(Math.abs(value))),
    }))
  }

  it('gives `cis_eig`’s eigenvalues and eigenvectors', () => {
    for (const [far, values, first] of [
      [80, [17.760623250388637, -10.961943768342252, -3.468600256749778], [-0.5124443358642781, -0.38573833418160997, -0.3599584977487035, -0.4417233023945974]],
      // Its far corner empty, the last three groups without a contact.
      [72, [18.138009101734376, -10.617036575209479, -4.756783500358663], [0.5969826853561353, 0.4809560251208968, 0.47477558844962153, 0.5748726980294896]],
    ] as const) {
      const pairs = decomposed(emptyCorner(80, far), 80)
      for (let k = 0; k < 3; k++) expect(pairs[k].value).toBeCloseTo(values[k], 10)
      const sign = Math.sign(pairs[0].vector[0]) * Math.sign(first[0])
      for (let i = 0; i < first.length; i++) expect(sign * pairs[0].vector[i]).toBeCloseTo(first[i], 10)
    }
  })

  it('is what the near-diagonal plan is not, past the thirty-fifth diagonal', () => {
    // Each diagonal over its own mean: the eigenvalue cooltools' does not give.
    const n = 80
    const values = emptyCorner(n, 72)
    const accumulator = new ExpectedAccumulator(n - 1)
    accumulator.addBlock({ nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] })
    const index = usableBins(values, n, 0.1)
    const plan = { ...singleGroupPlan(n, accumulator.finish()), ignoreDiags: 2 }
    const own = observedOverExpected(values, n, index, plan)
    const [first] = leadingEigenpairs(cooltoolsMatrix(own, index.length), index.length, 1)
    expect(first.value).not.toBeCloseTo(18.138009101734376, 3)
  })
})

describe('contactShares', () => {
  /** The two-compartment square's observed/expected over its usable bins. */
  function oeOf(n: number): { oe: Float64Array; m: number } {
    const values = blocks(n)
    const accumulator = new ExpectedAccumulator(n)
    accumulator.addBlock({ nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] })
    const index = usableBins(values, n, 0.1)
    return { oe: observedOverExpected(values, n, index, singleGroupPlan(n, accumulator.finish())), m: index.length }
  }

  /** The sum of the prepared matrix's cells squared, the whole the shares are of. */
  function wholeOf(oe: Float64Array, m: number): number {
    let whole = 0
    for (const value of cooltoolsMatrix(oe, m)) whole += value * value
    return whole
  }

  it('is the eigenvalue squared over the sum of squares for cooltools’ own components', () => {
    const { oe, m } = oeOf(40)
    const pairs = leadingEigenpairs(cooltoolsMatrix(oe, m), m, 3)
    const shares = contactShares(oe, m, pairs.map((pair) => pair.vector))
    const whole = wholeOf(oe, m)
    // To the solver's own convergence: its eigenvalue is the last iterate's.
    for (let k = 0; k < pairs.length; k++) expect(shares[k]).toBeCloseTo(pairs[k].value ** 2 / whole, 7)
  })

  it('measures the correlation’s components against the same map, and they add up to no more than it', async () => {
    const { oe, m } = oeOf(40)
    const pairs = leadingEigenpairs(await correlationMatrix(oe, m), m, 3)
    const shares = contactShares(oe, m, pairs.map((pair) => pair.vector))
    // The planted checkerboard is most of this map's departure from expected,
    // and the first component is that checkerboard.
    expect(shares[0]).toBeGreaterThan(0.3)
    for (const share of shares.slice(1)) expect(share).toBeLessThan(shares[0])
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(1 + 1e-12)
    // …and a correlation eigenvalue's own share is another quantity altogether.
    expect(pairs[0].value / m).not.toBeCloseTo(shares[0], 2)
  })

  it('reads a gap as expected, and leaves the observed/expected as it was', () => {
    const nan = Number.NaN
    // One checkerboard of departures, and a gap where it would have been largest.
    const oe = Float64Array.from([
      nan, 0.5, 1.5, 0.5,
      0.5, nan, 0.5, 1.5,
      1.5, 0.5, nan, 0.5,
      0.5, 1.5, 0.5, nan,
    ])
    const v = Float64Array.from([0.5, 0.5, 0.5, 0.5])
    const w = Float64Array.from([0.5, -0.5, 0.5, -0.5])
    const [flat, board] = contactShares(oe, 4, [v, w])
    // Every departure is ±0.5 off the gaps, so the whole is 12 × 0.25 = 3.
    // `w wᵀ` matches all twelve: its fit is 12 × 0.5 × 0.25 = 1.5, so 1.5² / 3.
    expect(board).toBeCloseTo(0.75, 12)
    // `v vᵀ` sees four above and eight below: (4 − 8) × 0.5 × 0.25 = −0.5, so 0.25 / 3.
    expect(flat).toBeCloseTo(0.25 / 3, 12)
    expect(Number.isNaN(oe[0])).toBe(true)
    expect(oe[2]).toBe(1.5)
  })
})

describe('usableBins', () => {
  it('excludes a row the balancer dropped rather than zeroing it', () => {
    const n = 10
    const values = new Float32Array(n * n).fill(1)
    for (let c = 0; c < n; c++) {
      values[4 * n + c] = Number.NaN
      values[c * n + 4] = Number.NaN
    }
    const index = Array.from(usableBins(values, n, 0.5))
    expect(index).not.toContain(4)
    expect(index).toHaveLength(n - 1)
  })
})

describe('observedOverExpected', () => {
  it('divides by the expected at each cell’s own offset', () => {
    const n = 4
    const values = new Float32Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) values[r * n + c] = Math.abs(r - c) === 0 ? 4 : 2
    }
    const accumulator = new ExpectedAccumulator(n)
    accumulator.addBlock({ nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] })
    const index = Int32Array.from([0, 1, 2, 3])
    const oe = observedOverExpected(values, n, index, singleGroupPlan(n, accumulator.finish()))
    // Every cell equals the mean at its own offset, so every ratio is 1.
    for (const value of oe) expect(value).toBeCloseTo(1, 12)
  })

  /**
   * Two sequences in one square, which is what a genome-wide run builds.
   *
   * The two halves of the plan are two different questions and the test is
   * really about not conflating them. A **cis** cell is divided by *its own*
   * sequence's decay — pooling the two would divide a small chromosome by the
   * average behaviour of a large one, which comes out as a gradient along the
   * eigenvector and looks exactly like a compartment. A **trans** cell has no
   * separation at all, so there is no curve to read and the expectation is that
   * pair's own block mean; reading `|col − row|` there would file every trans
   * cell under a made-up separation.
   */
  it('divides cis by its own sequence’s decay and trans by the pair’s mean', () => {
    // Rows 0–1 are sequence A, rows 2–4 are sequence B. A's cis cells are 10 on
    // the diagonal and 5 off it; B's are 100 and 50; the trans block is 3.
    const n = 5
    const group = Int32Array.from([0, 0, 1, 1, 1])
    const values = new Float32Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const same = group[r] === group[c]
        const scale = group[r] === 0 ? 1 : 10
        values[r * n + c] = same ? (r === c ? 10 * scale : 5 * scale) : 3
      }
    }

    const cis = [0, 1].map((g) => {
      const accumulator = new ExpectedAccumulator(n)
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (group[r] !== g || group[c] !== g) continue
          accumulator.add(Math.abs(c - r), values[r * n + c])
        }
      }
      return accumulator.finish()
    })
    const trans = Float64Array.from([Number.NaN, 3, 3, Number.NaN])
    const index = Int32Array.from([0, 1, 2, 3, 4])
    const oe = observedOverExpected(values, n, index, { group, cis, trans, contacts: 'both', ignoreDiags: 0 })

    // Every cell is exactly its own expectation, so the whole matrix is 1 —
    // including across the boundary, where a shared curve would have produced
    // 3/10 on one side and 3/100 on the other.
    for (const value of oe) expect(value).toBeCloseTo(1, 12)
  })

  /**
   * Cis, trans and both are three computations rather than one with a filter,
   * and the mode's whole job in the kernel is which cells become gaps. A gap is
   * not a zero: a cell left out takes no part in any correlation, where a zero
   * would assert that its two bins do not touch.
   */
  it('leaves out whichever half the mode excludes, as gaps', () => {
    const n = 4
    const group = Int32Array.from([0, 0, 1, 1])
    const values = new Float32Array(n * n).fill(2)
    const flat = new ExpectedAccumulator(n)
    for (let k = 0; k <= n; k++) flat.add(k, 2)
    const curve = flat.finish()
    const trans = Float64Array.from([Number.NaN, 2, 2, Number.NaN])
    const index = Int32Array.from([0, 1, 2, 3])
    const plan = { group, cis: [curve, curve], trans, ignoreDiags: 0 }

    const both = observedOverExpected(values, n, index, { ...plan, contacts: 'both' })
    expect([...both].every((value) => value === 1)).toBe(true)

    // Cis keeps the two diagonal blocks and drops what is between them…
    const cis = observedOverExpected(values, n, index, { ...plan, contacts: 'cis' })
    expect(cis[0 * n + 1]).toBe(1)
    expect(cis[0 * n + 2]).toBeNaN()
    expect(cis[2 * n + 3]).toBe(1)

    // …and trans is exactly its complement.
    const only = observedOverExpected(values, n, index, { ...plan, contacts: 'trans' })
    expect(only[0 * n + 1]).toBeNaN()
    expect(only[0 * n + 2]).toBe(1)
    expect(only[2 * n + 3]).toBeNaN()
  })

  /**
   * cooltools' `ignore_diags`, and its exact arithmetic: `|col - row| < n`.
   *
   * The near-diagonal is where self-ligation and unligated fragments land, and
   * those cells are the largest in the matrix. Left in, a row's correlation with
   * its neighbours is carried by two or three cells that say only that the bins
   * are adjacent — which every chromosome's rows agree about, so it enters the
   * eigenvector as a component that is really a picture of the diagonal.
   */
  it('drops the diagonals the count asks for, and only in cis', () => {
    const n = 4
    const group = Int32Array.from([0, 0, 1, 1])
    const values = new Float32Array(n * n).fill(2)
    const flat = new ExpectedAccumulator(n)
    for (let k = 0; k <= n; k++) flat.add(k, 2)
    const curve = flat.finish()
    const plan = {
      group,
      cis: [curve, curve],
      trans: Float64Array.from([Number.NaN, 2, 2, Number.NaN]),
      contacts: 'both' as const,
    }
    const index = Int32Array.from([0, 1, 2, 3])

    // 0 keeps everything.
    const none = observedOverExpected(values, n, index, { ...plan, ignoreDiags: 0 })
    expect(none[0 * n + 0]).toBe(1)
    expect(none[0 * n + 1]).toBe(1)

    // 1 is the main diagonal alone.
    const one = observedOverExpected(values, n, index, { ...plan, ignoreDiags: 1 })
    expect(one[0 * n + 0]).toBeNaN()
    expect(one[0 * n + 1]).toBe(1)

    // 2 is it and the two beside it — offsets 0 and 1.
    const two = observedOverExpected(values, n, index, { ...plan, ignoreDiags: 2 })
    expect(two[0 * n + 0]).toBeNaN()
    expect(two[0 * n + 1]).toBeNaN()
    expect(two[1 * n + 0]).toBeNaN()

    // …and the trans block is untouched at every setting: two bins on different
    // sequences have no separation for a diagonal to be measured from. Rows 0-1
    // are one sequence and 2-3 the other, so (0, 2) is trans.
    for (const ignore of [0, 1, 2, 8]) {
      const oe = observedOverExpected(values, n, index, { ...plan, ignoreDiags: ignore })
      expect(oe[0 * n + 2], `ignoreDiags ${ignore}`).toBe(1)
    }
  })

  it('leaves a cis-only square with nothing at all once the cut covers it', () => {
    // The control has no upper bound, and on a metagenome a sequence can be
    // shorter than the number typed into it. Every cell then becomes a gap,
    // every correlation is undefined, and `correlationMatrix` fills the matrix
    // with the zeros it reads *no evidence* as — so the eigenvector of what is
    // left is a shape with no data behind it. `run/compartments.ts` checks for
    // exactly this and says so instead of drawing it; this pins the premise.
    const n = 4
    const values = new Float32Array(n * n).fill(2)
    const flat = new ExpectedAccumulator(n)
    for (let k = 0; k <= n; k++) flat.add(k, 2)
    const index = Int32Array.from([0, 1, 2, 3])
    const oe = observedOverExpected(values, n, index, {
      ...singleGroupPlan(n, flat.finish()),
      contacts: 'cis',
      ignoreDiags: n,
    })
    expect([...oe].every((value) => Number.isNaN(value))).toBe(true)
  })

  it('answers a trans pair with nothing in it with a gap, not with the count', () => {
    const n = 2
    const group = Int32Array.from([0, 1])
    const values = Float32Array.from([1, 7, 7, 1])
    const flat = new ExpectedAccumulator(0)
    flat.add(0, 1)
    const oe = observedOverExpected(values, n, Int32Array.from([0, 1]), {
      group,
      cis: [flat.finish(), flat.finish()],
      trans: Float64Array.from([Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
      contacts: 'both',
      ignoreDiags: 0,
    })
    expect(oe[0]).toBeCloseTo(1, 12)
    expect(oe[1]).toBeNaN()
    expect(oe[2]).toBeNaN()
  })
})

describe('phaseComponent', () => {
  it('flips so that positive means the signal', () => {
    const component = Float64Array.from([-1, -1, 1, 1])
    const result = phaseComponent(
      component,
      { name: 'genes', values: Float64Array.from([5, 4, 0, 1]) },
      0.1,
    )
    expect(result.flipped).toBe(true)
    expect(result.confident).toBe(true)
    expect(Array.from(component)).toEqual([1, 1, -1, -1])
  })

  it('leaves the sign alone when it cannot tell, and says so', () => {
    // A sign chosen on an r of 0.04 is a coin flip wearing a decision's clothes,
    // and a reader comparing two chromosomes phased that way compares noise.
    // Orthogonal, so r is exactly 0. A *near-constant* signal would not do: its
    // variance is tiny but its correlation is not, and it would phase
    // confidently on a rounding error — which is itself worth knowing.
    const component = Float64Array.from([1, -1, 1, -1])
    const before = Array.from(component)
    const result = phaseComponent(
      component,
      { name: 'genes', values: Float64Array.from([1, 1, -1, -1]) },
      0.5,
    )
    expect(result.confident).toBe(false)
    expect(result.flipped).toBe(false)
    expect(Array.from(component)).toEqual(before)
  })
})

describe('saddle', () => {
  it('is brightest at the two corners where a compartment agrees with itself', () => {
    const m = 40
    const component = new Float64Array(m)
    for (let i = 0; i < m; i++) component[i] = i < m / 2 ? -1 - i / m : 1 + i / m
    const oe = new Float64Array(m * m)
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        oe[r * m + c] = Math.sign(component[r]) === Math.sign(component[c]) ? 2 : 0.5
      }
    }
    const result = saddle(oe, m, component, 10)
    expect(result.strength.aa).toBeCloseTo(2, 6)
    expect(result.strength.bb).toBeCloseTo(2, 6)
    expect(result.strength.ab).toBeCloseTo(0.5, 6)
  })
})

describe('fiedlerSplit', () => {
  it('splits a matrix that is really two blocks', () => {
    const n = 8
    const weights = new Float64Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const together = r < 4 === c < 4
        weights[r * n + c] = r === c ? 0 : together ? 10 : 0.1
      }
    }
    const split = fiedlerSplit(weights, n)
    expect(split).not.toBeNull()
    const side = Array.from(split!.side)
    // The first four agree with each other and disagree with the last four.
    expect(new Set(side.slice(0, 4)).size).toBe(1)
    expect(new Set(side.slice(4)).size).toBe(1)
    expect(side[0]).not.toBe(side[4])
  })

  it('refuses to split something with fewer than two members', () => {
    expect(fiedlerSplit(new Float64Array(1), 1)).toBeNull()
  })
})

/**
 * Why the correlation's row hook is awaited.
 *
 * A cancel arrives as a *message*, and a message is delivered in a task of its
 * own — so a hook that only ever ran synchronously asked about a cancel that
 * could not yet have been received, however many times it asked. The cubic loop
 * here is the one that most needs stopping and was the one that could not be:
 * a genome-wide correlation ran to completion with the reader's cancel sitting
 * in the worker's queue behind it, and delivered its result to somebody who had
 * asked for it to stop.
 */
describe('stopping the correlation', () => {
  const square = (m: number): Float64Array => {
    const oe = new Float64Array(m * m)
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) oe[r * m + c] = Math.sin((r + 1) * (c + 1))
    }
    return oe
  }

  it('waits for the hook rather than running past it', async () => {
    const m = 32
    const seen: number[] = []
    await expect(
      correlationMatrix(square(m), m, async (row) => {
        seen.push(row)
        // The yield is the whole point: a hook that suspends must suspend the
        // loop, or the flag it is about to read is one nothing could have set.
        await Promise.resolve()
        if (row === 3) throw new Error('stopped')
      }),
    ).rejects.toThrow('stopped')
    expect(seen).toEqual([0, 1, 2, 3])
  })

  it('still answers when nothing is watching', async () => {
    const m = 8
    const out = await correlationMatrix(square(m), m)
    expect(out).toHaveLength(m * m)
    // The diagonal is 1 by construction rather than by computation.
    for (let r = 0; r < m; r++) expect(out[r * m + r]).toBe(1)
  })
})

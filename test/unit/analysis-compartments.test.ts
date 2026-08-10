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
  correlationMatrix,
  observedOverExpected,
  singleGroupPlan,
  phaseComponent,
  saddle,
  usableBins,
} from '@/analysis/compartments'
import { ExpectedAccumulator } from '@/analysis/expected'
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

function chainOf(values: Float32Array, n: number): { component: Float64Array; index: Int32Array } {
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
  const correlation = correlationMatrix(oe, index.length)
  const pairs = leadingEigenpairs(correlation, index.length, 1)
  return { component: pairs[0].vector, index }
}

describe('the compartment chain', () => {
  it('separates two compartments with its first component', () => {
    const n = 40
    const { component, index } = chainOf(blocks(n), n)
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

  it('gives the same component twice, so a figure is reproducible', () => {
    // S16.4. Power iteration from an arbitrary start converges to the same
    // vector up to sign, and the sign is what a compartment track *means* — so
    // the start is seeded rather than random.
    const n = 30
    const a = chainOf(blocks(n), n).component
    const b = chainOf(blocks(n), n).component
    expect(Array.from(a)).toEqual(Array.from(b))
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

/**
 * The leading eigenpairs by Lanczos with deflation, held to spectra built by
 * hand.
 *
 * Each matrix is `Q diag(λ) Qᵀ` for a seeded orthogonal `Q`, so the answer is
 * known before the solver runs: the eigenvalues ranked by size with their
 * signs, and vectors whose residual `‖A v − λ v‖` is at the rounding of the
 * arithmetic. The spectra are the cases power iteration was slow or wrong on —
 * two eigenvalues a part in a thousand apart, two of opposite sign and almost
 * the same size — and the one single-vector Krylov methods are wrong on and
 * deflation is not: an eigenvalue that occurs twice.
 *
 * Sizes from 1 to 61, odd and even, because the product reads four rows at a
 * time and the rows left over are a path of their own.
 */

import { describe, expect, it } from 'vitest'

import { fiedlerSplit, leadingEigenpairs } from '@/analysis/linalg'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** `Q diag(λ) Qᵀ`, row-major and exactly symmetric, with `Q` a product of seeded reflections. */
function withSpectrum(spectrum: readonly number[], seed: number): Float64Array {
  const n = spectrum.length
  const rng = random(seed)
  // Q as columns, starting from the identity, reflected n times.
  const q = new Float64Array(n * n)
  for (let i = 0; i < n; i++) q[i * n + i] = 1
  for (let k = 0; k < n; k++) {
    const v = Array.from({ length: n }, () => rng() * 2 - 1)
    const norm = Math.hypot(...v)
    for (let i = 0; i < n; i++) v[i] /= norm
    // Q ← (I − 2 v vᵀ) Q
    for (let c = 0; c < n; c++) {
      let dot = 0
      for (let r = 0; r < n; r++) dot += v[r] * q[r * n + c]
      for (let r = 0; r < n; r++) q[r * n + c] -= 2 * v[r] * dot
    }
  }
  const a = new Float64Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++) {
      let total = 0
      for (let k = 0; k < n; k++) total += q[r * n + k] * spectrum[k] * q[c * n + k]
      a[r * n + c] = total
      a[c * n + r] = total
    }
  }
  return a
}

function residual(a: Float64Array, n: number, value: number, vector: Float64Array): number {
  let worst = 0
  for (let r = 0; r < n; r++) {
    let total = 0
    for (let c = 0; c < n; c++) total += a[r * n + c] * vector[c]
    worst = Math.max(worst, Math.abs(total - value * vector[r]))
  }
  return worst
}

/** The `k` largest in size, signs kept, as the solver ranks them. */
function leading(spectrum: readonly number[], k: number): number[] {
  return [...spectrum].sort((x, y) => Math.abs(y) - Math.abs(x)).slice(0, k)
}

describe('leadingEigenpairs', () => {
  it('finds the eigenvalues of a known spectrum, ranked by size, to the rounding', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 13, 31, 61]) {
      const rng = random(n)
      const spectrum = Array.from({ length: n }, () => (rng() * 2 - 1) * 10)
      const a = withSpectrum(spectrum, 100 + n)
      const k = Math.min(3, n)
      const pairs = leadingEigenpairs(Float64Array.from(a), n, k)
      expect(pairs.map((pair) => pair.value).length, `n = ${n}`).toBe(k)
      leading(spectrum, k).forEach((value, i) => expect(pairs[i].value, `n = ${n}, E${i + 1}`).toBeCloseTo(value, 9))
      for (const pair of pairs) expect(residual(a, n, pair.value, pair.vector), `n = ${n}`).toBeLessThan(1e-8)
    }
  })

  it('separates eigenvalues a part in a thousand apart', () => {
    const n = 60
    const spectrum = [10, 9.99, -9.98, ...Array.from({ length: n - 3 }, (_, i) => Math.sin(i + 1) * 4)]
    const a = withSpectrum(spectrum, 7)
    const pairs = leadingEigenpairs(Float64Array.from(a), n, 3)
    expect(pairs.map((pair) => pair.value)).toEqual([
      expect.closeTo(10, 9),
      expect.closeTo(9.99, 9),
      expect.closeTo(-9.98, 9),
    ])
    for (const pair of pairs) expect(residual(a, n, pair.value, pair.vector)).toBeLessThan(1e-8)
  })

  it('reports an eigenvalue that occurs twice twice, with two orthogonal vectors', () => {
    const n = 40
    const spectrum = [7, 7, 3, ...Array.from({ length: n - 3 }, (_, i) => Math.cos(i) * 2)]
    const a = withSpectrum(spectrum, 9)
    const pairs = leadingEigenpairs(Float64Array.from(a), n, 3)
    expect(pairs.map((pair) => pair.value)).toEqual([expect.closeTo(7, 9), expect.closeTo(7, 9), expect.closeTo(3, 9)])
    let dot = 0
    for (let i = 0; i < n; i++) dot += pairs[0].vector[i] * pairs[1].vector[i]
    expect(Math.abs(dot)).toBeLessThan(1e-8)
    for (const pair of pairs) expect(residual(a, n, pair.value, pair.vector)).toBeLessThan(1e-8)
  })

  it('returns unit vectors, the same ones on every run', () => {
    const n = 25
    const spectrum = Array.from({ length: n }, (_, i) => n - i)
    const a = withSpectrum(spectrum, 3)
    const first = leadingEigenpairs(Float64Array.from(a), n, 2)
    const again = leadingEigenpairs(Float64Array.from(a), n, 2)
    for (let k = 0; k < 2; k++) {
      expect(Math.hypot(...first[k].vector)).toBeCloseTo(1, 12)
      expect(Array.from(again[k].vector)).toEqual(Array.from(first[k].vector))
    }
  })

  it('stops at the components a matrix of low rank has, with its eigenvalue first', () => {
    const n = 12
    const u = Array.from({ length: n }, (_, i) => Math.sin(i + 1))
    const norm = Math.hypot(...u)
    const a = new Float64Array(n * n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) a[r * n + c] = (5 * u[r] * u[c]) / (norm * norm)
    const pairs = leadingEigenpairs(a, n, 1)
    expect(pairs[0].value).toBeCloseTo(5, 10)
  })
})

describe('fiedlerSplit, through the same solver', () => {
  it('still splits two blocks of a size the four-row product leaves a remainder on', () => {
    const n = 11
    const weights = new Float64Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) weights[r * n + c] = r === c ? 0 : (r < 6) === (c < 6) ? 10 : 0.1
    }
    const split = fiedlerSplit(weights, n)
    expect(split).not.toBeNull()
    const side = Array.from(split!.side)
    expect(new Set(side.slice(0, 6)).size).toBe(1)
    expect(new Set(side.slice(6)).size).toBe(1)
    expect(side[0]).not.toBe(side[6])
  })
})

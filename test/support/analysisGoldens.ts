/**
 * Loading the §18 golden oracles, and the two ways they are compared.
 *
 * `scripts/make_analysis_golden.py` writes each golden with two kinds of oracle,
 * and the distinction is the whole design (see that script's docstring):
 *
 * - **`direct`** is this repo's own definition, recomputed in numpy from the
 *   same file. It is compared to *equality*, within a tolerance the golden
 *   itself carries, and it is what catches a bug in a kernel.
 * - **`reference`** is cooltools' or coolpuppy's number under *their* definition,
 *   which is often not the same definition. Where the two coincide the golden
 *   says `relation: "equal"`; where they differ deliberately it says how, and
 *   what survives is a measured correlation floor.
 *
 * The helpers here exist so a test never spells out `Number.isFinite` around a
 * JSON `null` again: JSON has no `NaN`, so every absent value arrives as `null`
 * and has to become `NaN` before anything numeric touches it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { expect } from 'vitest'

/** Where `npm run fixtures:analysis` writes. */
export const ANALYSIS_GOLDEN_DIR = new URL('../golden/analysis/', import.meta.url).pathname

/** A column of numbers as the exporter writes it: `null` for anything not finite. */
export type GoldenNumbers = Array<number | null>

/** Whether the goldens are on disk. They are committed, so this is normally true. */
export function analysisGoldensPresent(): boolean {
  return existsSync(`${ANALYSIS_GOLDEN_DIR}_manifest.json`)
}

/** One golden by name, parsed. Throws with the path, which is the useful message. */
export function loadAnalysisGolden<T = Record<string, unknown>>(name: string): T {
  const path = `${ANALYSIS_GOLDEN_DIR}${name}.json`
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. Run: npm run fixtures:analysis`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** A golden column as a `Float64Array`, with `null` restored to `NaN`. */
export function numbers(values: GoldenNumbers): Float64Array {
  const out = new Float64Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    out[i] = value === null ? Number.NaN : value
  }
  return out
}

/**
 * Two series agree, value by value, within a relative tolerance.
 *
 * `NaN` is compared as a *value*: a position the reference has no number for and
 * one this code has no number for must be the same set of positions. That is not
 * pedantry — the whole edge-handling contract of `diamondSums`, of the coverage
 * accumulator and of `expectedAt` is expressed in *where* the gaps are, and a
 * comparison that skipped them would pass on an implementation that returned a
 * plausible number everywhere.
 *
 * `label` is prefixed to every failure so a run over four chromosomes and three
 * windows says which one broke.
 */
export function expectSeries(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  tolerance: number,
  label: string,
  absolute = 0,
): void {
  expect(actual.length, `${label}: length`).toBe(expected.length)
  let worst = 0
  let worstAt = -1
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i]
    const b = expected[i]
    const aGap = !Number.isFinite(a)
    const bGap = !Number.isFinite(b)
    if (aGap || bGap) {
      expect(aGap, `${label}: gap at ${i} (ours ${a}, theirs ${b})`).toBe(bGap)
      continue
    }
    const scale = Math.max(Math.abs(a), Math.abs(b))
    const difference = Math.abs(a - b)
    // Forgiven by whichever bound is looser. `absolute` exists for logarithms:
    // a score of 0.00003 differing in its last float32 place is a relative error
    // of 1e-4 and an absolute one of 3e-9, and only the second describes it.
    if (difference <= absolute) continue
    const error = scale === 0 ? 0 : difference / scale
    if (error > worst) {
      worst = error
      worstAt = i
    }
  }
  expect(
    worst,
    `${label}: worst relative error ${worst.toExponential(3)} at index ${worstAt}`,
  ).toBeLessThanOrEqual(tolerance)
}

/**
 * Pearson over the positions where both series have a value.
 *
 * Used only against `reference`, never against `direct`, and only where the
 * golden says the two definitions differ. Returns `NaN` under three shared
 * points, which the caller asserts against rather than silently passing.
 */
export function pearsonOf(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let count = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    sumA += a[i]
    sumB += b[i]
    count++
  }
  if (count < 3) return Number.NaN
  const meanA = sumA / count
  const meanB = sumB / count
  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    const da = a[i] - meanA
    const db = b[i] - meanB
    cov += da * db
    varA += da * da
    varB += db * db
  }
  const denominator = Math.sqrt(varA * varB)
  return denominator > 0 ? cov / denominator : Number.NaN
}

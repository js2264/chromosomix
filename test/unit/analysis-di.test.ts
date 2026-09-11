/**
 * The directionality index, against squares whose answer is arithmetic.
 *
 * Four properties, and each is a way a reimplementation produces a plausible
 * track that is wrong:
 *
 * - the **sign** — positive downstream — because a track with the sign inverted
 *   is a track whose every boundary is called on the wrong side, and the picture
 *   looks exactly as convincing either way;
 * - the **statistic**, checked against the long form Dixon writes it in, because
 *   the short form this module computes is an algebraic identity and an identity
 *   is worth verifying once rather than trusting;
 * - the **ends** of a linear sequence getting `NaN`, since a half window sums
 *   fewer cells on one side and reads as an enormous asymmetry at exactly the
 *   place a reader looks for a telomeric domain;
 * - and the **wrap**, which is the whole point of the circular flag: a circular
 *   sequence has no ends, so it has no `NaN`s, and a symmetric one scores zero
 *   everywhere rather than a rising ramp at its two artificial edges.
 */

import { describe, expect, it } from 'vitest'

import { maxSeparation, separation, squareBand } from '@/analysis/band'
import { directionalityIndex } from '@/analysis/di'

/** A symmetric square, built from a function of the two bins. */
function square(size: number, cell: (i: number, j: number) => number): Float32Array {
  const values = new Float32Array(size * size)
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) values[i * size + j] = cell(i, j)
  }
  return values
}

/** Dixon et al. 2012's own form, to check the identity this module collapses it to. */
function longForm(upstream: number, downstream: number): number {
  const expected = (upstream + downstream) / 2
  const chi =
    (upstream - expected) ** 2 / expected + (downstream - expected) ** 2 / expected
  return downstream >= upstream ? chi : -chi
}

describe('directionalityIndex', () => {
  it('is zero on a map with no direction in it', () => {
    const n = 40
    const band = squareBand(square(n, () => 1), n)
    const di = directionalityIndex(band, { window: 5, minValid: 1 })
    // Everything but the ends, which have no window on one side.
    for (let bin = 5; bin < n - 5; bin++) expect(di[bin]).toBe(0)
  })

  it('is positive where a bin looks downstream', () => {
    const n = 40
    // A contact map is symmetric, so "bin 20 looks downstream" cannot be written
    // as an asymmetric square — it is written by making the cells *joining* bin
    // 20 to its downstream neighbours heavier than the ones joining it to its
    // upstream ones, and mirroring both.
    const values = square(n, () => 1)
    for (let d = 1; d <= 5; d++) {
      values[20 * n + (20 + d)] = 2
      values[(20 + d) * n + 20] = 2
    }
    const di = directionalityIndex(squareBand(values, n), { window: 5, minValid: 1 })
    expect(di[20]).toBeGreaterThan(0)
    // Upstream 5 cells of 1, downstream 5 cells of 2 — and the long form of the
    // statistic, to check the identity the module collapses it to.
    expect(di[20]).toBeCloseTo(longForm(5, 10), 10)
  })

  it('is negative where a bin looks upstream', () => {
    const n = 40
    const values = square(n, () => 1)
    // The mirror image of the case above: the cells joining bin 20 to its
    // *upstream* neighbours are the heavy ones.
    for (let d = 1; d <= 5; d++) {
      values[(20 - d) * n + 20] = 2
      values[20 * n + (20 - d)] = 2
    }
    const di = directionalityIndex(squareBand(values, n), { window: 5, minValid: 1 })
    expect(di[20]).toBeLessThan(0)
    expect(di[20]).toBeCloseTo(longForm(10, 5), 10)
  })

  it('leaves the ends of a linear sequence as gaps, not as small numbers', () => {
    const n = 40
    const band = squareBand(square(n, () => 1), n)
    const di = directionalityIndex(band, { window: 5, minValid: 1 })
    for (let bin = 0; bin < 5; bin++) expect(di[bin]).toBeNaN()
    for (let bin = n - 5; bin < n; bin++) expect(di[bin]).toBeNaN()
  })

  it('scores every bin of a circular sequence, including its junction', () => {
    const n = 40
    const band = squareBand(square(n, () => 1), n, { circular: true })
    const di = directionalityIndex(band, { window: 5, minValid: 1 })
    for (let bin = 0; bin < n; bin++) expect(di[bin]).toBe(0)
  })

  it('reads the junction of a circle as one continuous stretch', () => {
    const n = 40
    // Contact that falls with the *circular* separation, which is what a
    // circular chromosome's near-diagonal looks like: bin 0 and bin 39 are
    // neighbours, so the cell joining them is as bright as any other pair one
    // bin apart.
    const values = square(n, (i, j) => 1 / (1 + separation(i, j, n, true)))
    const di = directionalityIndex(squareBand(values, n, { circular: true }), {
      window: 5,
      minValid: 1,
    })
    // No direction anywhere on a sequence whose contact depends only on
    // separation — the junction very much included.
    for (let bin = 0; bin < n; bin++) expect(di[bin]).toBeCloseTo(0, 10)
  })

  it('drops a bin whose window is mostly missing on one side only', () => {
    const n = 40
    const values = square(n, () => 1)
    // Four of bin 20's five upstream cells dropped by the balancer.
    for (let d = 2; d <= 5; d++) {
      values[(20 - d) * n + 20] = Number.NaN
      values[20 * n + (20 - d)] = Number.NaN
    }
    const di = directionalityIndex(squareBand(values, n), { window: 5, minValid: 0.5 })
    expect(di[20]).toBeNaN()
    // The neighbour, whose own window is whole, is unaffected.
    expect(di[30]).toBe(0)
  })
})

describe('separation and maxSeparation', () => {
  it('takes the short way round a circle and the only way along a line', () => {
    expect(separation(0, 39, 40, false)).toBe(39)
    expect(separation(0, 39, 40, true)).toBe(1)
    expect(separation(5, 12, 40, true)).toBe(7)
  })

  it('stops a circular band at half the sequence', () => {
    expect(maxSeparation(40, true)).toBe(20)
    expect(maxSeparation(40, false)).toBe(39)
  })
})

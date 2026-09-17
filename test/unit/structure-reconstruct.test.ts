/**
 * The reconstruction, held still (§25.6).
 *
 * The one golden a reconstruction can honestly have: a model that is *known*,
 * contacts made from it by the law the solver assumes, and the solver asked
 * for the model back. Distances are what is compared — a model is defined up
 * to a rigid motion and a reflection, and two models are the same model when
 * every pair is as far apart in one as in the other.
 */

import { describe, expect, it } from 'vitest'

import {
  classicalMds,
  constrainedBeads,
  distancesFromContacts,
  fillDistances,
  normaliseCoordinates,
  reconstruct,
  smacofStep,
  spearman,
  stressOf,
  subMatrix,
  type Coordinates,
} from '@/structure/reconstruct'

/** A helix of `n` beads on `contigs` sequences, one after the other. */
function helix(n: number): Coordinates {
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * 0.5
    x[i] = Math.cos(t) * 3
    y[i] = Math.sin(t) * 3
    z[i] = i * 0.35
  }
  return { x, y, z }
}

function pairDistances(c: Coordinates): number[] {
  const n = c.x.length
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      out.push(Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j], c.z[i] - c.z[j]))
    }
  }
  return out
}

/** Contacts as `d^(−α)`, with the pairs in `drop` left uncounted. */
function contactsOf(c: Coordinates, alpha: number, drop: (i: number, j: number) => boolean): Float32Array {
  const n = c.x.length
  const values = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || drop(i, j)) continue
      const d = Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j], c.z[i] - c.z[j])
      values[i * n + j] = Math.pow(d, -alpha)
    }
  }
  return values
}

const N = 60
const ALPHA = 3
const GROUP = Int32Array.from({ length: N }, (_, i) => (i < 40 ? 0 : 1))
const INDEX = Int32Array.from({ length: N }, (_, i) => (i < 40 ? i : i - 40))

describe('contacts to distances', () => {
  it('reads a count as c^(−1/α), symmetrised, and a zero as a missing pair', () => {
    const values = Float32Array.from([0, 8, 0, 8, 0, 1, 0, 3, 0])
    const d = distancesFromContacts(values, 3, 3)
    expect(d[0]).toBe(0)
    expect(d[1]).toBeCloseTo(0.5, 9)
    expect(d[3]).toBeCloseTo(0.5, 9)
    // (1,2): 1 one way and 3 the other → the mean, 2.
    expect(d[5]).toBeCloseTo(Math.pow(2, -1 / 3), 9)
    expect(d[2]).toBeNaN()
    expect(d[6]).toBeNaN()
  })

  it('drops a bead with no counted pair at all and keeps the rest', () => {
    const d = new Float64Array(9).fill(Number.NaN)
    d[0] = d[4] = d[8] = 0
    d[1] = d[3] = 1
    expect(Array.from(constrainedBeads(d, 3))).toEqual([0, 1])
    const sub = subMatrix(d, 3, Int32Array.from([0, 1]))
    expect(Array.from(sub)).toEqual([0, 1, 1, 0])
  })
})

describe('filling', () => {
  it('fills a cis gap from the mean at its separation, walking out when there is none', () => {
    const n = 5
    const d = new Float64Array(n * n).fill(Number.NaN)
    for (let i = 0; i < n; i++) d[i * n + i] = 0
    const set = (i: number, j: number, v: number): void => {
      d[i * n + j] = v
      d[j * n + i] = v
    }
    set(0, 1, 1)
    set(1, 2, 3)
    set(0, 2, 5)
    set(0, 4, 9)
    const group = new Int32Array(n)
    const index = Int32Array.from([0, 1, 2, 3, 4])
    const full = fillDistances(d, n, group, index)
    expect(full[2 * n + 3]).toBe(2) // separation 1: mean of 1 and 3
    expect(full[1 * n + 3]).toBe(5) // separation 2: the one observed
    expect(full[1 * n + 4]).toBe(5) // separation 3: none, nearest is 2 → 5
    expect(full[0 * n + 4]).toBe(9) // observed stays
    expect(d[2 * n + 3]).toBeNaN() // the original keeps its gaps
  })

  it('fills a trans gap from the mean trans distance', () => {
    const n = 4
    const d = new Float64Array(n * n).fill(Number.NaN)
    for (let i = 0; i < n; i++) d[i * n + i] = 0
    d[0 * n + 2] = d[2 * n + 0] = 4
    d[1 * n + 3] = d[3 * n + 1] = 6
    const full = fillDistances(d, n, Int32Array.from([0, 0, 1, 1]), Int32Array.from([0, 1, 0, 1]))
    expect(full[0 * n + 3]).toBe(5)
    expect(full[1 * n + 2]).toBe(5)
  })
})

describe('the solver', () => {
  it('gets a known helix back from complete contacts, to a rigid motion', () => {
    const truth = helix(N)
    const values = contactsOf(truth, ALPHA, () => false)
    const d = distancesFromContacts(values, N, ALPHA)
    const { coords, stress } = reconstruct(d, N, GROUP, INDEX, { iterations: 300 })
    expect(stress).toBeLessThan(1e-4)
    const rho = spearman(pairDistances(truth), pairDistances(coords))
    expect(rho).toBeGreaterThan(0.999)
    // Normalised: centred, unit root-mean-square radius.
    let sum = 0
    let cx = 0
    for (let i = 0; i < N; i++) {
      cx += coords.x[i]
      sum += coords.x[i] ** 2 + coords.y[i] ** 2 + coords.z[i] ** 2
    }
    expect(Math.abs(cx / N)).toBeLessThan(1e-9)
    expect(Math.sqrt(sum / N)).toBeCloseTo(1, 9)
  })

  it('still gets the helix back when most far pairs were never counted', () => {
    const truth = helix(N)
    // Only pairs within 12 beads on the same sequence, and one trans pair in
    // seven, are counted — the shape of a sparse map.
    const values = contactsOf(truth, ALPHA, (i, j) =>
      GROUP[i] === GROUP[j] ? Math.abs(i - j) > 12 : (i * 7 + j) % 7 !== 0,
    )
    const d = distancesFromContacts(values, N, ALPHA)
    const { coords, stress } = reconstruct(d, N, GROUP, INDEX, { iterations: 300 })
    // A helix turns every twelve or so beads, so a window of twelve says little
    // about where the turns stack: the classical start is far off (ρ ≈ 0.76)
    // and the refinement is what brings the model back.
    expect(stress).toBeLessThan(0.05)
    const rho = spearman(pairDistances(truth), pairDistances(coords))
    expect(rho).toBeGreaterThan(0.9)
  })

  it('lowers the stress with every step, and the classical start is already close', () => {
    const truth = helix(30)
    const group = new Int32Array(30)
    const index = Int32Array.from({ length: 30 }, (_, i) => i)
    const d = distancesFromContacts(contactsOf(truth, ALPHA, (i, j) => Math.abs(i - j) > 8), 30, ALPHA)
    const coords = classicalMds(fillDistances(d, 30, group, index), 30)
    let stress = stressOf(d, 30, coords)
    expect(stress).toBeLessThan(0.5)
    for (let k = 0; k < 20; k++) {
      const before = smacofStep(d, 30, coords)
      expect(before).toBeCloseTo(stress, 9)
      const after = stressOf(d, 30, coords)
      expect(after).toBeLessThanOrEqual(before + 1e-12)
      stress = after
    }
  })

  it('is deterministic: the same map gives the same model twice', () => {
    const truth = helix(20)
    const group = new Int32Array(20)
    const index = Int32Array.from({ length: 20 }, (_, i) => i)
    const d = distancesFromContacts(contactsOf(truth, ALPHA, () => false), 20, ALPHA)
    const a = reconstruct(d, 20, group, index, { iterations: 50 })
    const b = reconstruct(d, 20, group, index, { iterations: 50 })
    expect(Array.from(a.coords.x)).toEqual(Array.from(b.coords.x))
    expect(a.steps).toBe(b.steps)
  })

  it('normalises an empty or a one-point model without dividing by nothing', () => {
    const one: Coordinates = { x: Float64Array.from([3]), y: Float64Array.from([4]), z: Float64Array.from([5]) }
    normaliseCoordinates(one)
    expect(Array.from(one.x)).toEqual([0])
    const none: Coordinates = { x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }
    expect(() => normaliseCoordinates(none)).not.toThrow()
  })
})

describe('spearman', () => {
  it('is 1 on a monotone pair, −1 reversed, and ties share a rank', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9)
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 9)
    expect(spearman([1, 1, 2, 3], [1, 1, 2, 3])).toBeCloseTo(1, 9)
    expect(spearman([1, 2], [1, 2])).toBeNaN()
  })
})

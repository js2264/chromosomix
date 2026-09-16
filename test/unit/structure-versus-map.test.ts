/**
 * The model against the map (§25.6), over arrays: binning beads to a map's
 * bins, the distances and their agreement with contacts, and the three
 * tracks a model yields on its own.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import {
  agreement,
  beadsOf,
  binBeads,
  centroid,
  distanceBySeparation,
  distanceFrom,
  distanceMatrix,
  inverseDistances,
  localCompaction,
  paintProfile,
} from '@/structure/versusMap'

/** A straight chain of six 10 kb beads on chrA, one bead on chrB, unsorted. */
const MODEL = [
  'chrA 20000 2 0 0',
  'chrA 0 0 0 0',
  'chrA 10000 1 0 0',
  'chrA 30000 3 0 0',
  'chrA 40000 4 0 0',
  'chrA 50000 5 0 0',
  'chrB 0 0 5 0',
].join('\n')

function model() {
  const set = parseG3d(MODEL)
  if (set.model === undefined) throw new Error('no model')
  return { set, model: set.model }
}

describe('beads to bins', () => {
  it('takes each bin as the mean of the beads whose middle falls in it, and leaves the rest absent', () => {
    const { set, model: m } = model()
    const beads = beadsOf(set, 'chrA', -1)
    expect(beads).toHaveLength(6)
    // 20 kb bins over 80 kb of map: three bins with two beads each, one empty.
    const points = binBeads(set, m, beads, 20000, 4)
    expect(Array.from(points.present)).toEqual([1, 1, 1, 0])
    expect(Array.from(points.beads)).toEqual([2, 2, 2, 0])
    expect(points.x[0]).toBeCloseTo(0.5)
    expect(points.x[1]).toBeCloseTo(2.5)
    expect(points.x[2]).toBeCloseTo(4.5)
  })

  it('knows a haplotype from a phased file', () => {
    const phased = parseG3d(['chr1 0 0 0 0 m', 'chr1 0 1 0 0 p', 'chr1 5000 0 1 0 m', 'chr1 5000 1 1 0 p'].join('\n'))
    expect(beadsOf(phased, 'chr1', 0)).toHaveLength(2)
    expect(beadsOf(phased, 'chr1', 1)).toHaveLength(2)
    expect(beadsOf(phased, 'chr1', -1)).toHaveLength(4)
    expect(beadsOf(phased, 'chrZ', -1)).toEqual([])
  })
})

describe('distances', () => {
  it('is symmetric, zero on the diagonal, and absent against an empty bin', () => {
    const { set, model: m } = model()
    const points = binBeads(set, m, beadsOf(set, 'chrA', -1), 20000, 4)
    const d = distanceMatrix(points)
    expect(d[0 * 4 + 0]).toBe(0)
    expect(d[0 * 4 + 1]).toBeCloseTo(2)
    expect(d[1 * 4 + 0]).toBeCloseTo(2)
    expect(d[0 * 4 + 2]).toBeCloseTo(4)
    expect(Number.isNaN(d[0 * 4 + 3])).toBe(true)
    expect(Number.isNaN(d[3 * 4 + 3])).toBe(true)
  })

  it('predicts contacts as 1/d^alpha, absent where the distance is', () => {
    const d = Float32Array.from([0, 2, 2, 0])
    const predicted = inverseDistances(d, 3)
    expect(predicted[1]).toBeCloseTo(1 / 8)
    expect(Number.isNaN(predicted[0])).toBe(true)
    expect(Number.isNaN(inverseDistances(Float32Array.from([NaN]), 1)[0])).toBe(true)
  })

  it('averages the distance at each separation over the pairs that have one', () => {
    const { set, model: m } = model()
    const points = binBeads(set, m, beadsOf(set, 'chrA', -1), 20000, 4)
    const bySeparation = distanceBySeparation(distanceMatrix(points), 4)
    expect(bySeparation[1]).toBeCloseTo(2)
    expect(bySeparation[2]).toBeCloseTo(4)
    expect(Number.isNaN(bySeparation[3])).toBe(true)
  })
})

describe('agreement with the map', () => {
  it('is 1 for contacts that fall with distance, −1 for ones that rise, over pairs far enough apart', () => {
    const n = 5
    const points = {
      n,
      x: Float64Array.from([0, 1, 2, 3, 4]),
      y: new Float64Array(n),
      z: new Float64Array(n),
      present: new Uint8Array(n).fill(1),
      beads: new Int32Array(n).fill(1),
    }
    const d = distanceMatrix(points)
    const falling = new Float32Array(n * n)
    const rising = new Float32Array(n * n)
    for (let i = 0; i < n * n; i++) {
      falling[i] = 1 / (1 + d[i])
      rising[i] = d[i]
    }
    expect(agreement(d, falling, n).rho).toBeCloseTo(1)
    expect(agreement(d, rising, n).rho).toBeCloseTo(-1)
    // Pairs at separation 2, 3 and 4 only: 3 + 2 + 1.
    expect(agreement(d, falling, n).pairs).toBe(6)
    expect(agreement(d, falling, n, 1).pairs).toBe(10)
  })

  it('is not a number with too few pairs', () => {
    const d = Float32Array.from([0, 1, 1, 0])
    expect(Number.isNaN(agreement(d, Float32Array.from([1, 1, 1, 1]), 2, 1).rho)).toBe(true)
  })
})

describe('the model as tracks', () => {
  it('measures each bead from the centre, from a point, and from its chain neighbours', () => {
    const { set, model: m } = model()
    const beads = beadsOf(set, 'chrA', -1)
    const centre = centroid(m, beads)
    expect(centre).toEqual([2.5, 0, 0])
    const radial = distanceFrom(m, beads, centre ?? [0, 0, 0])
    expect(radial[0]).toBeCloseTo(2.5)
    expect(radial[5]).toBeCloseTo(2.5)
    const compaction = localCompaction(m, beads, 1)
    // An end bead has one neighbour at 1; a middle bead two at 1.
    expect(compaction[0]).toBeCloseTo(1)
    expect(compaction[2]).toBeCloseTo(1)
    const wider = localCompaction(m, beads, 2)
    expect(wider[2]).toBeCloseTo((2 + 1 + 1 + 2) / 4)
    expect(Number.isNaN(localCompaction(m, beadsOf(set, 'chrB', -1), 3)[0])).toBe(true)
  })

  it('paints bead values onto the map’s bins as means, from the sequence’s first bin', () => {
    const { set } = model()
    const beads = beadsOf(set, 'chrA', -1)
    const values = Float64Array.from([10, 20, 30, 40, 50, 60])
    const into = new Float32Array(12).fill(Number.NaN)
    paintProfile(set, beads, values, 20000, 4, 4, into)
    expect(Array.from(into.slice(4, 8))).toEqual([15, 35, 55, NaN])
    expect(Number.isNaN(into[0])).toBe(true)
  })
})

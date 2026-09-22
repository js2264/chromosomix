/**
 * The kernels the five new §18 tasks are built on, checked on their own.
 *
 * Each of these is arithmetic with no file and no worker in it, which is what
 * makes it testable here: a shuffle test, an independence model, a stratified
 * correlation, a mean filter and a re-binning. The tasks that call them are
 * checked where every other task is — the registry agreement, the runner, the
 * goldens — and what is asserted below is the thing a golden could not catch,
 * which is that the arithmetic means what its name says.
 */

import { describe, expect, it } from 'vitest'

import { shuffleNull, compareSets } from '@/analysis/overlap'
import { SequenceContactAccumulator, transExpectation } from '@/analysis/cistrans'
import { emptyStrata, smoothTileInto, stratumAdjusted, type Strata } from '@/analysis/hicrep'
// Aliased, because the kernel tests below build strata with a local helper of
// the same name. This is the *parameter*: how many of them a run asks for.
import { MAX_STRATA, strataOf as strataAsked } from '@/analysis/tasks/hicrep'
import { orientationFigure } from '@/analysis/orientation'
import type { FeatureSet } from '@/annotations/types'

const CONTIG_LENGTH = 1_000_000

/** A one-sequence feature set from `[start, end)` pairs. */
function features(spans: Array<[number, number]>): FeatureSet {
  const n = spans.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(spans.map(([from]) => from)),
    end: Int32Array.from(spans.map(([, to]) => to)),
    strand: new Int8Array(n),
    score: new Float32Array(n),
    name: spans.map((_, i) => `f${i}`),
    id: spans.map(() => ''),
    detail: spans.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(spans.map(() => -1)),
    cdsEnd: Int32Array.from(spans.map(() => -1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([Math.max(1, ...spans.map(([from, to]) => to - from))]),
  } as unknown as FeatureSet
}

describe('the overlap shuffle null', () => {
  const lengthOf = (): number => CONTIG_LENGTH

  it('reports a large enrichment for a set that sits inside the other', () => {
    // Forty 1 kb features, every one of them inside a 2 kb window of the second
    // set. Forty out of forty is not a number that says anything on its own —
    // it is the null that makes it a result.
    const anchors: Array<[number, number]> = []
    const windows: Array<[number, number]> = []
    for (let i = 0; i < 40; i++) {
      const at = 10_000 + i * 20_000
      anchors.push([at, at + 1000])
      windows.push([at - 500, at + 1500])
    }
    const test = shuffleNull(features(anchors), features(windows), {
      minFraction: 0.5,
      iterations: 200,
      seed: 7,
      lengthOf,
    })
    expect(test).not.toBeNull()
    expect(test?.featuresHit.observed).toBe(40)
    // The set covers 80 kb of a megabase, so chance would put about three of the
    // forty on one — a fold in the low tens, and the smallest p 200 shuffles can
    // report.
    expect(test?.featuresHit.fold).toBeGreaterThan(5)
    expect(test?.featuresHit.pEnriched).toBeCloseTo(1 / 201, 6)
    expect(test?.jaccard.fold).toBeGreaterThan(5)
  })

  it('reports about chance for two sets with no relationship', () => {
    const a: Array<[number, number]> = []
    const b: Array<[number, number]> = []
    for (let i = 0; i < 60; i++) {
      a.push([i * 16_000, i * 16_000 + 1000])
      // Offset by a third of the spacing, so the two interleave rather than
      // coincide — the same density and no shared position.
      b.push([i * 16_000 + 5333, i * 16_000 + 6333])
    }
    const test = shuffleNull(features(a), features(b), {
      minFraction: 0.5,
      iterations: 300,
      seed: 3,
      lengthOf,
    })
    expect(test).not.toBeNull()
    // Nothing overlaps, so the observed is zero and the null is not — which is
    // a depletion rather than an enrichment, and the tails must say so.
    expect(test?.featuresHit.observed).toBe(0)
    expect(test?.featuresHit.pDepleted).toBeLessThan(0.5)
    expect(test?.featuresHit.pEnriched).toBeCloseTo(1, 6)
  })

  it('is the same null twice from the same seed, and a different one from another', () => {
    const a = features([
      [1000, 2000],
      [50_000, 51_000],
      [900_000, 901_000],
    ])
    const b = features([
      [1500, 2500],
      [400_000, 401_000],
    ])
    const options = { minFraction: 0.1, iterations: 50, lengthOf }
    const first = shuffleNull(a, b, { ...options, seed: 11 })
    const again = shuffleNull(a, b, { ...options, seed: 11 })
    const other = shuffleNull(a, b, { ...options, seed: 12 })
    expect(first?.intersection.mean).toBe(again?.intersection.mean)
    expect(first?.intersection.mean).not.toBe(other?.intersection.mean)
  })

  it('never reports a p of zero, however many shuffles agree', () => {
    const a = features([[10_000, 11_000]])
    const b = features([[10_000, 11_000]])
    const test = shuffleNull(a, b, {
      minFraction: 0.5,
      iterations: 100,
      seed: 5,
      lengthOf,
    })
    // Phipson and Smyth: the floor is `1 / (iterations + 1)`, because a
    // permutation test cannot support a stronger claim than the number of
    // permutations it ran.
    expect(test?.intersection.pEnriched).toBeGreaterThan(0)
    expect(test?.intersection.pEnriched).toBeCloseTo(1 / 101, 6)
  })

  it('names the sequences whose length it had to assume', () => {
    const test = shuffleNull(features([[100, 200]]), features([[150, 250]]), {
      minFraction: 0.1,
      iterations: 10,
      seed: 1,
      lengthOf: () => undefined,
    })
    expect(test?.assumedLengths).toEqual(['I'])
  })

  it('agrees with compareSets about what was observed', () => {
    const a = features([
      [1000, 2000],
      [8000, 9000],
    ])
    const b = features([[1500, 8500]])
    const observed = compareSets(a, b, { minFraction: 0.1 })
    const test = shuffleNull(a, b, { minFraction: 0.1, iterations: 20, seed: 2, lengthOf })
    expect(test?.jaccard.observed).toBe(observed.jaccard)
    expect(test?.intersection.observed).toBe(observed.intersection)
    expect(test?.featuresHit.observed).toBe(observed.featuresAHit)
  })
})

describe('the cis/trans accumulator', () => {
  it('counts a trans contact once on the total and twice across the marginals', () => {
    const accumulator = new SequenceContactAccumulator(3)
    accumulator.add(0, 1, 10)
    expect(accumulator.transTotal).toBe(10)
    expect(accumulator.trans[0]).toBe(10)
    expect(accumulator.trans[1]).toBe(10)
    expect(accumulator.trans[2]).toBe(0)
    expect(accumulator.cis[0]).toBe(0)
  })

  it('keeps cis on its own sequence and out of the pairs', () => {
    const accumulator = new SequenceContactAccumulator(2)
    accumulator.add(1, 1, 7)
    expect(accumulator.cis[1]).toBe(7)
    expect(accumulator.transTotal).toBe(0)
    expect([...accumulator.pairs()]).toEqual([])
    expect(accumulator.pair(1, 1)).toBe(7)
  })

  it('sums a pair whichever order its ends arrive in', () => {
    const accumulator = new SequenceContactAccumulator(4)
    accumulator.add(2, 0, 3)
    accumulator.add(0, 2, 4)
    expect(accumulator.pair(0, 2)).toBe(7)
    expect(accumulator.pair(2, 0)).toBe(7)
    expect([...accumulator.pairs()]).toEqual([[0, 2, 7]])
  })

  it('drops a contact with an end outside every sequence, and counts it', () => {
    const accumulator = new SequenceContactAccumulator(2)
    accumulator.add(-1, 1, 5)
    expect(accumulator.dropped).toBe(5)
    expect(accumulator.trans[1]).toBe(0)
  })

  it('expects indifference at one, for a map that is indifferent', () => {
    // Six sequences with the same depth and contacts spread evenly between
    // them: every pair is exactly what indifference predicts, which is the
    // property the factor of two exists to make true and which a missing one
    // would report as a flat twofold enrichment across the whole map.
    const n = 6
    const accumulator = new SequenceContactAccumulator(n)
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) accumulator.add(a, b, 100)
    }
    const expectedOf = transExpectation(accumulator.trans, accumulator.transTotal)
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        expect(accumulator.pair(a, b) / expectedOf(a, b)).toBeCloseTo(1, 10)
      }
    }
  })

  it('expects exactly as many contacts as there are', () => {
    // The correction the closed-form scale exists for. Without it the model
    // spends part of the mass on a sequence contacting itself, which is not a
    // trans contact and is not in the table — so every enrichment on the map
    // comes out uniformly above one and a picture centred on 1 is centred on
    // nothing.
    const n = 5
    const accumulator = new SequenceContactAccumulator(n)
    let seed = 1
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return 10 + (seed % 200)
    }
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) accumulator.add(a, b, next())
    }
    const expectedOf = transExpectation(accumulator.trans, accumulator.transTotal)
    let total = 0
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) total += expectedOf(a, b)
    }
    expect(total).toBeCloseTo(accumulator.transTotal, 6)
  })

  it('has no expectation at all where there is no trans contact', () => {
    const expectedOf = transExpectation(new Float64Array(3), 0)
    expect(Number.isNaN(expectedOf(0, 1))).toBe(true)
  })
})

describe('the HiCRep kernel', () => {
  /** Strata whose `k`-th diagonal is `f(i, k)`. */
  function strataOf(bins: number, maxK: number, f: (i: number, k: number) => number): Strata {
    const out = emptyStrata(bins, maxK)
    for (let k = 0; k <= maxK; k++) {
      for (let i = 0; i + k < bins; i++) out[k][i] = f(i, k)
    }
    return out
  }

  it('scores a map against itself at one', () => {
    const a = strataOf(200, 20, (i, k) => Math.sin(i / 7) + k)
    expect(stratumAdjusted(a, a).scc).toBeCloseTo(1, 12)
  })

  it('scores a map against its own negative at minus one', () => {
    const a = strataOf(200, 20, (i) => Math.sin(i / 7))
    const b = strataOf(200, 20, (i) => -Math.sin(i / 7))
    expect(stratumAdjusted(a, b).scc).toBeCloseTo(-1, 12)
  })

  it('is unmoved by the decay the two maps share', () => {
    // The whole reason for stratifying: an enormous common gradient down the
    // diagonal is a constant *within* each stratum, so it contributes no
    // variance and cannot carry the coefficient. Two maps whose only agreement
    // is that gradient score about nothing.
    const decay = (k: number): number => 1000 / (k + 1)
    const a = strataOf(400, 30, (i, k) => decay(k) + Math.sin(i / 3))
    const b = strataOf(400, 30, (i, k) => decay(k) + Math.cos(i / 11))
    const scc = stratumAdjusted(a, b).scc
    expect(Math.abs(scc)).toBeLessThan(0.2)
  })

  it('weights a stratum by its own evidence, not by its index', () => {
    const a = strataOf(300, 3, (i, k) => (k === 0 ? Math.sin(i) : 1))
    const b = strataOf(300, 3, (i, k) => (k === 0 ? Math.sin(i) : 1))
    const result = stratumAdjusted(a, b)
    const varying = result.strata.find((stratum) => stratum.k === 0)
    const flat = result.strata.find((stratum) => stratum.k === 1)
    // A stratum with no variance has no correlation and no weight; one that
    // varies carries the whole answer.
    expect(varying?.weight).toBeGreaterThan(0)
    expect(flat?.weight ?? 0).toBe(0)
  })

  it('leaves out a stratum too thin to say anything', () => {
    const a = emptyStrata(10, 9)
    const b = emptyStrata(10, 9)
    for (let k = 0; k <= 9; k++) {
      for (let i = 0; i + k < 10; i++) {
        a[k][i] = i
        b[k][i] = i
      }
    }
    const result = stratumAdjusted(a, b)
    // `k = 8` has two positions and `k = 9` has one: two points always correlate
    // perfectly and say nothing, so neither is pooled.
    expect(result.strata.every((stratum) => stratum.n >= 3)).toBe(true)
  })

  it('has no answer where nothing can be compared', () => {
    const empty = emptyStrata(50, 5)
    expect(Number.isNaN(stratumAdjusted(empty, empty).scc)).toBe(true)
  })

  describe('the mean filter', () => {
    /** A tile whose cell `(r, c)` is `r * 10 + c`. */
    function tile(size: number): {
      values: Float32Array
      size: number
      from: number
      ownFrom: number
      ownTo: number
    } {
      const values = new Float32Array(size * size)
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) values[r * size + c] = r * 10 + c
      }
      return { values, size, from: 0, ownFrom: 0, ownTo: size }
    }

    it('takes the plain mean of the window it covers', () => {
      const into = emptyStrata(9, 2)
      smoothTileInto(tile(9), 1, 2, into)
      // `(4, 5)` with `h = 1`: rows 3–5, cols 4–6, whose mean is the centre's
      // own value by symmetry.
      expect(into[1][4]).toBeCloseTo(45, 10)
      // At the corner the window is clipped, so the mean is of rows 0–1 and
      // cols 0–1 — `(0 + 1 + 10 + 11) / 4`.
      expect(into[0][0]).toBeCloseTo(5.5, 10)
    })

    it('does nothing at all with a half-width of zero', () => {
      const into = emptyStrata(6, 2)
      smoothTileInto(tile(6), 0, 2, into)
      for (let i = 0; i < 4; i++) expect(into[2][i]).toBe(i * 10 + i + 2)
    })

    it('averages over the cells that have values, not over the window', () => {
      const size = 5
      const values = new Float32Array(size * size).fill(4)
      // One hole in the middle of the window around `(2, 2)`.
      values[1 * size + 1] = Number.NaN
      const into = emptyStrata(size, 0)
      smoothTileInto({ values, size, from: 0, ownFrom: 0, ownTo: size }, 1, 0, into)
      // Eight cells of four and one dropped: the mean is four, not four times
      // eight over nine. A window mean over the full area would report 3.56 and
      // pull every value near a gap towards zero.
      expect(into[0][2]).toBeCloseTo(4, 10)
    })

    it('says nothing where the whole window is missing', () => {
      const size = 3
      const values = new Float32Array(size * size).fill(Number.NaN)
      const into = emptyStrata(size, 0)
      smoothTileInto({ values, size, from: 0, ownFrom: 0, ownTo: size }, 1, 0, into)
      expect(Number.isNaN(into[0][1])).toBe(true)
    })

    it('writes only the rows its own tile owns, in the sequence’s coordinates', () => {
      const size = 6
      const values = new Float32Array(size * size).fill(1)
      const into = emptyStrata(20, 0)
      smoothTileInto({ values, size, from: 10, ownFrom: 12, ownTo: 14 }, 0, 0, into)
      expect(Number.isNaN(into[0][11])).toBe(true)
      expect(into[0][12]).toBe(1)
      expect(into[0][13]).toBe(1)
      expect(Number.isNaN(into[0][14])).toBe(true)
    })
  })
})

/**
 * **How far a run compares is a number of strata, and a stratum is a bin.**
 *
 * It was a separation in base pairs, divided by the bin size in two places — the
 * estimate and the runner — which is two chances to price a run the button did
 * not describe. And a stratum *is* a diagonal offset: it is why two maps on
 * different grids cannot be compared at all, which the estimate refuses by name.
 * So the parameter is the count, one expression reads it, and the cap is the
 * default because the 5 Mb it replaces hit that cap on every file at 10 kb or
 * finer.
 */
describe('how many strata a run asks for', () => {
  it('is the number asked for, with no bin size anywhere in it', () => {
    expect(strataAsked({ maxDistance: 120 })).toBe(120)
    expect(strataAsked({ maxDistance: 1 })).toBe(1)
  })

  it('is capped, and the cap is what an unanswered run takes', () => {
    expect(strataAsked({ maxDistance: 5_000 })).toBe(MAX_STRATA)
    expect(strataAsked({})).toBe(MAX_STRATA)
    // A stored session from before the change carries base pairs; it lands on
    // the cap, which is the run its 5 Mb produced on every file finer than
    // 10 kb anyway.
    expect(strataAsked({ maxDistance: 5_000_000 })).toBe(MAX_STRATA)
  })

  it('never asks for none, however it is answered', () => {
    expect(strataAsked({ maxDistance: 0 })).toBe(1)
    expect(strataAsked({ maxDistance: -4 })).toBe(1)
    expect(strataAsked({ maxDistance: 'many' })).toBe(MAX_STRATA)
  })
})

describe('the orientation curves', () => {
  /** Fine log edges of the shape `pairs/bin.ts` accumulates on. */
  function edgesTo(longest: number): Float64Array {
    const edges: number[] = [0, 1]
    let at = 1
    while (at < longest) {
      at = Math.max(at + 1, Math.round(at * 1.05))
      edges.push(at)
    }
    return Float64Array.from(edges)
  }

  /** Counts shaped by `f(separation, which)`, on those edges. */
  function counts(
    edges: Float64Array,
    f: (separation: number, which: number) => number,
  ): [Float64Array, Float64Array, Float64Array, Float64Array] {
    const out = [0, 1, 2, 3].map(() => new Float64Array(edges.length - 1)) as [
      Float64Array,
      Float64Array,
      Float64Array,
      Float64Array,
    ]
    for (let bin = 0; bin < edges.length - 1; bin++) {
      const at = Math.sqrt(Math.max(1, edges[bin]) * edges[bin + 1])
      for (let which = 0; which < 4; which++) out[which][bin] = f(at, which)
    }
    return out
  }

  it('finds the separation the four settle at', () => {
    const edges = edgesTo(2_000_000)
    // A shared decay everywhere, plus a spike in the inward orientation alone
    // below 3 kb — which is what a self-circle looks like in this picture.
    const figure = orientationFigure(
      {
        edges,
        counts: counts(edges, (at, which) => {
          const shared = 1e9 / (at * at)
          return which === 1 && at < 3000 ? shared * 50 : shared
        }),
        total: 0,
      },
      { factor: 1.2 },
    )
    expect(figure).not.toBeNull()
    expect(figure?.curves).toHaveLength(4)
    expect(figure?.convergence).not.toBeNull()
    // Found somewhere around where the spike stops, rather than at the far end
    // or at the very start.
    expect(figure?.convergence).toBeGreaterThan(1500)
    expect(figure?.convergence).toBeLessThan(20_000)
  })

  it('converges at the very bottom where nothing disagrees', () => {
    const edges = edgesTo(500_000)
    const figure = orientationFigure(
      { edges, counts: counts(edges, (at) => 1e6 / at), total: 0 },
      { factor: 1.3 },
    )
    expect(figure?.convergence).not.toBeNull()
    // The whole axis agrees, so the point found is its first bin.
    expect(figure?.convergence).toBeLessThan(10)
  })

  it('reports no convergence where the four never settle', () => {
    const edges = edgesTo(500_000)
    const figure = orientationFigure(
      {
        edges,
        // One orientation ten times the others, at every separation. Under the
        // shared denominator that is a real disagreement everywhere, which is
        // what a library with a systematic orientation bias looks like.
        counts: counts(edges, (at, which) => (which === 0 ? 1e7 : 1e6) / at),
        total: 0,
      },
      { factor: 1.3 },
    )
    expect(figure?.convergence).toBeNull()
  })

  it('shares one denominator, so an abundance difference does not divide out', () => {
    const edges = edgesTo(200_000)
    const figure = orientationFigure(
      {
        edges,
        // Two orientations with the same *shape* and different abundance.
        counts: counts(edges, (at, which) => (which < 2 ? (which + 1) * 1000 : 0) / at),
        total: 0,
      },
      { factor: 1.4 },
    )
    expect(figure?.curves).toHaveLength(2)
    const [first, second] = figure!.curves
    // Twice the records, twice the height — everywhere. Normalising each curve
    // by its own total would lay these two on top of each other and, with them,
    // the short-range excess the whole figure exists to show.
    for (let i = 0; i < first.y.length; i++) {
      if (!Number.isFinite(first.y[i]) || !Number.isFinite(second.y[i])) continue
      expect(second.y[i] / first.y[i]).toBeCloseTo(2, 8)
    }
    expect(second.n).toBeCloseTo(first.n * 2, 6)
  })

  it('is a density over the records in all four', () => {
    const edges = edgesTo(100_000)
    const figure = orientationFigure(
      { edges, counts: counts(edges, (at) => 1e6 / at), total: 0 },
      { factor: 1.2 },
    )
    // Every curve integrated over the axis, summed: one, because the four share
    // the denominator and between them hold every record.
    let mass = 0
    for (const curve of figure!.curves) {
      for (let i = 0; i < curve.x.length; i++) {
        if (!Number.isFinite(curve.y[i])) continue
        const lo = i === 0 ? curve.x[0] ** 2 / curve.x[1] : Math.sqrt(curve.x[i - 1] * curve.x[i])
        const hi =
          i === curve.x.length - 1
            ? curve.x[i] ** 2 / curve.x[i - 1]
            : Math.sqrt(curve.x[i] * curve.x[i + 1])
        mass += curve.y[i] * (hi - lo)
      }
    }
    expect(mass).toBeGreaterThan(0.9)
    expect(mass).toBeLessThan(1.1)
  })

  it('has nothing to say with fewer than two orientations', () => {
    const edges = edgesTo(100_000)
    const figure = orientationFigure(
      { edges, counts: counts(edges, (at, which) => (which === 3 ? 1e6 / at : 0)), total: 0 },
      { factor: 1.5 },
    )
    expect(figure).toBeNull()
  })
})

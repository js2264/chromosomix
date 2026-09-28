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
    const a = strataOf(200, 20, (i, k) => Math.sin(i / 7) + k + 2)
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

  /**
   * The variance-stabilised weight: `n` times the variance of the ranks of `n`
   * values, which is `(n + 1) / 12` whatever the values are. A diagonal counts by
   * how many positions it compares — never by how large or how varied its counts
   * are, which is what let the few diagonals nearest the main one carry the
   * number before.
   */
  it('weighs every stratum by the positions it compares, and nothing else', () => {
    const a = strataOf(100, 3, (i, k) => (k === 1 ? 1000 * Math.sin(i) + 2000 : Math.sin(i) + 2))
    const b = strataOf(100, 3, (i, k) => (k === 1 ? 1000 * Math.cos(i) + 2000 : Math.sin(i) + 2))
    const result = stratumAdjusted(a, b)
    expect(result.strata.map((stratum) => [stratum.k, stratum.n, stratum.weight])).toEqual([
      [1, 99, 100 / 12],
      [2, 98, 99 / 12],
      [3, 97, 98 / 12],
    ])
    const [one, two, three] = result.strata
    expect(result.scc).toBeCloseTo(
      (one.weight * one.r + two.weight * two.r + three.weight * three.r) /
        (one.weight + two.weight + three.weight),
      12,
    )
  })

  it('never compares the main diagonal', () => {
    const a = strataOf(50, 2, (i) => i + 1)
    const result = stratumAdjusted(a, a)
    expect(result.strata.map((stratum) => stratum.k)).toEqual([1, 2])
  })

  it('compares where either map has a contact, and leaves out where neither does', () => {
    const a = emptyStrata(6, 1)
    const b = emptyStrata(6, 1)
    a[1].set([0, 2, 0, 4, 5, Number.NaN])
    b[1].set([0, 0, 3, 1, 5, Number.NaN])
    // Positions 1 to 4: position 0 is zero in both, and 5 is past the diagonal.
    expect(stratumAdjusted(a, b).strata[0].n).toBe(4)
  })

  it('counts a stratum with no correlation as zero, with its weight', () => {
    // One map constant along the second diagonal: its correlation is undefined,
    // and the reference pools it as a zero that still carries its weight.
    const a = strataOf(40, 2, (i, k) => (k === 2 ? 7 : i + 1))
    const b = strataOf(40, 2, (i) => i + 1)
    const result = stratumAdjusted(a, b)
    expect(result.strata[1].r).toBeNaN()
    const [one, two] = result.strata
    expect(result.scc).toBeCloseTo((one.weight * one.r) / (one.weight + two.weight), 12)
  })

  it('leaves out a stratum of one position, and pools one of two', () => {
    const a = emptyStrata(10, 9)
    const b = emptyStrata(10, 9)
    for (let k = 0; k <= 9; k++) {
      for (let i = 0; i + k < 10; i++) {
        a[k][i] = i + 1
        b[k][i] = i + 1
      }
    }
    const result = stratumAdjusted(a, b)
    // `k = 8` has two positions and `k = 9` has one; the reference's weight is
    // undefined under two.
    expect(result.strata.map((stratum) => stratum.k)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('has no answer where nothing can be compared', () => {
    const empty = emptyStrata(50, 5)
    expect(Number.isNaN(stratumAdjusted(empty, empty).scc)).toBe(true)
  })

  /**
   * The whole kernel — trim, smooth, compare, pool — against `hicrep` 0.2.6 on a
   * pair of 40-bin maps with zeros scattered through both. Each expected value is
   * what `hicrep.hicrep.sccByDiag` returns for the same counts, after its own
   * `trimDiags` and `meanFilterSparse`, at the same `h` and ten strata.
   */
  it('is hicrep 0.2.6’s coefficient, to the last places', () => {
    const size = 40
    const maxK = 10
    const counts = (f: (i: number, j: number) => number): Float32Array => {
      const values = new Float32Array(size * size)
      for (let i = 0; i < size; i++) {
        for (let j = i; j < size; j++) {
          values[i * size + j] = f(i, j)
          values[j * size + i] = f(i, j)
        }
      }
      return values
    }
    const first = counts((i, j) => {
      const v = (i * 7919 + j * 104729 + 17) % 23
      return v < 8 ? 0 : v - 8
    })
    const second = counts((i, j) => {
      const v = (i * 104729 + j * 7919 + 5) % 19
      return v < 6 ? 0 : v - 6
    })
    const smoothed = (values: Float32Array, h: number): Strata => {
      const into = emptyStrata(size, maxK)
      smoothTileInto({ values, size, from: 0, ownFrom: 0, ownTo: size }, h, maxK, into)
      return into
    }
    const hicrep = [-0.20423464041983147, 0.011723637111902174, 0.06983099051628908]
    for (const h of [0, 1, 2]) {
      expect(stratumAdjusted(smoothed(first, h), smoothed(second, h)).scc).toBeCloseTo(hicrep[h], 12)
    }
  })

  describe('the mean filter', () => {
    /** A tile whose cell `(r, c)` is `r * 10 + c`, both triangles. */
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

    it('averages the upper band only, zeros below and on the diagonal counted', () => {
      const into = emptyStrata(9, 3)
      smoothTileInto(tile(9), 1, 3, into)
      // `(4, 5)` with `h = 1`: rows 3–5 by columns 4–6. The band `1 ≤ c − r ≤ 3`
      // holds six of the nine cells — (3,4) (3,5) (3,6) (4,5) (4,6) (5,6) — and
      // the other three are the zeros of the diagonal and below it.
      expect(into[1][4]).toBeCloseTo((34 + 35 + 36 + 45 + 46 + 56) / 9, 10)
    })

    it('counts the window inside the sequence, as the reference does at an end', () => {
      const into = emptyStrata(9, 3)
      smoothTileInto(tile(9), 1, 3, into)
      // `(0, 1)`: rows 0–1 by columns 0–2, six cells, of which (0,1) (0,2) and
      // (1,2) are in the band.
      expect(into[1][0]).toBeCloseTo((1 + 2 + 12) / 6, 10)
    })

    it('sets the diagonals past the furthest compared to zero before smoothing', () => {
      const into = emptyStrata(9, 2)
      smoothTileInto(tile(9), 1, 2, into)
      // `(4, 6)`: rows 3–5 by columns 5–7, and (3,6) (3,7) (4,7) are three and
      // four diagonals out — past the two compared, so zeros.
      expect(into[2][4]).toBeCloseTo((35 + 45 + 46 + 56 + 57) / 9, 10)
    })

    it('does nothing at all with a half-width of zero', () => {
      const into = emptyStrata(6, 2)
      smoothTileInto(tile(6), 0, 2, into)
      for (let i = 0; i < 4; i++) expect(into[2][i]).toBe(i * 10 + i + 2)
      // The main diagonal is never filled: it is not compared.
      expect(Number.isNaN(into[0][0])).toBe(true)
    })

    it('averages over the cells that have values, and counts the ones that are zero', () => {
      const size = 8
      const values = new Float32Array(size * size).fill(4)
      // One dropped cell in the window around `(2, 5)`.
      values[1 * size + 4] = Number.NaN
      const into = emptyStrata(size, 5)
      smoothTileInto({ values, size, from: 0, ownFrom: 0, ownTo: size }, 1, 5, into)
      // Rows 1–3 by columns 4–6, separations 1 to 5, all in the band: eight
      // cells of four and one dropped. The mean is four — the dropped cell leaves
      // the count as well as the sum — where a mean over the whole window would
      // pull it towards zero.
      expect(into[3][2]).toBeCloseTo(4, 10)
    })

    it('says nothing where the whole window is missing', () => {
      const size = 4
      const values = new Float32Array(size * size).fill(Number.NaN)
      const into = emptyStrata(size, 1)
      smoothTileInto({ values, size, from: 0, ownFrom: 0, ownTo: size }, 0, 1, into)
      expect(Number.isNaN(into[1][1])).toBe(true)
    })

    it('is exactly zero where the window holds no contact', () => {
      const size = 12
      const values = new Float32Array(size * size)
      // Large values far from a zero window, so a difference of prefix sums
      // would leave a residue there.
      for (let c = 8; c < size; c++) values[0 * size + c] = 1e7 + 0.3
      const into = emptyStrata(size, 2)
      smoothTileInto({ values, size, from: 0, ownFrom: 0, ownTo: size }, 1, 2, into)
      expect(into[1][4]).toBe(0)
    })

    it('writes only the rows its own tile owns, in the sequence’s coordinates', () => {
      const size = 6
      const values = new Float32Array(size * size).fill(1)
      const into = emptyStrata(20, 1)
      smoothTileInto({ values, size, from: 10, ownFrom: 12, ownTo: 14 }, 0, 1, into)
      expect(Number.isNaN(into[1][11])).toBe(true)
      expect(into[1][12]).toBe(1)
      expect(into[1][13]).toBe(1)
      expect(Number.isNaN(into[1][14])).toBe(true)
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

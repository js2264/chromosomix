// @dev-feature curate
/**
 * The curation's method (SPECS §33.5): the contig network's tallies, the
 * background, affinity and its lower bound, significance, and the confidence of
 * each kind of suggestion — on networks small enough to count by hand. The
 * numbers on the demo map, against a Python oracle and the mock's truth, are in
 * the demo suite.
 */

import { describe, expect, it } from 'vitest'
import {
  affinity,
  affinityBetween,
  background,
  confidenceOf,
  contactsBetween,
  contigFeatures,
  densities,
  densityOf,
  INITIAL_WEIGHTS,
  learn,
  linkFeatures,
  lowerAffinity,
  mergeFeatures,
  poissonLower,
  significance,
  tally,
  visibility,
  type ContigNetwork,
  type MethodBinning,
} from '../../src/curate/method'

/** Contigs 0–2 in genome 0, 3–4 in genome 1, 5 an element, 6 in the pool. */
function network(): ContigNetwork {
  const pairs: Array<[number, number, number]> = [
    [0, 1, 40],
    [0, 2, 30],
    [1, 2, 50],
    [3, 4, 60],
    [2, 3, 2],
    [4, 5, 9],
    [1, 6, 7],
  ]
  return {
    contigs: 7,
    first: Int32Array.from(pairs.map((p) => p[0])),
    second: Int32Array.from(pairs.map((p) => p[1])),
    contacts: Float64Array.from(pairs.map((p) => p[2])),
    within: new Float64Array(7),
  }
}

const BINNING: MethodBinning = { genomeOf: Int32Array.from([0, 0, 0, 1, 1, 2, -1]), kinds: Uint8Array.from([0, 0, 1]) }

describe('the tallies', () => {
  const net = network()
  const t = visibility(net)
  const tallied = tally(net, t, BINNING)

  it('give each contig its contacts with every other', () => {
    expect([...t]).toEqual([70, 97, 82, 62, 69, 9, 7])
  })

  it('give each genome its contacts within, between, and its visibility', () => {
    expect([...tallied.within]).toEqual([120, 60, 0])
    expect(contactsBetween(tallied, 0, 1)).toBe(2)
    expect(contactsBetween(tallied, 1, 2)).toBe(9)
    expect(contactsBetween(tallied, 2, 1)).toBe(9)
    expect([...tallied.visibility]).toEqual([249, 131, 9])
    expect(tallied.total).toBe(396)
    expect([...tallied.size]).toEqual([3, 2, 1])
  })
})

describe('affinity', () => {
  it('is observed over expected, over the genome’s own: O·t_g / (2·t_X·O_gg)', () => {
    const tallied = tally(network(), visibility(network()), BINNING)
    const d = densities(tallied)
    const T = tallied.total
    // Contig 6 (the pool) with genome 0: 7 contacts.
    const a = affinity(7, 7, tallied.visibility[0], densityOf(d, 0), T)
    expect(a).toBeCloseTo((7 * 249) / (2 * 7 * 120), 12)
  })

  it('between two genomes is O_ab / (2 √(O_aa O_bb)), the geometric mean of both directions', () => {
    const tallied = tally(network(), visibility(network()), BINNING)
    const d = densities(tallied)
    const T = tallied.total
    const ab = affinityBetween(2, tallied.visibility[0], tallied.visibility[1], d.own[0], d.own[1], T)
    expect(ab).toBeCloseTo(2 / (2 * Math.sqrt(120 * 60)), 12)
    const one = affinity(2, tallied.visibility[0], tallied.visibility[1], d.own[1], T)
    const two = affinity(2, tallied.visibility[1], tallied.visibility[0], d.own[0], T)
    expect(ab).toBeCloseTo(Math.sqrt(one * two), 12)
  })

  it('is about one for the two halves of one genome', () => {
    // Eight contigs all in contact with each other, ten contacts each pair,
    // split four and four.
    const first: number[] = []
    const second: number[] = []
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      first.push(i)
      second.push(j)
    }
    const net: ContigNetwork = {
      contigs: 8,
      first: Int32Array.from(first),
      second: Int32Array.from(second),
      contacts: new Float64Array(first.length).fill(10),
      within: new Float64Array(8),
    }
    const halves: MethodBinning = { genomeOf: Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), kinds: Uint8Array.from([0, 0]) }
    const tallied = tally(net, visibility(net), halves)
    const d = densities(tallied)
    // Each half: 6 pairs within (60), 16 between (160): 160 / (2 · 60) is 4/3,
    // since a half's own pairs are fewer than its pairs with the other half.
    expect(affinityBetween(160, tallied.visibility[0], tallied.visibility[1], d.own[0], d.own[1], tallied.total)).toBeCloseTo(160 / 120, 12)
  })

  it('takes the typical density for a genome with no contact between two of its contigs', () => {
    const tallied = tally(network(), visibility(network()), BINNING)
    const d = densities(tallied)
    expect(Number.isNaN(d.own[2])).toBe(true)
    expect(densityOf(d, 2)).toBe(d.typical)
    expect(d.typical).toBeCloseTo((d.own[0] + d.own[1]) / 2, 12)
  })

  it('is nought where nothing could be expected', () => {
    expect(affinity(3, 0, 10, 1, 100)).toBe(0)
    expect(affinityBetween(3, 10, 10, Number.NaN, 1, 100)).toBe(0)
  })
})

describe('the lower bound of a Poisson mean', () => {
  // SciPy's chi2.ppf(0.1, 2o) / 2.
  const scipy: Array<[number, number]> = [
    [1, 0.10536051565782636],
    [2, 0.531811608389612],
    [3, 1.1020653282493214],
    [5, 2.432591025962664],
    [10, 6.221304605225031],
    [37, 29.449981231168554],
    [100, 87.41763649959366],
    [1000, 959.6939327288333],
    [10000, 9872.060875049736],
    [123456, 123005.92478784113],
  ]
  it.each(scipy)('for %i contacts is χ²(0.1; 2o)/2 = %f', (o, expected) => {
    expect(poissonLower(o)).toBeCloseTo(expected, Math.max(4, 12 - Math.ceil(Math.log10(expected + 1))))
    expect(Math.abs(poissonLower(o) - expected) / expected).toBeLessThan(1e-10)
  })

  it('is nought for nought, and scales an affinity by its share', () => {
    expect(poissonLower(0)).toBe(0)
    expect(lowerAffinity(2, 1)).toBeCloseTo(2 * 0.10536051565782636, 12)
    expect(lowerAffinity(2, 0)).toBe(0)
  })
})

describe('the background', () => {
  it('is the median of observed over expected over every two MAGs, a pair that shares nothing counted as nought', () => {
    // Four MAGs of equal visibility 100 in T 400: every pair expects 25.
    const tallied = {
      genomes: 4,
      visibility: Float64Array.from([100, 100, 100, 100]),
      within: new Float64Array(4),
      between: new Map([
        [0 * 4 + 1, 5],
        [0 * 4 + 2, 1],
        [2 * 4 + 3, 50],
      ]),
      total: 400,
      size: Int32Array.from([1, 1, 1, 1]),
    }
    // Six pairs: 0.2, 0.04, 2 and three noughts — a median of (0.04 + 0) / 2... sorted 0,0,0,0.04,0.2,2.
    const b = background(tallied, Uint8Array.from([0, 0, 0, 0]))
    expect(b.how).toBe('median')
    expect(b.pairs).toBe(6)
    expect(b.rho).toBeCloseTo((0 + 0.04) / 2, 12)
  })

  it('takes the total where more than half the pairs share nothing, and says so', () => {
    const tallied = {
      genomes: 4,
      visibility: Float64Array.from([100, 100, 100, 100]),
      within: new Float64Array(4),
      between: new Map([[0 * 4 + 1, 10]]),
      total: 400,
      size: Int32Array.from([1, 1, 1, 1]),
    }
    const b = background(tallied, Uint8Array.from([0, 0, 0, 0]))
    expect(b.how).toBe('total')
    expect(b.rho).toBeCloseTo(10 / (6 * 25), 12)
  })

  it('leaves elements out, and falls to one contact over everything with fewer than two MAGs', () => {
    const tallied = tally(network(), visibility(network()), { genomeOf: BINNING.genomeOf, kinds: Uint8Array.from([0, 1, 1]) })
    expect(background(tallied, Uint8Array.from([0, 1, 1]))).toEqual({ rho: 1 / 396, how: 'floor', pairs: 0 })
  })
})

describe('significance', () => {
  it('is the chance spurious ligation alone gives as many contacts or more', () => {
    // ρ·tX·tG/T = 0.5: P(N ≥ 5) is SciPy's poisson.sf(4, 0.5).
    expect(significance(5, 10, 20, 0.5, 200)).toBeCloseTo(0.00017211562995584072, 15)
    expect(significance(0, 10, 20, 0.5, 200)).toBe(1)
  })
})

describe('confidence', () => {
  it('offers a merge of two genomes meeting a tenth as densely as their own, on a hundred contacts, at even odds', () => {
    expect(confidenceOf(mergeFeatures(0.1, 99, 0, 0, 1e-9), INITIAL_WEIGHTS.merge)).toBeCloseTo(0.5, 12)
  })

  it('turns down a merge that would duplicate every marker the smaller genome has', () => {
    const complementary = confidenceOf(mergeFeatures(0.3, 1000, 0, 30, 1e-9), INITIAL_WEIGHTS.merge)
    const duplicated = confidenceOf(mergeFeatures(0.3, 1000, 30, 30, 1e-9), INITIAL_WEIGHTS.merge)
    expect(complementary).toBeGreaterThan(0.95)
    expect(duplicated).toBeLessThan(0.15)
    // A fragment with one marker neither helps nor harms much.
    expect(confidenceOf(mergeFeatures(0.3, 1000, 1, 1, 1e-9), INITIAL_WEIGHTS.merge)).toBeGreaterThan(0.8)
  })

  it('caps a recruit’s affinity, so a few contacts with a tiny genome are not certainty', () => {
    const huge = contigFeatures(50, 0, 0, 1e-9)
    expect(huge[0]).toBe(2)
    expect(huge[1]).toBe(3)
    expect(confidenceOf(contigFeatures(0.5, 0.5, 0, 1e-9), INITIAL_WEIGHTS.recruit)).toBeCloseTo(0.5, 12)
    // The background fails: three down.
    expect(confidenceOf(contigFeatures(0.5, 0.5, 0, 0.5), INITIAL_WEIGHTS.recruit)).toBeCloseTo(1 / (1 + Math.exp(3)), 12)
  })

  it('asks a move more than a recruit: the binning put the contig where it is', () => {
    const f = contigFeatures(1, 0.25, 0, 1e-9)
    expect(confidenceOf(f, INITIAL_WEIGHTS.move)).toBeLessThan(confidenceOf(f, INITIAL_WEIGHTS.recruit))
  })

  it('offers a link at even odds at a fifth of the MAG’s own density and a tenth of the element’s contacts', () => {
    expect(confidenceOf(linkFeatures(0.2, 0.1, 1e-9), INITIAL_WEIGHTS.link)).toBeCloseTo(0.5, 12)
  })

  it('learns from an answer, pulled back towards the initial weights', () => {
    const f = linkFeatures(0.2, 0.1, 1e-9)
    const after = learn('link', INITIAL_WEIGHTS.link, f, false)
    expect(confidenceOf(f, after)).toBeLessThan(0.5)
    // Three rejections of a link at 92% leave it above even odds.
    const strong = linkFeatures(0.8, 0.4, 1e-9)
    let w: readonly number[] = INITIAL_WEIGHTS.link
    for (let i = 0; i < 3; i++) w = learn('link', w, strong, false)
    expect(confidenceOf(strong, w)).toBeGreaterThan(0.5)
  })
})

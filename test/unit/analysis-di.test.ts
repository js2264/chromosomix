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
import { directionBorders, directionalityIndex, integratedDirection } from '@/analysis/di'
import { ExpectedAccumulator } from '@/analysis/expected'
import { domainsBetween } from '@/analysis/insulation'

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

/**
 * P(s) round a circle.
 *
 * The separation two bins are at is the one number a decay curve is built from,
 * and on a circular sequence it is the shorter of the two ways round. Scored as
 * a line, a circular chromosome's curve stops falling and turns *up* at the far
 * end — those are the contacts joining the two ends of the molecule, which are
 * local contacts wearing a chromosome-long separation — and every fit through
 * that tail is a fit through an artefact.
 */
describe('ExpectedAccumulator, round a circle', () => {
  it('measures separation the short way round', () => {
    const circle = new ExpectedAccumulator(20, 40)
    expect(circle.separation(0, 39)).toBe(1)
    expect(circle.separation(5, 12)).toBe(7)
    expect(circle.separation(0, 20)).toBe(20)
    const line = new ExpectedAccumulator(39)
    expect(line.separation(0, 39)).toBe(39)
  })

  it('turns a circular map’s decay into a decay rather than a fold', () => {
    const n = 40
    const values = new Float32Array(n * n)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Contact that falls with the circular separation — what a circular
        // chromosome's map actually looks like.
        const d = Math.min(Math.abs(i - j), n - Math.abs(i - j))
        values[i * n + j] = 1 / (1 + d)
      }
    }
    const block = {
      nrows: n,
      ncols: n,
      values,
      rowExtent: [0, n] as [number, number],
      colExtent: [0, n] as [number, number],
    }

    const circle = new ExpectedAccumulator(n / 2, n)
    circle.addBlock(block)
    const round = circle.finish()
    // Monotonically falling all the way to half way round, which is as far apart
    // as two bins on this sequence can be.
    for (let k = 1; k <= n / 2; k++) expect(round.mean[k]).toBeLessThan(round.mean[k - 1])

    const line = new ExpectedAccumulator(n - 1)
    line.addBlock(block)
    const straight = line.finish()
    // The same map read as a line: the curve turns back up past half way, which
    // is the artefact, and it is large.
    expect(straight.mean[n - 1]).toBeGreaterThan(straight.mean[n / 2])
  })
})

/**
 * Borders and domains, from the shape of the index rather than its values.
 *
 * A domain reads as a positive block followed by a negative one, so the border
 * between two of them is the negative-to-positive flip — and the thing that
 * makes calling it delicate is that the flip is a *shape* and a noisy track
 * crosses zero many times inside one domain. The properties below are the four
 * ways a caller gets a plausible set of borders that is wrong:
 *
 * - the **bin**, because a border reported one bin early is a domain set adrift
 *   by one bin at both ends, which at 40 kb is 40 kb of the neighbour;
 * - the **stutter**, because a track that wobbles across zero has crossings a
 *   bin apart and only one of them is an edge;
 * - the **depth**, because the index is a χ² and grows with sequencing, so a
 *   caller that thresholds the raw curve calls twice as many borders on the same
 *   structure sequenced twice as far;
 * - and the **gaps**, since a dropped stretch must not be able to be the floor of
 *   a trough.
 */


/** A DI track for domains of the given lengths: first half downstream, second up. */
function domainsOf(lengths: readonly number[], amplitude = 1): Float64Array {
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const out = new Float64Array(total)
  let at = 0
  for (const length of lengths) {
    const half = length / 2
    for (let i = 0; i < length; i++) out[at + i] = i < half ? amplitude : -amplitude
    at += length
  }
  return out
}

describe('integratedDirection', () => {
  it('climbs through a downstream block and falls through an upstream one', () => {
    const curve = integratedDirection(domainsOf([20]))
    // Ten bins up, ten back down, so the peak is the middle of the domain and
    // the floor is its far end.
    expect(curve[9]).toBeCloseTo(10, 10)
    expect(curve[19]).toBeCloseTo(0, 10)
    for (let i = 1; i <= 9; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1])
    for (let i = 11; i <= 19; i++) expect(curve[i]).toBeLessThan(curve[i - 1])
  })

  it('is unchanged by how deep the library was sequenced', () => {
    const shallow = integratedDirection(domainsOf([20, 20], 1))
    const deep = integratedDirection(domainsOf([20, 20], 37))
    for (let i = 0; i < shallow.length; i++) expect(deep[i]).toBeCloseTo(shallow[i], 10)
  })

  it('leaves the index’s gaps as gaps, and carries the sum across them', () => {
    const di = domainsOf([20, 20])
    for (let i = 24; i < 28; i++) di[i] = Number.NaN
    const curve = integratedDirection(di)
    for (let i = 24; i < 28; i++) expect(curve[i]).toBeNaN()
    // The sum picks up where it left off rather than restarting, which would put
    // a step in the curve — and a step is a minimum.
    expect(curve[28]).toBeCloseTo(curve[23] + 1, 10)
  })

  it('says nothing at all about a track with no direction in it', () => {
    const curve = integratedDirection(new Float64Array(40))
    for (const value of curve) expect(value).toBeNaN()
  })
})

describe('directionBorders', () => {
  it('calls one border between two domains, at the first downstream bin', () => {
    const di = domainsOf([20, 20])
    const borders = directionBorders(di, { prominence: 5, spacing: 0 })
    expect(borders.map((border) => border.bin)).toEqual([20])
    // The bin the call lands on is the first that looks downstream again — the
    // opening bin of the new domain, not the closing bin of the old one.
    expect(di[borders[0].bin]).toBeGreaterThan(0)
    expect(di[borders[0].bin - 1]).toBeLessThan(0)
    // Ten bins of steady bias on each side, which is what the unit means.
    expect(borders[0].prominence).toBeCloseTo(10, 10)
  })

  it('does not call the two ends of the sequence', () => {
    // The first bin and the last are minima of the curve — there is nothing
    // beyond them to climb — and a prominence of zero is what says so.
    const borders = directionBorders(domainsOf([20, 20]), { prominence: 0.5, spacing: 0 })
    expect(borders.map((border) => border.bin)).toEqual([20])
  })

  it('reads a stutter across zero as one border rather than two', () => {
    const di = domainsOf([20, 20])
    // One bin in the middle of the first domain's upstream arm flips sign, which
    // is what a noisy track does and what a crossing-by-crossing caller reports
    // as a second border a few bins early.
    di[15] = 1
    const borders = directionBorders(di, { prominence: 5, spacing: 0 })
    expect(borders.map((border) => border.bin)).toEqual([20])
  })

  it('drops a flip too shallow to be an edge', () => {
    const borders = directionBorders(domainsOf([20, 20]), { prominence: 11, spacing: 0 })
    expect(borders).toHaveLength(0)
  })

  it('calls the same borders however deep the map is', () => {
    const shallow = directionBorders(domainsOf([20, 20, 20], 1), { prominence: 5, spacing: 0 })
    const deep = directionBorders(domainsOf([20, 20, 20], 500), { prominence: 5, spacing: 0 })
    expect(deep.map((border) => border.bin)).toEqual(shallow.map((border) => border.bin))
    expect(deep.map((border) => border.bin)).toEqual([20, 40])
  })

  it('puts the domains between its borders on the domains themselves', () => {
    const borders = directionBorders(domainsOf([20, 20, 20]), { prominence: 5, spacing: 0 })
    const domains = domainsBetween(borders)
    // Three domains, two interior borders, and the one domain with both of its
    // edges called is the middle one — exactly the span it was built at.
    expect(domains.map((domain) => [domain.from, domain.to])).toEqual([[20, 40]])
  })

  it('invents no border at the edge of a dropped stretch', () => {
    const di = domainsOf([20, 20])
    for (let i = 4; i < 9; i++) di[i] = Number.NaN
    const borders = directionBorders(di, { prominence: 5, spacing: 0 })
    expect(borders.map((border) => border.bin)).toEqual([20])
  })
})

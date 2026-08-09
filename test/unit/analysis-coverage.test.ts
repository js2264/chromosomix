/**
 * Marginals, and the two ways of getting them wrong by a factor of two.
 *
 * A marginal is a sum over a row *and* a column, from a store that keeps only
 * the upper triangle. So there are exactly two mirror-image mistakes, both of
 * which produce a track that looks entirely reasonable:
 *
 * - forgetting to mirror, and reporting half of every bin's contacts;
 * - mirroring the diagonal too, and putting a spike on every bin with a strong
 *   self-contact.
 *
 * The dense path has the same trap from the other side: a square mirrored out of
 * an upper-triangular store holds each off-diagonal pair twice, so walking all of
 * it doubles everything. Unlike the expected curve, a marginal has no
 * denominator to cancel that against — which is why the two paths are checked
 * against each other here rather than each against itself.
 */

import { describe, expect, it } from 'vitest'

import { binContigMap, CoverageAccumulator } from '@/analysis/coverage'

/** Two contigs, three bins each. */
const CONTIGS = [
  { startBin: 0, bins: 3 },
  { startBin: 3, bins: 3 },
]
const N_BINS = 6

function accumulator(): CoverageAccumulator {
  return new CoverageAccumulator(N_BINS, binContigMap(CONTIGS, N_BINS))
}

describe('binContigMap', () => {
  it('labels every bin with its sequence', () => {
    expect(Array.from(binContigMap(CONTIGS, N_BINS))).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('leaves a bin no contig claims at -1', () => {
    expect(Array.from(binContigMap([{ startBin: 0, bins: 2 }], 4))).toEqual([0, 0, -1, -1])
  })
})

describe('CoverageAccumulator', () => {
  it('adds an off-diagonal pixel to both of its bins', () => {
    const acc = accumulator()
    acc.add(0, 1, 5)
    const { total } = acc.finish()
    expect(total[0]).toBe(5)
    expect(total[1]).toBe(5)
  })

  it('adds a diagonal pixel exactly once', () => {
    // The classic spike: a strong self-contact counted for both ends of a pixel
    // whose two ends are the same bin.
    const acc = accumulator()
    acc.add(2, 2, 7)
    expect(acc.finish().total[2]).toBe(7)
  })

  it('separates cis from trans by the sequence, not by the distance', () => {
    const acc = accumulator()
    acc.add(0, 2, 3) // within contig 0
    acc.add(2, 3, 4) // adjacent bins, different contigs
    const { cis, trans, cisFraction } = acc.finish()
    expect(cis[2]).toBe(3)
    expect(trans[2]).toBe(4)
    expect(cisFraction[2]).toBeCloseTo(3 / 7, 12)
    // Bin 3 saw only the trans pixel.
    expect(cis[3]).toBe(0)
    expect(trans[3]).toBe(4)
    expect(cisFraction[3]).toBe(0)
  })

  it('reports a bin with no contacts as a measured zero, not a gap', () => {
    const acc = accumulator()
    acc.add(0, 1, 1)
    const { total, cisFraction } = acc.finish()
    // A cooler stores only its non-zeros, so an absent pixel is a zero the file
    // asserts rather than a measurement it is missing. Calling it a gap is what
    // made the sparse and dense paths disagree.
    expect(total[5]).toBe(0)
    // Its cis *fraction* is still a gap, because zero of zero is not zero.
    expect(cisFraction[5]).toBeNaN()
  })

  it('reports a bin the balancer dropped as a gap', () => {
    // The one genuine gap, and the only thing the accumulator cannot work out
    // for itself: a NaN weight is a bin excluded from the matrix (S6.4).
    const dropped = new Set([4])
    const acc = new CoverageAccumulator(
      N_BINS,
      binContigMap(CONTIGS, N_BINS),
      (bin) => !dropped.has(bin),
    )
    acc.add(0, 1, 1)
    const { total } = acc.finish()
    expect(total[4]).toBeNaN()
    expect(total[5]).toBe(0)
  })

  it('skips a NaN value rather than poisoning the bin', () => {
    const acc = accumulator()
    acc.add(0, 1, Number.NaN)
    acc.add(0, 1, 2)
    expect(acc.finish().total[0]).toBe(2)
  })

  it('gives a cis fraction on [0, 1] and never an infinity', () => {
    // `cis / trans` would be Infinity here, which is most of a well-binned
    // metagenome and which no bigWig can carry (S16.7).
    const acc = accumulator()
    acc.add(0, 1, 9)
    expect(acc.finish().cisFraction[0]).toBe(1)
  })

  it('agrees with the dense path, which holds each pair twice', () => {
    // The same three pixels, once as stored pairs and once as a mirrored square.
    const pairs: Array<[number, number, number]> = [
      [0, 0, 1],
      [0, 1, 2],
      [1, 4, 3],
    ]
    const sparse = accumulator()
    for (const [a, b, v] of pairs) sparse.add(a, b, v)

    const values = new Float32Array(N_BINS * N_BINS)
    for (const [a, b, v] of pairs) {
      values[a * N_BINS + b] = v
      values[b * N_BINS + a] = v
    }
    const dense = accumulator()
    dense.addBlock({
      nrows: N_BINS,
      ncols: N_BINS,
      values,
      rowExtent: [0, N_BINS],
      colExtent: [0, N_BINS],
    })

    expect(Array.from(dense.finish().total)).toEqual(Array.from(sparse.finish().total))
    expect(Array.from(dense.finish().trans)).toEqual(Array.from(sparse.finish().trans))
  })
})

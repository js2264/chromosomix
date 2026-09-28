/**
 * Diamond insulation, against squares whose answer is worked out by hand.
 *
 * The definition is cooltools' (`scripts/make_analysis_golden.py` holds it to
 * cooltools' own table on the demo map); what is checked here is the handful of
 * places a reimplementation goes wrong while still producing a plausible track:
 *
 * - the diamond is the `w × w` square cornered on the bin's own diagonal pixel,
 *   rows `(k − w, k]` against columns `[k, k + w)`, less the ignored diagonals;
 * - it is a **mean** over the cells that carry a value, so the ends of a contig
 *   and the edge of a dropped row are scored from what is there rather than
 *   reading as insulation;
 * - boundaries are cooltools' prominences, on the bins whose diamond holds enough
 *   cells, with those bins taken out of the track rather than blanked in it.
 */

import { describe, expect, it } from 'vitest'

import {
  callBoundaries,
  diamondCells,
  diamondTotals,
  diamondTotalsBanded,
  domainsBetween,
  findPeakProminence,
  insulationBoundaries,
  insulationScore,
  type Boundary,
  type ContigSquare,
} from '@/analysis/insulation'
import { squareBand } from '@/analysis/band'

/** A square of ones, so every diamond's sum is its own cell count. */
function ones(size: number): ContigSquare {
  return { size, values: new Float32Array(size * size).fill(1) }
}

/** A square of ones with a cross of zeros through `at` — a perfect boundary. */
function withBoundary(size: number, at: number): ContigSquare {
  const square = ones(size)
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      // Everything that crosses `at` is empty; everything on one side of it is
      // full. That is what a domain boundary is, in the limit.
      const crosses = (i < at && j >= at) || (j < at && i >= at)
      if (crosses) square.values[i * size + j] = 0
    }
  }
  return square
}

describe('diamondTotals', () => {
  it('counts the w × w square cornered on the bin, and nothing else', () => {
    const { sums, counts } = diamondTotals(ones(10), { window: 2 })
    // Rows (k − 2, k] against columns [k, k + 2): four cells, the diagonal pixel
    // (k, k) among them.
    expect(counts[5]).toBe(4)
    expect(sums[5]).toBe(4)
  })

  /**
   * cooltools' `ignore_diags`: a cell counts when `col − row` is at least the
   * cut. The diagonal pixel is the diamond's corner, so a cut of 1 takes it and
   * a cut of 2 takes it and the two cells beside it.
   */
  it('leaves out the diagonals nearest the corner, by cooltools’ count', () => {
    const square = ones(12)
    expect(diamondTotals(square, { window: 3 }).counts[6]).toBe(9)
    expect(diamondTotals(square, { window: 3, ignoreDiags: 1 }).counts[6]).toBe(8)
    expect(diamondTotals(square, { window: 3, ignoreDiags: 2 }).counts[6]).toBe(6)
    expect(diamondTotals(square, { window: 3, ignoreDiags: 3 }).counts[6]).toBe(3)
  })

  it('scores the ends of a contig from the part of the diamond inside it', () => {
    const { counts } = diamondTotals(ones(10), { window: 3 })
    // Bin 0 has only its own row; bin 9 only its own column. cooltools averages
    // what they hold rather than leaving them out, and a mean of fewer cells is
    // not a smaller number, so neither end reads as a boundary.
    expect(counts[0]).toBe(3)
    expect(counts[1]).toBe(6)
    expect(counts[9]).toBe(3)
    const score = insulationScore(diamondTotals(ones(10), { window: 3 }))
    for (const value of score) expect(value).toBe(0)
  })

  it('does not count a cell the balancer dropped', () => {
    const square = ones(10)
    square.values[4 * 10 + 5] = Number.NaN
    square.values[5 * 10 + 6] = Number.NaN
    const { sums, counts } = diamondTotals(square, { window: 2 })
    // Bin 5's diamond is (4..5) × (5..6): two of its four cells are gone, and
    // its mean is still that of the two that are left.
    expect(counts[5]).toBe(2)
    expect(sums[5]).toBe(2)
  })

  it('finds a boundary where one was built, half a bin either side of it', () => {
    const { sums, counts } = diamondTotals(withBoundary(20, 10), { window: 3 })
    // The edge falls between bins 9 and 10, and the diamond is cornered on a
    // bin, so both see six of their nine cells cross it.
    expect(sums[9] / counts[9]).toBeCloseTo(1 / 3, 12)
    expect(sums[10] / counts[10]).toBeCloseTo(1 / 3, 12)
    expect(sums[5] / counts[5]).toBe(1)
    expect(sums[15] / counts[15]).toBe(1)
  })

  describe('ignoring diagonals', () => {
    it('counts what a cut leaves, over the diamond’s whole span', () => {
      // Separations run 0 … 2w − 2: one cell at 0, two at 1, … four at 3, then
      // three, two, one.
      expect(diamondCells(4, 0)).toBe(16)
      expect(diamondCells(4, 1)).toBe(15)
      expect(diamondCells(4, 2)).toBe(13)
      expect(diamondCells(4, 3)).toBe(10)
      expect(diamondCells(4, 6)).toBe(1)
      expect(diamondCells(4, 7)).toBe(0)
      expect(diamondCells(4, 30)).toBe(0)
    })

    it('answers a cut wider than the diamond with gaps rather than with zeros', () => {
      const score = insulationScore(diamondTotals(ones(40), { window: 5, ignoreDiags: 30 }))
      // There is no cell at a separation of 30 in a diamond that spans 8, and a
      // zero here would read as total insulation.
      expect([...score].every((value) => Number.isNaN(value))).toBe(true)
    })
  })
})

describe('insulationScore', () => {
  const totals = (means: number[]) => ({
    sums: Float64Array.from(means),
    counts: new Float64Array(means.length).fill(1),
  })

  it('is zero at the median and negative where contact is suppressed', () => {
    const score = insulationScore(totals([4, 4, 2, 4, 5]))
    // The median is 4: a bin at 4 is zero, the bin at 2 one below.
    expect(score[0]).toBe(0)
    expect(score[2]).toBe(-1)
    expect(score[4]).toBeCloseTo(Math.log2(5 / 4), 12)
  })

  it('takes the median of an even count as the mean of the middle two', () => {
    const score = insulationScore(totals([1, 2, 4, 8]))
    expect(score[1]).toBeCloseTo(Math.log2(2 / 3), 12)
  })

  it('answers NaN for a bin with no contact rather than minus infinity, and counts it', () => {
    // A -Infinity would take the value axis of the whole lane with it, and could
    // not be written to a bigWig at all (§18.7). The zero still pulls the median
    // down, as cooltools lets it: the median of 0, 4, 8 is 4.
    const score = insulationScore(totals([8, 0, 4]))
    expect(score[1]).toBeNaN()
    expect(score[0]).toBe(1)
  })

  it('gives a bin with no cell to average no score', () => {
    const score = insulationScore({ sums: Float64Array.from([4, 0, 4]), counts: Float64Array.from([1, 0, 1]) })
    expect(score[1]).toBeNaN()
    expect(score[0]).toBe(0)
  })

  it('answers all NaN when nothing is finite, rather than throwing', () => {
    const score = insulationScore({ sums: new Float64Array(2), counts: new Float64Array(2) })
    expect(Array.from(score).every(Number.isNaN)).toBe(true)
  })
})

/**
 * cooltools' `find_peak_prominence`, against its own answers.
 *
 * Every expected value below is what cooltools 0.7.1 returns for the same array
 * — flat tops, `NaN` gaps and a tie for the highest peak included, which are the
 * three places a port quietly parts from it.
 */
describe('findPeakProminence', () => {
  const run = (values: number[]) => {
    const { positions, prominences } = findPeakProminence(values)
    return { positions, prominences: prominences.map((p) => (Number.isNaN(p) ? null : p)) }
  }

  it('measures each peak against the lowest point before a higher one', () => {
    expect(run([0, 1, 0, 2, 0])).toEqual({ positions: [1, 3], prominences: [1, 2] })
    const ragged = run([0, 3, 2.5, 2.9, 1, 4, 0.5, 2, 0])
    expect(ragged.positions).toEqual([1, 3, 5, 7])
    ragged.prominences.forEach((p, i) => expect(p).toBeCloseTo([2, 0.4, 3.5, 1.5][i], 12))
  })

  it('finds no peak on a flat top', () => {
    expect(run([0, 1, 1, 0])).toEqual({ positions: [], prominences: [] })
  })

  it('reads across gaps to the nearest values either side', () => {
    expect(run([0, Number.NaN, 1, Number.NaN, 0, 3, 0])).toEqual({
      positions: [2, 5],
      prominences: [1, 3],
    })
  })

  it('measures only the first of two equal highest peaks', () => {
    expect(run([0, 2, 0, 2, 0])).toEqual({ positions: [1, 3], prominences: [2, null] })
  })

  it('measures a lone peak against the lowest value when there is no minimum', () => {
    expect(run([0, 1, 0])).toEqual({ positions: [1], prominences: [1] })
  })
})

describe('insulationBoundaries', () => {
  it('calls the minima at least as prominent as the threshold', () => {
    const score = Float64Array.from([0, -1, 0, -3, 0])
    const counts = new Float64Array(5).fill(9)
    const calls = insulationBoundaries(score, counts, { minCells: 0, threshold: 1, spacing: 0 })
    expect(calls.map((call) => [call.bin, call.prominence])).toEqual([
      [1, 1],
      [3, 3],
    ])
    expect(insulationBoundaries(score, counts, { minCells: 0, threshold: 1.5, spacing: 0 })).toHaveLength(1)
  })

  it('takes thin diamonds out of the track rather than blanking them', () => {
    // Bin 2 holds too few cells. Removed, bins 1 and 3 become neighbours and the
    // minimum at 3 is measured against the 0 at bin 0 rather than the 4 at bin 2.
    const score = Float64Array.from([0, -1, 4, -3, 0])
    const counts = Float64Array.from([9, 9, 2, 9, 9])
    const calls = insulationBoundaries(score, counts, { minCells: 4.5, threshold: 0, spacing: 0 })
    expect(calls.map((call) => call.bin)).toEqual([3])
    expect(calls[0].prominence).toBe(3)
  })

  it('keeps the stronger of two calls closer than the spacing', () => {
    const score = Float64Array.from([0, -1, 0, -3, 0])
    const counts = new Float64Array(5).fill(9)
    const calls = insulationBoundaries(score, counts, { minCells: 0, threshold: 0, spacing: 4 })
    expect(calls.map((call) => call.bin)).toEqual([3])
  })
})

describe('callBoundaries', () => {
  it('calls one boundary per trough, not one per bin of it', () => {
    // A ragged trough: two equal minima with a shallow bump between them, all
    // well below the flanks. A depth threshold would call three; prominence
    // calls the two real floors and skips the bump.
    const score = Float64Array.from([0, 0, -2, -1.9, -2, 0, 0])
    const calls = callBoundaries(score, { prominence: 0.5, spacing: 1 })
    expect(calls.map((call) => call.bin)).toEqual([2, 4])
  })

  it('reports a flat plateau once, at its first bin', () => {
    const score = Float64Array.from([0, -2, -2, -2, 0])
    const calls = callBoundaries(score, { prominence: 0.5, spacing: 1 })
    expect(calls.map((call) => call.bin)).toEqual([1])
  })

  it('measures prominence as the climb on both sides', () => {
    // Deep on the left, shallow on the right: the prominence is the smaller
    // climb, so a minimum on the flank of a bigger one is not a boundary.
    const score = Float64Array.from([5, -1, 0.5, -3, 5])
    const calls = callBoundaries(score, { prominence: 0, spacing: 1 })
    const shallow = calls.find((call) => call.bin === 1)
    expect(shallow?.prominence).toBeCloseTo(1.5, 12)
  })

  it('keeps the stronger of two calls that are too close together', () => {
    const score = Float64Array.from([0, -1, 0, -3, 0])
    const calls = callBoundaries(score, { prominence: 0, spacing: 4 })
    expect(calls.map((call) => call.bin)).toEqual([3])
  })

  it('is not fooled by the NaN ends of a real score', () => {
    const score = Float64Array.from([Number.NaN, Number.NaN, 0, -2, 0, Number.NaN])
    const calls = callBoundaries(score, { prominence: 0.5, spacing: 1 })
    expect(calls.map((call) => call.bin)).toEqual([3])
  })
})

describe('domainsBetween', () => {
  const call = (bin: number, prominence: number): Boundary => ({ bin, score: -1, prominence })

  it('is the gaps between the calls, and they tile', () => {
    const domains = domainsBetween([call(10, 1), call(25, 2), call(40, 3)])
    expect(domains.map((domain) => [domain.from, domain.to])).toEqual([
      [10, 25],
      [25, 40],
    ])
    // One ends where the next begins, which is what makes a lane of them read
    // as a segmentation rather than as boxes with gaps between them.
    expect(domains[0].to).toBe(domains[1].from)
  })

  it('leaves the two ends of the sequence out', () => {
    // Three calls make two domains, never four: a domain running back to the
    // telomere would assert an edge the data never placed.
    expect(domainsBetween([call(10, 1), call(25, 2), call(40, 3)])).toHaveLength(2)
    expect(domainsBetween([call(10, 1)])).toHaveLength(0)
    expect(domainsBetween([])).toHaveLength(0)
  })

  it('takes the weaker of the two edges, never the stronger', () => {
    // A domain is only as well defined as its worse-supported side; reporting
    // the stronger would let one good boundary vouch for a run of bad ones.
    const domains = domainsBetween([call(0, 3), call(10, 0.4), call(20, 2)])
    expect(domains.map((domain) => domain.strength)).toEqual([0.4, 0.4])
  })

  it('pairs neighbours whatever order the calls arrive in', () => {
    // `callBoundaries` answers in bin order, but a caller that had sorted by
    // prominence — the other order a boundary list comes in — would otherwise
    // get domains between calls that are not neighbours.
    const byProminence = [call(25, 3), call(10, 1), call(40, 2)]
    expect(domainsBetween(byProminence).map((domain) => [domain.from, domain.to])).toEqual([
      [10, 25],
      [25, 40],
    ])
  })

  it('makes nothing of two calls at the same bin', () => {
    expect(domainsBetween([call(10, 1), call(10, 2)])).toHaveLength(0)
  })
})

/**
 * The banded diamond, against the square one it stands in for.
 *
 * A circular sequence's diamond has to be read from a band — the square has two
 * ends and a circle has none — and a second implementation of a goldened kernel
 * is a second answer unless something holds them together. This is that
 * something: on a **linear** band the two must agree cell for cell, the partial
 * diamonds at both ends included.
 */
describe('diamondTotalsBanded', () => {
  /** A square with no symmetry an indexing mistake could hide behind. */
  function noisy(size: number): Float32Array {
    const values = new Float32Array(size * size)
    for (let i = 0; i < size; i++) {
      for (let j = i; j < size; j++) {
        const value = ((i * 7919 + j * 104729) % 97) + 1
        values[i * size + j] = value
        values[j * size + i] = value
      }
    }
    return values
  }

  it('agrees with the square diamond on a linear sequence', () => {
    const size = 60
    const values = noisy(size)
    for (const options of [{ window: 5 }, { window: 8, ignoreDiags: 2 }, { window: 3, ignoreDiags: 0 }]) {
      const square = diamondTotals({ size, values }, options)
      const banded = diamondTotalsBanded(squareBand(values, size, { hi: 2 * options.window }), options)
      expect(Array.from(banded.counts)).toEqual(Array.from(square.counts))
      for (let i = 0; i < size; i++) expect(banded.sums[i]).toBeCloseTo(square.sums[i], 6)
    }
  })

  it('gives every bin of a circular sequence a whole diamond, junction included', () => {
    const size = 60
    const banded = diamondTotalsBanded(squareBand(noisy(size), size, { circular: true, hi: 10 }), {
      window: 5,
      ignoreDiags: 2,
    })
    for (let i = 0; i < size; i++) expect(banded.counts[i]).toBe(diamondCells(5, 2))
  })

  it('reads the junction of a circle as one continuous stretch', () => {
    const size = 60
    // Contact that depends only on the circular separation: no boundary anywhere,
    // so every diamond holds the same cells and the track is flat — the junction
    // most of all, which is where a linear reading would thin the diamond.
    const values = new Float32Array(size * size)
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const d = Math.min(Math.abs(i - j), size - Math.abs(i - j))
        values[i * size + j] = 1 / (1 + d)
      }
    }
    const score = insulationScore(
      diamondTotalsBanded(squareBand(values, size, { circular: true, hi: 10 }), { window: 5 }),
    )
    for (let i = 0; i < size; i++) expect(score[i]).toBeCloseTo(0, 10)
  })
})

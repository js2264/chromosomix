/**
 * The analysis kernels, checked against numbers worked out by hand.
 *
 * Everything in `analysis/stats.ts` and `analysis/expected.ts` fails *quietly*.
 * A correlation that answers `0` where it should answer `NaN` phases a
 * compartment eigenvector from no evidence; an expected curve that counts a
 * mirrored square's cells once per pair rather than once per cell doubles every
 * observed/expected value in the app; an `expectedAt` that clamps past the end
 * of its curve makes far-cis contacts look several-fold enriched. None of the
 * three produces a picture that looks broken, which is why the expected values
 * below are arithmetic somebody did on paper rather than a snapshot of what the
 * code happened to emit.
 */

import { describe, expect, it } from 'vitest'

import {
  ExpectedAccumulator,
  densityCurve,
  expectedAt,
  logBinCurve,
  logLogSlope,
} from '@/analysis/expected'
import { makeRandom, randomInt, shuffled } from '@/analysis/random'
import {
  bootstrapBand,
  logSpacedEdges,
  nanExtent,
  nanMean,
  pearson,
  quantileEdges,
  ranks,
  spearman,
} from '@/analysis/stats'

/** A dense block whose extents are absolute bins, as a reader hands one over. */
function block(
  rowFrom: number,
  colFrom: number,
  rows: number[][],
): {
  nrows: number
  ncols: number
  values: Float32Array
  rowExtent: [number, number]
  colExtent: [number, number]
} {
  const nrows = rows.length
  const ncols = rows[0].length
  const values = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) values[r * ncols + c] = rows[r][c]
  }
  return {
    nrows,
    ncols,
    values,
    rowExtent: [rowFrom, rowFrom + nrows],
    colExtent: [colFrom, colFrom + ncols],
  }
}

/**
 * A 4 × 4 symmetric square, exactly as a mirrored upper-triangular read gives
 * one. Every off-diagonal pair appears twice, which is the case the accumulator
 * has to get right.
 */
const SQUARE = [
  [10, 1, 4, 6],
  [1, 20, 2, 5],
  [4, 2, 30, 3],
  [6, 5, 3, 40],
]

describe('nanMean and nanExtent', () => {
  it('skips NaN rather than propagating it', () => {
    expect(nanMean([1, Number.NaN, 3])).toBe(2)
    expect(nanExtent([Number.NaN, 5, -2, 3])).toEqual({ min: -2, max: 5 })
  })

  it('says it has nothing rather than saying zero', () => {
    expect(nanMean([Number.NaN, Number.NaN])).toBeNaN()
    expect(nanExtent([Number.NaN])).toBeNull()
    expect(nanExtent([])).toBeNull()
  })
})

describe('pearson', () => {
  // a = 1..5, b = 2,4,5,4,5. Means 3 and 4; Σdxdy = 6, Σdx² = 10, Σdy² = 6,
  // so r = 6 / sqrt(60).
  const a = [1, 2, 3, 4, 5]
  const b = [2, 4, 5, 4, 5]

  it('matches the hand-computed coefficient', () => {
    expect(pearson(a, b)).toBeCloseTo(6 / Math.sqrt(60), 12)
    expect(pearson(a, a)).toBeCloseTo(1, 12)
  })

  it('drops a pair whole when either side is missing', () => {
    // Appending a pair whose left side is NaN must change nothing at all — not
    // the means, not the count, not the coefficient.
    expect(pearson([...a, Number.NaN], [...b, 1000])).toBeCloseTo(6 / Math.sqrt(60), 12)
    expect(pearson([...a, 1000], [...b, Number.NaN])).toBeCloseTo(6 / Math.sqrt(60), 12)

    // Dropping the middle pair leaves (1,2), (2,4), (4,4), (5,5): means 3 and
    // 3.75, Σdxdy = 6, Σdx² = 10, Σdy² = 4.75.
    const holed = pearson([1, 2, Number.NaN, 4, 5], b)
    expect(holed).toBeCloseTo(6 / Math.sqrt(10 * 4.75), 12)
  })

  it('answers NaN, never 0, when there is nothing to correlate', () => {
    // Two surviving pairs lie on a line whatever the data says.
    expect(pearson([1, 2, Number.NaN, Number.NaN], [1, 2, 3, 4])).toBeNaN()
    expect(pearson([], [])).toBeNaN()
    // A constant vector has no variance, and dividing by it would answer 0.
    expect(pearson([3, 3, 3, 3], [1, 2, 3, 4])).toBeNaN()
  })
})

describe('spearman', () => {
  it('is one for any increasing relation, however curved', () => {
    expect(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])).toBeCloseTo(1, 12)
  })

  it('completes the pairs before ranking, not after', () => {
    // The surviving pairs are (1,1), (3,3), (4,4) — perfectly monotone. Ranking
    // each vector whole first would rank 3 and 4 against a partner that never
    // saw the value at index 1, and would not give 1.
    expect(spearman([1, 2, 3, 4], [1, Number.NaN, 3, 4])).toBeCloseTo(1, 12)
  })
})

describe('ranks', () => {
  it('averages ties and leaves NaN where it was', () => {
    // Sorted: 10, 10, 20, 20, 30 at one-based positions 1..5, so the tens share
    // 1.5, the twenties share 3.5 and the thirty is 5.
    const out = ranks([10, 20, 20, 30, Number.NaN, 10])
    expect(Array.from(out.subarray(0, 4))).toEqual([1.5, 3.5, 3.5, 5])
    expect(out[4]).toBeNaN()
    expect(out[5]).toBe(1.5)
  })

  it('gives every element of a constant vector the same rank', () => {
    expect(Array.from(ranks([7, 7, 7, 7]))).toEqual([2.5, 2.5, 2.5, 2.5])
  })
})

describe('quantileEdges', () => {
  it('cuts at the order statistics', () => {
    expect(Array.from(quantileEdges([1, 2, 3, 4, 5], 4))).toEqual([1, 2, 3, 4, 5])
  })

  it('interpolates between them, and ignores NaN', () => {
    // Four values, three groups' worth of cut points at p = 0, 0.5, 1: the
    // middle lands halfway between the second and third.
    expect(Array.from(quantileEdges([4, 1, 3, 2], 2))).toEqual([1, 2.5, 4])
    expect(Array.from(quantileEdges([4, Number.NaN, 1, 3, 2], 2))).toEqual([1, 2.5, 4])
  })

  it('has no edges to offer when there are no values', () => {
    expect(quantileEdges([Number.NaN], 4).length).toBe(0)
  })
})

describe('logSpacedEdges', () => {
  it('never repeats an edge at a factor of 1.1 over a short range', () => {
    const edges = logSpacedEdges(1, 2, 1.1)
    expect(edges[0]).toBe(1)
    expect(edges[edges.length - 1]).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThan(edges[i - 1])
    // 1.1^7 = 1.949, 1.1^8 = 2.144: eight steps to cover the range.
    expect(edges.length).toBe(9)
  })

  it('terminates when the factor cannot step', () => {
    const edges = logSpacedEdges(1, 1000, 1)
    expect(edges.length).toBeLessThanOrEqual(1 << 14)
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThan(edges[i - 1])
  })

  it('has nothing to say about a range that is not positive', () => {
    expect(logSpacedEdges(0, 10, 2).length).toBe(0)
    expect(logSpacedEdges(10, 10, 2).length).toBe(0)
  })
})

describe('bootstrapBand', () => {
  it('brackets the mean and reproduces itself from the same seed', () => {
    const values = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
      [5, Number.NaN],
    ]
    const options = {
      rows: 5,
      cols: 2,
      at: (row: number, col: number) => values[row][col],
      iterations: 200,
      level: 0.9,
    }
    const first = bootstrapBand({ ...options, rng: makeRandom(7) })
    const again = bootstrapBand({ ...options, rng: makeRandom(7) })

    expect(first.mean[0]).toBeCloseTo(3, 12)
    // The fifth row's second column is missing, so that column's mean is over
    // four observations and not five.
    expect(first.mean[1]).toBeCloseTo(25, 12)
    for (let col = 0; col < 2; col++) {
      expect(first.low[col]).toBeLessThanOrEqual(first.mean[col])
      expect(first.high[col]).toBeGreaterThanOrEqual(first.mean[col])
      expect(first.low[col]).toBe(again.low[col])
      expect(first.high[col]).toBe(again.high[col])
    }
  })
})

describe('ExpectedAccumulator', () => {
  it('counts every cell of a mirrored square, and gets the mean right anyway', () => {
    const acc = new ExpectedAccumulator(3)
    acc.addBlock(block(0, 0, SQUARE))
    const curve = acc.finish()

    // Offset 0 is the four diagonal cells: (10 + 20 + 30 + 40) / 4.
    expect(curve.count[0]).toBe(4)
    expect(curve.mean[0]).toBeCloseTo(25, 12)

    // Offset 1 is three pairs, each present twice — six cells, sum 2×(1+2+3).
    // The doubling cancels: the mean is still (1 + 2 + 3) / 3.
    expect(curve.count[1]).toBe(6)
    expect(curve.sum[1]).toBeCloseTo(12, 12)
    expect(curve.mean[1]).toBeCloseTo(2, 12)

    // Offset 2 is two pairs, four cells, sum 2×(4+5); offset 3 is one pair.
    expect(curve.count[2]).toBe(4)
    expect(curve.mean[2]).toBeCloseTo(4.5, 12)
    expect(curve.count[3]).toBe(2)
    expect(curve.mean[3]).toBeCloseTo(6, 12)
  })

  it('takes the offset from absolute bins and not from local indices', () => {
    // A 4 × 4 block of ones starting at row 4, column 0: the separations run 1
    // to 7 with counts 1, 2, 3, 4, 3, 2, 1. Read from local indices they would
    // instead run 0 to 3 with counts 4, 6, 4, 2.
    const ones = [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]
    const acc = new ExpectedAccumulator(8)
    acc.addBlock(block(4, 0, ones))
    const curve = acc.finish()
    expect(Array.from(curve.count)).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0])
    expect(curve.mean[0]).toBeNaN()
    expect(curve.mean[4]).toBe(1)
  })

  it('skips NaN cells without counting them as observations', () => {
    const holed = SQUARE.map((row) => row.slice())
    holed[0][1] = Number.NaN
    const acc = new ExpectedAccumulator(3)
    acc.addBlock(block(0, 0, holed))
    const curve = acc.finish()
    // Five cells rather than six, and the surviving mirror of the dropped cell
    // still contributes: (1 + 2 + 2 + 3 + 3) / 5.
    expect(curve.count[1]).toBe(5)
    expect(curve.mean[1]).toBeCloseTo(11 / 5, 12)
  })

  it('adds sums and counts when two passes are merged', () => {
    const left = new ExpectedAccumulator(3)
    left.addBlock(block(0, 0, SQUARE))
    const right = new ExpectedAccumulator(3)
    right.addBlock(block(0, 0, SQUARE))
    left.merge(right)
    const curve = left.finish()
    expect(curve.count[1]).toBe(12)
    expect(curve.sum[1]).toBeCloseTo(24, 12)
    expect(curve.mean[1]).toBeCloseTo(2, 12)
  })

  it('hands out a record the accumulator can no longer change', () => {
    const acc = new ExpectedAccumulator(1)
    acc.add(0, 4)
    const curve = acc.finish()
    acc.add(0, 100)
    expect(curve.sum[0]).toBe(4)
    expect(curve.mean[1]).toBeNaN()
  })
})

describe('logBinCurve', () => {
  it('weights the per-offset means by their evidence, in base pairs', () => {
    const acc = new ExpectedAccumulator(3)
    acc.addBlock(block(0, 0, SQUARE))
    const binned = logBinCurve(acc.finish(), 1000, 2, 0)

    // Edges 1, 2, 4 over offsets 1..3. The first bin is offset 1 alone; the
    // second holds offsets 2 and 3, whose weighted mean is
    // (4 × 4.5 + 2 × 6) / 6 = 5, at a mean offset of (4 × 2 + 2 × 3) / 6.
    expect(Array.from(binned.y)).toHaveLength(2)
    expect(binned.x[0]).toBeCloseTo(1000, 9)
    expect(binned.y[0]).toBeCloseTo(2, 12)
    expect(binned.n[0]).toBe(6)
    expect(binned.x[1]).toBeCloseTo((14 / 6) * 1000, 9)
    expect(binned.y[1]).toBeCloseTo(5, 12)
    expect(binned.n[1]).toBe(6)
  })

  // The mirror is what makes this the *same* number as cooltools' `balanced.avg`
  // rather than half or twice it: a dense square read back from an
  // upper-triangular store doubles the sum and the count together, and a mean is
  // what survives that. The density beside it has to fold the mirror by hand,
  // for exactly the reason this one does not.
  it('is unmoved by the mirrored square, which is why it is a mean', () => {
    const acc = new ExpectedAccumulator(3)
    acc.addBlock(block(0, 0, SQUARE))
    const curve = acc.finish()
    const half = {
      ...curve,
      sum: curve.sum.map((value) => value / 2),
      count: curve.count.map((value) => value / 2),
    }
    const binned = logBinCurve(curve, 1000, 2, 0)
    const halved = logBinCurve(half, 1000, 2, 0)
    for (let i = 0; i < binned.y.length; i++) expect(halved.y[i]).toBeCloseTo(binned.y[i], 12)
  })

  it('drops empty log bins instead of punching holes in the plot', () => {
    const acc = new ExpectedAccumulator(3)
    acc.add(1, 8)
    acc.add(3, 1)
    const binned = logBinCurve(acc.finish(), 1000, 1.1, 0)
    // Many of the bins at a factor of 1.1 are narrower than a bin of the file,
    // and offset 2 was never observed; only the two populated offsets survive.
    expect(Array.from(binned.x)).toEqual([1000, 3000])
    expect(Array.from(binned.y)).toEqual([8, 1])
  })

  // In **bins**, not base pairs: the near-diagonal is a fact about the grid, so
  // the same typed number has to mean the same trim at every resolution. And the
  // floor is never below one, whatever is asked for — the mean at offset zero is
  // the diagonal, which is not a contact between two loci.
  it('floors the first bin at minOffset, and never below one offset', () => {
    const acc = new ExpectedAccumulator(4)
    for (let k = 0; k <= 4; k++) acc.add(k, k + 1)
    expect(logBinCurve(acc.finish(), 1000, 2, 0).x[0]).toBeCloseTo(1000, 9)
    const binned = logBinCurve(acc.finish(), 1000, 2, 3)
    expect(binned.x[0]).toBeGreaterThanOrEqual(3000)
    const coarse = logBinCurve(acc.finish(), 10_000, 2, 3)
    expect(coarse.x[0]).toBeGreaterThanOrEqual(30_000)
  })
})

describe('densityCurve', () => {
  // `SQUARE` mirrored, so the accumulator holds sum[0..3] = 100, 12, 18, 12 over
  // counts 4, 6, 4, 2. Folded to one entry per unordered pair — the diagonal
  // already is one — that is 100, 6, 9, 6 contacts over 4, 3, 2, 1 pairs, and
  // 121 contacts in all. At a factor of two the breaks are 1, 2, 4 … 2048, and
  // the gap distances (k − 1) · 1000 are −1000, 0, 1000 and 2000, so offsets 0
  // and 1 share the first break, offset 2 falls in [512, 1024) and offset 3 in
  // [1024, 2048).
  //
  // Each break is divided by the separation it *covers* — the number of bin
  // offsets in it times the bin size — and not by its own width. The first
  // holds two offsets and so covers 2 kb, where its nominal width is 1 bp; the
  // other two hold one each and cover 1 kb against nominal widths of 512 and
  // 1024. Dividing by the nominal width is what puts a factor-of-two sawtooth
  // through a real curve wherever a break is about as wide as a bin of the file.
  const TOTAL = 121

  it('divides by the map total and by the separation the break covers', () => {
    const acc = new ExpectedAccumulator(3)
    acc.addBlock(block(0, 0, SQUARE))
    const binned = densityCurve(acc.finish(), 1000, 2, 0, true)

    expect(Array.from(binned.x)).toEqual([1, 512, 1024])
    expect(binned.y[0]).toBeCloseTo(106 / TOTAL / 2000, 12)
    expect(binned.y[1]).toBeCloseTo(9 / TOTAL / 1000, 12)
    expect(binned.y[2]).toBeCloseTo(6 / TOTAL / 1000, 12)
    expect(Array.from(binned.n)).toEqual([7, 2, 1])
  })

  it('counts an offset the map has nothing at, since the break still covers it', () => {
    // Two offsets in the first break and one contact between them. The break
    // stands for 2 kb of separation whether or not both of its offsets carry
    // anything, and dividing by 1 kb because only one did would report twice the
    // density in exactly the sparse stretches a curve is least sure about.
    const acc = new ExpectedAccumulator(1)
    acc.add(1, 5)
    const binned = densityCurve(acc.finish(), 1000, 2, 0, false)
    expect(Array.from(binned.x)).toEqual([1])
    expect(binned.y[0]).toBeCloseTo(1 / 2000, 12)
  })

  it('folds the mirrored square, so the diagonal is not outweighed two to one', () => {
    const acc = new ExpectedAccumulator(3)
    acc.addBlock(block(0, 0, SQUARE))
    const curve = acc.finish()
    const folded = densityCurve(curve, 1000, 2, 0, true)
    const raw = densityCurve(curve, 1000, 2, 0, false)
    // Unfolded, the total is 100 + 12 + 18 + 12 = 142 and the first break holds
    // 112 of it. The curve still looks like a P(s), which is the danger.
    expect(raw.y[0]).toBeCloseTo(112 / 142 / 2000, 12)
    expect(raw.y[0]).not.toBeCloseTo(folded.y[0], 6)
  })

  it('keeps the diagonal, which shares the first break with offset one', () => {
    const acc = new ExpectedAccumulator(1)
    acc.add(0, 7)
    acc.add(1, 3)
    const binned = densityCurve(acc.finish(), 1000, 2, 0, false)
    // One point: −1000 bp and 0 bp both land below the first break at 1 bp, so
    // it holds all ten contacts and covers the 2 kb its two offsets span.
    expect(Array.from(binned.x)).toEqual([1])
    expect(binned.y[0]).toBeCloseTo(1 / 2000, 12)
    expect(binned.n[0]).toBe(2)
  })

  it('drops empty breaks instead of punching holes in the plot', () => {
    const acc = new ExpectedAccumulator(3)
    acc.add(1, 8)
    acc.add(3, 1)
    const binned = densityCurve(acc.finish(), 1000, 1.1, 0, false)
    // At a factor of 1.1 most breaks are narrower than a bin of the file, and
    // offset 2 was never observed; only the two populated offsets survive.
    expect(binned.x.length).toBe(2)
    for (const value of binned.y) expect(Number.isNaN(value)).toBe(false)
  })

  // In **bins**, not base pairs: the near-diagonal is a fact about the grid, so
  // the same typed number has to mean the same trim at every resolution.
  it('floors at minOffset in bins, and rescales the total to what is left', () => {
    const acc = new ExpectedAccumulator(4)
    for (let k = 1; k <= 4; k++) acc.add(k, k)
    const binned = densityCurve(acc.finish(), 1000, 2, 3, false)
    // Offsets 3 and 4 survive, at gap distances 2000 and 3000, and they are a
    // share of 3 + 4 rather than of 1 + 2 + 3 + 4. One offset each, so each
    // break covers one bin of separation.
    expect(Array.from(binned.x)).toEqual([1024, 2048])
    expect(binned.y[0]).toBeCloseTo(3 / 7 / 1000, 12)
    expect(binned.y[1]).toBeCloseTo(4 / 7 / 1000, 12)
    // The same two offsets at another resolution are ten times further along —
    // far enough that one break at a factor of two now swallows both, which is
    // the whole reason the floor is in bins and the abscissa is in base pairs.
    const coarse = densityCurve(acc.finish(), 10_000, 2, 3, false)
    expect(Array.from(coarse.x)).toEqual([16384])
    // Both offsets in one break, which therefore covers 20 kb of separation.
    expect(coarse.y[0]).toBeCloseTo(1 / 20_000, 12)
  })
})

describe('logLogSlope', () => {
  it('recovers the exponent of a power law', () => {
    // y = x^-1.5 sampled geometrically: every central difference is the
    // exponent, exactly.
    const xs = new Float64Array([1, 2, 4, 8, 16])
    const ys = new Float64Array(xs.length)
    for (let i = 0; i < xs.length; i++) ys[i] = Math.pow(xs[i], -1.5)
    const slope = logLogSlope(xs, ys)
    expect(Array.from(slope.x)).toEqual([2, 4, 8])
    for (const value of slope.y) expect(value).toBeCloseTo(-1.5, 12)
  })

  it('gaps rather than invents a slope across a zero', () => {
    const slope = logLogSlope(new Float64Array([1, 2, 4]), new Float64Array([1, 0.5, 0]))
    expect(slope.y[0]).toBeNaN()
  })
})

describe('expectedAt', () => {
  /** Means of 100 at offset 0, 15 at offset 1, nothing at 2, 5 at 3 and 4. */
  function gapped(): ExpectedAccumulator {
    const acc = new ExpectedAccumulator(4)
    acc.add(0, 100)
    acc.add(1, 10)
    acc.add(1, 20)
    acc.add(3, 5)
    return acc
  }

  it('returns an observed offset unchanged', () => {
    expect(expectedAt(gapped().finish(), 1)).toBeCloseTo(15, 12)
  })

  it('interpolates across a gap and between offsets', () => {
    const curve = gapped().finish()
    // Offset 2 was never observed, so it sits halfway between 15 and 5.
    expect(expectedAt(curve, 2)).toBeCloseTo(10, 12)
    // A quarter of the way from offset 1 to offset 3.
    expect(expectedAt(curve, 1.5)).toBeCloseTo(12.5, 12)
  })

  it('returns NaN past the end rather than clamping', () => {
    const curve = gapped().finish()
    // Offset 4 is inside the curve's reach but has no value beyond it to
    // interpolate towards; clamping to offset 3 would make a far-cis O/E wrong
    // and plausible at once.
    expect(expectedAt(curve, 4)).toBeNaN()
    expect(expectedAt(curve, 5)).toBeNaN()
    expect(expectedAt(curve, -1)).toBeNaN()
  })
})

describe('makeRandom', () => {
  it('gives the same stream twice from the same seed', () => {
    const first = makeRandom(1234)
    const again = makeRandom(1234)
    const drawn: number[] = []
    for (let i = 0; i < 32; i++) {
      const value = first()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
      expect(value).toBe(again())
      drawn.push(value)
    }
    // A different seed is a different figure, which is the other half of the
    // claim: the seed has to matter or recording it is theatre.
    const other = makeRandom(1235)
    expect(drawn.some((value) => value !== other())).toBe(true)
  })

  it('survives a seed the form should never have produced', () => {
    for (const seed of [0, -7, 2.5, 1e12]) {
      const value = makeRandom(seed)()
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('draws integers inside the half-open range', () => {
    const rng = makeRandom(99)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const value = randomInt(rng, 3, 7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThan(7)
      seen.add(value)
    }
    expect(seen.size).toBe(4)
    // An empty range answers its own lower bound rather than asking the caller
    // to have checked.
    expect(randomInt(rng, 5, 5)).toBe(5)
  })

  it('shuffles into a permutation, deterministically, without touching the input', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7]
    const first = shuffled(items, makeRandom(3))
    const again = shuffled(items, makeRandom(3))
    expect(first).toEqual(again)
    expect(items).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(first.slice().sort((a, b) => a - b)).toEqual(items)
  })
})

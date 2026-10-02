/**
 * The junction test, on maps whose shape is known by construction.
 *
 * A circle's last bin and first are neighbours, so the cells joining them hold
 * what the diagonal holds at the same separation; a line's hold what two ends a
 * chromosome apart hold, which is almost nothing — and a line whose ends are
 * held *near* each other, the case §8.15 was right to be wary of, holds a
 * fraction of the diagonal rather than the diagonal itself.
 */

import { describe, expect, it } from 'vitest'

import {
  CIRCULAR_SCORE,
  JUNCTION_BINS,
  MIN_JUNCTION_SEQUENCE_BINS,
  junctionCandidates,
  junctionQuorum,
  junctionScore,
  measureJunctions,
  type JunctionBlock,
} from '../../src/analysis/circularity'

/** A dense block of a square whose cell (i, j) is `cell(i, j)`. */
function block(rows: [number, number], cols: [number, number], cell: (i: number, j: number) => number): JunctionBlock {
  const values: number[] = []
  for (let i = rows[0]; i < rows[1]; i++) for (let j = cols[0]; j < cols[1]; j++) values.push(cell(i, j))
  return { rows, cols, values }
}

/** The three blocks the test reads, off a map of `n` bins. */
function blocks(n: number, cell: (i: number, j: number) => number): [JunctionBlock, JunctionBlock, JunctionBlock] {
  const k = JUNCTION_BINS
  return [
    block([0, 2 * k], [0, 2 * k], cell),
    block([n - 2 * k, n], [n - 2 * k, n], cell),
    block([0, k], [n - k, n], cell),
  ]
}

const decay = (s: number): number => 1000 / (1 + s) ** 1.5

describe('the junction score', () => {
  const n = 200

  it('reads a circle as one: its ends are neighbours', () => {
    const circle = (i: number, j: number): number => {
      const d = Math.abs(i - j)
      return decay(Math.min(d, n - d))
    }
    const { score } = junctionScore(n, ...blocks(n, circle))
    expect(score).toBeCloseTo(1, 6)
    expect(score).toBeGreaterThanOrEqual(CIRCULAR_SCORE)
  })

  it('reads a line as one: its ends are a chromosome apart', () => {
    const line = (i: number, j: number): number => decay(Math.abs(i - j))
    const { score } = junctionScore(n, ...blocks(n, line))
    expect(score).toBeLessThan(0.01)
  })

  /** Telomeres held together, or an assembly error: bright, and not neighbours. */
  it('does not mistake ends held near each other for a join', () => {
    const tethered = (i: number, j: number): number => {
      const far = Math.abs(i - j) > n / 2
      return decay(Math.abs(i - j)) + (far ? 0.05 * decay(1) : 0)
    }
    const { score } = junctionScore(n, ...blocks(n, tethered))
    expect(score).toBeLessThan(CIRCULAR_SCORE)
  })

  it('does not decide where the ends have no data, rather than calling it a line', () => {
    const dropped = (i: number, j: number): number =>
      i < 3 || j < 3 || i >= n - 3 || j >= n - 3 ? Number.NaN : decay(Math.abs(i - j))
    expect(Number.isNaN(junctionScore(n, ...blocks(n, dropped)).score)).toBe(true)
  })

  /**
   * A line whose last two bins the balancer dropped, and one stray read pair
   * joining its first bin to the last one kept — at the diagonal's level, as a
   * mismapped repeat puts one. Only the third separation has a junction cell
   * left, and that cell alone reads as a circle.
   */
  it('does not decide a line on one stray cell across its end', () => {
    const stray = (i: number, j: number): number => {
      if (i >= n - 2 || j >= n - 2) return Number.NaN
      if (i === 0 && j === n - 3) return decay(3)
      return decay(Math.abs(i - j))
    }
    const { score, ratios } = junctionScore(n, ...blocks(n, stray))
    expect(ratios).toHaveLength(1)
    expect(ratios[0]).toBeGreaterThanOrEqual(CIRCULAR_SCORE)
    expect(Number.isNaN(score)).toBe(true)
    expect(junctionQuorum()).toBe(2)
  })

  /**
   * A line whose last bins are kept and hold nothing near the diagonal — an
   * ampliconic stretch whose reads went elsewhere — with stray contacts joining
   * them to the first bins at every separation, three-tenths of what the head's
   * diagonal holds. Pooled with the empty end, the diagonal is half the head's
   * and the stray contacts read as 0.6 of it: a circle. With nothing on one
   * end's diagonal, there is nothing to hold them against.
   */
  it('does not hold the junction against one end where the other is empty', () => {
    const empty = (i: number, j: number): number => {
      const d = Math.abs(i - j)
      if (i >= n - 2 * JUNCTION_BINS && j >= n - 2 * JUNCTION_BINS) return d === 0 ? decay(0) : 0
      if (Math.min(i, j) < JUNCTION_BINS && Math.max(i, j) >= n - JUNCTION_BINS) return 0.3 * decay(n - d)
      return decay(d)
    }
    const { score, ratios } = junctionScore(n, ...blocks(n, empty))
    expect(ratios).toEqual([])
    expect(Number.isNaN(score)).toBe(true)
  })

  it('still reads a circle whose last bin the balancer dropped', () => {
    const circle = (i: number, j: number): number => {
      if (i === n - 1 || j === n - 1) return Number.NaN
      const d = Math.abs(i - j)
      return decay(Math.min(d, n - d))
    }
    const { score, ratios } = junctionScore(n, ...blocks(n, circle))
    expect(ratios).toHaveLength(2)
    expect(score).toBeCloseTo(1, 6)
  })

  /**
   * chrY of the mouse progenitors map in the demo store, balanced, at the 640
   * kb rung the session measures it at when the file is opened at 10 kb (four
   * significant figures). It was ticked as circular at 0.41: the last two bins
   * are dropped, the one junction cell left is a single read pair, and the
   * tail's diagonal holds nothing at that separation.
   */
  it('leaves chrY of a mouse map undecided', () => {
    const N = Number.NaN
    const chrY = 144
    const head: JunctionBlock = {
      rows: [0, 6],
      cols: [0, 6],
      values: [
        0, 0.0478, 0.06299, 0.0236, 0, 0,
        0.0478, 0.9778, 0.2221, 0.05911, 0.03018, 0.02033,
        0.06299, 0.2221, 0.8071, 0.1141, 0.04151, 0.02297,
        0.0236, 0.05911, 0.1141, 0.3043, 0.04472, 0.04733,
        0, 0.03018, 0.04151, 0.04472, 0.5648, 0.3511,
        0, 0.02033, 0.02297, 0.04733, 0.3511, 2.02,
      ],
    }
    const tail: JunctionBlock = {
      rows: [chrY - 6, chrY],
      cols: [chrY - 6, chrY],
      values: [
        0, 0.01283, 0, 0, N, N,
        0.01283, 0.0421, 0.06961, 0.00594, N, N,
        0, 0.06961, 0, 0, N, N,
        0, 0.00594, 0, 0.1842, N, N,
        N, N, N, N, N, N,
        N, N, N, N, N, N,
      ],
    }
    const corner: JunctionBlock = {
      rows: [0, 3],
      cols: [chrY - 3, chrY],
      values: [0.007919, N, N, 0.001619, N, N, 0.0005333, N, N],
    }
    expect(Number.isNaN(junctionScore(chrY, head, tail, corner).score)).toBe(true)
  })
})

describe('the test over a whole map', () => {
  it('measures the long sequences, longest first, where each one starts', () => {
    const candidates = junctionCandidates(
      [
        ['plasmid', 30_000],
        ['chromosome', 200_000],
        ['scrap', 5_000],
        ['megaplasmid', 100_000],
      ],
      1000,
    )
    expect(candidates).toEqual([
      { name: 'chromosome', from: 30, n: 200 },
      { name: 'megaplasmid', from: 235, n: 100 },
      { name: 'plasmid', from: 0, n: 30 },
    ])
    expect(MIN_JUNCTION_SEQUENCE_BINS).toBeGreaterThan(5)
    expect(junctionCandidates([['a', 90_000], ['b', 80_000]], 1000, 1).map((one) => one.name)).toEqual(['a'])
  })

  /** A map of a 200-bin circle followed by a 100-bin line, read a block at a time. */
  const ring = 200
  const line = 100
  const cell = (i: number, j: number): number => {
    const ringI = i < ring
    if (ringI !== j < ring) return 0
    const d = Math.abs(i - j)
    return ringI ? decay(Math.min(d, ring - d)) : decay(d)
  }
  const read = async (rows: [number, number], cols: [number, number]): Promise<number[]> =>
    block(rows, cols, cell).values as number[]

  it('reads each sequence off its own ends, and declares the circle', async () => {
    const candidates = junctionCandidates([['ring', ring * 1000], ['line', line * 1000]], 1000)
    const measured = await measureJunctions(candidates, read)
    expect(measured?.circular).toEqual(['ring'])
    expect(measured?.scores.ring).toBeCloseTo(1, 6)
    expect(measured?.scores.line).toBeLessThan(0.01)
  })

  it('leaves a line out, unscored, where one stray cell is all its junction holds', async () => {
    // The line again, now with its last two bins dropped by the balancer and
    // one read pair joining its first bin to the last one kept.
    const end = ring + line
    const strayed = async (rows: [number, number], cols: [number, number]): Promise<number[]> =>
      block(rows, cols, (i, j) => {
        if (i >= end - 2 || j >= end - 2) return Number.NaN
        if (i === ring && j === end - 3) return decay(3)
        return cell(i, j)
      }).values as number[]
    const candidates = junctionCandidates([['ring', ring * 1000], ['line', line * 1000]], 1000)
    const measured = await measureJunctions(candidates, strayed)
    expect(measured?.circular).toEqual(['ring'])
    expect(measured?.scores).not.toHaveProperty('line')
  })

  it('answers nothing once the answer is no longer wanted', async () => {
    const candidates = junctionCandidates([['ring', ring * 1000]], 1000)
    expect(await measureJunctions(candidates, read, () => false)).toBeNull()
  })
})

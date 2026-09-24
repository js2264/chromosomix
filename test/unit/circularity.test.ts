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

  it('answers nothing once the answer is no longer wanted', async () => {
    const candidates = junctionCandidates([['ring', ring * 1000]], 1000)
    expect(await measureJunctions(candidates, read, () => false)).toBeNull()
  })
})

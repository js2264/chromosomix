/**
 * Base composition, checked against sequences whose answer is known by
 * construction rather than against a second implementation: a replichore made
 * of G-rich and C-rich halves has its skew's sign change exactly where it was
 * built to, and a window that wraps the origin of a circle must see the far end.
 */

import { describe, expect, it } from 'vitest'

import {
  atSkewOf,
  baseCounts,
  cumulativeOf,
  gcContentOf,
  gcSkewOf,
  windowCounts,
} from '../../src/annotations/composition'

function bases(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let at = 0; at < text.length; at++) out[at] = text.charCodeAt(at)
  return out
}

describe('counting bases per step', () => {
  it('counts each base in its step, case-folded, and leaves N out of every count', () => {
    const counts = baseCounts(bases('AACGgtNNtt'), 4)
    expect(counts.steps).toBe(3)
    expect([...counts.a]).toEqual([2, 0, 0])
    expect([...counts.c]).toEqual([1, 0, 0])
    expect([...counts.g]).toEqual([1, 1, 0])
    expect([...counts.t]).toEqual([0, 1, 2])
  })

  it('makes the last step partial, as the last bin of a map is', () => {
    expect(baseCounts(bases('ACGTACGTAC'), 4).steps).toBe(3)
    expect(baseCounts(bases(''), 4).steps).toBe(0)
  })
})

describe('the three ratios', () => {
  it('is GC over every counted base, and a gap has none rather than zero', () => {
    const counts = baseCounts(bases('GGCCAATTNNNN'), 4)
    const gc = gcContentOf(counts)
    expect(gc[0]).toBeCloseTo(1)
    expect(gc[1]).toBeCloseTo(0)
    expect(Number.isNaN(gc[2])).toBe(true)
  })

  it('signs the skews the way the literature does: G over C, A over T', () => {
    const counts = baseCounts(bases('GGGCAAAT'), 4)
    expect(gcSkewOf(counts)[0]).toBeCloseTo(0.5)
    expect(atSkewOf(counts)[1]).toBeCloseTo(0.5)
    // Neither G nor C in the second step: no GC skew there, not a skew of zero.
    expect(Number.isNaN(gcSkewOf(counts)[1])).toBe(true)
  })
})

describe('windows', () => {
  it('sums whole steps centred on each, clipped at the ends of a line', () => {
    const counts = baseCounts(bases('GGGGCCCCGGGG'), 4)
    const wide = windowCounts(counts, 3, false)
    expect([...wide.g]).toEqual([4, 8, 4])
    expect([...wide.c]).toEqual([4, 4, 4])
  })

  /**
   * The case a circular window exists for: the step at the end of the sequence
   * is next to the step at its start, and a window there has to see both.
   */
  it('wraps round the origin of a circle', () => {
    const counts = baseCounts(bases('GGGGAAAACCCC'), 4)
    const round = windowCounts(counts, 3, true)
    expect([...round.g]).toEqual([4, 4, 4])
    expect([...round.c]).toEqual([4, 4, 4])
    const line = windowCounts(counts, 3, false)
    expect([...line.c]).toEqual([0, 4, 4])
  })

  it('never counts a base twice, however wide the window asked for is', () => {
    const counts = baseCounts(bases('GGGGAAAACCCC'), 4)
    const lap = windowCounts(counts, 99, true)
    expect([...lap.g]).toEqual([4, 4, 4])
  })

  it('makes an even span odd rather than centring it half a step off', () => {
    const counts = baseCounts(bases('GGGGCCCCGGGG'), 4)
    expect([...windowCounts(counts, 2, false).g]).toEqual([...windowCounts(counts, 3, false).g])
  })
})

describe('the cumulative skew', () => {
  /**
   * A toy chromosome whose forward strand leads from 0 to 40 (G-rich) and lags
   * from 40 to 80 (C-rich): the cumulative skew climbs to the terminus at 40 and
   * falls back to the origin, which is where every assembly-independent reading
   * of the curve puts them.
   */
  it('turns at the replichore boundary it was built with', () => {
    const genome = `${'GGGCA'.repeat(8)}${'CCCGA'.repeat(8)}`
    const skew = gcSkewOf(baseCounts(bases(genome), 5))
    const cumulative = cumulativeOf(skew)
    let high = 0
    for (let i = 1; i < cumulative.length; i++) if (cumulative[i] > cumulative[high]) high = i
    expect(high).toBe(7)
    expect(cumulative[cumulative.length - 1]).toBeCloseTo(0)
  })

  it('carries the sum across a gap rather than breaking it', () => {
    const out = cumulativeOf(Float32Array.from([1, Number.NaN, 1]))
    expect([...out]).toEqual([1, 1, 2])
  })
})

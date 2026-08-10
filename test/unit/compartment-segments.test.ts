/**
 * E1's sign, as the A/B call everybody actually cites.
 *
 * The eigenvector is a number per bin and the thing that goes into a paper is
 * the interval — *this arm is A, that half-megabase is B*. Turning one into the
 * other is a comparison against zero, and the three ways it goes wrong are all
 * silent, which is why they are pinned here rather than left to a reviewer.
 *
 * The one that matters most is the **gap**. The chain works over an index of the
 * bins that carried enough data to correlate, so two entries beside each other
 * in that index can be a megabase apart on the chromosome. A segmenter that
 * walked the index rather than the bins would join them, and the BED would
 * assert a compartment over a stretch that took no part in the calculation.
 */

import { describe, expect, it } from 'vitest'

import { compartmentSegments } from '@/analysis/compartments'

/** Every bin of `0 … n`, as the index of a sequence with no excluded bins. */
function whole(n: number): Int32Array {
  return Int32Array.from({ length: n }, (_, i) => i)
}

describe('calling A and B from E1', () => {
  it('is one segment per run of one sign', () => {
    const calls = compartmentSegments(whole(6), Float64Array.from([1, 2, 3, -1, -2, 4]))
    expect(calls.map((call) => [call.side, call.from, call.to])).toEqual([
      ['A', 0, 2],
      ['B', 3, 4],
      ['A', 5, 5],
    ])
  })

  it('carries the mean of E1 as the strength of the call', () => {
    const [a, b] = compartmentSegments(whole(4), Float64Array.from([1, 3, -2, -4]))
    expect(a.mean).toBe(2)
    expect(a.bins).toBe(2)
    expect(b.mean).toBe(-3)
  })

  /**
   * The bins that took no part are not in the index, and a segment drawn across
   * them would be a claim about a stretch nothing measured.
   */
  it('does not bridge a gap in the index, even where the sign never changes', () => {
    const index = Int32Array.from([0, 1, 2, 40, 41])
    const calls = compartmentSegments(index, Float64Array.from([1, 1, 1, 1, 1]))
    expect(calls.map((call) => [call.from, call.to])).toEqual([
      [0, 2],
      [40, 41],
    ])
    expect(calls.every((call) => call.side === 'A')).toBe(true)
  })

  // A bin at exactly zero is not evidence of A, and one with no value is not
  // evidence of anything. Both end a run and start nothing.
  it('treats zero and NaN as no call at all', () => {
    const calls = compartmentSegments(
      whole(5),
      Float64Array.from([1, 0, 1, Number.NaN, 1]),
    )
    expect(calls.map((call) => [call.side, call.from, call.to])).toEqual([
      ['A', 0, 0],
      ['A', 2, 2],
      ['A', 4, 4],
    ])
  })

  it('answers an empty or all-gap vector with no calls', () => {
    expect(compartmentSegments(new Int32Array(0), new Float64Array(0))).toEqual([])
    expect(
      compartmentSegments(whole(3), Float64Array.from([Number.NaN, Number.NaN, Number.NaN])),
    ).toEqual([])
  })

  it('closes the last run rather than dropping it', () => {
    const calls = compartmentSegments(whole(3), Float64Array.from([-1, -1, -1]))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ side: 'B', from: 0, to: 2, bins: 3 })
  })
})

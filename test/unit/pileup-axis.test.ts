/**
 * What a pileup's axis says, and in what units (§18.8).
 *
 * A pileup is a picture of a window of the genome, and the question a reader
 * has of one is *how far from the anchor is that* — the corner of the domain,
 * the shoulder off the dot, the row the marginal peaks on. The axis used to
 * answer in **bins**, which is a number only somebody holding the resolution in
 * their head can use, and a different number for the same window at every
 * resolution: `±21` on a 1 kb map and `±21` on a 5 kb one are two pictures
 * five times apart, labelled identically.
 *
 * So the labels are distances. Two rules carry it and both are here: the sign
 * is written out on both sides, because what the label says is *which side of
 * the anchor*; and the five of them are positions **along the axis** rather
 * than the offsets of the cells they land on, which is what keeps a symmetric
 * window symmetric.
 */

import { describe, expect, it } from 'vitest'

import { formatBp, formatOffset, offsetTicks } from '@/analysis/run/labels'

describe('a signed distance', () => {
  it('writes the sign on both sides, so a label is a position and not a size', () => {
    expect(formatOffset(-21_000)).toBe('-21 kb')
    expect(formatOffset(21_000)).toBe('+21 kb')
    // The middle is neither, and `+0` is a claim about a side that has none.
    expect(formatOffset(0)).toBe('0')
  })

  it('is the same rounding the lanes are named with', () => {
    expect(formatOffset(1_500_000)).toBe(`+${formatBp(1_500_000)}`)
    expect(formatOffset(-750)).toBe('-750 bp')
    expect(formatOffset(-10_500)).toBe('-10.5 kb')
  })

  it('rounds to the base pair rather than printing a fraction of one', () => {
    expect(formatOffset(-0.4)).toBe('0')
    expect(formatOffset(250.6)).toBe('+251 bp')
  })
})

describe('the five labels along a pileup’s axis', () => {
  it('runs from one end of the window to the other, through zero', () => {
    // 43 cells at 1 kb: a half-width of 21 bins, which is ±21 kb.
    expect(offsetTicks(43, 1_000)).toEqual(['-21 kb', '-10.5 kb', '0', '+10.5 kb', '+21 kb'])
  })

  it('says the same thing about the same window at any resolution', () => {
    // The same ±20 kb, read at 1 kb and at 5 kb. A count of bins would call
    // the first ±20 and the second ±4 and leave the reader to divide.
    expect(offsetTicks(41, 1_000)[0]).toBe('-20 kb')
    expect(offsetTicks(9, 5_000)[0]).toBe('-20 kb')
  })

  it('is symmetric, which taking the labelled cells’ own offsets would not be', () => {
    // The quarter points of a 43-cell axis fall between cells — cell 10.5 and
    // cell 31.5 — and rounding each to a whole bin puts `-10 kb` opposite
    // `+11 kb` on a window that is the same width on both sides.
    const ticks = offsetTicks(43, 1_000)
    expect(ticks[1].replace('-', '')).toBe(ticks[3].replace('+', ''))
    expect(ticks[0].replace('-', '')).toBe(ticks[4].replace('+', ''))
  })

  it('handles an even window, whose middle is between two cells', () => {
    // Nothing in this task produces one — a half-width of `w` bins is `2w + 1`
    // cells — but a kernel from another tool may, and half a bin is a real
    // distance rather than a reason to draw no axis at all.
    expect(offsetTicks(4, 1_000)).toEqual(['-1.5 kb', '-750 bp', '0', '+750 bp', '+1.5 kb'])
  })

  it('has nothing to say where there is no window or no bin size', () => {
    expect(offsetTicks(0, 1_000)).toEqual([])
    expect(offsetTicks(43, 0)).toEqual([])
    // One cell is its own middle, and the picture is a single number.
    expect(offsetTicks(1, 1_000)).toEqual(['0', '0', '0', '0', '0'])
  })
})

/**
 * The sequence lane's resolution ladder, and the readout that has to agree with it.
 *
 * `drawSequence` itself is ink and is checked by eye, but the *decision* it makes
 * is not: whether a frame is showing residues or GC content is asked in three
 * places — the fetch (`BrowserView.fill` chooses which cache to ask), the paint,
 * and the tooltip — and if they ever disagree the lane fetches one thing and
 * draws another. So the decision lives in one function over the frame, and this
 * pins where it turns over.
 */

import { describe, expect, it } from 'vitest'

import { baseAt, basePixels, basesAreDrawable } from '@/render/sequence'
import type { LaneFrame } from '@/render/lane'

/** A bottom lane over `[from, to)` base pairs of a genome-unit axis. */
function frameOver(from: number, to: number, pixels = 900): LaneFrame {
  const scale = pixels / (to - from)
  return {
    orientation: 'bottom',
    toPixel: (unit) => (unit - from) * scale,
    toUnit: (pixel) => from + pixel / scale,
    domain: [from, to],
    alongFrom: 0,
    alongTo: pixels,
    acrossFrom: 100,
    thickness: 46,
  }
}

describe('the sequence ladder', () => {
  it('measures a base in pixels, from the frame alone', () => {
    expect(basePixels(frameOver(0, 900))).toBeCloseTo(1)
    expect(basePixels(frameOver(0, 90))).toBeCloseTo(10)
    expect(basePixels(frameOver(0, 12_000_000))).toBeLessThan(0.001)
  })

  it('turns over at one pixel per base', () => {
    // A window the width of the lane in bases: each base owns its column.
    expect(basesAreDrawable(frameOver(1000, 1900))).toBe(true)
    // One base more than there are pixels, and nothing legible can be drawn.
    expect(basesAreDrawable(frameOver(1000, 1901))).toBe(false)
    expect(basesAreDrawable(frameOver(0, 12_000_000))).toBe(false)
  })

  it('is unaffected by where the window is, only by how wide it is', () => {
    expect(basesAreDrawable(frameOver(0, 900))).toBe(basesAreDrawable(frameOver(11_000_000, 11_000_900)))
  })

  it('refuses an empty domain rather than dividing by it', () => {
    expect(basePixels(frameOver(500, 500))).toBe(0)
    expect(basesAreDrawable(frameOver(500, 500))).toBe(false)
  })
})

describe('baseAt', () => {
  const regions = [
    { contig: 'chrI', start: 100, end: 104, bases: new TextEncoder().encode('ACgt') },
    { contig: 'chrII', start: 0, end: 2, bases: new TextEncoder().encode('NN') },
  ]

  it('finds the residue at a position, upper-cased', () => {
    expect(baseAt(regions, 'chrI', 100)).toBe('A')
    expect(baseAt(regions, 'chrI', 102)).toBe('G')
    // A fractional position is the base it is inside, not the nearest one.
    expect(baseAt(regions, 'chrI', 103.9)).toBe('T')
    expect(baseAt(regions, 'chrII', 1)).toBe('N')
  })

  it('is null outside what has arrived, rather than the nearest thing to it', () => {
    expect(baseAt(regions, 'chrI', 99)).toBeNull()
    expect(baseAt(regions, 'chrI', 104)).toBeNull()
    expect(baseAt(regions, 'chrIII', 100)).toBeNull()
    expect(baseAt([], 'chrI', 100)).toBeNull()
  })
})

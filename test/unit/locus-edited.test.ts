/**
 * The axis through an edit (SPECS §27.2, §27.7): stretches that read backwards,
 * pieces of one original side by side, and a stretch that lands twice.
 *
 * Built by hand rather than through the reader, because what is pinned is the
 * one conversion every renderer now goes through (`bpAt`, `unitAt`,
 * `stretchOf`) and the answers it gives, on an axis small enough to check in
 * one's head: chromosome I, 100 kb at 1 kb a cell, with its middle third turned
 * round — the picture an inversion makes.
 */

import { describe, expect, it } from 'vitest'

import type { TrackSampleSet } from '../../src/annotations/types'
import type { LaneFrame } from '../../src/render/lane'
import { LocusAxis, bpAt, unitAt, unitSpan, type LocusSegment } from '../../src/render/locus'
import { profileOf } from '../../src/render/tracks'
import { bandRegion } from '../../src/ui/MatrixPanel'

const I = 100_000

/** `I` with `[30 kb, 60 kb)` inverted: forward, reversed, forward. */
function inverted(): LocusAxis {
  const piece = (unitStart: number, unitEnd: number, from: number, to: number, strand: 1 | -1): LocusSegment => ({
    contig: 'I',
    unitStart,
    unitEnd,
    bpStart: strand === 1 ? from : to,
    bpPerUnit: 1000,
    contigLength: I,
    strand,
    bpFrom: from,
    bpTo: to,
  })
  return new LocusAxis([piece(0, 30, 0, 30_000, 1), piece(30, 60, 30_000, 60_000, -1), piece(60, 100, 60_000, I, 1)])
}

describe('a stretch read backwards', () => {
  const axis = inverted()
  const turned = axis.segments[1]

  it('names falling base pairs as the unit rises, and back again', () => {
    expect(bpAt(turned, 30)).toBe(60_000)
    expect(bpAt(turned, 45)).toBe(45_000)
    expect(bpAt(turned, 59)).toBe(31_000)
    expect(unitAt(turned, 31_000)).toBe(59)
    expect(axis.unitToLocus(30.5)).toEqual({ contig: 'I', bp: 59_500 })
  })

  it('places a place in the piece that holds it, and only there', () => {
    expect(axis.locusToUnit('I', 10_000)).toBe(10)
    expect(axis.locusToUnit('I', 40_000)).toBe(50)
    expect(axis.locusToUnit('I', 70_000)).toBe(70)
    // One landing each: the three pieces of I are disjoint.
    expect(axis.locusToUnits('I', 40_000)).toEqual([50])
  })

  it('draws a feature’s end on its left', () => {
    expect(unitSpan(turned, 40_000, 42_000)).toEqual([48, 50])
  })

  it('asks for its window low end first, and never past the piece', () => {
    const windows = axis.windows([25, 65])
    expect(windows.map(({ start, end, unitFrom, unitTo }) => [start, end, unitFrom, unitTo])).toEqual([
      [25_000, 30_000, 25, 30],
      [30_000, 60_000, 30, 60],
      [60_000, 65_000, 60, 65],
    ])
    // Padded, a window stops at its piece's edges rather than fetching the
    // stretch beside it in the original — which is drawn elsewhere on the axis.
    const [padded] = axis.windows([40, 50], 1)
    expect(padded).toMatchObject({ start: 30_000, end: 60_000 })
  })

  it('names a band dragged across it low end first (bandRegion)', () => {
    expect(bandRegion(axis, [40, 45])).toEqual({ contig: 'I', start: 45_000, end: 50_000 })
  })
})

describe('a stretch that lands twice, and one that lands nowhere', () => {
  // I's `[10 kb, 20 kb)` duplicated after the whole of it, and `[50 kb, 60 kb)`
  // set aside: forward pieces of one original, not in order.
  const segment = (unitStart: number, from: number, to: number): LocusSegment => ({
    contig: 'I',
    unitStart,
    unitEnd: unitStart + (to - from) / 1000,
    bpStart: from,
    bpPerUnit: 1000,
    contigLength: I,
    bpFrom: from,
    bpTo: to,
  })
  const axis = new LocusAxis([segment(0, 0, 50_000), segment(50, 60_000, I), segment(90, 10_000, 20_000)])

  it('lands a duplicated place at both copies', () => {
    expect(axis.locusToUnits('I', 15_000)).toEqual([15, 95])
    expect(axis.segmentsOf('I')).toHaveLength(3)
  })

  it('lands a stretch set aside nowhere', () => {
    expect(axis.locusToUnits('I', 55_000)).toEqual([])
  })
})

describe('a signal through the lens', () => {
  const frame: LaneFrame = {
    orientation: 'bottom',
    toPixel: (unit) => unit,
    toUnit: (pixel) => pixel,
    domain: [0, 100],
    alongFrom: 0,
    alongTo: 100,
    acrossFrom: 0,
    thickness: 40,
  }
  /** A ramp: the value is the kilobase, so a mirror is visible at a glance. */
  function ramp(): TrackSampleSet {
    const starts = Int32Array.from({ length: 100 }, (_, i) => i * 1000)
    return {
      basesPerPixel: 1000,
      regions: [
        {
          contig: 'I',
          start: 0,
          end: I,
          starts,
          ends: Int32Array.from(starts, (start) => start + 1000),
          values: Float32Array.from({ length: 100 }, (_, i) => i),
          min: null,
          max: null,
          variant: null,
          summary: false,
        },
      ],
      extent: null,
    }
  }

  it('is mirrored in the turned piece and left alone either side', () => {
    const profile = profileOf(frame, inverted(), ramp())
    expect(profile.mean[10]).toBeCloseTo(10, 6)
    // The turned piece's first pixel is the original's 59th kilobase.
    expect(profile.mean[30]).toBeCloseTo(59, 6)
    expect(profile.mean[59]).toBeCloseTo(30, 6)
    expect(profile.mean[60]).toBeCloseTo(60, 6)
  })
})

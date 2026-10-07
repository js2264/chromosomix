/**
 * The two buttons beside `go` that move a region's window half its own width
 * along the sequence (§5.4): upstream and downstream, sliding in to stop at an
 * end, greyed (`null`) once there, and on a circle stopping at the ends as the
 * zoom steps do unless the window is already across the origin (§8.15).
 */

import { describe, expect, it } from 'vitest'

import { PAN_STEPS, shiftedRegion } from '@/ui/RegionView'

const LENGTH = 230_218

function window(start: number, end: number, length = LENGTH) {
  return { contig: 'chrI', start, end, length }
}

describe('shiftedRegion', () => {
  it('moves half a window each way', () => {
    expect(shiftedRegion(window(100_000, 120_000), -0.5)).toBe('chrI:90000-110000')
    expect(shiftedRegion(window(100_000, 120_000), 0.5)).toBe('chrI:110000-130000')
  })

  it('slides in to stop at an end, keeping the width', () => {
    expect(shiftedRegion(window(5_000, 25_000), -0.5)).toBe('chrI:0-20000')
    expect(shiftedRegion(window(205_000, 225_000), 0.5)).toBe('chrI:210218-230218')
  })

  it('has nowhere to go at an end, or on the whole sequence', () => {
    expect(shiftedRegion(window(0, 20_000), -0.5)).toBeNull()
    expect(shiftedRegion(window(210_218, LENGTH), 0.5)).toBeNull()
    expect(shiftedRegion(window(0, LENGTH), 0.5)).toBeNull()
  })

  it('stops at the ends of a circle, unless the window is already across the origin', () => {
    expect(shiftedRegion(window(0, 20_000), -0.5, { circular: true })).toBeNull()
    expect(shiftedRegion(window(220_000, 10_000), 0.5, { circular: true })).toBe(
      'chrI:230109-20109',
    )
    expect(shiftedRegion(window(220_000, 10_000), -0.5, { circular: true })).toBe(
      'chrI:209891-230109',
    )
  })

  it('offers upstream first', () => {
    expect(PAN_STEPS.map((step) => step.fraction)).toEqual([-0.5, 0.5])
  })
})

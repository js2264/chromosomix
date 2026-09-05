/**
 * The mark a depth lane puts on a position its reads disagree with (§8.13).
 *
 * Three claims, and each of them is a way to draw a lie rather than a way to
 * draw nothing. **The threshold has to bite**, because sequencing error puts a
 * base or two of disagreement under any real pileup and a mark at the first
 * mismatch is a lane speckled from end to end. **The height has to be the
 * disagreeing depth**, not the total, or a position where one read in twenty
 * differs is painted as tall as the pileup and reads as a homozygous variant.
 * And **no reference must draw nothing at all**, since "these reads agree" and
 * "there was nothing to compare against" are different sentences and only one
 * of them is a fact about the data.
 */

import { describe, expect, it } from 'vitest'

import type { LaneFrame } from '@/render/lane'
import { drawTrack, type PixelProfile, type TrackPaint } from '@/render/tracks'

interface Rect {
  x: number
  y: number
  w: number
  h: number
  fill: string
}

/** A canvas that remembers the rectangles it was asked to fill, and in what. */
function recorder(): { ctx: CanvasRenderingContext2D; filled: Rect[] } {
  const filled: Rect[] = []
  let pending: Array<Omit<Rect, 'fill'>> = []
  const state = { strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, globalAlpha: 1 }
  const stack: Array<typeof state> = []
  const ctx = {
    get strokeStyle() { return state.strokeStyle },
    set strokeStyle(value: string) { state.strokeStyle = value },
    get fillStyle() { return state.fillStyle },
    set fillStyle(value: string) { state.fillStyle = value },
    get lineWidth() { return state.lineWidth },
    set lineWidth(value: number) { state.lineWidth = value },
    get globalAlpha() { return state.globalAlpha },
    set globalAlpha(value: number) { state.globalAlpha = value },
    font: '',
    lineJoin: '',
    save: () => { stack.push({ ...state }) },
    restore: () => { Object.assign(state, stack.pop() ?? state) },
    beginPath: () => { pending = [] },
    closePath: () => {},
    rect: (x: number, y: number, w: number, h: number) => { pending.push({ x, y, w, h }) },
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {
      for (const one of pending) filled.push({ ...one, fill: String(state.fillStyle) })
      pending = []
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, filled }
}

/** A four-pixel lane, forty across, growing down from its top edge. */
const frame: LaneFrame = {
  orientation: 'bottom',
  toPixel: (unit) => unit,
  toUnit: (pixel) => pixel,
  domain: [0, 4],
  alongFrom: 0,
  alongTo: 4,
  acrossFrom: 0,
  thickness: 40,
}

const LANE_COLOUR = '#1f5fa9'

function paintOf(): TrackPaint {
  return {
    colour: LANE_COLOUR,
    mode: 'bar',
    limits: { min: 0, max: 10 },
    guideColour: '#333',
    haloColour: '#fff',
    font: '10px sans-serif',
    opacity: 1,
    fills: true,
    outline: false,
    flip: false,
    baseline: false,
  }
}

function profileOf(mean: number[], variant: number[] | null): PixelProfile {
  return {
    from: 0,
    mean: Float32Array.from(mean),
    low: Float32Array.from(mean),
    high: Float32Array.from(mean),
    envelope: false,
    variant: variant === null ? null : Float32Array.from(variant),
    extent: { min: 0, max: 10 },
  }
}

/** The rectangles that are not the track's own bars. */
function marks(filled: Rect[]): Rect[] {
  return filled.filter((one) => one.fill !== LANE_COLOUR)
}

describe('the variant mark', () => {
  it('is drawn where a fifth or more of the depth disagrees', () => {
    const { ctx, filled } = recorder()
    // Four pixels at depth 10, disagreeing by 0, 1, 2 and 5 reads: a tenth is
    // noise, a fifth is the threshold itself, and a half is a heterozygote.
    drawTrack(ctx, frame, profileOf([10, 10, 10, 10], [0, 1, 2, 5]), paintOf())
    expect(marks(filled).map((one) => one.x)).toEqual([2, 3])
  })

  it('is as tall as the depth that disagrees, not as the depth', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([10, 10], [10, 5]), paintOf())
    const [full, half] = marks(filled)
    // A pixel every read disagrees at fills the bar; one where half do fills
    // half of it. Without this a one-in-five position is painted as tall as a
    // homozygous one and the picture stops saying anything.
    expect(full.h).toBeCloseTo(frame.thickness, 6)
    expect(half.h).toBeCloseTo(full.h / 2, 6)
  })

  it('draws nothing where there was no reference to compare against', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([10, 10, 10, 10], null), paintOf())
    expect(marks(filled)).toEqual([])
    // …and the track itself is still drawn, so this is a missing mark and not a
    // missing lane.
    expect(filled.filter((one) => one.fill === LANE_COLOUR)).toHaveLength(4)
  })

  it('draws nothing where the reads agree', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([10, 10], [0, 0]), paintOf())
    expect(marks(filled)).toEqual([])
  })

  it('marks an area lane as well as a bar one', () => {
    // The two modes take different paths through `drawTrack` — a bar is a
    // rectangle per pixel, an area is one closed polyline — and the mark has to
    // come out of both. It went into the bar arm first and was invisible on the
    // default lane, which draws as an area.
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([10, 10], [10, 0]), { ...paintOf(), mode: 'area' })
    expect(marks(filled).map((one) => one.x)).toEqual([0])
  })

  it('says nothing about a pixel with no depth under it', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([Number.NaN, 0], [1, 1]), paintOf())
    expect(marks(filled)).toEqual([])
  })
})

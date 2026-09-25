/**
 * The points lane: a dot per value, and nothing between them.
 *
 * A Manhattan plot's picture, for a track whose values are not a curve. What is
 * pinned here is what makes it that picture rather than a dotted line:
 *
 * - **one dot per value**, where a value is a run of pixels carrying it — so a
 *   bin twenty pixels wide is one point at its middle and not a dash, and a
 *   zoomed-out lane is a dot per pixel;
 * - **a gap is a gap**, as in every mode: `NaN` draws nothing;
 * - **the lane's own limits and flip**, from the mean, because a dot is a
 *   position like a line's vertex and has to answer to the same axis;
 * - **each dot its own subpath**, or a canvas fills the polygon between them.
 */

import { describe, expect, it } from 'vitest'

import { TRACK_MODES } from '@/annotations/types'
import type { LaneFrame } from '@/render/lane'
import {
  POINT_RADIUS,
  drawTrack,
  valueRuns,
  type PixelProfile,
  type TrackPaint,
} from '@/render/tracks'

interface Dot {
  x: number
  y: number
  r: number
  /** Whether a `moveTo` opened this dot's subpath at its own edge. */
  moved: boolean
}

/** A canvas that remembers the circles it was asked to fill. */
function recorder(): { ctx: CanvasRenderingContext2D; dots: Dot[]; fills: number } {
  const out = { dots: [] as Dot[], fills: 0 }
  let pending: Dot[] = []
  let last: { x: number; y: number } | null = null
  const noop = (): void => {}
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    lineJoin: '',
    save: noop,
    restore: noop,
    beginPath: () => {
      pending = []
      last = null
    },
    closePath: noop,
    moveTo: (x: number, y: number) => {
      last = { x, y }
    },
    lineTo: noop,
    rect: noop,
    fillRect: noop,
    stroke: noop,
    arc: (x: number, y: number, r: number) => {
      pending.push({ x, y, r, moved: last !== null && last.x === x + r && last.y === y })
      last = null
    },
    fill: () => {
      out.dots.push(...pending)
      out.fills++
      pending = []
    },
  }
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    get dots() {
      return out.dots
    },
    get fills() {
      return out.fills
    },
  } as { ctx: CanvasRenderingContext2D; dots: Dot[]; fills: number }
}

/** A lane eight pixels long and forty across, growing up from its bottom edge. */
const frame: LaneFrame = {
  orientation: 'bottom',
  toPixel: (unit) => unit,
  toUnit: (pixel) => pixel,
  domain: [0, 8],
  alongFrom: 0,
  alongTo: 8,
  acrossFrom: 0,
  thickness: 40,
}

function paintOf(over: Partial<TrackPaint> = {}): TrackPaint {
  return {
    colour: '#1f5fa9',
    mode: 'points',
    limits: { min: 0, max: 10 },
    guideColour: '#333',
    haloColour: '#fff',
    font: '10px sans-serif',
    opacity: 1,
    fills: true,
    outline: false,
    flip: false,
    baseline: false,
    ...over,
  }
}

function profileOf(mean: number[]): PixelProfile {
  return {
    from: 0,
    mean: Float32Array.from(mean),
    low: Float32Array.from(mean),
    high: Float32Array.from(mean),
    envelope: false,
    variant: null,
    extent: null,
  }
}

describe('the points style', () => {
  it('is offered with the others', () => {
    expect(TRACK_MODES).toContain('points')
  })

  it('draws a dot per pixel where every pixel is its own value', () => {
    const canvas = recorder()
    drawTrack(canvas.ctx, frame, profileOf([1, 2, 3, 4, 5, 6, 7, 8]), paintOf())
    expect(canvas.dots).toHaveLength(8)
    expect(canvas.dots.map((dot) => dot.x)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5])
    expect(canvas.dots.every((dot) => dot.r === POINT_RADIUS)).toBe(true)
    // All of them in one fill, each opened at its own edge.
    expect(canvas.fills).toBe(1)
    expect(canvas.dots.every((dot) => dot.moved)).toBe(true)
  })

  it('draws a bin that spans several pixels as one dot at its middle', () => {
    const canvas = recorder()
    drawTrack(canvas.ctx, frame, profileOf([2, 2, 2, 2, 5, 5, 5, 5]), paintOf())
    expect(canvas.dots.map((dot) => dot.x)).toEqual([2, 6])
  })

  it('leaves a gap empty, and does not join the values either side of it', () => {
    const canvas = recorder()
    drawTrack(canvas.ctx, frame, profileOf([3, 3, NaN, NaN, 3, 3, NaN, 1]), paintOf())
    expect(canvas.dots.map((dot) => dot.x)).toEqual([1, 5, 7.5])
  })

  it('places a dot by the lane’s own limits, and turns over with the flip', () => {
    const upright = recorder()
    drawTrack(upright.ctx, frame, profileOf([10, 10, 10, 10, 0, 0, 0, 0]), paintOf())
    const flipped = recorder()
    drawTrack(flipped.ctx, frame, profileOf([10, 10, 10, 10, 0, 0, 0, 0]), paintOf({ flip: true }))
    const [high, low] = upright.dots
    // Growing up from the bottom edge: the ceiling is the far side of the lane.
    expect(Math.abs(high.y - low.y)).toBeCloseTo(40, 5)
    expect(flipped.dots[0].y).toBeCloseTo(low.y, 5)
    expect(flipped.dots[1].y).toBeCloseTo(high.y, 5)
  })
})

describe('the runs a points lane dots', () => {
  it('splits on every change of value and on every gap', () => {
    expect(valueRuns(profileOf([1, 1, 2, NaN, 2, 2]))).toEqual([
      [0, 2],
      [2, 3],
      [4, 6],
    ])
    expect(valueRuns(profileOf([NaN, NaN]))).toEqual([])
    expect(valueRuns(profileOf([]))).toEqual([])
  })
})

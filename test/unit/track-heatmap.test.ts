/**
 * The heatmap lane: a value drawn as a colour rather than as a position (§18.11).
 *
 * It exists for one picture — several tracks that are one measurement at several
 * settings, insulation at four windows being the case that asked for it — and
 * the reason it is a *mode* rather than a second renderer is that everything
 * else about the lane has to keep working: the same limits, the same autoscale
 * group, the same ceiling drag, the same flip. So what is asserted here is
 * mostly that nothing was special-cased away.
 *
 * The three claims that are actually new:
 *
 * - **the lane's whole thickness is filled**, because a value that costs no
 *   height is the entire point — four scales in one lane instead of four lanes;
 * - **the colour is the value through the lane's own limits**, so two rows of a
 *   stack sharing an axis are comparable by eye, which is what a group is for;
 * - **a gap stays a gap.** `NaN` means *no value here* everywhere in this
 *   codebase, and a heatmap is the one mode where the tempting mistake — paint
 *   it at the bottom of the ramp — is invisible rather than obviously wrong.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HEATMAP_LANE_COLORMAP,
  colormapOf,
  stacksAsHeatmaps,
  type TrackMode,
} from '@/annotations/types'
import { DEFAULT_DIVERGING_COLORMAP, colormapCss } from '@/render/colormaps'
import { laneBands, type LaneFrame } from '@/render/lane'
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
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(value: string) {
      state.strokeStyle = value
    },
    get fillStyle() {
      return state.fillStyle
    },
    set fillStyle(value: string) {
      state.fillStyle = value
    },
    get lineWidth() {
      return state.lineWidth
    },
    set lineWidth(value: number) {
      state.lineWidth = value
    },
    get globalAlpha() {
      return state.globalAlpha
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value
    },
    font: '',
    lineJoin: '',
    save: () => {
      stack.push({ ...state })
    },
    restore: () => {
      Object.assign(state, stack.pop() ?? state)
    },
    beginPath: () => {
      pending = []
    },
    closePath: () => {},
    rect: (x: number, y: number, w: number, h: number) => {
      pending.push({ x, y, w, h })
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      filled.push({ x, y, w, h, fill: String(state.fillStyle) })
    },
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

/** A lane four pixels long and forty across, growing down from its top edge. */
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

function paintOf(over: Partial<TrackPaint> = {}): TrackPaint {
  return {
    colour: '#1f5fa9',
    mode: 'heatmap',
    colormap: DEFAULT_HEATMAP_LANE_COLORMAP,
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

describe('a value drawn as a colour', () => {
  it('fills the whole thickness of the lane, so the value costs no height', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([0, 3, 7, 10]), paintOf())

    expect(filled).toHaveLength(4)
    for (const [at, rect] of filled.entries()) {
      expect(rect.h).toBe(frame.thickness)
      expect(rect.y).toBe(frame.acrossFrom)
      expect(rect.x).toBe(at)
      expect(rect.w).toBe(1)
    }
  })

  it('takes the colour from the value, through the limits the lane is drawn on', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([0, 5, 10]), paintOf())

    // The same normaliser every other mode is drawn through: 0 at the floor, 1
    // at the ceiling. A lane whose limits are set by its group therefore colours
    // by the group's axis, which is what makes two rows comparable.
    expect(filled.map((rect) => rect.fill)).toEqual([
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 0),
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 0.5),
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 1),
    ])
  })

  it('leaves a gap unpainted rather than painting it at the floor', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([1, Number.NaN, 9]), paintOf())

    // Two rectangles, at the two pixels that had a value — and the middle pixel
    // shows whatever is behind the lane, which is the honest answer.
    expect(filled).toHaveLength(2)
    expect(filled.map((rect) => rect.x)).toEqual([0, 2])
  })

  it('reverses the ramp when the axis is flipped, because that is what flipping an axis means', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([0, 10]), paintOf({ flip: true }))

    expect(filled.map((rect) => rect.fill)).toEqual([
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 1),
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 0),
    ])
  })

  it('clamps a value past the ceiling onto the end colour instead of dropping it', () => {
    const { ctx, filled } = recorder()
    drawTrack(ctx, frame, profileOf([-4, 14]), paintOf())

    expect(filled).toHaveLength(2)
    expect(filled.map((rect) => rect.fill)).toEqual([
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 0),
      colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, 1),
    ])
  })
})

/**
 * *Auto* is a reading of the data, not a fallback.
 *
 * A track that runs from zero upwards is an amount and wants a ramp; one that
 * crosses zero is a departure from something and wants a diverging map with its
 * middle on the zero — which is the same reading the value axis already makes
 * when it decides where to put its baseline. Insulation is the second kind, and
 * a log2 ratio drawn on `viridis` puts "no change" at an arbitrary green.
 */
describe('the colormap a heatmap lane picks', () => {
  it('diverges when the values straddle zero', () => {
    expect(colormapOf({}, { min: -2, max: 2 })).toBe(DEFAULT_DIVERGING_COLORMAP)
  })

  it('ramps when they do not', () => {
    expect(colormapOf({}, { min: 0, max: 40 })).toBe(DEFAULT_HEATMAP_LANE_COLORMAP)
    expect(colormapOf({}, { min: -8, max: -1 })).toBe(DEFAULT_HEATMAP_LANE_COLORMAP)
  })

  it('gives way to the reader, and treats their empty choice as no choice', () => {
    expect(colormapOf({ colormap: 'magma' }, { min: -2, max: 2 })).toBe('magma')
    expect(colormapOf({ colormap: '' }, { min: -2, max: 2 })).toBe(DEFAULT_DIVERGING_COLORMAP)
  })
})

/**
 * Heatmaps stack; everything else overlays.
 *
 * Two translucent lines in one lane are legible because ink adds. Two
 * translucent colour maps are a third colour that means neither, so a lane of
 * them divides itself instead — and a lane that is *partly* heatmaps cannot,
 * because the line among them has nowhere to be drawn but across the whole of it.
 */
describe('what makes a lane divide itself', () => {
  const member = (mode: TrackMode): { style: { mode: TrackMode } } => ({ style: { mode } })

  it('stacks a lane whose members all draw as heatmaps', () => {
    expect(stacksAsHeatmaps([member('heatmap'), member('heatmap')])).toBe(true)
  })

  it('overlays a mixed lane, and leaves a single track alone', () => {
    expect(stacksAsHeatmaps([member('heatmap'), member('line')])).toBe(false)
    expect(stacksAsHeatmaps([member('heatmap')])).toBe(false)
    expect(stacksAsHeatmaps([])).toBe(false)
  })

  it('splits the lane the reader set, and does not grow it', () => {
    // Four scales in the height of one track: the bands are equal, in order,
    // and butt against each other without overlapping — which is what keeps a
    // boundary a straight column through the stack.
    const bands = laneBands(
      frame,
      [1, 2, 3, 4].map(() => ({ fill: true as const })),
    )
    expect(bands).toHaveLength(4)
    for (const band of bands) expect(band.thickness).toBe(frame.thickness / 4)
    expect(bands.map((band) => band.acrossFrom)).toEqual([0, 10, 20, 30])
  })
})

/**
 * Four edges, one geometry.
 *
 * A lane can be drawn above the map, below it, or down either side, and the
 * whole of what makes that cheap is that nothing outside `render/lane.ts` knows
 * which of *along* and *across* is x, which way each of them points, or where a
 * value of zero sits. Two things follow, and both fail silently if they are
 * wrong: `across` always runs **outward, away from the map**, so "the far
 * border" is `thickness` on every edge; and an unflipped lane grows in the
 * conventional direction for its axis — up the page, or right across it — which
 * is towards the matrix on two edges and away from it on the other two.
 *
 * Asserted as arithmetic rather than looked at on screen, because the failure
 * mode of a mirrored coordinate is a picture that looks plausible and is upside
 * down (spec §8.4).
 */

import { describe, expect, it } from 'vitest'

import { LANE_EDGES, type LaneEdge } from '../../src/annotations/types'
import {
  GRIP_GAP,
  acrossToCanvas,
  canvasToAcross,
  gripBox,
  gripFrom,
  laneGrowsInward,
  laneIsHorizontal,
  laneOutward,
  laneRect,
  laneStartsFlipped,
  valueAcross,
  type LaneFrame,
} from '../../src/render/lane'
import { ceilingFactor } from '../../src/render/tracks'

/**
 * A lane on one edge, `thickness` across, with its near-the-map edge at
 * `acrossFrom` and data running from 40 to 400 along.
 */
function frameOf(orientation: LaneEdge, thickness = 40, acrossFrom = 100): LaneFrame {
  return {
    orientation,
    toPixel: (unit) => unit,
    toUnit: (pixel) => pixel,
    domain: [40, 400],
    alongFrom: 40,
    alongTo: 400,
    acrossFrom,
    thickness,
  }
}

describe('which axis an edge runs along', () => {
  it('puts the genomic axis across the page above and below the map', () => {
    expect(laneIsHorizontal('top')).toBe(true)
    expect(laneIsHorizontal('bottom')).toBe(true)
    expect(laneIsHorizontal('left')).toBe(false)
    expect(laneIsHorizontal('right')).toBe(false)
  })

  // The handle hangs immediately before the lane's *name*, which is a fact about
  // the reading direction and therefore about the axis — not about the side. A
  // lane above the map and one below it read the same way round.
  it('hangs the handle off the same end for both edges of an axis', () => {
    const before = 40 - GRIP_GAP
    expect(gripFrom(frameOf('top'))).toBe(gripFrom(frameOf('bottom')))
    expect(gripFrom(frameOf('bottom'))).toBeLessThan(before)
    expect(gripFrom(frameOf('left'))).toBe(gripFrom(frameOf('right')))
    expect(gripFrom(frameOf('right'))).toBe(400 + GRIP_GAP)
  })
})

/**
 * The convention the rest of the application is written against: `across` counts
 * from the map outward. Below and beside the map that is the canvas direction;
 * above it and to its left it is the canvas direction reversed, and every hit
 * test, clip and label depends on the two being told apart exactly here.
 */
describe('across, measured outward from the map', () => {
  it('runs with the canvas below and beside the map, and against it above and left', () => {
    expect(laneOutward('bottom')).toBe(1)
    expect(laneOutward('right')).toBe(1)
    expect(laneOutward('top')).toBe(-1)
    expect(laneOutward('left')).toBe(-1)
  })

  it('puts the lane’s far border at `thickness` on every edge', () => {
    for (const edge of LANE_EDGES) {
      const frame = frameOf(edge)
      // Whatever the canvas direction, zero is against the map and `thickness`
      // is the border a resize drag grabs.
      // `toBeCloseTo` rather than `toBe`, only because `-1 * 0` is `-0` and
      // `Object.is` tells the two zeroes apart. Nothing else does.
      expect(canvasToAcross(frame, acrossToCanvas(frame, 0))).toBeCloseTo(0)
      expect(canvasToAcross(frame, acrossToCanvas(frame, frame.thickness))).toBe(frame.thickness)
    }
  })

  it('mirrors the canvas coordinate above the map and to its left', () => {
    expect(acrossToCanvas(frameOf('bottom'), 10)).toBe(110)
    expect(acrossToCanvas(frameOf('right'), 10)).toBe(110)
    expect(acrossToCanvas(frameOf('top'), 10)).toBe(90)
    expect(acrossToCanvas(frameOf('left'), 10)).toBe(90)
  })

  // A rectangle is always its low corner and a positive span, so the mirrored
  // edges cannot be allowed to hand back a negative width.
  it('gives a rectangle its low corner and a positive span on every edge', () => {
    for (const edge of LANE_EDGES) {
      const [x, y, width, height] = laneRect(frameOf(edge), 100, 200, 0, 40)
      expect(width).toBeGreaterThan(0)
      expect(height).toBeGreaterThan(0)
      if (laneIsHorizontal(edge)) {
        expect([x, width]).toEqual([100, 100])
        expect([y, height]).toEqual(edge === 'bottom' ? [100, 40] : [60, 40])
      } else {
        expect([y, height]).toEqual([100, 100])
        expect([x, width]).toEqual(edge === 'right' ? [100, 40] : [60, 40])
      }
    }
  })

  it('keeps the handle inside the canvas its stack occupies', () => {
    // The handle hangs outside the lane *along* the axis and inside it *across*,
    // so on a mirrored edge its box must still land on the drawn strip.
    for (const edge of LANE_EDGES) {
      const frame = frameOf(edge, 40, laneOutward(edge) > 0 ? 0 : 40)
      const [x, y, width, height] = gripBox(frame, 8)
      const low = laneIsHorizontal(edge) ? y : x
      const span = laneIsHorizontal(edge) ? height : width
      expect(low).toBeGreaterThanOrEqual(0)
      expect(low + span).toBeLessThanOrEqual(40)
    }
  })
})

/**
 * Which way a lane grows, which is the one thing about the four edges that is
 * not a coordinate: unflipped, a horizontal lane's values grow up the page and a
 * vertical one's grow right across it — the conventional orientation of each
 * axis — and the side of the map decides whether that points at the matrix.
 */
describe('which way an unflipped lane grows', () => {
  it('grows towards the map from below it and from its left', () => {
    expect(laneGrowsInward('bottom')).toBe(true)
    expect(laneGrowsInward('left')).toBe(true)
    expect(laneGrowsInward('top')).toBe(false)
    expect(laneGrowsInward('right')).toBe(false)
  })

  /**
   * …and which way a lane *starts*, which is a policy on top of that geometry
   * and is two rules rather than one.
   *
   * A horizontal lane keeps the conventional reading of a track under a ruler —
   * up from a floor — above the map and below it alike, because that convention
   * is universal and beats the picture's own symmetry. A vertical lane has no
   * such convention, so the corner decides and it faces the matrix. Exactly one
   * edge therefore turns, which is what it was when there were only two.
   */
  it('starts a lane turned round on the right edge and nowhere else', () => {
    expect(laneStartsFlipped('right')).toBe(true)
    for (const edge of ['top', 'bottom', 'left'] as const) {
      expect(laneStartsFlipped(edge)).toBe(false)
    }
  })

  it('starts every horizontal lane growing up the page', () => {
    for (const edge of ['top', 'bottom'] as const) {
      const frame = frameOf(edge)
      const flip = laneStartsFlipped(edge)
      const full = acrossToCanvas(frame, valueAcross(frame, flip ? 0 : 1))
      const floor = acrossToCanvas(frame, valueAcross(frame, flip ? 1 : 0))
      expect(full).toBeLessThan(floor)
    }
  })

  it('starts every vertical lane growing towards the map', () => {
    for (const edge of ['left', 'right'] as const) {
      const frame = frameOf(edge)
      const flip = laneStartsFlipped(edge)
      // Towards the map is `across` decreasing, whichever canvas direction that
      // is: `across` runs outward by construction.
      expect(valueAcross(frame, flip ? 0 : 1)).toBeLessThan(valueAcross(frame, flip ? 1 : 0))
    }
  })

  it('draws a full value up the page on both horizontal edges', () => {
    // Canvas y, not lane across: the claim is about the picture. A value of one
    // is higher up the page than a value of zero, above the map and below it.
    for (const edge of ['top', 'bottom'] as const) {
      const frame = frameOf(edge)
      const full = acrossToCanvas(frame, valueAcross(frame, 1))
      const floor = acrossToCanvas(frame, valueAcross(frame, 0))
      expect(full).toBeLessThan(floor)
    }
  })

  it('draws a full value to the right on both vertical edges', () => {
    for (const edge of ['left', 'right'] as const) {
      const frame = frameOf(edge)
      const full = acrossToCanvas(frame, valueAcross(frame, 1))
      const floor = acrossToCanvas(frame, valueAcross(frame, 0))
      expect(full).toBeGreaterThan(floor)
    }
  })

  // The baseline is the edge of the strip a track fills from, and it has to be
  // one of the two ends of the lane rather than somewhere in the middle of it.
  it('puts the baseline against one end of the lane on every edge', () => {
    for (const edge of LANE_EDGES) {
      const frame = frameOf(edge)
      expect([0, frame.thickness]).toContain(valueAcross(frame, 0))
      expect([0, frame.thickness]).toContain(valueAcross(frame, 1))
      expect(valueAcross(frame, 0)).not.toBe(valueAcross(frame, 1))
    }
  })
})

/**
 * The ceiling drag, which is direct manipulation in the one sense that survives
 * four edges and the flip: dragging **towards the signal's own growing
 * direction** makes the signal taller, which is the ceiling coming down.
 *
 * Which screen direction that is cannot be written down — it is `valueAcross`'s
 * answer, and it is opposite on the two ends of each axis and reversed again by
 * `flip`. So the property is asserted rather than the number, on every edge and
 * both ways round: eight cases, one rule.
 */
describe('a drag on a lane’s ceiling', () => {
  /** The lane-local across a value of one is drawn at, which is where to drag. */
  const towardsFull = (frame: LaneFrame, flip: boolean): number =>
    valueAcross(frame, flip ? 0 : 1)

  it('lowers the ceiling when the drag goes the way the signal grows', () => {
    for (const edge of LANE_EDGES) {
      for (const flip of [false, true]) {
        const frame = frameOf(edge)
        const middle = frame.thickness / 2
        const factor = ceilingFactor(frame, middle, towardsFull(frame, flip), flip)
        expect(factor).toBeLessThan(1)
      }
    }
  })

  it('raises it when the drag goes the other way', () => {
    for (const edge of LANE_EDGES) {
      for (const flip of [false, true]) {
        const frame = frameOf(edge)
        const middle = frame.thickness / 2
        const away = frame.thickness - towardsFull(frame, flip)
        expect(ceilingFactor(frame, middle, away, flip)).toBeGreaterThan(1)
      }
    }
  })

  // The gesture composes: the same travel back is the same factor inverted, so
  // a drag out and back leaves the axis where it started.
  it('is its own inverse over the same travel', () => {
    for (const edge of LANE_EDGES) {
      const frame = frameOf(edge)
      const out = ceilingFactor(frame, 10, 30, false)
      const back = ceilingFactor(frame, 30, 10, false)
      expect(out * back).toBeCloseTo(1, 10)
    }
  })
})

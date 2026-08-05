/**
 * The handle every lane is dragged by: where it lands, and what counts as being
 * on it.
 *
 * Pure geometry, and deliberately so — the handle is drawn on a canvas and hit
 * tested against a pointer, and those are two calls that have to agree about one
 * rectangle. The thing that can go wrong is a number, so the number is asserted
 * here rather than looked at on screen (spec §8.4).
 */

import { describe, expect, it } from 'vitest'

import {
  GRIP_ACROSS,
  GRIP_ALONG,
  GRIP_GAP,
  GRIP_ROOM,
  gripAcross,
  gripBox,
  gripFrom,
  withinGrip,
  type LaneFrame,
} from '../../src/render/lane'

/** A lane on either edge of a map: `thickness` across, and data from 40 to 400. */
function frameOf(
  orientation: 'bottom' | 'right',
  thickness: number,
  acrossFrom = 0,
  alongFrom = 40,
): LaneFrame {
  return {
    orientation,
    toPixel: (unit) => unit,
    toUnit: (pixel) => pixel,
    domain: [alongFrom, 400],
    alongFrom,
    alongTo: 400,
    acrossFrom,
    thickness,
  }
}

describe('the handle’s box', () => {
  // Outside the lane, in the margin before the data: that is what lets it be
  // there permanently without a track name moving to make room for it.
  it('hangs off the near end of a bottom lane, clear of the data', () => {
    const frame = frameOf('bottom', 40, 100)
    const [x, y, width, height] = gripBox(frame, gripAcross(frame, 20))
    expect(x + width).toBe(frame.alongFrom - GRIP_GAP)
    expect(width).toBe(GRIP_ALONG)
    expect(height).toBe(GRIP_ACROSS)
    // Level with a name whose middle is 20 into a lane that starts at 100.
    expect(y + height / 2).toBe(120)
  })

  // A right-hand lane turns a quarter turn and reads *upward*, so its name
  // starts at the bottom: the handle goes below the data, before that name,
  // rather than at the top where the axis begins and the label ends.
  it('hangs off the end a right-hand lane’s name starts at', () => {
    const frame = frameOf('right', 40, 100)
    const [x, y, width, height] = gripBox(frame, gripAcross(frame, 20))
    expect(y).toBe(frame.alongTo + GRIP_GAP)
    expect(height).toBe(GRIP_ALONG)
    expect(width).toBe(GRIP_ACROSS)
    expect(x + width / 2).toBe(120)
  })

  // …and it is never backed into the data to fit a canvas. A handle sitting on
  // the signal is both illegible and a target you cannot tell from the picture,
  // so the stack grows its own canvas instead (`AnnotationLanes.tailFor`).
  it('never overlaps the data, however little room is left after it', () => {
    for (const alongTo of [100, 399, 400, 460]) {
      const frame = { ...frameOf('right', 40, 100), alongTo }
      const [, y] = gripBox(frame, gripAcross(frame, 20))
      expect(y).toBeGreaterThanOrEqual(alongTo + GRIP_GAP)
    }
  })

  // A plot with almost no margin still gets a handle: flush against the data
  // rather than off the canvas, where it could be neither seen nor pressed.
  it('never leaves the canvas when the margin is too small for it', () => {
    for (const alongFrom of [0, 2, 6, 8, 40]) {
      const box = gripBox(frameOf('bottom', 30, 0, alongFrom), 3)
      expect(box[0]).toBeGreaterThanOrEqual(0)
      expect(box[0] + box[2]).toBeLessThanOrEqual(Math.max(GRIP_ALONG, alongFrom))
    }
    expect(gripFrom(frameOf('bottom', 30, 0, 0))).toBe(0)
  })

  // The handle is on the *name's* line — the label and the handle are one row,
  // read together — so it follows the name wherever the layout puts it: at the
  // top over the data, centred in a column, at the floor on a flipped track.
  it('lines up with the name it belongs to', () => {
    const frame = frameOf('bottom', 90, 50)
    for (const nameAt of [9, 45, 80]) {
      expect(gripAcross(frame, nameAt) + GRIP_ACROSS / 2).toBe(nameAt)
    }
  })

  // …but never outside the lane, however short it has been dragged or wherever
  // the name ended up on it.
  it('stays inside the lane whatever the name did', () => {
    for (const thickness of [10, 14, 40, 90]) {
      const frame = frameOf('bottom', thickness, 50)
      for (const nameAt of [0, 9, thickness / 2, thickness, thickness + 20]) {
        const across = gripAcross(frame, nameAt)
        expect(across).toBeGreaterThanOrEqual(0)
        expect(across + GRIP_ACROSS).toBeLessThanOrEqual(Math.max(GRIP_ACROSS, thickness))
      }
    }
  })

  // What a view has to keep clear before its data if the handle is to hang
  // there at all — the 1D browser's left margin is built out of this.
  it('says how much room it needs', () => {
    expect(GRIP_ROOM).toBe(GRIP_ALONG + GRIP_GAP)
  })
})

describe('what counts as being on it', () => {
  const frame = frameOf('bottom', 40, 100)
  const box = gripBox(frame, gripAcross(frame, 20))

  it('takes a point on the glyph', () => {
    expect(withinGrip(box, box[0] + 3, box[1] + 5)).toBe(true)
  })

  // Six pixels by ten is a target nobody hits with a trackpad, so there is slack
  // around it — but slack in *every* direction, not a box that has quietly grown
  // into the data beside it.
  it('takes a point just outside it, and not one well outside', () => {
    expect(withinGrip(box, box[0] - 3, box[1] + 5)).toBe(true)
    expect(withinGrip(box, box[0] + 30, box[1] + 5)).toBe(false)
    expect(withinGrip(box, box[0] + 3, box[1] + 30)).toBe(false)
  })

  it('misses the lane below', () => {
    expect(withinGrip(box, box[0] + 3, 160)).toBe(false)
  })
})

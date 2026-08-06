/**
 * The label block every lane carries, and the boxes it hands back.
 *
 * The drawing is not what is asserted here — a canvas is a picture and a picture
 * is not a unit test. What *is* asserted is the arithmetic that makes the block
 * pointable: where each end of the range was measured to, where the autoscale
 * mark goes, which end of the lane the caption belongs at, and when a lane is
 * too short to hold a click target clear of its own resize border. Every one of
 * those is a number, and a number can be wrong silently (spec §8.4).
 *
 * The context is a stub with a ruler in it: one width per character, so a box's
 * expected size is arithmetic rather than a font's opinion.
 */

import { describe, expect, it } from 'vitest'

import { drawLaneLabel, labelEndFor, type LaneLabelStyle } from '@/render/laneLabel'
import type { LaneFrame } from '@/render/lane'

/** Every glyph this ruler knows is this wide. */
const CHAR = 6

/**
 * Enough of a 2D context to be measured into.
 *
 * Only the members the label block touches, and `measureText` is the one that
 * matters: the boxes come back from the same measurement that placed the text,
 * so a ruler that answers deterministically is what makes the boxes assertable.
 */
function stubContext(): CanvasRenderingContext2D {
  const noop = (): void => {}
  return {
    save: noop,
    restore: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
    strokeText: noop,
    translate: noop,
    rotate: noop,
    measureText: (text: string) => ({ width: text.length * CHAR }) as TextMetrics,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'round',
    textAlign: 'left',
    textBaseline: 'middle',
  } as unknown as CanvasRenderingContext2D
}

const STYLE: LaneLabelStyle = {
  nameFont: '10px sans-serif',
  rangeFont: '10px sans-serif',
  swatch: 9,
  nameTop: 8,
  nameLine: 11,
  detailDrop: 11,
  inset: 4,
  hitHeight: 12,
  autoSlot: 13,
  grip: 4,
}

/** A lane on either edge, `thickness` across, with data from 40 to 400. */
function frameOf(orientation: 'bottom' | 'right', thickness: number): LaneFrame {
  return {
    orientation,
    toPixel: (unit) => unit,
    toUnit: (pixel) => pixel,
    domain: [40, 400],
    alongFrom: 40,
    alongTo: 400,
    acrossFrom: 100,
    thickness,
  }
}

const PALETTE = { text: '#111', halo: '#fff' }

function label(
  frame: LaneFrame,
  overrides: Partial<Parameters<typeof drawLaneLabel>[2]> = {},
): ReturnType<typeof drawLaneLabel> {
  return drawLaneLabel(stubContext(), frame, {
    names: [{ id: 'a', text: 'cov', colour: '#f00' }],
    detail: { kind: 'limits', min: 0, max: 100 },
    labelAt: 'near',
    column: null,
    style: STYLE,
    palette: PALETTE,
    ...overrides,
  })
}

describe('the boxes a lane label hands back', () => {
  // The whole reason the block returns anything: a range that is only drawn is
  // a range a reader cannot put a caret in, which is what the two numbers beside
  // a map were before this existed.
  it('measures each end of the range into its own box', () => {
    const boxes = label(frameOf('bottom', 60))
    expect(boxes.limits.map((limit) => limit.part)).toEqual(['min', 'max'])
    expect(boxes.limits[0].value).toBe('0')
    expect(boxes.limits[1].value).toBe('100')
    // Widths are the ruler's: one character, then three.
    expect(boxes.limits[0].box[2]).toBe(1 * CHAR)
    expect(boxes.limits[1].box[2]).toBe(3 * CHAR)
    // …and `max` sits past `min` and the dash between them.
    expect(boxes.limits[1].box[0]).toBeGreaterThan(boxes.limits[0].box[0] + boxes.limits[0].box[2])
  })

  // The two edges are one implementation, so the right-hand stack's quarter turn
  // has to fall out of the geometry rather than out of a second code path.
  it('turns the boxes a quarter turn on a right-hand lane', () => {
    const bottom = label(frameOf('bottom', 60)).limits[1].box
    const right = label(frameOf('right', 60)).limits[1].box
    // Below the map a box is as wide as its text and as tall as the hit height;
    // beside it the two swap, because the text reads up the lane.
    expect(bottom[2]).toBe(3 * CHAR)
    expect(bottom[3]).toBe(STYLE.hitHeight)
    expect(right[2]).toBe(STYLE.hitHeight)
    expect(right[3]).toBe(3 * CHAR)
    // And it advances the other way: `max` starts at a smaller `along` than the
    // run before it, because a right-hand lane reads upward.
    const run = label(frameOf('right', 60)).limits
    expect(run[1].box[1]).toBeLessThan(run[0].box[1])
  })

  it('puts the autoscale mark just past the number it resets', () => {
    const boxes = label(frameOf('bottom', 60))
    const last = boxes.limits[1].box
    expect(boxes.auto).not.toBeNull()
    expect(boxes.auto?.x).toBeGreaterThan(last[0] + last[2])
  })

  // A lane too short to hold both keeps the *gesture* and gives up the caret:
  // the canvas draws the resize rule there, promising a drag, and a press that
  // opened a text box instead would be worse than either.
  it('gives up the click targets rather than overlap the resize border', () => {
    expect(label(frameOf('bottom', 60)).limits).toHaveLength(2)
    expect(label(frameOf('bottom', 14)).limits).toHaveLength(0)
    // Still drawn, though — only the boxes are withheld.
    expect(label(frameOf('bottom', 14)).nameAcross).toBe(STYLE.nameTop)
  })

  it('reports one chip per name, before the name it belongs to', () => {
    const boxes = label(frameOf('bottom', 60), {
      names: [
        { id: 'a', text: 'fwd', colour: '#f00' },
        { id: 'b', text: 'rev', colour: '#00f' },
      ],
    })
    expect(boxes.swatches.map((swatch) => swatch.id)).toEqual(['a', 'b'])
    expect(boxes.swatches[0].box[2]).toBe(STYLE.swatch)
    expect(boxes.swatches[1].box[0]).toBeGreaterThan(boxes.swatches[0].box[0])
  })

  // A phrase is not a pair, and only a pair is editable: "412 in view" under a
  // gene model is a fact, not an axis.
  it('offers no boxes for a lane whose detail is a phrase', () => {
    const boxes = label(frameOf('bottom', 60), { detail: { kind: 'text', text: '412 in view' } })
    expect(boxes.limits).toEqual([])
    expect(boxes.auto).toBeNull()
  })
})

/**
 * The name is the other thing on a lane a reader changes, so it is measured and
 * reported exactly as the range is. Everything asserted here is the arithmetic
 * that decides where the caret lands when the name is clicked.
 */
describe('the name boxes a lane label hands back', () => {
  it('measures the name into a box that starts past its colour chip', () => {
    const boxes = label(frameOf('bottom', 60))
    expect(boxes.names).toHaveLength(1)
    expect(boxes.names[0].id).toBe('a')
    expect(boxes.names[0].text).toBe('cov')
    // The ruler's: three characters. `swatchRoom` is the chip plus five.
    expect(boxes.names[0].box[2]).toBe(3 * CHAR)
    expect(boxes.names[0].box[3]).toBe(STYLE.hitHeight)
    expect(boxes.names[0].box[0]).toBe(40 + STYLE.inset + STYLE.swatch + 5)
    expect(boxes.names[0].box[1]).toBe(100 + STYLE.nameTop - STYLE.hitHeight / 2)
  })

  // A caret sized by a second opinion about the font is a caret that moves the
  // text it opens over, which is the one thing the whole arrangement prevents.
  it('carries the font the name was measured in', () => {
    expect(label(frameOf('bottom', 60)).names[0].font).toBe(STYLE.nameFont)
  })

  // An overlaid lane is several tracks under one axis, so the range belongs to
  // the lane and the names belong to the tracks. One box each is what keeps a
  // rename on the one that was pointed at.
  it('reports one box per name in an overlaid lane', () => {
    const boxes = label(frameOf('bottom', 60), {
      names: [
        { id: 'a', text: 'fwd', colour: '#f00' },
        { id: 'b', text: 'rev', colour: '#00f' },
      ],
    })
    expect(boxes.names.map((name) => name.id)).toEqual(['a', 'b'])
    // The second starts past the first, its gap, and its own chip.
    expect(boxes.names[1].box[0]).toBe(
      boxes.names[0].box[0] + boxes.names[0].box[2] + 12 + STYLE.swatch + 5,
    )
  })

  // The quarter turn falls out of `laneRect`, as it does for the limits — and
  // `along` is what stays in reading order on both edges, which is the reason it
  // is reported at all: an input's width is a width whichever way the lane runs.
  it('turns a quarter turn on a right-hand lane, but keeps its reading length', () => {
    const bottom = label(frameOf('bottom', 60)).names[0]
    const right = label(frameOf('right', 60)).names[0]
    expect(bottom.box[2]).toBe(3 * CHAR)
    expect(bottom.box[3]).toBe(STYLE.hitHeight)
    expect(right.box[2]).toBe(STYLE.hitHeight)
    expect(right.box[3]).toBe(3 * CHAR)
    expect(bottom.along).toBe(3 * CHAR)
    expect(right.along).toBe(3 * CHAR)
  })

  // The twin of the limits' rule, and the same trade: a lane too short to hold a
  // click target clear of its resize border keeps the drag and gives up the
  // caret. The name is still drawn.
  it('gives up the caret rather than overlap the resize border', () => {
    expect(label(frameOf('bottom', 60)).names).toHaveLength(1)
    expect(label(frameOf('bottom', 10)).names).toHaveLength(0)
  })
})

describe('which end of a lane the caption belongs at', () => {
  // The rule is one rule — the end farthest from the baseline — and the four
  // answers it gives are not two pairs: a bottom lane's zero is at its floor
  // while a right-hand lane's is at the edge nearest the map, so the flip
  // reverses each of them independently.
  it('follows the baseline on both edges', () => {
    const bottom = frameOf('bottom', 60)
    const right = frameOf('right', 60)
    const limits = { min: 0, max: 100 }
    expect(labelEndFor(bottom, limits, false)).toBe('near')
    expect(labelEndFor(bottom, limits, true)).toBe('far')
    expect(labelEndFor(right, limits, false)).toBe('far')
    expect(labelEndFor(right, limits, true)).toBe('near')
  })

  // A signed track's baseline is inside the lane rather than at an edge, so the
  // caption goes to whichever half of it the zero line is not in.
  it('reads a signed track from where its zero actually falls', () => {
    const frame = frameOf('bottom', 60)
    // Mostly negative: zero sits near the top, so the caption goes to the floor.
    expect(labelEndFor(frame, { min: -100, max: 10 }, false)).toBe('far')
    // Mostly positive: zero sits near the floor, and the caption stays up top.
    expect(labelEndFor(frame, { min: -10, max: 100 }, false)).toBe('near')
  })

  // A flipped track used to lose its caret: the block was measured back by the
  // name's own inset, which is smaller than the resize border plus half a hit
  // box, so the range landed inside the grip and no box was recorded.
  it('keeps the click targets clear of the border at the far end too', () => {
    const boxes = label(frameOf('bottom', 60), { labelAt: 'far' })
    expect(boxes.limits).toHaveLength(2)
    // …and it really is at the other end of the lane.
    expect(boxes.nameAcross).toBeGreaterThan(30)
  })
})

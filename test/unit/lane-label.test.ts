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

import { NAME_CUT, drawLaneLabel, fitName, labelEndFor, type LaneLabelStyle } from '@/render/laneLabel'
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

/**
 * A name too long for the column it is in.
 *
 * The column is measured from the names, so this only happens once a reader has
 * *pinned* it — which they do because one long name was making a column three
 * others did not need. Wrapping and cutting are what that press has to buy, or
 * the name simply runs out over the data it belongs to.
 *
 * The ruler is six pixels a character, so every width here is arithmetic.
 */
describe('fitting a name into a column', () => {
  const measure = (text: string): number => text.length * CHAR

  it('leaves a name that fits alone', () => {
    expect(fitName(measure, 'cov', 10 * CHAR, 2)).toEqual(['cov'])
  })

  // At a word, not at the last character that fits: a name split as
  // `Yeast_ChIP_Pol2-vs-` / `input` is one line of name and one of remainder.
  it('breaks at the separator nearest the middle, and drops it', () => {
    expect(fitName(measure, 'Yeast_input', 8 * CHAR, 2)).toEqual(['Yeast', 'input'])
  })

  it('breaks at a camel-case seam when there is no punctuation', () => {
    expect(fitName(measure, 'YeastChIPInput', 8 * CHAR, 2)).toEqual(['YeastCh', 'IPInput'])
  })

  // …but never in preference to one. A separator is where the writer said a part
  // ends; a case change is this module guessing at one.
  it('prefers a separator to a case change nearer the middle', () => {
    expect(fitName(measure, 'Yeast_ChIP_input', 10 * CHAR, 2)).toEqual(['Yeast', 'ChIP_input'])
  })

  // A name with no seam at all still has to become two lines rather than one
  // line and an overflow.
  it('splits between characters when there is nowhere better', () => {
    const lines = fitName(measure, 'AAAAAAAAAAAA', 8 * CHAR, 2)
    expect(lines).toHaveLength(2)
    expect(lines.join('')).toBe('AAAAAAAAAAAA')
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(8 * CHAR)
  })

  // The ends are where the information is: a run of tracks from one experiment
  // share their beginnings, and a truncation from the right leaves eight
  // identical rows.
  it('cuts the middle when even two lines will not hold it', () => {
    const [line] = fitName(measure, 'Yeast_ChIP_Pol2_vs_input_rep1', 6 * CHAR, 1)
    expect(line).toContain(NAME_CUT)
    expect(line.startsWith('Y')).toBe(true)
    expect(line.endsWith('1')).toBe(true)
    expect(measure(line)).toBeLessThanOrEqual(6 * CHAR)
  })

  it('never gives back an empty line', () => {
    for (const line of fitName(measure, 'Yeast_ChIP_input', 2 * CHAR, 2)) {
      expect(line.length).toBeGreaterThan(0)
    }
  })
})

describe('a long name in a narrow column', () => {
  const column = { start: 40, end: 40 + 14 * CHAR, pad: 8, nameLines: 2 }
  const long = 'Yeast_ChIP_input'
  const wrapped = (thickness: number, nameLines = 2): ReturnType<typeof drawLaneLabel> =>
    label(frameOf('bottom', thickness), {
      names: [{ id: 'a', text: long, colour: '#f00' }],
      column: { ...column, nameLines },
    })

  it('writes it on two lines and reports one box per line', () => {
    const boxes = wrapped(60)
    expect(boxes.names.length).toBe(2)
    // Both boxes belong to the same track, and both carry the *whole* name —
    // a caret over a cut name has to open on the name, not on the cut.
    expect(boxes.names.every((name) => name.id === 'a' && name.text === long)).toBe(true)
    // …on two different lines, one `nameLine` apart.
    expect(boxes.names[1].box[1] - boxes.names[0].box[1]).toBe(STYLE.nameLine)
  })

  // The anti-oscillation rule, and the reason it is asserted rather than
  // commented: `wantGutter` is measured last frame and applied this one, so a
  // wrapped width fed back would shrink the column, un-wrap the name, grow the
  // column, and wrap it again — every frame, for ever.
  it('still reports the width the unwrapped name would want', () => {
    const natural = STYLE.swatch + 5 + long.length * CHAR + column.pad
    expect(wrapped(60).wanted).toBe(natural)
  })

  // A lane dragged short has no room for a second line, so it loses the
  // *layout* rather than the fact: one line, cut in the middle.
  it('falls back to one cut line on a lane too short for two', () => {
    const boxes = wrapped(22)
    expect(boxes.names).toHaveLength(1)
  })

  // The map's lane stacks pass no column at all, and nothing about them moves.
  it('leaves a lane with no column exactly as it was', () => {
    const boxes = label(frameOf('bottom', 60), {
      names: [{ id: 'a', text: long, colour: '#f00' }],
    })
    expect(boxes.names).toHaveLength(1)
    expect(boxes.names[0].along).toBe(long.length * CHAR)
  })
})

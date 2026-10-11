/**
 * What a dragged box resolves to.
 *
 * One block *per axis*, each clamped to itself. On the diagonal the two agree
 * and the answer is a region; in the trans corner they do not, and the answer
 * is the rectangle between them — which is the picture a box drawn there was
 * asking about, and the one thing a single chromosome cannot express.
 *
 * Asserted through `axisRegion` and `bpWithin`, the arithmetic the panel uses,
 * because the panel itself needs a canvas and this suite runs in Node. The
 * clamping is expressed the way the panel expresses it, so a change to one
 * without the other shows up here.
 */

import { describe, expect, it } from 'vitest'

import { bpWithin } from '@/ui/blockAxes'
import { axisRegion, onDiagonal, spanText, type SelectedAxis } from '@/ui/mapSelection'
import type { Cell } from '@/render/heatmap'
import type { AxisGroup } from '@/worker/protocol'

const BIN = 1000


/** Chromosome II of a whole-genome block: bins 100–350, starting at its own 0. */
const II: AxisGroup = { label: 'II', start: 100, end: 350, unitStart: 100 }

/** The panel's per-axis rule, in one place, over a block that starts at bin 0. */
function resolve(group: AxisGroup, span: [number, number], blockStart = 0): SelectedAxis | null {
  const lo = Math.max(span[0], group.start)
  const hi = Math.min(span[1], group.end)
  if (!(hi > lo)) return null
  const raw = bpWithin(group, hi, blockStart, BIN)
  return {
    label: group.label,
    range: [
      Math.max(0, bpWithin(group, lo, blockStart, BIN)),
      group.unitLength === undefined ? raw : Math.min(raw, group.unitLength),
    ],
  }
}

describe('a box inside one chromosome', () => {
  it('is that chromosome, and the base pairs the box covers', () => {
    const selection = resolve(II, [150, 200])
    expect(selection).not.toBeNull()
    expect(axisRegion(selection as SelectedAxis)).toBe('II:50000-100000')
  })

  it('measures from the chromosome, not from the left edge of the picture', () => {
    // Bin 150 is 50 kb into chromosome II and 150 kb into the block. The second
    // number is the one a reader would never recognise.
    expect(bpWithin(II, 150, 0, BIN)).toBe(50_000)
  })
})

describe('a box that runs past the end', () => {
  it('stops at the chromosome boundary rather than spilling into the next', () => {
    // Dragged from the middle of II well into III: the region ends where II
    // does, because the alternative is a range that names something untrue.
    const selection = resolve(II, [300, 600])
    expect(axisRegion(selection as SelectedAxis)).toBe('II:200000-250000')
  })

  it('stops at the start too, for a drag that began late and reached back', () => {
    const selection = resolve(II, [0, 150])
    expect(axisRegion(selection as SelectedAxis)).toBe('II:0-50000')
  })

  it('is nothing when the box and the block do not overlap at all', () => {
    expect(resolve(II, [400, 500])).toBeNull()
  })
})

describe('axisRegion', () => {
  it('writes the region grammar, so the result pastes back into the box', () => {
    expect(axisRegion({ label: 'NODE_7', range: [1234.6, 5678.2] })).toBe('NODE_7:1235-5678')
  })

  it('is the block name alone above bin level, where a cell is a whole unit', () => {
    expect(axisRegion({ label: 'MAG_1' })).toBe('MAG_1')
  })
})

describe('the trans corner', () => {
  /** Chromosome III, after II: bins 350-500, its own coordinates from 0. */
  const III: AxisGroup = { label: 'III', start: 350, end: 500, unitStart: 350 }

  it('names both sequences, each clamped to itself', () => {
    // A box begun in the II x III corner: rows in II, columns in III. Answering
    // with either one alone throws away the half that made it interesting.
    const rows = resolve(II, [200, 300])
    const cols = resolve(III, [380, 460])
    expect(axisRegion(rows as SelectedAxis)).toBe('II:100000-200000')
    expect(axisRegion(cols as SelectedAxis)).toBe('III:30000-110000')
  })

  it('clamps each axis to its own block, not to the other', () => {
    // The same box, overrunning both ways: each side stops at its own edge.
    const rows = resolve(II, [0, 600])
    const cols = resolve(III, [0, 600])
    expect(axisRegion(rows as SelectedAxis)).toBe('II:0-250000')
    expect(axisRegion(cols as SelectedAxis)).toBe('III:0-150000')
  })
})

describe('the end of a sequence', () => {
  it('stops at the contig length, which the bins overshoot', () => {
    // The last bin of a contig is a short one, so `bins * binsize` runs past the
    // sequence: 546 kb of bins over a 545,940 bp chromosome. The region built
    // from the bin arithmetic alone is refused as out of bounds by the reader,
    // which is how a selection came to open an error screen.
    const VII: AxisGroup = { label: 'VII', start: 0, end: 546, unitStart: 0, unitLength: 545_940 }
    expect(axisRegion(resolve(VII, [46, 546]) as SelectedAxis)).toBe('VII:46000-545940')
  })
})

describe('on the diagonal, or not', () => {
  const anchor: Cell = { row: 0, col: 0, rowBin: 0, colBin: 0, value: 0 }
  const box = (rows: [number, number], cols: [number, number]) => ({ rows, cols, anchor })

  it('is the diagonal when both axes cover the same stretch', () => {
    expect(onDiagonal(box([100, 200], [100, 200]))).toBe(true)
  })

  it('tolerates a bin of skew, which a square in *pixels* can produce', () => {
    // The marquee is square on screen; each axis converts those pixels through
    // its own scale, so a plot whose gutters differ by a pixel gives ranges a
    // cell apart. Without the slack, every diagonal drag opened a rectangle.
    expect(onDiagonal(box([100, 200], [101, 201]))).toBe(true)
    expect(onDiagonal(box([100, 200], [100, 201]))).toBe(true)
  })

  it('is not the diagonal for a box above it, in the same contig', () => {
    // The bug this rule replaced: same block on both axes was taken to mean
    // "one region", so a box in the top-right corner of a chromosome opened a
    // square centred on the diagonal — the one place the reader was not looking.
    expect(onDiagonal(box([100, 200], [400, 500]))).toBe(false)
  })

  it('is not the diagonal for a box that merely overlaps it', () => {
    expect(onDiagonal(box([100, 200], [150, 250]))).toBe(false)
  })
})

/**
 * The numbers written beside a box while it is being dragged.
 *
 * A marquee that zooms to itself is only as good as a reader's ability to put
 * its edges where they mean to, and the shaded square says nothing at all about
 * where they are. What is pinned here is that the chips speak the *reader's*
 * dialect — 1-based positions and a width — while `axisRegion` beside them keeps
 * speaking the region box's, half-open and separator-free.
 */
describe('the chips on a dragged box', () => {
  it('writes both ends as positions, and the width between them', () => {
    const axis = resolve(II, [150, 200])
    expect(axis).not.toBeNull()
    expect(spanText(axis!)).toEqual({
      start: 'II:50,001',
      end: 'II:100,000',
      span: '50.0 kb',
    })
  })

  // The same axis, the other dialect: what a reader reads is not what the box
  // takes, and the two are deliberately a base apart.
  it('is not the region string, and the difference is the base', () => {
    const axis = resolve(II, [150, 200])!
    expect(axisRegion(axis)).toBe('II:50000-100000')
    expect(spanText(axis).start).toBe('II:50,001')
  })

  // The last bin of a contig is usually short, so the bin arithmetic overruns
  // the sequence. The chip has to say the clamped end, or a reader aims at a
  // coordinate the reader itself would refuse.
  it('reports the clamped end at a contig boundary', () => {
    // 546 bins of 1 kb is 546,000 bp against a chromosome of 545,500: the last
    // bin is a short one, and the region built from the raw arithmetic is out
    // of bounds for the very reader that would open it.
    const short: AxisGroup = { label: 'VII', start: 0, end: 546, unitStart: 0, unitLength: 545_500 }
    const axis = resolve(short, [500, 546])!
    expect(spanText(axis).end).toBe('VII:545,500')
  })

  // Above bin level a cell *is* the block, and there is no position inside one.
  it('falls back to the block name where there is no range', () => {
    expect(spanText({ label: 'MAG_1' })).toEqual({ start: 'MAG_1', end: 'MAG_1', span: '' })
  })
})

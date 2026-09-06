/**
 * Clicking a read, which is the inverse of drawing one.
 *
 * `readAt` and `drawReads` are two halves of one piece of geometry, and §8.4 is
 * about exactly this: an inverse written independently of the thing it inverts
 * drifts, and it drifts *invisibly* — the card opens, it names a read, and it is
 * the read one row up. So this file asks the same questions of the hit test that
 * a reader asks with a pointer: the row, the extent, the clips, and which of two
 * overlapping reads wins.
 *
 * The lane is built at the four edges rather than only at `bottom`, because
 * `across` runs backwards against the canvas on two of them — which is the bug
 * an inverse written by hand always has.
 */

import { describe, expect, it } from 'vitest'

import { readAt, type PileLayout } from '@/render/alignments'
import { LocusAxis } from '@/render/locus'
import type { LaneFrame } from '@/render/lane'
import type { LaneEdge, ReadPile } from '@/annotations/types'

const ROW = 7
const GAP = 2

/** One contig, one base per unit, so a base pair *is* an axis unit (§5.8). */
const axis = new LocusAxis([
  { contig: 'chrI', unitStart: 0, unitEnd: 2000, bpStart: 0, bpPerUnit: 1, contigLength: 2000 },
])

/** A lane 900 px along and 60 across, over bases 0–900. */
function frameOf(orientation: LaneEdge = 'bottom', acrossFrom = 100): LaneFrame {
  return {
    orientation,
    toPixel: (unit) => unit,
    toUnit: (pixel) => pixel,
    domain: [0, 900],
    alongFrom: 0,
    alongTo: 900,
    acrossFrom,
    thickness: 60,
  }
}

/**
 * The layout a fixture pile stands for.
 *
 * The rows are packed on the main thread now, per view, so the hit test is
 * handed a layout rather than reading `pile.row`. These tests are about the
 * *geometry* of the inverse, so the layout they use is the fixture's own rows.
 */
function layoutOf(pile: ReadPile): PileLayout {
  return { row: Int16Array.from(pile.row), rows: pile.length, placed: pile.length, hidden: 0 }
}

/** Only the fields the hit test reads; the rest of a pile is not its business. */
function pileOf(
  reads: Array<{ start: number; end: number; row: number; clipStart?: number; clipEnd?: number }>,
): ReadPile {
  const n = reads.length
  return {
    contig: 'chrI',
    start: 0,
    end: 2000,
    length: n,
    refStart: Int32Array.from(reads.map((read) => read.start)),
    refEnd: Int32Array.from(reads.map((read) => read.end)),
    clipStart: Int32Array.from(reads.map((read) => read.clipStart ?? 0)),
    clipEnd: Int32Array.from(reads.map((read) => read.clipEnd ?? 0)),
    row: Int16Array.from(reads.map((read) => read.row)),
    flags: new Uint16Array(n),
    mapq: new Uint8Array(n),
    mateContig: new Int32Array(n).fill(-1),
    matePos: new Int32Array(n).fill(-1),
    tlen: new Int32Array(n),
    group: new Uint8Array(n),
    mate: new Int32Array(n).fill(-1),
    opAt: new Int32Array(n + 1),
    opCode: new Uint8Array(0),
    opLen: new Int32Array(0),
    diffAt: new Int32Array(n + 1),
    diffPos: new Int32Array(0),
    diffBase: new Uint8Array(0),
    contigs: ['chrI'],
    groups: ['reads'],
    names: reads.map((_, i) => `r${i}`),
  }
}

describe('finding the read under a point', () => {
  const pile = pileOf([
    { start: 100, end: 200, row: 0 },
    { start: 300, end: 400, row: 0 },
    { start: 100, end: 200, row: 1 },
  ])
  const frame = frameOf()

  it('finds the one whose extent contains the point, on its own row', () => {
    // Row 0 spans `across` 0–7 and row 1 spans 9–16; on a bottom lane `across`
    // grows downwards from `acrossFrom`.
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 150, 103)).toBe(0)
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 350, 103)).toBe(1)
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 150, 112)).toBe(2)
  })

  it('misses between two reads on one row', () => {
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 250, 103)).toBeNull()
  })

  it('misses outside the lane', () => {
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 150, 99)).toBeNull()
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 150, 400)).toBeNull()
  })

  it('gives the gap under a row to that row, so a dense pile stays clickable', () => {
    // `across` 8 is the two-pixel gap below row 0. A pointer is not accurate to
    // two pixels, and treating it as a miss makes every third click do nothing.
    expect(readAt(frame, axis, pile, layoutOf(pile), ROW, GAP, 150, 108)).toBe(0)
  })

  it('includes the soft clips, which are drawn and are part of the read', () => {
    const clipped = pileOf([{ start: 500, end: 600, row: 0, clipStart: 20, clipEnd: 30 }])
    expect(readAt(frame, axis, clipped, layoutOf(clipped), ROW, GAP, 485, 103)).toBe(0)
    expect(readAt(frame, axis, clipped, layoutOf(clipped), ROW, GAP, 625, 103)).toBe(0)
    expect(readAt(frame, axis, clipped, layoutOf(clipped), ROW, GAP, 700, 103)).toBeNull()
  })

  it('takes the last of two that overlap, which is the one drawn on top', () => {
    const stacked = pileOf([
      { start: 100, end: 300, row: 0 },
      { start: 200, end: 400, row: 0 },
    ])
    expect(readAt(frame, axis, stacked, layoutOf(stacked), ROW, GAP, 250, 103)).toBe(1)
  })

  it('ignores the name column, which the paint is clipped out of', () => {
    // A lane starts at `alongFrom`, not at the canvas edge: everything to the
    // left is the name column, whose documented answer to a click is "reveal
    // this track". `clipLane` keeps the paint out of it; an inverse written
    // without the same bound answers there, and the reads it answers with are
    // the ones fetched a whole view-width off the left edge (`FETCH_PAD`), so
    // they are not merely off-lane, they are off-screen.
    const gutter = { ...frame, alongFrom: 150, alongTo: 900 }
    const pile = pileOf([{ start: 100, end: 800, row: 0 }])
    expect(readAt(gutter, axis, pile, layoutOf(pile), ROW, GAP, 400, 103)).toBe(0)
    expect(readAt(gutter, axis, pile, layoutOf(pile), ROW, GAP, 149, 103)).toBeNull()
    expect(readAt(gutter, axis, pile, layoutOf(pile), ROW, GAP, 20, 103)).toBeNull()
    // …and the far edge too, for a lane that does not run to the canvas end.
    const short = { ...frame, alongFrom: 0, alongTo: 500 }
    expect(readAt(short, axis, pile, layoutOf(pile), ROW, GAP, 400, 103)).toBe(0)
    expect(readAt(short, axis, pile, layoutOf(pile), ROW, GAP, 600, 103)).toBeNull()
  })

  it('ignores the strip below the last drawn row', () => {
    // The band is 60 and a row is 9, so `drawReads` draws six rows and leaves
    // six pixels empty at the bottom. A read packed into row 6 was fetched (the
    // budget is quantised upward) and is not on the screen — opening a card for
    // it is the one way a hit test can be wrong and look right.
    const below = pileOf([{ start: 100, end: 200, row: 6 }])
    expect(readAt(frame, axis, below, layoutOf(below), ROW, GAP, 150, 100 + 57)).toBeNull()
    // …and the last row that *is* drawn still answers.
    const last = pileOf([{ start: 100, end: 200, row: 5 }])
    expect(readAt(frame, axis, last, layoutOf(last), ROW, GAP, 150, 100 + 48)).toBe(0)
  })

  it('says nothing about a contig the axis has never heard of', () => {
    const elsewhere = { ...pileOf([{ start: 100, end: 200, row: 0 }]), contig: 'chrZ' }
    expect(readAt(frame, axis, elsewhere, layoutOf(elsewhere), ROW, GAP, 150, 103)).toBeNull()
  })
})

describe('at every edge', () => {
  const pile = pileOf([{ start: 100, end: 200, row: 1 }])

  it('reads `across` in the lane’s own direction, not the canvas’s', () => {
    // A top lane grows *upwards* from its own edge, so the second row is at a
    // smaller canvas y than the first. An inverse that forgot that would land
    // every click on the mirrored row and never say so.
    const top = frameOf('top', 100)
    expect(readAt(top, axis, pile, layoutOf(pile), ROW, GAP, 150, 100 - 12)).toBe(0)
    expect(readAt(top, axis, pile, layoutOf(pile), ROW, GAP, 150, 100 + 12)).toBeNull()

    const bottom = frameOf('bottom', 100)
    expect(readAt(bottom, axis, pile, layoutOf(pile), ROW, GAP, 150, 100 + 12)).toBe(0)
    expect(readAt(bottom, axis, pile, layoutOf(pile), ROW, GAP, 150, 100 - 12)).toBeNull()
  })

  it('reads `along` down the other axis on a vertical lane', () => {
    // Beside a map's rows the lane runs down the screen: the genomic coordinate
    // is `y` and the row is `x`.
    const left = frameOf('left', 100)
    expect(readAt(left, axis, pile, layoutOf(pile), ROW, GAP, 100 - 12, 150)).toBe(0)
    const right = frameOf('right', 100)
    expect(readAt(right, axis, pile, layoutOf(pile), ROW, GAP, 100 + 12, 150)).toBe(0)
  })
})

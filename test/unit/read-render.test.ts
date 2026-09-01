/**
 * What the pile actually puts on the page.
 *
 * A read is a rectangle only when nothing happened to it, and everything a
 * reader is looking for is an exception: a deletion is a rule through a gap
 * because the read spans it, a spliced gap is a thinner rule because the read
 * says nothing about what it skipped, an insertion is a tick between two bases
 * with no width of its own, and a supplementary alignment is outlined because
 * it is one piece of a molecule rather than a read of its own.
 *
 * Each of those is a different call, and getting one wrong draws a picture that
 * is *plausible* — an RNA-seq gene as a solid block, a chimera as an ordinary
 * read — which is why they are asserted here rather than left to the eye.
 *
 * Through a recording context rather than a canvas: what is being checked is
 * which drawing calls were made over which rectangle, and that is exactly what
 * a record of the calls says. Pixels are checked by eye; this is the part that
 * can be wrong without looking wrong.
 */

import { describe, expect, it } from 'vitest'

import {
  BAND_GAP,
  COVERAGE_BAND,
  NAME_BAND,
  alignmentBands,
  consensusBandFor,
  drawReads,
  readRungFor,
  rowsFor,
  type ReadPaint,
} from '@/render/alignments'
import { LocusAxis } from '@/render/locus'
import type { LaneFrame } from '@/render/lane'
import type { ReadPile } from '@/annotations/types'

interface Call {
  op: string
  args: number[]
  stroke: string
  fill: string
  width: number
  alpha: number
}

/** A context that records the subset `drawReads` draws through. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  const state = { strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, globalAlpha: 1 }
  const stack: Array<typeof state> = []
  const note = (op: string, ...args: number[]): void => {
    calls.push({
      op,
      args,
      stroke: String(state.strokeStyle),
      fill: String(state.fillStyle),
      width: state.lineWidth,
      alpha: state.globalAlpha,
    })
  }
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
    textAlign: '',
    textBaseline: '',
    save: () => { stack.push({ ...state }) },
    restore: () => { Object.assign(state, stack.pop() ?? state) },
    fillRect: (x: number, y: number, w: number, h: number) => note('fillRect', x, y, w, h),
    strokeRect: (x: number, y: number, w: number, h: number) => note('strokeRect', x, y, w, h),
    beginPath: () => {},
    moveTo: (x: number, y: number) => note('moveTo', x, y),
    lineTo: (x: number, y: number) => note('lineTo', x, y),
    stroke: () => note('stroke'),
    fillText: (_text: string, x: number, y: number) => note('fillText', x, y),
    measureText: () => ({ width: 6, actualBoundingBoxAscent: 7 }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const axis = new LocusAxis([
  { contig: 'chrI', unitStart: 0, unitEnd: 4000, bpStart: 0, bpPerUnit: 1, contigLength: 4000 },
])

const frame: LaneFrame = {
  orientation: 'bottom',
  toPixel: (unit) => unit,
  toUnit: (pixel) => pixel,
  domain: [0, 900],
  alongFrom: 0,
  alongTo: 900,
  acrossFrom: 0,
  thickness: 100,
}

const paint: ReadPaint = {
  colours: ['#0072b2'],
  rowHeight: 7,
  rowGap: 2,
  pairs: true,
  diffs: false,
  opacity: 1,
  font: '10px sans-serif',
  guideColour: '#333333',
}

interface Spec {
  start: number
  ops: Array<[number, number]>
  row?: number
  flags?: number
  mate?: number
  matePos?: number
  clipStart?: number
  clipEnd?: number
}

function pileOf(reads: Spec[]): ReadPile {
  const n = reads.length
  const opCount = reads.reduce((sum, read) => sum + read.ops.length, 0)
  const pile: ReadPile = {
    contig: 'chrI',
    start: 0,
    end: 4000,
    length: n,
    refStart: new Int32Array(n),
    refEnd: new Int32Array(n),
    clipStart: Int32Array.from(reads.map((read) => read.clipStart ?? 0)),
    clipEnd: Int32Array.from(reads.map((read) => read.clipEnd ?? 0)),
    row: Int16Array.from(reads.map((read, i) => read.row ?? i)),
    flags: Uint16Array.from(reads.map((read) => read.flags ?? 0)),
    mapq: new Uint8Array(n).fill(60),
    mateContig: new Int32Array(n).fill(-1),
    matePos: Int32Array.from(reads.map((read) => read.matePos ?? -1)),
    tlen: new Int32Array(n),
    group: new Uint8Array(n),
    mate: Int32Array.from(reads.map((read) => read.mate ?? -1)),
    opAt: new Int32Array(n + 1),
    opCode: new Uint8Array(opCount),
    opLen: new Int32Array(opCount),
    diffAt: new Int32Array(n + 1),
    diffPos: new Int32Array(0),
    diffBase: new Uint8Array(0),
    contigs: ['chrI'],
    groups: ['reads'],
    names: [],
  }
  let at = 0
  for (let i = 0; i < n; i++) {
    pile.refStart[i] = reads[i].start
    pile.opAt[i] = at
    let reach = reads[i].start
    for (const [code, length] of reads[i].ops) {
      pile.opCode[at] = code
      pile.opLen[at] = length
      at++
      // `M`, `=`, `X`, `D` and `N` are the ops that move along the reference.
      if (code === 0 || code === 2 || code === 3 || code === 7 || code === 8) reach += length
    }
    pile.refEnd[i] = reach
  }
  pile.opAt[n] = at
  return pile
}

function drawn(pile: ReadPile, over: Partial<ReadPaint> = {}): Call[] {
  const { ctx, calls } = recorder()
  drawReads(ctx, frame, axis, pile, { ...paint, ...over }, 'reads')
  return calls
}

describe('one read', () => {
  it('fills its aligned blocks and nothing between them', () => {
    const calls = drawn(pileOf([{ start: 100, ops: [[0, 50]] }]))
    const fills = calls.filter((call) => call.op === 'fillRect')
    expect(fills).toHaveLength(1)
    expect(fills[0].args.slice(0, 3)).toEqual([100, 0, 50])
  })

  it('rules through a deletion, because the read spans it and says it is absent', () => {
    const calls = drawn(pileOf([{ start: 100, ops: [[0, 20], [2, 30], [0, 20]] }]))
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(2)
    const rules = calls.filter((call) => call.op === 'moveTo')
    expect(rules).toHaveLength(1)
    expect(rules[0].args[0]).toBe(120)
    // Thicker than a spliced gap's: "not there" and "not observed" are two
    // different claims and the picture has to make them two different marks.
    expect(rules[0].width).toBe(1.5)
  })

  it('draws a spliced gap thinner, since the read says nothing about what it skipped', () => {
    const calls = drawn(pileOf([{ start: 100, ops: [[0, 20], [3, 200], [0, 20]] }]))
    const rules = calls.filter((call) => call.op === 'moveTo')
    expect(rules).toHaveLength(1)
    expect(rules[0].width).toBe(0.75)
  })

  it('gives an insertion no width, because it has none on the reference', () => {
    const calls = drawn(pileOf([{ start: 100, ops: [[0, 20], [1, 8], [0, 20]] }]))
    const ticks = calls.filter((call) => call.op === 'moveTo')
    expect(ticks).toHaveLength(1)
    // A tick across the row, at one x: both ends of the line are at base 120.
    const to = calls.find((call) => call.op === 'lineTo')
    expect(ticks[0].args[0]).toBe(120)
    expect(to?.args[0]).toBe(120)
    expect(to?.args[1]).not.toBe(ticks[0].args[1])
  })

  it('draws soft clips outside the extent and faintly', () => {
    const calls = drawn(pileOf([{ start: 100, ops: [[0, 50]], clipStart: 10, clipEnd: 5 }]))
    const fills = calls.filter((call) => call.op === 'fillRect')
    expect(fills).toHaveLength(3)
    const faint = fills.filter((call) => call.alpha < 1)
    expect(faint).toHaveLength(2)
    // Before the aligned start, and after the aligned end.
    expect(faint[0].args[0]).toBe(90)
    expect(faint[1].args[0]).toBe(150)
  })
})

describe('a mismatch', () => {
  /** A read with one disagreement at `at`, carrying the base the read has. */
  function withDiff(at: number, base: number): ReadPile {
    const pile = pileOf([{ start: 100, ops: [[0, 50]] }])
    return {
      ...pile,
      diffAt: Int32Array.of(0, 1),
      diffPos: Int32Array.of(at),
      diffBase: Uint8Array.of(base),
    }
  }

  it('is a column in the base’s own colour, over the read', () => {
    const calls = drawn(withDiff(120, 2), { diffs: true })
    const fills = calls.filter((call) => call.op === 'fillRect')
    // The read, then the column on top of it.
    expect(fills).toHaveLength(2)
    expect(fills[1].args[0]).toBe(120)
    expect(fills[1].fill).not.toBe(fills[0].fill)
  })

  it('is not drawn when the lane has nothing to compare against', () => {
    // `diffs: false` is what a window with no `MD`, no `=`/`X` and no reference
    // comes to. Drawing anything then would be an agreement nobody checked.
    const calls = drawn(withDiff(120, 2), { diffs: false })
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(1)
  })
})

describe('a split read', () => {
  const SUPPLEMENTARY = 0x800

  it('is outlined, and an ordinary read is not', () => {
    const plain = drawn(pileOf([{ start: 100, ops: [[0, 50]] }]))
    expect(plain.filter((call) => call.op === 'strokeRect')).toHaveLength(0)

    const split = drawn(pileOf([{ start: 100, ops: [[0, 50]], flags: SUPPLEMENTARY }]))
    const outline = split.filter((call) => call.op === 'strokeRect')
    expect(outline).toHaveLength(1)
    expect(outline[0].stroke).toBe(paint.guideColour)
    // Around the aligned extent, not around the row.
    expect(outline[0].args[0]).toBeCloseTo(100.5, 6)
    expect(outline[0].args[2]).toBeCloseTo(49, 6)
  })

  it('is still filled like a read, since it is one piece of a real alignment', () => {
    const split = drawn(pileOf([{ start: 100, ops: [[0, 50]], flags: SUPPLEMENTARY }]))
    expect(split.filter((call) => call.op === 'fillRect')).toHaveLength(1)
  })
})

describe('a pair', () => {
  const pair = pileOf([
    { start: 100, ops: [[0, 50]], row: 0, mate: 1 },
    { start: 300, ops: [[0, 50]], row: 0, mate: 0 },
  ])

  it('is joined by a thread when the lane asks for one', () => {
    const calls = drawn(pair)
    // The thread runs from the end of the first to the start of the second,
    // and it is drawn before the reads so no read is under it.
    const thread = calls.find((call) => call.op === 'moveTo')
    expect(thread).toBeDefined()
    expect(thread?.args[0]).toBe(150)
    expect(calls.indexOf(thread as Call)).toBeLessThan(
      calls.findIndex((call) => call.op === 'fillRect'),
    )
  })

  it('is left unjoined when the switch is off', () => {
    const calls = drawn(pair, { pairs: false })
    expect(calls.filter((call) => call.op === 'moveTo')).toHaveLength(0)
    // …and the reads themselves are unaffected.
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(2)
  })
})

describe('the row budget', () => {
  it('draws only the rows the band can hold, and says how many', () => {
    // Eleven rows of nine pixels is ninety-nine; the band is a hundred, so the
    // twelfth read is fetched and simply not drawn.
    const many = pileOf(Array.from({ length: 20 }, (_, i) => ({ start: 100, ops: [[0, 50] as [number, number]], row: i })))
    const { ctx, calls } = recorder()
    const rows = drawReads(ctx, frame, axis, many, paint, 'reads')
    expect(rows).toBe(11)
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(11)
  })

  it('lays the bands out where an independent reading of the rule says', () => {
    // Stated from the constants rather than from `alignmentBands`, because a
    // test built from the function under test moves with it: comparing
    // `rowsFor` to `drawReads` over the same band object passes even if
    // `laneBands` counts the wrong number of gaps, since both sides shift
    // together. Four parts means THREE gaps, and getting that wrong by one is
    // the bug this pins.
    const thickness = 240
    const [name, coverage, consensus, pileBand] = alignmentBands(
      { ...frame, thickness, acrossFrom: 0 },
      'reads',
      true,
    )
    const gaps = 3
    expect(name.thickness).toBe(NAME_BAND)
    expect(coverage.thickness).toBe(COVERAGE_BAND)
    expect(consensus.thickness).toBe(consensusBandFor('reads', { ...frame, thickness }))
    expect(pileBand.thickness).toBeCloseTo(
      thickness - NAME_BAND - COVERAGE_BAND - consensus.thickness - BAND_GAP * gaps,
      6,
    )
    // …and they are laid end to end with one gap between each pair.
    expect(coverage.acrossFrom).toBeCloseTo(name.thickness + BAND_GAP, 6)
    expect(consensus.acrossFrom).toBeCloseTo(coverage.acrossFrom + COVERAGE_BAND + BAND_GAP, 6)
    expect(pileBand.acrossFrom).toBeCloseTo(
      consensus.acrossFrom + consensus.thickness + BAND_GAP,
      6,
    )
    // An unlabelled lane keeps the four-part shape — a zero-thickness strip
    // that still consumes its gap — so every caller can index it the same way.
    const bare = alignmentBands({ ...frame, thickness, acrossFrom: 0 }, 'reads', false)
    expect(bare[0].thickness).toBe(0)
    expect(bare[3].thickness).toBeCloseTo(pileBand.thickness + NAME_BAND, 6)
  })

  it('asks the worker for exactly the rows the band will draw', () => {
    for (const thickness of [120, 160, 200, 240, 241, 242, 300]) {
      for (const labelled of [true, false]) {
        const lane = { ...frame, thickness }
        const band = alignmentBands(lane, 'reads', labelled)[3]
        const { ctx } = recorder()
        const drew = drawReads(ctx, band, axis, pileOf([]), paint, 'reads')
        expect(rowsFor(lane, 'reads', labelled), `${thickness}px, labelled=${labelled}`).toBe(drew)
      }
    }
  })

  it('stops calling itself the reads rung once no read row fits', () => {
    // The fixed bands take about eighty pixels before the first row, so a lane
    // dragged short enough has a pile band that can hold nothing. Answering
    // "reads" there drew an empty lane and still spent a whole BAM window on
    // it, so zooming *in* made the picture disappear. Below that it is a
    // coverage lane — which is what it was one zoom step out.
    const zoomed = { ...frame, domain: [0, 300] as [number, number] }
    expect(readRungFor({ ...zoomed, thickness: 240 }, 'browser', 1, true)).not.toBe('coverage')
    expect(readRungFor({ ...zoomed, thickness: 40 }, 'browser', 1, true)).toBe('coverage')
    expect(readRungFor({ ...zoomed, thickness: 12 }, 'browser', 1, true)).toBe('coverage')
    // Unlabelled, the name strip's thirty pixels come back, so the same lane
    // can hold reads at a thickness where a labelled one cannot.
    const edge = { ...zoomed, thickness: 78 }
    expect(readRungFor(edge, 'browser', 1, true)).toBe('coverage')
    expect(readRungFor(edge, 'browser', 1, false)).not.toBe('coverage')
  })
})

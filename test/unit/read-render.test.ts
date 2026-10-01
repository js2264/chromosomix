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
  NAME_BAND,
  READ_ROW,
  drawReads,
  pileBands,
  packPile,
  readRungFor,
  rowsAcross,
  rowsFor,
  MOD_INK,
  modsNear,
  type PileLayout,
  type ReadPaint,
} from '@/render/alignments'
import type { PairLayout } from '@/annotations/types'
import { LocusAxis } from '@/render/locus'
import { acrossToCanvas, laneOutward } from '@/render/lane'
import type { LaneFrame } from '@/render/lane'
import type { ReadPile } from '@/annotations/types'

interface Call {
  op: string
  args: number[]
  stroke: string
  fill: string
  width: number
  alpha: number
  dash: number[]
}

/** A context that records the subset `drawReads` draws through. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  let dash: number[] = []
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
      dash: [...dash],
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
    setLineDash: (pattern: number[]) => { dash = [...pattern] },
    getLineDash: () => [...dash],
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
  layout: 'pairs',
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

/**
 * The layout for a fixture, packed the way the view packs it.
 *
 * The rows are assigned on the main thread now, over the visible window, so a
 * renderer test that wants a particular row has to say so through the layout
 * rather than through `pile.row`. `packPile` is the real packer; these tests use
 * it so the rows they assert are the rows the application would produce.
 */
function layoutFor(pile: ReadPile, over: Partial<ReadPaint> = {}): PileLayout {
  const rowsDrawn = rowsAcross(frame.thickness, paint.rowHeight, paint.rowGap)
  return packPile(
    [pile],
    axis,
    frame,
    frame.domain[0],
    frame.domain[1],
    over.layout ?? paint.layout,
    rowsDrawn,
  )[0]
}

function drawn(pile: ReadPile, over: Partial<ReadPaint> = {}): Call[] {
  const { ctx, calls } = recorder()
  drawReads(ctx, frame, axis, pile, layoutFor(pile, over), { ...paint, ...over }, 'reads')
  return calls
}

describe('packing the pile for the window on screen', () => {
  /** A pile of plain reads, with mates where a pair is given. */
  function pileWith(
    reads: Array<{ start: number; end: number; mate?: number; clipStart?: number; clipEnd?: number }>,
  ): ReadPile {
    const pile = pileOf(
      reads.map((read) => ({
        start: read.start,
        ops: [[0, read.end - read.start] as [number, number]],
        ...(read.clipStart === undefined ? {} : { clipStart: read.clipStart }),
        ...(read.clipEnd === undefined ? {} : { clipEnd: read.clipEnd }),
      })),
    )
    reads.forEach((read, i) => {
      pile.mate[i] = read.mate ?? -1
    })
    return pile
  }

  const pack = (pile: ReadPile, layout: PairLayout, from = 0, to = 900, rowsDrawn = 100) =>
    packPile([pile], axis, frame, from, to, layout, rowsDrawn)[0]

  it('packs by position, first fit, so a sparse window uses one row', () => {
    const pile = pileWith([
      { start: 100, end: 200 },
      { start: 300, end: 400 },
      { start: 500, end: 600 },
    ])
    const placed = pack(pile, 'reads')
    expect([...placed.row]).toEqual([0, 0, 0])
    expect(placed.rows).toBe(1)
  })

  it('stacks what overlaps', () => {
    const pile = pileWith([
      { start: 100, end: 400 },
      { start: 200, end: 500 },
      { start: 300, end: 600 },
    ])
    expect([...pack(pile, 'reads').row]).toEqual([0, 1, 2])
  })

  it('leaves room for the soft clips it will draw', () => {
    // The clip is drawn outside the aligned extent, so packing on the aligned
    // extent alone puts two reads' clips on top of each other.
    const clipped = pileWith([
      { start: 100, end: 200, clipEnd: 60 },
      { start: 210, end: 300 },
    ])
    expect([...pack(clipped, 'reads').row]).toEqual([0, 1])
    const bare = pileWith([
      { start: 100, end: 200 },
      { start: 210, end: 300 },
    ])
    expect([...pack(bare, 'reads').row]).toEqual([0, 0])
  })

  it('puts both ends of a template on one row, and only in a paired layout', () => {
    // The whole of the reported symptom: packed by position, the two ends of a
    // fragment land on different rows at any real depth, and the thread between
    // them runs from one of them towards a mate that is not there.
    const pile = pileWith([
      { start: 100, end: 200, mate: 1 },
      { start: 400, end: 500, mate: 0 },
      { start: 250, end: 350 },
    ])
    const paired = pack(pile, 'pairs')
    expect(paired.row[0]).toBe(paired.row[1])
    expect(paired.row[2]).not.toBe(paired.row[0])

    // …and unpaired, the middle read takes the gap between them.
    const alone = pack(pile, 'reads')
    expect([...alone.row]).toEqual([0, 0, 0])
  })

  it('packs fragments and pairs identically — they differ only in the ink', () => {
    const pile = pileWith([
      { start: 100, end: 200, mate: 1 },
      { start: 400, end: 500, mate: 0 },
      { start: 250, end: 350 },
    ])
    expect([...pack(pile, 'fragments').row]).toEqual([...pack(pile, 'pairs').row])
  })

  it('leaves out what is off screen, so the rows count what is drawn', () => {
    // The window is fetched three view-widths wide so a pan is free. Packing
    // that whole width would give the visible reads the rows of a picture three
    // times bigger — which is the bug this exists to fix.
    const pile = pileWith([
      { start: 10, end: 90 },
      { start: 400, end: 500 },
      { start: 820, end: 890 },
    ])
    const placed = pack(pile, 'reads', 300, 600)
    expect([...placed.row]).toEqual([-1, 0, -1])
    expect(placed.placed).toBe(1)
    expect(placed.rows).toBe(1)
  })

  it('shares one row space across the piles of one window', () => {
    // A window read as two byte spans comes back as two piles, and each used to
    // number its rows from zero — so drawn into one band they collided and two
    // reads a chunk boundary apart were drawn on top of each other.
    const a = pileWith([{ start: 100, end: 400 }])
    const b = pileWith([{ start: 200, end: 500 }])
    const [first, second] = packPile([a, b], axis, frame, 0, 900, 'reads', 100)
    expect(first.row[0]).toBe(0)
    expect(second.row[0]).toBe(1)
    expect(first.rows).toBe(2)
  })

  it('counts what will not fit, rather than dropping it silently', () => {
    const deep = pileWith(
      Array.from({ length: 12 }, () => ({ start: 100, end: 400 })),
    )
    const placed = pack(deep, 'reads', 0, 900, 5)
    expect(placed.rows).toBe(12)
    expect(placed.placed).toBe(12)
    expect(placed.hidden).toBe(7)
  })

  it('says nothing about a contig the axis has never heard of', () => {
    const elsewhere = { ...pileWith([{ start: 100, end: 200 }]), contig: 'chrZ' }
    const placed = pack(elsewhere, 'reads')
    expect(placed.placed).toBe(0)
    expect([...placed.row]).toEqual([-1])
  })
})

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

describe('a base-modification call', () => {
  /** A read with three calls: a sure 5mC, a sure unmodified C, and a 5hmC. */
  function withMods(): ReadPile {
    const pile = pileOf([{ start: 100, ops: [[0, 50]] }])
    return {
      ...pile,
      diffAt: Int32Array.of(0, 1),
      diffPos: Int32Array.of(110),
      diffBase: Uint8Array.of(3),
      mods: {
        at: Int32Array.of(0, 4),
        pos: Int32Array.of(105, 120, 120, 130),
        code: Uint8Array.of(0, 0, 1, 0),
        prob: Uint8Array.of(250, 5, 200, 140),
        codes: ['m', 'h'],
        counts: [3, 1],
      },
    }
  }
  const modPaint = (threshold: number): Partial<ReadPaint> => ({ diffs: true, mods: { code: 'm', threshold } })

  it('is a column at its base, red when modified and blue when not, of the chosen code only', () => {
    const fills = drawn(withMods(), modPaint(0.5)).filter((call) => call.op === 'fillRect')
    // The read, then the three `m` calls — never the `h` one, nor the mismatch.
    expect(fills).toHaveLength(4)
    expect(fills.slice(1).map((call) => call.fill)).toEqual([MOD_INK.modified, MOD_INK.unmodified, MOD_INK.modified])
    // One base wide is a pixel here, so it is widened to be seen, around its centre.
    expect(fills[1].args[0]).toBeCloseTo(104.5)
    expect(fills[1].args[2]).toBeCloseTo(2)
  })

  it('is as opaque as the caller was sure', () => {
    const fills = drawn(withMods(), modPaint(0.5)).filter((call) => call.op === 'fillRect')
    expect(fills[1].alpha).toBeGreaterThan(0.9)
    expect(fills[3].alpha).toBeLessThan(0.4)
  })

  it('is left out between the threshold and its complement', () => {
    const fills = drawn(withMods(), modPaint(0.8)).filter((call) => call.op === 'fillRect')
    expect(fills).toHaveLength(3)
  })

  it('is found by the readout within reach of the pointer, every code at that base', () => {
    const pile = withMods()
    expect(modsNear(pile, 0, 120.6, 1).map((call) => call.code)).toEqual(['m', 'h'])
    expect(modsNear(pile, 0, 115, 1)).toEqual([])
    // With the drawn code named, that code decides the base and leads the list.
    expect(modsNear(pile, 0, 120.6, 1, 'h').map((call) => call.code)).toEqual(['h', 'm'])
    expect(modsNear(pile, 0, 106, 2, 'h')).toEqual([])
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
    const calls = drawn(pair, { layout: 'reads' })
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
    const rows = drawReads(ctx, frame, axis, many, layoutFor(many), paint, 'reads')
    expect(rows).toBe(11)
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(11)
  })

  it('lays the bands out where an independent reading of the rule says', () => {
    // Stated from the constants rather than from `pileBands`, because a test
    // built from the function under test moves with it: comparing `rowsFor` to
    // `drawReads` over the same band object passes even if `laneBands` counts
    // the wrong number of gaps, since both sides shift together. Two parts
    // means ONE gap.
    const thickness = 180
    const [name, pile] = pileBands({ ...frame, thickness, acrossFrom: 0 }, NAME_BAND)
    expect(name.thickness).toBe(NAME_BAND)
    expect(pile.thickness).toBeCloseTo(thickness - NAME_BAND - BAND_GAP, 6)
    expect(pile.acrossFrom).toBeCloseTo(name.thickness + BAND_GAP, 6)
    // An unlabelled lane keeps the two-part shape — a zero-thickness strip that
    // still consumes its gap — so every caller can index it the same way.
    const bare = pileBands({ ...frame, thickness, acrossFrom: 0 }, 0)
    expect(bare[0].thickness).toBe(0)
    expect(bare[1].thickness).toBeCloseTo(pile.thickness + NAME_BAND, 6)
  })

  it('cuts the same split at every edge', () => {
    // `laneBand` stores `acrossFrom` in *canvas* coordinates while `thickness`
    // is a length, so a band's far edge is `acrossFrom + outward * thickness`
    // and not the sum of the two. The parent's own `acrossFrom` is deliberately
    // non-zero here, because at zero the difference is invisible.
    for (const orientation of ['bottom', 'top', 'left', 'right'] as const) {
      const lane = { ...frame, orientation, acrossFrom: 300, thickness: 180 }
      const [name, pile] = pileBands(lane, NAME_BAND)
      // The pile begins one gap past the name strip and ends on the lane's own
      // floor, whichever way the lane grows.
      expect(name.thickness, orientation).toBe(NAME_BAND)
      expect(pile.acrossFrom, orientation).toBeCloseTo(
        lane.acrossFrom + laneOutward(orientation) * (NAME_BAND + BAND_GAP),
        6,
      )
      const far = pile.acrossFrom + laneOutward(orientation) * pile.thickness
      expect(acrossToCanvas(lane, lane.thickness), orientation).toBeCloseTo(far, 6)
    }
  })

  it('asks the worker for exactly the rows the band will draw', () => {
    for (const thickness of [120, 160, 200, 240, 241, 242, 300]) {
      for (const labelled of [true, false]) {
        const lane = { ...frame, thickness }
        const band = pileBands(lane, labelled ? NAME_BAND : 0)[1]
        const { ctx } = recorder()
        const empty = pileOf([])
        const drew = drawReads(
          ctx,
          band,
          axis,
          empty,
          { row: new Int16Array(0), rows: 0, placed: 0, hidden: 0 },
          paint,
          'reads',
        )
        expect(rowsFor(lane, labelled ? NAME_BAND : 0), `${thickness}px, labelled=${labelled}`).toBe(drew)
      }
    }
  })

  it('draws nothing at all once no read row fits', () => {
    // The name strip and its gap take thirty-three pixels before the first row,
    // so a lane dragged short enough has a pile band that can hold nothing.
    // Answering "reads" there drew an empty lane and still spent a whole BAM
    // window on it, so zooming *in* made the picture disappear. `none` is the
    // honest answer: this lane's only picture is the pile, and the depth over
    // the same reads is the row beside it (§8.13).
    const zoomed = { ...frame, domain: [0, 300] as [number, number] }
    expect(readRungFor({ ...zoomed, thickness: 240 }, 'browser', 1, NAME_BAND)).not.toBe('none')
    expect(readRungFor({ ...zoomed, thickness: 12 }, 'browser', 1, NAME_BAND)).toBe('none')
    // The boundary itself, stated from the constants: the strip and its gap
    // come off the top, and one row plus the gap it does not need under it is
    // `READ_ROW + READ_ROW_GAP` less the gap — nine pixels of band for seven of
    // read. One pixel either side of it, so an off-by-one moves this.
    const fits = NAME_BAND + BAND_GAP + READ_ROW
    expect(readRungFor({ ...zoomed, thickness: fits }, 'browser', 1, NAME_BAND)).not.toBe('none')
    expect(readRungFor({ ...zoomed, thickness: fits - 1 }, 'browser', 1, NAME_BAND)).toBe('none')
    // Unlabelled, the name strip's pixels come back, so the same lane can hold
    // reads at a thickness where a labelled one cannot.
    const edge = { ...zoomed, thickness: fits - 1 }
    expect(readRungFor(edge, 'browser', 1, 0)).not.toBe('none')
  })

  it('draws nothing beside a map, whatever the zoom says', () => {
    // A pile exists only in the 1D browser. Beside a heatmap the finest unit on
    // the axis is a matrix bin, so `basePixels` can read like a browser zoomed
    // right in and there is still nothing for a read to be drawn on — which is
    // exactly why the surface is asked rather than inferred from the number.
    const zoomed = { ...frame, domain: [0, 300] as [number, number], thickness: 240 }
    expect(readRungFor(zoomed, 'browser', 1, NAME_BAND)).not.toBe('none')
    expect(readRungFor(zoomed, 'map', 1, NAME_BAND)).toBe('none')
  })
})

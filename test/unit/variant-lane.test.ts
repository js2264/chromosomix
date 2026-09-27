/**
 * The variant lane's drawing, through the code the browser actually calls.
 *
 * `variant-ink.test.ts` pins the ink *rule*; this pins that the rule is wired
 * to anything. The two were written the other way round at first — an assertion
 * that `VARIANT_MIN_WIDTH >= 3` and nothing at all about the lane — and a check
 * found the gap by deleting each half of the wiring in turn: `colourOf` ignored,
 * the width floor ignored, the whole per-feature ink path removed, and the suite
 * stayed green through all three.
 *
 * So what these do is build a real `FeatureSet` from a real VCF through
 * `parseVcf`, lay it out through `layoutFeatures`, and draw it through
 * `drawFeatures` onto a recording canvas — the same three calls
 * `BrowserView.paintLane` makes. Every claim below is about a rectangle that
 * came out of that, not about a constant.
 */

import { describe, expect, it } from 'vitest'

import { parseVcf } from '@/annotations/vcf'
import type { FeatureSet } from '@/annotations/types'
import { drawFeatures, featureAt, layoutFeatures } from '@/render/features'
import type { LaneFrame } from '@/render/lane'
import { LocusAxis } from '@/render/locus'
import { BASE_COLOURS } from '@/render/sequence'
import { variantInk, VARIANT_MIN_WIDTH } from '@/render/variants'

interface Rect {
  x: number
  w: number
  fill: string
}

/** A canvas that remembers the rectangles it filled, and in what ink. */
function recorder(): { ctx: CanvasRenderingContext2D; filled: Rect[] } {
  const filled: Rect[] = []
  let pending: Array<{ x: number; w: number }> = []
  const state = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1 }
  const stack: Array<typeof state> = []
  const ctx = {
    get fillStyle() { return state.fillStyle },
    set fillStyle(v: string) { state.fillStyle = v },
    get strokeStyle() { return state.strokeStyle },
    set strokeStyle(v: string) { state.strokeStyle = v },
    get lineWidth() { return state.lineWidth },
    set lineWidth(v: number) { state.lineWidth = v },
    get globalAlpha() { return state.globalAlpha },
    set globalAlpha(v: number) { state.globalAlpha = v },
    font: '', textAlign: '', textBaseline: '', lineJoin: '',
    save: () => { stack.push({ ...state }) },
    restore: () => { Object.assign(state, stack.pop() ?? state) },
    beginPath: () => { pending = [] },
    closePath: () => {},
    rect: (x: number, _y: number, w: number) => { pending.push({ x, w }) },
    moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    fillText: () => {}, strokeText: () => {},
    measureText: () => ({ width: 20, actualBoundingBoxAscent: 7 }),
    translate: () => {}, rotate: () => {}, setLineDash: () => {}, getLineDash: () => [],
    fill: () => {
      for (const one of pending) filled.push({ ...one, fill: String(state.fillStyle) })
      pending = []
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, filled }
}

const CONTIG = 'chrV'
const LENGTH = 20_000

function axisOf(): LocusAxis {
  return new LocusAxis([
    { contig: CONTIG, unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

/** A lane `pixels` wide showing `[from, to)` of the contig. */
function frameOf(from: number, to: number, pixels = 1000): LaneFrame {
  const span = to - from
  return {
    orientation: 'bottom',
    toPixel: (unit) => ((unit - from) / span) * pixels,
    toUnit: (pixel) => from + (pixel / pixels) * span,
    domain: [from, to],
    alongFrom: 0,
    alongTo: pixels,
    acrossFrom: 0,
    thickness: 40,
  }
}

const LANE = '#0072b2'

function paintOf(set: FeatureSet): Parameters<typeof drawFeatures>[4] {
  return {
    colour: LANE,
    guideColour: '#333',
    haloColour: '#fff',
    font: '10px sans-serif',
    opacity: 1,
    labels: false,
    outline: false,
    colourOf: (at: number) => variantInk(set.detail[at] ?? '', LANE),
  }
}

const HEADER = `##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n`

function vcf(rows: string[]): FeatureSet {
  return parseVcf(HEADER + rows.map((r) => r.replace(/ +/g, '\t')).join('\n') + '\n')
}

/** Lay out and draw, the way the browser does. */
function drawn(set: FeatureSet, frame: LaneFrame): Rect[] {
  const layout = layoutFeatures(frame, axisOf(), set, 4, VARIANT_MIN_WIDTH)
  const { ctx, filled } = recorder()
  drawFeatures(ctx, frame, set, layout, paintOf(set), 'variants')
  return filled
}

describe('a variant lane, drawn', () => {
  it('paints each record in the ink its own ALT earns', () => {
    // Through the real parser and the real renderer: the detail string
    // `variantInk` reads is the one `parseVcf` wrote, so the two cannot drift.
    const set = vcf([
      'chrV 1000 . A G 60 PASS .',
      'chrV 3000 . A C 60 PASS .',
      'chrV 5000 . G GAA 60 PASS .',
    ])
    const inks = drawn(set, frameOf(0, 8000)).map((r) => r.fill)
    expect(inks).toContain(BASE_COLOURS[2]) // G, orange
    expect(inks).toContain(BASE_COLOURS[1]) // C, blue
    expect(inks).toContain(BASE_COLOURS[4]) // the insertion, grey
    expect(inks).not.toContain(LANE)
  })

  it('draws a single base wide enough to see', () => {
    const set = vcf(['chrV 1000 . A G 60 PASS .'])
    // 8000 bases over 1000 pixels: the record's true extent is an eighth of a
    // pixel. Without the floor it is a hairline.
    const [box] = drawn(set, frameOf(0, 8000))
    expect(box.w).toBeGreaterThanOrEqual(VARIANT_MIN_WIDTH)
  })

  it('draws a structural variant at its own size, not at the floor', () => {
    // The floor is a floor. An 800-base deletion over a 1000-pixel view of
    // 8000 bases is a hundred pixels, and must stay one.
    const set = vcf(['chrV 4000 . N <DEL> 99 PASS SVTYPE=DEL;END=4800'])
    const [box] = drawn(set, frameOf(0, 8000))
    expect(box.w).toBeCloseTo(100, 0)
  })

  it('makes the whole of what it drew clickable', () => {
    // The defect this file was written for. The floor was applied in the paint
    // alone, so a mark was three pixels on screen and an eighth of a pixel to
    // the pointer: two thirds of every variant was dead to hover and to click.
    const set = vcf(['chrV 1000 . A G 60 PASS .'])
    const frame = frameOf(0, 8000)
    const layout = layoutFeatures(frame, axisOf(), set, 4, VARIANT_MIN_WIDTH)
    const [box] = drawn(set, frame)
    // Every pixel the box covers answers, including its far edge.
    for (const x of [box.x, box.x + 1, box.x + box.w - 1]) {
      expect(featureAt(frame, layout, x, 20), `x=${x}`).not.toBeNull()
    }
  })

  it('leaves a peak set exactly as it was', () => {
    // The floor and the per-feature ink are a variant lane's alone. A BED lane
    // passes neither, and must come out in one colour at its true width.
    const set = vcf(['chrV 4000 . N <DEL> 99 PASS SVTYPE=DEL;END=4800'])
    const frame = frameOf(0, 8000)
    const layout = layoutFeatures(frame, axisOf(), set, 4)
    const { ctx, filled } = recorder()
    drawFeatures(ctx, frame, set, layout, { ...paintOf(set), colourOf: undefined }, 'variants')
    expect(filled.every((r) => r.fill === LANE)).toBe(true)
  })

  it('collapses rather than merging a stretch it cannot draw apart', () => {
    // 400 variants over 8000 bases is one every 20 — a quarter of a pixel here,
    // well inside the floor. Drawn individually they merge into one bar in
    // whichever ink went down last, which reads as a single 8 kb variant.
    //
    // Four rows do not rescue it, and that is why the threshold asks about the
    // *strand bands* rather than about the rows the lane has room for: a record
    // set with no strand in it is one band, the packing only reaches for a
    // second row when two features overlap, and these do not overlap — they
    // merely sit a quarter of a pixel apart, all of them in row zero.
    const rows = Array.from({ length: 400 }, (_, i) => `chrV ${1000 + i * 15} . A G 60 PASS .`)
    const layout = layoutFeatures(frameOf(0, 8000), axisOf(), vcf(rows), 4, VARIANT_MIN_WIDTH)
    expect(layout.dense).toBe(true)
    // …and the count it reports is the whole window, which is what the picture
    // can still carry.
    expect(layout.total).toBe(400)
  })
})

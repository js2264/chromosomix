/**
 * How a karyotype and a sample's junctions are drawn (§8.22, §8.23).
 *
 * Both glyphs are paths rather than boxes, so the canvas here records every
 * path it is given — each move, line and curve, with the ink it was filled or
 * stroked in — and every text it writes. The claims are geometric: the
 * chromosome's outline pinches at the centromere and narrows at a stalk; a
 * centromere too narrow to see is widened to a waist that is red across its
 * width; an arc stands between the intron's two ends and peaks at a height set
 * by its count; the two strands of a split lane grow in opposite directions;
 * and a click is answered by the curve under it rather than by a box.
 */

import { describe, expect, it } from 'vitest'

import { parseCytoBand } from '@/annotations/cytoband'
import { parseJunctions } from '@/annotations/junctions'
import type { FeatureSet } from '@/annotations/types'
import {
  drawFeatures,
  featureAt,
  featureCaption,
  featureLayoutFor,
  glyphExtentOf,
  layoutFeatures,
  type FeatureLayout,
  type FeaturePaint,
} from '@/render/features'
import { featureColouring } from '@/render/featureInk'
import { ACEN_COLOUR, ideogramBody, stainColour } from '@/render/ideogram'
import { junctionAt } from '@/render/junctions'
import type { LaneFrame } from '@/render/lane'
import { LocusAxis } from '@/render/locus'

type Point = [number, number]

interface Recorded {
  /** Every point the path passed through, in order: moves, lines, curve ends. */
  points: Point[]
  /** Each curve's control point and end, in order. */
  curves: Array<{ control: Point; end: Point }>
  rects: Array<[number, number, number, number]>
  /** How it was put on the canvas, and in what ink. */
  as: 'fill' | 'stroke' | 'clip'
  ink: string
  width: number
}

interface Written {
  text: string
  x: number
  y: number
  fill: string
}

/** A canvas that keeps its paths and its words. */
function recorder(): { ctx: CanvasRenderingContext2D; paths: Recorded[]; texts: Written[]; filled: Array<{ rect: [number, number, number, number]; fill: string }> } {
  const paths: Recorded[] = []
  const texts: Written[] = []
  const filled: Array<{ rect: [number, number, number, number]; fill: string }> = []
  let current: Omit<Recorded, 'as' | 'ink' | 'width'> = { points: [], curves: [], rects: [] }
  const state = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, tx: 0, ty: 0 }
  const stack: Array<typeof state> = []
  const commit = (as: Recorded['as']): void => {
    paths.push({
      ...current,
      points: [...current.points],
      curves: [...current.curves],
      rects: [...current.rects],
      as,
      ink: as === 'stroke' ? String(state.strokeStyle) : String(state.fillStyle),
      width: state.lineWidth,
    })
  }
  const ctx = {
    get fillStyle() { return state.fillStyle },
    set fillStyle(v: string) { state.fillStyle = v },
    get strokeStyle() { return state.strokeStyle },
    set strokeStyle(v: string) { state.strokeStyle = v },
    get lineWidth() { return state.lineWidth },
    set lineWidth(v: number) { state.lineWidth = v },
    get globalAlpha() { return state.globalAlpha },
    set globalAlpha(v: number) { state.globalAlpha = v },
    font: '', textAlign: '', textBaseline: '', lineJoin: '', lineCap: '',
    save: () => { stack.push({ ...state }) },
    restore: () => { Object.assign(state, stack.pop() ?? state) },
    beginPath: () => { current = { points: [], curves: [], rects: [] } },
    closePath: () => {},
    rect: (x: number, y: number, w: number, h: number) => { current.rects.push([x, y, w, h]) },
    moveTo: (x: number, y: number) => { current.points.push([x, y]) },
    lineTo: (x: number, y: number) => { current.points.push([x, y]) },
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
      current.curves.push({ control: [cx, cy], end: [x, y] })
      current.points.push([x, y])
    },
    fill: () => commit('fill'),
    stroke: () => commit('stroke'),
    clip: () => commit('clip'),
    fillRect: (x: number, y: number, w: number, h: number) => { filled.push({ rect: [x, y, w, h], fill: String(state.fillStyle) }) },
    fillText: (text: string) => { texts.push({ text, x: state.tx, y: state.ty, fill: String(state.fillStyle) }) },
    strokeText: () => {},
    measureText: (text: string) => ({ width: text.length * 5, actualBoundingBoxAscent: 7 }),
    translate: (x: number, y: number) => { state.tx = x; state.ty = y },
    rotate: () => {},
    setLineDash: () => {},
    getLineDash: () => [],
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, paths, texts, filled }
}

/** One sequence, one base a unit, drawn over `pixels` from `from` to `to`. */
function frameOf(from: number, to: number, pixels = 1000, thickness = 30): LaneFrame {
  const span = to - from
  return {
    orientation: 'bottom',
    toPixel: (unit) => ((unit - from) / span) * pixels,
    toUnit: (pixel) => from + (pixel / pixels) * span,
    domain: [from, to],
    alongFrom: 0,
    alongTo: pixels,
    acrossFrom: 0,
    thickness,
  }
}

function axisOf(contig: string, length: number): LocusAxis {
  return new LocusAxis([{ contig, unitStart: 0, unitEnd: length, bpStart: 0, bpPerUnit: 1, contigLength: length }])
}

const PAINT: FeaturePaint = {
  colour: '#0072b2',
  guideColour: '#333333',
  haloColour: '#ffffff',
  font: '10px sans-serif',
  opacity: 1,
  outline: true,
  labels: true,
}

function draw(
  kind: 'ideogram' | 'junctions',
  set: FeatureSet,
  frame: LaneFrame,
  axis: LocusAxis,
  paint: Partial<FeaturePaint> = {},
): { layout: FeatureLayout } & ReturnType<typeof recorder> {
  const rules = featureLayoutFor(kind, frame.thickness, (n) => n)
  const layout = layoutFeatures(frame, axis, set, rules.rows, rules.least, rules.banded)
  const canvas = recorder()
  const ink = featureColouring(set, kind, 'strand', PAINT.colour)
  drawFeatures(canvas.ctx, frame, set, layout, { ...PAINT, colourOf: ink.colourOf, ...paint }, kind)
  return { layout, ...canvas }
}

// ---------------------------------------------------------------------------
// The ideogram
// ---------------------------------------------------------------------------

/** A chromosome 1,000 kb long: two arms, a centromere, a stalk and a gvar band. */
const KARYOTYPE = [
  'chrT\t0\t200000\tp13\tgvar',
  'chrT\t200000\t300000\tp12\tstalk',
  'chrT\t300000\t400000\tp11.2\tgpos50',
  'chrT\t400000\t450000\tp11.1\tacen',
  'chrT\t450000\t500000\tq11.1\tacen',
  'chrT\t500000\t800000\tq12\tgneg',
  'chrT\t800000\t1000000\tq13\tgpos100',
].join('\n')

describe('an ideogram', () => {
  const set = parseCytoBand(KARYOTYPE)
  const axis = axisOf('chrT', 1_000_000)
  const frame = frameOf(0, 1_000_000, 1000, 30)
  const drawn = draw('ideogram', set, frame, axis)
  const outline = drawn.paths.find((path) => path.as === 'stroke' && path.ink === PAINT.guideColour)
  const half = ideogramBody(30) / 2
  const centre = 15

  it('is one outline for the chromosome, clipping every band inside it', () => {
    const clips = drawn.paths.filter((path) => path.as === 'clip')
    expect(clips).toHaveLength(1)
    expect(outline).toBeDefined()
    // Each band a rectangle the height of the body, filled in its stain.
    const fills = drawn.paths.filter((path) => path.as === 'fill')
    const inks = new Set(fills.map((path) => path.ink))
    expect(inks).toContain(stainColour('gpos50'))
    expect(inks).toContain(stainColour('gpos100'))
    expect(inks).toContain(ACEN_COLOUR)
  })

  it('pinches to a waist where the q arm’s first centromeric band begins', () => {
    // The top edge's narrowest point along the centromere is at 450 kb = 450 px.
    const top = outline!.points.filter(([x, y]) => x >= 395 && x <= 505 && y < centre)
    const narrowest = top.reduce((best, point) => (point[1] > best[1] ? point : best))
    expect(narrowest[0]).toBeCloseTo(450, 0)
    expect(centre - narrowest[1]).toBeCloseTo(half * 0.2, 1)
    // …and is full height either side of it.
    expect(top.some(([x, y]) => Math.abs(x - 400) < 0.5 && Math.abs(centre - y - half) < 0.01)).toBe(true)
  })

  it('narrows along a stalk', () => {
    const stalk = outline!.points.filter(([x, y]) => x > 205 && x < 295 && y < centre)
    for (const [, y] of stalk) expect(centre - y).toBeCloseTo(half * 0.5, 5)
  })

  it('rounds the telomeres it can see, and only those', () => {
    // Both ends in view: four curves, two a cap.
    expect(outline!.curves).toHaveLength(4)
    const zoomed = draw('ideogram', set, frameOf(300_000, 700_000), axis)
    const inner = zoomed.paths.find((path) => path.as === 'stroke' && path.ink === PAINT.guideColour)
    expect(inner!.curves).toHaveLength(0)
  })

  it('hatches the variable band with strokes, not a pattern', () => {
    const hatch = drawn.paths.filter((path) => path.as === 'stroke' && path.ink !== PAINT.guideColour)
    expect(hatch.length).toBeGreaterThan(0)
    // Every stroke of it inside the gvar band's 0–200 px.
    for (const [x] of hatch[0].points) expect(x).toBeLessThanOrEqual(200.001)
  })

  it('names the bands that hold their names, and not a centromere', () => {
    const names = drawn.texts.map((text) => text.text)
    expect(names).toContain('q12')
    expect(names).toContain('p13')
    expect(names).not.toContain('p11.1')
    // Light text on a dark band, dark on a light one.
    expect(drawn.texts.find((text) => text.text === 'q13')?.fill).toBe('#ffffff')
    expect(drawn.texts.find((text) => text.text === 'q12')?.fill).toBe('#1c1c1e')
  })

  it('widens a centromere too narrow to see, and paints the width it drew red', () => {
    const yeast = parseCytoBand(
      [
        'IV\t0\t449710\tp\tgneg',
        'IV\t449710\t449766\tp11\tacen',
        'IV\t449766\t449821\tq11\tacen',
        'IV\t449821\t1531933\tq\tgneg',
      ].join('\n'),
    )
    const whole = draw('ideogram', yeast, frameOf(0, 1_531_933), axisOf('IV', 1_531_933))
    const red = whole.filled.filter((fill) => fill.fill === ACEN_COLOUR)
    expect(red).toHaveLength(1)
    expect(red[0].rect[2]).toBeCloseTo(6, 5)
    const edge = whole.paths.find((path) => path.as === 'stroke' && path.ink === PAINT.guideColour)!
    const waist = edge.points.filter(([x, y]) => Math.abs(x - 293.5) < 4 && y < 15)
    // Symmetric: the waist starts three pixels before its pinch and ends three after.
    const xs = waist.map(([x]) => x).sort((a, b) => a - b)
    expect(xs[xs.length - 1] - xs[0]).toBeCloseTo(6, 1)
  })

  it('says in its caption which bands are under the window', () => {
    expect(featureCaption('ideogram', set, draw('ideogram', set, frameOf(810_000, 900_000), axis).layout, 'file', undefined, String, String)).toBe('Tq13')
    expect(featureCaption('ideogram', set, draw('ideogram', set, frameOf(350_000, 600_000), axis).layout, 'file', undefined, String, String)).toBe('Tp11.2 – q12')
  })

  it('keys its stains in UCSC’s order and chips its name in the centromere’s red', () => {
    const ink = featureColouring(set, 'ideogram', 'strand', '#0072b2')
    expect(ink.key.levels.map((level) => level.label)).toEqual([
      'gneg · unstained',
      'gpos50',
      'gpos100',
      'acen · centromere',
      'gvar · variable',
      'stalk',
    ])
    expect(ink.chip).toBe(ACEN_COLOUR)
    // Whatever the picker had stored: a karyotype is coloured by its stains.
    expect(featureColouring(set, 'ideogram', '', '#0072b2').colourOf?.(0)).toBe(stainColour('gvar'))
  })
})

// ---------------------------------------------------------------------------
// The arcs
// ---------------------------------------------------------------------------

/** Three forward introns, nested, and one reverse — STAR's own columns. */
const STAR = [
  'chrJ\t101\t400\t1\t1\t1\t100\t0\t30',
  'chrJ\t101\t700\t1\t1\t1\t25\t0\t30',
  'chrJ\t501\t700\t1\t1\t0\t4\t0\t30',
  'chrJ\t801\t900\t2\t2\t1\t50\t0\t30',
].join('\n')

describe('a lane of junctions', () => {
  const set = parseJunctions(STAR, 'SJ.out.tab')
  const axis = axisOf('chrJ', 1000)
  const frame = frameOf(0, 1000, 1000, 80)
  const drawn = draw('junctions', set, frame, axis)
  const arcs = drawn.layout.arcs!

  it('stands each arc on the intron’s two ends', () => {
    const first = arcs.find((arc) => arc.index === 0)!
    // STAR's 101..400 is the intron [100, 400): 100 px to 400 px.
    expect(first.along0).toBeCloseTo(100, 5)
    expect(first.along1).toBeCloseTo(400, 5)
    const curves = drawn.paths.filter((path) => path.as === 'stroke').flatMap((path) => path.curves)
    expect(curves.some((curve) => Math.abs(curve.end[0] - 400) < 1e-6)).toBe(true)
  })

  it('splits the lane when both strands are there: forward up, reverse down', () => {
    const forward = arcs.find((arc) => arc.index === 0)!
    const reverse = arcs.find((arc) => arc.index === 3)!
    expect(forward.base).toBe(40)
    expect(reverse.base).toBe(40)
    // A bottom lane grows towards the map, which is towards across 0.
    expect(forward.apex).toBeLessThan(forward.base)
    expect(reverse.apex).toBeGreaterThan(reverse.base)
  })

  it('draws a stronger junction taller, against the file’s largest count', () => {
    const strong = arcs.find((arc) => arc.index === 0)!
    const weak = arcs.find((arc) => arc.index === 1)!
    const faint = arcs.find((arc) => arc.index === 2)!
    const height = (arc: typeof strong): number => Math.abs(arc.apex - arc.base)
    expect(height(strong)).toBeGreaterThan(height(weak))
    expect(height(weak)).toBeGreaterThan(height(faint))
    // A four-read arc is still an arc and not the baseline.
    expect(height(faint)).toBeGreaterThan(2)
    expect(glyphExtentOf('junctions', set)).toEqual({ min: 0, max: 100 })
  })

  it('writes each count at its apex, where it fits', () => {
    const counts = drawn.texts.map((text) => text.text)
    expect(counts).toContain('100')
    expect(counts).toContain('50')
  })

  // DDX3X's last intron has three acceptors three bases apart, so three arcs on
  // one span: 12, 6 and 1 reads. In a short lane the 6 is too close under the
  // 12 to be written, and the 1, which clears the 12, lands on the six-read
  // arc's line — where it reads as that arc's count. Neither is written.
  it('writes no count where another arc’s line runs through it', () => {
    const acceptors = parseJunctions(
      ['chrJ\t101\t400\t1\t1\t1\t12\t0\t30', 'chrJ\t101\t403\t1\t1\t0\t6\t0\t30', 'chrJ\t101\t406\t1\t1\t0\t1\t0\t30'].join(
        '\n',
      ),
      'SJ.out.tab',
    )
    const short = draw('junctions', acceptors, frameOf(0, 1000, 1000, 33), axis)
    expect(short.layout.arcs).toHaveLength(3)
    expect(short.texts.map((text) => text.text)).toEqual(['12'])
    // With the room to write each clear of the others' lines, all three are.
    const tall = draw('junctions', acceptors, frameOf(0, 1000, 1000, 80), axis)
    expect(tall.texts.map((text) => text.text).sort()).toEqual(['1', '12', '6'])
  })

  it('filters by the floor of a typed pair, which is a minimum count', () => {
    const floored = draw('junctions', set, frame, axis, { axisLimits: { min: 10, max: 100 } })
    const kept = floored.layout.arcs!.map((arc) => arc.index).sort()
    expect(kept).toEqual([0, 1, 3])
    expect(featureCaption('junctions', set, floored.layout, 'file', { min: 10, max: 100 }, String, String)).toBe(
      '3 of 4 · 10–100 reads',
    )
  })

  it('fits `auto` to the junctions in view, and says so on every frame', () => {
    // Only the reverse junction (50 reads) is between 800 and 1,000.
    const narrow = draw('junctions', set, frameOf(780, 1000, 1000, 80), axis)
    expect(featureCaption('junctions', set, narrow.layout, 'file', undefined, String, String)).toBe(
      '1 junction · to 50 reads',
    )
    // Its arc stands the full height of its side, being the strongest in view.
    const arc = narrow.layout.arcs![0]
    expect(Math.abs(arc.apex - arc.base)).toBeCloseTo(40 - 11 - 1, 5)
    // An empty window says it is empty rather than naming a ceiling.
    const empty = draw('junctions', set, frameOf(950, 1000, 1000, 80), axis)
    expect(featureCaption('junctions', set, empty.layout, 'file', undefined, String, String)).toBe('no junctions in view')
    // …and a gesture on it starts from the axis on screen.
    expect(glyphExtentOf('junctions', set, narrow.layout)).toEqual({ min: 0, max: 50 })
  })

  it('answers a click with the curve under it, not the widest box', () => {
    // At 250 px the long arc (100–700) and the short strong one (100–400) both
    // span the pointer; the pointer is on the short one's curve.
    const strong = arcs.find((arc) => arc.index === 0)!
    const t = (250 - strong.along0) / (strong.along1 - strong.along0)
    const onCurve = strong.base + 4 * (strong.apex - strong.base) * t * (1 - t)
    expect(featureAt(frame, drawn.layout, 250, onCurve)?.index).toBe(0)
    expect(junctionAt(frame, drawn.layout, 250, onCurve)?.index).toBe(0)
    const long = arcs.find((arc) => arc.index === 1)!
    const s = (600 - long.along0) / (long.along1 - long.along0)
    const onLong = long.base + 4 * (long.apex - long.base) * s * (1 - s)
    expect(featureAt(frame, drawn.layout, 600, onLong)?.index).toBe(1)
    // Nothing between the curves.
    expect(featureAt(frame, drawn.layout, 250, strong.base - 1)).toBe(null)
  })

  it('draws an intron narrower than two pixels as a spike of the same height', () => {
    const wide = frameOf(0, 1_000_000, 1000, 80)
    const far = draw('junctions', set, wide, axisOf('chrJ', 1_000_000))
    const spikes = far.paths.filter((path) => path.as === 'stroke' && path.curves.length === 0 && path.points.length >= 2)
    // The baseline, and the spikes: vertical strokes at each intron's middle.
    const vertical = spikes.flatMap((path) => {
      const out: Point[][] = []
      for (let i = 0; i + 1 < path.points.length; i += 2) out.push([path.points[i], path.points[i + 1]])
      return out.filter(([a, b]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) > 1)
    })
    expect(vertical.length).toBe(4)
  })

  it('stands on the far edge, rising the whole lane, when the file has one strand', () => {
    const forward = parseJunctions(STAR.split('\n').slice(0, 3).join('\n'), 'SJ.out.tab')
    const one = draw('junctions', forward, frame, axis)
    for (const arc of one.layout.arcs!) {
      expect(arc.base).toBe(80)
      expect(arc.apex).toBeLessThan(arc.base)
    }
  })

  it('colours by strand to start with, as every feature lane does', () => {
    const ink = featureColouring(set, 'junctions', 'strand', '#0072b2')
    expect(ink.key.levels.map((level) => level.label)).toEqual(['forward', 'reverse'])
    const strokes = new Set(drawn.paths.filter((path) => path.as === 'stroke' && path.curves.length > 0).map((path) => path.ink))
    expect(strokes.size).toBe(2)
  })
})

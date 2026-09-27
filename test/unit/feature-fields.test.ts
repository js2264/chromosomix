/**
 * What a feature lane can be coloured by, and what it comes out looking like
 * (§8.16).
 *
 * Against the published demo files, for the reason `annotation-parse.test.ts`
 * uses them: the whole point of the field picker is that it reads columns back
 * out of strings *this app's own parsers wrote*, so a test over three lines
 * written to pass would only ever prove that the regex in this module agrees
 * with the regex in this test. `Yeast_annotations.gtf` is a real Ensembl GTF
 * with eight biotypes and both strands in it, and `Yeast_ATAC.narrowPeak` is a
 * real MACS call set with four numeric columns and no strand at all — between
 * them they are every case the picker has.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseBed, parseGtf } from '@/annotations/parse'
import {
  ABSENT_LEVEL,
  featureFields,
  fieldLevels,
  fieldNumber,
  fieldRange,
  fieldText,
  featuresOf,
  featureStyleOf,
  strandBands,
} from '@/annotations/fields'
import type { FeatureSet } from '@/annotations/types'
import { defaultStyle } from '@/annotations/types'
import { featureColouring, NO_ANSWER } from '@/render/featureInk'
import { drawFeatures, layoutFeatures } from '@/render/features'
import type { LaneFrame } from '@/render/lane'
import { LocusAxis } from '@/render/locus'

function demo(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../demo/yeast/${name}`, import.meta.url)), 'utf8')
}

const GENES = parseGtf(demo('Yeast_annotations.gtf'))
const PEAKS = parseBed(demo('Yeast_ATAC.narrowPeak'), 'Yeast_ATAC.narrowPeak')

const LANE = '#0072b2'

function keysOf(set: FeatureSet | undefined, kind: 'gtf' | 'segments' = 'segments'): string[] {
  return featureFields(set, kind).map((field) => field.key)
}

describe('what a file offers to be coloured by', () => {
  it('finds the columns a GTF actually writes', () => {
    // `biotype` and `source` are attributes with no column of their own; they
    // reach the picker only because the parser writes them as `key value` and
    // this reads that shape back. `exons` must not be here — `4 exons` has its
    // number on the wrong side, which is a count and not a column.
    const keys = keysOf(GENES, 'gtf')
    expect(keys).toContain('biotype')
    expect(keys).toContain('source')
    expect(keys).not.toContain('exons')
    // The two every set has, and the lane's own colour first.
    expect(keys.slice(0, 2)).toEqual(['', 'strand'])
    expect(keys).toContain('score')
  })

  it('finds a peak caller’s numeric columns, and knows they are numbers', () => {
    const fields = featureFields(PEAKS, 'segments')
    const numeric = fields.filter((field) => field.kind === 'number').map((field) => field.key)
    expect(numeric).toContain('signal')
    expect(numeric).toContain('-log10 p')
    expect(numeric).toContain('-log10 q')
    // The value is the *last* token, which is what keeps this one column rather
    // than a column called `-log10`.
    expect(fields.map((field) => field.key)).not.toContain('-log10')
  })

  it('offers the built-ins before a file has arrived', () => {
    // The card is built while the worker is still parsing. A picker that was
    // empty then and full a second later would lose the reader's choice.
    expect(keysOf(undefined)).toEqual(['', 'strand', 'score'])
    // …and a VCF's own rule is offered only on a VCF.
    expect(featureFields(undefined, 'variants').map((f) => f.key)).toContain('base')
    expect(keysOf(undefined)).not.toContain('base')
  })

  it('names the values of a categorical column, commonest first', () => {
    const levels = fieldLevels(GENES, 'biotype')
    expect(levels[0]).toBe('protein_coding')
    expect(levels).toContain('tRNA')
    expect(levels).toContain('snoRNA')
  })

  it('reads one row’s value back out of the string it was joined into', () => {
    const at = GENES.detail.findIndex((detail) => detail.includes('biotype tRNA'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(fieldText(GENES, at, 'biotype')).toBe('tRNA')
    expect(fieldText(GENES, at, 'source')).toBe('sgd')
    // A column this file does not carry is empty, not an invented value.
    expect(fieldText(GENES, at, 'signal')).toBe('')
  })

  it('fits a numeric ramp to the file rather than to the window', () => {
    const range = fieldRange(PEAKS, 'signal')
    expect(range.min).toBeGreaterThan(0)
    expect(range.max).toBeGreaterThan(range.min)
    // `score` on a peak set is the signal column (`annotations/parse.ts`), so
    // the two agree — which is the check that the built-in reads the real array
    // rather than the detail string. To a float's precision and no further: one
    // is a `Float32Array` cell and the other is the text it was parsed from.
    const score = fieldRange(PEAKS, 'score')
    expect(score.min).toBeCloseTo(range.min, 4)
    expect(score.max).toBeCloseTo(range.max, 4)
  })
})

describe('which strands a file uses', () => {
  it('reads them from the file, so a pan cannot change the layout', () => {
    expect(strandBands(GENES)).toEqual([1, -1])
    // A MACS call set writes `.` in column 6: one band, and therefore no
    // banding at all.
    expect(strandBands(PEAKS)).toEqual([0])
  })
})

describe('the ink a field earns', () => {
  it('starts on strand, in three colours, with the reader’s own on forward', () => {
    const style = featuresOf(defaultStyle('segments', LANE), 'segments')
    expect(style.colourBy).toBe('strand')
    const { colourOf, key, chip } = featureColouring(GENES, 'gtf', style.colourBy, LANE)
    expect(colourOf).not.toBeUndefined()
    // Only the bands this file has: the yeast GTF is all `+` and `-`, so a
    // third row saying `unstranded` would be a legend for a colour nothing in
    // this lane is drawn in.
    expect(key.levels.map((level) => level.label)).toEqual(['forward', 'reverse'])
    const inks = key.levels.map((level) => level.colour)
    expect(inks[0]).toBe(LANE)
    expect(inks[1]).not.toBe(LANE)
    // …and the lane's name keeps the reader's colour, because it is in the lane.
    expect(chip).toBe(LANE)
    const forward = GENES.strand.findIndex((s) => s > 0)
    const reverse = GENES.strand.findIndex((s) => s < 0)
    expect(colourOf?.(forward)).toBe(inks[0])
    expect(colourOf?.(reverse)).toBe(inks[1])
  })

  it('gives a category column the categories’ own palette, and says so on the row', () => {
    // A lane colour that is *not* the category palette's first, so that "the
    // chip changed" is a claim about the rule rather than about two constants
    // happening to differ.
    const other = '#cc79a7'
    const { colourOf, key, chip } = featureColouring(GENES, 'gtf', 'biotype', other)
    const protein = GENES.detail.findIndex((d) => d.includes('biotype protein_coding'))
    const trna = GENES.detail.findIndex((d) => d.includes('biotype tRNA'))
    expect(colourOf?.(protein)).not.toBe(colourOf?.(trna))
    // §8.12's rule: the chip on the lane's name is a colour that is in the lane.
    expect(chip).not.toBe(other)
    expect(chip).toBe(key.levels[0].colour)
    // A row with no value for the column is the neutral that means *no answer*
    // everywhere else in this application, and the key names it.
    expect(key.levels.at(-1)).toEqual({ label: ABSENT_LEVEL, colour: NO_ANSWER })
  })

  it('draws a number as a ramp between the file’s own ends', () => {
    const { colourOf, key } = featureColouring(PEAKS, 'segments', 'signal', LANE)
    expect(key.ramp).not.toBeNull()
    const range = fieldRange(PEAKS, 'signal')
    let weakest = 0
    let strongest = 0
    for (let i = 0; i < PEAKS.length; i++) {
      const value = fieldNumber(PEAKS, i, 'signal')
      if (value === range.min) weakest = i
      if (value === range.max) strongest = i
    }
    expect(fieldNumber(PEAKS, weakest, 'signal')).toBe(range.min)
    expect(fieldNumber(PEAKS, strongest, 'signal')).toBe(range.max)
    expect(colourOf?.(weakest)).not.toBe(colourOf?.(strongest))
  })

  it('falls back to one colour for a column the file no longer has', () => {
    // A stored session reopened against another assembly. Colouring every
    // feature `not set` would look like a broken file rather than a missing
    // column.
    const { colourOf, chip } = featureColouring(PEAKS, 'segments', 'gene_biotype', LANE)
    expect(colourOf).toBeUndefined()
    expect(chip).toBe(LANE)
  })

  it('leaves a file with no strand in its own colour, rather than all grey', () => {
    // Every peak is unstranded. Colouring them all in the neutral would cost
    // the reader the colour that tells this lane from the three beside it, and
    // say nothing in exchange.
    const { colourOf, key, chip } = featureColouring(PEAKS, 'segments', 'strand', LANE)
    expect(colourOf).toBeUndefined()
    expect(key.levels).toEqual([])
    expect(chip).toBe(LANE)
  })

  it('keeps the neutral for the features a stranded file could not place', () => {
    const mixed = parseBed(
      ['I\t10\t20\ta\t0\t+', 'I\t30\t40\tb\t0\t-', 'I\t50\t60\tc\t0\t.'].join('\n') + '\n',
      'mixed.bed',
    )
    const { colourOf, key } = featureColouring(mixed, 'segments', 'strand', LANE)
    expect(key.levels.map((level) => level.label)).toEqual(['unstranded', 'forward', 'reverse'])
    expect(colourOf?.(2)).toBe(NO_ANSWER)
  })

  it('leaves a called variant on §8.14’s rule, which is its default', () => {
    expect(featuresOf(defaultStyle('variants', LANE), 'variants').colourBy).toBe('base')
  })
})

describe('a stored choice, read back', () => {
  it('keeps a string and defaults everything else', () => {
    expect(featureStyleOf({ colourBy: 'biotype', arrows: false }, 'gtf')).toEqual({
      colourBy: 'biotype',
      arrows: false,
      bars: 'file',
      display: 'expanded',
    })
    // Untrusted input: a session outlives the build that wrote it.
    expect(featureStyleOf({ colourBy: 42 }, 'segments').colourBy).toBe('strand')
    expect(featureStyleOf(null, 'segments')).toEqual({
      colourBy: 'strand',
      arrows: true,
      bars: 'file',
      display: 'expanded',
    })
    // Absent means on, so a row written before the switch existed comes back
    // pointing rather than blank.
    expect(featureStyleOf({ colourBy: 'strand' }, 'segments').arrows).toBe(true)
  })

  it('keeps one of the three ways of spending the rows, and nothing else', () => {
    expect(featureStyleOf({ display: 'squished' }, 'gtf').display).toBe('squished')
    expect(featureStyleOf({ display: 'collapsed' }, 'segments').display).toBe('collapsed')
    // A row written before the choice existed, and one written by something
    // else entirely, both come back expanded.
    expect(featureStyleOf({ colourBy: 'strand' }, 'gtf').display).toBe('expanded')
    expect(featureStyleOf({ display: 'dense' }, 'gtf').display).toBe('expanded')
  })

  it('takes only the one string that names the other bar scale (§8.17)', () => {
    // The comparable reading is the default, so anything but the exact stored
    // word comes back on it — including a row written before the switch existed.
    expect(featureStyleOf({ bars: 'feature' }, 'barchart').bars).toBe('feature')
    expect(featureStyleOf({ bars: 'per-feature' }, 'barchart').bars).toBe('file')
    expect(featureStyleOf({ bars: true }, 'barchart').bars).toBe('file')
    expect(featureStyleOf({ colourBy: 'strand' }, 'barchart').bars).toBe('file')
  })
})

// ---------------------------------------------------------------------------
// The lane, laid out and drawn
// ---------------------------------------------------------------------------

const CONTIG = 'I'
const LENGTH = 230_218

function axisOf(): LocusAxis {
  return new LocusAxis([
    { contig: CONTIG, unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

function frameOf(from: number, to: number, pixels = 1000, thickness = 90): LaneFrame {
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

describe('the rows, banded by strand', () => {
  it('puts every forward feature above every reverse one', () => {
    const frame = frameOf(0, 40_000)
    const layout = layoutFeatures(frame, axisOf(), GENES, 4)
    expect(layout.dense).toBe(false)
    expect(layout.placements.length).toBeGreaterThan(4)
    const rows = { forward: [] as number[], reverse: [] as number[] }
    for (const placement of layout.placements) {
      const strand = GENES.strand[placement.index]
      if (strand > 0) rows.forward.push(placement.row)
      else if (strand < 0) rows.reverse.push(placement.row)
    }
    expect(rows.forward.length).toBeGreaterThan(0)
    expect(rows.reverse.length).toBeGreaterThan(0)
    // Across runs outward from the map, so a lower row is nearer it — which on
    // the browser and on a bottom stack is higher up the screen.
    expect(Math.max(...rows.forward)).toBeLessThan(Math.min(...rows.reverse))
    // The lane reports the rows it *allotted*, so the two bands sit where the
    // allotment put them however well either packed.
    expect(layout.rows).toBe(4)
  })

  it('bands a short lane too, where a band still has room to be seen', () => {
    // A sixteen-pixel segments lane: `rowsThatFit` gives it one row, because a
    // row there is measured on the height a *name under a feature* needs. A
    // band needs only a glyph and a gap, and this is the lane a stranded BED
    // actually lands in — so the bands win and the names go back inside.
    const layout = layoutFeatures(frameOf(0, 40_000, 1000, 16), axisOf(), GENES, 1)
    expect(layout.rows).toBe(2)
    const rows = new Map<number, number[]>()
    for (const placement of layout.placements) {
      const strand = GENES.strand[placement.index]
      rows.set(strand, [...(rows.get(strand) ?? []), placement.row])
    }
    expect(Math.max(...(rows.get(1) ?? []))).toBeLessThan(Math.min(...(rows.get(-1) ?? [])))
  })

  it('falls back to one packing where a band would be a hairline', () => {
    // Ten pixels over two bands is five each, which is two rows of nothing.
    const layout = layoutFeatures(frameOf(0, 40_000, 1000, 10), axisOf(), GENES, 1)
    expect(layout.rows).toBe(1)
    expect(layout.placements.every((placement) => placement.row === 0)).toBe(true)
  })

  it('leaves a file with one strand exactly as it was', () => {
    const layout = layoutFeatures(frameOf(0, 40_000), axisOf(), PEAKS, 4)
    // Every peak is unstranded, so there is one band and the packing is the
    // greedy one it has always been — which means rows are *used* rather than
    // allotted, and a sparse window uses fewer than four.
    expect(layout.rows).toBeLessThanOrEqual(4)
    expect(layout.placements.length).toBeGreaterThan(0)
  })
})

/** A canvas that remembers both the boxes and the outlines it filled. */
function recorder(): {
  ctx: CanvasRenderingContext2D
  rects: Array<{ x: number; w: number; fill: string }>
  polys: Array<{ points: Array<[number, number]>; fill: string }>
  curves: { count: number }
} {
  const rects: Array<{ x: number; w: number; fill: string }> = []
  const polys: Array<{ points: Array<[number, number]>; fill: string }> = []
  const curves = { count: 0 }
  let pendingRects: Array<{ x: number; w: number }> = []
  let pendingPolys: Array<Array<[number, number]>> = []
  let current: Array<[number, number]> | null = null
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
    beginPath: () => { pendingRects = []; pendingPolys = []; current = null },
    closePath: () => { if (current !== null) { pendingPolys.push(current); current = null } },
    rect: (x: number, _y: number, w: number) => { pendingRects.push({ x, w }) },
    moveTo: (x: number, y: number) => { current = [[x, y]] },
    lineTo: (x: number, y: number) => { current?.push([x, y]) },
    // A rounded corner's far end, which is where the outline goes next; the
    // bend is counted so a test can ask whether the corners were rounded.
    quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => {
      current?.push([x, y])
      curves.count++
    },
    stroke: () => { current = null; pendingPolys = [] },
    fillText: () => {}, strokeText: () => {},
    measureText: () => ({ width: 20, actualBoundingBoxAscent: 7 }),
    translate: () => {}, rotate: () => {}, setLineDash: () => {}, getLineDash: () => [],
    fill: () => {
      for (const one of pendingRects) rects.push({ ...one, fill: String(state.fillStyle) })
      for (const points of pendingPolys) polys.push({ points, fill: String(state.fillStyle) })
      pendingRects = []
      pendingPolys = []
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, polys, curves }
}

function paintOf(over: Partial<Parameters<typeof drawFeatures>[4]> = {}): Parameters<typeof drawFeatures>[4] {
  return {
    colour: LANE,
    guideColour: '#333',
    haloColour: '#fff',
    font: '10px sans-serif',
    opacity: 1,
    labels: false,
    outline: false,
    ...over,
  }
}

const BED = parseBed(
  [
    'I\t1000\t3000\twide_fwd\t100\t+',
    'I\t5000\t7000\twide_rev\t100\t-',
    'I\t9000\t9010\tnarrow_fwd\t100\t+',
  ].join('\n') + '\n',
  'stranded.bed',
)

/** The x of the outline's point: its one vertex on the centre line, if it has one. */
function tipOf(poly: { points: Array<[number, number]> }): number | null {
  const ys = poly.points.map(([, y]) => y)
  const middle = (Math.min(...ys) + Math.max(...ys)) / 2
  const on = poly.points.filter(([, y]) => Math.abs(y - middle) < 0.01)
  return on.length === 1 ? on[0][0] : null
}

describe('a stranded segment, drawn', () => {
  it('ends in a point at the end it runs to', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { ctx, polys } = recorder()
    drawFeatures(ctx, frame, BED, layout, paintOf(), 'segments')
    // The two wide ones are outlines; the one-pixel one is a rectangle.
    expect(polys.length).toBe(2)
    const xs = (poly: (typeof polys)[number]): number[] => poly.points.map(([x]) => x)
    const [forward, reverse] = polys
    // A forward feature's point is at its far end and a reverse one's at its
    // near end — the vertex alone on the centre line, against the corners.
    expect(tipOf(forward)).toBeCloseTo(Math.max(...xs(forward)), 5)
    expect(tipOf(reverse)).toBeCloseTo(Math.min(...xs(reverse)), 5)
  })

  it('draws no chevrons through a long one: the point is the whole of it', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { ctx } = recorder()
    const strokes: number[] = []
    const stroke = ctx.stroke.bind(ctx)
    ;(ctx as unknown as { stroke: () => void }).stroke = () => {
      strokes.push(1)
      stroke()
    }
    drawFeatures(ctx, frame, BED, layout, paintOf(), 'segments')
    expect(strokes).toHaveLength(0)
  })

  it('rounds the corners it does not point', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { ctx, curves } = recorder()
    drawFeatures(ctx, frame, BED, layout, paintOf(), 'segments')
    // Two outlines, each with a square end rounded at both of its corners.
    expect(curves.count).toBe(4)
  })

  it('keeps the feature’s exact extent, point and all', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { ctx, polys } = recorder()
    drawFeatures(ctx, frame, BED, layout, paintOf(), 'segments')
    // 1000–3000 of a 10 kb window drawn 1000 px wide is x 100 to 300. The head
    // is cut *out of* the box and the corners are rounded *into* it, so neither
    // costs the glyph a base nor adds one (§8.4).
    const xs = polys[0].points.map(([x]) => x)
    expect(Math.min(...xs)).toBeCloseTo(100, 5)
    expect(Math.max(...xs)).toBeCloseTo(300, 5)
  })

  it('leaves a feature too narrow to hold a head as a plain box', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { ctx, rects } = recorder()
    drawFeatures(ctx, frame, BED, layout, paintOf(), 'segments')
    // 9000–9010 is one pixel: a point there would eat the extent it exists to
    // show, and a rounded corner on it would be a smudge.
    expect(rects.length).toBe(1)
    expect(rects[0].w).toBeLessThan(2)
  })

  it('draws rounded boxes with no point when the reader turns the points off', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { ctx, polys, curves } = recorder()
    drawFeatures(ctx, frame, BED, layout, paintOf({ arrows: false }), 'segments')
    expect(polys.length).toBe(2)
    expect(polys.every((poly) => tipOf(poly) === null)).toBe(true)
    // All four corners of each rounded.
    expect(curves.count).toBe(8)
  })

  it('paints each strand in its own ink, in one path per colour', () => {
    const frame = frameOf(0, 10_000, 1000, 40)
    const layout = layoutFeatures(frame, axisOf(), BED, 4)
    const { colourOf, key } = featureColouring(BED, 'segments', 'strand', LANE)
    const { ctx, rects, polys } = recorder()
    drawFeatures(ctx, frame, BED, layout, paintOf({ colourOf }), 'segments')
    const inks = [...polys, ...rects].map((one) => one.fill)
    expect(new Set(inks)).toEqual(new Set([key.levels[0].colour, key.levels[1].colour]))
  })
})

/**
 * How a feature is drawn (§8.16): by its own structure, whatever format it came
 * from, pointed at the end it runs to, and as thick as its row allows.
 *
 * The defects these pin, each of them seen on screen:
 *
 * - **A BED12 of transcripts was drawn as one box per gene.** The kind decided
 *   the glyph, a BED12 or a bigBed is a `segments` lane, and `segments` drew
 *   boxes: the exons and the coding span were parsed, carried and never drawn.
 *   The same gene from a GTF and from a BED12 now draws the same blocks.
 * - **Genes stopped at nine and thirteen pixels**, however tall their lane was
 *   made; a taller lane now draws them thicker, to a cap.
 * - **Direction was chevrons laid over the glyph**, in the halo colour, through
 *   every long box and along every intron. It is now the point on the block the
 *   feature ends in, and nothing else.
 * - **The row modes**: collapsed is one row for everything, squished is many
 *   thin ones, and neither reaches a barChart, whose rows are its value axis.
 *
 * Asserted off the outlines a recording canvas was asked to fill, measured the
 * way the eye measures them: where each block starts and ends, and how tall it
 * is.
 */

import { describe, expect, it } from 'vitest'

import { parseBed, parseGtf } from '@/annotations/parse'
import type { FeatureSet } from '@/annotations/types'
import { LocusAxis } from '@/render/locus'
import type { LaneFrame } from '@/render/lane'
import {
  MAX_THICK,
  drawFeatures,
  featureLayoutFor,
  glyphSizes,
  layoutFeatures,
  type FeaturePaint,
} from '@/render/features'

/** One filled shape: its bounding box, whether it was traced (not a `rect`), and its tip. */
interface Shape {
  x0: number
  x1: number
  y0: number
  y1: number
  traced: boolean
  /** The x of the one vertex on the shape's centre line, or `null` for none. */
  tip: number | null
}

function recorder(): { ctx: CanvasRenderingContext2D; shapes: Shape[]; strokes: number[] } {
  const shapes: Shape[] = []
  const strokes: number[] = []
  let pending: Shape[] = []
  let outline: Array<[number, number]> = []
  const close = (): void => {
    if (outline.length === 0) return
    const xs = outline.map(([x]) => x)
    const ys = outline.map(([, y]) => y)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const on = outline.filter(([, y]) => Math.abs(y - (y0 + y1) / 2) < 0.01)
    pending.push({
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0,
      y1,
      traced: true,
      tip: on.length === 1 ? on[0][0] : null,
    })
    outline = []
  }
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    save: () => {},
    restore: () => {},
    beginPath: () => {
      pending = []
      outline = []
    },
    closePath: close,
    rect: (x: number, y: number, w: number, h: number) => {
      pending.push({ x0: x, x1: x + w, y0: y, y1: y + h, traced: false, tip: null })
    },
    moveTo: (x: number, y: number) => {
      close()
      outline = [[x, y]]
    },
    lineTo: (x: number, y: number) => {
      outline.push([x, y])
    },
    quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => {
      outline.push([x, y])
    },
    fill: () => {
      close()
      shapes.push(...pending)
      pending = []
    },
    stroke: () => {
      strokes.push(1)
    },
    fillText: () => {},
    strokeText: () => {},
    measureText: () => ({ width: 20, actualBoundingBoxAscent: 7 }),
    translate: () => {},
    rotate: () => {},
    setLineDash: () => {},
    getLineDash: () => [],
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, shapes, strokes }
}

const LENGTH = 20_000

function axisOf(): LocusAxis {
  return new LocusAxis([
    { contig: 'I', unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

/** 2000 bases over 1000 pixels: two bases a pixel. */
function frameOf(thickness = 40, from = 0, to = 2000): LaneFrame {
  const span = to - from
  return {
    orientation: 'bottom',
    toPixel: (unit) => ((unit - from) / span) * 1000,
    toUnit: (pixel) => from + (pixel / 1000) * span,
    domain: [from, to],
    alongFrom: 0,
    alongTo: 1000,
    acrossFrom: 0,
    thickness,
  }
}

function paint(over: Partial<FeaturePaint> = {}): FeaturePaint {
  return {
    colour: '#0072b2',
    guideColour: '#333',
    haloColour: '#fff',
    font: '10px sans-serif',
    opacity: 1,
    labels: false,
    ...over,
  }
}

/** Lay out and draw, the way both surfaces do. */
function drawn(
  set: FeatureSet,
  kind: 'gtf' | 'segments',
  frame = frameOf(),
  over: Partial<FeaturePaint> = {},
): { shapes: Shape[]; strokes: number[] } {
  const rules = featureLayoutFor(kind, frame.thickness, (n) => n, over.display)
  const layout = layoutFeatures(frame, axisOf(), set, rules.rows, rules.least, rules.banded)
  const { ctx, shapes, strokes } = recorder()
  drawFeatures(ctx, frame, set, layout, paint(over), kind)
  return { shapes, strokes }
}

/**
 * One transcript, three exons, coding from inside the first to inside the last:
 * `[200, 400)`, `[800, 1000)`, `[1400, 1600)`, coding `[300, 1500)`.
 */
function bed12(strand: '+' | '-'): FeatureSet {
  return parseBed(
    `I\t200\t1600\tGENE1\t0\t${strand}\t300\t1500\t0\t3\t200,200,200,\t0,600,1200,\n`,
    'genes.bed',
  )
}

/** The same transcript as a GTF writes it: 1-based, and the stop codon apart. */
function gtf(strand: '+' | '-'): FeatureSet {
  const row = (feature: string, from: number, to: number): string =>
    `I\tsrc\t${feature}\t${from}\t${to}\t.\t${strand}\t.\tgene_id "G1"; transcript_id "T1"; gene_name "GENE1";`
  const stop = strand === '+' ? row('stop_codon', 1498, 1500) : row('stop_codon', 301, 303)
  const cds = strand === '+' ? [301, 1497] : [304, 1500]
  return parseGtf(
    [
      row('transcript', 201, 1600),
      row('exon', 201, 400),
      row('exon', 801, 1000),
      row('exon', 1401, 1600),
      // The CDS rows stop short of the stop codon, which is a row of its own.
      row('CDS', cds[0], Math.min(cds[1], 400)),
      row('CDS', 801, 1000),
      row('CDS', 1401, cds[1]),
      stop,
    ].join('\n') + '\n',
  )
}

/** The filled blocks, in axis order — every shape but the intron's hairline. */
function blocks(shapes: Shape[]): Shape[] {
  return shapes.filter((shape) => shape.y1 - shape.y0 > 2).sort((a, b) => a.x0 - b.x0)
}

describe('a transcript', () => {
  it('is its exons on a hairline, with the coding span thick — from a BED12 too', () => {
    const { shapes } = drawn(bed12('+'), 'segments')
    const parts = blocks(shapes)
    // The first exon's untranslated end, the coding span across all three
    // exons, and the last exon's untranslated end: five blocks.
    expect(parts.map((part) => [Math.round(part.x0), Math.round(part.x1)])).toEqual([
      [100, 150],
      [150, 200],
      [400, 500],
      [700, 750],
      [750, 800],
    ])
    const height = (part: Shape): number => part.y1 - part.y0
    const [utr5, cds1, cds2, cds3, utr3] = parts
    expect(height(cds1)).toBeGreaterThan(height(utr5))
    expect(height(cds2)).toBeCloseTo(height(cds1), 5)
    expect(height(cds3)).toBeCloseTo(height(cds1), 5)
    expect(height(utr3)).toBeCloseTo(height(utr5), 5)
    // The introns: one hairline from the end of the first exon to the start of
    // the last, under the blocks.
    const hairlines = shapes.filter((shape) => shape.y1 - shape.y0 <= 2)
    expect(hairlines).toHaveLength(1)
    expect(Math.round(hairlines[0].x0)).toBe(200)
    expect(Math.round(hairlines[0].x1)).toBe(700)
  })

  it('draws the same blocks from a GTF, stop codon and all', () => {
    const fromBed = blocks(drawn(bed12('+'), 'segments').shapes)
    const fromGtf = blocks(drawn(gtf('+'), 'gtf').shapes)
    expect(fromGtf.map((part) => [part.x0, part.x1, part.y1 - part.y0])).toEqual(
      fromBed.map((part) => [part.x0, part.x1, part.y1 - part.y0]),
    )
  })

  it('points the block it ends in, at the end it runs to', () => {
    const forward = blocks(drawn(bed12('+'), 'segments').shapes)
    // The 3′ untranslated end is the last block, and its far end is the point.
    expect(forward.map((part) => part.tip)).toEqual([null, null, null, null, 800])
    const reverse = blocks(drawn(bed12('-'), 'segments').shapes)
    // On the minus strand the transcript ends on the left.
    expect(reverse.map((part) => part.tip)).toEqual([100, null, null, null, null])
  })

  it('draws a non-coding transcript’s exons thin, and all of them', () => {
    const set = parseBed('I\t200\t1600\tRNA1\t0\t+\t200\t200\t0\t3\t200,200,200,\t0,600,1200,\n', 'rna.bed')
    const parts = blocks(drawn(set, 'segments').shapes)
    expect(parts).toHaveLength(3)
    const thin = glyphSizes(40 - 2, 'expanded').thin
    for (const part of parts) expect(part.y1 - part.y0).toBeCloseTo(thin, 5)
  })

  it('strokes nothing: no chevrons along the introns or through the blocks', () => {
    expect(drawn(bed12('+'), 'segments').strokes).toHaveLength(0)
    expect(drawn(gtf('-'), 'gtf').strokes).toHaveLength(0)
  })
})

describe('the thickness of a glyph', () => {
  it('grows with the room its row gives it, up to a cap', () => {
    expect(glyphSizes(12, 'expanded').thick).toBe(10)
    expect(glyphSizes(20, 'expanded').thick).toBe(18)
    expect(glyphSizes(200, 'expanded').thick).toBe(MAX_THICK)
    // …which is well past the thirteen pixels a gene used to stop at.
    expect(MAX_THICK).toBeGreaterThan(13)
  })

  it('draws a taller lane’s features thicker', () => {
    const single = parseBed('I\t200\t1600\tBOX\t0\t.\n', 'box.bed')
    const heightIn = (thickness: number): number => {
      const [part] = blocks(drawn(single, 'segments', frameOf(thickness)).shapes)
      return part.y1 - part.y0
    }
    expect(heightIn(16)).toBeLessThan(heightIn(24))
    expect(heightIn(24)).toBeLessThanOrEqual(MAX_THICK)
  })

  it('keeps an untranslated end about three fifths of the coding span', () => {
    const sizes = glyphSizes(20, 'expanded')
    expect(sizes.thin / sizes.thick).toBeCloseTo(0.6, 5)
  })
})

describe('the rows', () => {
  /** Two overlapping features on opposite strands. */
  const OVERLAPPING = parseBed('I\t200\t900\tA\t0\t+\nI\t400\t1200\tB\t0\t-\n', 'two.bed')

  it('collapse into one row for everything, strands and overlaps alike', () => {
    const rules = featureLayoutFor('segments', 60, (n) => n, 'collapsed')
    expect(rules).toMatchObject({ rows: 1, banded: false })
    const layout = layoutFeatures(frameOf(60), axisOf(), OVERLAPPING, rules.rows, 0, rules.banded)
    expect(layout.placements.map((placement) => placement.row)).toEqual([0, 0])
  })

  it('squish into many thin rows where expanded has room for a few', () => {
    const expanded = featureLayoutFor('gtf', 60, (n) => n, 'expanded')
    const squished = featureLayoutFor('gtf', 60, (n) => n, 'squished')
    expect(squished.rows).toBeGreaterThan(expanded.rows)
    expect(squished.banded).toBe(true)
    // And a squished glyph is thin whatever the row: it is the point of it.
    expect(glyphSizes(60, 'squished').thick).toBeLessThan(glyphSizes(60, 'expanded').thick)
  })

  it('leave a barChart alone: its rows are its value axis', () => {
    for (const display of ['expanded', 'squished', 'collapsed'] as const) {
      expect(featureLayoutFor('barchart', 60, (n) => n, display)).toEqual(
        featureLayoutFor('barchart', 60, (n) => n),
      )
    }
  })
})

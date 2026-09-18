/**
 * barChart and bigBarChart, from the bytes to the glyph (§8.17).
 *
 * Three claims, and the first two are about what this format can be *mistaken*
 * for. A barChart is BED6+5, so it lands in the middle of a family whose
 * members are told apart by column counts — and column 8 of a BED9 is
 * `thickEnd` with `itemRgb` beside it, which is an integer followed by three
 * comma-separated numbers and is therefore the exact shape the sniffer looks
 * for. If that collision is not held shut, every BED9 in the world opens as a
 * bar chart of its own RGB triple; if the sniffer is asked too late, every
 * barChart opens as a BED whose ninth column — the whole of what the file is
 * about — is silently dropped.
 *
 * The third is that the vector survives the *sort*. `FeatureBuilder.finish`
 * orders rows by `(contig, start)` and a file is not required to be sorted, so
 * a parallel array of charts written in file order and a set read in genomic
 * order are two orders — and the bug that makes is a chart drawn on the wrong
 * gene, which looks exactly like data.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BAR_FIELD_TOP,
  barChartSummary,
  isBarChartSchema,
  parseBarChart,
  sniffBarChart,
} from '@/annotations/barchart'
import { formatIntervals } from '@/annotations/export'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffFormat } from '@/annotations/parse'
import { sniffVcf } from '@/annotations/vcf'
import { sniffSignal } from '@/annotations/signal'
import type { FeatureSet } from '@/annotations/types'
import { barChartCaption, barColours, barLimitsOf, dominantOf, peakOf } from '@/render/barchart'
import { drawBarCharts, featureLayoutFor, layoutFeatures } from '@/render/features'
import { featureColouring } from '@/render/featureInk'
import type { LaneFrame } from '@/render/lane'
import { LocusAxis } from '@/render/locus'
import { CATEGORY_PALETTE } from '@/render/meta'

/** Tabs, so a test can be written with spaces and read as the format. */
function rows(lines: string[]): string {
  return lines.map((line) => line.replace(/ +/g, '\t')).join('\n')
}

const TRACK =
  'track type=barChart name="Toy" barChartBars="liver kidney lung" ' +
  'barChartColors="#f00 #0f0 #00f" barChartLabel=Tissues barChartMetric=Median ' +
  'barChartUnit=TPM'

/** Deliberately out of genomic order, to catch a chart that follows file order. */
const TOY = [
  TRACK,
  rows([
    'chrII 500 900 YBL001C 100 . ECM15 3 0,0,7',
    'chrI 3000 4000 YAL002W 300 - VPS8 3 1,2,9',
    'chrI 1000 2000 YAL001C 500 + TFC3 3 10.5,3.2,0',
  ]),
].join('\n')

/** The same rows a bigBarChart arrives as: no `track` line to name anything. */
const HEADLESS = TOY.split('\n').slice(1).join('\n')

/** …and one row whose `expCount` disagrees with the file's categories. */
const ODD = TOY + '\n' + rows(['chrII 2000 2500 YBL002W 50 + MIC10 4 1,2,3,4'])

describe('what a barChart is not', () => {
  it('leaves a BED9 alone, though thickEnd and itemRgb are the shape it looks for', () => {
    // The collision this sniffer exists to survive. `thickEnd` is 3 on both
    // rows, so the count agrees with the three numbers in `itemRgb` — and what
    // refuses them is column 7, which is `thickStart` here and a *name* in a
    // barChart.
    const bed9 = rows([
      'chrI 1000 2000 peak1 500 + 1000 3 255,0,0',
      'chrI 3000 4000 peak2 300 - 3000 3 0,255,0',
    ])
    expect(sniffBarChart(bed9)).toBe(false)
    expect(sniffFormat(bed9)).toBe('bed')
  })

  it('leaves a BED12 and a gappedPeak alone for the same reason', () => {
    const bed12 = rows([
      'chrI 1000 2000 gene1 500 + 1200 3 0,0,255 2 100,200 0,800',
      'chrI 3000 4000 gene2 300 - 3200 3 0,0,255 2 100,200 0,800',
    ])
    expect(sniffBarChart(bed12)).toBe(false)
  })

  it('leaves a narrowPeak alone, because one q-value is not two categories', () => {
    // `BAR_MIN_CATEGORIES` doing its job: column 8 here is a single number, so
    // a count of one would have matched it.
    const narrow = rows([
      'chrI 1000 2000 p1 500 + 3.5 9 4.2 500',
      'chrI 3000 4000 p2 300 - 2.5 8 3.2 100',
    ])
    expect(sniffBarChart(narrow)).toBe(false)
  })

  it('cannot capture the two sniffers asked before it, nor they it', () => {
    // The ordering claim in `load`: three strict sniffers before the one that
    // never says no, and none of the three overlapping.
    expect(sniffVcf(TOY)).toBe(false)
    expect(sniffSignal(TOY)).toBe(null)
    const bedgraph = rows(['chrI 0 100 4.5', 'chrI 100 200 5.5', 'chrI 200 300 1.5', 'chrI 300 400 2'])
    expect(sniffBarChart(bedgraph)).toBe(false)
    const vcf = '##fileformat=VCFv4.3\n' + rows(['chrV 1000 . A G 60 PASS .'])
    expect(sniffBarChart(vcf)).toBe(false)
  })

  it('stops once it has seen enough, rather than reading the whole file', () => {
    // It runs on every dropped file before anything knows what one is, so a
    // half-gigabyte text file must not be split line by line to answer a
    // question four rows settle. Asserted through behaviour: the rows past the
    // fourth are nonsense, and a sniffer that read them would say no.
    const head = Array.from({ length: 6 }, (_, at) =>
      `chrI ${at * 100} ${at * 100 + 50} g${at} 500 + NAME 3 1,2,3`,
    )
    const junk = Array.from({ length: 200 }, () => 'this is not a row of anything')
    expect(sniffBarChart(rows([...head, ...junk]))).toBe(true)
  })

  it('refuses a row whose count and list disagree', () => {
    expect(sniffBarChart(rows(['chrI 1000 2000 g 500 + NAME 3 1,2']))).toBe(false)
    expect(sniffBarChart(rows(['chrI 1000 2000 g 500 + NAME 2 1,2,3']))).toBe(false)
  })

  it('takes a file that names itself one, whatever column 7 holds', () => {
    // A barChart whose `name2` is a number: the shape test cannot tell it from
    // a thickStart, and the reader naming the format has already answered.
    const numeric = rows(['chrI 1000 2000 g 500 + 12345 3 1,2,3'])
    expect(sniffBarChart(numeric)).toBe(false)
    expect(sniffBarChart(numeric, 'toy.barChart')).toBe(true)
  })
})

describe('a barChart, read', () => {
  it('takes its categories, colours and units from the track line', () => {
    const set = parseBarChart(TOY, 'toy.barChart')
    const bars = set.bars
    expect(bars).toBeDefined()
    expect(bars?.labels).toEqual(['liver', 'kidney', 'lung'])
    expect(bars?.named).toBe(true)
    expect(bars?.colours).toEqual(['#f00', '#0f0', '#00f'])
    expect(bars?.unit).toBe('TPM')
    expect(bars?.label).toBe('Tissues')
    expect(bars?.metric).toBe('Median')
    expect(bars?.unplaced).toBe(0)
  })

  it('keeps each chart on its own feature through the sort', () => {
    // The file lists chrI's two rows backwards, so the sort moves them past
    // each other: in file order this is `ECM15, VPS8, TFC3`. Every vector below
    // would still be *present* if the charts had been laid out in file order,
    // and two of them would be on the wrong gene.
    //
    // chrII leads because `FeatureBuilder` mints contig ids on first sight and
    // the file mentions it first — the ordinary behaviour of every set here,
    // and what the map's own contig order corrects on the way in.
    const set = parseBarChart(TOY, 'toy.barChart')
    expect([...set.name]).toEqual(['ECM15', 'TFC3', 'VPS8'])
    expect(valuesAt(set, 0)).toEqual([0, 0, 7])
    expect(valuesAt(set, 1)).toEqual([10.5, 3.2, 0])
    expect(valuesAt(set, 2)).toEqual([1, 2, 9])
  })

  it('fits the ceiling to the file, not to any one row', () => {
    expect(parseBarChart(TOY).bars?.max).toBeCloseTo(10.5, 5)
  })

  it('takes maxLimit over the file’s own largest value where one is set', () => {
    const capped = TOY.replace('barChartUnit=TPM', 'barChartUnit=TPM maxLimit=50')
    expect(parseBarChart(capped).bars?.max).toBe(50)
  })

  it('splits the name from the accession the way a GTF does', () => {
    const set = parseBarChart(TOY, 'toy.barChart')
    expect(set.name[1]).toBe('TFC3')
    expect(set.id[1]).toBe('YAL001C')
  })

  it('writes the dominant category and the total as columns', () => {
    const set = parseBarChart(TOY, 'toy.barChart')
    expect(set.detail[1]).toContain(`${BAR_FIELD_TOP} liver`)
    expect(set.detail[2]).toContain(`${BAR_FIELD_TOP} lung`)
    expect(set.detail[1]).toContain('total 13.70')
  })

  it('numbers its categories when the file names none, and withholds `top`', () => {
    // The bigBarChart case: the categories' names live in a hub this file
    // arrived without. A `top` of `3` would be read back as a *number* by
    // `fields.ts` and drawn as a ramp over the order the categories happen to
    // be listed in, which is §8.12's own counter-example.
    const set = parseBarChart(HEADLESS)
    expect(set.bars?.labels).toEqual(['1', '2', '3'])
    expect(set.bars?.named).toBe(false)
    expect(set.detail[0]).not.toContain(BAR_FIELD_TOP)
    expect(set.detail[0]).toContain('total')
  })

  it('drops a partial colour list rather than padding it', () => {
    const partial = TOY.replace('barChartColors="#f00 #0f0 #00f"', 'barChartColors="#f00 #0f0"')
    expect(parseBarChart(partial).bars?.colours).toEqual([])
  })

  it('keeps the interval of a row that disagrees about the count, and says so', () => {
    const set = parseBarChart(ODD, 'toy.barChart')
    expect(set.length).toBe(4)
    expect(set.bars?.unplaced).toBe(1)
    // Its interval is intact and its chart is *no value* rather than zeroes.
    const at = set.name.indexOf('MIC10')
    expect(set.start[at]).toBe(2000)
    expect(set.end[at]).toBe(2500)
    expect(valuesAt(set, at).every(Number.isNaN)).toBe(true)
    expect(barChartSummary(set)).toContain('1 with no chart')
  })

  it('reads the optional _dataOffset and _dataLen columns without tripping', () => {
    const wide = [
      TRACK,
      rows(['chrI 1000 2000 YAL001C 500 + TFC3 3 10.5,3.2,0 4096 128']),
    ].join('\n')
    expect(sniffBarChart(wide)).toBe(true)
    expect(valuesAt(parseBarChart(wide), 0)).toEqual([10.5, 3.2, 0])
  })

  it('summarises what it holds', () => {
    expect(barChartSummary(parseBarChart(TOY, 'toy.barChart'))).toBe('3 features · 3 tissues')
  })
})

describe('a bigBarChart', () => {
  it('is a bigBed whose schema says so', () => {
    // The real thing, from UCSC's barChart.as. The two field names together,
    // because `expCount` alone appears in the older microarray schemas whose
    // ninth column is a different thing.
    const auto = `table barChartBed
"BED6+5 with additional fields for category count and median values"
    (
    string chrom;       "Reference sequence chromosome or scaffold"
    uint   chromStart;  "Start position in chromosome"
    uint   chromEnd;    "End position in chromosome"
    string name;        "Name or ID of item"
    uint   score;       "Score from 0-1000"
    char[1] strand;     "+ or - for strand"
    string name2;       "Alternative name for item"
    uint expCount;      "Number of bar chart categories"
    float[expCount] expScores; "Comma separated list of category values"
    bigint _dataOffset; "Offset of sample data"
    int _dataLen;       "Length of sample data row"
    )`
    expect(isBarChartSchema(auto)).toBe(true)
  })

  it('is not an ordinary bigBed', () => {
    expect(isBarChartSchema('table bed12\n( string chrom; uint blockCount; )')).toBe(false)
    expect(isBarChartSchema('')).toBe(false)
    // Half the schema is not the schema.
    expect(isBarChartSchema('uint expCount; "Number of categories"')).toBe(false)
  })

  it('reads the rows the bigBed road hands over', () => {
    // `loadBigBed` re-joins bbi's rows into BED lines and runs this parser over
    // them (§8.7) — so what a bigBarChart parses is exactly `HEADLESS`, and the
    // categories it cannot name are numbered rather than invented.
    const set = parseBarChart(HEADLESS, 'genes.bb')
    expect(set.length).toBe(3)
    expect(set.bars?.named).toBe(false)
    expect(valuesAt(set, set.name.indexOf('TFC3'))).toEqual([10.5, 3.2, 0])
  })
})

describe('a barChart, written back out', () => {
  it('round-trips through the export, categories and all', () => {
    // BED6 would be a lossy export that looks like a complete one, so what
    // comes out is a barChart — and the proof is that this app reads it back as
    // the same lane rather than as a peak set.
    const set = parseBarChart(TOY, 'toy.barChart')
    const text = formatIntervals({ kind: 'features', data: set })
    expect(sniffBarChart(text)).toBe(true)
    const again = parseBarChart(text, 'exported.barChart')
    expect(again.length).toBe(set.length)
    expect(again.bars?.labels).toEqual(['liver', 'kidney', 'lung'])
    expect(again.bars?.named).toBe(true)
    expect(again.bars?.colours).toEqual(['#f00', '#0f0', '#00f'])
    expect(again.bars?.unit).toBe('TPM')
    expect(again.bars?.metric).toBe('Median')
    expect(again.bars?.max).toBeCloseTo(set.bars!.max, 5)
    expect([...again.name]).toEqual([...set.name])
    expect([...again.id]).toEqual([...set.id])
    for (let at = 0; at < set.length; at++) {
      expect(valuesAt(again, at)).toEqual(valuesAt(set, at))
    }
  })

  it('writes a row that lost its chart as the BED6 it now is', () => {
    // A chart of zeroes it never had would be a measurement; the interval is
    // all this row has left and all it should claim.
    const text = formatIntervals({ kind: 'features', data: parseBarChart(ODD, 'toy.barChart') })
    const line = text.split('\n').find((row) => row.includes('MIC10'))
    expect(line?.split('\t')).toHaveLength(6)
  })

  it('leaves every other feature set a plain BED6', () => {
    const set = parseBarChart(TOY, 'toy.barChart')
    delete set.bars
    const text = formatIntervals({ kind: 'features', data: set })
    expect(text).not.toContain('track type=barChart')
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue
      expect(line.split('\t')).toHaveLength(6)
    }
  })
})

describe('where a barChart is routed', () => {
  it('lands in a lane, as its own kind', () => {
    expect(cardFor('barchart')).toBe('linear')
    expect(kindFor('linear', 'barchart')).toBe('barchart')
  })

  it('is refused by the overlay, which has no lane to draw a chart in', () => {
    expect(kindFor('overlay', 'barchart')).toBe(null)
  })
})

describe('the ink', () => {
  it('uses the file’s own colours where it gives one per category', () => {
    const bars = parseBarChart(TOY, 'toy.barChart').bars
    expect(barColours(bars!)).toEqual(['#f00', '#0f0', '#00f'])
  })

  it('falls back to the categories’ palette, which is §8.12’s', () => {
    const bars = parseBarChart(HEADLESS).bars
    expect(barColours(bars!)).toEqual(CATEGORY_PALETTE.slice(0, 3))
  })

  it('spreads a ramp rather than cycling the palette past its length', () => {
    // A cycle would make category 13 and category 1 the same blue, and a
    // repeating rhythm across every glyph reads as structure in the data.
    const wide = manyCategories(CATEGORY_PALETTE.length + 6)
    const colours = barColours(parseBarChart(wide).bars!)
    expect(new Set(colours).size).toBe(colours.length)
    expect(colours[0]).not.toBe(colours[CATEGORY_PALETTE.length])
  })

  it('names the categories in the lane’s key, and chips the lane in one of them', () => {
    const set = parseBarChart(TOY, 'toy.barChart')
    const ink = featureColouring(set, 'barchart', 'strand', '#999999')
    expect(ink.key.levels.map((level) => level.label)).toEqual(['liver', 'kidney', 'lung'])
    expect(ink.key.levels.map((level) => level.colour)).toEqual(['#f00', '#0f0', '#00f'])
    expect(ink.chip).toBe('#f00')
    // Nothing per feature: `drawBarCharts` reads the categories itself, and a
    // second answer here would be one that could disagree with the picture.
    expect(ink.colourOf).toBeUndefined()
  })

  it('finds each row’s dominant category and its height', () => {
    const set = parseBarChart(TOY, 'toy.barChart')
    expect(dominantOf(set.bars!, 1)).toBe(0) // TFC3, liver
    expect(dominantOf(set.bars!, 2)).toBe(2) // VPS8, lung
    expect(peakOf(set.bars!, 1)).toBeCloseTo(10.5, 5)
    expect(peakOf(set.bars!, 2)).toBe(9)
  })

  it('has no dominant category for a row that carries no chart', () => {
    const set = parseBarChart(ODD, 'toy.barChart')
    const at = set.name.indexOf('MIC10')
    expect(dominantOf(set.bars!, at)).toBe(-1)
    expect(Number.isNaN(peakOf(set.bars!, at))).toBe(true)
  })

  it('says what the top of a bar means, and which reading is on', () => {
    const bars = parseBarChart(TOY, 'toy.barChart').bars!
    expect(barChartCaption(bars, (v) => String(v))).toBe('bars to 10.5 TPM')
    expect(barChartCaption(bars, (v) => String(v), 'feature')).toContain('own top')
    // A fixed axis says both its ends, and overrides the per-chart reading: the
    // caption is what lets two lanes of two files be compared.
    expect(barChartCaption(bars, (v) => String(v), 'feature', { min: 0, max: 50 })).toBe(
      'bars from 0 to 50 TPM',
    )
  })
})

// ---------------------------------------------------------------------------
// The lane, drawn
// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  w: number
  h: number
  fill: string
}

/** A canvas that remembers the rectangles it filled, and in what ink. */
function recorder(): { ctx: CanvasRenderingContext2D; filled: Rect[] } {
  const filled: Rect[] = []
  let pending: Array<{ x: number; y: number; w: number; h: number }> = []
  const state = { fillStyle: '#000', globalAlpha: 1 }
  const stack: Array<typeof state> = []
  const ctx = {
    get fillStyle() { return state.fillStyle },
    set fillStyle(v: string) { state.fillStyle = v },
    get globalAlpha() { return state.globalAlpha },
    set globalAlpha(v: number) { state.globalAlpha = v },
    strokeStyle: '#000', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineJoin: '',
    save: () => { stack.push({ ...state }) },
    restore: () => { Object.assign(state, stack.pop() ?? state) },
    beginPath: () => { pending = [] },
    closePath: () => {},
    rect: (x: number, y: number, w: number, h: number) => { pending.push({ x, y, w, h }) },
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

const CONTIG = 'chrI'
const LENGTH = 20_000
const LANE = '#0072b2'

function axisOf(): LocusAxis {
  return new LocusAxis([
    { contig: CONTIG, unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

function frameOf(from: number, to: number, pixels = 1000, thickness = 60): LaneFrame {
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

/** Lay out and draw, the way both surfaces do. */
function drawn(
  set: FeatureSet,
  frame: LaneFrame,
  barScale: 'file' | 'feature' = 'file',
  barLimits?: { min: number; max: number },
): Rect[] {
  const rules = featureLayoutFor('barchart', frame.thickness, (n) => n)
  const layout = layoutFeatures(frame, axisOf(), set, rules.rows, rules.least, rules.banded)
  const { ctx, filled } = recorder()
  drawBarCharts(ctx, frame, set, layout, {
    colour: LANE,
    guideColour: '#333333',
    haloColour: '#ffffff',
    font: '10px sans-serif',
    opacity: 1,
    labels: false,
    barScale,
    ...(barLimits === undefined ? {} : { barLimits }),
  })
  return filled
}

/** One wide feature whose three categories are 10.5, 3.2 and 0. */
const ONE = [TRACK, rows(['chrI 1000 2000 YAL001C 500 + TFC3 3 10.5,3.2,0'])].join('\n')

describe('a barChart lane, drawn', () => {
  it('draws one bar per category, in the categories’ own colours', () => {
    const bars = drawn(parseBarChart(ONE, 'toy.barChart'), frameOf(0, 4000)).filter(
      (rect) => rect.fill !== '#333333',
    )
    // Two bars, not three: the third category is zero, and a zero-height bar is
    // the baseline the guide already drew.
    expect(bars.map((rect) => rect.fill)).toEqual(['#f00', '#0f0'])
    // …and the tall one is the tall one.
    expect(bars[0].h).toBeGreaterThan(bars[1].h)
    expect(bars[0].h / bars[1].h).toBeCloseTo(10.5 / 3.2, 1)
  })

  it('stands them side by side inside the feature’s own bases', () => {
    const frame = frameOf(0, 4000)
    const bars = drawn(parseBarChart(ONE, 'toy.barChart'), frame).filter(
      (rect) => rect.fill !== '#333333',
    )
    // The feature covers 1000–2000 of a 4000 bp window over 1000 px: 250 px
    // wide, starting at 250.
    for (const rect of bars) {
      expect(rect.x).toBeGreaterThanOrEqual(250)
      expect(rect.x + rect.w).toBeLessThanOrEqual(250 + 250 + 1)
    }
    expect(bars[1].x).toBeGreaterThan(bars[0].x)
  })

  it('draws a baseline under every feature, so a chart of zeroes is still there', () => {
    const flat = [TRACK, rows(['chrI 1000 2000 g 0 + G 3 0,0,0'])].join('\n')
    const drawnRects = drawn(parseBarChart(flat, 'toy.barChart'), frameOf(0, 4000))
    // The guide colour, and nothing else: no bar has any height to draw.
    expect(drawnRects.map((rect) => rect.fill)).toEqual(['#333333'])
  })

  it('collapses to one box in the dominant category’s colour where there is no room', () => {
    // The whole contig in forty pixels: the feature is two pixels wide, which
    // is not three bars. One box, and it is the colour of the category that
    // dominates the row — so the lane still says *which* long after it has
    // stopped being able to say *which ones*.
    const bars = drawn(parseBarChart(ONE, 'toy.barChart'), frameOf(0, LENGTH, 40)).filter(
      (rect) => rect.fill !== '#333333',
    )
    expect(bars).toHaveLength(1)
    expect(bars[0].fill).toBe('#f00')
  })

  it('scales each chart to its own top when asked to', () => {
    // Two features an order of magnitude apart. Against the file both of the
    // second's bars are a smear; against itself it is the same shape as the
    // first, which is the reading the switch exists for (§8.17).
    const two = [
      TRACK,
      rows([
        'chrI 1000 2000 big 500 + BIG 3 100,50,0',
        'chrI 3000 4000 small 10 + SMALL 3 2,1,0',
      ]),
    ].join('\n')
    const set = parseBarChart(two, 'toy.barChart')
    const byFile = drawn(set, frameOf(0, 6000), 'file').filter((r) => r.fill === '#f00')
    const byFeature = drawn(set, frameOf(0, 6000), 'feature').filter((r) => r.fill === '#f00')
    expect(byFile).toHaveLength(2)
    expect(byFile[1].h / byFile[0].h).toBeCloseTo(2 / 100, 2)
    expect(byFeature).toHaveLength(2)
    expect(byFeature[1].h).toBeCloseTo(byFeature[0].h, 5)
  })

  it('draws against a value axis the reader fixed, whichever switch is on', () => {
    // The tall feature's first bar is 100 against a file ceiling of 100, so it
    // fills the chart; on a ceiling of 200 it fills half of it, and it does so
    // under both readings — a fixed axis is what the reader typed, and "each
    // chart against its own top" is the other answer to the same question.
    const two = [
      TRACK,
      rows([
        'chrI 1000 2000 big 500 + BIG 3 100,50,0',
        'chrI 3000 4000 small 10 + SMALL 3 2,1,0',
      ]),
    ].join('\n')
    const set = parseBarChart(two, 'toy.barChart')
    const free = drawn(set, frameOf(0, 6000)).filter((r) => r.fill === '#f00')
    const fixed = drawn(set, frameOf(0, 6000), 'file', { min: 0, max: 200 }).filter(
      (r) => r.fill === '#f00',
    )
    expect(fixed[0].h / free[0].h).toBeCloseTo(0.5, 2)
    const overridden = drawn(set, frameOf(0, 6000), 'feature', { min: 0, max: 200 }).filter(
      (r) => r.fill === '#f00',
    )
    expect(overridden.map((r) => r.h)).toEqual(fixed.map((r) => r.h))
  })

  it('clamps a value above the ceiling rather than drawing out of the lane', () => {
    const tall = drawn(parseBarChart(ONE, 'toy.barChart'), frameOf(0, 4000), 'file', {
      min: 0,
      max: 1,
    }).filter((r) => r.fill !== '#333333')
    const full = drawn(parseBarChart(ONE, 'toy.barChart'), frameOf(0, 4000)).filter(
      (r) => r.fill !== '#333333',
    )
    // Both categories are past the ceiling, so both draw the full chart — the
    // same height the tallest bar had when the file's own ceiling was in force.
    expect(tall).toHaveLength(2)
    expect(tall[0].h).toBeCloseTo(full[0].h, 5)
    expect(tall[1].h).toBeCloseTo(full[0].h, 5)
  })

  it('draws nothing below the floor rather than downwards through the baseline', () => {
    const under = drawn(parseBarChart(ONE, 'toy.barChart'), frameOf(0, 4000), 'file', {
      min: 20,
      max: 40,
    })
    // The guide and nothing else: 10.5 and 3.2 are both under the floor.
    expect(under.map((rect) => rect.fill)).toEqual(['#333333'])
  })

  it('never bands a chart lane by strand, because the rows are its axis', () => {
    const stranded = [
      TRACK,
      rows([
        'chrI 1000 2000 a 500 + A 3 9,1,0',
        'chrI 3000 4000 b 500 - B 3 9,1,0',
      ]),
    ].join('\n')
    const frame = frameOf(0, 6000)
    const set = parseBarChart(stranded, 'toy.barChart')
    const rules = featureLayoutFor('barchart', frame.thickness, (n) => n)
    expect(rules.banded).toBe(false)
    const layout = layoutFeatures(frame, axisOf(), set, rules.rows, rules.least, rules.banded)
    // Both features in row 0: banded, the reverse one would sit in a band of
    // its own and lose two thirds of its height.
    expect(layout.placements.map((p) => p.row)).toEqual([0, 0])
  })

  it('gives a short lane one row rather than a stack of unreadable ones', () => {
    expect(featureLayoutFor('barchart', 16, (n) => n).rows).toBe(1)
    expect(featureLayoutFor('barchart', 60, (n) => n).rows).toBeGreaterThan(1)
  })

  it('draws boxes for a set that reached this lane with no chart on it', () => {
    // A stored session restored against a file that was re-read as a BED. The
    // lane must not draw an empty chart, which would assert the values are zero.
    // Unstranded, so the box is a plain rectangle: `drawSegments` cuts an
    // arrowhead out of a stranded one and this recorder only keeps rectangles.
    const flat = [TRACK, rows(['chrI 1000 2000 YAL001C 500 . TFC3 3 10.5,3.2,0'])].join('\n')
    const set = parseBarChart(flat, 'toy.barChart')
    delete set.bars
    const drawnRects = drawn(set, frameOf(0, 4000))
    expect(drawnRects).toHaveLength(1)
    expect(drawnRects[0].fill).toBe(LANE)
  })
})

describe('the demo file', () => {
  const text = readFileSync(join(process.cwd(), 'demo/yeast/Yeast_expression.barChart'), 'utf8')

  it('is recognised as one without being told its name', () => {
    expect(sniffBarChart(text)).toBe(true)
  })

  it('carries a chart per gene over the conditions it names', () => {
    const set = parseBarChart(text, 'Yeast_expression.barChart')
    expect(set.length).toBeGreaterThan(5000)
    expect(set.bars?.named).toBe(true)
    expect(set.bars?.labels).toEqual([
      'YPD',
      'heat_shock',
      'osmotic_stress',
      'diauxic',
      'stationary',
      'sporulation',
    ])
    expect(set.bars?.unit).toBe('TPM')
    expect(set.bars?.unplaced).toBe(0)
    // The contigs are the demo assembly's, so the lane lands on the map the
    // rest of `demo/yeast` opens.
    expect(set.contigs).toContain('IV')
  })

  it('sets a display ceiling under its own tallest bar, so the bulk is readable', () => {
    const set = parseBarChart(text)
    const bars = set.bars!
    let tallest = 0
    for (const value of bars.values) if (value > tallest) tallest = value
    expect(bars.max).toBeLessThan(tallest)
    // …and a good fraction of the file still has something to draw against it.
    let over = 0
    for (let at = 0; at < set.length; at++) if (peakOf(bars, at) > bars.max / 10) over++
    expect(over / set.length).toBeGreaterThan(0.2)
  })
})

/** Feature `at`'s vector, as plain numbers rounded back off `Float32`. */
function valuesAt(set: FeatureSet, at: number): number[] {
  const bars = set.bars
  if (bars === undefined) throw new Error('no bars')
  const width = bars.labels.length
  return Array.from(bars.values.slice(at * width, (at + 1) * width), (value) =>
    Number.isNaN(value) ? Number.NaN : Number(value.toPrecision(7)),
  )
}

/** A one-row file with `width` categories and no track line. */
function manyCategories(width: number): string {
  const values = Array.from({ length: width }, (_, at) => at + 1).join(',')
  return rows([`chrI 1000 2000 g 500 + G ${width} ${values}`])
}

describe('the value axis a reader fixes', () => {
  it('is the lane’s own limits, and absent while they are on auto', () => {
    expect(barLimitsOf({ auto: true, min: 0, max: 50 })).toBeUndefined()
    expect(barLimitsOf({ auto: false, min: 0, max: 50 })).toEqual({ min: 0, max: 50 })
  })

  it('refuses a pair that is not an axis, so a half-typed number draws nothing new', () => {
    expect(barLimitsOf({ auto: false, min: 50, max: 50 })).toBeUndefined()
    expect(barLimitsOf({ auto: false, min: 80, max: 20 })).toBeUndefined()
    expect(barLimitsOf({ auto: false, min: Number.NaN, max: 20 })).toBeUndefined()
  })
})

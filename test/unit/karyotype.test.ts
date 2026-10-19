/**
 * The ideogram view (§5.10): every sequence drawn whole, side by side, with the
 * tracks beside each.
 *
 * The claims are the layout's — one scale for every chromosome, standing in a
 * row or lying in a column, the lanes on the side ideogram.js puts them and
 * fitted to the room by one factor down to a floor, a lane of nothing taking no
 * room — then the curves between two chromosomes, which leave each one across
 * it and are capped as the junction lanes are, the hit test, a chromosome
 * coloured by a track and the box its scale is kept, and the three places the
 * view is kept: the look a reader sets, the word a link carries, and the
 * workspace file.
 */

import { describe, expect, it } from 'vitest'

import type { PairSet } from '@/annotations/types'
import {
  KARYOTYPE_GUTTER,
  KARYOTYPE_LANE_FLOOR,
  KARYOTYPE_PAD,
  TRANS_CAP,
  alongOf,
  drawTransArcs,
  laneIndexAt,
  layoutKaryotype,
  onSequence,
  placeAt,
  type KaryotypeOptions,
  type KaryotypeSequence,
} from '@/render/karyotype'
import { drawKey, measureKey } from '@/render/legend'
import { LocusAxis } from '@/render/locus'
import { drawTrack } from '@/render/tracks'
import { rampCss, TRACK_TINT_RAMP } from '@/structure/colour'
import { DEFAULT_IDEOGRAM_LOOK, IDEOGRAM_WIDTH, readIdeogramLook } from '@/state/ideogramLook'
import { applyConfig, buildConfig, parseTab } from '@/state/SessionConfig'
import { parseViewState, serialiseViewState } from '@/state/ViewState'
import { recall, remember } from '@/state/UiMemory'
import { DEFAULT_UI_PLOT_OPTIONS } from '@/ui/plotOptions'
import type { ViewState } from '@/types'

/** Three chromosomes end to end on one axis, a base pair a unit: 1000, 500 and 250 long. */
const LENGTHS: Array<[string, number]> = [
  ['I', 1000],
  ['II', 500],
  ['III', 250],
]
const SEQUENCES: KaryotypeSequence[] = (() => {
  let at = 0
  return LENGTHS.map(([contig, length]) => {
    const sequence = { contig, unitStart: at, unitEnd: at + length }
    at += length
    return sequence
  })
})()
const AXIS = new LocusAxis(
  SEQUENCES.map((sequence) => ({
    contig: sequence.contig,
    unitStart: sequence.unitStart,
    unitEnd: sequence.unitEnd,
    bpStart: 0,
    bpPerUnit: 1,
    contigLength: sequence.unitEnd - sequence.unitStart,
  })),
)

function options(over: Partial<KaryotypeOptions> = {}): KaryotypeOptions {
  return {
    orientation: 'vertical',
    width: 1000,
    height: 600,
    top: 40,
    names: 20,
    body: 12,
    gap: 14,
    laneGap: 3,
    lanes: [40, 20],
    fit: true,
    length: null,
    ...over,
  }
}

describe('the chromosomes standing in a row', () => {
  const layout = layoutKaryotype(SEQUENCES, options())

  it('draws every chromosome to one scale, the longest filling the room under the names', () => {
    const [one, two, three] = layout.places
    // The room runs from under the key and the names to the padding at the foot.
    expect(one.along0).toBe(40 + 20)
    expect(one.along1).toBeCloseTo(600 - KARYOTYPE_PAD)
    const perBase = (one.along1 - one.along0) / 1000
    expect(layout.perUnit).toBeCloseTo(perBase)
    expect(two.along1 - two.along0).toBeCloseTo(500 * perBase)
    expect(three.along1 - three.along0).toBeCloseTo(250 * perBase)
    // All start level, as ideogram.js's do: a karyotype is read from the top.
    expect(new Set(layout.places.map((place) => place.along0)).size).toBe(1)
  })

  it('puts them in one row, left to right, in the axis’s order, each read downward', () => {
    const xs = layout.places.map((place) => place.body.acrossFrom)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    for (const place of layout.places) {
      expect(place.body.orientation).toBe('right')
      expect(place.body.toPixel(place.unitStart)).toBeCloseTo(place.along0)
      expect(place.body.toPixel(place.unitEnd)).toBeCloseTo(place.along1)
    }
  })

  it('stands each lane to the right of the one before, outward from the chromosome', () => {
    for (const place of layout.places) {
      // The anchors' strip first, on the far side from the lanes.
      expect(place.body.acrossFrom - place.across[0]).toBe(KARYOTYPE_GUTTER)
      const [first, second] = place.lanes
      expect(first.acrossFrom).toBe(place.body.acrossFrom + place.body.thickness + 3)
      expect(second.acrossFrom).toBe(first.acrossFrom + first.thickness + 3)
      expect(place.across[1]).toBe(second.acrossFrom + second.thickness)
    }
  })

  it('keeps the lanes at their own heights where the row has room for them', () => {
    expect(layout.factor).toBe(1)
    expect(layout.lanes).toEqual([40, 20])
    expect(layout.width).toBeLessThanOrEqual(1000)
  })

  it('writes each name over its chromosome, centred', () => {
    for (const place of layout.places) {
      expect(place.name.align).toBe('center')
      expect(place.name.x).toBeCloseTo(place.body.acrossFrom + place.body.thickness / 2)
      expect(place.name.y).toBeLessThan(place.along0)
    }
  })
})

describe('the chromosomes lying in a column', () => {
  const layout = layoutKaryotype(SEQUENCES, options({ orientation: 'horizontal', names: 60, height: 900 }))

  it('reads each left to right from after the names, the longest filling the width', () => {
    const [one] = layout.places
    expect(one.along0).toBe(KARYOTYPE_PAD + 60)
    expect(one.along1).toBeCloseTo(1000 - KARYOTYPE_PAD)
    expect(new Set(layout.places.map((place) => place.along0)).size).toBe(1)
  })

  it('stacks them down the page, with their lanes above them — the standing picture turned', () => {
    const ys = layout.places.map((place) => place.body.acrossFrom)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    for (const place of layout.places) {
      expect(place.body.orientation).toBe('top')
      const [first, second] = place.lanes
      // A `top` frame grows upward from `acrossFrom`: each lane sits over the one before.
      expect(first.acrossFrom).toBe(place.body.acrossFrom - place.body.thickness - 3)
      expect(second.acrossFrom).toBe(first.acrossFrom - first.thickness - 3)
      // The anchors' strip is under the chromosome.
      expect(place.across[1] - place.body.acrossFrom).toBe(KARYOTYPE_GUTTER)
    }
  })

  it('writes each name before its chromosome, set right against it', () => {
    for (const place of layout.places) {
      expect(place.name.align).toBe('right')
      expect(place.name.x).toBeLessThan(place.along0)
    }
  })
})

describe('fitting the lanes to the room', () => {
  it('shrinks every lane by one factor until the row fits, never past the floor', () => {
    // 200 px for three chromosomes: about fifty each, less 21 for the strip and the body.
    const layout = layoutKaryotype(SEQUENCES, options({ width: 200 }))
    expect(layout.factor).toBeLessThan(1)
    expect(layout.width).toBeLessThanOrEqual(200)
    const [wide, narrow] = layout.lanes
    expect(wide).toBeGreaterThanOrEqual(narrow)
    // One factor for both, to the whole pixel under it.
    expect(wide).toBe(Math.max(KARYOTYPE_LANE_FLOOR, Math.floor(40 * layout.factor)))
    expect(narrow).toBe(Math.max(KARYOTYPE_LANE_FLOOR, Math.floor(20 * layout.factor)))
  })

  it('keeps a pixel between the lanes once they are squeezed, and not the gap they have at full height', () => {
    // 300 px is short of the lanes with their gaps, and room enough for them with a pixel between.
    const layout = layoutKaryotype(SEQUENCES, options({ width: 300 }))
    expect(layout.lanes).toEqual([40, 20])
    const [place] = layout.places
    const [first, second] = place.lanes
    expect(first.acrossFrom - (place.body.acrossFrom + place.body.thickness)).toBe(1)
    expect(second.acrossFrom - (first.acrossFrom + first.thickness)).toBe(1)
  })

  it('never grows a lane past its height in the browser, however much room there is', () => {
    const layout = layoutKaryotype(SEQUENCES, options({ width: 5000 }))
    expect(layout.factor).toBe(1)
    expect(layout.lanes).toEqual([40, 20])
  })

  it('holds the floor and reports a picture wider than the room, which the stage scrolls', () => {
    const layout = layoutKaryotype(SEQUENCES, options({ width: 120 }))
    expect(layout.lanes).toEqual([KARYOTYPE_LANE_FLOOR, KARYOTYPE_LANE_FLOOR])
    expect(layout.width).toBeGreaterThan(120)
  })

  it('leaves every lane its height where the reader asked for the browser’s heights', () => {
    const layout = layoutKaryotype(SEQUENCES, options({ width: 120, fit: false }))
    expect(layout.lanes).toEqual([40, 20])
    expect(layout.width).toBeGreaterThan(120)
  })

  it('gives a lane of nothing no room at all, gap and all', () => {
    const layout = layoutKaryotype(SEQUENCES, options({ lanes: [40, 0, 20] }))
    const [place] = layout.places
    const [first, none, last] = place.lanes
    expect(none.thickness).toBe(0)
    expect(last.acrossFrom).toBe(first.acrossFrom + first.thickness + 3)
    const without = layoutKaryotype(SEQUENCES, options({ lanes: [40, 20] }))
    expect(layout.width).toBe(without.width)
  })

  it('draws the longest at the length asked for, the room notwithstanding', () => {
    const layout = layoutKaryotype(SEQUENCES, options({ length: 900 }))
    expect(layout.places[0].along1 - layout.places[0].along0).toBeCloseTo(900)
    expect(layout.height).toBeGreaterThan(600)
  })
})

describe('pointing at a chromosome', () => {
  const layout = layoutKaryotype(SEQUENCES, options())
  const [one, two] = layout.places

  it('finds the chromosome whose column holds the point, and how far down it is', () => {
    const x = one.body.acrossFrom + 2
    const y = (one.along0 + one.along1) / 2
    expect(placeAt(layout, x, y)?.contig).toBe('I')
    expect(alongOf(layout, x, y)).toBe(y)
    expect(placeAt(layout, two.body.acrossFrom + 2, y)?.contig).toBe('II')
  })

  it('is off the sequence past the end of a short chromosome, though still in its column', () => {
    const below = two.along1 + 20
    expect(placeAt(layout, two.body.acrossFrom + 2, below)?.contig).toBe('II')
    expect(onSequence(two, below)).toBe(false)
    expect(onSequence(two, two.along1 - 1)).toBe(true)
  })

  it('says which lane the point is in: -1 on the chromosome, an index in a lane, null between', () => {
    const y = one.along0 + 10
    expect(laneIndexAt(layout, one, one.body.acrossFrom + 1, y)).toBe(-1)
    expect(laneIndexAt(layout, one, one.lanes[0].acrossFrom + 5, y)).toBe(0)
    expect(laneIndexAt(layout, one, one.lanes[1].acrossFrom + 5, y)).toBe(1)
    expect(laneIndexAt(layout, one, one.across[0] + 1, y)).toBeNull()
  })

  it('never answers with a lane of nothing', () => {
    const squeezed = layoutKaryotype(SEQUENCES, options({ lanes: [0, 20] }))
    const place = squeezed.places[0]
    const edge = place.body.acrossFrom + place.body.thickness
    expect(laneIndexAt(squeezed, place, edge + 0.5, place.along0 + 10)).not.toBe(0)
  })
})

/** A pair set from rows of `[contig1, start1, end1, contig2, start2, end2, score]`. */
function pairsOf(rows: Array<[string, number, number, string, number, number, number]>): PairSet {
  const contigs = [...new Set(rows.flatMap((row) => [row[0], row[3]]))]
  const index = (contig: string): number => contigs.indexOf(contig)
  return {
    contigs,
    length: rows.length,
    contig1: Int32Array.from(rows.map((row) => index(row[0]))),
    start1: Int32Array.from(rows.map((row) => row[1])),
    end1: Int32Array.from(rows.map((row) => row[2])),
    contig2: Int32Array.from(rows.map((row) => index(row[3]))),
    start2: Int32Array.from(rows.map((row) => row[4])),
    end2: Int32Array.from(rows.map((row) => row[5])),
    score: Float32Array.from(rows.map((row) => row[6])),
    name: rows.map(() => ''),
    detail: rows.map(() => ''),
  }
}

/** A context that records each curve's start, its two control points and its end, and draws nothing. */
function curveRecorder(): { ctx: CanvasRenderingContext2D; curves: number[][] } {
  const curves: number[][] = []
  let start: number[] = []
  const target = {
    moveTo: (x: number, y: number) => {
      start = [x, y]
    },
    bezierCurveTo: (...points: number[]) => {
      curves.push([...start, ...points])
    },
  } as unknown as CanvasRenderingContext2D
  const ctx = new Proxy(target, {
    get(base, key) {
      const held = Reflect.get(base, key)
      return held !== undefined ? held : () => undefined
    },
    set() {
      return true
    },
  })
  return { ctx, curves }
}

describe('the pairs between two chromosomes', () => {
  const paint = { colour: '#7b3fb0', opacity: 1 }

  it('joins two chromosomes and leaves each across it — a pair on one chromosome is its lane’s', () => {
    const layout = layoutKaryotype(SEQUENCES, options())
    const pairs = pairsOf([
      ['I', 100, 200, 'III', 50, 150, 5],
      ['I', 100, 200, 'I', 600, 700, 5],
    ])
    const { ctx, curves } = curveRecorder()
    expect(drawTransArcs(ctx, layout, AXIS, pairs, paint)).toEqual({ drawn: 1, total: 1 })
    const [[x0, y0, c1x, c1y, c2x, c2y, x1, y1]] = curves
    const [one, , three] = layout.places
    // From the middle of I, at the base pair's height, to the middle of III at its own.
    expect(x0).toBeCloseTo(one.body.acrossFrom + one.body.thickness / 2)
    expect(y0).toBeCloseTo(one.body.toPixel(150))
    expect(x1).toBeCloseTo(three.body.acrossFrom + three.body.thickness / 2)
    expect(y1).toBeCloseTo(three.body.toPixel(three.unitStart + 100))
    // Level at both ends: each control point is at its own end's height, half way across.
    expect(c1y).toBeCloseTo(y0)
    expect(c2y).toBeCloseTo(y1)
    expect(c1x).toBeCloseTo((x0 + x1) / 2)
    expect(c2x).toBeCloseTo((x0 + x1) / 2)
  })

  it('leaves a lying chromosome straight up or down, towards the other', () => {
    const layout = layoutKaryotype(SEQUENCES, options({ orientation: 'horizontal', height: 900 }))
    const { ctx, curves } = curveRecorder()
    drawTransArcs(ctx, layout, AXIS, pairsOf([['I', 100, 200, 'II', 50, 150, 1]]), paint)
    const [[x0, y0, c1x, c1y, c2x, c2y, x1, y1]] = curves
    expect(c1x).toBeCloseTo(x0)
    expect(c2x).toBeCloseTo(x1)
    expect(c1y).toBeCloseTo((y0 + y1) / 2)
    expect(c2y).toBeCloseTo((y0 + y1) / 2)
  })

  it('draws nothing to a chromosome the picture does not have', () => {
    const layout = layoutKaryotype(SEQUENCES.slice(0, 2), options())
    const { ctx, curves } = curveRecorder()
    expect(drawTransArcs(ctx, layout, AXIS, pairsOf([['I', 1, 2, 'III', 1, 2, 1]]), paint)).toEqual({ drawn: 0, total: 0 })
    expect(curves).toHaveLength(0)
  })

  it('draws the strongest few thousand of a pile, and counts the rest', () => {
    const layout = layoutKaryotype(SEQUENCES, options())
    // The ten weakest at the foot of I, where nothing else is; the rest over its first 900 bp.
    const rows: Array<[string, number, number, string, number, number, number]> = []
    for (let i = 0; i < 10; i++) rows.push(['I', 990 + i, 991 + i, 'II', 10, 11, i])
    for (let i = 10; i < TRANS_CAP + 10; i++) rows.push(['I', i % 900, (i % 900) + 1, 'II', 10, 11, 100 + i])
    const { ctx, curves } = curveRecorder()
    expect(drawTransArcs(ctx, layout, AXIS, pairsOf(rows), paint)).toEqual({ drawn: TRANS_CAP, total: TRANS_CAP + 10 })
    const foot = layout.places[0].body.toPixel(990)
    expect(curves.filter((curve) => curve[1] >= foot)).toHaveLength(0)
  })
})

describe('the look a reader sets', () => {
  it('opens on twelve pixels, fourteen apart, the bands where there are some, fitted', () => {
    expect(readIdeogramLook(undefined)).toEqual(DEFAULT_IDEOGRAM_LOOK)
    expect(DEFAULT_IDEOGRAM_LOOK).toMatchObject({ width: 12, gap: 14, length: null, colourBy: 'auto', tracks: 'fit' })
  })

  it('reads a stored look field by field, holding numbers to their bounds and refusing what is not a colour', () => {
    const read = readIdeogramLook({ width: 999, gap: -4, length: 12.4, colour: 'red', colourBy: 'atac', tracks: 'full' })
    expect(read.width).toBe(IDEOGRAM_WIDTH.max)
    expect(read.gap).toBe(0)
    expect(read.length).toBe(40)
    expect(read.colour).toBe(DEFAULT_IDEOGRAM_LOOK.colour)
    expect(read.colourBy).toBe('atac')
    expect(read.tracks).toBe('full')
  })

  it('takes anything it does not know as the default, and an empty colour-by as none chosen', () => {
    const read = readIdeogramLook({ width: '20', length: 'long', colourBy: '', tracks: 'tall', extra: 1 })
    expect(read).toEqual(DEFAULT_IDEOGRAM_LOOK)
  })
})

describe('the ideogram in a link', () => {
  const BASE: ViewState = { uri: 'yeast.cool', view: 'browser', locus: 'IV:1-1000' }

  it('round-trips either way the chromosomes run, after the locus it was opened from', () => {
    for (const ideogram of ['vertical', 'horizontal'] as const) {
      const hash = serialiseViewState({ ...BASE, ideogram })
      expect(hash).toContain(`ideogram=${ideogram}`)
      expect(hash.indexOf('locus=')).toBeLessThan(hash.indexOf('ideogram='))
      expect(parseViewState(hash)).toEqual({ ...BASE, ideogram })
    }
  })

  it('reads a bare ideogram=1 as the ideogram as it opens, and a word it does not draw as the browser', () => {
    expect(parseViewState('#uri=yeast.cool&view=browser&ideogram=1')?.ideogram).toBe('vertical')
    expect(parseViewState('#uri=yeast.cool&view=browser&ideogram=circle')?.ideogram).toBeUndefined()
  })

  it('is absent from a link that is not one', () => {
    expect(serialiseViewState(BASE)).not.toContain('ideogram')
  })
})

describe('the look in a workspace', () => {
  const NOW = new Date('2026-10-19T00:00:00Z')
  const STATE: ViewState = { uri: 'https://example.org/yeast.cool', view: 'browser', ideogram: 'horizontal' }

  it('is saved where it was ever set, and read back field by field', () => {
    const key = 'ideogram|yeast.cool'
    remember(key, 'browser:ideogram', { ...DEFAULT_IDEOGRAM_LOOK, width: 20, colourBy: 'a1' })
    const config = buildConfig({ state: STATE, memoryKey: key, plot: DEFAULT_UI_PLOT_OPTIONS, now: NOW })
    expect(config.ideogram).toMatchObject({ width: 20, colourBy: 'a1' })
    const read = parseTab(JSON.parse(JSON.stringify(config)))
    expect(read?.ideogram).toEqual(config.ideogram)
    expect(read?.state.ideogram).toBe('horizontal')
  })

  it('is left out where nobody set one, and left alone by a workspace that has none', () => {
    const key = 'ideogram|untouched.cool'
    const config = buildConfig({ state: STATE, memoryKey: key, plot: DEFAULT_UI_PLOT_OPTIONS, now: NOW })
    expect('ideogram' in config).toBe(false)
    remember(key, 'browser:ideogram', { ...DEFAULT_IDEOGRAM_LOOK, gap: 30 })
    applyConfig(config, key)
    expect(recall<{ gap: number }>(key, 'browser:ideogram')?.gap).toBe(30)
  })

  it('lands in memory when a workspace carries one', () => {
    const key = 'ideogram|imported.cool'
    const config = parseTab({ state: STATE, ideogram: { width: 30, gap: 'wide' } })
    expect(config?.ideogram).toMatchObject({ width: 30, gap: DEFAULT_IDEOGRAM_LOOK.gap })
    if (config !== null) applyConfig(config, key)
    expect(recall<{ width: number }>(key, 'browser:ideogram')?.width).toBe(30)
  })
})

describe('a chromosome coloured by a track', () => {
  /** A context that records every fill colour a rectangle was filled in, and draws nothing. */
  function fillRecorder(): { ctx: CanvasRenderingContext2D; fills: string[] } {
    const fills: string[] = []
    let style = ''
    const target = {
      fillRect: () => {
        fills.push(style)
      },
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D
    const ctx = new Proxy(target, {
      get(base, key) {
        if (key === 'fillStyle') return style
        const held = Reflect.get(base, key)
        return held !== undefined ? held : () => undefined
      },
      set(_base, key, value) {
        if (key === 'fillStyle') style = String(value)
        return true
      },
    })
    return { ctx, fills }
  }

  it('fills a heatmap with the ramp it is handed in place of a colormap, against the track’s limits', () => {
    const layout = layoutKaryotype(SEQUENCES, options())
    const body = layout.places[0].body
    const profile = {
      from: body.alongFrom,
      mean: Float32Array.from([0, 5, 10, Number.NaN]),
      low: new Float32Array(4),
      high: new Float32Array(4),
      envelope: false,
      variant: null,
      extent: { min: 0, max: 10 },
    }
    const { ctx, fills } = fillRecorder()
    drawTrack(ctx, body, profile, {
      colour: '#d55e00',
      mode: 'heatmap',
      colormap: 'viridis',
      ramp: (t) => rampCss(TRACK_TINT_RAMP, t, '#d55e00'),
      limits: { min: 0, max: 10 },
      guideColour: '#000',
      haloColour: '#fff',
      font: '10px sans-serif',
      opacity: 1,
      fills: true,
      outline: false,
      baseline: false,
      flip: false,
    })
    // White at the floor, the track's own colour at the ceiling, and nothing for a gap.
    expect(fills).toEqual(['rgb(255, 255, 255)', rampCss(TRACK_TINT_RAMP, 0.5, '#d55e00'), 'rgb(213, 94, 0)'])
  })
})

describe('the colour scale’s box', () => {
  it('is measured as the map’s key draws it, so the room kept for it is the room it takes', () => {
    const recorder = curveRecorder()
    const ctx = new Proxy(recorder.ctx, {
      get(base, key) {
        if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
        return Reflect.get(base, key)
      },
      set() {
        return true
      },
    })
    const content = {
      title: 'ATAC',
      lo: 0,
      hi: 40,
      loLabel: '0',
      hiLabel: '40',
      loColor: '#fff',
      hiColor: '#d55e00',
      ramp: ['#fff', '#d55e00'],
    }
    const drawn = drawKey(ctx, 500, 10, content, { font: 'sans-serif', textColor: '#000', background: '#fff', borderColor: '#000' })
    const measured = measureKey(ctx, content, 'sans-serif')
    expect(drawn.width).toBe(measured.width)
    expect(drawn.height).toBe(measured.height)
    expect(drawn.x).toBe(500 - measured.width)
  })
})

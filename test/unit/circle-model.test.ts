/**
 * The map drawn round (§7.6): which sections a block is cut into, what each
 * chord weighs, where everything is laid out, and what the pointer is over.
 *
 * Arithmetic over hand-built blocks, so every number has a reason a reader can
 * check against the matrix it came from: a chord is the sum of the cells
 * between two runs, and a section is a run.
 */

import { describe, expect, it } from 'vitest'
import type { AxisGroup, MatrixResult } from '../../src/worker/protocol'
import {
  CHORD_CAP,
  CHORD_INKED,
  LIGHT_CIRCLE_PALETTE,
  TOP,
  chordBend,
  circleCuts,
  circleGeometry,
  circleModelOf,
  circleUnitsOf,
  fitText,
  hitCircle,
  namePolicy,
  insideRibbon,
  layoutChords,
  litChords,
  midAngle,
  paintLabels,
  partnerWeights,
  unitAtAngle,
  type CircleModel,
} from '../../src/render/circle'
import {
  angleOf,
  binAt,
  binCells,
  binSamples,
  bpAtAngle,
  circleBins,
  featureArcs,
  sequenceAt,
  sequenceIndex,
  paintRing,
  type RingInk,
  type RingPaint,
} from '../../src/render/circleRings'
import type { FeatureSet, TrackSampleSet } from '../../src/annotations/types'
import { ringBlockOrder } from '../../src/ui/ringOrder'

/** A square block from a full symmetric matrix written row by row. */
function block(
  rows: number[][],
  groups: AxisGroup[],
  extra: Partial<MatrixResult> = {},
): MatrixResult {
  const n = rows.length
  return {
    nrows: n,
    ncols: n,
    values: Float32Array.from(rows.flat()),
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: groups,
    colGroups: groups,
    level: 'bin',
    ...extra,
  }
}

const measure = (text: string): number => text.length * 6

describe('the sections a block is cut into', () => {
  it('draws a genome × genome block as one section per genome, sized by the table', () => {
    const data = block(
      [
        [10, 2, 0],
        [2, 20, 5],
        [0, 5, 30],
      ],
      [
        { label: 'A', start: 0, end: 1 },
        { label: 'B', start: 1, end: 2 },
        { label: 'C', start: 2, end: 3 },
      ],
      { level: 'genome' },
    )
    const lengths: Record<string, number> = { A: 1000, B: 3000, C: 2000 }
    const found = circleUnitsOf(data, { genomeLength: (name) => lengths[name] })
    expect(found?.kind).toBe('genome')
    expect(found?.groups).toBeNull()
    expect(found?.units.map((unit) => [unit.name, unit.bp])).toEqual([
      ['A', 1000],
      ['B', 3000],
      ['C', 2000],
    ])
  })

  it('draws a bin-level block divided by genome as its genomes, made of their contigs', () => {
    const contigs: AxisGroup[] = [
      { label: 'a1', start: 0, end: 2, unitLength: 2000 },
      { label: 'a2', start: 2, end: 3, unitLength: 900 },
      { label: 'b1', start: 3, end: 4, unitLength: 1000 },
    ]
    const data = block(
      [
        [1, 1, 1, 2],
        [1, 1, 1, 3],
        [1, 1, 1, 0],
        [2, 3, 0, 9],
      ],
      contigs,
      {
        rowGenomes: [
          { label: 'A', start: 0, end: 3 },
          { label: 'B', start: 3, end: 4 },
        ],
        genomeBoundaries: true,
      },
    )
    const found = circleUnitsOf(data)
    expect(found?.kind).toBe('genome')
    expect(found?.units.map((unit) => unit.name)).toEqual(['A', 'B'])
    expect(found?.units[0].sequences).toEqual([
      { name: 'a1', length: 2000 },
      { name: 'a2', length: 900 },
    ])
    expect(found?.units[0].bp).toBe(2900)
  })

  it('cuts a block divided by genome into its contigs too, grouped under each genome', () => {
    const data = block(
      [
        [1, 1, 1, 2],
        [1, 1, 1, 3],
        [1, 1, 1, 0],
        [2, 3, 0, 9],
      ],
      [
        { label: 'a1', start: 0, end: 2, unitLength: 2000 },
        { label: 'a2', start: 2, end: 3, unitLength: 900 },
        { label: 'b1', start: 3, end: 4, unitLength: 1000 },
      ],
      {
        rowGenomes: [
          { label: 'A', start: 0, end: 3 },
          { label: 'B', start: 3, end: 4 },
        ],
        genomeBoundaries: true,
      },
    )
    expect(circleCuts(data)).toEqual(['genomes', 'contigs'])
    const found = circleUnitsOf(data, {}, 1, 'contigs')
    expect(found?.kind).toBe('contig')
    expect(found?.units.map((unit) => [unit.name, unit.genome, unit.bp])).toEqual([
      ['a1', 'A', 2000],
      ['a2', 'A', 900],
      ['b1', 'B', 1000],
    ])
    expect(found?.groups).toEqual([
      { name: 'A', from: 0, to: 2 },
      { name: 'B', from: 2, to: 3 },
    ])
    // The chords follow the cut: b1's contacts with each of A's contigs.
    const model = circleModelOf(data, {}, 1, CHORD_CAP, 'contigs') as CircleModel
    expect(model.chords).toEqual([
      { a: 0, b: 2, weight: 5 },
      { a: 0, b: 1, weight: 2 },
    ])
  })

  it('offers every other block the one cut its axis is divided by', () => {
    const three = ['A', 'B', 'C'].map((label, index) => ({ label, start: index, end: index + 1 }))
    const square = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]
    expect(circleCuts(block(square, three, { level: 'genome' }))).toEqual(['genomes'])
    expect(circleCuts(block(square, three))).toEqual(['contigs'])
    expect(circleCuts(block(square, three, { ncols: 2 }))).toEqual([])
    // Asked for the cut it does not offer, a genome × genome block is still genomes.
    expect(circleUnitsOf(block(square, three, { level: 'genome' }), {}, 1, 'contigs')?.kind).toBe('genome')
  })

  it('draws one genome, or ticked contigs, as contigs — a pooled run as every contig in it', () => {
    const data = block(
      [
        [4, 1, 0],
        [1, 4, 2],
        [0, 2, 4],
      ],
      [
        { label: 'c1', start: 0, end: 1, unitLength: 5000 },
        { label: 'c2', start: 1, end: 2, unitLength: 3000 },
        {
          label: 'c3',
          start: 2,
          end: 3,
          merged: [
            { label: 'c3', unitLength: 400 },
            { label: 'c4', unitLength: 300 },
          ],
        },
      ],
    )
    const found = circleUnitsOf(data)
    expect(found?.kind).toBe('contig')
    expect(found?.groups).toBeNull()
    expect(found?.units.map((unit) => [unit.name, unit.bp])).toEqual([
      ['c1', 5000],
      ['c2', 3000],
      ['c3', 700],
    ])
  })

  it('groups the contig × contig overview by genome, a pooled slot through the table', () => {
    // The overview stamps its contig picture `genome` and carries the genome
    // runs; a pooled slot is labelled `+N` and named by the contig it starts at.
    const data = block(
      [
        [1, 0, 3],
        [0, 1, 0],
        [3, 0, 1],
      ],
      [
        { label: 'x1 +1', name: 'x1', start: 0, end: 1 },
        { label: 'x3', start: 1, end: 2 },
        { label: 'y1', start: 2, end: 3 },
      ],
      {
        level: 'genome',
        rowGenomes: [
          { label: 'X', start: 0, end: 2 },
          { label: 'Y', start: 2, end: 3 },
        ],
        genomeBoundaries: true,
      },
    )
    const lengths: Record<string, number> = { x1: 100, x2: 50, x3: 70, y1: 300 }
    const found = circleUnitsOf(data, {
      slotSequences: (first, next) =>
        first === 'x1' && next === 'x3'
          ? [
              { name: 'x1', length: 100 },
              { name: 'x2', length: 50 },
            ]
          : null,
      contigLength: (name) => lengths[name],
    })
    expect(found?.kind).toBe('contig')
    expect(found?.units.map((unit) => [unit.name, unit.label, unit.genome, unit.bp])).toEqual([
      ['x1', 'x1 +1', 'X', 150],
      ['x3', 'x3', 'X', 70],
      ['y1', 'y1', 'Y', 300],
    ])
    expect(found?.groups).toEqual([
      { name: 'X', from: 0, to: 2 },
      { name: 'Y', from: 2, to: 3 },
    ])
  })

  it('refuses a rectangle, a block read round a circle and a single section', () => {
    const groups: AxisGroup[] = [{ label: 'A', start: 0, end: 2 }]
    const square = block(
      [
        [1, 1],
        [1, 1],
      ],
      groups,
    )
    expect(circleUnitsOf(square)).toBeNull()
    expect(circleUnitsOf({ ...square, colExtent: [2, 4] })).toBeNull()
    expect(
      circleUnitsOf({
        ...square,
        rowGroups: [
          { label: 'A', start: 0, end: 1 },
          { label: 'B', start: 1, end: 2 },
        ],
        colGroups: [
          { label: 'A', start: 0, end: 1 },
          { label: 'B', start: 1, end: 2 },
        ],
        wrapped: [0, 2],
      }),
    ).toBeNull()
  })
})

describe('the chords', () => {
  const genomes = block(
    [
      [10, 2, 0, 7],
      [2, 20, 5, 0],
      [0, 5, 30, Number.NaN],
      [7, 0, Number.NaN, 1],
    ],
    ['A', 'B', 'C', 'D'].map((label, index) => ({ label, start: index, end: index + 1 })),
    { level: 'genome' },
  )

  it('weighs each pair by the cells between them, strongest first, skipping a filtered cell', () => {
    const model = circleModelOf(genomes) as CircleModel
    expect(model.chords).toEqual([
      { a: 0, b: 3, weight: 7 },
      { a: 1, b: 2, weight: 5 },
      { a: 0, b: 1, weight: 2 },
    ])
    expect(model.pairs).toBe(3)
    expect([...model.intra]).toEqual([10, 20, 30, 1])
    expect([...model.inter]).toEqual([9, 7, 5, 7])
  })

  it('sums every cell between two runs of several cells, once, from the upper triangle', () => {
    const data = block(
      [
        [1, 1, 2, 2],
        [1, 1, 2, 2],
        [2, 2, 1, 1],
        [2, 2, 1, 1],
      ],
      [
        { label: 'p', start: 0, end: 2, unitLength: 10 },
        { label: 'q', start: 2, end: 4, unitLength: 10 },
      ],
    )
    const model = circleModelOf(data) as CircleModel
    expect(model.chords).toEqual([{ a: 0, b: 1, weight: 8 }])
    // Each run's own triangle, its diagonal included: 1 + 1 + 1.
    expect([...model.intra]).toEqual([3, 3])
  })

  it('keeps only the strongest the cap allows, and still counts every pair', () => {
    const model = circleModelOf(genomes, {}, 1, 2) as CircleModel
    expect(model.chords.map((chord) => chord.weight)).toEqual([7, 5])
    expect(model.pairs).toBe(3)
    expect(CHORD_CAP).toBeGreaterThanOrEqual(1128)
  })

  it('lights a section’s chords and weighs its partners', () => {
    const model = circleModelOf(genomes) as CircleModel
    const geometry = circleGeometry(model, { width: 400, height: 400, rings: [], measure, fontPx: 11 })
    const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'none', colormap: 'default' })
    const lit = litChords(model, chords, { unit: 0, slot: -1, group: -1 })
    const partners = [...(lit ?? [])].map((slot) => model.chords[chords.order[slot]])
    expect(partners.map((chord) => [chord.a, chord.b]).sort()).toEqual([
      [0, 1],
      [0, 3],
    ])
    expect([...(partnerWeights(model, { unit: 0, slot: -1, group: -1 }) ?? [])]).toEqual([0, 2, 0, 7])
  })
})

describe('the layout', () => {
  const model = circleModelOf(
    block(
      [
        [1, 3, 1],
        [3, 1, 2],
        [1, 2, 1],
      ],
      ['A', 'B', 'C'].map((label, index) => ({ label, start: index, end: index + 1 })),
      { level: 'genome' },
    ),
    { genomeLength: (name) => ({ A: 1000, B: 2000, C: 1000 })[name] },
  ) as CircleModel

  it('gives each section its share of the circle by length, from twelve o’clock, with gaps', () => {
    const geometry = circleGeometry(model, { width: 500, height: 400, rings: [], measure, fontPx: 11 })
    expect(geometry.cx).toBe(250)
    expect(geometry.cy).toBe(200)
    const spans = [0, 1, 2].map((u) => geometry.arcs[2 * u + 1] - geometry.arcs[2 * u])
    expect(spans[1] / spans[0]).toBeCloseTo(2, 6)
    expect(spans[2] / spans[0]).toBeCloseTo(1, 6)
    expect(geometry.arcs[0]).toBeCloseTo(TOP + geometry.topGap / 2, 9)
    // Sections in order round the circle, never overlapping.
    for (let u = 1; u < 3; u++) expect(geometry.arcs[2 * u]).toBeGreaterThan(geometry.arcs[2 * u - 1])
    // The last section stops short of the gap left open at twelve.
    expect(geometry.arcs[5]).toBeCloseTo(TOP + 2 * Math.PI - geometry.topGap / 2, 9)
  })

  it('stacks the rings between the sections and the chords, the first nearest the chords', () => {
    const geometry = circleGeometry(model, {
      width: 600,
      height: 600,
      rings: [
        { id: 'first', size: 56 },
        { id: 'second', size: 20 },
      ],
      measure,
      fontPx: 11,
    })
    const [first, second] = geometry.rings
    expect(first.id).toBe('first')
    expect(second.id).toBe('second')
    expect(geometry.chord).toBeLessThan(first.inner)
    expect(first.outer).toBeLessThan(second.inner)
    expect(second.outer).toBeLessThan(geometry.sections.inner)
    expect(geometry.sections.outer).toBeLessThan(geometry.labelAt)
    // As thick as its lane is tall where they fit — past a sixth of the radius
    // too, which no longer holds a lane under its height.
    expect(second.outer - second.inner).toBeCloseTo(20, 6)
    expect(first.outer - first.inner).toBeCloseTo(56, 6)
    expect(56).toBeGreaterThan(geometry.outer * 0.16)
  })

  it('shares out the room in proportion to the lanes where they do not fit', () => {
    const geometry = circleGeometry(model, {
      width: 300,
      height: 300,
      rings: [
        { id: 'first', size: 90 },
        { id: 'second', size: 30 },
        { id: 'third', size: 30 },
      ],
      measure,
      fontPx: 11,
    })
    // Every lane's height times the share of it the room allows, and never
    // under six pixels.
    const scale = geometry.ringRoom / 150
    expect(scale).toBeLessThan(1)
    ;[90, 30, 30].forEach((size, k) => {
      const ring = geometry.rings[k]
      expect(ring.outer - ring.inner).toBeCloseTo(Math.max(size * scale, 6), 6)
    })
    const total = geometry.rings.reduce((sum, ring) => sum + (ring.outer - ring.inner), 0)
    expect(total).toBeLessThanOrEqual(geometry.ringRoom + 1e-9)
  })

  it('seats every chord’s two ends inside the sections it joins, weakest drawn first', () => {
    const geometry = circleGeometry(model, { width: 400, height: 400, rings: [], measure, fontPx: 11 })
    const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'log1p', colormap: 'default' })
    expect(chords.drawn).toBe(3)
    const weights = [...chords.order].map((index) => model.chords[index].weight)
    expect(weights).toEqual([...weights].sort((x, y) => x - y))
    for (let slot = 0; slot < chords.drawn; slot++) {
      const chord = model.chords[chords.order[slot]]
      for (const [end, unit] of [
        [0, chord.a],
        [2, chord.b],
      ] as const) {
        const centre = chords.ends[slot * 4 + end]
        const half = chords.ends[slot * 4 + end + 1]
        expect(centre - half).toBeGreaterThanOrEqual(geometry.arcs[2 * unit] - 1e-9)
        expect(centre + half).toBeLessThanOrEqual(geometry.arcs[2 * unit + 1] + 1e-9)
      }
    }
    // The strongest is the top of the ramp.
    expect(chords.strength[chords.drawn - 1]).toBeCloseTo(1, 6)
  })

  it('draws only the strongest asked for', () => {
    const geometry = circleGeometry(model, { width: 400, height: 400, rings: [], measure, fontPx: 11 })
    const chords = layoutChords(model, geometry, { limit: 1, transform: 'log1p', colormap: 'default' })
    expect(chords.drawn).toBe(1)
    expect(model.chords[chords.order[0]].weight).toBe(3)
  })
})

describe('the ink', () => {
  /** `n` genomes, every pair sharing a different number of contacts. */
  function everyPair(n: number): CircleModel {
    const rows = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : 1 + Math.min(i, j) * n + Math.max(i, j))),
    )
    const groups = Array.from({ length: n }, (_, index) => ({ label: `g${index}`, start: index, end: index + 1 }))
    return circleModelOf(block(rows, groups, { level: 'genome' })) as CircleModel
  }
  const inked = (model: CircleModel): number => {
    const geometry = circleGeometry(model, { width: 600, height: 600, rings: [], measure, fontPx: 11 })
    const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'none', colormap: 'default' })
    return [...chords.strength].filter((strength) => strength > 0).length
  }

  it('spends the ramp on the stronger half of a hundred or more chords', () => {
    const model = everyPair(18)
    expect(model.chords).toHaveLength(153)
    expect(inked(model)).toBe(76)
  })

  it('inks no more than a few hundred, however many are drawn', () => {
    const model = everyPair(60)
    expect(model.chords).toHaveLength(1770)
    expect(inked(model)).toBeLessThanOrEqual(CHORD_INKED)
    expect(inked(model)).toBeGreaterThan(CHORD_INKED - 5)
  })

  it('never draws a chord narrower than a hairline, however short its section', () => {
    const model = everyPair(60)
    const geometry = circleGeometry(model, { width: 300, height: 300, rings: [], measure, fontPx: 11 })
    const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'none', colormap: 'default' })
    let narrowest = Number.POSITIVE_INFINITY
    for (let slot = 0; slot < chords.drawn; slot++) {
      narrowest = Math.min(narrowest, chords.ends[slot * 4 + 1], chords.ends[slot * 4 + 3])
    }
    expect(2 * narrowest * geometry.chord).toBeGreaterThanOrEqual(0.7 - 1e-9)
  })
})

describe('the names round the outside', () => {
  /** A context that keeps what was written and in which font, and draws nothing. */
  function recorder(): { ctx: CanvasRenderingContext2D; written: Array<{ text: string; font: string }> } {
    const written: Array<{ text: string; font: string }> = []
    const ctx = {
      font: '',
      textAlign: 'left',
      textBaseline: 'middle',
      lineWidth: 1,
      lineJoin: 'round',
      strokeStyle: '',
      fillStyle: '',
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      strokeText() {},
      measureText: (text: string) => ({ width: measure(text) }),
      fillText(text: string) {
        written.push({ text, font: ctx.font })
      },
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, written }
  }

  it('cuts a long name in its middle, so both ends stay', () => {
    const { ctx } = recorder()
    expect(fitText(ctx, 'metator_00002_00004', 60)).toBe('metat…0004')
    expect(fitText(ctx, 'short', 60)).toBe('short')
  })

  it('names a lit section and its partners, but never one over another', () => {
    // Forty sections, all named by the rule but only the first one long enough
    // to carry its name at rest: the room kept for it is what a hover writes
    // in. The twentieth's two strongest partners are its neighbours, and its
    // third is across the circle.
    const n = 40
    const rows = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const link = (i: number, j: number, weight: number): void => {
      rows[i][j] = weight
      rows[j][i] = weight
    }
    link(20, 19, 100)
    link(20, 21, 90)
    link(20, 30, 80)
    const groups = Array.from({ length: n }, (_, index) => ({ label: `s${index}`, start: index, end: index + 1 }))
    const model = circleModelOf(block(rows, groups, { level: 'genome' }), {
      genomeLength: (name) => (name === 's0' ? 100_000 : 1_000),
    }) as CircleModel
    const geometry = circleGeometry(model, { width: 400, height: 400, rings: [], measure, fontPx: 11 })
    expect(geometry.names).toBe(true)
    expect([...geometry.labelled].filter((named) => named === 1)).toHaveLength(1)
    const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'none', colormap: 'default' })
    const { ctx, written } = recorder()
    paintLabels(ctx, {
      model,
      geometry,
      palette: LIGHT_CIRCLE_PALETTE,
      focus: { unit: 20, slot: -1, group: -1 },
      chords,
      colormap: 'default',
      transform: 'none',
      font: '11px sans-serif',
      boldFont: '600 11px sans-serif',
    })
    const names = written.filter((entry) => entry.text.startsWith('s'))
    expect(names.map((entry) => entry.text)).toEqual(['s20', 's30', 's0'])
    expect(names[0].font).toBe('600 11px sans-serif')
  })

  it('names every section of a small circle, the long contigs of a large one, and no genome past fifty', () => {
    const sections = (n: number, level: MatrixResult['level'], length: (index: number) => number): CircleModel => {
      const rows = Array.from({ length: n }, () => new Array<number>(n).fill(1))
      const groups = Array.from({ length: n }, (_, index) => ({
        label: `u${index}`,
        start: index,
        end: index + 1,
        unitLength: length(index),
      }))
      return circleModelOf(block(rows, groups, { level }), {
        genomeLength: (name) => length(Number(name.slice(1))),
      }) as CircleModel
    }
    expect(namePolicy(sections(48, 'genome', () => 4e6))).toBe('all')
    expect(namePolicy(sections(51, 'genome', () => 4e6))).toBe('none')
    // One genome's contigs, past fifty: the long ones.
    const contigs = sections(208, 'bin', (index) => (index < 10 ? 120_000 : 8_000))
    expect(namePolicy(contigs)).toBe('long')
    const geometry = circleGeometry(contigs, { width: 900, height: 900, rings: [], measure, fontPx: 11 })
    for (let u = 0; u < 208; u++) if (geometry.labelled[u] === 1) expect(contigs.units[u].bp).toBeGreaterThanOrEqual(50_000)
    expect([...geometry.labelled].some((named) => named === 1)).toBe(true)
  })

  it('keeps no room for names a circle of thousands of genomes cannot give, nor with the labels off', () => {
    const n = 2000
    const rows = Array.from({ length: n }, () => new Float32Array(n).fill(1))
    const groups = Array.from({ length: n }, (_, index) => ({ label: `metator_${index}`, start: index, end: index + 1 }))
    const many = circleModelOf(
      {
        nrows: n,
        ncols: n,
        values: Float32Array.from(rows.flatMap((row) => [...row])),
        rowExtent: [0, n],
        colExtent: [0, n],
        rowGroups: groups,
        colGroups: groups,
        level: 'genome',
      },
      // One genome a hundred times the others: large enough to carry a name,
      // and still not named.
      { genomeLength: (name) => (name === 'metator_0' ? 4e8 : 4e6) },
      1,
      50,
    ) as CircleModel
    const crowded = circleGeometry(many, { width: 800, height: 800, rings: [], measure, fontPx: 11 })
    expect(crowded.names).toBe(false)
    expect(crowded.labelAt).toBe(crowded.outer)
    expect([...crowded.labelled].every((named) => named === 0)).toBe(true)
    // The mock community's forty-eight, with the labels overlay off.
    const few = circleModelOf(
      block(
        [
          [1, 1],
          [1, 1],
        ],
        [
          { label: 'A', start: 0, end: 1 },
          { label: 'B', start: 1, end: 2 },
        ],
        { level: 'genome' },
      ),
    ) as CircleModel
    const on = circleGeometry(few, { width: 400, height: 400, rings: [], measure, fontPx: 11 })
    const off = circleGeometry(few, { width: 400, height: 400, rings: [], measure, fontPx: 11, names: false })
    expect(on.names).toBe(true)
    expect(off.names).toBe(false)
    expect(off.sections.outer).toBeGreaterThan(on.sections.outer)
    // And with no room, not even a hover writes a name.
    const { ctx, written } = recorder()
    paintLabels(ctx, {
      model: few,
      geometry: off,
      palette: LIGHT_CIRCLE_PALETTE,
      focus: { unit: 0, slot: -1, group: -1 },
      chords: layoutChords(few, off, { limit: Infinity, transform: 'none', colormap: 'default' }),
      colormap: 'default',
      transform: 'none',
      font: '11px sans-serif',
      boldFont: '600 11px sans-serif',
    })
    expect(written.filter((entry) => /^[AB]$/.test(entry.text))).toEqual([])
  })

  it('keeps a lit genome’s name over a partner beside it', () => {
    // Genome A is one short contig, B two hundred; A's only partner is B's first
    // contig, a few degrees round, where its name would cover A's.
    const n = 201
    const rows = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    rows[0][1] = 50
    rows[1][0] = 50
    const groups = Array.from({ length: n }, (_, index) => ({
      label: index === 0 ? 'a1' : `b${index}`,
      start: index,
      end: index + 1,
      unitLength: index === 0 ? 100 : 1000,
    }))
    const data = block(rows, groups, {
      level: 'contig',
      rowGenomes: [
        { label: 'A', start: 0, end: 1 },
        { label: 'B', start: 1, end: n },
      ],
    })
    const model = circleModelOf(data) as CircleModel
    expect(model.groups?.map((group) => group.name)).toEqual(['A', 'B'])
    const geometry = circleGeometry(model, { width: 400, height: 400, rings: [], measure, fontPx: 11 })
    const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'none', colormap: 'default' })
    const { ctx, written } = recorder()
    paintLabels(ctx, {
      model,
      geometry,
      palette: LIGHT_CIRCLE_PALETTE,
      focus: { unit: -1, slot: -1, group: 0 },
      chords,
      colormap: 'default',
      transform: 'none',
      font: '11px sans-serif',
      boldFont: '600 11px sans-serif',
    })
    const names = written.map((entry) => entry.text).filter((text) => !/^\d/.test(text))
    expect(names[0]).toBe('A')
    expect(names).not.toContain('b1')
  })
})

describe('what the pointer is over', () => {
  const model = circleModelOf(
    block(
      [
        [1, 9, 0],
        [9, 1, 0],
        [0, 0, 1],
      ],
      ['A', 'B', 'C'].map((label, index) => ({ label, start: index, end: index + 1 })),
      { level: 'genome' },
    ),
    { genomeLength: () => 1000 },
  ) as CircleModel
  const geometry = circleGeometry(model, { width: 400, height: 400, rings: [{ id: 'r', size: 40 }], measure, fontPx: 11 })
  const chords = layoutChords(model, geometry, { limit: Infinity, transform: 'none', colormap: 'default' })
  const at = (radius: number, angle: number): [number, number] => [
    geometry.cx + Math.cos(angle) * radius,
    geometry.cy + Math.sin(angle) * radius,
  ]

  it('finds a section by its angle, and nothing in a gap', () => {
    const middle = (geometry.sections.inner + geometry.sections.outer) / 2
    expect(hitCircle(geometry, model, chords, ...at(middle, midAngle(geometry, 1)))).toEqual({
      kind: 'section',
      unit: 1,
    })
    expect(unitAtAngle(geometry, TOP)).toBe(-1)
    expect(hitCircle(geometry, model, chords, ...at(middle, TOP))).toBeNull()
  })

  it('treats a label as its section, and a ring by its radius', () => {
    const label = geometry.labelAt + 4
    expect(hitCircle(geometry, model, chords, ...at(label, midAngle(geometry, 2)))).toEqual({
      kind: 'section',
      unit: 2,
    })
    const ring = geometry.rings[0]
    const hit = hitCircle(geometry, model, chords, ...at((ring.inner + ring.outer) / 2, midAngle(geometry, 0)))
    expect(hit?.kind).toBe('ring')
  })

  it('finds a chord inside its ribbon and not beside it', () => {
    // A → B: each edge of the ribbon is a quadratic from one end to the other
    // through the chord's bend, so its middle is a quarter of each end and half
    // the bend — and halfway between the two edges' middles is inside.
    const slot = 0
    const aMid = chords.ends[0]
    const aHalf = chords.ends[1]
    const bMid = chords.ends[2]
    const bHalf = chords.ends[3]
    const r = geometry.chord
    const rim = (angle: number): [number, number] => [geometry.cx + Math.cos(angle) * r, geometry.cy + Math.sin(angle) * r]
    const bend = chordBend(geometry.cx, geometry.cy, r, aMid, bMid)
    const middle = (from: number, to: number): [number, number] => {
      const [x0, y0] = rim(from)
      const [x1, y1] = rim(to)
      return [0.25 * x0 + 0.5 * bend.x + 0.25 * x1, 0.25 * y0 + 0.5 * bend.y + 0.25 * y1]
    }
    const one = middle(aMid + aHalf, bMid - bHalf)
    const other = middle(bMid + bHalf, aMid - aHalf)
    const inside: [number, number] = [(one[0] + other[0]) / 2, (one[1] + other[1]) / 2]
    expect(insideRibbon(geometry, chords, slot, ...inside)).toBe(true)
    expect(hitCircle(geometry, model, chords, ...inside)).toEqual({ kind: 'chord', slot })
    const opposite = at(geometry.chord * 0.55, (aMid + bMid) / 2 + Math.PI)
    expect(insideRibbon(geometry, chords, slot, ...opposite)).toBe(false)
  })

  it('bends a chord between neighbours under the rim, and one across through the middle', () => {
    const { cx, cy } = geometry
    const r = 100
    const depth = (a: number, b: number): number => {
      const bend = chordBend(cx, cy, r, a, b)
      return Math.hypot(bend.x - cx, bend.y - cy) / r
    }
    expect(depth(0, Math.PI)).toBeCloseTo(0, 6)
    expect(depth(0, 0.05)).toBeGreaterThan(0.85)
    // The short way round, whichever end comes first.
    const bend = chordBend(cx, cy, r, 0.1, Math.PI * 2 - 0.1)
    expect(bend.x).toBeGreaterThan(cx)
    expect(Math.abs(bend.y - cy)).toBeLessThan(1e-9)
  })
})

describe('the rings', () => {
  const model = circleModelOf(
    block(
      [
        [1, 1],
        [1, 1],
      ],
      [
        { label: 'A', start: 0, end: 1 },
        { label: 'B', start: 1, end: 2 },
      ],
      { level: 'genome' },
    ),
    {
      genomeSequences: (genome) =>
        genome === 'A'
          ? [
              { name: 'a1', length: 600 },
              { name: 'a2', length: 400 },
            ]
          : [{ name: 'b1', length: 1000 }],
    },
  ) as CircleModel
  const geometry = circleGeometry(model, { width: 400, height: 400, rings: [{ id: 'r', size: 40 }], measure, fontPx: 11 })
  const bins = circleBins(model, geometry, 10)
  const index = sequenceIndex(model)

  it('cuts each section into bins of equal base pairs, laid along its arc', () => {
    expect(bins.count).toBe(10)
    expect([...bins.first]).toEqual([0, 5, 10])
    expect(bins.from[1]).toBeCloseTo(200)
    expect(bins.to[4]).toBeCloseTo(1000)
    expect(bins.a0[0]).toBeCloseTo(geometry.arcs[0])
    expect(bins.a1[4]).toBeCloseTo(geometry.arcs[1])
  })

  it('reduces a signal into each bin by the bases each value covers', () => {
    const samples: TrackSampleSet = {
      basesPerPixel: 1,
      extent: null,
      regions: [
        {
          contig: 'a2',
          start: 0,
          end: 400,
          // a2 starts 600 bp into A, so bin 3 (600–800 bp) is its first 100 bp
          // at 2 and the next 100 at 6, and bin 4 (800–1000 bp) is all 6.
          starts: Int32Array.from([0, 100]),
          ends: Int32Array.from([100, 400]),
          values: Float32Array.from([2, 6]),
          min: null,
          max: null,
          variant: null,
          summary: false,
        },
      ],
    }
    const binned = binSamples(samples, bins, index)
    expect(Number.isNaN(binned.values[0])).toBe(true)
    expect(binned.values[3]).toBeCloseTo(4)
    expect(binned.values[4]).toBeCloseTo(6)
    expect(binned.extent).toEqual({ min: 4, max: 6 })
  })

  it('broadcasts a column per sequence onto its bins, and votes a category by base pairs', () => {
    const quantities = binCells({ kind: 'quantitative', values: Float64Array.from([1, 3, 5]), extent: null }, model, bins)
    expect(quantities.kind).toBe('quantitative')
    if (quantities.kind !== 'quantitative') return
    // Bin 2 of A is 400–600 bp: all a1.
    expect(quantities.values[2]).toBeCloseTo(1)
    // Bin 3 is 600–800 bp: all a2.
    expect(quantities.values[3]).toBeCloseTo(3)
    expect(quantities.values[7]).toBeCloseTo(5)
    const classes = binCells({ kind: 'qualitative', codes: Int32Array.from([0, 1, 1]), levels: ['x', 'y'] }, model, bins)
    expect(classes.kind).toBe('qualitative')
    if (classes.kind === 'qualitative') expect([...classes.codes]).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1])
  })

  it('places a feature at its own coordinates, and reads an angle back to a base', () => {
    const set = {
      contigs: ['b1'],
      contigAt: Int32Array.from([0, 1]),
      start: Int32Array.from([250]),
      end: Int32Array.from([500]),
    } as unknown as FeatureSet
    const [arc] = featureArcs(set, model, geometry, index)
    expect(arc.a0).toBeCloseTo(angleOf(geometry, model, 1, 250))
    expect(arc.a1).toBeCloseTo(angleOf(geometry, model, 1, 500))
    expect(bpAtAngle(geometry, model, 1, arc.a0)).toBeCloseTo(250)
    expect(sequenceAt(model, 0, 700)).toEqual({ name: 'a2', position: 100, length: 400 })
    expect(binAt(bins, 1, arc.a0 + 2 * Math.PI)).toBe(6)
  })

  /** A context that records every fill and stroke and the style it was made in. */
  function inked(): { ctx: CanvasRenderingContext2D; marks: Array<{ op: 'fill' | 'stroke'; style: string; width: number }> } {
    const marks: Array<{ op: 'fill' | 'stroke'; style: string; width: number }> = []
    const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 }
    const ctx = new Proxy(state, {
      get: (target, key: string) => {
        if (key in target) return target[key]
        if (key === 'fill') return () => marks.push({ op: 'fill', style: String(target.fillStyle), width: 0 })
        if (key === 'stroke') {
          return () => marks.push({ op: 'stroke', style: String(target.strokeStyle), width: Number(target.lineWidth) })
        }
        return () => {}
      },
      set: (target, key: string, value) => {
        target[key] = value
        return true
      },
    })
    return { ctx: ctx as unknown as CanvasRenderingContext2D, marks }
  }
  const area = (mode: 'area' | 'bar'): RingPaint => ({
    id: 'r',
    label: 'r',
    colour: '#d55e00',
    opacity: 1,
    content: {
      kind: 'values',
      values: { kind: 'quantitative', values: Float32Array.from([1, 2, 3, 2, 1, 1, 2, 3, 2, 1]), extent: { min: 1, max: 3 } },
      limits: { min: 0, max: 3 },
      mode,
      colormap: 'default',
      flip: false,
    },
  })
  const ink = (patch: Partial<RingInk>): RingInk => ({ guide: '#222', fills: true, outline: true, baseline: true, ...patch })
  const band = geometry.rings[0]

  it('fills an area ring and outlines its profile in the plot’s ink, as a lane does', () => {
    const { ctx, marks } = inked()
    paintRing(ctx, area('area'), band, geometry, bins, '#eee', ink({ baseline: false }))
    const fills = marks.filter((mark) => mark.op === 'fill' && mark.style === '#d55e00')
    const strokes = marks.filter((mark) => mark.op === 'stroke')
    // A fill and an outline a section.
    expect(fills).toHaveLength(2)
    expect(strokes.map((mark) => [mark.style, mark.width])).toEqual([
      ['#222', 0.75],
      ['#222', 0.75],
    ])
  })

  it('leaves the line alone with fills off, in its own colour with the outline off', () => {
    const { ctx, marks } = inked()
    paintRing(ctx, area('area'), band, geometry, bins, '#eee', ink({ fills: false, outline: false, baseline: false }))
    expect(marks.filter((mark) => mark.op === 'fill' && mark.style === '#d55e00')).toHaveLength(0)
    expect(marks.filter((mark) => mark.op === 'stroke').map((mark) => mark.style)).toEqual(['#d55e00', '#d55e00'])
  })

  it('outlines bars along their tops, a line a section, and draws the floor under them', () => {
    const { ctx, marks } = inked()
    paintRing(ctx, area('bar'), band, geometry, bins, null, ink({}))
    // Bars stay filled whatever `fills` says; no wash where none is asked for.
    expect(marks.filter((mark) => mark.op === 'fill')).toHaveLength(10)
    const strokes = marks.filter((mark) => mark.op === 'stroke')
    // Two tops and one floor — not a box round every bar.
    expect(strokes).toHaveLength(3)
    const { ctx: bare, marks: none } = inked()
    paintRing(bare, area('bar'), band, geometry, bins, null, ink({ outline: false, baseline: false }))
    expect(none.filter((mark) => mark.op === 'stroke')).toHaveLength(0)
  })
})

describe('a ring moved', () => {
  it('moves its tracks as one block, after the other ring going out and before it going in', () => {
    // The overlay group g is a and c; b and d are rings of their own, x is a
    // track drawn on no map.
    const order = ['a', 'b', 'x', 'c', 'd']
    expect(ringBlockOrder(order, ['a', 'c'], ['d'], true)).toEqual(['b', 'x', 'd', 'a', 'c'])
    expect(ringBlockOrder(order, ['d'], ['a', 'c'], false)).toEqual(['d', 'a', 'b', 'x', 'c'])
    expect(ringBlockOrder(order, ['b'], ['d'], true)).toEqual(['a', 'x', 'c', 'd', 'b'])
    // Nothing to move, or nowhere to move it: as it was.
    expect(ringBlockOrder(order, ['q'], ['d'], true)).toEqual(order)
    expect(ringBlockOrder(order, ['a'], ['q'], true)).toEqual(order)
  })
})

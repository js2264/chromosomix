/**
 * Where the circle's rings go and how a ring is resized (§7.6): inside the
 * sections or outside them, the sections then the inner circle round the
 * chords; what the pointer is over either way; a ring's foot — its inner
 * edge — which a drag moves; and the rings' names in a column before twelve
 * o'clock, the arcs starting on it and ending short of them.
 *
 * Arithmetic over hand-built circles, as `circle-model.test.ts` is.
 */

import { describe, expect, it } from 'vitest'
import type { AxisGroup, MatrixResult } from '../../src/worker/protocol'
import {
  CHORD_CAP,
  COLUMN_MAX,
  COLUMN_PAD,
  TOP,
  carryRadius,
  columnReach,
  fromTwelve,
  circleGeometry,
  circleModelOf,
  hitCircle,
  radialCursor,
  radialStops,
  ringEdgeAt,
  ringNamePx,
  ringScale,
  ringThickness,
  type CircleGeometry,
  type CircleModel,
} from '../../src/render/circle'

const measure = (text: string): number => text.length * 6

/** Three genomes of 1, 2 and 1 kb, every pair in contact. */
function threeGenomes(): CircleModel {
  const groups: AxisGroup[] = ['A', 'B', 'C'].map((label, index) => ({ label, start: index, end: index + 1 }))
  const data: MatrixResult = {
    nrows: 3,
    ncols: 3,
    values: Float32Array.from([1, 3, 1, 3, 1, 2, 1, 2, 1]),
    rowExtent: [0, 3],
    colExtent: [0, 3],
    rowGroups: groups,
    colGroups: groups,
    level: 'genome',
  }
  return circleModelOf(data, { genomeLength: (name) => ({ A: 1000, B: 2000, C: 1000 })[name] }) as CircleModel
}

/** Two genomes of three contigs each, cut into their contigs under a band. */
function banded(): CircleModel {
  const n = 6
  const runs = Array.from({ length: n }, (_, index) => ({ label: `c${index}`, start: index, end: index + 1, unitLength: 1000 }))
  const data: MatrixResult = {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n).fill(1),
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: runs,
    colGroups: runs,
    level: 'bin',
    rowGenomes: [
      { label: 'A', start: 0, end: 3 },
      { label: 'B', start: 3, end: 6 },
    ],
    genomeBoundaries: true,
  }
  return circleModelOf(data, {}, 1, CHORD_CAP, 'contigs') as CircleModel
}

const RINGS = [
  { id: 'first', size: 30 },
  { id: 'second', size: 20 },
  { id: 'third', size: 40 },
]

const at = (geometry: CircleGeometry, r: number, angle: number): [number, number] => [
  geometry.cx + Math.cos(angle) * r,
  geometry.cy + Math.sin(angle) * r,
]

describe('the rings outside the sections', () => {
  const model = threeGenomes()
  const inside = circleGeometry(model, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11 })
  const outside = circleGeometry(model, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11, outside: true })

  it('lays the sections round the chords and the rings outside them, the first nearest the sections', () => {
    expect(inside.outside).toBe(false)
    expect(outside.outside).toBe(true)
    // Inside: chords, rings, sections, names.
    expect(inside.chord).toBeLessThan(inside.rings[0].inner)
    expect(inside.rings[2].outer).toBeLessThan(inside.sections.inner)
    // Outside: chords, sections, rings, names — the chords meet the sections.
    expect(outside.chord).toBeCloseTo(outside.sections.inner - 6, 9)
    expect(outside.sections.outer).toBeLessThan(outside.rings[0].inner)
    expect(outside.rings[0].outer).toBeLessThan(outside.rings[1].inner)
    expect(outside.rings[1].outer).toBeLessThan(outside.rings[2].inner)
    expect(outside.rings[2].outer).toBeLessThanOrEqual(outside.labelAt)
  })

  it('draws every ring as thick either way, and the same angles', () => {
    const thick = (geometry: CircleGeometry) => geometry.rings.map((ring) => ring.outer - ring.inner)
    expect(thick(outside)).toEqual(thick(inside))
    expect(thick(inside)).toEqual([30, 20, 40])
    expect([...outside.arcs]).toEqual([...inside.arcs])
    expect(outside.labelAt).toBe(inside.labelAt)
  })

  it('finds a ring, a section and a chord where each is drawn', () => {
    const middle = (inside.arcs[2] + inside.arcs[3]) / 2
    const second = outside.rings[1]
    expect(hitCircle(outside, model, null, ...at(outside, (second.inner + second.outer) / 2, middle))).toEqual({
      kind: 'ring',
      ring: 1,
      unit: 1,
      angle: expect.closeTo(middle, 9),
    })
    expect(hitCircle(outside, model, null, ...at(outside, (outside.sections.inner + outside.sections.outer) / 2, middle))).toEqual({
      kind: 'section',
      unit: 1,
    })
    // In the six pixels between the sections and the first ring, past either's
    // slack, nothing.
    expect(outside.rings[0].inner - outside.sections.outer).toBeCloseTo(6, 9)
    expect(hitCircle(outside, model, null, ...at(outside, outside.sections.outer + 3, middle))).toBeNull()
    // Over the names, the section.
    expect(hitCircle(outside, model, null, ...at(outside, outside.labelAt + 5, middle))).toEqual({ kind: 'section', unit: 1 })
  })

  it('carries a point through a zoom in the layers’ own order', () => {
    const stops = radialStops(outside)
    for (let k = 1; k < stops.length; k++) expect(stops[k]).toBeGreaterThanOrEqual(stops[k - 1])
    const insideStops = radialStops(inside)
    for (let k = 1; k < insideStops.length; k++) expect(insideStops[k]).toBeGreaterThanOrEqual(insideStops[k - 1])
    // A ring's middle outside stays its middle in another layout of it.
    const bigger = circleGeometry(model, {
      width: 700,
      height: 700,
      rings: RINGS,
      measure,
      fontPx: 11,
      outside: true,
      zoom: { cx: 350, cy: 350, rim: outside.labelAt * 3, labelRoom: outside.outer - outside.labelAt },
    })
    const [ring] = outside.rings
    const [zoomed] = bigger.rings
    expect(carryRadius(stops, radialStops(bigger), (ring.inner + ring.outer) / 2)).toBeCloseTo(
      (zoomed.inner + zoomed.outer) / 2,
      9,
    )
  })

  it('keeps a genome’s band against its contigs, between them and the rings', () => {
    const contigs = banded()
    const geometry = circleGeometry(contigs, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11, outside: true })
    const band = geometry.band
    expect(band).not.toBeNull()
    if (band === null) return
    expect(geometry.sections.outer).toBeLessThan(band.inner)
    expect(band.outer).toBeLessThan(geometry.rings[0].inner)
    const middle = (geometry.arcs[0] + geometry.arcs[5]) / 2
    expect(hitCircle(geometry, contigs, null, ...at(geometry, (band.inner + band.outer) / 2, middle))).toEqual({
      kind: 'group',
      group: 0,
    })
  })
})

describe('a ring’s foot', () => {
  const model = threeGenomes()
  const geometry = circleGeometry(model, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11 })
  const side = (geometry.arcs[2] + geometry.arcs[3]) / 2

  it('is its inner edge, three pixels either way, and never in the gap at twelve o’clock', () => {
    const second = geometry.rings[1]
    expect(ringEdgeAt(geometry, ...at(geometry, second.inner, side))).toBe(1)
    expect(ringEdgeAt(geometry, ...at(geometry, second.inner - 2.5, side))).toBe(1)
    expect(ringEdgeAt(geometry, ...at(geometry, second.inner + 2.5, side))).toBe(1)
    // Its middle, and its outer edge, are not its foot.
    expect(ringEdgeAt(geometry, ...at(geometry, (second.inner + second.outer) / 2, side))).toBe(-1)
    expect(ringEdgeAt(geometry, ...at(geometry, second.outer, side))).toBe(-1)
    // At twelve o’clock a ring is held by its name instead.
    expect(ringEdgeAt(geometry, ...at(geometry, second.inner, TOP))).toBe(-1)
  })

  it('is the inner edge outside the sections too, the one a thicker ring moves', () => {
    const outside = circleGeometry(model, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11, outside: true })
    const thicker = circleGeometry(model, {
      width: 700,
      height: 700,
      rings: RINGS.map((ring) => (ring.id === 'second' ? { ...ring, size: 50 } : ring)),
      measure,
      fontPx: 11,
      outside: true,
    })
    // The ring's outer edge holds still and its inner edge — with the
    // sections and the chords inside it — moves in.
    expect(thicker.rings[1].outer).toBeCloseTo(outside.rings[1].outer, 9)
    expect(thicker.rings[1].inner).toBeCloseTo(outside.rings[1].inner - 30, 9)
    expect(thicker.sections.inner).toBeCloseTo(outside.sections.inner - 30, 9)
    expect(ringEdgeAt(outside, ...at(outside, outside.rings[1].inner, side))).toBe(1)
  })

  it('wears the double arrow along the radius', () => {
    expect(radialCursor(TOP)).toBe('ns-resize')
    expect(radialCursor(Math.PI / 2)).toBe('ns-resize')
    expect(radialCursor(0)).toBe('ew-resize')
    expect(radialCursor(Math.PI)).toBe('ew-resize')
    // Down and right, and up and left, are the same diagonal.
    expect(radialCursor(Math.PI / 4)).toBe('nwse-resize')
    expect(radialCursor((-3 * Math.PI) / 4)).toBe('nwse-resize')
    expect(radialCursor((3 * Math.PI) / 4)).toBe('nesw-resize')
    expect(radialCursor(-Math.PI / 4)).toBe('nesw-resize')
  })
})

describe('the rings’ room', () => {
  it('draws each ring as tall as its lane where they fit, with no ceiling of its own', () => {
    expect(ringScale([30, 20, 40], 200)).toBe(1)
    expect(ringThickness([30, 20, 300], 400)).toEqual([30, 20, 300])
  })

  it('squeezes them in proportion where they do not, never under six pixels', () => {
    expect(ringScale([100, 100], 100)).toBeCloseTo(0.5, 12)
    expect(ringThickness([100, 100], 100)).toEqual([50, 50])
    expect(ringThickness([200, 5], 102.5)).toEqual([100, 6])
  })
})

describe('the rings’ names in a column before twelve', () => {
  const model = threeGenomes()
  const TAU = 2 * Math.PI
  const names = ['hits_per_kb', 'GC', 'Completeness']
  const column = { names, px: 10, measure: (text: string, px: number) => text.length * px * 0.6 }
  const fitted = circleGeometry(model, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11 })
  const columned = circleGeometry(model, { width: 700, height: 700, rings: RINGS, measure, fontPx: 11, column })

  it('starts every arc on twelve o’clock and ends them short of the widest line', () => {
    // Without the column, too, the opening is just before twelve.
    expect(fitted.column).toBe(false)
    expect(fitted.gap).toEqual({ from: -fitted.topGap, to: 0 })
    expect(fitted.arcs[0]).toBeCloseTo(TOP, 9)
    expect(columned.column).toBe(true)
    expect(columned.gap.to).toBe(0)
    // The first arc starts on twelve exactly; the last ends where the opening starts.
    expect(columned.arcs[0]).toBeCloseTo(TOP, 9)
    expect(columned.arcs[5]).toBeCloseTo(TOP + TAU + columned.gap.from, 9)
    expect(columned.topGap).toBeCloseTo(-columned.gap.from, 12)
    expect(columned.topGap).toBeGreaterThan(fitted.topGap)
  })

  it('reaches as far back round as the lower left corner of the line nearest the middle', () => {
    // Each line at its ring's middle, ending on twelve, its name and the
    // padding either side; the first ring is the innermost and its line the lowest.
    const corner = (k: number): number => {
      const ring = columned.rings[k]
      const r = (ring.inner + ring.outer) / 2
      return Math.atan2(2 * COLUMN_PAD + names[k].length * 10 * 0.6, r - 10 / 2)
    }
    const reach = columnReach(columned.rings, column, columned.outer)
    expect(reach).toBeCloseTo(Math.max(corner(0), corner(1), corner(2)), 12)
    expect(reach).toBeCloseTo(corner(0), 12)
    expect(-columned.gap.from).toBeGreaterThan(reach)
    // Every line lies in the opening: no arc is drawn under a name.
    for (let k = 0; k < 3; k++) expect(corner(k)).toBeLessThan(-columned.gap.from)
  })

  it('cuts a name past the column’s length rather than opening the circle for it', () => {
    const long = { ...column, names: ['x'.repeat(400), 'GC', 'C'] }
    const reach = columnReach(columned.rings, long, columned.outer)
    const ring = columned.rings[0]
    const r = (ring.inner + ring.outer) / 2
    expect(reach).toBeCloseTo(Math.atan2(2 * COLUMN_PAD + columned.outer * COLUMN_MAX, r - 5), 12)
  })

  it('names no ring too thin to hold a line', () => {
    expect(ringNamePx(10, { inner: 100, outer: 103 })).toBeNull()
    expect(ringNamePx(10, { inner: 100, outer: 104 })).toBe(7)
    expect(ringNamePx(10, { inner: 100, outer: 150 })).toBe(10)
  })

  it('puts no ring’s foot in the column, and reads angles either side of twelve', () => {
    const ring = columned.rings[1]
    const inColumn = TOP + columned.gap.from / 2
    expect(ringEdgeAt(columned, ...at(columned, ring.inner, inColumn))).toBe(-1)
    // Just past twelve, where the arcs start, the foot is the ring’s again.
    expect(ringEdgeAt(columned, ...at(columned, ring.inner, TOP + 0.05))).toBe(1)
    expect(fromTwelve(TOP + 0.1)).toBeCloseTo(0.1, 12)
    expect(fromTwelve(TOP - 0.1)).toBeCloseTo(-0.1, 12)
    expect(fromTwelve(TOP + Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('keeps its opening through a zoom, which keeps every angle', () => {
    const zoomed = circleGeometry(model, {
      width: 700,
      height: 700,
      rings: RINGS,
      measure,
      fontPx: 11,
      column,
      zoom: { cx: 0, cy: 0, rim: columned.labelAt * 5, labelRoom: columned.outer - columned.labelAt, gap: columned.gap },
    })
    expect(zoomed.gap).toEqual(columned.gap)
    expect([...zoomed.arcs]).toEqual([...columned.arcs])
    expect(zoomed.column).toBe(true)
  })
})

/**
 * Where the circle's rings go and how a ring is resized (§7.6): inside the
 * sections or outside them, the sections then the inner circle round the
 * chords; what the pointer is over either way; and a ring's foot — its inner
 * edge — which a drag moves.
 *
 * Arithmetic over hand-built circles, as `circle-model.test.ts` is.
 */

import { describe, expect, it } from 'vitest'
import type { AxisGroup, MatrixResult } from '../../src/worker/protocol'
import {
  CHORD_CAP,
  TOP,
  carryRadius,
  circleGeometry,
  circleModelOf,
  hitCircle,
  radialCursor,
  radialStops,
  ringEdgeAt,
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

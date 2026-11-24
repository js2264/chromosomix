// @dev-feature curate
/**
 * How the curation stage lays its genomes out and colours them (SPECS §33.3):
 * a chain of the densest neighbours, elements beside their host, an order kept
 * across steps, and a colour kept by slot.
 */

import { describe, expect, it } from 'vitest'
import { chainOrder, elementOrder, keepOrder, type PairList } from '../../src/curate/order'
import { genomeColour, hslToRgba, hueDistance, slotApart, slotHue, slotOf } from '../../src/curate/colours'
import { coverageTicks, DotGrid, dotRadius, drawOrder, gcTicks, insidePolygon, lassoContigs, scatterFrame, scatterPlaces } from '../../src/curate/scatter'

/** Five MAGs: 0, 3 and 4 one organism's fragments, 1 and 2 another's; 0 and 1 barely meet. */
const PAIRS = pairList([
  [0, 3, 0.8],
  [3, 4, 0.5],
  [1, 2, 0.9],
  [0, 1, 0.01],
])

function pairList(rows: Array<[number, number, number]>): PairList {
  return { a: rows.map((r) => r[0]), b: rows.map((r) => r[1]), affinity: rows.map((r) => r[2]) }
}

describe('the order', () => {
  it('chains the densest pairs, so an organism’s fragments sit side by side', () => {
    const sizes = [5, 1, 1, 3, 2]
    const order = chainOrder([0, 1, 2, 3, 4], PAIRS, (g) => sizes[g])
    // 1–2, 0–3, 3–4, then 0–1 joins the two chains: one chain, read from its
    // larger end (4, size 2, against 2, size 1).
    expect(order).toEqual([4, 3, 0, 1, 2])
  })

  it('never splits a pair of fragments for a weaker one', () => {
    // 0 meets 1, 2 and 3 densely; 0 can keep two neighbours, so the third
    // joins the chain at its end, and 0's two densest stay beside it.
    const pairs = pairList([
      [0, 1, 0.9],
      [0, 2, 0.8],
      [0, 3, 0.7],
      [1, 3, 0.6],
    ])
    const order = chainOrder([0, 1, 2, 3], pairs, () => 1)
    const at = (g: number): number => order.indexOf(g)
    expect(Math.abs(at(0) - at(1))).toBe(1)
    expect(Math.abs(at(0) - at(2))).toBe(1)
    expect(Math.abs(at(1) - at(3))).toBe(1)
  })

  it('puts the chains one after another, the longest first, and leaves out pairs with another genome', () => {
    const pairs = pairList([
      [0, 3, 0.8],
      [5, 6, 0.4],
      [5, 9, 0.9],
    ])
    expect(chainOrder([0, 3, 5, 6, 7], pairs, (g) => (g === 6 ? 9 : 1))).toEqual([6, 5, 0, 3, 7])
  })

  it('places each element in its densest MAG’s place, those meeting none last', () => {
    const pairs = pairList([
      [4, 10, 0.3],
      [2, 11, 0.6],
      [4, 12, 0.5],
      [10, 12, 0.9],
      [1, 10, 0.1],
    ])
    expect(elementOrder([10, 11, 12, 13], [2, 1, 0, 3, 4], pairs, () => 1)).toEqual([11, 12, 10, 13])
  })

  it('is kept across a step: a merged genome leaves no hole, a new one sits beside its source', () => {
    const before = ['A', 'B', 'C', 'E1']
    const after = [
      { id: 'A', kind: 'mag' as const, from: [] },
      { id: 'C', kind: 'mag' as const, from: [] },
      { id: 'new1', kind: 'mag' as const, from: ['A'] },
      { id: 'E1', kind: 'element' as const, from: [] },
      { id: 'el2', kind: 'element' as const, from: [] },
    ]
    expect(keepOrder(before, after)).toEqual(['A', 'new1', 'C', 'E1', 'el2'])
  })
})

describe('the colours', () => {
  it('are a golden angle apart by slot, and kept by it', () => {
    expect(slotHue(0)).toBe(0)
    expect(slotHue(1)).toBe(138)
    expect(slotHue(2)).toBe(275)
    expect(genomeColour(3, 'mag').css).toBe(genomeColour(3, 'mag').css)
    expect(genomeColour(3, 'element').css).not.toBe(genomeColour(3, 'mag').css)
  })

  it('pack HSL as RGBA for image data', () => {
    // Pure red, opaque: 0xff0000ff little-endian.
    expect(hslToRgba(0, 1, 0.5)).toBe(0xff0000ff)
    expect(hslToRgba(120, 1, 0.5)).toBe(0xff00ff00)
    expect(hslToRgba(240, 1, 0.5, 0)).toBe(0x00ff0000)
  })

  it('give a created genome a slot after the file’s, by the number in its id', () => {
    expect(slotOf(5, 'A', 50)).toBe(5)
    expect(slotOf(-1, 'curated_3', 50)).toBe(53)
  })

  it('step a created genome’s slot on until its hue stands apart from its neighbours’', () => {
    // On MM133 a MAG made of slot 34's contigs would get slot 178: a degree away.
    expect(hueDistance(slotHue(178), slotHue(34))).toBeLessThan(5)
    const apart = slotApart(178, [34])
    expect(apart).toBeGreaterThan(178)
    expect(hueDistance(slotHue(apart), slotHue(34))).toBeGreaterThanOrEqual(30)
    // Far enough already, kept; with no neighbour, kept.
    expect(slotApart(1, [0])).toBe(1)
    expect(slotApart(178, [])).toBe(178)
    expect(hueDistance(350, 10)).toBe(20)
  })
})

describe('the scatter', () => {
  const gc = [30, 50, 70, Number.NaN, 50]
  const coverage = [1, 10, 100, 5, 0]

  it('frames every contig, a contig without coverage at half the least there is', () => {
    const frame = scatterFrame(gc, coverage)
    expect(frame.floor).toBe(0.5)
    expect(frame.gc0).toBeLessThan(30)
    expect(frame.gc1).toBeGreaterThan(70)
    expect(frame.log0).toBeLessThan(Math.log10(0.5))
    expect(frame.log1).toBeGreaterThan(2)
  })

  it('places GC across and the coverage up, on a log scale, and no contig without a GC content', () => {
    const frame = scatterFrame(gc, coverage)
    const places = scatterPlaces(frame, gc, coverage, 200, 100)
    expect(places.x[0]).toBeLessThan(places.x[1])
    expect(places.x[1]).toBeLessThan(places.x[2])
    // Up is a smaller y; ten times the coverage is one step up whatever the start.
    expect(places.y[2]).toBeLessThan(places.y[1])
    expect(places.y[0] - places.y[1]).toBeCloseTo(places.y[1] - places.y[2], 4)
    expect(Number.isNaN(places.x[3])).toBe(true)
    // The contig without coverage sits lowest.
    expect(places.y[4]).toBeGreaterThan(places.y[0])
  })

  it('draws the longest contigs last, so none hides under short ones', () => {
    expect([...drawOrder([500, 100, 9000, 100], [0, 1, 2, 3])]).toEqual([1, 3, 0, 2])
    expect(dotRadius(100)).toBe(1)
    expect(dotRadius(1_000_000)).toBe(7)
    expect(dotRadius(20_000)).toBeCloseTo(Math.sqrt(20) * 0.9, 6)
  })

  it('finds the dot on top under the pointer, within a little slack', () => {
    const places = { x: Float32Array.from([10, 12, 100]), y: Float32Array.from([10, 10, 100]) }
    const grid = new DotGrid(places, [0, 1, 2])
    const rank = (c: number): number => c
    expect(grid.at(11, 10, () => 3, rank)).toBe(1)
    expect(grid.at(100, 104, () => 3, rank)).toBe(2)
    expect(grid.at(60, 60, () => 3, rank)).toBe(-1)
  })

  it('holds in a lasso the dots whose centre it holds', () => {
    const places = { x: Float32Array.from([10, 50, 90, 50]), y: Float32Array.from([10, 50, 90, 12]) }
    // A triangle around the middle dot and the one above it.
    const lasso = [30, 0, 70, 0, 50, 70]
    expect(lassoContigs(places, lasso, [0, 1, 2, 3])).toEqual([1, 3])
    expect(lassoContigs(places, [0, 0, 1, 1], [0, 1, 2, 3])).toEqual([])
    expect(insidePolygon(5, 5, [0, 0, 10, 0, 10, 10, 0, 10])).toBe(true)
    expect(insidePolygon(15, 5, [0, 0, 10, 0, 10, 10, 0, 10])).toBe(false)
  })

  it('ticks every power of ten, and their halves when there are few', () => {
    expect(coverageTicks({ gc0: 0, gc1: 100, log0: -0.5, log1: 3.2, floor: 0.5 })).toEqual([1, 10, 100, 1000])
    expect(coverageTicks({ gc0: 0, gc1: 100, log0: 0.1, log1: 1.9, floor: 1 })).toEqual([5, 10, 50])
    expect(gcTicks({ gc0: 24, gc1: 71, log0: 0, log1: 1, floor: 1 })).toEqual([30, 40, 50, 60, 70])
    expect(gcTicks({ gc0: 41.2, gc1: 49.9, log0: 0, log1: 1, floor: 1 })).toEqual([42, 44, 46, 48])
  })
})

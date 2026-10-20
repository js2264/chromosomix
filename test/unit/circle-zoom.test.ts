/**
 * The circle zoomed in on (§7.6): which of it a box shows, where a point under
 * the pointer goes as the circle grows, which names a zoom writes, and the bins
 * a zoomed picture draws its rings in.
 *
 * Arithmetic over hand-built circles, as `circle-model.test.ts` is: every
 * angle here is one a reader can work out from the box and the radius.
 */

import { describe, expect, it } from 'vitest'
import type { AxisGroup, MatrixResult } from '../../src/worker/protocol'
import {
  CHORD_CAP,
  TOP,
  anglesInView,
  carryRadius,
  circleGeometry,
  circleModelOf,
  hitCircle,
  inTurn,
  namesInView,
  radialStops,
  unionArcs,
  unitsInView,
  visibleArcs,
  type CircleModel,
} from '../../src/render/circle'
import { paintRing, windowBins, type RingPaint } from '../../src/render/circleRings'

const TAU = 2 * Math.PI
const measure = (text: string): number => text.length * 6

/** A genome × genome block of `n` genomes, each `length(index)` long, every pair in contact. */
function genomes(n: number, length: (index: number) => number = () => 1e6, level: MatrixResult['level'] = 'genome'): CircleModel {
  const groups: AxisGroup[] = Array.from({ length: n }, (_, index) => ({
    label: `g${index}`,
    start: index,
    end: index + 1,
    unitLength: length(index),
  }))
  const data: MatrixResult = {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n).fill(1),
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: groups,
    colGroups: groups,
    level,
  }
  return circleModelOf(data, { genomeLength: (name) => length(Number(name.slice(1))) }) as CircleModel
}

describe('what a box shows of a circle', () => {
  const close = (got: Array<[number, number]>, want: Array<[number, number]>): void => {
    expect(got).toHaveLength(want.length)
    got.forEach(([a, b], k) => {
      expect(a).toBeCloseTo(want[k][0], 9)
      expect(b).toBeCloseTo(want[k][1], 9)
    })
  }

  it('is the whole turn for a circle inside the box, and nothing for one outside it', () => {
    close(visibleArcs(100, 100, 50, { x0: 0, y0: 0, x1: 200, y1: 200 }), [[TOP, TOP + TAU]])
    expect(visibleArcs(1000, 1000, 50, { x0: 0, y0: 0, x1: 200, y1: 200 })).toEqual([])
    // A box inside the circle, touching none of it.
    expect(visibleArcs(100, 100, 500, { x0: 50, y0: 50, x1: 150, y1: 150 })).toEqual([])
  })

  it('is the right half for a box over the right half, from twelve o’clock to six', () => {
    close(visibleArcs(0, 0, 10, { x0: 0, y0: -20, x1: 20, y1: 20 }), [[TOP, TOP + Math.PI]])
  })

  it('is two pieces for a box across twelve o’clock, one either side of the turn’s start', () => {
    // Half the radius either side of the top: thirty degrees either way.
    const arcs = visibleArcs(0, 0, 10, { x0: -5, y0: -20, x1: 5, y1: -5 })
    close(arcs, [
      [TOP, TOP + Math.PI / 6],
      [TOP + TAU - Math.PI / 6, TOP + TAU],
    ])
  })

  it('joins pieces that overlap, in order, and keeps those that do not', () => {
    expect(
      unionArcs(
        [
          [0, 1],
          [3, 4],
        ],
        [
          [0.5, 2],
          [5, 6],
        ],
      ),
    ).toEqual([
      [0, 2],
      [3, 4],
      [5, 6],
    ])
  })

  it('puts any angle in the circle’s own turn, from twelve o’clock', () => {
    expect(inTurn(TOP)).toBeCloseTo(TOP, 12)
    expect(inTurn(TOP - 0.1)).toBeCloseTo(TOP + TAU - 0.1, 12)
    expect(inTurn(TOP + TAU + 0.2)).toBeCloseTo(TOP + 0.2, 12)
  })
})

describe('a circle zoomed in on', () => {
  const model = genomes(3, (index) => [1000, 2000, 1000][index])
  const rings = [
    { id: 'first', size: 90 },
    { id: 'second', size: 30 },
  ]
  const fit = circleGeometry(model, { width: 300, height: 300, rings, measure, fontPx: 11 })
  const room = fit.outer - fit.labelAt
  const zoomed = (zoom: number, cx = 150, cy = 150) =>
    circleGeometry(model, {
      width: 300,
      height: 300,
      rings,
      measure,
      fontPx: 11,
      zoom: { cx, cy, rim: fit.labelAt * zoom, labelRoom: room },
    })

  it('is the same angles at a larger rim about a middle of its own, with the names’ room it had', () => {
    const geometry = zoomed(4, -200, 900)
    expect(geometry.cx).toBe(-200)
    expect(geometry.cy).toBe(900)
    expect(geometry.labelAt).toBeCloseTo(fit.labelAt * 4, 9)
    expect(geometry.outer - geometry.labelAt).toBeCloseTo(room, 9)
    expect([...geometry.arcs]).toEqual([...fit.arcs])
  })

  it('draws each ring as thick as its lane is tall, which the fitted circle had to scale', () => {
    expect(fit.rings[0].outer - fit.rings[0].inner).toBeLessThan(90)
    const geometry = zoomed(10)
    expect(geometry.rings[0].outer - geometry.rings[0].inner).toBeCloseTo(90, 6)
    expect(geometry.rings[1].outer - geometry.rings[1].inner).toBeCloseTo(30, 6)
  })

  it('carries a point to the same place in the same layer, and past the names by as much', () => {
    const from = radialStops(fit)
    const to = radialStops(zoomed(6))
    const [ring] = fit.rings
    const [zoomedRing] = zoomed(6).rings
    // A ring's middle is its middle, however thick it has become.
    expect(carryRadius(from, to, (ring.inner + ring.outer) / 2)).toBeCloseTo(
      (zoomedRing.inner + zoomedRing.outer) / 2,
      9,
    )
    // A place in the chord disc, the same share of it.
    expect(carryRadius(from, to, fit.chord / 2)).toBeCloseTo(zoomed(6).chord / 2, 9)
    // Over the names, the same distance past where they start.
    expect(carryRadius(from, to, fit.labelAt + 7)).toBeCloseTo(zoomed(6).labelAt + 7, 9)
    // The same layout carries every point to itself.
    for (const r of [0, 10, fit.chord, fit.sections.outer, fit.outer + 20]) {
      expect(carryRadius(from, from, r)).toBeCloseTo(r, 9)
    }
  })

  it('shows the angles of its layers the box holds: the whole turn fitted, a stretch zoomed', () => {
    const box = { x0: 0, y0: 0, x1: 300, y1: 300 }
    expect(anglesInView(fit, box)).toEqual([[TOP, TOP + TAU]])
    // Zoomed about a middle below the box, its top in view: a stretch either
    // side of twelve o’clock.
    const geometry = zoomed(8, 150, 150 + fit.labelAt * 8 - 60)
    const windows = anglesInView(geometry, box)
    expect(windows.length).toBe(2)
    expect(windows[0][0]).toBeCloseTo(TOP, 9)
    expect(windows[1][1]).toBeCloseTo(TOP + TAU, 9)
    const span = windows.reduce((sum, [a, b]) => sum + b - a, 0)
    expect(span).toBeGreaterThan(0)
    expect(span).toBeLessThan(0.5)
    // Neither the middle section nor the last is in view — only the first,
    // which starts just past twelve, and the last, which ends just before it.
    expect([...unitsInView(geometry, windows)]).toEqual([1, 0, 1])
  })
})

describe('the names a zoom writes', () => {
  it('names the genomes in view, which at rest were too many to name', () => {
    const many = genomes(120)
    const fit = circleGeometry(many, { width: 600, height: 600, rings: [], measure, fontPx: 11 })
    // A hundred and twenty genomes: no names at rest, and no room kept.
    expect(fit.names).toBe(false)
    const everything = new Uint8Array(120).fill(1)
    expect(namesInView(many, fit, everything, true).names).toBe(false)
    // Ten in view, at a zoom where each arc holds a line: those ten.
    const zoomed = circleGeometry(many, {
      width: 600,
      height: 600,
      rings: [],
      measure,
      fontPx: 11,
      zoom: { cx: 300, cy: 300, rim: fit.labelAt * 12, labelRoom: 0 },
    })
    const ten = new Uint8Array(120)
    for (let u = 40; u < 50; u++) ten[u] = 1
    const named = namesInView(many, zoomed, ten, true)
    expect(named.names).toBe(true)
    expect([...named.labelled].reduce((sum, on) => sum + on, 0)).toBe(10)
    for (let u = 40; u < 50; u++) expect(named.labelled[u]).toBe(1)
    // The labels overlay off: none.
    expect(namesInView(many, zoomed, ten, false).names).toBe(false)
  })

  it('names only an arc that holds a line at the zoom', () => {
    const few = genomes(48)
    const fit = circleGeometry(few, { width: 120, height: 120, rings: [], measure, fontPx: 11 })
    const all = new Uint8Array(48).fill(1)
    // Forty-eight genomes on a small circle: a few degrees each, too short a line.
    const small = namesInView(few, fit, all, true)
    expect(small.names).toBe(true)
    expect([...small.labelled].every((on) => on === 0)).toBe(true)
    const zoomed = circleGeometry(few, {
      width: 120,
      height: 120,
      rings: [],
      measure,
      fontPx: 11,
      zoom: { cx: 60, cy: 60, rim: fit.labelAt * 20, labelRoom: fit.outer - fit.labelAt },
    })
    expect([...namesInView(few, zoomed, all, true).labelled].every((on) => on === 1)).toBe(true)
  })

  it('names the long contigs of a contig circle with more than fifty in view', () => {
    const contigs = genomes(208, (index) => (index < 10 ? 120_000 : 8_000), 'bin')
    const fit = circleGeometry(contigs, { width: 900, height: 900, rings: [], measure, fontPx: 11 })
    const zoomed = circleGeometry(contigs, {
      width: 900,
      height: 900,
      rings: [],
      measure,
      fontPx: 11,
      zoom: { cx: 450, cy: 450, rim: fit.labelAt * 50, labelRoom: fit.outer - fit.labelAt },
    })
    const named = namesInView(contigs, zoomed, new Uint8Array(208).fill(1), true)
    expect(named.names).toBe(true)
    for (let u = 0; u < 208; u++) expect(named.labelled[u]).toBe(u < 10 ? 1 : 0)
  })
})

describe('the names of a zoomed contig circle under its genomes’ band', () => {
  // Two genomes of sixty contigs each, cut into their contigs.
  const n = 120
  const data: MatrixResult = {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n).fill(1),
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: Array.from({ length: n }, (_, index) => ({ label: `c${index}`, start: index, end: index + 1, unitLength: 1000 })),
    colGroups: Array.from({ length: n }, (_, index) => ({ label: `c${index}`, start: index, end: index + 1, unitLength: 1000 })),
    level: 'bin',
    rowGenomes: [
      { label: 'A', start: 0, end: 60 },
      { label: 'B', start: 60, end: 120 },
    ],
    genomeBoundaries: true,
  }
  const model = circleModelOf(data, {}, 1, CHORD_CAP, 'contigs') as CircleModel
  const fit = circleGeometry(model, { width: 600, height: 600, rings: [], measure, fontPx: 11 })
  const zoomed = circleGeometry(model, {
    width: 600,
    height: 600,
    rings: [],
    measure,
    fontPx: 11,
    zoom: { cx: 300, cy: 300, rim: fit.labelAt * 30, labelRoom: fit.outer - fit.labelAt },
  })

  it('names the genomes alone while more than fifty contigs are in view', () => {
    const named = namesInView(model, zoomed, new Uint8Array(n).fill(1), true)
    expect(named.names).toBe(true)
    expect([...(named.groupLabelled ?? [])]).toEqual([1, 1])
    expect([...named.labelled].every((on) => on === 0)).toBe(true)
  })

  it('names the contigs in view as well once no more than fifty are, and a name is its contig', () => {
    const thirty = new Uint8Array(n)
    for (let u = 10; u < 40; u++) thirty[u] = 1
    const named = namesInView(model, zoomed, thirty, true)
    expect([...(named.groupLabelled ?? [])]).toEqual([1, 0])
    for (let u = 0; u < n; u++) expect(named.labelled[u]).toBe(u >= 10 && u < 40 ? 1 : 0)
    // Over the names, a named contig is hit as itself, and its genome elsewhere.
    const geometry = { ...zoomed, labelled: named.labelled, groupLabelled: named.groupLabelled }
    const over = (unit: number) => {
      const angle = (geometry.arcs[2 * unit] + geometry.arcs[2 * unit + 1]) / 2
      const r = geometry.labelAt + 10
      return hitCircle(geometry, model, null, geometry.cx + Math.cos(angle) * r, geometry.cy + Math.sin(angle) * r)
    }
    expect(over(20)).toEqual({ kind: 'section', unit: 20 })
    expect(over(50)).toEqual({ kind: 'group', group: 0 })
  })
})

describe('the bins of a zoomed picture', () => {
  const model = genomes(2, () => 1000)
  const geometry = circleGeometry(model, { width: 400, height: 400, rings: [{ id: 'r', size: 30 }], measure, fontPx: 11 })
  const a0 = geometry.arcs[0]
  const a1 = geometry.arcs[1]
  // The middle fifth of the first genome in view, nothing of the second.
  const window: [number, number] = [a0 + (a1 - a0) * 0.4, a0 + (a1 - a0) * 0.6]
  const bins = windowBins(model, geometry, [window], 100)

  it('is fine across what is in view and one bin for each stretch out of it', () => {
    const inView = Math.ceil((window[1] - window[0]) * 100)
    // Before the window, the window's own, after it; and the second genome whole.
    expect(bins.count).toBe(1 + inView + 1 + 1)
    expect([...bins.first]).toEqual([0, inView + 2, inView + 3])
    expect(bins.shown?.[0]).toBe(0)
    expect(bins.shown?.[1]).toBe(1)
    expect(bins.shown?.[inView]).toBe(1)
    expect(bins.shown?.[inView + 1]).toBe(0)
    expect(bins.shown?.[inView + 2]).toBe(0)
  })

  it('still runs each section from its start to its end, a bin a stretch of its base pairs', () => {
    for (let u = 0; u < 2; u++) {
      const first = bins.first[u]
      const last = bins.first[u + 1] - 1
      expect(bins.from[first]).toBeCloseTo(0, 9)
      expect(bins.to[last]).toBeCloseTo(1000, 9)
      expect(bins.a0[first]).toBeCloseTo(geometry.arcs[2 * u], 9)
      expect(bins.a1[last]).toBeCloseTo(geometry.arcs[2 * u + 1], 9)
      for (let bin = first + 1; bin <= last; bin++) {
        expect(bins.from[bin]).toBeCloseTo(bins.to[bin - 1], 9)
        expect(bins.a0[bin]).toBeCloseTo(bins.a1[bin - 1], 9)
      }
    }
    // The window's first bin starts where the window does: 400 bp in.
    expect(bins.from[1]).toBeCloseTo(400, 6)
  })

  it('holds to its cap, however fine the screen asks for — give or take a bin a stretch', () => {
    const capped = windowBins(model, geometry, [window], 1e9, 500)
    // The window's 500, rounded up, and the three stretches out of view.
    expect(capped.count).toBeGreaterThanOrEqual(500 + 3)
    expect(capped.count).toBeLessThanOrEqual(500 + 1 + 3)
  })

  it('draws nothing for a bin out of view', () => {
    let fills = 0
    const ctx = new Proxy(
      {},
      {
        get: (_target, key: string) => (key === 'fill' ? () => fills++ : () => {}),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D
    const values = new Float32Array(bins.count).fill(2)
    const ring: RingPaint = {
      id: 'r',
      label: 'r',
      colour: '#d55e00',
      opacity: 1,
      content: {
        kind: 'values',
        values: { kind: 'quantitative', values, extent: { min: 2, max: 2 } },
        limits: { min: 0, max: 2 },
        mode: 'bar',
        colormap: 'default',
        flip: false,
      },
    }
    paintRing(ctx, ring, geometry.rings[0], geometry, bins, null, {
      guide: '#222',
      fills: true,
      outline: false,
      baseline: false,
    })
    // A bar a bin in view, and none for the three bins out of it.
    expect(fills).toBe(bins.count - 3)
  })
})

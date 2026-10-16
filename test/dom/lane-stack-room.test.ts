// @vitest-environment jsdom
/**
 * The room a stack of lanes leaves past its last lane, for that lane's name.
 *
 * A name is written across the lane it names, and its size is the reader's text
 * size while the lane's is the height the reader gave it. On the 14-pixel peak
 * lanes the yeast demo opens with, at the default text size, the block runs a
 * few pixels past the lane — and past the last lane on an edge that was the
 * edge of the canvas, which cut the chip and the descenders off the name on
 * screen and in every figure (§8.8). `thicknessOf` is what both the grid and the
 * figures are sized from, so it is what is pinned: the room is there exactly
 * when the last lane is too thin for its block, follows the text size, goes
 * with the *track text* option, and pushes a loop's anchors out past it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ManualStore } from '@/annotations/manual'
import { parseBed } from '@/annotations/parse'
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle, type AnnotationKind, type LaneEdge } from '@/annotations/types'
import { MARK_WASH } from '@/render/lane'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { AnnotationLanes, type LaneGeometry } from '@/ui/AnnotationLanes'
import { getPlotOptions, setPlotOptions } from '@/ui/plotOptions'
import { getTextScale, setTextScale } from '@/ui/textScale'
import { silentContext } from '../support/dom'

const LENGTH = 1_500_000

let scaleBefore = 1
let textBefore = true

beforeEach(() => {
  scaleBefore = getTextScale()
  textBefore = getPlotOptions().text
  setTextScale(1.35)
  setPlotOptions({ text: true })
})

afterEach(() => {
  setTextScale(scaleBefore)
  setPlotOptions({ text: textBefore })
})

function axis(): LocusAxis {
  return new LocusAxis([
    { contig: 'IV', unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

/** A stack of lanes on one edge, each `[kind, height]`, nearest the map first. */
function stack(
  lanes: Array<[AnnotationKind, number]>,
  edge: LaneEdge = 'right',
  manual?: ManualStore,
): AnnotationLanes {
  const store = new AnnotationStore(`room-${Math.random()}.cool`, { persist: false })
  for (const [index, [kind, size]] of lanes.entries()) {
    store.begin({
      card: 'linear',
      kind,
      id: `lane-${index}`,
      label: `${kind} ${index}`,
      source: { kind: 'local', name: `${kind}.bed`, file: new File([], `${kind}.bed`) },
      placement: { top: edge === 'top', right: edge === 'right', bottom: edge === 'bottom', left: edge === 'left' },
      style: { ...defaultStyle(kind, '#0072b2'), size },
      visible: true,
    })
  }
  const lanesOf = new AnnotationLanes({ store, onChange: () => {}, ...(manual === undefined ? {} : { manual }) })
  lanesOf.setAxes({ rows: axis(), cols: axis() })
  return lanesOf
}

describe('the room past the last lane of a stack', () => {
  it('is the name’s overhang on a lane too thin for it, at the default text size', () => {
    // nameTop 11 and a plate 16 tall reach 19 across; the lane is 14.
    expect(stack([['segments', 14]]).thicknessOf('right')).toBe(19)
    expect(stack([['segments', 14]], 'bottom').thicknessOf('bottom')).toBe(19)
  })

  it('is nothing where the last lane holds its name', () => {
    // The height a dropped feature file opens at, and a coverage track's.
    expect(stack([['segments', 24]]).thicknessOf('right')).toBe(24)
    expect(stack([['track', 72]]).thicknessOf('right')).toBe(72)
  })

  it('is asked of the last lane only; a thin lane further in runs into the gap', () => {
    // 14, the 4-pixel gap, and a lane that holds its own name.
    expect(stack([['segments', 14], ['track', 72]]).thicknessOf('right')).toBe(90)
    expect(stack([['track', 72], ['segments', 14]]).thicknessOf('right')).toBe(72 + 4 + 19)
  })

  it('is mirrored onto the outer side of a stack above or left of the map', () => {
    // The total is what the top and left stacks are laid out backwards from, so
    // the same room lands on the side away from the map.
    expect(stack([['segments', 14]], 'left').thicknessOf('left')).toBe(19)
    expect(stack([['segments', 14]], 'top').thicknessOf('top')).toBe(19)
  })

  it('follows the text size', () => {
    setTextScale(1)
    // The drawn sizes: nine-pixel type, a plate 12 tall at 8 — 14 holds it.
    expect(stack([['segments', 14]]).thicknessOf('right')).toBe(14)
    setTextScale(1.6)
    // nameTop 13, plate 19: the block reaches 22.5.
    expect(stack([['segments', 14]]).thicknessOf('right')).toBe(23)
  })

  it('goes with the track text option, since there is no name to make room for', () => {
    setPlotOptions({ text: false })
    expect(stack([['segments', 14]]).thicknessOf('right')).toBe(14)
  })

  it('puts a loop’s anchors past the name, not over it', () => {
    const manual = new ManualStore(`room-${Math.random()}.cool`)
    manual.add({
      id: 'm1',
      kind: 'arrowhead',
      a: { contig: 'IV', bp: 200_000 },
      b: { contig: 'IV', bp: 600_000 },
      colour: '#d55e00',
    })
    // The lane, the name's room, then the anchors' own band of 2 + 7.
    expect(stack([['segments', 14]], 'right', manual).thicknessOf('right')).toBe(19 + 9)
    expect(stack([['segments', 24]], 'right', manual).thicknessOf('right')).toBe(24 + 9)
  })

  it('takes no band for a box, which is washed over the lanes rather than pointed at (§8.1)', () => {
    const manual = new ManualStore(`room-${Math.random()}.cool`)
    manual.add({
      id: 'r1',
      kind: 'rect',
      a: { contig: 'IV', from: 300_000, to: 450_000 },
      b: { contig: 'IV', from: 300_000, to: 450_000 },
      colour: '#1f5fa9',
    })
    expect(stack([['segments', 24]], 'bottom', manual).thicknessOf('bottom')).toBe(24)
  })

  it('gives the anchors’ band back while the mark that needs it is hidden (§8.1)', () => {
    // A hidden mark is no mark to every picture, down to the room it took: a
    // figure saved with the loop hidden is the figure with no loop in it.
    const manual = new ManualStore(`room-${Math.random()}.cool`)
    manual.add({
      id: 'm1',
      kind: 'arrowhead',
      a: { contig: 'IV', bp: 200_000 },
      b: { contig: 'IV', bp: 600_000 },
      colour: '#d55e00',
    })
    manual.hideAll()
    expect(stack([['segments', 24]], 'right', manual).thicknessOf('right')).toBe(24)
    manual.showAll()
    expect(stack([['segments', 24]], 'right', manual).thicknessOf('right')).toBe(24 + 9)
  })
})

describe('the marks under the pointer on a stack (§8.1)', () => {
  /** A kilobase to the pixel, the plot at the canvas's corner: x and y read as kb along the axis. */
  const geometry = {
    plot: { x: 0, y: 0, width: 1_500, height: 1_500 },
    data: { x: 0, y: 0, width: 1_500, height: 1_500 },
    colScale: new Scale([0, LENGTH], 1_500),
    rowScale: new Scale([0, LENGTH], 1_500),
  } as unknown as LaneGeometry

  function marked(): ManualStore {
    const manual = new ManualStore(`hit-${Math.random()}.cool`)
    manual.add({ id: 'v', kind: 'line', axis: 'vertical', at: { contig: 'IV', bp: 300_000 }, colour: '#000' })
    manual.add({
      id: 'a',
      kind: 'arrowhead',
      a: { contig: 'IV', bp: 200_000 },
      b: { contig: 'IV', bp: 600_000 },
      colour: '#000',
    })
    return manual
  }
  const ids = (lanes: AnnotationLanes, edge: LaneEdge, x: number, y: number): string[] =>
    lanes.marksAt(edge, x, y, geometry, 6).map((mark) => mark.id)

  it('names the rules an edge draws and the anchors on it, along the stack only', () => {
    const manual = marked()
    const below = stack([['segments', 24]], 'bottom', manual)
    expect(ids(below, 'bottom', 302, 10)).toEqual(['v'])
    // Both ends of the loop are anchored under the map.
    expect(ids(below, 'bottom', 200, 10)).toEqual(['a'])
    expect(ids(below, 'bottom', 597, 10)).toEqual(['a'])
    expect(ids(below, 'bottom', 450, 10)).toEqual([])
    // Beside the map a vertical rule is not drawn, so it is not under anything.
    const beside = stack([['segments', 24]], 'right', manual)
    expect(ids(beside, 'right', 10, 300)).toEqual([])
    expect(ids(beside, 'right', 10, 600)).toEqual(['a'])
  })

  it('finds a box anywhere inside its wash, after a rule in reach and the narrower of two first', () => {
    const manual = marked()
    // A box on the diagonal over the rule at 300 kb, and a wider one round it.
    manual.add({
      id: 'small',
      kind: 'rect',
      a: { contig: 'IV', from: 280_000, to: 400_000 },
      b: { contig: 'IV', from: 280_000, to: 400_000 },
      colour: '#000',
    })
    manual.add({
      id: 'wide',
      kind: 'rect',
      a: { contig: 'IV', from: 250_000, to: 700_000 },
      b: { contig: 'IV', from: 250_000, to: 700_000 },
      colour: '#000',
    })
    const below = stack([['segments', 24]], 'bottom', manual)
    // Deep inside both: the narrower first.
    expect(ids(below, 'bottom', 350, 10)).toEqual(['small', 'wide'])
    // On the rule, which is aimed at, before the boxes it stands in.
    expect(ids(below, 'bottom', 300, 10)).toEqual(['v', 'small', 'wide'])
    // Inside the wide box only, and beside the map too: a box is washed on every stack.
    expect(ids(below, 'bottom', 550, 10)).toEqual(['wide'])
    expect(ids(stack([['segments', 24]], 'right', manual), 'right', 10, 550)).toEqual(['wide'])
    expect(ids(below, 'bottom', 900, 10)).toEqual([])
  })

  it('finds both stretches of a box off the diagonal, on either stack', () => {
    const manual = new ManualStore(`hit-${Math.random()}.cool`)
    manual.add({
      id: 'off',
      kind: 'rect',
      a: { contig: 'IV', from: 100_000, to: 150_000 },
      b: { contig: 'IV', from: 900_000, to: 1_000_000 },
      colour: '#000',
    })
    for (const edge of ['bottom', 'right'] as const) {
      const lanes = stack([['segments', 24]], edge, manual)
      const at = (kb: number): string[] => (edge === 'bottom' ? ids(lanes, edge, kb, 10) : ids(lanes, edge, 10, kb))
      expect(at(120)).toEqual(['off'])
      expect(at(950)).toEqual(['off'])
      expect(at(500)).toEqual([])
    }
  })

  it('names nothing that is hidden', () => {
    const manual = marked()
    manual.setShown('v', false)
    expect(ids(stack([['segments', 24]], 'bottom', manual), 'bottom', 300, 10)).toEqual([])
  })
})

describe('a box on the tracks beside a map (§8.1)', () => {
  /** A kilobase to the pixel, the data six pixels in, as the heatmap lays one out. */
  function geometry(): LaneGeometry {
    return {
      plot: { x: 6, y: 6, width: 1_500, height: 1_500 },
      data: { x: 6, y: 6, width: 1_500, height: 1_500 },
      colScale: new Scale([0, LENGTH], 1_500),
      rowScale: new Scale([0, LENGTH], 1_500),
      cssWidth: 1_512,
      cssHeight: 1_512,
      hover: null,
      anchors: null,
      crosshair: false,
      echo: null,
      echoAnchors: null,
      laneEcho: null,
      guide: null,
      border: null,
      handles: true,
      grip: null,
      scaling: null,
      palette: { guide: '#333', halo: '#fff', crosshair: '#f00' },
    }
  }

  interface Fill {
    x: number
    y: number
    width: number
    height: number
    alpha: number
    colour: string
  }
  const fills = new Map<HTMLCanvasElement, Fill[]>()
  const prototype = HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  let original: unknown

  beforeEach(() => {
    fills.clear()
    original = prototype.getContext
    // The silent context, keeping the rectangles it is asked to fill and the
    // ink they were filled with: what a wash is.
    prototype.getContext = function (this: HTMLCanvasElement) {
      const ctx = silentContext(this) as unknown as Record<string, unknown>
      const kept: Fill[] = fills.get(this) ?? []
      fills.set(this, kept)
      ctx.globalAlpha = 1
      ctx.fillStyle = '#000'
      ctx.fillRect = (x: number, y: number, width: number, height: number) => {
        kept.push({ x, y, width, height, alpha: ctx.globalAlpha as number, colour: String(ctx.fillStyle) })
      }
      return ctx
    }
  })

  afterEach(() => {
    prototype.getContext = original
  })

  /** Feature lanes of these heights on one edge, each with a peak to draw, nearest the map first. */
  function drawn(heights: number[], edge: LaneEdge, manual: ManualStore): AnnotationLanes {
    const store = new AnnotationStore(`wash-${Math.random()}.cool`, { persist: false })
    for (const [index, size] of heights.entries()) {
      const id = `lane-${index}`
      store.begin({
        card: 'linear',
        kind: 'segments',
        id,
        label: `peaks ${index}`,
        source: { kind: 'local', name: 'peaks.bed', file: new File([], 'peaks.bed') },
        placement: { top: edge === 'top', right: edge === 'right', bottom: edge === 'bottom', left: edge === 'left' },
        style: { ...defaultStyle('segments', '#0072b2'), size },
        visible: true,
      })
      store.update(id, {
        status: 'ready',
        payload: { kind: 'features', data: parseBed('IV\t500000\t520000\tp1\n', 'peaks.bed') },
      })
    }
    const lanes = new AnnotationLanes({ store, onChange: () => {}, manual })
    lanes.setAxes({ rows: axis(), cols: axis() })
    lanes.draw(geometry())
    return lanes
  }

  /** The washes one stack's canvas was given: a tenth of a box's colour. */
  function washes(lanes: AnnotationLanes, edge: LaneEdge, colour: string): Fill[] {
    return (fills.get(lanes.canvases[edge]) ?? []).filter((fill) => fill.alpha === MARK_WASH && fill.colour === colour)
  }

  it('is washed across every lane of the stack, along the stretch it covers', () => {
    const manual = new ManualStore(`wash-${Math.random()}.cool`)
    const span = { contig: 'IV', from: 300_000, to: 450_000 }
    manual.add({ id: 'r1', kind: 'rect', a: span, b: { ...span }, colour: '#1f5fa9' })
    const lanes = drawn([24, 40], 'bottom', manual)
    // One wash for a box on the diagonal, though it names the stretch twice.
    const [wash, ...more] = washes(lanes, 'bottom', '#1f5fa9')
    expect(more).toEqual([])
    expect(wash.x).toBeCloseTo(6 + 300)
    expect(wash.width).toBeCloseTo(150)
    // From the near edge of the first lane to the far edge of the second, the
    // gap between them included: 24, the 4-pixel gap, 40.
    expect(wash.y).toBe(0)
    expect(wash.height).toBe(24 + 4 + 40)
  })

  it('washes both stretches of a box off the diagonal, on both stacks', () => {
    const manual = new ManualStore(`wash-${Math.random()}.cool`)
    manual.add({
      id: 'off',
      kind: 'rect',
      a: { contig: 'IV', from: 100_000, to: 150_000 },
      b: { contig: 'IV', from: 900_000, to: 1_000_000 },
      colour: '#d55e00',
    })
    const under = drawn([24], 'bottom', manual)
    expect(washes(under, 'bottom', '#d55e00').map((wash) => [Math.round(wash.x), Math.round(wash.width)])).toEqual([
      [106, 50],
      [906, 100],
    ])
    const beside = drawn([24], 'right', manual)
    expect(washes(beside, 'right', '#d55e00').map((wash) => [Math.round(wash.y), Math.round(wash.height)])).toEqual([
      [106, 50],
      [906, 100],
    ])
  })

  it('is drawn nowhere while it is hidden', () => {
    const manual = new ManualStore(`wash-${Math.random()}.cool`)
    const span = { contig: 'IV', from: 300_000, to: 450_000 }
    manual.add({ id: 'r1', kind: 'rect', a: span, b: { ...span }, colour: '#1f5fa9' })
    const lanes = drawn([24], 'bottom', manual)
    expect(washes(lanes, 'bottom', '#1f5fa9')).toHaveLength(1)
    manual.hideAll()
    fills.clear()
    lanes.draw(geometry())
    expect(washes(lanes, 'bottom', '#1f5fa9')).toEqual([])
  })
})

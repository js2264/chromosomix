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
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle, type AnnotationKind, type LaneEdge } from '@/annotations/types'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { AnnotationLanes, type LaneGeometry } from '@/ui/AnnotationLanes'
import { getPlotOptions, setPlotOptions } from '@/ui/plotOptions'
import { getTextScale, setTextScale } from '@/ui/textScale'

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

  it('names nothing that is hidden', () => {
    const manual = marked()
    manual.setShown('v', false)
    expect(ids(stack([['segments', 24]], 'bottom', manual), 'bottom', 300, 10)).toEqual([])
  })
})

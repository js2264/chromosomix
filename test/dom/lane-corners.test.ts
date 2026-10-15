// @vitest-environment jsdom
/**
 * The tracks' names beside a map, in its corners (§8.8).
 *
 * Each stack's names go into the corner that follows it clockwise — left of the
 * bottom stack, above the left one, right of the top one, below the right one —
 * so the four corners hold one stack's each whichever edges have lanes. A name
 * starts in the stack's own margin and runs out over its corner, whose size is
 * measured off the names the paint wrote and applied a frame later, as the
 * browser's name column is; what is pinned here is that arrangement: which
 * corner opens, how wide, where the boxes a reader points at land, what a
 * figure makes room for, and that nothing hangs off a lane any more.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseBed } from '@/annotations/parse'
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle, type LaneEdge } from '@/annotations/types'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { AnnotationLanes, CORNER_OF, CORNER_SIDE, type LaneGeometry } from '@/ui/AnnotationLanes'
import { getPlotOptions, setPlotOptions } from '@/ui/plotOptions'
import { getTextScale, setTextScale } from '@/ui/textScale'
import { setUpDom, type DomTeardown } from '../support/dom'

const LENGTH = 400_000

let teardown: DomTeardown
let scaleBefore = 1
let textBefore = true

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  scaleBefore = getTextScale()
  textBefore = getPlotOptions().text
  setTextScale(1)
  setPlotOptions({ text: true })
})

afterEach(() => {
  setTextScale(scaleBefore)
  setPlotOptions({ text: textBefore })
  teardown()
})

function axis(): LocusAxis {
  return new LocusAxis([
    { contig: 'IV', unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

/** One peak lane on `edge`, called `label`, with something in it to draw. */
function lanesWith(edge: LaneEdge, label: string, corners = true, size = 24): AnnotationLanes {
  const store = new AnnotationStore(`corners-${Math.random()}.cool`, { persist: false })
  store.begin({
    card: 'linear',
    kind: 'bed',
    id: 'peaks',
    label,
    source: { kind: 'local', name: 'peaks.bed', file: new File([], 'peaks.bed') },
    placement: { top: edge === 'top', right: edge === 'right', bottom: edge === 'bottom', left: edge === 'left' },
    style: { ...defaultStyle('bed', '#0072b2'), size },
    visible: true,
  })
  store.update('peaks', {
    status: 'ready',
    payload: { kind: 'features', data: parseBed('IV\t100000\t120000\tp1\n', 'peaks.bed') },
  })
  const lanes = new AnnotationLanes({ store, onChange: () => {}, corners })
  lanes.setAxes({ rows: axis(), cols: axis() })
  return lanes
}

/** A 400-pixel map with a six-pixel margin all round, as the heatmap draws one with no labels. */
function geometry(): LaneGeometry {
  return {
    plot: { x: 6, y: 6, width: 400, height: 400 },
    data: { x: 6, y: 6, width: 400, height: 400 },
    colScale: new Scale([0, LENGTH], 400),
    rowScale: new Scale([0, LENGTH], 400),
    cssWidth: 412,
    cssHeight: 412,
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

/** Two frames: the first measures the names, the second lays the corner out for them. */
function settle(lanes: AnnotationLanes): void {
  lanes.draw(geometry())
  lanes.draw(geometry())
}

describe('the corner a stack’s names go into', () => {
  it('follows each stack clockwise, one stack to a corner', () => {
    expect(CORNER_OF).toEqual({
      bottom: 'bottom-left',
      left: 'top-left',
      top: 'top-right',
      right: 'bottom-right',
    })
    expect(new Set(Object.values(CORNER_OF)).size).toBe(4)
    // …and widens the side of the map that corner is on.
    expect(CORNER_SIDE).toEqual({ bottom: 'left', left: 'top', top: 'right', right: 'bottom' })
  })

  it('opens as wide as the names want past the stack’s own margin, a frame later', () => {
    const lanes = lanesWith('bottom', 'ATAC peaks')
    lanes.draw(geometry())
    // The first frame measures; nothing is laid out for it yet.
    expect(lanes.cornerOf('bottom')).toBeGreaterThan(0)
    const canvas = lanes.labelCanvases.bottom
    lanes.draw(geometry())
    expect(canvas.classList.contains('hidden')).toBe(false)
    expect(canvas.style.width).toBe(`${lanes.cornerOf('bottom')}px`)
    // As tall as the stack it names.
    expect(canvas.style.height).toBe(`${lanes.thicknessOf('bottom')}px`)
    for (const edge of ['top', 'left', 'right'] as const) {
      expect(lanes.labelCanvases[edge].classList.contains('hidden')).toBe(true)
    }
  })

  it('writes the name left of a bottom stack, ending before its handle, where a press finds it', () => {
    const lanes = lanesWith('bottom', 'ATAC peaks')
    settle(lanes)
    const corner = lanes.cornerOf('bottom')
    // A point on the name, in the stack's own coordinates: left of its canvas.
    let found = null
    for (let x = -corner; x < 0 && found === null; x += 1) {
      for (let y = 0; y < 24 && found === null; y += 1) found = lanes.nameAt('bottom', x, y)
    }
    expect(found?.entry.label).toBe('ATAC peaks')
    const [bx, , width] = found?.hit.box ?? [0, 0, 0, 0]
    expect(bx).toBeLessThan(0)
    // Clear of the handle, which hangs before the data.
    expect(bx + width).toBeLessThanOrEqual(0)
  })

  it('stands below a right stack, its name reading up to the stack’s foot', () => {
    const lanes = lanesWith('right', 'Pol II peaks')
    settle(lanes)
    const corner = lanes.cornerOf('right')
    expect(corner).toBeGreaterThan(0)
    expect(lanes.labelCanvases.right.style.height).toBe(`${corner}px`)
    // Past the data and the handle under it, along the stack's own axis.
    let found = null
    for (let y = 412; y < 412 + corner + 20 && found === null; y += 1) {
      for (let x = 0; x < 24 && found === null; x += 1) found = lanes.nameAt('right', x, y)
    }
    expect(found?.entry.label).toBe('Pol II peaks')
    expect(found?.hit.box[1]).toBeGreaterThan(406)
  })

  it('opens above a left stack and right of a top one', () => {
    const left = lanesWith('left', 'scalogram')
    settle(left)
    expect(left.labelCanvases.left.classList.contains('hidden')).toBe(false)
    expect(left.cornerReach(geometry()).top).toBe(left.cornerOf('left'))
    const top = lanesWith('top', 'ATAC')
    settle(top)
    expect(top.labelCanvases.top.classList.contains('hidden')).toBe(false)
    expect(top.cornerReach(geometry()).right).toBe(top.cornerOf('top'))
  })

  it('gives the figure the room the corner takes, by side of the map', () => {
    const lanes = lanesWith('bottom', 'ATAC peaks')
    settle(lanes)
    expect(lanes.cornerReach(geometry())).toEqual({ left: lanes.cornerOf('bottom'), top: 0, right: 0, bottom: 0 })
  })

  it('stops at a column’s width, wrapping a long name rather than taking the map’s room', () => {
    const lanes = lanesWith('bottom', 'Yeast_ATAC_G2M_replicate_two_merged_peaks_IDR_0.05')
    settle(lanes)
    // The cap, its padding, and the six-pixel margin the stack already has
    // (less the handle's room in it, which a short margin does not have).
    expect(lanes.cornerOf('bottom')).toBeLessThanOrEqual(150 + 4 + 4 + 1)
  })

  it('needs no corner with the track text off, and leaves nothing hanging off a lane', () => {
    setPlotOptions({ text: false })
    const lanes = lanesWith('bottom', 'ATAC peaks')
    settle(lanes)
    expect(lanes.cornerOf('bottom')).toBe(0)
    expect(lanes.labelCanvases.bottom.classList.contains('hidden')).toBe(true)
    setPlotOptions({ text: true })
    // A 14-pixel lane at a larger text size had room left past it for a name
    // written across it; with the names in a corner it is the height it was given.
    setTextScale(1.35)
    expect(lanesWith('bottom', 'ATAC peaks', false, 14).thicknessOf('bottom')).toBe(19)
    expect(lanesWith('bottom', 'ATAC peaks', true, 14).thicknessOf('bottom')).toBe(14)
  })

  it('is not opened by a surface that mounts no corners', () => {
    const lanes = lanesWith('bottom', 'ATAC peaks', false)
    settle(lanes)
    expect(lanes.cornerOf('bottom')).toBe(0)
    expect(lanes.labelCanvases.bottom.classList.contains('hidden')).toBe(true)
  })
})

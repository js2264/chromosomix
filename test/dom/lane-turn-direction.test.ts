// @vitest-environment jsdom
/**
 * Which way a lane grows under a turned map (§17.4).
 *
 * A turned map has one stack, below the band, and every lane falls into it from
 * whichever edge it was put on. A lane put beside the square map is turned on
 * arrival to grow away from it on that side — which is where a computed track
 * opens — and drawn with that flip below the band it hung downwards, away from
 * the picture, under lanes that rose to meet it. Under the turn every lane grows
 * towards the band; the flip it is stored with is the square map's, untouched,
 * and drawn again when the map is square.
 *
 * Read off the drawing itself: a loop set drawn as arcs needs no samples
 * fetched, so the flip the lane is painted with is the flip `drawArcs` is handed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseBedpe } from '@/annotations/parse'
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle, type LaneEdge } from '@/annotations/types'
import { LocusAxis } from '@/render/locus'
import { Scale } from '@/render/scale'
import { AnnotationLanes, type LaneGeometry } from '@/ui/AnnotationLanes'
import { setUpDom, type DomTeardown } from '../support/dom'

/** The flip every arc drawing was handed, in order. */
const drawn: boolean[] = []

vi.mock('@/render/browser', async (load) => {
  const real = await load<typeof import('@/render/browser')>()
  return {
    ...real,
    drawArcs: (...args: Parameters<typeof real.drawArcs>) => {
      drawn.push(args[4]?.flip === true)
      return real.drawArcs(...args)
    },
  }
})

const LENGTH = 400_000

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  drawn.length = 0
})

afterEach(() => {
  teardown()
})

function axis(): LocusAxis {
  return new LocusAxis([
    { contig: 'IV', unitStart: 0, unitEnd: LENGTH, bpStart: 0, bpPerUnit: 1, contigLength: LENGTH },
  ])
}

/** A loop set on one edge, stored with `flip`, on a square map or a turned one. */
function lanesWith(edge: LaneEdge, flip: boolean, turned: boolean): AnnotationLanes {
  const store = new AnnotationStore(`turn-${Math.random()}.cool`, { persist: false })
  store.begin({
    card: 'linear',
    kind: 'pairs',
    id: 'loops',
    label: 'loops',
    source: { kind: 'local', name: 'loops.bedpe', file: new File([], 'loops.bedpe') },
    placement: { top: edge === 'top', right: edge === 'right', bottom: edge === 'bottom', left: edge === 'left' },
    style: { ...defaultStyle('pairs', '#0072b2'), flip },
    visible: true,
  })
  // `begin` records a track as on its way, whatever it is handed; this is the
  // read landing.
  store.update('loops', {
    status: 'ready',
    payload: { kind: 'pairs', data: parseBedpe('IV\t100000\t110000\tIV\t200000\t210000\n') },
  })
  const lanes = new AnnotationLanes({ store, onChange: () => {} })
  lanes.setAxes(
    turned
      ? { rows: null, cols: axis(), turn: { maxSeparation: 200, direction: 'up', binsize: 1000, nrows: 200 } }
      : { rows: axis(), cols: axis() },
  )
  return lanes
}

/** Two frames, as the panel draws them: the first lays the stacks out, the second paints them. */
function paint(lanes: AnnotationLanes): void {
  lanes.draw(geometry())
  drawn.length = 0
  lanes.draw(geometry())
}

/** A 400-pixel map with a six-pixel margin all round. */
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

describe('a lane under a turned map', () => {
  it('is drawn beside the square map as it is stored', () => {
    paint(lanesWith('left', true, false))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.every((flip) => flip)).toBe(true)
  })

  it('grows towards the band from the edge beside the map it was put on, stored as it is', () => {
    // Stored turned round, as a lane arriving on the left is: below the band,
    // drawn unflipped, which on the bottom edge is towards the map.
    paint(lanesWith('left', true, true))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.every((flip) => !flip)).toBe(true)
  })

  it('grows towards the band from below the map too, even turned round there', () => {
    paint(lanesWith('bottom', true, true))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.every((flip) => !flip)).toBe(true)
  })
})

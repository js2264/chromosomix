// @vitest-environment jsdom
/**
 * A lane carried off its map by its grip (§16.9, `ui/laneCarry.ts`).
 *
 * The grip drag is a pointer drag captured on the lane's own canvas, so no
 * `dragover` reaches anything else on the page; the places a lane can land say
 * so through one registry instead, and the carrying map asks it where the
 * pointer is. What is asserted here is that contract from both ends — who is
 * told a lane is in the air, who answers a point, what each answer does — and
 * the one rule every landing keeps: the lane is **moved**, drawn where it was
 * let go and taken off the map it came from.
 *
 * jsdom lays nothing out, so each place's box is given to it by hand, as the
 * browser would measure it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { LEAD_MAP, laneOf, mapsOf, resolveStyle, type MapId } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import { placementOn } from '@/annotations/types'
import { assemblyOf } from '@/genome/assembly'
import { PanelDeck } from '@/panels/PanelDeck'
import type { TracksContext } from '@/panels/TracksPanel'
import {
  carried,
  endCarry,
  landingAt,
  offerLanding,
  startCarry,
  within,
  type LaneCarry,
  type LaneSurface,
} from '@/ui/laneCarry'
import { MatrixPanel } from '@/ui/MatrixPanel'
import { gripBox, type LaneFrame } from '@/render/lane'
import { all, setUpDom, type DomTeardown } from '../support/dom'

class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown
const cleanups: Array<() => void> = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  sessionStorage.clear()
})

afterEach(() => {
  // Every surface off offer: the registry is the module's, and a deck left
  // registered by one test would answer the next one's points.
  for (const clean of cleanups.splice(0, cleanups.length)) clean()
  endCarry()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
  vi.restoreAllMocks()
})

/** Give an element the box a browser would have measured for it. */
function boxAt(node: Element, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }),
  })
}

/** A session's one list of tracks, holding one bigWig drawn under the first map. */
function trackStore(): { store: AnnotationStore; id: string } {
  const store = new AnnotationStore(`lane-carry-${Math.random()}.cool`, { persist: false })
  const { id } = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'ATAC',
    source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
  })
  store.update(id, { status: 'ready' })
  return { store, id }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the places a lane can land', () => {
  function surface(answer: 'here' | null = null) {
    const told: Array<LaneCarry | null> = []
    const offered: LaneSurface = {
      landingAt: () => (answer === null ? null : { light: () => {}, take: () => {} }),
      carrying: (carry) => told.push(carry),
    }
    cleanups.push(offerLanding(offered))
    return { offered, told }
  }

  it('are all told when a lane is taken up, and when it is put down', () => {
    const one = surface()
    const two = surface()
    const carry: LaneCarry = { ids: ['t1'], from: LEAD_MAP, edge: 'bottom' }
    startCarry(carry)
    expect(carried()).toBe(carry)
    endCarry()
    expect(carried()).toBeNull()
    expect(one.told).toEqual([carry, null])
    expect(two.told).toEqual([carry, null])
  })

  it('include one offered while the lane is in the air — a cell the drop is opening', () => {
    const carry: LaneCarry = { ids: ['t1'], from: LEAD_MAP, edge: 'bottom' }
    startCarry(carry)
    const late = surface()
    expect(late.told).toEqual([carry])
  })

  it('answer a point from any surface but the one the lane is leaving', () => {
    const source = surface('here')
    const carry: LaneCarry = { ids: ['t1'], from: LEAD_MAP, edge: 'bottom' }
    // The source answers its own edges itself, from its own drag.
    expect(landingAt(5, 5, carry, source.offered)).toBeNull()
    surface('here')
    expect(landingAt(5, 5, carry, source.offered)).not.toBeNull()
  })

  it('stop answering once taken off offer', () => {
    const offered: LaneSurface = { landingAt: () => ({ light: () => {}, take: () => {} }) }
    const stop = offerLanding(offered)
    expect(landingAt(0, 0, { ids: [], from: LEAD_MAP, edge: 'bottom' })).not.toBeNull()
    stop()
    expect(landingAt(0, 0, { ids: [], from: LEAD_MAP, edge: 'bottom' })).toBeNull()
  })

  it('measure a point against a box, and nothing against a box that is not drawn', () => {
    const node = document.createElement('div')
    boxAt(node, 10, 10, 20, 20)
    expect(within(node, 15, 15)).toBe(true)
    expect(within(node, 9, 15)).toBe(false)
    boxAt(node, 10, 10, 0, 0)
    expect(within(node, 10, 10)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A map's edges
// ---------------------------------------------------------------------------

describe('another map’s edges', () => {
  function mapOf(store: AnnotationStore, map: MapId): MatrixPanel {
    const panel = new MatrixPanel({
      binsize: 1000,
      detachedControls: true,
      hideTitle: true,
      annotations: {
        store,
        map,
        manual: new ManualStore(`lane-carry-marks-${Math.random()}`),
        client: { request: () => Promise.resolve(null), drop: () => {} } as never,
        groups: new GroupSettings(`lane-carry-groups-${Math.random()}`),
        contigLength: () => undefined,
      },
    })
    document.body.append(panel.el)
    cleanups.push(() => panel.destroy())
    return panel
  }

  const zone = (panel: MatrixPanel, edge: string): HTMLElement => {
    const found = panel.el.querySelector<HTMLElement>(`.lane-drop-${edge}`)
    if (found === null) throw new Error(`no ${edge} rectangle`)
    return found
  }

  it('light up while a lane of another map is in the air, and not while one of their own is', () => {
    const { store } = trackStore()
    const lead = mapOf(store, LEAD_MAP)
    const other = mapOf(store, 'p1')
    const grid = (panel: MatrixPanel) => panel.el.querySelector('.panel-grid')
    startCarry({ ids: ['x'], from: LEAD_MAP, edge: 'bottom' })
    expect(grid(other)?.classList.contains('is-dropping')).toBe(true)
    // The map the lane is leaving shows its own rectangles from its own drag.
    expect(grid(lead)?.classList.contains('is-dropping')).toBe(false)
    endCarry()
    expect(grid(other)?.classList.contains('is-dropping')).toBe(false)
  })

  it('take a lane let go on one of them: drawn on that edge there, and off the map it left', () => {
    const { store, id } = trackStore()
    mapOf(store, LEAD_MAP)
    const other = mapOf(store, 'p1')
    const top = zone(other, 'top')
    boxAt(top, 100, 0, 300, 30)
    const carry: LaneCarry = { ids: [id], from: LEAD_MAP, edge: 'bottom' }
    startCarry(carry)
    const landing = landingAt(250, 15, carry)
    expect(landing).not.toBeNull()
    landing?.light(true)
    expect(top.classList.contains('over')).toBe(true)
    landing?.take(carry)
    endCarry()
    expect(top.classList.contains('over')).toBe(false)
    expect(mapsOf(store.placements, id)).toEqual(['p1'])
    expect(laneOf(store.placements, id, 'p1')?.placement).toEqual(placementOn('top'))
  })

  it('take one edge of a track drawn on two, leaving it on the other side of the map it left', () => {
    const { store, id } = trackStore()
    store.place(id, { ...placementOn('bottom'), left: true })
    mapOf(store, LEAD_MAP)
    const other = mapOf(store, 'p1')
    boxAt(zone(other, 'top'), 100, 0, 300, 30)
    const carry: LaneCarry = { ids: [id], from: LEAD_MAP, edge: 'bottom' }
    landingAt(250, 15, carry)?.take(carry)
    expect(laneOf(store.placements, id, 'p1')?.placement).toEqual(placementOn('top'))
    expect(laneOf(store.placements, id, LEAD_MAP)?.placement).toEqual(placementOn('left'))
    // Each reads the way its edge does. The lane left behind turns to grow
    // away from the map; the one that arrived is not turned with it.
    const entry = store.byId(id)
    const arrived = laneOf(store.placements, id, 'p1')
    if (entry === undefined || arrived === undefined) throw new Error('the track, on both maps')
    expect(entry.style.flip).toBe(true)
    expect(resolveStyle(entry.style, arrived).flip).toBe(false)
  })

  it('do not answer a lane of their own map, whose own drag knows the edge it came from', () => {
    const { store, id } = trackStore()
    const other = mapOf(store, 'p1')
    boxAt(zone(other, 'top'), 100, 0, 300, 30)
    expect(landingAt(250, 15, { ids: [id], from: 'p1', edge: 'bottom' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The deck: its `+` edges and its cells
// ---------------------------------------------------------------------------

describe('the deck', () => {
  /** A deck whose session carries tracks, over one list of them. */
  function deckWithTracks() {
    const { store, id } = trackStore()
    const tracks: TracksContext = {
      assembly: assemblyOf({
        uri: 'lead.cool',
        name: 'lead.cool',
        contigs: [{ name: 'chr1', length: 400_000 }],
        origin: 'cooler',
      }),
      store,
      // A read that never comes back: the lanes are drawn empty, which is all
      // a grip needs to be found.
      client: {
        request: () => new Promise(() => {}),
        cancellable: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
        drop: () => {},
      } as never,
      groups: new GroupSettings(`lane-carry-deck-groups-${Math.random()}`),
    }
    const published: Array<string | undefined> = []
    const deck = new PanelDeck({
      onMapsChange: (maps) => published.push(maps),
      memoryKey: () => 'lane-carry-deck',
      leadName: () => 'lead.cool',
      tracks: { context: () => tracks },
      annotations: () => ({ store }) as never,
      onTrackFile: () => {},
    })
    document.body.appendChild(deck.el)
    const view = document.createElement('div')
    view.appendChild(document.createElement('div')).className = 'view-head'
    deck.frame(view)
    cleanups.push(() => deck.destroy())
    return { deck, store, id, published }
  }

  /**
   * The browser inside the deck's first tracks cell, opened up: jsdom lays
   * nothing out, so the test draws it and reads where a lane's grip is.
   */
  const browserOf = (deck: PanelDeck) => {
    const slots = (deck as unknown as { slots: Array<{ cell: { kind?: string; browser?: unknown } | null }> }).slots
    const view = slots.find((slot) => slot.cell?.kind === 'tracks')?.cell?.browser
    if (view === undefined) throw new Error('no browser in the tracks cell')
    return view as unknown as { draw(): void; lanes: Array<{ frame: LaneFrame }>; gripRow(lane: { frame: LaneFrame }): number }
  }

  /** The tracks cells, as the placement control lists them: `tracks`, `tracks 2`… */
  const tracksCells = (deck: PanelDeck) => deck.mapList.filter((map) => map.label.startsWith('tracks'))

  it('opens a tracks cell for a lane let go on a `+`, and writes the link once, filled', () => {
    const { deck, store, id, published } = deckWithTracks()
    const before = published.length
    deck.landLaneGrowing('beside', { ids: [id], from: LEAD_MAP, edge: 'bottom' })
    const cells = tracksCells(deck)
    expect(cells).toHaveLength(1)
    expect(mapsOf(store.placements, id)).toEqual([cells[0]?.id])
    // One write, with the cell already a tracks cell. Two — an empty cell,
    // then the filled one — came back through the session a beat apart, and
    // the first, read as a link this deck had not written, rebuilt the cell
    // empty and put the lane back on the map it had left.
    expect(published.length - before).toBe(1)
    expect(published.at(-1)).toBe('tracks')
  })

  it('answers a point on a `+` edge, lit while the lane is over it', () => {
    const { deck, store, id } = deckWithTracks()
    const edge = deck.el.querySelector('.deck-grow.is-beside')
    if (edge === null) throw new Error('no + beside')
    boxAt(edge, 900, 0, 24, 600)
    const carry: LaneCarry = { ids: [id], from: LEAD_MAP, edge: 'bottom' }
    startCarry(carry)
    const landing = landingAt(910, 300, carry)
    expect(landing).not.toBeNull()
    landing?.light(true)
    expect(edge.classList.contains('over')).toBe(true)
    landing?.light(false)
    landing?.take(carry)
    endCarry()
    expect(edge.classList.contains('over')).toBe(false)
    expect(mapsOf(store.placements, id)).toEqual([tracksCells(deck)[0]?.id])
  })

  it('makes an empty cell a tracks cell drawing the lane let go on it', () => {
    const { deck, store, id } = deckWithTracks()
    deck.grow('below')
    const empty = deck.el.querySelector('.deck-grid > .is-vacant')
    if (empty === null) throw new Error('no empty cell')
    boxAt(empty, 0, 600, 400, 400)
    const carry: LaneCarry = { ids: [id], from: LEAD_MAP, edge: 'bottom' }
    landingAt(200, 800, carry)?.take(carry)
    expect(all(deck.el, '.deck-grid > .is-vacant')).toHaveLength(0)
    const cells = tracksCells(deck)
    expect(cells).toHaveLength(1)
    expect(mapsOf(store.placements, id)).toEqual([cells[0]?.id])
  })

  it('opens a cell for one edge of a track drawn on two, and leaves it on the other', () => {
    // The track along the bottom and the left of the first map, its bottom
    // lane carried to a `+`: a cell of its own, and still along the left.
    const { deck, store, id } = deckWithTracks()
    store.place(id, { ...placementOn('bottom'), left: true })
    deck.landLaneGrowing('beside', { ids: [id], from: LEAD_MAP, edge: 'bottom' })
    const [cell] = tracksCells(deck)
    if (cell === undefined) throw new Error('no tracks cell')
    expect(laneOf(store.placements, id, cell.id)?.placement).toEqual(placementOn('bottom'))
    expect(laneOf(store.placements, id, LEAD_MAP)?.placement).toEqual(placementOn('left'))
    const arrived = laneOf(store.placements, id, cell.id)
    const entry = store.byId(id)
    if (entry === undefined || arrived === undefined) throw new Error('the track, on both')
    expect(resolveStyle(entry.style, arrived).flip).toBe(false)
  })

  it('carries a lane off a tracks cell by its grip, to wherever it is let go', () => {
    // The grip on a tracks cell's lane only ever reordered the stack, so a
    // track sent to a cell of its own could not be carried on to a map's edge
    // from there: the drag did nothing past the cell's own border (§16.9).
    const { deck, store, id } = deckWithTracks()
    deck.add({ kind: 'tracks' })
    const [cell] = tracksCells(deck)
    if (cell === undefined) throw new Error('no tracks cell')
    store.placeAt(id, cell.id, placementOn('bottom'))
    store.unplaceFrom(id, LEAD_MAP)
    // Somewhere to land, right of the cell — what a map's edge offers.
    const taken: LaneCarry[] = []
    const lit: boolean[] = []
    cleanups.push(
      offerLanding({
        landingAt: (x) => (x > 1000 ? { light: (on) => lit.push(on), take: (carry) => taken.push(carry) } : null),
      }),
    )
    const view = browserOf(deck)
    view.draw()
    const lane = view.lanes[0]
    if (lane === undefined) throw new Error('no lane in the cell')
    const [bx, by, bw, bh] = gripBox(lane.frame, view.gripRow(lane))
    const canvas = deck.el.querySelector<HTMLCanvasElement>('.deck-tracks .browser-canvas')
    if (canvas === null) throw new Error('no tracks canvas')
    boxAt(canvas, 0, 0, 800, 400)
    Object.assign(canvas, { setPointerCapture: () => {}, releasePointerCapture: () => {} })
    const press = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }))

    press('pointerdown', bx + bw / 2, by + bh / 2)
    const carry = { ids: [id], from: cell.id, edge: 'bottom' }
    expect(carried()).toEqual(carry)
    press('pointermove', 1100, 50)
    expect(lit).toEqual([true])
    press('pointerup', 1100, 50)
    expect(taken).toEqual([carry])
    expect(lit).toEqual([true, false])
    expect(carried()).toBeNull()
  })

  it('draws the lane in a tracks cell it is let go on — and not in the one it came from', () => {
    const { deck, store, id } = deckWithTracks()
    deck.add({ kind: 'tracks' })
    deck.add({ kind: 'tracks' })
    const [from, to] = tracksCells(deck)
    if (from === undefined || to === undefined) throw new Error('two tracks cells wanted')
    store.placeAt(id, from.id, placementOn('bottom'))
    store.unplaceFrom(id, LEAD_MAP)
    const [first, second] = all(deck.el, '.deck-grid > .deck-tracks')
    if (first === undefined || second === undefined) throw new Error('two tracks cells on screen')
    boxAt(first, 0, 0, 400, 400)
    boxAt(second, 400, 0, 400, 400)
    const carry: LaneCarry = { ids: [id], from: from.id, edge: 'bottom' }
    expect(landingAt(200, 200, carry)).toBeNull()
    landingAt(600, 200, carry)?.take(carry)
    expect(mapsOf(store.placements, id)).toEqual([to.id])
  })
})

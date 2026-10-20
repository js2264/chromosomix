/**
 * A called set as one row, on one of its two surfaces: a 1D track beside the
 * map, or an overlay on it (§18.7, `analysis/surfaces.ts`).
 *
 * What is pinned here is the conversion, the row it makes and the display that
 * moves it, because those are what every task's interval output goes through —
 * peaks, boundaries, domains, A/B segments, loops. Drawing either surface is the
 * code a loaded BED and a loaded BEDPE already go through, and is tested there.
 */

import { describe, expect, it } from 'vitest'

import { FeatureBuilder, PairBuilder } from '@/annotations/featureset'
import { FIELD_NAME, featureFields, fieldText, featuresOf } from '@/annotations/fields'
import { AnnotationStore } from '@/annotations/store'
import { remember } from '@/state/UiMemory'
import {
  adoptCalledSet,
  anchorsOf,
  calledPayloadOf,
  displayOf,
  isCalledSet,
  laneSetOf,
  laneStyleFor,
  legacyLaneIdOf,
  offersDisplay,
  offersLook,
  setDisplay,
  setLook,
  type CalledSet,
} from '@/analysis/surfaces'
import {
  emptyPlacement,
  overlayShapeOf,
  placementOn,
  type AnnotationPayload,
  type ComputedSource,
  type StoredEntry,
} from '@/annotations/types'

const source: ComputedSource = {
  kind: 'computed',
  name: 'A/B compartments',
  task: 'compartments',
  recipe: { taskVersion: 1, params: {}, framing: {} },
  framing: 'this file',
}

function compartments(): AnnotationPayload {
  const build = new FeatureBuilder()
  build.add('I', 0, 40_000, { name: 'A', score: 0.4 })
  build.add('I', 40_000, 90_000, { name: 'B', score: -0.3 })
  build.add('I', 90_000, 120_000, { name: 'A', score: 0.2 })
  return { kind: 'features', data: build.finish() }
}

function boundaries(): AnnotationPayload {
  const build = new FeatureBuilder()
  build.add('I', 10_000, 11_000, { name: 'boundary_1', score: 0.4 })
  build.add('I', 52_000, 53_000, { name: 'boundary_2', score: 0.9 })
  return { kind: 'features', data: build.finish() }
}

function loops(): AnnotationPayload {
  const build = new PairBuilder()
  build.add('I', 10_000, 11_000, 'I', 50_000, 51_000, { score: 2, name: 'loop_1' })
  build.add('I', 10_000, 11_000, 'I', 90_000, 91_000, { score: 5, name: 'loop_2' })
  return { kind: 'pairs', data: build.finish() }
}

function called(overrides: Partial<CalledSet> = {}): CalledSet {
  return {
    id: 'analysis:compartments:compartment-ab',
    label: 'A/B compartments',
    source,
    payload: compartments(),
    summary: '3 segments',
    colour: '#1f5fa9',
    map: 'lead',
    display: 'lane',
    look: 'corner',
    overlay: true,
    under: null,
    ...overrides,
  }
}

function fresh(): AnnotationStore {
  const store = new AnnotationStore(`surfaces-${Math.random()}.cool`)
  store.clear()
  return store
}

describe('what a called set draws as a lane', () => {
  it('is the set itself, for intervals', () => {
    const payload = compartments()
    expect(laneSetOf(payload)).toBe(payload.data)
  })

  it('is each anchor once, for pairs, with the best score of the pairs at it', () => {
    const anchors = anchorsOf((loops() as { kind: 'pairs'; data: never }).data)
    expect(anchors.length).toBe(3)
    expect(Array.from(anchors.start)).toEqual([10_000, 50_000, 90_000])
    expect(anchors.score[0]).toBe(5)
    expect(anchors.name[0]).toBe('loop_1')
    expect(anchors.detail[0]).toBe('anchors 2')
  })
})

describe('the name column', () => {
  it('is offered as a colouring where the set writes names, and read from the column', () => {
    const set = (compartments() as { kind: 'features'; data: never }).data
    const field = featureFields(set, 'segments').find((one) => one.key === FIELD_NAME)
    expect(field?.kind).toBe('name')
    expect(fieldText(set, 1, FIELD_NAME)).toBe('B')
  })

  it('is not offered where no row has a name', () => {
    const build = new FeatureBuilder()
    build.add('I', 0, 10, {})
    expect(featureFields(build.finish(), 'segments').some((one) => one.key === FIELD_NAME)).toBe(false)
  })

  it('colours a lane of a few kinds by them, and a lane of ids by the default', () => {
    const ab = (compartments() as { kind: 'features'; data: never }).data
    expect(featuresOf(laneStyleFor(ab, '#000', placementOn('left')), 'segments').colourBy).toBe(FIELD_NAME)
    const build = new FeatureBuilder()
    for (let i = 0; i < 40; i++) build.add('I', i * 100, i * 100 + 50, { name: `domain_${i + 1}` })
    expect(featuresOf(laneStyleFor(build.finish(), '#000', placementOn('left')), 'segments').colourBy).not.toBe(
      FIELD_NAME,
    )
  })
})

describe('a called set, as one row', () => {
  it('opens as a 1D track where its task says so: one row, beside the map and not on it', () => {
    const store = fresh()
    const id = adoptCalledSet(store, called())
    expect(id).toBe('analysis:compartments:compartment-ab')
    expect(store.entries).toHaveLength(1)
    const row = store.byId(id)
    expect(row).toMatchObject({ card: 'synthetic', kind: 'segments', status: 'ready', visible: true })
    expect(row?.partner).toBeUndefined()
    expect(isCalledSet(row as never)).toBe(true)
    expect(displayOf(row as never)).toBe('lane')
    expect(store.drawnOn('left').map((one) => one.id)).toEqual([id])
    expect(store.overlays()).toHaveLength(0)
  })

  it('opens on the map where its task says so, in its look, and not as a track', () => {
    const store = fresh()
    const id = adoptCalledSet(store, called({ display: 'overlay', look: 'corner' }))
    expect(store.overlays().map((one) => one.id)).toEqual([id])
    expect(store.drawnOn('left')).toHaveLength(0)
    expect(overlayShapeOf(store.byId(id)!.style)).toBe('corner')
  })

  it('moves between the two surfaces by its display, keeping its colour, name and slot', () => {
    const store = fresh()
    const id = adoptCalledSet(store, called({ payload: boundaries(), display: 'lane', look: 'point' }))
    store.restyle(id, { colour: '#ff0000' })
    setDisplay(store, id, 'overlay')
    expect(store.overlays().map((one) => one.id)).toEqual([id])
    expect(store.drawnOn('left')).toHaveLength(0)
    expect(store.byId(id)?.style.colour).toBe('#ff0000')
    // On the map, a set of places is a point until the reader picks the marker.
    expect(offersLook(store.byId(id)!)).toBe(true)
    setLook(store, id, 'border')
    expect(overlayShapeOf(store.byId(id)!.style)).toBe('border')
    setDisplay(store, id, 'lane')
    expect(store.drawnOn('left').map((one) => one.id)).toEqual([id])
    expect(store.overlays()).toHaveLength(0)
    expect(store.entries).toHaveLength(1)
  })

  it('offers a look only for a set of places: an extent is a corner, a loop a ring', () => {
    const store = fresh()
    const domains = adoptCalledSet(store, called({ id: 'a', display: 'overlay', look: 'corner' }))
    const places = adoptCalledSet(store, called({ id: 'b', payload: boundaries(), display: 'overlay', look: 'point' }))
    const rings = adoptCalledSet(store, called({ id: 'c', payload: loops(), display: 'overlay', look: 'corner' }))
    expect(offersLook(store.byId(domains)!)).toBe(false)
    expect(offersLook(store.byId(places)!)).toBe(true)
    expect(offersLook(store.byId(rings)!)).toBe(false)
  })

  it('gives a track its edges back on a map it was put on as an overlay', () => {
    const store = fresh()
    const id = adoptCalledSet(store, called({ display: 'overlay' }))
    // Lit in the maps field, or dropped on a map's face: a lane with no edge.
    store.placeOn(id, 'm2', emptyPlacement())
    setDisplay(store, id, 'lane')
    expect(store.laneFor(id, 'm2')?.placement).toEqual(placementOn('left'))
  })

  it('puts the row directly under the row it is read against, on that row’s edges', () => {
    const store = fresh()
    const coverage = store.begin({ card: 'linear', kind: 'track', source: { kind: 'derived', name: 'ATAC' } })
    store.update(coverage.id, { status: 'ready' })
    const other = store.begin({ card: 'linear', kind: 'track', source: { kind: 'derived', name: 'Pol II' } })
    store.update(other.id, { status: 'ready' })
    const id = adoptCalledSet(store, called({ under: coverage.id }))
    expect(store.entries.map((row) => row.id)).toEqual([coverage.id, id, other.id])
    expect(store.drawnOn('bottom').map((row) => row.id)).toEqual([coverage.id, id, other.id])
  })

  it('keeps, on a second run, its display, its look, its edges, its colour and whether it is shown', () => {
    const store = fresh()
    const id = adoptCalledSet(store, called({ payload: boundaries(), look: 'point' }))
    store.place(id, placementOn('top'))
    store.restyle(id, { colour: '#ff0000' })
    setDisplay(store, id, 'overlay')
    setLook(store, id, 'border')
    store.update(id, { visible: false })
    adoptCalledSet(store, called({ payload: boundaries(), look: 'point', summary: '2 boundaries' }))
    const row = store.byId(id)
    expect(row?.card).toBe('overlay')
    expect(overlayShapeOf(row!.style)).toBe('border')
    expect(row?.visible).toBe(false)
    expect(row?.style.colour).toBe('#ff0000')
    expect(row?.placement).toEqual(placementOn('top'))
    expect(row?.summary).toBe('2 boundaries')
    expect(store.entries).toHaveLength(1)
  })

  it('takes the task’s look on a second run over a look of the other family', () => {
    // A box, stored before the looks, on a set of boundaries: a corner of a
    // one-bin square is a hook, and the task's point is what it gets instead.
    const store = fresh()
    const id = adoptCalledSet(store, called({ payload: boundaries(), display: 'overlay', look: 'point' }))
    store.restyle(id, { shape: 'element' as never })
    adoptCalledSet(store, called({ payload: boundaries(), display: 'overlay', look: 'point' }))
    expect(overlayShapeOf(store.byId(id)!.style)).toBe('point')
  })

  it('is a track alone where there is no map, whatever its task opens it as', () => {
    const browser = fresh()
    const id = adoptCalledSet(browser, called({ overlay: false, display: 'overlay' }))
    expect(browser.entries).toHaveLength(1)
    expect(browser.byId(id)?.card).toBe('synthetic')
  })

  it('removes the lane a session written as two rows left behind, when it is run again', () => {
    const store = fresh()
    const id = 'analysis:compartments:compartment-ab'
    store.begin({ card: 'synthetic', kind: 'segments', id: legacyLaneIdOf(id), source })
    adoptCalledSet(store, called())
    expect(store.entries.map((row) => row.id)).toEqual([id])
  })
})

describe('a loop set, on its two surfaces', () => {
  it('is its pairs on both surfaces: rings on the map, arcs as a 1D track', () => {
    const store = fresh()
    const id = adoptCalledSet(store, called({ payload: loops(), display: 'overlay' }))
    expect(store.byId(id)?.kind).toBe('pairs')
    expect(store.overlays().map((row) => row.id)).toEqual([id])
    setDisplay(store, id, 'lane')
    const lane = store.byId(id)
    expect(lane?.kind).toBe('pairs')
    expect(lane?.payload?.kind === 'pairs' ? lane.payload.data.length : 0).toBe(2)
    expect(store.drawnOn('left').map((row) => row.id)).toEqual([id])
    // …and it leaves as its loops from either surface.
    expect(calledPayloadOf(lane!)?.kind).toBe('pairs')
    setDisplay(store, id, 'overlay')
    const back = store.byId(id)
    expect(back?.kind).toBe('pairs')
    expect(back?.payload?.kind === 'pairs' ? back.payload.data.length : 0).toBe(2)
  })
})

describe('a loaded set of pairs (§8.1)', () => {
  it('takes the same two displays, a loaded track’s card on the way to a lane', () => {
    const store = fresh()
    const entry = store.begin({
      card: 'overlay',
      kind: 'pairs',
      source: { kind: 'remote', url: 'https://x/loops.bedpe', name: 'loops.bedpe' },
    })
    store.update(entry.id, { status: 'ready', payload: loops() })
    expect(offersDisplay(store.byId(entry.id)!)).toBe(true)
    setDisplay(store, entry.id, 'lane')
    expect(store.byId(entry.id)?.card).toBe('linear')
    expect(store.byId(entry.id)?.kind).toBe('pairs')
    setDisplay(store, entry.id, 'overlay')
    expect(store.byId(entry.id)?.card).toBe('overlay')
  })

  it('leaves as its anchors, each exact place once', () => {
    const anchors = anchorsOf((loops() as { kind: 'pairs'; data: never }).data)
    const places = Array.from({ length: anchors.length }, (_, i) => `${anchors.contigs[anchors.contig[i]]}:${anchors.start[i]}`)
    expect(new Set(places).size).toBe(places.length)
  })
})

describe('a called set across a reload (§8.6)', () => {
  it('remembers its one row and which surface it is on', () => {
    const uri = `surfaces-kept-${Math.random()}.cool`
    const store = new AnnotationStore(uri)
    store.clear()
    const id = adoptCalledSet(store, called({ payload: boundaries(), look: 'point' }))
    setDisplay(store, id, 'overlay')
    setLook(store, id, 'border')
    const stored = AnnotationStore.stored(uri)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id, card: 'overlay', kind: 'segments', visible: true })
    expect(stored[0].style.shape).toBe('border')
    expect(stored[0].partner).toBeUndefined()
    expect(stored[0].source.kind).toBe('computed')
  })

  /** A pair as a build that drew a called set as two rows wrote it down. */
  function legacyPair(overlayVisible: boolean, laneVisible: boolean): StoredEntry[] {
    const id = 'analysis:insulation:insulation-domains'
    const stored = { kind: 'computed' as const, name: 'Insulation domains', task: 'insulation', recipe: {}, framing: 'f' }
    const style = {
      colour: '#c040a0',
      size: 24,
      mode: 'area' as const,
      limits: { auto: true, min: 0, max: 1 },
      group: '',
      radius: 7,
      flip: false,
    }
    return [
      {
        id: legacyLaneIdOf(id),
        card: 'synthetic',
        kind: 'segments',
        label: 'Insulation domains',
        source: stored,
        visible: laneVisible,
        placement: placementOn('left'),
        style: { ...style, shape: 'corner', opacity: 1 },
        partner: id,
      },
      {
        id,
        card: 'overlay',
        kind: 'segments',
        label: 'Insulation domains',
        source: stored,
        visible: overlayVisible,
        placement: emptyPlacement(),
        style: { ...style, shape: 'element' as never, opacity: 0.6 },
        partner: legacyLaneIdOf(id),
      },
    ]
  }

  it('folds a pair written as two rows into one, a track where its lane was on', () => {
    const uri = `surfaces-legacy-${Math.random()}.cool`
    remember(uri, 'annotations', legacyPair(true, true))
    const rows = AnnotationStore.stored(uri)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'analysis:insulation:insulation-domains',
      card: 'synthetic',
      visible: true,
      placement: placementOn('left'),
    })
    expect(rows[0].partner).toBeUndefined()
    // The overlay's look and opacity ride along, for when it goes on the map.
    expect(rows[0].style.opacity).toBe(0.6)
    expect(overlayShapeOf(rows[0].style)).toBe('corner')
  })

  it('folds it onto the map where only the overlay was drawn', () => {
    const uri = `surfaces-legacy-${Math.random()}.cool`
    remember(uri, 'annotations', legacyPair(true, false))
    const rows = AnnotationStore.stored(uri)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ card: 'overlay', visible: true })
    // Its edges are the lane's, for when it is made a track again.
    expect(rows[0].placement).toEqual(placementOn('left'))
  })
})

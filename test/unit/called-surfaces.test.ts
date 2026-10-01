/**
 * A called set on both surfaces: an overlay on the map and a lane beside it
 * (§18.7, `analysis/surfaces.ts`).
 *
 * What is pinned here is the conversion and the two rows it makes, because
 * those are what every task's interval output goes through — peaks, boundaries,
 * domains, A/B segments, loops. Drawing either row is the code a loaded BED and
 * a loaded BEDPE already go through, and is tested there.
 */

import { describe, expect, it } from 'vitest'

import { FeatureBuilder, PairBuilder } from '@/annotations/featureset'
import { FIELD_NAME, featureFields, fieldText, featuresOf } from '@/annotations/fields'
import { AnnotationStore } from '@/annotations/store'
import {
  adoptCalledSet,
  anchorsOf,
  laneIdOf,
  laneSetOf,
  laneStyleFor,
  surfaceWord,
  surfacesOf,
  type CalledSet,
} from '@/analysis/surfaces'
import { placementOn, type AnnotationPayload, type ComputedSource } from '@/annotations/types'

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
    overlay: true,
    lane: true,
    laneShown: true,
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

describe('a called set, as its two rows', () => {
  it('is an overlay on the map and a lane beside it, each naming the other', () => {
    const store = fresh()
    const ids = adoptCalledSet(store, called())
    expect(ids).toEqual({ overlay: 'analysis:compartments:compartment-ab', lane: laneIdOf(ids.overlay ?? '') })
    expect(store.overlays().map((row) => row.id)).toEqual([ids.overlay])
    expect(store.drawnOn('left').map((row) => row.id)).toEqual([ids.lane])
    const overlay = store.byId(ids.overlay ?? '')
    const lane = store.byId(ids.lane ?? '')
    expect(overlay?.partner).toBe(ids.lane)
    expect(lane?.partner).toBe(ids.overlay)
    expect(lane?.card).toBe('synthetic')
    expect(lane?.kind).toBe('segments')
    expect(lane?.payload).toEqual(overlay?.payload)
    expect(surfacesOf(store, lane as never)).toEqual({ overlay, lane })
  })

  it('says on each row which surface it is, and nothing on any other row', () => {
    const store = fresh()
    const ids = adoptCalledSet(store, called())
    expect(surfaceWord(store.byId(ids.overlay ?? '') as never)).toBe('on the map')
    expect(surfaceWord(store.byId(ids.lane ?? '') as never)).toBe('as a lane')
    const alone = fresh()
    adoptCalledSet(alone, called({ overlay: false }))
    expect(surfaceWord(alone.entries[0])).toBeNull()
  })

  it('puts the lane directly under the row it is read against, on that row’s edges', () => {
    const store = fresh()
    const coverage = store.begin({ card: 'linear', kind: 'track', source: { kind: 'derived', name: 'ATAC' } })
    store.update(coverage.id, { status: 'ready' })
    const other = store.begin({ card: 'linear', kind: 'track', source: { kind: 'derived', name: 'Pol II' } })
    store.update(other.id, { status: 'ready' })
    const ids = adoptCalledSet(store, called({ under: coverage.id }))
    expect(store.entries.map((row) => row.id)).toEqual([coverage.id, ids.lane, other.id, ids.overlay])
    expect(store.drawnOn('bottom').map((row) => row.id)).toEqual([coverage.id, ids.lane, other.id])
  })

  it('keeps, on a second run, which surfaces the reader switched off and where the lane was', () => {
    const store = fresh()
    const ids = adoptCalledSet(store, called())
    store.update(ids.overlay ?? '', { visible: false })
    store.place(ids.lane ?? '', placementOn('top'))
    store.restyle(ids.lane ?? '', { colour: '#ff0000' })
    adoptCalledSet(store, called({ summary: '4 segments' }))
    expect(store.byId(ids.overlay ?? '')?.visible).toBe(false)
    expect(store.byId(ids.lane ?? '')?.visible).toBe(true)
    expect(store.byId(ids.lane ?? '')?.style.colour).toBe('#ff0000')
    expect(store.drawnOn('top').map((row) => row.id)).toEqual([ids.lane])
    expect(store.entries.filter((row) => row.id === ids.lane)).toHaveLength(1)
  })

  it('is a lane alone where there is no map, and an overlay alone where there are no lanes', () => {
    const browser = fresh()
    expect(adoptCalledSet(browser, called({ overlay: false })).overlay).toBeNull()
    expect(browser.entries).toHaveLength(1)
    expect(browser.entries[0].partner).toBeUndefined()
    expect(surfacesOf(browser, browser.entries[0])).toBeNull()

    const metacool = fresh()
    expect(adoptCalledSet(metacool, called({ lane: false })).lane).toBeNull()
    expect(metacool.entries).toHaveLength(1)
    expect(metacool.entries[0].card).toBe('overlay')
    expect(metacool.entries[0].partner).toBeUndefined()
  })

  it('starts a loop set’s anchors switched off, as a row the reader can switch on', () => {
    const store = fresh()
    const ids = adoptCalledSet(store, called({ payload: loops(), laneShown: false }))
    expect(store.byId(ids.overlay ?? '')?.kind).toBe('pairs')
    expect(store.byId(ids.lane ?? '')?.visible).toBe(false)
    expect(store.drawnOn('left')).toHaveLength(0)
    const lane = store.byId(ids.lane ?? '')
    expect(lane?.payload?.kind === 'features' ? lane.payload.data.length : 0).toBe(3)
  })

  it('remembers both rows, the link between them and which is drawn (§8.6)', () => {
    const uri = `surfaces-kept-${Math.random()}.cool`
    const store = new AnnotationStore(uri)
    store.clear()
    const ids = adoptCalledSet(store, called())
    store.update(ids.lane ?? '', { visible: false })
    const stored = AnnotationStore.stored(uri)
    const lane = stored.find((row) => row.id === ids.lane)
    const overlay = stored.find((row) => row.id === ids.overlay)
    expect(lane).toMatchObject({ card: 'synthetic', kind: 'segments', visible: false, partner: ids.overlay })
    expect(overlay).toMatchObject({ card: 'overlay', kind: 'segments', visible: true, partner: ids.lane })
    expect(lane?.source.kind).toBe('computed')
  })
})

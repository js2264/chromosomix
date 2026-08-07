/**
 * The 4C profile as a lane in the store.
 *
 * The claim being tested is not that a profile is drawn — that is
 * `viewpoint.test.ts`'s arithmetic — but that the *lane* is an ordinary entry:
 * it can be styled, moved, renamed and hidden through the same store methods
 * every track uses, and every place that treats entries as files leaves it
 * alone. Those two together are the whole of "first-class", and each of them
 * fails quietly: a synthetic entry that reaches the persistence path comes back
 * as a broken row on the next reload, and one that misses the lane path is
 * simply not drawn.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '../../src/annotations/store'
import { LANE_EDGES, placementOn } from '../../src/annotations/types'
import {
  VIEWPOINT_EDGE,
  VIEWPOINT_ID,
  isViewpointShown,
  resetViewpoint,
  setViewpointAnchor,
  showViewpoint,
  syncViewpointLabel,
  viewpointEntry,
} from '../../src/ui/viewpoint'

const int = (n: number): string => String(n)

let store: AnnotationStore
let uri = 0

beforeEach(() => {
  resetViewpoint()
  store = new AnnotationStore(`viewpoint-${uri++}.cool`)
})

/** A loaded track, for the tests about what the profile must *not* disturb. */
function track(): string {
  const entry = store.begin({
    card: 'linear',
    kind: 'track',
    source: { kind: 'local', file: new File([], 'a.bw'), name: 'a.bw' },
  })
  store.update(entry.id, { status: 'ready' })
  return entry.id
}

describe('switching the profile on', () => {
  it('is off until it is asked for', () => {
    expect(isViewpointShown(store)).toBe(false)
    expect(viewpointEntry(store)).toBeUndefined()
    for (const edge of LANE_EDGES) expect(store.drawnOn(edge)).toHaveLength(0)
  })

  // `ready` and not `loading`: `drawnOn` draws what is ready, and there is no
  // file behind this one to wait for.
  it('arrives ready, visible, and drawn above the map', () => {
    showViewpoint(store, true, int)
    const entry = viewpointEntry(store)
    expect(entry?.status).toBe('ready')
    expect(entry?.visible).toBe(true)
    expect(entry?.placement).toEqual(placementOn(VIEWPOINT_EDGE))
    expect(store.drawnOn(VIEWPOINT_EDGE).map((row) => row.id)).toEqual([VIEWPOINT_ID])
  })

  // Every new lane grows towards the map, whichever side of it that is, and the
  // profile is a lane: above the map that means hanging down towards it.
  it('faces the map like every other new lane', () => {
    showViewpoint(store, true, int)
    expect(viewpointEntry(store)?.style.flip).toBe(true)
  })

  // Hiding rather than removing is what makes the button safe to press twice:
  // the colour, the height and the edge are decisions about *this* reader's
  // profile, and a lane that came back in the factory's colours every time is
  // one nobody would bother to style.
  it('keeps what the reader styled when it is switched off and on', () => {
    showViewpoint(store, true, int)
    store.restyle(VIEWPOINT_ID, { colour: '#123456', size: 140 })
    store.place(VIEWPOINT_ID, placementOn('left'))
    showViewpoint(store, false, int)
    expect(isViewpointShown(store)).toBe(false)
    expect(store.drawnOn('left')).toHaveLength(0)
    showViewpoint(store, true, int)
    expect(viewpointEntry(store)?.style.colour).toBe('#123456')
    expect(viewpointEntry(store)?.style.size).toBe(140)
    expect(store.drawnOn('left').map((row) => row.id)).toEqual([VIEWPOINT_ID])
  })

  it('can be moved to any edge, and turns its axis to keep facing the map', () => {
    showViewpoint(store, true, int)
    // Above the map, facing it means growing down; below it, growing up. Both
    // are `place`'s doing, and neither is the caller's to know.
    expect(viewpointEntry(store)?.style.flip).toBe(true)
    store.place(VIEWPOINT_ID, placementOn('bottom'))
    expect(viewpointEntry(store)?.style.flip).toBe(false)
    store.place(VIEWPOINT_ID, placementOn('right'))
    expect(viewpointEntry(store)?.style.flip).toBe(true)
    store.place(VIEWPOINT_ID, placementOn('left'))
    expect(viewpointEntry(store)?.style.flip).toBe(false)
  })
})

describe('the name it opens with', () => {
  it('follows the anchor while it is still the name we wrote', () => {
    showViewpoint(store, true, int)
    expect(viewpointEntry(store)?.label).toBe('4C')
    setViewpointAnchor({ contig: 'chrIV', start: 1000, end: 2000 })
    syncViewpointLabel(store, int)
    expect(viewpointEntry(store)?.label).toBe('4C · chrIV:1001–2000')
    setViewpointAnchor({ contig: 'chrI', start: 0, end: 500 })
    syncViewpointLabel(store, int)
    expect(viewpointEntry(store)?.label).toBe('4C · chrI:1–500')
  })

  // A renameable lane whose name is also derived has to answer one question:
  // has the reader taken it over? Once they have, it is theirs for good — an
  // anchor moved afterwards must not overwrite what they typed.
  it('stops following once the reader has renamed it', () => {
    showViewpoint(store, true, int)
    setViewpointAnchor({ contig: 'chrIV', start: 1000, end: 2000 })
    syncViewpointLabel(store, int)
    store.update(VIEWPOINT_ID, { label: 'promoter contacts' })
    setViewpointAnchor({ contig: 'chrI', start: 0, end: 500 })
    syncViewpointLabel(store, int)
    expect(viewpointEntry(store)?.label).toBe('promoter contacts')
  })
})

/**
 * What the store must *not* do with it.
 *
 * The profile is computed from the block on screen, so there is nothing a reload
 * could re-read and nothing another file could inherit. Both of those paths take
 * every entry they are given, so the exclusion has to be theirs rather than the
 * caller's.
 */
describe('what a session remembers', () => {
  it('remembers the tracks and not the profile', () => {
    const key = `viewpoint-persist-${uri++}.cool`
    const persisting = new AnnotationStore(key)
    const entry = persisting.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'remote', url: 'https://example.org/a.bw', name: 'a.bw' },
    })
    persisting.update(entry.id, { status: 'ready' })
    showViewpoint(persisting, true, int)
    const stored = AnnotationStore.stored(key)
    expect(stored.map((row) => row.id)).toEqual([entry.id])
  })

  it('writes nothing at all from a store that persists nothing', () => {
    const key = `viewpoint-private-${uri++}.cool`
    const private_ = new AnnotationStore(key, { persist: false })
    showViewpoint(private_, true, int)
    private_.restyle(VIEWPOINT_ID, { colour: '#abcdef' })
    expect(AnnotationStore.stored(key)).toEqual([])
  })
})

describe('living beside real tracks', () => {
  it('shares a stack with them, and reorders through the same list', () => {
    const first = track()
    showViewpoint(store, true, int)
    store.place(VIEWPOINT_ID, placementOn('bottom'))
    expect(store.drawnOn('bottom').map((row) => row.id)).toEqual([first, VIEWPOINT_ID])
    // By identity through the whole list, which is what every lane drag does.
    store.moveTo(VIEWPOINT_ID, 0)
    expect(store.drawnOn('bottom').map((row) => row.id)).toEqual([VIEWPOINT_ID, first])
  })

  it('takes a colour the tracks are not already using', () => {
    const first = track()
    showViewpoint(store, true, int)
    expect(viewpointEntry(store)?.style.colour).not.toBe(store.byId(first)?.style.colour)
  })
})

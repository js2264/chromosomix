/**
 * One list of tracks, drawn in many places.
 *
 * The model's whole claim is that a lane which was never given a patch keeps
 * following its track *for good* — not that it happens to match today. Most of
 * what follows tests that claim from a different side each time, because the
 * failure it guards against is the one nobody sees: a "propagate" that copies
 * the style instead of deferring to it looks identical the moment it runs, and
 * silently stops agreeing the first time somebody recolours the track.
 *
 * The other half is about what a placement is *not* allowed to differ on. Every
 * field a lane can override is a field two maps can then disagree about, and a
 * deck exists so that they do not — so the narrowness of `LANE_OVERRIDES` is a
 * property worth pinning rather than a detail.
 */

import { describe, expect, it } from 'vitest'

import {
  LANE_OVERRIDES,
  LEAD_MAP,
  clearOverride,
  isOverridden,
  isPlaced,
  lanesOn,
  mapsOf,
  place,
  propagate,
  pruneLanes,
  reorderLane,
  resolveStyle,
  unplace,
  withdraw,
  type Lane,
} from '@/annotations/placement'
import { defaultStyle, placementOn } from '@/annotations/types'

const track = () => defaultStyle('track', '#336699')

describe('the cascade', () => {
  it('draws a lane with the track’s own style where it says nothing', () => {
    expect(resolveStyle(track(), {})).toEqual(track())
  })

  it('lets a lane win on the fields it has been given, and only those', () => {
    const base = track()
    const lane: Lane = {
      track: 't', map: LEAD_MAP, placement: placementOn('bottom'),
      style: { limits: { min: 0, max: 50, auto: false } },
    }
    const resolved = resolveStyle(base, lane)
    expect(resolved.limits).toEqual({ min: 0, max: 50, auto: false })
    // Everything else still the track's — the same object's values, not a copy
    // taken at placement time.
    expect(resolved.colour).toBe(base.colour)
    expect(resolved.size).toBe(base.size)
    expect(resolved.mode).toBe(base.mode)
  })

  it('follows the track when the track changes, wherever it was not overridden', () => {
    // The claim `propagate` rests on. A lane holding a *copy* would pass every
    // assertion above and fail this one.
    const lane: Lane = { track: 't', map: 'p1', placement: placementOn('bottom') }
    const before = resolveStyle({ ...track(), colour: '#111111' }, lane)
    const after = resolveStyle({ ...track(), colour: '#eeeeee' }, lane)
    expect(before.colour).toBe('#111111')
    expect(after.colour).toBe('#eeeeee')
  })

  it('hands a field back, and leaves no empty patch behind', () => {
    // Two representations of "no override" would compare unequal in a store
    // that reconciles by structure.
    const lane: Lane = {
      track: 't', map: 'p1', placement: placementOn('bottom'),
      style: { limits: { min: 0, max: 9, auto: false } },
    }
    expect(isOverridden(lane, 'limits')).toBe(true)
    const cleared = clearOverride(lane, 'limits')
    expect(isOverridden(cleared, 'limits')).toBe(false)
    expect(cleared.style).toBeUndefined()
    expect(resolveStyle(track(), cleared)).toEqual(track())
  })

  it('keeps the other overrides when one is handed back', () => {
    const lane: Lane = {
      track: 't', map: 'p1', placement: placementOn('bottom'),
      style: { limits: { min: 0, max: 9, auto: false }, flip: true },
    }
    const cleared = clearOverride(lane, 'limits')
    expect(cleared.style).toEqual({ flip: true })
  })
})

describe('what a placement may differ on', () => {
  it('is the two fields that have a reason, and no others', () => {
    // Height especially: a deck reserves the same lane room on every panel so
    // the maps line up to the pixel, and a track two rows tall on one map and
    // three on another would put every picture beside it at a different height.
    expect([...LANE_OVERRIDES]).toEqual(['limits', 'flip'])
  })
})

describe('placing and taking away', () => {
  it('gives a track one lane per map, however often it is placed', () => {
    let lanes = place([], 't', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 't', LEAD_MAP, placementOn('right'))
    expect(lanes).toHaveLength(1)
    expect(isPlaced(lanes, 't', LEAD_MAP)).toBe(true)
  })

  it('moves a track between edges without losing what was set on it', () => {
    // Placing again replaces the edges and keeps the patch: dragging a lane from
    // the bottom to the right must not throw away the range somebody typed.
    const held: Lane = {
      track: 't', map: LEAD_MAP, placement: placementOn('bottom'),
      style: { limits: { min: 0, max: 7, auto: false } },
    }
    const moved = place([held], 't', LEAD_MAP, placementOn('right'))
    expect(moved[0].placement.right).toBe(true)
    expect(moved[0].placement.bottom).toBe(false)
    expect(moved[0].style).toEqual(held.style)
  })

  it('puts a new lane at the foot of the stack it lands in', () => {
    let lanes = place([], 'a', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 'b', LEAD_MAP, placementOn('bottom'))
    expect(lanesOn(lanes, LEAD_MAP).map((l) => l.track)).toEqual(['a', 'b'])
  })

  it('takes a track off one map and leaves it on the others', () => {
    let lanes = place([], 't', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 't', 'p1', placementOn('bottom'))
    expect(unplace(lanes, 't', LEAD_MAP).map((l) => l.map)).toEqual(['p1'])
  })

  it('keeps each map’s stack to itself', () => {
    let lanes = place([], 't', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 't', 'p1', placementOn('top'))
    expect(lanesOn(lanes, LEAD_MAP)).toHaveLength(1)
    expect(lanesOn(lanes, 'p1')[0].placement.top).toBe(true)
    expect(lanesOn(lanes, 'p2')).toHaveLength(0)
    expect(mapsOf(lanes, 't')).toEqual([LEAD_MAP, 'p1'])
  })
})

describe('one track across every map', () => {
  it('puts it at the edges it is already on', () => {
    const lanes = propagate(place([], 't', LEAD_MAP, placementOn('top')), 't', [LEAD_MAP, 'p1', 'p2'])
    expect(lanes).toHaveLength(3)
    for (const lane of lanes) expect(lane.placement.top).toBe(true)
  })

  it('mirrors every edge it is on, not just one of them', () => {
    const both: Lane = {
      track: 't', map: LEAD_MAP,
      placement: { ...placementOn('bottom'), right: true },
    }
    const lanes = propagate([both], 't', [LEAD_MAP, 'p1'])
    const copy = lanesOn(lanes, 'p1')[0]
    expect(copy.placement.bottom).toBe(true)
    expect(copy.placement.right).toBe(true)
  })

  it('serves a freshly imported track with nowhere to be yet', () => {
    const lanes = propagate([], 't', [LEAD_MAP, 'p1'])
    expect(lanes.map((l) => l.map)).toEqual([LEAD_MAP, 'p1'])
    for (const lane of lanes) expect(lane.placement.bottom).toBe(true)
  })

  it('creates no patch, so the copies cannot drift from the track', () => {
    // The whole reason to propagate rather than to duplicate.
    const lanes = propagate([], 't', [LEAD_MAP, 'p1', 'p2'])
    for (const lane of lanes) expect(lane.style).toBeUndefined()
  })

  it('leaves a lane that already exists exactly as it was, patch and all', () => {
    const kept: Lane = {
      track: 't', map: 'p1', placement: placementOn('right'),
      style: { limits: { min: 0, max: 3, auto: false } },
    }
    const lanes = propagate([kept], 't', [LEAD_MAP, 'p1'])
    expect(lanes.find((l) => l.map === 'p1')).toBe(kept)
  })
})

describe('taking a track back', () => {
  it('removes every lane and keeps the import', () => {
    // The reason a track and its lanes are different things: this leaves
    // something in the list to put back without reading the file again.
    let lanes = propagate([], 't', [LEAD_MAP, 'p1', 'p2'])
    lanes = place(lanes, 'other', 'p1', placementOn('bottom'))
    const left = withdraw(lanes, 't')
    expect(left.map((l) => l.track)).toEqual(['other'])
  })

  it('drops lanes whose track or map has gone', () => {
    let lanes = place([], 'a', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 'b', 'p1', placementOn('bottom'))
    lanes = place(lanes, 'a', 'p9', placementOn('bottom'))
    const kept = pruneLanes(lanes, new Set(['a', 'b']), new Set([LEAD_MAP, 'p1']))
    expect(kept.map((l) => `${l.track}@${l.map}`)).toEqual([`a@${LEAD_MAP}`, 'b@p1'])
  })
})

describe('order within a stack', () => {
  it('moves one lane and leaves the rest of the map where it was', () => {
    let lanes = place([], 'a', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 'x', 'p1', placementOn('bottom'))
    lanes = place(lanes, 'b', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 'c', LEAD_MAP, placementOn('bottom'))
    const moved = reorderLane(lanes, lanesOn(lanes, LEAD_MAP)[2], 0)
    expect(lanesOn(moved, LEAD_MAP).map((l) => l.track)).toEqual(['c', 'a', 'b'])
    // The other map is untouched, and still in the same absolute slot.
    expect(lanesOn(moved, 'p1').map((l) => l.track)).toEqual(['x'])
    expect(moved[1].track).toBe('x')
  })

  it('clamps a drop past either end rather than throwing', () => {
    let lanes = place([], 'a', LEAD_MAP, placementOn('bottom'))
    lanes = place(lanes, 'b', LEAD_MAP, placementOn('bottom'))
    const first = lanesOn(lanes, LEAD_MAP)[0]
    expect(reorderLane(lanes, first, 99).map((l) => l.track)).toEqual(['b', 'a'])
    expect(reorderLane(lanes, first, -5).map((l) => l.track)).toEqual(['a', 'b'])
  })
})

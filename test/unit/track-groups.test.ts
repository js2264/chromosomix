/**
 * What a group of tracks *is*, now that both surfaces read one answer.
 *
 * Three pure computations, and each of them used to exist twice. `planStack` is
 * what makes an overlay group one lane; `resolveGroupExtents` is what makes its
 * members comparable, and the one place the "scale each" opt-out lives; the
 * ceiling step is what a modifier-scroll over a lane means. While the heatmap
 * had its own copy of the second and none of the other two, a group made in the
 * 1D browser meant something different beside the map — and a group deliberately
 * set to scale each of its members separately was silently ignored there.
 */

import { describe, expect, it } from 'vitest'

import { planStack, resolveGroupExtents } from '@/annotations/groups'
import { groupRuns, type LaneFrame } from '@/render/lane'
import { ceilingFactor, nudgedLimits, resolveLimits, scaledTo } from '@/render/tracks'
import {
  heightThatFills,
  laneSize,
  smallestLaneSize,
  LANE_MAX_SIZE,
  LANE_MIN_SIZE,
} from '@/ui/trackControls'

/** A track, reduced to the three things a stack plan reads. */
function track(id: string, group = '', size = 40): { id: string; group: string; size: number } {
  return { id, group, size }
}

function plan(
  entries: ReturnType<typeof track>[],
  overlay: string[] = [],
): ReturnType<typeof planStack<ReturnType<typeof track>>> {
  return planStack(entries, {
    groupOf: (entry) => entry.group,
    modeOf: (name) => (overlay.includes(name) ? 'overlay' : 'stacked'),
    sizeOf: (entry) => entry.size,
    gap: 4,
    minimum: 12,
  })
}

describe('planning a stack of lanes', () => {
  it('gives every track its own lane while nothing is overlaid', () => {
    const slots = plan([track('a'), track('b'), track('c')])
    expect(slots.map((slot) => slot.host.id)).toEqual(['a', 'b', 'c'])
    expect(slots.map((slot) => slot.acrossFrom)).toEqual([0, 44, 88])
    expect(slots.every((slot) => slot.overlaid.length === 0)).toBe(true)
  })

  // The first member met keeps its slot, which is what stops an overlaid group
  // moving somewhere else in the stack the moment it is overlaid.
  it('collapses an overlaid group into the slot its first member had', () => {
    const slots = plan(
      [track('a'), track('b', 'strands'), track('c'), track('d', 'strands')],
      ['strands'],
    )
    expect(slots.map((slot) => slot.host.id)).toEqual(['a', 'b', 'c'])
    expect(slots[1].overlaid.map((entry) => entry.id)).toEqual(['d'])
    // Three lanes rather than four, so everything below moves up by one.
    expect(slots.map((slot) => slot.acrossFrom)).toEqual([0, 44, 88])
  })

  it('leaves a stacked group as several lanes', () => {
    const slots = plan([track('a', 'g'), track('b', 'g')])
    expect(slots).toHaveLength(2)
    expect(slots[1].overlaid).toEqual([])
  })

  it('never lets a lane fall below the floor', () => {
    const slots = plan([track('a', '', 2)])
    expect(slots[0].thickness).toBe(12)
  })
})

describe('the range a group resolves to', () => {
  const shared = (): 'shared' => 'shared'

  it('unions every member on every edge', () => {
    const groups = resolveGroupExtents(
      [
        { group: 'g', extent: { min: 0, max: 10 } },
        { group: 'g', extent: { min: -4, max: 6 } },
        { group: '', extent: { min: 0, max: 999 } },
      ],
      shared,
    )
    expect(groups.get('g')).toEqual({ min: -4, max: 10 })
    expect(groups.has('')).toBe(false)
  })

  // The whole of what "scale each" does: contributing nothing means every lookup
  // falls back to the track's own extent, which is what an ungrouped track uses.
  // One code path for both scalings, so `each` cannot drift from `shared`.
  it('contributes nothing for a group set to scale each of its members', () => {
    const groups = resolveGroupExtents(
      [
        { group: 'g', extent: { min: 0, max: 10 } },
        { group: 'g', extent: { min: 0, max: 6 } },
      ],
      () => 'each',
    )
    expect(groups.size).toBe(0)
  })

  it('ignores a member with nothing on screen', () => {
    const groups = resolveGroupExtents(
      [
        { group: 'g', extent: null },
        { group: 'g', extent: { min: 1, max: 3 } },
      ],
      shared,
    )
    expect(groups.get('g')).toEqual({ min: 1, max: 3 })
  })
})

describe('the bars that say which lanes share an axis', () => {
  const lane = (group: string, acrossFrom: number, thickness = 40) => ({
    group,
    colour: '#f00',
    acrossFrom,
    thickness,
  })

  it('merges adjacent members of one group into one run', () => {
    const runs = groupRuns([lane('g', 0), lane('g', 44), lane('', 88)], 4)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ group: 'g', from: 0, to: 84 })
  })

  // A bar drawn across a lane that is not in the group would be saying something
  // false, so two separated members get a bar each.
  it('gives non-adjacent members a bar each', () => {
    const runs = groupRuns([lane('g', 0), lane('', 44), lane('g', 88)], 4)
    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.from)).toEqual([0, 88])
  })

  it('says nothing about ungrouped lanes', () => {
    expect(groupRuns([lane('', 0), lane('', 44)], 4)).toEqual([])
  })
})

describe('moving a ceiling by a notch', () => {
  // From what the axis is *resolved to*, not from what is stored: an autoscaled
  // track has no stored pair, so a naive multiply would start from the `[0, 1]`
  // `resolveLimits` invents and the first notch would jump the picture.
  it('starts from the range on screen for an autoscaled track', () => {
    const extent = { min: 0, max: 80 }
    const auto = { auto: true, min: 0, max: 1 }
    expect(resolveLimits(auto, extent)).toEqual({ min: 0, max: 80 })
    expect(nudgedLimits(auto, extent, 1.25)).toEqual({ auto: false, min: 0, max: 100 })
  })

  it('composes, so up and down again is where it started', () => {
    const stored = { auto: false as const, min: 0, max: 64 }
    const up = nudgedLimits(stored, null, 1.25)
    expect(up).not.toBeNull()
    expect(nudgedLimits(up!, null, 1 / 1.25)?.max).toBeCloseTo(64, 9)
  })

  // An axis whose ceiling has fallen through its floor is a lane redrawn against
  // something nobody asked for; refusing is the honest answer.
  it('refuses a step that would invert or overflow the axis', () => {
    expect(nudgedLimits({ auto: false, min: 10, max: 20 }, null, 0.1)).toBeNull()
    expect(nudgedLimits({ auto: false, min: 0, max: Number.MAX_VALUE }, null, 10)).toBeNull()
  })
})

describe('dragging a lane’s body to set its ceiling', () => {
  const frameOf = (orientation: 'bottom' | 'right'): LaneFrame => ({
    orientation,
    toPixel: (unit) => unit,
    toUnit: (pixel) => pixel,
    domain: [0, 100],
    alongFrom: 0,
    alongTo: 100,
    acrossFrom: 0,
    thickness: 90,
  })
  const positive = { min: 0, max: 100 }

  /**
   * The rule is "towards where the signal grows", and the two edges disagree
   * about which screen direction that is: a bottom lane grows up from its floor,
   * a right-hand one grows outward from the map. Pulling the trace towards its
   * own tall end makes it taller, which is the ceiling coming down.
   */
  it('shrinks the range when the hand goes the way the signal grows', () => {
    // Below the map: up the screen is towards more, and across is down.
    expect(ceilingFactor(frameOf('bottom'), 60, 30, false)).toBeLessThan(1)
    expect(ceilingFactor(frameOf('bottom'), 30, 60, false)).toBeGreaterThan(1)
    // Beside it: away from the map is towards more, and across grows outward.
    expect(ceilingFactor(frameOf('right'), 30, 60, false)).toBeLessThan(1)
    expect(ceilingFactor(frameOf('right'), 60, 30, false)).toBeGreaterThan(1)
  })

  it('reverses again on a flipped track, on either edge', () => {
    expect(ceilingFactor(frameOf('bottom'), 60, 30, true)).toBeGreaterThan(1)
    expect(ceilingFactor(frameOf('right'), 30, 60, true)).toBeGreaterThan(1)
  })

  // Exponential in the fraction of the lane travelled, so the gesture composes:
  // there and back is where it started, whatever route it took.
  it('is exponential in the travel, and returns exactly', () => {
    const frame = frameOf('bottom')
    // A third of the lane is one octave, three octaves to the whole of it.
    expect(ceilingFactor(frame, 90, 60, false)).toBeCloseTo(0.5, 9)
    expect(ceilingFactor(frame, 60, 90, false)).toBeCloseTo(2, 9)
    expect(ceilingFactor(frame, 90, 0, false) * ceilingFactor(frame, 0, 90, false)).toBeCloseTo(1, 9)
  })

  it('bounds one gesture, so a flick off the lane cannot run away', () => {
    const frame = frameOf('bottom')
    expect(ceilingFactor(frame, 0, 10_000, false)).toBe(64)
    expect(ceilingFactor(frame, 10_000, 0, false)).toBe(1 / 64)
  })

  // The floor holds and the ceiling moves, which is what "max scaling" means:
  // a signed track's zero must not drift up the lane while its top is dragged.
  it('moves the ceiling and leaves the floor alone', () => {
    expect(scaledTo(positive, 0.5)).toEqual({ min: 0, max: 50 })
    expect(scaledTo({ min: -20, max: 80 }, 0.5)).toEqual({ min: -20, max: 30 })
  })
})

describe('one height for every lane', () => {
  it('divides the room and clamps to what a lane may be', () => {
    expect(heightThatFills(300, 3)).toBe(100)
    expect(heightThatFills(30, 10)).toBe(LANE_MIN_SIZE)
    expect(heightThatFills(4000, 1)).toBe(LANE_MAX_SIZE)
  })

  it('answers nothing when there is nothing to share, or nobody to share it', () => {
    expect(heightThatFills(0, 3)).toBeNull()
    expect(heightThatFills(300, 0)).toBeNull()
  })

  // Three floors used to disagree — fourteen in the browser, twelve in the
  // panel, ten in the lane stack — so a lane dragged to eleven pixels was legal
  // on one surface and rounded on another.
  it('clamps a typed height to one floor and one ceiling', () => {
    expect(laneSize(3)).toBe(LANE_MIN_SIZE)
    expect(laneSize(10_000)).toBe(LANE_MAX_SIZE)
    expect(laneSize(90.4)).toBe(90)
  })

  // The way out of a stretch: the shortest lane on screen, not the floor. Twelve
  // pixels is a number this module chose; the shortest lane is a number the
  // reader chose, and applying *that* to the rest is what shrink means.
  it('shrinks to the shortest lane rather than to the floor', () => {
    const lane = (...sizes: number[]): { members: Array<{ style: { size: number } }> } => ({
      members: sizes.map((size) => ({ style: { size } })),
    })
    const lanes = [lane(90), lane(40), lane(120)] as never
    expect(smallestLaneSize(lanes)).toBe(40)
  })

  // An overlaid lane is two tracks at one height, so it must not get two votes
  // — and a stack with nothing in it is left alone rather than resized to zero.
  it('reads every track in a lane, and answers nothing for an empty stack', () => {
    const lanes = [{ members: [{ style: { size: 70 } }, { style: { size: 30 } }] }] as never
    expect(smallestLaneSize(lanes)).toBe(30)
    expect(smallestLaneSize([])).toBeNull()
    expect(smallestLaneSize([{ members: [] }] as never)).toBeNull()
  })

  // Whatever is stored, what comes back is a height a lane may actually be: a
  // row restored from an older build can carry anything.
  it('clamps the answer like a typed height', () => {
    expect(smallestLaneSize([{ members: [{ style: { size: 2 } }] }] as never)).toBe(LANE_MIN_SIZE)
  })
})

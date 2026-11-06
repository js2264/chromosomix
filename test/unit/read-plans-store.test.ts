// @vitest-environment jsdom
/**
 * What a session keeps of an open's walk for the next open of the same map
 * (§6.1, §12, `state/readPlans.ts`), and the plan an example ships with
 * (`ui/exampleSessions.ts`, §24.11).
 *
 * Two halves, kept apart: the open's own walk, keyed by the map's address, and
 * the first view's, keyed by that and the window it read — fetched only for an
 * open that goes to the same window. A plan is checked by the size of the file
 * it was made on, so one made on another file is never used.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { readPlanFor } from '@/app/readPlan'
import { mergeRanges, planFor, planOf, rememberPlans } from '@/state/readPlans'
import { EXAMPLE_PLANS, HUMAN_MAP, HUMAN_REGION, humanConfig } from '@/ui/exampleSessions'

const CHUNK = 256 * 1024
const URI = 'https://bucket.example/map.mcool::resolutions/10000'

beforeEach(() => localStorage.clear())

describe('the plans a session keeps', () => {
  it('fetches the window’s half only for an open going to that window', () => {
    rememberPlans(URI, 'chr2:1-1000000', {
      open: { size: 100 * CHUNK, ranges: [[0, CHUNK], [40 * CHUNK, 41 * CHUNK]] },
      view: { size: 100 * CHUNK, ranges: [[10 * CHUNK, 12 * CHUNK]] },
    })
    expect(planFor(URI, 'chr2:1-1000000')).toEqual({
      size: 100 * CHUNK,
      ranges: [
        [0, CHUNK],
        [10 * CHUNK, 12 * CHUNK],
        [40 * CHUNK, 41 * CHUNK],
      ],
    })
    // Another window, or none: the open's walk alone.
    expect(planFor(URI, 'chr3')?.ranges).toEqual([
      [0, CHUNK],
      [40 * CHUNK, 41 * CHUNK],
    ])
    expect(planFor(URI, undefined)?.ranges).toHaveLength(2)
    expect(planFor('https://bucket.example/other.mcool', undefined)).toBeNull()
  })

  it('forgets the windows of a file that has changed size', () => {
    rememberPlans(URI, 'chr2', { open: { size: 10 * CHUNK, ranges: [[0, CHUNK]] }, view: { size: 10 * CHUNK, ranges: [[2 * CHUNK, 3 * CHUNK]] } })
    rememberPlans(URI, undefined, { open: { size: 11 * CHUNK, ranges: [[0, CHUNK]] }, view: null })
    expect(planFor(URI, 'chr2')).toEqual({ size: 11 * CHUNK, ranges: [[0, CHUNK]] })
  })

  it('keeps nothing of an open that read nothing', () => {
    rememberPlans(URI, 'chr2', { open: null, view: { size: 1, ranges: [[0, 1]] } })
    rememberPlans(URI, 'chr2', { open: { size: CHUNK, ranges: [] }, view: null })
    expect(planFor(URI, 'chr2')).toBeNull()
  })

  it('keeps the most recently opened maps, and a few windows of each', () => {
    for (let i = 0; i < 45; i++) {
      rememberPlans(`${URI}?${i}`, undefined, { open: { size: CHUNK, ranges: [[0, CHUNK]] }, view: null })
    }
    expect(planFor(`${URI}?44`, undefined)).not.toBeNull()
    expect(planFor(`${URI}?0`, undefined)).toBeNull()
    for (let w = 0; w < 6; w++) {
      rememberPlans(URI, `chr${w}`, { open: { size: 8 * CHUNK, ranges: [[0, CHUNK]] }, view: { size: 8 * CHUNK, ranges: [[(w + 1) * CHUNK, (w + 2) * CHUNK]] } })
    }
    expect(planFor(URI, 'chr5')?.ranges).toHaveLength(2)
    expect(planFor(URI, 'chr0')?.ranges).toHaveLength(1)
  })

  it('reads nothing it could not have written', () => {
    localStorage.setItem('chromosomix:read-plans', JSON.stringify({ [URI]: { size: 'big', open: [[0, 1]], views: {}, at: 1 } }))
    expect(planFor(URI, undefined)).toBeNull()
    localStorage.setItem('chromosomix:read-plans', '{not json')
    expect(planFor(URI, undefined)).toBeNull()
    expect(planOf({ size: 10, open: [[5, 2]], views: {}, at: 0 }, undefined)).toBeNull()
  })

  it('merges ranges that touch or overlap into one', () => {
    expect(
      mergeRanges(
        [
          [10, 20],
          [0, 5],
        ],
        [
          [20, 30],
          [4, 8],
        ],
      ),
    ).toEqual([
      [0, 8],
      [10, 30],
    ])
  })
})

describe('the plan an example ships with', () => {
  it('is the Human Hi-C map’s, at the rung and the window the example opens', () => {
    const config = humanConfig()
    expect(config.state.uri).toBe(`${HUMAN_MAP}::resolutions/10000`)
    expect(config.state.region).toBe(HUMAN_REGION)
    const plan = readPlanFor(config.state.uri, config.state.region)
    expect(plan).not.toBeNull()
    // The open's walk and the window's, merged: more than either alone.
    expect(plan!.ranges.length).toBeGreaterThan(EXAMPLE_PLANS[config.state.uri].open.length)
  })

  it('is runs of whole chunks, inside the file it was made on', () => {
    for (const plan of Object.values(EXAMPLE_PLANS)) {
      for (const ranges of [plan.open, ...Object.values(plan.views)]) {
        for (const [start, end] of ranges) {
          expect(start % CHUNK).toBe(0)
          expect(end > start).toBe(true)
          expect(end === plan.size || end % CHUNK === 0).toBe(true)
          expect(end <= plan.size).toBe(true)
        }
      }
    }
  })

  it('gives way to a plan this browser kept of its own', () => {
    const uri = `${HUMAN_MAP}::resolutions/10000`
    rememberPlans(uri, HUMAN_REGION, { open: { size: 7, ranges: [[0, 7]] }, view: null })
    expect(readPlanFor(uri, HUMAN_REGION)).toEqual({ size: 7, ranges: [[0, 7]] })
  })
})

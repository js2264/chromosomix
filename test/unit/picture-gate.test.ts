/**
 * What a session holds behind the reader's first picture (`app/pictureGate.ts`,
 * §6.5, §8.6, §12): a file's track reads, its census and its circularity check.
 *
 * Each waits for the first block of the next view that draws a map, or for the
 * cap. A landing table holds them for the map a row opens — started when the
 * table showed, they were mid-step when the reader's first click came, and the
 * chromosome waited for that step — while a view whose picture has no map (the
 * 1D browser's tracks) lets them go at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PictureGate } from '@/app/pictureGate'

const CAP = 4000

/** Settles every microtask a release takes. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) await Promise.resolve()
}

/** A waiter, and whether it has been let go. */
function waiting(gate: PictureGate): { released: () => boolean } {
  let released = false
  void gate.wait().then(() => {
    released = true
  })
  return { released: () => released }
}

/** A map view's first block, settled when the test says so. */
function mapView(): { firstData: Promise<void>; draw: () => void } {
  let draw = (): void => {}
  const firstData = new Promise<void>((resolve) => (draw = resolve))
  return { firstData, draw }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the picture gate', () => {
  it('lets go when the map view draws its first block, and not before', async () => {
    const gate = new PictureGate(CAP)
    const census = waiting(gate)
    const view = mapView()
    gate.shown({ firstData: view.firstData })
    await flush()
    expect(census.released()).toBe(false)
    view.draw()
    await flush()
    expect(census.released()).toBe(true)
  })

  it('holds everything on a landing table, for the map a row opens', async () => {
    const gate = new PictureGate(CAP)
    const census = waiting(gate)
    const circles = waiting(gate)
    gate.shown({ waypoint: true })
    await vi.advanceTimersByTimeAsync(CAP - 1)
    expect([census.released(), circles.released()]).toEqual([false, false])
    expect(gate.waiting).toBe(2)
    // The reader clicks a chromosome: its map takes over what the table held.
    const view = mapView()
    gate.shown({ firstData: view.firstData })
    expect(gate.waiting).toBe(0)
    await flush()
    expect(census.released()).toBe(false)
    view.draw()
    await flush()
    expect([census.released(), circles.released()]).toEqual([true, true])
  })

  it('lets go at the cap when the table is left standing', async () => {
    const gate = new PictureGate(CAP)
    const census = waiting(gate)
    gate.shown({ waypoint: true })
    await vi.advanceTimersByTimeAsync(CAP)
    expect(census.released()).toBe(true)
  })

  it('lets go at the cap when the map takes longer than it', async () => {
    const gate = new PictureGate(CAP)
    const tracks = waiting(gate)
    gate.shown(mapView())
    await vi.advanceTimersByTimeAsync(CAP)
    expect(tracks.released()).toBe(true)
  })

  it('lets go at once for a view whose picture has no map', async () => {
    const gate = new PictureGate(CAP)
    const tracks = waiting(gate)
    gate.shown({})
    await flush()
    expect(tracks.released()).toBe(true)
  })

  it('lets go when the map view goes away without a block', async () => {
    const gate = new PictureGate(CAP)
    const census = waiting(gate)
    gate.shown({ firstData: Promise.reject(new Error('closed')) })
    await flush()
    expect(census.released()).toBe(true)
  })

  it('hands a later waiter to the next view, not to one already drawn', async () => {
    const gate = new PictureGate(CAP)
    const first = mapView()
    gate.shown({ firstData: first.firstData })
    first.draw()
    await flush()
    // Asked after that view took its turn: the next view decides.
    const late = waiting(gate)
    await flush()
    expect(late.released()).toBe(false)
    gate.shown({})
    await flush()
    expect(late.released()).toBe(true)
  })
})

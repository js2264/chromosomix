/**
 * How big a square map is drawn, as a fact that outlives the panel.
 *
 * `turn-box.test.ts`'s sibling, and the division of labour is the same: what the
 * reader asked for is one number for the whole session, and how much of it a
 * panel can honour is a fact about one window — so the ask is stored whole and
 * fitted on the way out. That is what lets a size chosen beside a wide map be
 * read as "and as much of that as fits" beside a narrow one, and what makes it
 * survive the navigation that rebuilds the panel.
 *
 * The one number is the difference from the band, and it is the point: a band is
 * *cut* to fill its box, so its width and its depth are two questions. A square
 * block has no shape to choose, so a box of any other shape is paper down two
 * sides of the picture — which is why all four handles set this and why there is
 * only one of it.
 *
 * The `localStorage` read and write are untested on purpose, on the same rule the
 * turn box's file gives: they are `try`/`catch` wrappers around a browser API this
 * suite runs without.
 */

import { describe, expect, it } from 'vitest'

import { MIN_MAP_SIZE, fitMapSize, getMapSize, setMapSize, subscribeMapSize } from '@/ui/mapSize'

const ROOM = { width: 900, height: 600 }

describe('the size a panel draws', () => {
  it('takes all the room there is when nobody has said otherwise', () => {
    // The smaller of the two, because the box is square: a window 900 wide and
    // 600 tall has room for a 600-pixel map and not for a 900-pixel one.
    expect(fitMapSize(null, ROOM)).toBe(600)
    expect(fitMapSize(null, { width: 400, height: 600 })).toBe(400)
  })

  it('honours a size that fits', () => {
    expect(fitMapSize(420, ROOM)).toBe(420)
  })

  it('clamps one that does not, rather than overflowing the column', () => {
    expect(fitMapSize(1200, ROOM)).toBe(600)
    // …and gives it back in full when the room comes back, because what is
    // stored is the ask rather than what was drawn. A window resized smaller and
    // back again therefore returns to the size the reader chose, not to whatever
    // survived the squeeze.
    expect(fitMapSize(1200, { width: 1400, height: 1300 })).toBe(1200)
  })

  it('keeps a picture in the picture, however small the room', () => {
    expect(fitMapSize(10, ROOM)).toBe(MIN_MAP_SIZE)
    // The floor beats the ceiling: a panel with no room for the minimum draws
    // the minimum rather than nothing.
    expect(fitMapSize(null, { width: 20, height: 10 })).toBe(MIN_MAP_SIZE)
  })
})

describe('what the reader asked for', () => {
  it('starts as no answer at all, which is what takes all the room', () => {
    expect(getMapSize()).toBeNull()
  })

  it('remembers a size, and takes null for "put the default back"', () => {
    setMapSize(520)
    expect(getMapSize()).toBe(520)
    setMapSize(null)
    expect(getMapSize()).toBeNull()
  })

  it('refuses a size that is not one', () => {
    setMapSize(Number.NaN)
    expect(getMapSize()).toBeNull()
    setMapSize(-30)
    expect(getMapSize()).toBeNull()
    setMapSize(300.4)
    expect(getMapSize()).toBe(300)
  })

  it('tells every panel, and says nothing when nothing moved', () => {
    const seen: Array<number | null> = []
    const off = subscribeMapSize((size) => seen.push(size))
    setMapSize(420)
    // The same number again is not a resize, and a repaint per pointer move that
    // changed nothing is a repaint per pointer move.
    setMapSize(420)
    setMapSize(300)
    off()
    setMapSize(200)
    expect(seen).toEqual([420, 300])
  })
})

/**
 * How big a square map is drawn, and in what shape, as a fact that outlives the
 * panel.
 *
 * `turn-box.test.ts`'s sibling, and the division of labour is the same: what the
 * reader asked for is two numbers for the whole session, and how much of them a
 * panel can honour is a fact about one window — so the ask is stored whole and
 * fitted on the way out. That is what lets a box chosen beside a wide map be
 * read as "and as much of that as fits" beside a narrow one, and what makes it
 * survive the navigation that rebuilds the panel.
 *
 * It was one number, the side, on the argument that a square block has no shape
 * to choose. The box is a window onto the block rather than the block, and one
 * zoom for both axes keeps every cell square inside a window of any shape — so
 * the two ends set its width and the top and bottom its height (§7.2), and a side
 * nobody has set is the side of the square the map opens as.
 *
 * The `localStorage` read and write are untested on purpose, on the same rule the
 * turn box's file gives: they are `try`/`catch` wrappers around a browser API this
 * suite runs without.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  MIN_MAP_SIZE,
  fitMapSize,
  getMapSize,
  resetMapSize,
  setMapSize,
  subscribeMapSize,
} from '@/ui/mapSize'

const ROOM = { width: 900, height: 600 }
const SQUARE = { width: null, height: null }

beforeEach(() => {
  // A module-level store, so it outlives a test as it outlives a navigation.
  resetMapSize()
})

describe('the box a panel draws', () => {
  it('is the square of all the room there is when nobody has said otherwise', () => {
    // The smaller of the two, because the box opens square: a window 900 wide and
    // 600 tall has room for a 600-pixel map and not for a 900-pixel one.
    expect(fitMapSize(SQUARE, ROOM)).toEqual({ width: 600, height: 600 })
    expect(fitMapSize(SQUARE, { width: 400, height: 600 })).toEqual({ width: 400, height: 400 })
  })

  it('honours a rectangle that fits, which is a shape a map may now have', () => {
    expect(fitMapSize({ width: 840, height: 420 }, ROOM)).toEqual({ width: 840, height: 420 })
    expect(fitMapSize({ width: 300, height: 560 }, ROOM)).toEqual({ width: 300, height: 560 })
  })

  it('gives a side nobody set the square’s side, not all the room on its own axis', () => {
    // The right edge dragged out: the height stays where the square had it, rather
    // than jumping to the window's whole height the moment one edge was touched.
    expect(fitMapSize({ width: 840, height: null }, ROOM)).toEqual({ width: 840, height: 600 })
    expect(fitMapSize({ width: 300, height: null }, { width: 500, height: 800 })).toEqual({
      width: 300,
      height: 500,
    })
    // …and it goes on following the room as the square's side would: a track
    // grown under the map is taken out of the height alone.
    expect(fitMapSize({ width: 840, height: null }, { width: 900, height: 450 })).toEqual({
      width: 840,
      height: 450,
    })
  })

  it('clamps each side to its own room, rather than overflowing the column', () => {
    expect(fitMapSize({ width: 1200, height: 900 }, ROOM)).toEqual({ width: 900, height: 600 })
    // …and gives it back in full when the room comes back, because what is
    // stored is the ask rather than what was drawn. A window resized smaller and
    // back again therefore returns to the box the reader chose, not to whatever
    // survived the squeeze.
    expect(fitMapSize({ width: 1200, height: 900 }, { width: 1400, height: 1300 })).toEqual({
      width: 1200,
      height: 900,
    })
  })

  it('keeps a picture in the picture, however small the room', () => {
    expect(fitMapSize({ width: 10, height: 10 }, ROOM)).toEqual({ width: MIN_MAP_SIZE, height: MIN_MAP_SIZE })
    // The floor beats the ceiling: a panel with no room for the minimum draws
    // the minimum rather than nothing.
    expect(fitMapSize(SQUARE, { width: 20, height: 10 })).toEqual({ width: MIN_MAP_SIZE, height: MIN_MAP_SIZE })
  })
})

describe('what the reader asked for', () => {
  it('starts as no answer at all, which is the square of all the room', () => {
    expect(getMapSize()).toEqual(SQUARE)
  })

  it('remembers one side at a time, and takes null for "the square’s side back"', () => {
    setMapSize({ width: 520 })
    expect(getMapSize()).toEqual({ width: 520, height: null })
    setMapSize({ height: 300 })
    expect(getMapSize()).toEqual({ width: 520, height: 300 })
    // An omitted side is one the drag said nothing about.
    setMapSize({ width: null })
    expect(getMapSize()).toEqual({ width: null, height: 300 })
  })

  it('puts the whole square back at once, which is what Fit the view does', () => {
    setMapSize({ width: 840, height: 420 })
    resetMapSize()
    expect(getMapSize()).toEqual(SQUARE)
  })

  it('refuses a size that is not one', () => {
    setMapSize({ width: Number.NaN })
    expect(getMapSize().width).toBeNull()
    setMapSize({ height: -30 })
    expect(getMapSize().height).toBeNull()
    setMapSize({ width: 300.4 })
    expect(getMapSize().width).toBe(300)
  })

  it('hands out a copy, so a caller cannot reshape every map by editing it', () => {
    const held = getMapSize()
    held.width = 999
    expect(getMapSize().width).toBeNull()
  })

  it('tells every panel, and says nothing when nothing moved', () => {
    const seen: Array<{ width: number | null; height: number | null }> = []
    const off = subscribeMapSize((size) => seen.push(size))
    setMapSize({ width: 420 })
    // The same number again is not a resize, and a repaint per pointer move that
    // changed nothing is a repaint per pointer move.
    setMapSize({ width: 420 })
    setMapSize({ height: 300 })
    off()
    setMapSize({ width: 200 })
    expect(seen).toEqual([
      { width: 420, height: null },
      { width: 420, height: 300 },
    ])
  })
})

/**
 * The rectangle a turned map is drawn in, as a fact that outlives the panel.
 *
 * The bug this exists to keep fixed is not a wrong number, it is a *lost* one:
 * the box used to be a field on `MatrixPanel`, and the panel is rebuilt on every
 * navigation — so a reader who shaped their band and then went to look at
 * something in it found the band back at its default when they arrived. Which
 * is the one gesture shaping a band is *for*.
 *
 * The two halves are tested apart because they are two different kinds of thing.
 * What the reader asked for is one pair of numbers for the whole session; how
 * much of it a panel can honour is a fact about one window, and belongs to
 * neither the store nor the panel but to the fitting between them. The
 * `localStorage` read and write are untested on purpose, on
 * `name-column.test.ts`'s rule: they are `try`/`catch` wrappers around a browser
 * API this suite runs without, which is also why the store below behaves as a
 * fresh one in every case here.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TURN_ASPECT,
  MIN_TURN_HEIGHT,
  MIN_TURN_WIDTH,
  fitTurnBox,
  getTurnBox,
  setTurnBox,
  subscribeTurnBox,
} from '@/ui/turnBox'

const ROOM = { width: 900, height: 600 }

describe('the box a panel draws', () => {
  it('opens at a third of the room, which is the shape of the figure', () => {
    expect(fitTurnBox({ width: null, height: null }, ROOM)).toEqual({
      width: 900,
      height: Math.round(900 * DEFAULT_TURN_ASPECT),
    })
  })

  it('keeps what the reader asked for while it fits', () => {
    expect(fitTurnBox({ width: 500, height: 220 }, ROOM)).toEqual({ width: 500, height: 220 })
  })

  /**
   * The whole of why the ask is stored unclamped. A deck's panels are narrower
   * than a lone map's, and a window can be resized: fitting on the way out means
   * the box comes back when the room does, where a stored clamp would have
   * thrown the reader's number away the first time it did not fit.
   */
  it('draws as much of it as there is room for, without forgetting the rest', () => {
    expect(fitTurnBox({ width: 1200, height: 800 }, ROOM)).toEqual({ width: 900, height: 600 })
    expect(fitTurnBox({ width: 1200, height: 800 }, { width: 1400, height: 900 })).toEqual({
      width: 1200,
      height: 800,
    })
  })

  it('takes the default height from the width it will actually draw', () => {
    // Asked for a box wider than the room: the third is a third of 900, not of
    // the 1200 that was asked for and cannot be drawn.
    expect(fitTurnBox({ width: 1200, height: null }, ROOM).height).toBe(
      Math.round(900 * DEFAULT_TURN_ASPECT),
    )
  })

  it('keeps a picture in the picture, however small the room', () => {
    expect(fitTurnBox({ width: 10, height: 5 }, ROOM)).toEqual({
      width: MIN_TURN_WIDTH,
      height: MIN_TURN_HEIGHT,
    })
    // The floor beats the ceiling: a panel with no room for the minimum still
    // draws the minimum rather than nothing.
    expect(fitTurnBox({ width: null, height: null }, { width: 20, height: 10 })).toEqual({
      width: MIN_TURN_WIDTH,
      height: MIN_TURN_HEIGHT,
    })
  })
})

describe('what the reader asked for', () => {
  it('starts as no answer at all, which is what takes the default', () => {
    expect(getTurnBox()).toEqual({ width: null, height: null })
  })

  it('moves one axis at a time, because the handles do', () => {
    setTurnBox({ height: 250 })
    expect(getTurnBox()).toEqual({ width: null, height: 250 })
    setTurnBox({ width: 480 })
    expect(getTurnBox()).toEqual({ width: 480, height: 250 })
  })

  it('takes null for "put the default back", on that axis alone', () => {
    setTurnBox({ height: null })
    expect(getTurnBox()).toEqual({ width: 480, height: null })
  })

  it('refuses a size that is not one', () => {
    setTurnBox({ width: Number.NaN })
    expect(getTurnBox().width).toBeNull()
    setTurnBox({ width: -30 })
    expect(getTurnBox().width).toBeNull()
    setTurnBox({ width: 300.4 })
    expect(getTurnBox().width).toBe(300)
  })

  it('tells every panel, and says nothing when nothing moved', () => {
    const seen: Array<number | null> = []
    const off = subscribeTurnBox((box) => seen.push(box.width))
    setTurnBox({ width: 420 })
    // The same number again is not a resize, and a repaint per pointer move that
    // changed nothing is a repaint per pointer move.
    setTurnBox({ width: 420 })
    setTurnBox({ width: 300 })
    off()
    setTurnBox({ width: 200 })
    expect(seen).toEqual([420, 300])
  })
})

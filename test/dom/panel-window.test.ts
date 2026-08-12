// @vitest-environment jsdom
/**
 * The window the reader is looking at, across the things that are not a
 * navigation.
 *
 * A block arrives through `setMatrix`, which **refits** — right for a new place,
 * and wrong for the same place read again. Most of what a reader does is the
 * same place read again: turning the map, switching what the cells are, ticking
 * a derivation on. Each of those used to hand back the whole chromosome, so the
 * fifty kilobases somebody had zoomed into had to be found by hand again, and
 * the round trip — turn, turn back — did it twice.
 *
 * Two mechanisms are asserted here and they are deliberately the same idea at
 * two scales: the panel carries its own window across a **turn**, which is a
 * re-cut of a block it already holds; and it can be *told* to stand the next
 * block somewhere, which is how a window survives a whole view being rebuilt
 * around a fresh read.
 *
 * Both carry base pairs, never cells. A cell is a different number of base pairs
 * on every grid — half a bin under a turn — so a window kept as indices comes
 * back showing the wrong stretch of genome, confidently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import { setMapSize } from '@/ui/mapSize'
import { setTurnBox } from '@/ui/turnBox'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.localStorage.clear()
  setTurnBox({ width: null, height: null })
  setMapSize(null)
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
  window.localStorage.clear()
})

const BINSIZE = 1000

/** One sequence against itself — the only block that has a diagonal to turn. */
function block(bins: number): MatrixResult {
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins),
    rowExtent: [0, bins],
    colExtent: [0, bins],
    rowGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
    colGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

function harness(turn = true): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: BINSIZE,
    turn: { on: turn, onChange: () => {}, onAvailable: () => {} },
  })
  built.push(panel)
  document.body.append(panel.el)
  // jsdom lays nothing out, and the plot's *shape* is part of the arithmetic
  // here: a window asked for on both axes is fitted to whichever axis is
  // tighter, so a 2:1 canvas would show twice the columns that were asked for
  // and the round trip would look like a bug that is really the harness. A
  // square canvas is what a map is drawn in.
  const canvas = panel.el.querySelector('canvas')
  if (canvas === null) throw new Error('the panel has no canvas')
  Object.defineProperty(canvas, 'clientWidth', { get: () => 400, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { get: () => 400, configurable: true })
  panel.remeasure()
  return panel
}

/** The turn presentation the session hands over on every render. */
function turned(on: boolean) {
  return { on, onChange: () => {}, onAvailable: () => {} }
}

/**
 * Two windows agree to within a bin.
 *
 * Not to the base pair, and the slack is the arithmetic rather than sloppiness:
 * the window is read off the picture's edges in *pixels*, so it survives the
 * round trip to within whatever a pixel is worth — and under a turn a column is
 * half a bin, so the two shapes round differently by construction.
 */
function agree(
  a: { contig: string; start: number; end: number } | null,
  b: { contig: string; start: number; end: number } | null,
): void {
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  expect(a?.contig).toBe(b?.contig)
  expect(Math.abs((a?.start ?? 0) - (b?.start ?? 0))).toBeLessThanOrEqual(BINSIZE)
  expect(Math.abs((a?.end ?? 0) - (b?.end ?? 0))).toBeLessThanOrEqual(BINSIZE)
}

describe('turning the map', () => {
  it('keeps the stretch of genome on screen', () => {
    const panel = harness(true)
    panel.setData(block(200), 'IV')
    expect(panel.showLocus({ contig: 'IV', start: 40_000, end: 60_000 })).toBe(true)
    const before = panel.framedWindow()
    expect(before).not.toBeNull()

    expect(panel.rederive(undefined, undefined, turned(false))).toBe(true)

    agree(panel.framedWindow(), before)
  })

  it('keeps it on the way back, so a round trip lands where it started', () => {
    const panel = harness(true)
    panel.setData(block(200), 'IV')
    panel.showLocus({ contig: 'IV', start: 40_000, end: 60_000 })
    const before = panel.framedWindow()

    panel.rederive(undefined, undefined, turned(false))
    panel.rederive(undefined, undefined, turned(true))

    agree(panel.framedWindow(), before)
  })

  it('leaves a fitted picture fitted rather than pinning it to its own edges', () => {
    const panel = harness(true)
    panel.setData(block(200), 'IV')
    const whole = panel.framedWindow()

    panel.rederive(undefined, undefined, turned(false))

    agree(panel.framedWindow(), whole)
  })

  it('says so, so a view with a saved place knows whether to step in', () => {
    // The shell falls back to the bookmark only where the panel could not carry
    // its own window — a picture spanning more than one sequence, which is not
    // at a location at all. On an ordinary block it answers `true` and the
    // bookmark stays out of the way, which is what keeps a reader who zoomed in
    // *from* a bookmark where they actually are.
    const panel = harness(true)
    panel.setData(block(200), 'IV')
    panel.showLocus({ contig: 'IV', start: 40_000, end: 60_000 })
    expect(panel.rederive(undefined, undefined, turned(false))).toBe(true)
  })

  it('reports the picture never moved when the turn did not change', () => {
    const panel = harness(true)
    panel.setData(block(200), 'IV')
    panel.showLocus({ contig: 'IV', start: 40_000, end: 60_000 })
    const before = panel.framedWindow()
    expect(panel.rederive(undefined, undefined, turned(true))).toBe(true)
    agree(panel.framedWindow(), before)
  })
})

describe('standing the next block somewhere', () => {
  it('puts the incoming block on the window it was given', () => {
    const panel = harness(false)
    panel.setData(block(200), 'IV')
    panel.standOn({ contig: 'IV', start: 40_000, end: 60_000 })

    // A fresh read of the same place — what a change of score is.
    panel.setData(block(200), 'IV')

    agree(panel.framedWindow(), { contig: 'IV', start: 40_000, end: 60_000 })
  })

  it('is one shot, so the block after it fits as it always did', () => {
    const panel = harness(false)
    panel.setData(block(200), 'IV')
    const whole = panel.framedWindow()
    panel.standOn({ contig: 'IV', start: 40_000, end: 60_000 })
    panel.setData(block(200), 'IV')

    panel.setData(block(200), 'IV')

    // A window that outlived its block would put every later navigation back
    // where the reader used to be, which is the opposite of the bug this fixes.
    agree(panel.framedWindow(), whole)
  })

  it('is cleared by being handed nothing, without touching the picture', () => {
    const panel = harness(false)
    panel.setData(block(200), 'IV')
    panel.showLocus({ contig: 'IV', start: 40_000, end: 60_000 })
    const before = panel.framedWindow()
    panel.standOn(null)
    expect(panel.framedWindow()).toEqual(before)
  })

  it('carries across the turn too, since the window is base pairs either way', () => {
    // The case a cell index gets wrong for free: a turned band counts its
    // columns in half bins, so a window kept as indices lands at half the
    // position on one of the two shapes.
    const panel = harness(true)
    panel.setData(block(200), 'IV')
    panel.standOn({ contig: 'IV', start: 40_000, end: 60_000 })
    panel.setData(block(200), 'IV')
    agree(panel.framedWindow(), { contig: 'IV', start: 40_000, end: 60_000 })
  })
})

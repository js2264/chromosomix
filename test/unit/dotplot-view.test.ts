/**
 * The dot plot's view of its own, as arithmetic (SPECS §28.2): both sets at one
 * scale, zoomed about the pointer and kept over the data, moved by the hand,
 * pixels to bases and back, the streak under the pointer, and a position as a
 * locus of its set.
 */

import { describe, expect, it } from 'vitest'

import {
  clampView,
  fitView,
  locusOf,
  offsetsOf,
  panView,
  scaleOf,
  streakAt,
  toBases,
  toPixels,
  zoomView,
  type DotplotLines,
  type PlotRect,
} from '@/dotplot/view'

const RECT: PlotRect = { x: 50, y: 20, width: 400, height: 400 }

describe('the view', () => {
  it('fits both sets at one scale, the longer filling its side', () => {
    const view = fitView(8000, 4000, RECT)
    expect(scaleOf(view, RECT)).toBe(20)
    expect(view).toEqual({ x0: 0, x1: 8000, y0: -2000, y1: 6000 })
  })

  it('keeps the bases under the pointer through a zoom into the far corner, where a set’s last sequence is', () => {
    const view = fitView(8000, 8000, RECT)
    const px = RECT.x + RECT.width - 3
    const py = RECT.y + RECT.height - 3
    const before = toBases(view, RECT, px, py)
    const zoomed = clampView(zoomView(view, RECT, px, py, 20), 8000, 8000, RECT)
    const after = toBases(zoomed, RECT, px, py)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('keeps the bases under the pointer where they were through a zoom', () => {
    const view = fitView(8000, 8000, RECT)
    const before = toBases(view, RECT, 150, 320)
    const zoomed = zoomView(view, RECT, 150, 320, 4)
    expect(scaleOf(zoomed, RECT)).toBe(5)
    const after = toBases(zoomed, RECT, 150, 320)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('never zooms out past the whole, nor past a base a pixel, nor leaves the data', () => {
    const whole = fitView(8000, 8000, RECT)
    expect(clampView(zoomView(whole, RECT, 250, 220, 0.25), 8000, 8000, RECT)).toEqual(whole)
    const deep = clampView(zoomView(whole, RECT, 250, 220, 1e6), 8000, 8000, RECT)
    expect(scaleOf(deep, RECT)).toBe(1)
    const far = clampView(panView(zoomView(whole, RECT, 250, 220, 4), RECT, 1e6, 1e6), 8000, 8000, RECT)
    expect((far.x0 + far.x1) / 2).toBeGreaterThanOrEqual(0)
    expect((far.y0 + far.y1) / 2).toBeGreaterThanOrEqual(0)
  })

  it('moves the picture with the hand, and takes pixels to bases and back', () => {
    const view = fitView(8000, 8000, RECT)
    const moved = panView(view, RECT, 40, -20)
    expect(moved.x0).toBe(view.x0 - 40 * 20)
    expect(moved.y0).toBe(view.y0 + 20 * 20)
    const bases = toBases(view, RECT, 170, 90)
    const back = toPixels(view, RECT, bases.x, bases.y)
    expect(back.px).toBeCloseTo(170, 9)
    expect(back.py).toBeCloseTo(90, 9)
  })
})

describe('the streak under the pointer', () => {
  // One the same way round down the diagonal, one the other way round beside it.
  const lines: DotplotLines = {
    x0: [0, 5000],
    x1: [4000, 7000],
    y0: [0, 1000],
    y1: [4000, 3000],
    strand: [1, -1],
  }
  const view = fitView(8000, 8000, RECT)

  it('is the one whose line passes within reach, measured to the line', () => {
    const on = toPixels(view, RECT, 2000, 2000)
    expect(streakAt(lines, view, RECT, on.px + 3, on.py - 2, 6)).toBe(0)
    // The other way round runs from (5000, 3000) to (7000, 1000).
    const back = toPixels(view, RECT, 6000, 2000)
    expect(streakAt(lines, view, RECT, back.px, back.py + 2, 6)).toBe(1)
    // Its box's corner is no part of its line.
    const corner = toPixels(view, RECT, 5000, 1000)
    expect(streakAt(lines, view, RECT, corner.px, corner.py, 6)).toBe(-1)
  })
})

describe('a position as a locus', () => {
  it('names the sequence it is in and the base in it', () => {
    const axis = { names: ['I', 'II', 'III'], lengths: [1000, 500, 200] }
    const offsets = offsetsOf(axis)
    expect(offsets).toEqual([0, 1000, 1500, 1700])
    expect(locusOf(axis, offsets, 0)).toEqual({ name: 'I', at: 0 })
    expect(locusOf(axis, offsets, 1200.7)).toEqual({ name: 'II', at: 200 })
    expect(locusOf(axis, offsets, 1700)).toBeNull()
    expect(locusOf(axis, offsets, -1)).toBeNull()
  })
})

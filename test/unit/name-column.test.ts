/**
 * How wide the browser's name column may be.
 *
 * The width becomes a *decision* the moment the edge is dragged, and a decision
 * outlives the build and the window it was made in — a stored 900-pixel column
 * on a 600-pixel window would leave no axis at all. So the bounds are applied on
 * the way out of storage as much as on the way in, which is the same rule the
 * side panels' own widths follow.
 *
 * The read and write halves are untested on purpose: they are `try`/`catch`
 * wrappers over `localStorage`, which this suite runs without.
 */

import { describe, expect, it } from 'vitest'

import { NAME_COLUMN_DEFAULT, NAME_COLUMN_MIN, clampNameColumn } from '@/ui/nameColumn'

describe('the width the name column may be', () => {
  it('leaves a reasonable width alone, rounded', () => {
    expect(clampNameColumn(140, 900)).toBe(140)
    expect(clampNameColumn(140.4, 900)).toBe(140)
  })

  it('floors at the width below which it is a stripe rather than a column', () => {
    expect(clampNameColumn(4, 900)).toBe(NAME_COLUMN_MIN)
    expect(clampNameColumn(-200, 900)).toBe(NAME_COLUMN_MIN)
  })

  // A column wider than a third of the window has stopped being a margin and
  // started being the picture.
  it('ceilings at a third of the window', () => {
    expect(clampNameColumn(400, 900)).toBe(300)
    expect(clampNameColumn(900, 900)).toBe(300)
  })

  // The floor wins over the ceiling on a window too narrow for both, because a
  // column of four pixels is not a column and the axis has `Math.max(1, …)`
  // behind it either way.
  it('keeps the floor on a window too narrow to honour the ceiling', () => {
    expect(clampNameColumn(200, 60)).toBe(NAME_COLUMN_MIN)
  })

  // Stored state is untrusted input, exactly like the URL hash.
  it('falls back to the default for a value that is not a number', () => {
    expect(clampNameColumn(Number.NaN, 900)).toBe(NAME_COLUMN_DEFAULT)
    expect(clampNameColumn(Number.POSITIVE_INFINITY, 900)).toBe(NAME_COLUMN_DEFAULT)
  })
})

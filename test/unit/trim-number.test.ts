/**
 * `trimNumber` — the number as it goes *into an editable box*, rather than as a
 * reader reads it.
 *
 * Two boxes share it and want slightly different things from it, which is the
 * whole reason it takes a cap: the colour clip is in transformed units that have
 * no natural precision, and a track's limits are read off a lane forty pixels
 * tall. What is pinned here is that the two agree on everything except the cap —
 * a track limit and a clip bound seeded from the same float must not disagree
 * about what that float *is*.
 */

import { describe, expect, it } from 'vitest'

import { trimNumber } from '@/ui/dom'

describe('a number on its way into a box', () => {
  // The case this exists for. A bigWig header stores `float32`, and reading one
  // back as a double is where `0.04` becomes seventeen digits — which is what
  // the limits boxes used to be seeded with.
  it('cuts a widened float32 down to something worth nudging', () => {
    expect(trimNumber(0.03999999910593033)).toBe('0.04')
    expect(trimNumber(0.03999999910593033, 3)).toBe('0.04')
    expect(trimNumber(-4.67803955078125)).toBe('-4.678')
  })

  it('keeps four significant digits when nothing caps it', () => {
    expect(trimNumber(1598.85)).toBe('1599')
    expect(trimNumber(1.23456)).toBe('1.235')
    expect(trimNumber(0.00123456)).toBe('0.001235')
  })

  it('keeps at most the decimals it is capped at', () => {
    expect(trimNumber(1.23456, 3)).toBe('1.235')
    expect(trimNumber(0.00123456, 3)).toBe('0.001')
    expect(trimNumber(123.456, 3)).toBe('123.5')
    expect(trimNumber(2.5, 3)).toBe('2.5')
  })

  // The cap is a ceiling, not a format: a box reading `5.000` invites the reader
  // to wonder what the zeroes are telling them.
  it('does not pad to the cap', () => {
    expect(trimNumber(5, 3)).toBe('5')
    expect(trimNumber(0, 3)).toBe('0')
    expect(trimNumber(-1, 3)).toBe('-1')
  })

  /**
   * Checked *before* the cap, deliberately. `1.2e-7` under a three-decimal cap
   * is `0`, and a limits box reading zero for a track whose values are all
   * around 1e-7 would be a lie that the auto checkbox beside it cannot explain.
   */
  it('falls back to an exponent where fixed point would say nothing', () => {
    expect(trimNumber(1.2e-7, 3)).toBe('1.200e-7')
    expect(trimNumber(2.5e9, 3)).toBe('2.500e+9')
    expect(trimNumber(1e-9)).toBe('1.000e-9')
  })

  // A box cannot show `NaN` and must not show `Infinity`: both come from an
  // extent over a track with no data in view, and an empty box is the honest
  // rendering of "there is no number here".
  it('gives an empty string for anything that is not a number', () => {
    expect(trimNumber(Number.NaN)).toBe('')
    expect(trimNumber(Number.POSITIVE_INFINITY)).toBe('')
    expect(trimNumber(Number.NEGATIVE_INFINITY, 3)).toBe('')
  })
})

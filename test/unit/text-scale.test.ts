/**
 * The one multiplier every canvas font in the app goes through.
 *
 * Two properties carry the whole feature and both are silent when wrong.
 * **Identity at 1.0**: every golden render and every measured-label test in this
 * suite compares against sizes written down as literals, so a scale that
 * "helpfully" rewrote `10px` as `10px` through a regex would still be one
 * rounding away from moving all of them. And **invalidation**: the rewrite is
 * memoised per font string, so a cache that outlived a change would be a control
 * that appears to do nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

/**
 * `localStorage`, as the module reaches for it.
 *
 * Installed before the import, because the module reads the stored value the
 * first time it is asked for a scale and there is no `window` under Node.
 */
vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
})

const {
  DEFAULT_TEXT_SCALE,
  TEXT_SCALE_STEPS,
  getTextScale,
  scaleFont,
  scaleLength,
  setTextScale,
  stepTextScale,
  subscribeTextScale,
} = await import('@/ui/textScale')

/** Every font literal this application writes on a canvas. */
const FONTS = [
  '10px system-ui, sans-serif',
  '9px system-ui, sans-serif',
  '600 9px system-ui, sans-serif',
  '600 11px system-ui, sans-serif',
  '11.5px system-ui, sans-serif',
  '600 12px system-ui, sans-serif',
  '600 13px system-ui, sans-serif',
  '600 15px system-ui, sans-serif',
  '12px system-ui, sans-serif',
  '11px Helvetica, sans-serif',
]

describe('the text scale', () => {
  beforeEach(() => setTextScale(DEFAULT_TEXT_SCALE))

  // The assertion that keeps every other test in this suite meaningful.
  it('is the identity at 1.0, for every font the app writes', () => {
    for (const font of FONTS) expect(scaleFont(font)).toBe(font)
    expect(scaleLength(11)).toBe(11)
    expect(scaleLength(18)).toBe(18)
  })

  // The weight and the family are what the mark *is*: a 600-weight name that
  // thinned out as it grew would be a different label rather than a larger one.
  it('moves the size and nothing else', () => {
    setTextScale(1.35)
    expect(scaleFont('600 12px system-ui, sans-serif')).toBe('600 16.2px system-ui, sans-serif')
    expect(scaleFont('11px Helvetica, sans-serif')).toBe('14.9px Helvetica, sans-serif')
  })

  // Rounded to a tenth, not to an integer: 9 px at 1.15 must not collapse to 9,
  // or the smallest text in the app is the one the control cannot move.
  it('keeps a tenth of a pixel, so a small font still grows', () => {
    setTextScale(1.15)
    expect(scaleFont('9px system-ui, sans-serif')).toBe('10.4px system-ui, sans-serif')
    expect(scaleFont('11.5px system-ui, sans-serif')).toBe('13.2px system-ui, sans-serif')
  })

  it('leaves a string with no size in it alone', () => {
    setTextScale(1.35)
    expect(scaleFont('bold sans-serif')).toBe('bold sans-serif')
  })

  // The memo is per font string and cleared on every change; without the clear
  // the second press would return the first press's answer for ever.
  it('answers the new size after a change, not the cached one', () => {
    setTextScale(0.8)
    const small = scaleFont('10px system-ui, sans-serif')
    expect(scaleFont('10px system-ui, sans-serif')).toBe(small)
    setTextScale(1.6)
    expect(scaleFont('10px system-ui, sans-serif')).not.toBe(small)
  })

  it('steps a rung at a time and stops at both ends', () => {
    setTextScale(TEXT_SCALE_STEPS[0])
    expect(stepTextScale(-1)).toBe(TEXT_SCALE_STEPS[0])
    expect(stepTextScale(1)).toBe(TEXT_SCALE_STEPS[1])
    setTextScale(TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1])
    expect(stepTextScale(1)).toBe(TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1])
  })

  // Stored state is untrusted input, exactly like the URL hash: a value between
  // rungs, or one from a build with a different ladder, lands on the nearest.
  it('snaps whatever it is given to a rung', () => {
    setTextScale(1.31)
    expect(getTextScale()).toBe(1.35)
    setTextScale(Number.NaN)
    expect(getTextScale()).toBe(DEFAULT_TEXT_SCALE)
  })

  it('tells its subscribers, until they let go', () => {
    const seen: number[] = []
    const off = subscribeTextScale((scale) => seen.push(scale))
    setTextScale(1.6)
    off()
    setTextScale(0.9)
    expect(seen).toEqual([1.6])
  })

  // Lengths are pixel offsets rather than type, so they round to whole pixels.
  it('rounds a spacing length to a pixel', () => {
    setTextScale(1.15)
    expect(scaleLength(11)).toBe(13)
    expect(scaleLength(26)).toBe(30)
  })
})

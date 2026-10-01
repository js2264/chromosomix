/**
 * The spellings `src/units.ts` owns, where they are not already pinned
 * elsewhere.
 *
 * `fmt` is exercised through `ui/dom.ts`'s re-export in `test/dom/controls.test.ts`,
 * and `resolutionLabel` through the surfaces that print a bin size. What is here
 * is the pair with no other home: the clock a result carries, and the duration
 * beside it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { axisNumber, durationText, runClock } from '../../src/units'

describe('durationText', () => {
  it('uses the largest unit that still says something', () => {
    expect(durationText(340)).toBe('340 ms')
    expect(durationText(2000)).toBe('2.0 s')
    expect(durationText(65_000)).toBe('1 m 5 s')
  })

  it('says so rather than guessing when there is no duration', () => {
    expect(durationText(Number.NaN)).toBe('—')
    expect(durationText(-1)).toBe('—')
  })
})

describe('fmt.pos', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  // **Grouped as en-US, whatever the locale** (§26.1): a coordinate is copied
  // between this app, IGV and a terminal, and is written one way in all three.
  // A count is the locale's to group, and stays so.
  it('groups a coordinate with commas in a browser that groups with full stops', async () => {
    const Real = Intl.NumberFormat
    // A German browser: every formatter asked for "the locale's" gets de-DE.
    const German = function (locale?: string | string[], options?: Intl.NumberFormatOptions) {
      return new Real(locale ?? 'de-DE', options)
    } as unknown as typeof Intl.NumberFormat
    vi.stubGlobal('Intl', { ...Intl, NumberFormat: German })
    vi.resetModules()
    const { fmt } = await import('../../src/units')
    expect(fmt.int(1_224_000)).toBe('1.224.000')
    expect(fmt.pos(1_224_000)).toBe('1,224,000')
    expect(fmt.pos(1_224_000.4)).toBe('1,224,000')
  })
})

describe('runClock', () => {
  // **Twenty-four hour, in every locale.** The reader's own locale decided this
  // at first, and on `en-US` that is a twelve-hour clock: a result read
  // *computed in 776 ms at 03:29:24 PM*, where the eight characters that say the
  // hour carry three of punctuation and a word, and two runs an hour apart in
  // the afternoon and the small hours sort the same. The duration beside it is a
  // measurement, and so is this. The separators stay the locale's.
  it('is a twenty-four hour clock whatever the locale prefers', () => {
    const at = runClock('2026-09-21T15:26:19Z')
    expect(at).not.toMatch(/[AP]M/i)
    expect(at).toMatch(/^\d{2}\D\d{2}\D\d{2}$/)
  })

  it('says so rather than guessing when the stamp is not a time', () => {
    expect(runClock('not a date')).toBe('—')
  })
})

describe('axisNumber', () => {
  // A P(s) ordinate climbed `0.001`, `0.0001`, `0.00001`, `0.000001`,
  // `0.0000001`, and the log-log slope beside it reached eight zeros — at which
  // point a reader cannot tell one tick from the next without counting.
  it('turns a run of zeros into an exponent', () => {
    expect(axisNumber(1e-7)).toBe('1e-7')
    expect(axisNumber(2.5e-8)).toBe('2.5e-8')
    expect(axisNumber(1e8)).toBe('1e8')
  })

  it('leaves the magnitudes a reader reads at a glance alone, grouped', () => {
    expect(axisNumber(0.001)).toBe('0.001')
    expect(axisNumber(0.25)).toBe('0.25')
    expect(axisNumber(1)).toBe('1')
    expect(axisNumber(1000)).toBe('1,000')
    expect(axisNumber(0)).toBe('0')
  })

  // The upper bound is 1e7, not 1e6, so a log axis reaching a million does not
  // print `4,000`, `10,000`, `100,000` and then `1e6` — one tick in a different
  // notation from its neighbours.
  it('keeps a whole log axis in one notation up to ten million', () => {
    expect([4e3, 1e4, 1e5, 1e6].map((v) => axisNumber(v))).toEqual([
      '4,000',
      '10,000',
      '100,000',
      '1,000,000',
    ])
  })

  // A log axis is decades, and decades are read as exponents: an ordinate that
  // went `0.001`, `0.0001`, `1e-5`, `1e-6` changed notation halfway down itself.
  it('reads a log axis in one notation, decade by decade', () => {
    expect([1e-3, 1e-4, 1e-5, 1e-6, 1e-7].map((v) => axisNumber(v, 'log'))).toEqual([
      '1e-3',
      '1e-4',
      '1e-5',
      '1e-6',
      '1e-7',
    ])
  })

  it('leaves a log axis of ordinary numbers plain', () => {
    expect([1, 10, 100, 1000].map((v) => axisNumber(v, 'log'))).toEqual(['1', '10', '100', '1,000'])
  })

  it('keeps no idle zeros, on either side of the threshold', () => {
    expect(axisNumber(1.5)).toBe('1.5')
    expect(axisNumber(1e-5)).toBe('1e-5')
  })
})

/**
 * The spellings `src/units.ts` owns, where they are not already pinned
 * elsewhere.
 *
 * `fmt` is exercised through `ui/dom.ts`'s re-export in `test/dom/controls.test.ts`,
 * and `resolutionLabel` through the surfaces that print a bin size. What is here
 * is the pair with no other home: the clock a result carries, and the duration
 * beside it.
 */

import { describe, expect, it } from 'vitest'

import { durationText, runClock } from '../../src/units'

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

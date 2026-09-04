/**
 * Where the second file goes when the first changes resolution.
 *
 * A comparison is dropped when the file it belongs to is replaced, and a change
 * of rung is the one open that is not a replacement — the same `.mcool` at
 * another bin size, with the reader having closed nothing. The arithmetic that
 * moves the second file across is small and its two failure modes are both
 * silent: carrying the *URI* instead of the *bin size* re-opens the level the
 * reader has just left, and settling for the nearest rung draws one file at
 * 1 kb against another at 5 kb under a label that names one of them.
 */

import { describe, expect, it } from 'vitest'

import { compareRung, withoutSecond, type CompareCarry } from '../../src/app/Session'
import type { ViewState } from '../../src/state/ViewState'

function carry(over: Partial<CompareCarry> = {}): CompareCarry {
  return {
    uri: 'rep2.mcool::/resolutions/1000',
    source: { kind: 'remote', url: 'https://example.org/rep2.mcool' },
    entries: ['1000', '5000', '20000'],
    entryGroup: 'resolutions',
    binsize: 1000,
    hidden: false,
    ...over,
  }
}

describe('compareRung', () => {
  it('addresses the second file at the rung the first moved to', () => {
    expect(compareRung(carry(), 5000)).toBe('rep2.mcool::resolutions/5000')
    expect(compareRung(carry(), 20000)).toBe('rep2.mcool::resolutions/20000')
  })

  it('leaves a file already at the bin size exactly where it is', () => {
    // Not merely equivalent: a `.cool` has no entries to look a rung up in, and
    // the URI it is open at is the only address it has.
    expect(compareRung(carry(), 1000)).toBe('rep2.mcool::/resolutions/1000')
    expect(compareRung(carry({ uri: 'rep2.cool', entries: [], entryGroup: '' }), 1000)).toBe(
      'rep2.cool',
    )
  })

  it('refuses a bin size the second file has no rung for', () => {
    // The gate's own rule from the other side: two bin sizes in one square would
    // draw a pixel that means 1 kb above the diagonal and 2 kb below it. The
    // nearest rung is a different picture, so there is no nearest rung.
    expect(compareRung(carry(), 2000)).toBeNull()
    expect(compareRung(carry({ entries: [], binsize: 1000 }), 5000)).toBeNull()
  })

  it('refuses a file whose entries are not a ladder', () => {
    // `rungsOf`'s rule: a replicate collection is not a resolution ladder, and
    // `rep1` is not a bin size however much a reader would like it to be.
    expect(compareRung(carry({ entries: ['rep1', 'rep2'], entryGroup: 'entries' }), 5000)).toBeNull()
  })

  it('refuses a first file with no bin size to match', () => {
    expect(compareRung(carry(), null)).toBeNull()
    expect(compareRung(carry(), 0)).toBeNull()
  })
})

describe('withoutSecond', () => {
  it('removes the field rather than emptying it', () => {
    const state: ViewState = {
      uri: 'rep1.mcool::/resolutions/1000',
      view: 'region',
      region: 'chrII',
      uri2: 'https://example.org/rep2.mcool::/resolutions/1000',
    }
    const stripped = withoutSecond(state)
    expect('uri2' in stripped).toBe(false)
    expect(stripped).toEqual({
      uri: 'rep1.mcool::/resolutions/1000',
      view: 'region',
      region: 'chrII',
    })
  })

  it('leaves a state that never named one alone', () => {
    const state: ViewState = { uri: 'rep1.cool', view: 'contigs' }
    expect(withoutSecond(state)).toEqual(state)
  })
})

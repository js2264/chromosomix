/**
 * Pointing at a locus on the map, and the two rules that make it safe.
 *
 * The gesture that used to name a 4C anchor is now a 1D zoom, so a pick has to
 * be *asked for* — a form arms the module, and the next drag answers it. That
 * is a mode on a picture, which is a thing to be careful with, and the care is
 * all here rather than in the map: it disarms after one pick, and it disarms on
 * Escape. The map's whole job is to ask `isArmed` before it decides what a drag
 * means, so if this module gets those two wrong the map has no way to notice.
 *
 * The last describe is about the *string*, which is the other half of the
 * feature: what the same gesture writes to the clipboard when nothing armed it.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  armPick,
  disarmPick,
  isArmed,
  lastPick,
  locusText,
  pickKeyDown,
  pickLocus,
  resetPick,
  subscribePick,
} from '@/ui/mapPick'

// Module-level state, so every test starts from the same place — otherwise the
// order they happen to run in decides whether one of them passes.
afterEach(() => {
  resetPick()
})

describe('arming', () => {
  it('starts disarmed and with nothing picked', () => {
    expect(isArmed()).toBe(false)
    expect(lastPick()).toBeNull()
  })

  it('arms and disarms', () => {
    armPick()
    expect(isArmed()).toBe(true)
    disarmPick()
    expect(isArmed()).toBe(false)
  })

  // A second press of an already-lit button must not be a toggle by accident:
  // the button calls `disarmPick` for that, and `armPick` twice is one arming.
  it('is idempotent, and announces only on a change', () => {
    let heard = 0
    const off = subscribePick(() => {
      heard += 1
    })
    armPick()
    armPick()
    expect(heard).toBe(1)
    disarmPick()
    disarmPick()
    expect(heard).toBe(2)
    off()
  })
})

describe('picking', () => {
  it('records the locus and disarms itself', () => {
    armPick()
    pickLocus({ contig: 'chrIV', start: 500_000, end: 510_000 })
    expect(lastPick()).toEqual({ contig: 'chrIV', start: 500_000, end: 510_000 })
    // The rule that keeps this from being a mode a reader leaves on: one pick
    // per arming, so the next three drags zoom as they normally would.
    expect(isArmed()).toBe(false)
  })

  it('tells its listeners', () => {
    const seen: Array<string | null> = []
    const off = subscribePick(() => {
      seen.push(lastPick()?.contig ?? null)
    })
    armPick()
    pickLocus({ contig: 'II', start: 0, end: 1_000 })
    expect(seen).toEqual([null, 'II'])
    off()
  })

  it('stops listening when the subscription is dropped', () => {
    let heard = 0
    const off = subscribePick(() => {
      heard += 1
    })
    off()
    armPick()
    expect(heard).toBe(0)
  })
})

/**
 * The rule, not the wiring: there is no DOM here, so the handler is called
 * directly. What is being checked is that Escape is the way out of the mode and
 * that nothing else is.
 */
describe('Escape', () => {
  it('disarms', () => {
    armPick()
    pickKeyDown({ key: 'Escape' })
    expect(isArmed()).toBe(false)
  })

  it('says nothing once the mode is already over', () => {
    armPick()
    pickLocus({ contig: 'I', start: 10, end: 20 })
    let heard = 0
    const off = subscribePick(() => {
      heard += 1
    })
    pickKeyDown({ key: 'Escape' })
    expect(heard).toBe(0)
    off()
  })

  it('leaves the picked locus alone', () => {
    pickLocus({ contig: 'I', start: 10, end: 20 })
    armPick()
    pickKeyDown({ key: 'Escape' })
    expect(lastPick()).toEqual({ contig: 'I', start: 10, end: 20 })
  })

  it('leaves other keys alone', () => {
    armPick()
    pickKeyDown({ key: 'Enter' })
    expect(isArmed()).toBe(true)
  })
})

describe('resetting on the way into another file', () => {
  // The same sequence name in another file is another place, so a locus cannot
  // cross: a form holding one would be asking about somewhere the reader never
  // pointed at.
  it('forgets the locus and the arming', () => {
    armPick()
    pickLocus({ contig: 'I', start: 0, end: 100 })
    armPick()
    resetPick()
    expect(lastPick()).toBeNull()
    expect(isArmed()).toBe(false)
  })

  it('says nothing when there was nothing to forget', () => {
    let heard = 0
    const off = subscribePick(() => {
      heard += 1
    })
    resetPick()
    expect(heard).toBe(0)
    off()
  })
})

/**
 * The string, which is the part a reader actually handles: it goes on the
 * clipboard on every Shift-drag, armed or not, and it is pasted into other
 * tools.
 */
describe('locusText', () => {
  // 1-based inclusive, because that is what the format means. The interval here
  // is 0-based half-open like everything internal, and the `+1` is the
  // conversion rather than an off-by-one.
  it('converts to 1-based inclusive', () => {
    expect(locusText({ contig: 'chrIV', start: 500_000, end: 510_000 })).toBe(
      'chrIV:500001-510000',
    )
  })

  it('writes a single base as a range of one', () => {
    expect(locusText({ contig: 'I', start: 0, end: 1 })).toBe('I:1-1')
  })

  // The whole point of having a second format: no thousands separators and a
  // plain hyphen, so the string pastes into samtools, bedtools, IGV and this
  // app's own locus boxes. The *display* format uses an en dash and grouped
  // digits, and the two must not be confused.
  it('has no separators and a plain hyphen, at any magnitude', () => {
    const text = locusText({ contig: 'chr1', start: 1_234_567, end: 12_345_678 })
    expect(text).toBe('chr1:1234568-12345678')
    expect(text).not.toMatch(/[,\s–—]/)
  })

  it('keeps a sequence name that contains a colon whole', () => {
    expect(locusText({ contig: 'NODE_1:2', start: 4, end: 9 })).toBe('NODE_1:2:5-9')
  })
})

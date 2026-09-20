/**
 * Resolutions the reader asks for and the file does not store (§3.4).
 *
 * The whole feature rests on one sentence — *a coarse bin is a whole number of
 * fine bins* — and on the refusals being **specific**. A dialog that greys its
 * own button teaches a reader nothing; one that says *2.5 kb is not a whole
 * number of bins of any resolution this file carries* tells them to type 2 or 3.
 *
 * So what is pinned here is: which rung a target is summed from (the coarsest
 * that divides it, because that walks the fewest stored pixels), which targets
 * are refused, and that each refusal is told apart from the others by kind
 * rather than by the wording of its sentence.
 */

import { describe, expect, it } from 'vitest'

import { coarsenTo, derivable, isDerived, ladderWith, MAX_DERIVED_BP } from '@/metacooler/coarsen'

/** The ladder in the user's own example: 1, 2, 5 and 10 kb. */
const LADDER = [1_000, 2_000, 5_000, 10_000].map((binsize) => ({
  name: String(binsize),
  binsize,
}))

/** A `zoomify` default that stops early — the case this exists for. */
const DOUBLING = [1_000, 2_000, 4_000].map((binsize) => ({ name: String(binsize), binsize }))

/** The refusal's kind, or `'ok'` where there was none. */
function kindOf(target: number, rungs = LADDER, declared: number[] = []): string {
  const answer = derivable(target, rungs, declared)
  return isDerived(answer) ? 'ok' : answer.kind
}

describe('which rung a resolution is summed from', () => {
  it('takes the coarsest that divides it, not the finest', () => {
    // 20 kb is twenty 1 kb bins, ten 2 kb bins, four 5 kb bins or two 10 kb
    // ones. All four give the same picture; the last walks a twentieth of the
    // stored pixels.
    expect(coarsenTo(20_000, LADDER)).toEqual({
      binsize: 20_000,
      from: { name: '10000', binsize: 10_000 },
      factor: 2,
    })
  })

  it('falls back down the ladder when the coarse rungs do not divide', () => {
    // 4 kb: not a multiple of 5 or 10, twice 2 kb.
    expect(coarsenTo(4_000, LADDER)?.from.binsize).toBe(2_000)
    // 3 kb: not a multiple of 2, 5 or 10 — three 1 kb bins.
    expect(coarsenTo(3_000, LADDER)?.from.binsize).toBe(1_000)
    expect(coarsenTo(3_000, LADDER)?.factor).toBe(3)
  })

  it('reaches a resolution past the coarsest rung the file has', () => {
    // The case in the request: a 10 kb picture of a file that stops at 4 kb.
    const derived = coarsenTo(10_000, DOUBLING)
    expect(derived?.from.binsize).toBe(2_000)
    expect(derived?.factor).toBe(5)
  })

  it('never returns a factor of one, which would be the rung itself', () => {
    // A target the file already carries still has arithmetic behind it — 10 kb
    // is two 5 kb bins — and `coarsenTo` answers with it, because a link that
    // arrives naming one needs to know how to read it. Refusing to *offer* it
    // is `derivable`'s job, which is the split these two functions are.
    expect(coarsenTo(10_000, LADDER)?.factor).toBe(2)
    expect(kindOf(10_000)).toBe('stored')
    // Nothing is finer than the finest rung, so there is nothing to sum.
    expect(coarsenTo(1_000, LADDER)).toBeNull()
  })

  it('holds the invariant everything downstream reads it by', () => {
    for (const target of [3_000, 4_000, 6_000, 20_000, 50_000, 1_000_000]) {
      const derived = coarsenTo(target, LADDER)
      if (derived === null) continue
      expect(derived.from.binsize * derived.factor).toBe(derived.binsize)
      expect(derived.factor).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('what cannot be reached', () => {
  it('refuses half a bin, and says which bins it is half of', () => {
    const answer = derivable(2_500, LADDER)
    expect(isDerived(answer)).toBe(false)
    expect(kindOf(2_500)).toBe('indivisible')
    if (!isDerived(answer)) expect(answer.why).toContain('1,000')
  })

  it('refuses a resolution finer than the file’s own bins', () => {
    expect(kindOf(500)).toBe('finer')
    // …and says so in those words, because "bins can be added up, never split"
    // is the fact a reader needs and no arithmetic will ever get round.
    const answer = derivable(500, LADDER)
    if (!isDerived(answer)) expect(answer.why).toContain('never split')
  })

  it('refuses one the file already carries, rather than shadowing it', () => {
    expect(kindOf(5_000)).toBe('stored')
  })

  it('refuses one the reader has already added', () => {
    expect(kindOf(3_000, LADDER, [3_000])).toBe('declared')
    // …and still accepts it where they have not.
    expect(kindOf(3_000, LADDER, [4_000])).toBe('ok')
  })

  it('refuses a number that is not a whole count of base pairs', () => {
    expect(kindOf(1_500.5)).toBe('shape')
    expect(kindOf(0)).toBe('shape')
    expect(kindOf(-1_000)).toBe('shape')
    expect(kindOf(Number.NaN)).toBe('shape')
  })

  it('refuses a slipped decimal point rather than computing it', () => {
    expect(kindOf(MAX_DERIVED_BP + 1_000)).toBe('wide')
    expect(kindOf(MAX_DERIVED_BP)).toBe('ok')
  })
})

describe('the ladder the picker draws', () => {
  it('puts an added resolution where its number says, not in a group at the end', () => {
    const ladder = ladderWith(LADDER, [3_000])
    expect(ladder.map((rung) => rung.binsize)).toEqual([1_000, 2_000, 3_000, 5_000, 10_000])
  })

  it('marks the added one and leaves the file’s own unmarked', () => {
    const ladder = ladderWith(LADDER, [3_000, 20_000])
    expect(
      ladder.filter((rung) => rung.derived !== undefined).map((rung) => rung.binsize),
    ).toEqual([3_000, 20_000])
    expect(ladder.find((rung) => rung.binsize === 5_000)?.derived).toBeUndefined()
  })

  it('drops a declared size this file cannot reach', () => {
    // 3 kb was added against a 1 kb ladder; this entry starts at 2 kb, where
    // three 1 kb bins do not exist. A stop that cannot be read is worse than
    // one that is not offered.
    const coarse = [2_000, 4_000].map((binsize) => ({ name: String(binsize), binsize }))
    expect(ladderWith(coarse, [3_000]).map((rung) => rung.binsize)).toEqual([2_000, 4_000])
  })

  it('drops a declared size the file turns out to carry', () => {
    expect(ladderWith(LADDER, [5_000]).map((rung) => rung.binsize)).toEqual([
      1_000, 2_000, 5_000, 10_000,
    ])
  })

  it('is the file’s own ladder where the reader has declared nothing', () => {
    expect(ladderWith(LADDER, [])).toEqual(LADDER.map((rung) => ({ ...rung })))
  })

  it('names a derived rung by its own bin size, which is what a link carries', () => {
    const derived = ladderWith(LADDER, [3_000]).find((rung) => rung.binsize === 3_000)
    expect(derived?.name).toBe('3000')
    expect(derived?.derived?.from.name).toBe('1000')
  })
})

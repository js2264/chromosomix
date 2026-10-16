/**
 * int64 columns narrowed word by word, never through a BigInt per element.
 *
 * `toNumberArray` and `lowWords` used to call `Number(x[i])` on every element,
 * which made a BigInt of each. What they compute now from the two 32-bit words
 * has to be that same number to the last bit: exact below 2^53, the one
 * rounding `Number` makes above it, and the low word `ToInt32` keeps.
 */

import { describe, expect, it } from 'vitest'

import { lowWords, toNumberArray } from '@/h5/typed'

const SIGNED = [
  0n, 1n, -1n, -5n, 2n ** 31n - 1n, 2n ** 31n, 2n ** 31n + 3n, -(2n ** 31n), -(2n ** 31n) - 1n, 2n ** 32n,
  2n ** 32n + 7n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, 2n ** 53n + 3n, 2n ** 62n + 12345n, 2n ** 63n - 1n,
  -(2n ** 63n), -(2n ** 53n) - 1n, 123456789012345n, -987654321098765n,
]
const UNSIGNED = [0n, 1n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 53n + 1n, 2n ** 63n, 2n ** 64n - 1n, 2n ** 64n - 2049n]

/** The extremes, and a few thousand from a 64-bit LCG for everything between. */
function values(): { signed: bigint[]; unsigned: bigint[] } {
  const signed = [...SIGNED]
  const unsigned = [...UNSIGNED]
  let r = 1n
  for (let i = 0; i < 4000; i++) {
    r = (r * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
    unsigned.push(r)
    signed.push(BigInt.asIntN(64, r))
    // and small ones, which is what an index column holds
    signed.push(r % 100_000_000n)
  }
  return { signed, unsigned }
}

describe('toNumberArray on 64-bit integers', () => {
  it('is Number() of every signed value, bit for bit', () => {
    const { signed } = values()
    const got = toNumberArray(BigInt64Array.from(signed))
    signed.forEach((v, i) => expect(Object.is(got[i], Number(v)), `${v}`).toBe(true))
  })

  it('is Number() of every unsigned value, bit for bit', () => {
    const { unsigned } = values()
    const got = toNumberArray(BigUint64Array.from(unsigned))
    unsigned.forEach((v, i) => expect(Object.is(got[i], Number(v)), `${v}`).toBe(true))
  })
})

describe('lowWords', () => {
  it('is ToInt32(Number(x)) wherever Number is exact, and the low word everywhere', () => {
    const { signed } = values()
    const got = lowWords(BigInt64Array.from(signed))
    signed.forEach((v, i) => {
      expect(got[i], `${v}`).toBe(Number(BigInt.asIntN(32, v)))
      if (v >= -(2n ** 53n) && v <= 2n ** 53n) expect(got[i], `${v}`).toBe(new Int32Array([Number(v)])[0])
    })
  })
})

describe('a view that does not start at its buffer', () => {
  it('narrows the view and nothing either side of it', () => {
    const whole = BigInt64Array.from([5n, -7n, 2n ** 40n + 9n, 11n])
    const view = whole.subarray(1, 3)
    expect(Array.from(toNumberArray(view))).toEqual([-7, 2 ** 40 + 9])
    expect(Array.from(lowWords(view))).toEqual([-7, 9])
  })
})

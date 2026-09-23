/**
 * Telling "the browser would not lend the memory" from every other failure.
 *
 * It is the one error the whole-file view answers with another level rather
 * than an error screen (§7.3), so a false positive would silently change the
 * picture and a false negative is the failure a reader reported: an error
 * screen reading *Array buffer allocation failed* over a file that opens fine
 * one level up. Only the name and the message cross the worker boundary, so
 * that is what is tested.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError, isAllocationFailure } from '@/errors'
import { reviveError, serialiseError } from '@/worker/protocol'

const named = (name: string, message: string): Error => {
  const err = new Error(message)
  err.name = name
  return err
}

describe('isAllocationFailure', () => {
  it('knows each engine’s words for it', () => {
    expect(isAllocationFailure(new RangeError('Array buffer allocation failed'))).toBe(true)
    expect(isAllocationFailure(new RangeError('Invalid array length'))).toBe(true)
    expect(isAllocationFailure(new RangeError('Out of memory'))).toBe(true)
    expect(isAllocationFailure(named('InternalError', 'out of memory'))).toBe(true)
  })

  it('survives the trip back from the reader worker', () => {
    const back = reviveError(serialiseError(new RangeError('Array buffer allocation failed')))
    expect(isAllocationFailure(back)).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isAllocationFailure(new RangeError("Unknown transform: 'x'"))).toBe(false)
    expect(isAllocationFailure(new Error('Array buffer allocation failed'))).toBe(false)
    expect(isAllocationFailure(new ViewerError('dense-too-large', 'too large'))).toBe(false)
    expect(isAllocationFailure('out of memory')).toBe(false)
  })
})

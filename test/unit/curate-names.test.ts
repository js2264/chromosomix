// @dev-feature curate
/** Short names (SPECS §33.3): a section's shared prefix printed once. */

import { describe, expect, it } from 'vitest'
import { sharedPrefix, shortName } from '../../src/curate/names'

describe('short names', () => {
  it('take the prefix a binner gives every bin, to its last underscore', () => {
    const mags = ['MM133_metator_00001_00000', 'MM133_metator_00001_00002', 'MM133_metator_00700_00001']
    expect(sharedPrefix(mags)).toBe('MM133_metator_')
    expect(mags.map((name) => shortName(name, 'MM133_metator_'))).toEqual(['00001_00000', '00001_00002', '00700_00001'])
    expect(sharedPrefix(['MetaTOR_MGE_00001', 'MetaTOR_MGE_00127'])).toBe('MetaTOR_MGE_')
  })

  it('keep a name whole that does not share it, and take none from one name, a short prefix, or a name it would leave bare', () => {
    expect(shortName('curated_MAG_1', 'MM133_metator_')).toBe('curated_MAG_1')
    expect(sharedPrefix(['MM133_metator_00001_00000'])).toBe('')
    expect(sharedPrefix(['ab_1', 'ab_2'])).toBe('')
    expect(sharedPrefix(['bin_x_1', 'bin_x_12'])).toBe('')
    expect(sharedPrefix(['X1', 'X2', 'Y'])).toBe('')
  })
})

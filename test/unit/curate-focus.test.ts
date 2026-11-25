// @dev-feature curate
/**
 * The close-up's picture (SPECS §33.3): one cell a contig, observed over what
 * the visibilities expect, a contig's own cell its density, drawn as the file's
 * picture is — and the readout's numbers from the contacts, never a byte.
 */

import { describe, expect, it } from 'vitest'
import { FOCUS_PICTURE_CAP, focusContactsOf, focusPicture, ownRatio, pairRatio, type FocusContacts } from '../../src/curate/focus'
import { logOf, triangleIndex } from '../../src/metacooler/picture'

/** Three contigs: 0 and 1 one organism's, meeting densely; 2 a stranger. */
const CONTACTS: FocusContacts = {
  i: [0, 0, 1],
  j: [1, 2, 2],
  contacts: [400, 1, 2],
  within: [5000, 3000, 0],
  visibility: [500, 450, 60],
  total: 100_000,
}

describe('the close-up', () => {
  it('shows a pair over what the visibilities expect, a contig with itself as its density', () => {
    expect(pairRatio(400, 500, 450, 100_000)).toBeCloseTo((400 * 100_000) / (500 * 450), 9)
    expect(pairRatio(3, 0, 450, 100_000)).toBe(0)
    expect(ownRatio(5000, 500, 100_000)).toBeCloseTo((2 * 5000 * 100_000) / (500 * 500), 9)
    expect(ownRatio(0, 500, 100_000)).toBe(0)
    expect(ownRatio(10, 0, 100_000)).toBe(Number.POSITIVE_INFINITY)
  })

  it('is a byte a cell, the organism’s pair brighter than the stranger’s, the diagonal brightest', () => {
    const picture = focusPicture(3, CONTACTS, 0.02)
    expect(picture).not.toBeNull()
    if (picture === null) return
    const cells = picture.levels[0].cells
    const q = { low: picture.low, high: picture.high }
    const at = (a: number, b: number): number => cells[triangleIndex(a, b, 3)]
    expect(at(0, 1)).toBeGreaterThan(at(0, 2))
    expect(at(0, 0)).toBeGreaterThanOrEqual(at(0, 1))
    // A contig without contacts within itself is an empty cell.
    expect(at(2, 2)).toBe(0)
    // The byte stands for the ratio, to a byte's step.
    const step = (picture.high - picture.low) / 254
    expect(Math.abs(logOf(at(0, 1), q) - Math.log10(pairRatio(400, 500, 450, 100_000)))).toBeLessThanOrEqual(step)
    // It opens at the background, so noise sits at the scale's foot.
    expect(picture.vmin).toBeCloseTo(Math.log10(0.02), 9)
    expect(picture.vmax).toBeGreaterThan(picture.vmin)
  })

  it('builds a pyramid of means past 256 contigs, and none past its cap', () => {
    const n = 600
    const many: FocusContacts = { i: [0], j: [599], contacts: [5], within: new Float64Array(n).fill(10), visibility: new Float64Array(n).fill(100), total: 1e5 }
    const picture = focusPicture(n, many, 0.02)
    expect(picture?.levels.map((level) => level.n)).toEqual([600, 300, 150])
    expect(focusPicture(FOCUS_PICTURE_CAP + 1, many, 0.02)).toBeNull()
    expect(focusPicture(0, many, 0.02)).toBeNull()
  })

  it('gives the readout a pair’s contacts from the answer, whichever way it is asked', () => {
    expect(focusContactsOf(CONTACTS, 0, 1)).toBe(400)
    expect(focusContactsOf(CONTACTS, 2, 1)).toBe(2)
    expect(focusContactsOf(CONTACTS, 1, 1)).toBe(3000)
    expect(focusContactsOf({ ...CONTACTS, i: [0], j: [2], contacts: [7] }, 0, 1)).toBe(0)
  })
})

// @vitest-environment jsdom
/**
 * The two lines' `split by` select (§7.6), as a reader meets it on the Map card
 * and on the picture before a column is chosen: every column of the Genomes
 * table, those of two values with their two values and the rest greyed with why
 * not, and a first option asking for one while none is chosen.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SplitChoice } from '@/app/lineSplit'
import { paintSplitSelect } from '@/ui/LinesView'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const CHOICES: SplitChoice[] = [
  { column: 'length', levels: null, reason: '48 values', missing: 0 },
  { column: 'step', levels: ['0', '1'], reason: null, missing: 1 },
  { column: 'recursive', levels: null, reason: 'one value', missing: 1 },
]

const options = (select: HTMLSelectElement): string[] =>
  [...select.options].map((option) => `${option.textContent}${option.disabled ? ' ✗' : ''}`)

describe('the split by select', () => {
  it('asks for a column while none is chosen, and greys every column that cannot split the genomes', () => {
    const select = document.createElement('select')
    paintSplitSelect(select, CHOICES, null)
    expect(options(select)).toEqual(['pick a column…', 'length — 48 values ✗', 'step — 0 | 1', 'recursive — one value ✗'])
    expect(select.value).toBe('')
  })

  it('shows the column chosen, and drops the question once one is', () => {
    const select = document.createElement('select')
    paintSplitSelect(select, CHOICES, 'step')
    expect(options(select)[0]).toBe('length — 48 values ✗')
    expect(select.value).toBe('step')
  })

  it('keeps its options while the list is the same, so a menu open on it stays open', () => {
    const select = document.createElement('select')
    paintSplitSelect(select, CHOICES, 'step')
    const first = select.options[0]
    paintSplitSelect(select, [...CHOICES], 'step')
    expect(select.options[0]).toBe(first)
  })
})

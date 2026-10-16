// @vitest-environment jsdom
/**
 * The picker on a deck cell's heading saying which sequence its map is on, and
 * taking it to another (§16.3).
 *
 * What it must say is a fact about the block the cell read — one sequence, a
 * block between two, or several — and what it must not do is offer a menu
 * nobody could use: none on a file of one sequence, and none on one of more
 * sequences than a menu holds, where the box drawn on the cell is the road.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { paintSequencePicker, SEQUENCE_MENU_MAX, sequencePicker, shownSequence } from '@/panels/sequencePicker'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const YEAST = ['I', 'II', 'III', 'IV', 'V', 'XII']

describe('shownSequence', () => {
  it('names the one sequence a block is on', () => {
    expect(shownSequence(['IV'], ['IV'])).toEqual({ name: 'IV' })
    expect(shownSequence(['IV'], [])).toEqual({ name: 'IV' })
  })

  it('writes a block between two sequences as the pair', () => {
    expect(shownSequence(['IV'], ['V'])).toEqual({ phrase: 'IV × V' })
  })

  it('counts a block over several', () => {
    expect(shownSequence(['I', 'II', 'III'], ['I', 'II', 'III'])).toEqual({ phrase: '3 sequences' })
    expect(shownSequence([], [])).toEqual({ phrase: '—' })
  })
})

describe('the picker', () => {
  it('lists the file’s sequences and stands on the one shown', () => {
    const picker = sequencePicker(() => {})
    paintSequencePicker(picker, YEAST, { name: 'IV' }, 'title')
    expect(picker.classList.contains('hidden')).toBe(false)
    expect(Array.from(picker.options, (option) => option.value)).toEqual(['', ...YEAST])
    expect(picker.value).toBe('IV')
    expect(picker.title).toBe('title')
  })

  it('says a pair or a count in the closed box, which is not a place to go', () => {
    const picker = sequencePicker(() => {})
    paintSequencePicker(picker, YEAST, { phrase: 'IV × V' }, '')
    expect(picker.value).toBe('')
    const blank = picker.options[0]
    expect(blank.textContent).toBe('IV × V')
    expect(blank.disabled).toBe(true)
    expect(blank.hidden).toBe(true)
  })

  it('says a name this file does not list without standing on another', () => {
    const picker = sequencePicker(() => {})
    paintSequencePicker(picker, YEAST, { name: 'genome_7' }, '')
    expect(picker.value).toBe('')
    expect(picker.options[0].textContent).toBe('genome_7')
  })

  it('keeps its options while the list is the same, so an open menu stays open', () => {
    const picker = sequencePicker(() => {})
    paintSequencePicker(picker, YEAST, { name: 'IV' }, '')
    const first = picker.options[3]
    paintSequencePicker(picker, [...YEAST], { name: 'V' }, '')
    expect(picker.options[3]).toBe(first)
    expect(picker.value).toBe('V')
    paintSequencePicker(picker, ['chrI', 'chrII'], { name: 'chrII' }, '')
    expect(Array.from(picker.options, (option) => option.value)).toEqual(['', 'chrI', 'chrII'])
  })

  it('is not offered on one sequence, nor on more than a menu holds', () => {
    const picker = sequencePicker(() => {})
    paintSequencePicker(picker, ['chr'], { name: 'chr' }, '')
    expect(picker.classList.contains('hidden')).toBe(true)
    const many = Array.from({ length: SEQUENCE_MENU_MAX + 1 }, (_, i) => `contig_${i}`)
    paintSequencePicker(picker, many, { name: 'contig_0' }, '')
    expect(picker.classList.contains('hidden')).toBe(true)
  })

  it('hands a pick to the cell, and nothing for the blank', () => {
    const picked: string[] = []
    const picker = sequencePicker((name) => picked.push(name))
    paintSequencePicker(picker, YEAST, { name: 'IV' }, '')
    picker.value = 'XII'
    picker.dispatchEvent(new Event('change'))
    picker.value = ''
    picker.dispatchEvent(new Event('change'))
    expect(picked).toEqual(['XII'])
  })
})

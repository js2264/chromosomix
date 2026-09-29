// @vitest-environment jsdom
/**
 * The breadcrumb's *contacts* box (§6.5), on its own.
 *
 * What it owes the reader is small and easy to get wrong in ways a picture
 * hides: a total typed in the forms a methods section prints is read as one; a
 * total that is not one is refused *in the box*, with nothing drawn; Escape and
 * an emptied box put back what they should; and the two chevrons appear only
 * where there are two maps to match, type the shallowest or the deepest total,
 * and wait while any map's total is still being counted.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { ContactsBox, type MapTotal } from '@/ui/ContactsBox'
import { setUpDom } from '../support/dom'

beforeEach(() => {
  setUpDom()
})

interface Rig {
  box: ContactsBox
  input: HTMLInputElement
  down: HTMLButtonElement
  up: HTMLButtonElement
  commits: (number | null)[]
  /** What the session holds; the box reads it back on every sync. */
  state: { value: number | null; maps: MapTotal[]; refusal: string | null }
}

function rig(state: Partial<Rig['state']> = {}): Rig {
  const held: Rig['state'] = { value: null, maps: [{ label: 'a.cool', total: 179_175_551 }], refusal: null, ...state }
  const commits: (number | null)[] = []
  const box = new ContactsBox({
    value: () => held.value,
    own: () => held.maps[0]?.total ?? null,
    maps: () => held.maps,
    refusal: () => held.refusal,
    onCommit: (contacts) => {
      commits.push(contacts)
      held.value = contacts
    },
  })
  document.body.appendChild(box.el)
  const [down, up] = [...box.el.querySelectorAll<HTMLButtonElement>('.contacts-match')]
  return { box, input: box.el.querySelector('.contacts-input')!, down, up, commits, state: held }
}

function typeAndEnter(input: HTMLInputElement, text: string): void {
  input.focus()
  input.value = text
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

describe('one map', () => {
  it('shows the map’s own total in grey and nothing typed', () => {
    const { box, input } = rig()
    expect(box.el.querySelector('.res-label')?.textContent).toBe('contacts')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('179,175,551')
    expect(input.classList.contains('is-set')).toBe(false)
  })

  it('reads 10M and 23,000,000 as the totals they are', () => {
    const { input, commits } = rig()
    typeAndEnter(input, '10M')
    typeAndEnter(input, '23,000,000')
    expect(commits).toEqual([10_000_000, 23_000_000])
    expect(input.value).toBe('23,000,000')
    expect(input.classList.contains('is-set')).toBe(true)
  })

  it('refuses a total that is not one in the box, and draws nothing', () => {
    const { input, commits } = rig()
    typeAndEnter(input, 'lots')
    expect(commits).toEqual([])
    expect(input.classList.contains('is-refused')).toBe(true)
    expect(input.title).toContain('is not a number of contacts')
    // Left as typed, so the reader can fix it rather than type it again.
    expect(input.value).toBe('lots')
  })

  it('puts back what is in force on Escape', () => {
    const { input, commits } = rig({ value: 10_000_000 })
    input.focus()
    input.value = '5M'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(commits).toEqual([])
    expect(input.value).toBe('10,000,000')
  })

  it('puts the files back as stored when emptied', () => {
    const { input, commits } = rig({ value: 10_000_000 })
    typeAndEnter(input, '')
    expect(commits).toEqual([null])
    expect(input.value).toBe('')
    expect(input.classList.contains('is-set')).toBe(false)
  })

  it('does not ask for the total already in force', () => {
    const { input, commits } = rig({ value: 10_000_000 })
    typeAndEnter(input, '10,000,000')
    expect(commits).toEqual([])
  })

  it('commits on leaving the box, not on every keystroke', () => {
    const { input, commits } = rig()
    input.focus()
    input.value = '1'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.value = '10M'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(commits).toEqual([])
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(commits).toEqual([10_000_000])
  })

  it('says why a map could not be drawn to the total, in red', () => {
    const { box, input } = rig({ value: 500_000_000, refusal: 'NC_000913.3 is 4,642 bins at this resolution' })
    box.sync()
    expect(input.classList.contains('is-refused')).toBe(true)
    expect(input.title).toContain('4,642 bins')
  })

  it('keeps the chevrons away, with nothing to match', () => {
    const { down, up } = rig()
    expect(down.classList.contains('hidden')).toBe(true)
    expect(up.classList.contains('hidden')).toBe(true)
  })
})

describe('two maps or more', () => {
  const two: MapTotal[] = [
    { label: 'micro-C (cool)', total: 179_175_551 },
    { label: 'Hi-C (hic)', total: 13_681_280 },
  ]

  it('puts up the chevrons, and lists every map’s total in the box’s tooltip', () => {
    const { input, down, up } = rig({ maps: two })
    expect(down.classList.contains('hidden')).toBe(false)
    expect(up.classList.contains('hidden')).toBe(false)
    expect(input.title).toContain('micro-C (cool): 179,175,551')
    expect(input.title).toContain('Hi-C (hic): 13,681,280')
  })

  it('types the shallowest total on down and the deepest on up, and lights the one in force', () => {
    const { input, down, up, commits } = rig({ maps: two })
    down.click()
    expect(commits).toEqual([13_681_280])
    expect(input.value).toBe('13,681,280')
    expect(down.getAttribute('aria-pressed')).toBe('true')
    expect(up.getAttribute('aria-pressed')).toBe('false')
    up.click()
    expect(commits).toEqual([13_681_280, 179_175_551])
    expect(down.getAttribute('aria-pressed')).toBe('false')
    expect(up.getAttribute('aria-pressed')).toBe('true')
    expect(up.title).toContain('Boost-HiC')
  })

  it('names the map each chevron’s total is', () => {
    const { down, up } = rig({ maps: two })
    expect(down.title).toContain('13,681,280')
    expect(down.title).toContain('Hi-C (hic)')
    expect(up.title).toContain('micro-C (cool)')
  })

  it('waits, disabled, while a map’s total is still being counted', () => {
    const { box, down, up, commits, state } = rig({ maps: [two[0], { label: 'Hi-C (hic)', total: null }] })
    expect(down.disabled).toBe(true)
    expect(up.disabled).toBe(true)
    expect(down.title).toContain('Hi-C (hic)')
    down.click()
    expect(commits).toEqual([])
    state.maps = two
    box.sync()
    expect(down.disabled).toBe(false)
  })
})

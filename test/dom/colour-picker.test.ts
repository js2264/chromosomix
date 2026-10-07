// @vitest-environment jsdom
/**
 * The app's own colour picker (§26.6): every `<input type="color">` opens it
 * in place of the platform's, it leads with hex, it keeps the colours last
 * picked, and a drag across it survives the swatch being rebuilt under it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  RECENT_LIMIT,
  installColourPicker,
  openPickerElement,
  parseHex,
  recentColours,
  rememberColour,
  resetColourPickerForTests,
} from '@/ui/colourPicker'
import { setUpDom } from '../support/dom'

beforeEach(() => {
  setUpDom()
  resetColourPickerForTests()
  window.localStorage.clear()
  installColourPicker()
})

function swatch(value = '#56b4e9'): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'color'
  input.value = value
  document.body.append(input)
  return input
}

function hexBox(): HTMLInputElement {
  return openPickerElement()!.querySelector<HTMLInputElement>('.cpick-hex')!
}

describe('parseHex', () => {
  it('takes three or six digits, with or without the #, and drops an alpha', () => {
    expect(parseHex('56B4E9')).toBe('#56b4e9')
    expect(parseHex(' #5be ')).toBe('#55bbee')
    expect(parseHex('#56b4e980')).toBe('#56b4e9')
    expect(parseHex('56b4e')).toBeNull()
    expect(parseHex('rgb(1,2,3)')).toBeNull()
  })
})

describe('the picker', () => {
  it('opens on a click in place of the platform picker, with the colour as hex', () => {
    const input = swatch()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    input.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(openPickerElement()).not.toBeNull()
    expect(hexBox().value).toBe('56b4e9')
    expect(document.activeElement).toBe(hexBox())
  })

  it('writes a typed hex into the input with input, then change on Enter, and remembers it', () => {
    const input = swatch()
    const seen: string[] = []
    input.addEventListener('input', () => seen.push(`input ${input.value}`))
    input.addEventListener('change', () => seen.push(`change ${input.value}`))
    input.click()
    hexBox().value = 'e69f00'
    hexBox().dispatchEvent(new Event('input'))
    hexBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(seen).toEqual(['input #e69f00', 'change #e69f00'])
    expect(openPickerElement()).toBeNull()
    expect(recentColours()[0]).toBe('#e69f00')
  })

  it('leaves a half-typed hex unapplied', () => {
    const input = swatch()
    input.click()
    hexBox().value = 'e69'
    hexBox().dispatchEvent(new Event('input'))
    expect(input.value).toBe('#ee6699')
    hexBox().value = 'e69f'
    hexBox().dispatchEvent(new Event('input'))
    expect(input.value).toBe('#ee6699')
    expect(hexBox().classList.contains('is-invalid')).toBe(true)
  })

  it('offers the recent colours, newest first, and applies one on a click', () => {
    rememberColour('#009e73')
    rememberColour('#d55e00')
    const input = swatch()
    input.click()
    const chips = [...openPickerElement()!.querySelectorAll<HTMLButtonElement>('.cpick-chip')]
    expect(chips.map((chip) => chip.dataset.colour)).toEqual(['#d55e00', '#009e73'])
    let changes = 0
    input.addEventListener('change', () => changes++)
    chips[1].click()
    expect(input.value).toBe('#009e73')
    expect(changes).toBe(1)
  })

  it('keeps at most the limit, once each', () => {
    for (let i = 0; i < RECENT_LIMIT + 4; i++) rememberColour(`#0000${i.toString(16).padStart(2, '0')}`)
    rememberColour('#000003')
    const list = recentColours()
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0]).toBe('#000003')
    expect(new Set(list).size).toBe(list.length)
  })

  it('stays open while the swatch it came from is rebuilt, and closes on a press outside', () => {
    const input = swatch()
    input.addEventListener('input', () => {
      // What a card does on every store change: a new swatch where the old was.
      input.replaceWith(swatch(input.value))
    })
    input.click()
    hexBox().value = '123456'
    hexBox().dispatchEvent(new Event('input'))
    expect(input.isConnected).toBe(false)
    expect(openPickerElement()).not.toBeNull()
    hexBox().value = '654321'
    hexBox().dispatchEvent(new Event('input'))
    expect(input.value).toBe('#654321')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(openPickerElement()).toBeNull()
    expect(recentColours()[0]).toBe('#654321')
  })

  it('closes on Escape, and a second click on its swatch', () => {
    const input = swatch()
    input.click()
    hexBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(openPickerElement()).toBeNull()
    input.click()
    expect(openPickerElement()).not.toBeNull()
    input.click()
    expect(openPickerElement()).toBeNull()
  })

  it('does not remember a colour it was opened on and left alone', () => {
    const input = swatch('#abcdef')
    input.click()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(recentColours()).toEqual([])
  })
})

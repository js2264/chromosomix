// @vitest-environment jsdom
/**
 * The two controls a reader sets the colour scale from.
 *
 * They are the same two numbers seen twice — once on the card, where they are a
 * pair of boxes and a way back to auto, and once in the corner of the map, where
 * they are the legend and a click puts a caret in them. Both are edited *while
 * the picture underneath is repainting*, which is the whole difficulty: each has
 * a guard that stops a repaint rewriting a box under the caret, and each has to
 * make sure that guard does not also swallow the answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClipRange } from '@/ui/ClipRange'
import { MapKey } from '@/ui/MapKey'
import type { ValueRange } from '@/render/scale'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

interface BuiltClip {
  clip: ClipRange
  changes: Array<ValueRange | null>
  low: HTMLInputElement
  high: HTMLInputElement
  note: HTMLElement
  auto: HTMLButtonElement
}

function clipRange(): BuiltClip {
  const changes: Array<ValueRange | null> = []
  const clip = new ClipRange({
    onChange: (value) => changes.push(value),
    format: (value) => `${value.toFixed(1)} counts`,
  })
  document.body.appendChild(clip.el)
  return {
    clip,
    changes,
    low: clip.el.querySelector('[aria-label="low clip value"]') as HTMLInputElement,
    high: clip.el.querySelector('[aria-label="high clip value"]') as HTMLInputElement,
    note: clip.el.querySelector('.clip-note') as HTMLElement,
    auto: clip.el.querySelector('.clip-auto') as HTMLButtonElement,
  }
}

/** Type a value and commit it the way Enter does: without leaving the box. */
function typeInto(box: HTMLInputElement, text: string): void {
  box.focus()
  box.value = text
  box.dispatchEvent(new Event('change'))
}

describe('the clip boxes', () => {
  it('shows the bounds in force, and says they came from the data', () => {
    const built = clipRange()
    built.clip.setValues({ vmin: -2, vmax: 8.5 }, true)
    expect(built.low.value).toBe('-2')
    expect(built.high.value).toBe('8.5')
    expect(built.note.textContent).toBe('auto · -2.0 counts – 8.5 counts')
    // Nothing to hand back while it is already the data's.
    expect(built.auto.disabled).toBe(true)
    expect(built.clip.el.classList.contains('clip-manual')).toBe(false)
  })

  it('takes a bound, reports it, and stops calling itself auto', () => {
    const built = clipRange()
    built.clip.setValues({ vmin: 0, vmax: 10 }, true)
    typeInto(built.high, '4')
    expect(built.changes).toEqual([{ vmin: 0, vmax: 4 }])
    expect(built.note.textContent).toBe('clipped · 0.0 counts – 4.0 counts')
    expect(built.clip.el.classList.contains('clip-manual')).toBe(true)
    expect(built.auto.disabled).toBe(false)
  })

  it('refuses an inverted bound, visibly, with the caret still in the box', () => {
    const built = clipRange()
    built.clip.setValues({ vmin: 0, vmax: 10 }, true)
    typeInto(built.high, '-3')
    // `change` fires on Enter without moving the focus, so a refusal that went
    // through the repaint's focus guard would leave `-3` on screen as if it had
    // been taken.
    expect(built.changes).toEqual([])
    expect(built.high.value).toBe('10')
    expect(built.note.textContent).toBe('auto · 0.0 counts – 10.0 counts')
  })

  it('refuses an emptied box rather than reading it as zero', () => {
    const built = clipRange()
    built.clip.setValues({ vmin: -4, vmax: 4 }, true)
    // A `type="number"` box reports `''` for a cleared box *and* for anything the
    // browser refused to parse, and `Number('')` is 0 — which on a log10 scale,
    // whose values are all below zero, made clearing the high bound clip the map
    // at 1 instead of leaving it alone.
    typeInto(built.high, '')
    expect(built.changes).toEqual([])
    expect(built.high.value).toBe('4')
    typeInto(built.low, 'nonsense')
    expect(built.changes).toEqual([])
    expect(built.low.value).toBe('-4')
  })

  it('hands the range back to the data', () => {
    const built = clipRange()
    built.clip.setValues({ vmin: 0, vmax: 10 }, true)
    typeInto(built.high, '4')
    built.high.blur()
    built.auto.click()
    expect(built.changes.at(-1)).toBeNull()
    expect(built.clip.el.classList.contains('clip-manual')).toBe(false)
    expect(built.auto.disabled).toBe(true)
  })

  it('leaves a box alone while it is being typed in', () => {
    const built = clipRange()
    built.clip.setValues({ vmin: 0, vmax: 10 }, true)
    built.high.focus()
    built.high.value = '7'
    // The heatmap repaints on every frame of a drag; rewriting the box under the
    // caret eats digits.
    built.clip.setValues({ vmin: 0, vmax: 12 }, true)
    expect(built.high.value).toBe('7')
    expect(built.low.value).toBe('0')
  })
})

const CONTENT = {
  title: 'Balanced (log2)',
  note: '5 kb per square',
  lo: -3,
  hi: 4,
  loLabel: '0.125',
  hiLabel: '16',
  loColor: '#000',
  hiColor: '#fff',
}

describe('the key in the corner of the map', () => {
  it('prints the title, the resolution and both ends', () => {
    const key = new MapKey()
    document.body.appendChild(key.el)
    key.set(CONTENT)
    expect(key.el.querySelector('.map-key-title')?.textContent).toBe('Balanced (log2)')
    expect(key.el.querySelector('.map-key-note')?.textContent).toBe('5 kb per square')
    expect(key.el.querySelector('.map-key-note')?.classList.contains('hidden')).toBe(false)
    expect(key.el.querySelector('.is-lo')?.textContent).toBe('0.125')
    expect(key.el.querySelector('.is-hi')?.textContent).toBe('16')
  })

  it('hides the second line rather than keeping a blank one', () => {
    const key = new MapKey()
    key.set({ ...CONTENT, note: undefined })
    expect(key.el.querySelector('.map-key-note')?.classList.contains('hidden')).toBe(true)
  })

  it('is not a control on a panel whose scale is not the reader’s to set', () => {
    const key = new MapKey()
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const lo = key.el.querySelector('.is-lo') as HTMLElement
    expect(lo.getAttribute('role')).toBeNull()
    lo.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(lo.querySelector('input')).toBeNull()
  })

  it('opens a box on the bound, seeded with the value in force', () => {
    const changes: Array<[string, number | null]> = []
    const key = new MapKey({ onChange: (bound, value) => changes.push([bound, value]) })
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const hi = key.el.querySelector('.is-hi') as HTMLElement
    expect(hi.getAttribute('role')).toBe('button')
    hi.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = hi.querySelector('input') as HTMLInputElement
    // The transformed value, which is what the caller's `onChange` takes — not
    // the label, which is printed in counts.
    expect(input.value).toBe('4')
  })

  it('commits on Enter, once, and puts the label back', () => {
    const changes: Array<[string, number | null]> = []
    const key = new MapKey({ onChange: (bound, value) => changes.push([bound, value]) })
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const hi = key.el.querySelector('.is-hi') as HTMLElement
    hi.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = hi.querySelector('input') as HTMLInputElement
    input.value = '6'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    // Taking the box away blurs it, and the blur handler commits too: the second
    // pass has to be a no-op or the label never goes back.
    expect(changes).toEqual([['hi', 6]])
    expect(hi.querySelector('input')).toBeNull()
    expect(hi.textContent).toBe('16')
  })

  it('reads an emptied box as “back to auto”', () => {
    const changes: Array<[string, number | null]> = []
    const key = new MapKey({ onChange: (bound, value) => changes.push([bound, value]) })
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const lo = key.el.querySelector('.is-lo') as HTMLElement
    lo.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = lo.querySelector('input') as HTMLInputElement
    input.value = '   '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(changes).toEqual([['lo', null]])
  })

  it('abandons the edit on Escape', () => {
    const changes: Array<[string, number | null]> = []
    const key = new MapKey({ onChange: (bound, value) => changes.push([bound, value]) })
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const lo = key.el.querySelector('.is-lo') as HTMLElement
    lo.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = lo.querySelector('input') as HTMLInputElement
    input.value = '-9'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(changes).toEqual([])
    expect(lo.textContent).toBe('0.125')
  })

  it('does not rewrite a bound the reader has a caret in', () => {
    const key = new MapKey({ onChange: () => {} })
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const hi = key.el.querySelector('.is-hi') as HTMLElement
    hi.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    key.set({ ...CONTENT, hiLabel: '32', hi: 5 })
    expect(hi.querySelector('input')?.value).toBe('4')
  })

  it('keeps the map from reading a keystroke aimed at the box', () => {
    const key = new MapKey({ onChange: () => {} })
    document.body.appendChild(key.el)
    key.set(CONTENT)
    const seen: string[] = []
    document.body.addEventListener('keydown', (event) => seen.push(event.key))
    const hi = key.el.querySelector('.is-hi') as HTMLElement
    hi.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const input = hi.querySelector('input') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))
    // `f` fits the map. A caret in a legend is not a gesture on the picture.
    expect(seen).toEqual([])
  })
})

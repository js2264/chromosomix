/**
 * The key in the corner of a map, as DOM: a title, two swatches, two numbers.
 *
 * DOM and not a canvas, and the two numbers are why. A colourbar's ticks are a
 * picture of a scale; these are the *bounds the reader set*, and a reader who
 * can read a bound off a legend will try to change it there — so they are
 * buttons, and clicking one puts a caret in it. A canvas cannot hold a caret,
 * and a legend the reader has to go and find a distant pair of boxes for is a
 * legend they read and then hunt from.
 *
 * Everything about *what* it says is {@link KeyContent}'s; this decides only
 * how it behaves. The export draws the same content with `drawKey`.
 */

import type { KeyContent } from '../render/legend'
import { el } from './dom'

export interface MapKeyProps {
  /**
   * A bound was typed, in transformed units, or `null` to hand it back to auto.
   *
   * Absent on a panel whose scale is not the reader's to set — the second
   * file's key in a comparison describes numbers derived from the first's clip
   * and a caret in it would be a control over nothing.
   */
  onChange?(bound: 'lo' | 'hi', value: number | null): void
}

export class MapKey {
  readonly el: HTMLElement
  private readonly titleEl = el('span', { class: 'map-key-title' })
  private readonly noteEl = el('span', { class: 'map-key-note' })
  private readonly loEl: HTMLElement
  private readonly hiEl: HTMLElement
  private readonly loSwatch = el('span', { class: 'map-key-swatch' })
  private readonly hiSwatch = el('span', { class: 'map-key-swatch' })
  private content: KeyContent | null = null

  constructor(private readonly props: MapKeyProps = {}) {
    this.loEl = this.bound('lo')
    this.hiEl = this.bound('hi')
    this.el = el(
      'div',
      { class: 'map-key' },
      this.titleEl,
      this.noteEl,
      el(
        'div',
        { class: 'map-key-row' },
        this.loEl,
        el('span', { class: 'map-key-ramp' }, this.loSwatch, this.hiSwatch),
        this.hiEl,
      ),
    )
  }

  set(content: KeyContent): void {
    this.content = content
    this.titleEl.textContent = content.title
    this.titleEl.title = content.title
    const note = content.note ?? ''
    this.noteEl.textContent = note
    this.noteEl.title = note === '' ? '' : `One square of this map covers ${note}.`
    // Hidden rather than emptied, so the key does not keep a blank line's worth
    // of height on a block that has no resolution to report.
    this.noteEl.classList.toggle('hidden', note === '')
    this.loSwatch.style.background = content.loColor
    this.hiSwatch.style.background = content.hiColor
    // Not while a caret is in it: the panel repaints on every frame of a drag
    // over the map, and rewriting the box under a reader mid-number is the one
    // way an editable legend is worse than a printed one.
    if (this.loEl.querySelector('input') === null) this.loEl.textContent = content.loLabel
    if (this.hiEl.querySelector('input') === null) this.hiEl.textContent = content.hiLabel
  }

  private bound(which: 'lo' | 'hi'): HTMLElement {
    const onChange = this.props.onChange
    const node = el('span', {
      class: `map-key-value is-${which}`,
      ...(onChange === undefined
        ? {}
        : {
            title:
              which === 'lo'
                ? 'Where the colour scale starts, in the units above. Click to set it; empty is auto.'
                : 'Where the colour scale saturates, in the units above. Click to set it; empty is auto.',
            attrs: { tabindex: '0', role: 'button' },
          }),
    })
    if (onChange === undefined) return node

    const open = (): void => {
      if (node.querySelector('input') !== null) return
      const held = which === 'lo' ? this.content?.lo : this.content?.hi
      const input = el('input', {
        class: 'map-key-input',
        type: 'text',
        value: held === undefined ? '' : String(held),
      })
      // A flag rather than a DOM test, because the two ways out of the box fire
      // *inside each other*: taking the input away on Enter blurs it, the blur
      // handler commits a second time, and the second `replaceChildren` runs
      // while the first is still unwinding — which throws, and the throw left
      // the box empty where the number should have gone back.
      let closed = false
      const commit = (apply: boolean): void => {
        if (closed) return
        closed = true
        const raw = input.value.trim()
        node.replaceChildren()
        if (this.content !== null) {
          node.textContent = which === 'lo' ? this.content.loLabel : this.content.hiLabel
        }
        if (!apply) return
        // An empty box is "auto", the same thing the clip card's own button
        // means, so a reader can undo a bound where they set it rather than
        // having to find the control they were avoiding.
        const value = raw === '' ? null : Number(raw)
        if (value === null || Number.isFinite(value)) onChange(which, value)
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit(true)
        if (event.key === 'Escape') commit(false)
        // The map beneath reads every key it is given — `f` fits, arrows pan —
        // and a caret in a legend is not a gesture on the picture.
        event.stopPropagation()
      })
      input.addEventListener('blur', () => commit(true))
      // The map takes a pointer down as the start of a pan.
      input.addEventListener('pointerdown', (event) => event.stopPropagation())
      node.replaceChildren(input)
      input.focus()
      input.select()
    }

    node.addEventListener('click', (event) => {
      event.stopPropagation()
      open()
    })
    node.addEventListener('pointerdown', (event) => event.stopPropagation())
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })
    return node
  }
}

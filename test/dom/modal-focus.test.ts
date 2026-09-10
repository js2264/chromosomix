// @vitest-environment jsdom
/**
 * What `aria-modal="true"` promises, and what `Modal` had to be taught to keep.
 *
 * `<dialog>.showModal()` was refused for its backdrop and its close behaviour
 * (`ui/Modal.ts`), and the third thing it brings went with it unnoticed:
 * containment. The panel said it was modal, and Tab walked straight out of it —
 * onto a session tab's ✕ or a panel fold button behind the dimmed backdrop,
 * where Enter fires them under a dialog the reader is still looking at and
 * cannot see the effect through. A screen reader got the mirror image: told by
 * `aria-modal` that the rest of the page was inert, over a DOM that was fully
 * exposed and fully operable.
 *
 * Two halves, both asserted here. `inert` on everything the backdrop covers is
 * what a browser acts on; the Tab branch is what does not depend on the browser
 * having `inert`, and — jsdom implementing neither `inert` nor sequential focus
 * navigation — is the half these cases can actually watch move.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Modal } from '@/ui/Modal'
import { el } from '@/ui/dom'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const open: Modal[] = []

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  for (const modal of open.splice(0, open.length)) modal.close()
  teardown()
})

/** A control of the app, behind whatever dialog opens next. */
function background(label: string): HTMLButtonElement {
  const node = el('button', { text: label })
  document.body.appendChild(node)
  return node
}

/** A dialog whose body holds two stops, so first and last are distinguishable. */
function dialog(): { modal: Modal; stops: HTMLElement[] } {
  const modal = new Modal({
    title: 'Shortcuts',
    body: () => el('div', {}, el('input', { type: 'text' }), el('button', { text: 'Run' })),
  })
  open.push(modal)
  // The last panel, not the first: two dialogs can be up at once and the one
  // just built is the one on top.
  const panels = all<HTMLElement>(document.body, '.modal-panel')
  return { modal, stops: all<HTMLElement>(panels[panels.length - 1], 'input, button') }
}

/** Press Tab, and say whether the browser's own move was refused. */
function tab(shift = false): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('the caret while a dialog is up', () => {
  it('wraps from the last stop back to the first', () => {
    const { stops } = dialog()
    const last = stops[stops.length - 1]
    last.focus()
    expect(tab()).toBe(true)
    expect(document.activeElement).toBe(stops[0])
  })

  it('wraps backwards from the first stop to the last', () => {
    const { stops } = dialog()
    stops[0].focus()
    expect(tab(true)).toBe(true)
    expect(document.activeElement).toBe(stops[stops.length - 1])
  })

  it('is pulled back in when it is somewhere behind the backdrop', () => {
    const behind = background('Close this session')
    const { stops } = dialog()
    // However it got there — a click, or a browser that moved it before this
    // handler existed — the next Tab brings it home rather than continuing
    // along the page.
    behind.focus()
    expect(document.activeElement).toBe(behind)
    expect(tab()).toBe(true)
    expect(document.activeElement).toBe(stops[0])
  })

  it('is answered by the dialog on top when two are up', () => {
    dialog()
    const inner = dialog()
    inner.stops[0].focus()
    // Mid-panel, so the press belongs to the browser. Every open dialog is
    // listening on the window: if the outer one answered too it would see a
    // caret outside *its* panel, take the press, and pull it away — and the
    // caret would sit on the inner dialog's first stop for ever, however many
    // times Tab was pressed.
    expect(tab()).toBe(false)
    expect(document.activeElement).toBe(inner.stops[0])
  })

  it('moves on through the panel without interfering in the middle', () => {
    const { stops } = dialog()
    stops[0].focus()
    // Not the last stop, so the browser's own Tab is left to do its work.
    expect(tab()).toBe(false)
  })
})

describe('the page behind the backdrop', () => {
  it('is inert while the dialog is up, and operable again after', () => {
    const behind = background('Close this session')
    const { modal } = dialog()
    expect(behind.hasAttribute('inert')).toBe(true)
    modal.close()
    expect(behind.hasAttribute('inert')).toBe(false)
  })

  it('does not include the dialog itself', () => {
    dialog()
    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement
    expect(backdrop.hasAttribute('inert')).toBe(false)
  })

  it('gets the caret back on close, which an inert subtree would refuse', () => {
    const opener = background('Share this session as a link')
    opener.focus()
    const { modal } = dialog()
    expect(document.activeElement).not.toBe(opener)
    modal.close()
    // The order in `close` is what this pins: cleared first, focused second.
    expect(document.activeElement).toBe(opener)
  })

  it('stays inert under the outer dialog when an inner one closes', () => {
    const behind = background('Close this session')
    const outer = dialog()
    const inner = dialog()
    expect(behind.hasAttribute('inert')).toBe(true)
    inner.modal.close()
    // The inner dialog puts back only what it took, so the page is still the
    // outer dialog's to hold.
    expect(behind.hasAttribute('inert')).toBe(true)
    outer.modal.close()
    expect(behind.hasAttribute('inert')).toBe(false)
  })
})

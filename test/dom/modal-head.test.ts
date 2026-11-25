// @vitest-environment jsdom
/**
 * A dialog's head that carries controls (`ModalProps.head`, SPECS §33.3).
 *
 * A stage on the whole window keeps its tools in its title bar rather than in
 * a row of their own under it: the caller's `centre` in the middle of the bar,
 * its `end` before the ✕. A dialog that asks for neither keeps the head it had
 * — the title and the ✕, nothing between. Where the bar cannot hold the
 * title's first words beside the centre and the end, the centre goes on a line
 * of its own under them (`is-stacked`), measured by the modal on the head's
 * every resize — jsdom lays nothing out, so the widths are given here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '@/ui/Modal'
import { el } from '@/ui/dom'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const open: Modal[] = []

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  for (const modal of open.splice(0, open.length)) modal.close()
  vi.unstubAllGlobals()
  teardown()
})

function dialog(head?: { centre?: HTMLElement; end?: HTMLElement }, onClose?: () => void): HTMLElement {
  const modal = new Modal({
    title: 'Curate the genomes · MM133.metacool',
    titleIsName: true,
    ...(head === undefined ? {} : { head }),
    body: () => el('div', {}, el('input', { type: 'text' })),
    ...(onClose === undefined ? {} : { onClose }),
  })
  open.push(modal)
  return document.querySelector('.modal-head') as HTMLElement
}

const classes = (node: Element): string[] => [...node.children].map((child) => child.className)

describe('a dialog’s head', () => {
  it('is the title and the ✕ alone where the dialog asks for no controls', () => {
    const head = dialog()
    expect(classes(head)).toEqual(['modal-title is-name', 'btn-close'])
    expect(head.classList.contains('has-centre')).toBe(false)
    // Never cut short, so no title of its own.
    expect(head.querySelector('.modal-title')?.hasAttribute('title')).toBe(false)
  })

  it('sets the end before the ✕, and the centre between the title and the end', () => {
    const tabs = el('div', { class: 'tabs' }, el('button', { text: 'contacts' }))
    const tools = el('div', { class: 'tools' }, el('button', { text: 'tidy' }))
    const head = dialog({ centre: tabs, end: tools })
    expect(head.classList.contains('has-centre')).toBe(true)
    expect(classes(head)).toEqual(['modal-title is-name', 'modal-head-centre', 'modal-head-end'])
    // Moved in as they are, never built again.
    expect(head.querySelector('.modal-head-centre')?.firstElementChild).toBe(tabs)
    expect(classes(head.querySelector('.modal-head-end') as HTMLElement)).toEqual(['tools', 'btn-close'])
    expect(head.querySelector('.modal-title')?.getAttribute('title')).toBe('Curate the genomes · MM133.metacool')
    // The body's first control has the caret, not the bar's.
    expect(document.activeElement?.tagName).toBe('INPUT')
  })

  it('carries an end alone with no centre, in the head it had', () => {
    const head = dialog({ end: el('div', { class: 'tools' }) })
    expect(head.classList.contains('has-centre')).toBe(false)
    expect(classes(head)).toEqual(['modal-title is-name', 'modal-head-end'])
  })

  it('closes from its ✕ among the controls', () => {
    let closed = 0
    const head = dialog({ centre: el('div'), end: el('div') }, () => closed++)
    ;(head.querySelector('.btn-close') as HTMLButtonElement).click()
    expect(closed).toBe(1)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('puts the centre under the title where the bar is too narrow for the three, and back on one line when it widens', () => {
    const observers: Array<{ fit: () => void; disconnected: boolean }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: { fit: () => void; disconnected: boolean }
        constructor(fit: () => void) {
          this.entry = { fit, disconnected: false }
          observers.push(this.entry)
        }
        observe(): void {}
        disconnect(): void {
          this.entry.disconnected = true
        }
      },
    )
    const tabs = el('div')
    const tools = el('div')
    const head = dialog({ centre: tabs, end: tools })
    expect(observers).toHaveLength(1)
    const tail = head.querySelector('.modal-head-end') as HTMLElement
    const width = (node: HTMLElement, key: 'offsetWidth' | 'clientWidth', value: number): void => {
      Object.defineProperty(node, key, { configurable: true, value })
    }
    width(tabs, 'offsetWidth', 300)
    width(tail, 'offsetWidth', 260)
    const title = head.querySelector('.modal-title') as HTMLElement
    title.style.fontSize = '16px'
    // Twelve of the title's ems, the tabs and the end: 752 px.
    width(head, 'clientWidth', 1000)
    observers[0].fit()
    expect(head.classList.contains('is-stacked')).toBe(false)
    width(head, 'clientWidth', 700)
    observers[0].fit()
    expect(head.classList.contains('is-stacked')).toBe(true)
    width(head, 'clientWidth', 1000)
    observers[0].fit()
    expect(head.classList.contains('is-stacked')).toBe(false)
    // Before it is laid out, it is left as it is.
    width(head, 'clientWidth', 0)
    observers[0].fit()
    expect(head.classList.contains('is-stacked')).toBe(false)
    open.splice(0, 1)[0].close()
    expect(observers[0].disconnected).toBe(true)
  })

  it('watches no head that has no centre', () => {
    const made: unknown[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          made.push(this)
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    dialog({ end: el('div') })
    dialog()
    expect(made).toHaveLength(0)
  })
})

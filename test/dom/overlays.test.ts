// @vitest-environment jsdom
/**
 * The two things that open over everything else, and how they close.
 *
 * A `Modal` and a context `Menu` are the only surfaces in this application that
 * take the top of the screen, and closing is the whole of what is hard about
 * them. Both were written once for that reason — the comment on `Menu` puts it
 * plainly: a second menu beside the first is a second set of answers to "how
 * does this close", and the one that gets it wrong is the one left open behind a
 * dialog.
 *
 * So this file is mostly about dismissal. Escape, a click outside, a scroll
 * under a menu positioned against the viewport, and — for the modal — the one
 * that is politeness in most applications and not here: focus goes back where it
 * was, because the palette is opened from the keyboard and a keyboard user who
 * closes it should still be where they were.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { el } from '@/ui/dom'
import { Modal } from '@/ui/Modal'
import { closeMenu, openMenu } from '@/ui/Menu'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  closeMenu()
  teardown()
})

function escape(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

/** A frame, so the menu's deferred outside-click listener is armed. */
function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

describe('a modal', () => {
  function open(onClose?: () => void): { modal: Modal; closes: number } {
    const state = { closes: 0 }
    const modal = new Modal({
      title: 'Open a file',
      body: (close) => {
        const node = document.createElement('div')
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = 'cancel'
        button.addEventListener('click', close)
        node.appendChild(button)
        return node
      },
      onClose: () => {
        state.closes++
        onClose?.()
      },
    })
    return { modal, closes: state.closes }
  }

  it('mounts a backdrop with one titled panel in it', () => {
    open()
    const backdrop = document.querySelector('.modal-backdrop')
    expect(backdrop).not.toBeNull()
    expect(textsOf(document.body, '.modal-title')).toEqual(['Open a file'])
    expect(document.querySelector('.modal-panel')?.getAttribute('aria-modal')).toBe('true')
    expect(document.querySelector('.modal-panel')?.getAttribute('role')).toBe('dialog')
  })

  it('takes the caret to the first thing in it', () => {
    open()
    expect((document.activeElement as HTMLElement).tagName).toBe('BUTTON')
  })

  it('takes it to the body’s control and not to the close button', () => {
    open()
    const active = document.activeElement as HTMLElement
    // A selector list answers in document order, and the ✕ is in the header —
    // so "the first focusable in the panel" was always Close, on every dialog,
    // and Enter dismissed the dialog instead of submitting it.
    expect(active.classList.contains('btn-close')).toBe(false)
    expect(active.textContent).toBe('cancel')
  })

  it('leaves on Escape', () => {
    const { modal } = open()
    escape()
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    modal.close()
  })

  it('leaves on a click on the backdrop', () => {
    open()
    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('stays for a press inside the panel, or selecting text would dismiss it', () => {
    open()
    const panel = document.querySelector('.modal-panel') as HTMLElement
    panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(document.querySelector('.modal-backdrop')).not.toBeNull()
  })

  it('leaves by its own close button', () => {
    open()
    document.querySelector<HTMLButtonElement>('.btn-close')?.click()
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('leaves by whatever its body wired up', () => {
    open()
    buttonNamed(document.body, 'cancel')?.click()
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('tells the opener once, however many times it is closed', () => {
    let closes = 0
    const modal = new Modal({
      title: 'x',
      body: () => document.createElement('div'),
      onClose: () => {
        closes++
      },
    })
    modal.close()
    modal.close()
    escape()
    expect(closes).toBe(1)
  })

  it('answers no key once it has gone', () => {
    const modal = new Modal({ title: 'x', body: () => document.createElement('div') })
    modal.close()
    const before = document.body.childElementCount
    escape()
    expect(document.body.childElementCount).toBe(before)
  })

  it('gives focus back to whatever had it', () => {
    const opener = el('button', {})
    opener.textContent = 'open'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const modal = new Modal({
      title: 'x',
      body: () => {
        const node = document.createElement('div')
        node.appendChild(document.createElement('input'))
        return node
      },
    })
    expect((document.activeElement as HTMLElement).tagName).toBe('INPUT')
    modal.close()
    expect(document.activeElement).toBe(opener)
  })
})

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

describe('a context menu', () => {
  it('draws a button per item and a heading for a row that does not act', () => {
    openMenu(10, 10, [
      { label: 'Marks' },
      { label: 'Place a mark', run: () => {} },
      { label: 'Clear marks', run: () => {} },
    ])
    expect(textsOf(document.body, '.context-menu-head')).toEqual(['Marks'])
    expect(all(document.body, '.crumb-menu-item')).toHaveLength(2)
  })

  it('opens nothing at all for an empty list', () => {
    openMenu(10, 10, [])
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('runs the item that was clicked, and closes', () => {
    const ran: string[] = []
    openMenu(10, 10, [{ label: 'Place a mark', run: () => ran.push('mark') }])
    document.querySelector<HTMLButtonElement>('.crumb-menu-item')?.click()
    expect(ran).toEqual(['mark'])
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('greys a disabled row rather than dropping it', () => {
    openMenu(10, 10, [{ label: 'Copy region', run: () => {}, disabled: true }])
    const item = document.querySelector<HTMLButtonElement>('.crumb-menu-item')
    expect(item?.disabled).toBe(true)
    expect(item?.classList.contains('disabled')).toBe(true)
  })

  it('shows a hint beside the label where the label is not the whole answer', () => {
    openMenu(10, 10, [{ label: 'Balance', hint: 'needs /bins/weight', run: () => {} }])
    expect(textsOf(document.body, '.context-menu-hint')).toEqual(['needs /bins/weight'])
    expect(document.querySelector<HTMLButtonElement>('.crumb-menu-item')?.title).toBe(
      'needs /bins/weight',
    )
  })

  it('is nudged back inside the window rather than hanging off it', () => {
    openMenu(1e6, 1e6, [{ label: 'Place a mark', run: () => {} }])
    const menu = document.querySelector<HTMLElement>('.context-menu')
    // jsdom measures nothing, so the box is 0×0 and the clamp lands on the
    // window's own edge — which is the arithmetic being checked.
    expect(menu?.style.left).toBe(`${window.innerWidth - 4}px`)
    expect(menu?.style.top).toBe(`${window.innerHeight - 4}px`)
  })

  it('never opens off the top or left either', () => {
    openMenu(-500, -500, [{ label: 'Place a mark', run: () => {} }])
    const menu = document.querySelector<HTMLElement>('.context-menu')
    expect(menu?.style.left).toBe('4px')
    expect(menu?.style.top).toBe('4px')
  })

  it('closes on Escape', () => {
    openMenu(10, 10, [{ label: 'Place a mark', run: () => {} }])
    escape()
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('closes on a scroll, because it is positioned against the viewport', () => {
    openMenu(10, 10, [{ label: 'Place a mark', run: () => {} }])
    window.dispatchEvent(new Event('scroll'))
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('closes on a resize', () => {
    openMenu(10, 10, [{ label: 'Place a mark', run: () => {} }])
    window.dispatchEvent(new Event('resize'))
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('survives the click that opened it', async () => {
    openMenu(10, 10, [{ label: 'Place a mark', run: () => {} }])
    // Same tick: this is the press that opened the menu, and a `once` listener
    // added now would eat it.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.context-menu')).not.toBeNull()
    await frame()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('replaces whatever was open rather than stacking', () => {
    openMenu(10, 10, [{ label: 'first', run: () => {} }])
    openMenu(20, 20, [{ label: 'second', run: () => {} }])
    expect(all(document.body, '.context-menu')).toHaveLength(1)
    expect(textsOf(document.body, '.crumb-menu-item')).toEqual(['second'])
  })

  it('can be closed by anybody, including when none is open', () => {
    expect(() => closeMenu()).not.toThrow()
    openMenu(10, 10, [{ label: 'first', run: () => {} }])
    closeMenu()
    expect(document.querySelector('.context-menu')).toBeNull()
    expect(() => closeMenu()).not.toThrow()
  })
})

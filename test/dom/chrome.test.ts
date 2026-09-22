// @vitest-environment jsdom
/**
 * The four small pieces of furniture every view borrows.
 *
 * A context menu, a modal, the `‹ ›` pair beside a heading and the theme toggle
 * are each a few dozen lines, and each is a few dozen lines that decide something
 * a reader would notice at once if it were wrong: whether a menu closes, whether
 * a dialog gives the keyboard back, whether a disabled step button says *why* it
 * is disabled, whether choosing "system" leaves the document with no override on
 * it rather than with the wrong one.
 *
 * None of them had a test. They are the kind of code that is read once, believed,
 * and then quietly grows a second way out that does not undo the first.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetMounting } from '@/embed'
import { closeMenu, openMenu } from '@/ui/Menu'
import { Modal } from '@/ui/Modal'
import { stepper } from '@/ui/Stepper'
import { applyTheme, initTheme, ThemeToggle } from '@/ui/ThemeToggle'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  closeMenu()
  teardown()
})

/** `openMenu` waits a frame before it will close on a click. */
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

const menu = (): HTMLElement | null => document.querySelector('.context-menu')

describe('the context menu', () => {
  it('draws a row per item, and a heading for one with nothing to run', () => {
    openMenu(10, 10, [
      { label: 'Marks' },
      { label: 'Place a mark', run: () => {} },
      { label: 'Clear', run: () => {}, disabled: true },
    ])
    expect(textsOf(document.body, '.context-menu-head')).toEqual(['Marks'])
    expect(all(document.body, '.crumb-menu-item')).toHaveLength(2)
    // A heading is not a button, so it cannot be tabbed to or pressed.
    expect(all(document.body, '.context-menu-head button')).toHaveLength(0)
  })

  it('runs an item and closes, once', () => {
    let ran = 0
    openMenu(10, 10, [{ label: 'Place a mark', run: () => ran++ }])
    all<HTMLButtonElement>(document.body, '.crumb-menu-item')[0].click()
    expect(ran).toBe(1)
    expect(menu()).toBeNull()
  })

  it('will not run a disabled item', () => {
    let ran = 0
    openMenu(10, 10, [{ label: 'Clear', run: () => ran++, disabled: true }])
    const item = all<HTMLButtonElement>(document.body, '.crumb-menu-item')[0]
    expect(item.disabled).toBe(true)
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ran).toBe(0)
    expect(menu()).not.toBeNull()
  })

  it('opens nothing for an empty list', () => {
    openMenu(10, 10, [])
    expect(menu()).toBeNull()
  })

  it('replaces the menu that was up rather than stacking a second one', () => {
    openMenu(10, 10, [{ label: 'one', run: () => {} }])
    openMenu(20, 20, [{ label: 'two', run: () => {} }])
    expect(all(document.body, '.context-menu')).toHaveLength(1)
    expect(textsOf(document.body, '.crumb-menu-item')).toEqual(['two'])
  })

  it('closes on Escape, on a scroll, and on the next click', async () => {
    openMenu(10, 10, [{ label: 'one', run: () => {} }])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(menu()).toBeNull()

    openMenu(10, 10, [{ label: 'one', run: () => {} }])
    window.dispatchEvent(new Event('scroll'))
    expect(menu()).toBeNull()

    openMenu(10, 10, [{ label: 'one', run: () => {} }])
    // Not on the click that opened it: the listener goes on a frame later, which
    // is what lets the pointer come up first.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(menu()).not.toBeNull()
    await frame()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(menu()).toBeNull()
  })

  it('nudges itself back inside the window rather than hanging off it', () => {
    openMenu(99_999, 99_999, [{ label: 'one', run: () => {} }])
    const node = menu() as HTMLElement
    expect(Number.parseFloat(node.style.left)).toBeLessThanOrEqual(window.innerWidth)
    expect(Number.parseFloat(node.style.top)).toBeLessThanOrEqual(window.innerHeight)
    // …and never off the other edge either.
    openMenu(-500, -500, [{ label: 'one', run: () => {} }])
    expect((menu() as HTMLElement).style.left).toBe('4px')
    expect((menu() as HTMLElement).style.top).toBe('4px')
  })

  it('is safe to close when none is open', () => {
    expect(() => closeMenu()).not.toThrow()
  })
})

describe('the modal', () => {
  const open = (body?: (close: () => void) => HTMLElement): { modal: Modal; closed: number } => {
    let closed = 0
    const modal = new Modal({
      title: 'Shortcuts',
      body: body ?? ((): HTMLElement => document.createElement('p')),
      onClose: () => {
        closed++
      },
    })
    return {
      modal,
      get closed() {
        return closed
      },
    }
  }

  it('mounts a labelled dialog with a close button', () => {
    const { modal } = open()
    const panel = document.querySelector('.modal-panel')
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-modal')).toBe('true')
    expect(panel?.querySelector('.modal-title')?.textContent).toBe('Shortcuts')
    modal.close()
  })

  it('closes on Escape, and tells the opener once', () => {
    const opened = open()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(opened.closed).toBe(1)
    // A second close is a no-op rather than a second notification.
    opened.modal.close()
    expect(opened.closed).toBe(1)
  })

  it('closes on the backdrop but not on the panel', () => {
    open()
    const panel = document.querySelector('.modal-panel') as HTMLElement
    panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(document.querySelector('.modal-backdrop')).not.toBeNull()
    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('gives the keyboard back to whatever had it', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { modal } = open((): HTMLElement => {
      const input = document.createElement('input')
      return input
    })
    // The first focusable thing in the panel takes the caret…
    expect(document.activeElement).not.toBe(opener)
    modal.close()
    // …and it goes back where it came from, because the palette is opened from
    // the keyboard and a keyboard user should still be where they were.
    expect(document.activeElement).toBe(opener)
  })

  it('stops listening for Escape once it is gone', () => {
    const opened = open()
    opened.modal.close()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(opened.closed).toBe(1)
  })
})

describe('the stepper', () => {
  it('names the neighbour it would open', () => {
    const node = stepper({ neighbours: { prev: 'MAG_01', next: 'MAG_03' }, noun: 'genome', onStep: () => {} })
    const [prev, next] = all<HTMLButtonElement>(node, 'button')
    // The key that does the same thing, because a tooltip is where a reader
    // who is already pointing at the button discovers there is a faster way.
    expect(prev.title).toBe('Previous genome: MAG_01 ([)')
    expect(next.title).toBe('Next genome: MAG_03 (])')
    expect(prev.disabled).toBe(false)
  })

  it('says why it is dead at either end, rather than just being dead', () => {
    const node = stepper({ neighbours: { prev: null, next: 'MAG_02' }, noun: 'contig', onStep: () => {} })
    const [prev, next] = all<HTMLButtonElement>(node, 'button')
    expect(prev.disabled).toBe(true)
    // No key on the dead end: there is nothing for it to reach.
    expect(prev.title).toBe('No previous contig')
    expect(next.disabled).toBe(false)
  })

  it('steps in the direction it was pressed', () => {
    const steps: number[] = []
    const node = stepper({
      neighbours: { prev: 'a', next: 'b' },
      noun: 'genome',
      onStep: (delta) => steps.push(delta),
    })
    const [prev, next] = all<HTMLButtonElement>(node, 'button')
    next.click()
    prev.click()
    expect(steps).toEqual([1, -1])
  })
})

describe('the theme toggle', () => {
  // The cycle is ordered against the machine's own scheme, and this environment
  // reports a light one, so the first press is the one that *changes the page*.
  // It used to be `system → light → dark`, which on a light OS spent the first
  // press on a choice that repainted nothing — see `ui/ThemeToggle.next`.
  it('cycles system → dark → light → system on a light machine', () => {
    const toggle = new ThemeToggle()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    toggle.el.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    toggle.el.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    toggle.el.click()
    // "System" is the *absence* of an override, so that one stylesheet answers
    // `prefers-color-scheme` rather than a third palette existing.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('says what it is and what the press would do', () => {
    const toggle = new ThemeToggle()
    expect(toggle.el.title).toContain('Theme: system')
    expect(toggle.el.title).toContain('Click for dark')
    // The accessible *name*, not only the description: a screen reader
    // announcing the constant "colour theme" three times never said the state.
    expect(toggle.el.getAttribute('aria-label')).toBe(toggle.el.title)
    expect(toggle.el.querySelector('svg')).not.toBeNull()
  })

  it('is a preference, so it outlives the toggle that set it', () => {
    new ThemeToggle().el.click()
    applyTheme('system')
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('reads an unknown stored value as system rather than writing it out', () => {
    window.localStorage.setItem('metacooler-viewer:theme', 'sepia')
    expect(initTheme()).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('the theme toggle, embedded', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    resetMounting()
  })

  it('is fixed to light on startup, over a stored dark preference and the system one', () => {
    window.localStorage.setItem('metacooler-viewer:theme', 'dark')
    window.history.replaceState(null, '', '/?embed=1')
    resetMounting()
    expect(initTheme()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('ignores a click, so the "theme" command cannot flip a published figure dark', () => {
    // The button this drives is never mounted in an embed's own bar
    // (`app/App.ts`), but the command palette's "theme" entry still runs
    // there like every other bound command — this is what keeps that path a
    // no-op instead of a second way to reach the toggle.
    window.history.replaceState(null, '', '/?embed=1')
    resetMounting()
    const toggle = new ThemeToggle()
    toggle.el.click()
    toggle.el.click()
    toggle.el.click()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

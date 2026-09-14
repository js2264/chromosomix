// @vitest-environment jsdom
/**
 * The store drawer on its key.
 *
 * Backslash folds the drawer out and back, the way backtick does the console:
 * a panel at the window's edge on a punctuation key, so it cannot collide with
 * the letters the views are driven by. The one thing worth pinning beyond
 * "it toggles" is that a backslash typed into a box stays a backslash — the
 * drawer's own search field included.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import { KEYS } from '@/ui/commands'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

afterEach(() => {
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

function press(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('the backslash', () => {
  it('opens the drawer, closes it again, and is left alone while typing', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    new App(root)
    const drawer = document.querySelector('.store-drawer') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(KEYS.stores).toBe('\\')
    expect(drawer.classList.contains('collapsed')).toBe(true)

    press(window, '\\')
    expect(drawer.classList.contains('collapsed')).toBe(false)

    // A backslash typed into a box is text, not a command.
    const box = document.createElement('input')
    document.body.appendChild(box)
    box.focus()
    press(box, '\\')
    expect(drawer.classList.contains('collapsed')).toBe(false)
    box.blur()

    press(window, '\\')
    expect(drawer.classList.contains('collapsed')).toBe(true)
  })

  it('is printed on the header button and listed with the command', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    new App(root)
    const toggle = document.querySelector('.head-files button[aria-label="stores"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.title).toContain('\\')
    // The two doors that used to stand beside it are gone: a place is connected
    // from the Files column, a file is added from the file crumb or by dropping.
    expect(document.querySelector('.head-files button[aria-label^="Connect a place"]')).toBeNull()
    expect(document.querySelector('.head-files button[aria-label^="Add a file"]')).toBeNull()
  })
})

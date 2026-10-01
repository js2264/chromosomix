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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import { KEYS, type Command } from '@/ui/commands'
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
    const app = new App(root) as unknown as { commands(): Command[] }
    const toggle = document.querySelector('.head-files button[aria-label="stores"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.title).toContain('\\')
    expect(app.commands().find((command) => command.keys === KEYS.stores)?.title).toBe('Stores')
    // The two doors that used to stand beside it are gone: a place is connected
    // from the Files column, a file is added from the file crumb or by dropping.
    expect(document.querySelector('.head-files button[aria-label^="Connect a place"]')).toBeNull()
    expect(document.querySelector('.head-files button[aria-label^="Add a file"]')).toBeNull()
  })
})

/**
 * The single file has no network (§19), so it has no drawer — and nothing that
 * reaches for one. It used to build the drawer all the same: a button in the
 * header, the backslash and a row in the palette, each opening a catalogue the
 * build could not read, and a `?store=` link that went and tried.
 */
describe('in the single-file build', () => {
  afterEach(() => {
    vi.doUnmock('@/version')
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  /** A window of the standalone build, at an address. */
  async function standalone(search = ''): Promise<{ commands(): Command[] }> {
    window.history.replaceState(null, '', `/${search}`)
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      TARGET: 'standalone',
      IS_STANDALONE: true,
    }))
    const fresh = await import('@/app/App')
    const root = document.createElement('div')
    document.body.appendChild(root)
    return new fresh.App(root) as unknown as { commands(): Command[] }
  }

  it('builds no drawer, and no button in the header for one', async () => {
    await standalone()
    expect(document.querySelector('.store-drawer')).toBeNull()
    expect(document.querySelector('.head-files button[aria-label="stores"]')).toBeNull()
    // The Files column's stays: a folder on this machine is a place this
    // build can reach.
    expect(document.querySelector('.head-files button')).not.toBeNull()
  })

  it('lists no stores in the palette, and binds nothing to the backslash', async () => {
    // The registry the palette and the shortcuts dialog are both printed from.
    const commands = (await standalone()).commands()
    expect(commands.length).toBeGreaterThan(0)
    // Absent rather than greyed: no state of this window opens a store.
    expect(commands.map((command) => command.title)).not.toContain('Stores')
    expect(commands.some((command) => command.keys === KEYS.stores)).toBe(false)
  })

  it('reads nothing for a link naming a store', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', (url: unknown) => {
      asked.push(String(url))
      return Promise.reject(new TypeError('NetworkError when attempting to fetch resource.'))
    })
    await standalone('?store=4dn')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual([])
    expect(document.querySelector('.store-drawer')).toBeNull()
  })
})

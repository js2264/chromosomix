// @vitest-environment jsdom
/**
 * The header's `+` (§5.5): the landing page's *Load files*, in a dialog, from
 * any tab.
 *
 * A tab a file was dropped into has no Files column — nothing is connected — and
 * no landing page any more, so a second file held at an address had no door but
 * the palette. What is pinned: where the button stands, that what it opens is the
 * landing page's first section and nothing else — a drop area that is also the
 * file chooser, and a URL box under it — and that it says what it will do: open,
 * on an empty tab, and add, on one holding a file, in a dialog titled to match.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
/** The windows a test mounted, whose status bars tick until they are stopped. */
const mounted: App[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

afterEach(() => {
  for (const close of all<HTMLButtonElement>(document.body, '.modal-head .btn-close')) close.click()
  // Stopped before the document goes: a status bar's second-by-second tick
  // that outlives it throws into whichever file the worker runs next.
  for (const app of mounted.splice(0)) app['status']?.destroy()
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

function mount(): App {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = new App(root)
  mounted.push(app)
  return app
}

const plus = (): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>('.app-head .head-add')
  if (button === null) throw new Error('the header has no +')
  return button
}

describe('the header’s +', () => {
  it('stands before back, first of the group past the panels', () => {
    mount()
    const group = plus().parentElement
    expect(group?.classList.contains('head-history')).toBe(true)
    expect(group?.firstElementChild).toBe(plus())
    expect(plus().nextElementSibling?.getAttribute('aria-label')).toBe('Go back')
    expect(plus().disabled).toBe(false)
  })

  it('opens the landing page’s first section in a dialog: a drop area that chooses, and a URL box under it', () => {
    mount()
    expect(plus().title).toContain('Open a file in this tab')
    plus().click()
    const dialog = document.querySelector<HTMLElement>('.modal-panel')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('.modal-title')?.textContent).toBe('Open a file')
    const zone = dialog?.querySelector<HTMLElement>('.dropzone')
    expect(zone?.getAttribute('role')).toBe('button')
    expect(zone?.textContent).toContain('or click to choose')
    expect(dialog?.querySelector('.load-or')?.textContent).toBe('or a URL')
    expect(dialog?.querySelector('input.input-url')).not.toBeNull()
    // The section and nothing else: no folders to connect, no stores.
    expect(dialog?.querySelector('.picker-providers, .picker-stores')).toBeNull()
  })

  it('adds, once the tab holds a file — and says so before it is pressed', () => {
    const app = mount()
    const session = app['current']
    if (session === undefined) throw new Error('no tab')
    // A file open, as far as the shell asks: a session tells it so through
    // `sessionChanged`, which is what an open ends in.
    ;(session as unknown as { file: unknown }).file = { uri: 'https://data.example/f.mcool' }
    app['sessionChanged'](session)
    expect(plus().title).toContain('Add a file to this tab')
    expect(plus().getAttribute('aria-label')).toBe(plus().title)
    plus().click()
    expect(document.querySelector('.modal-title')?.textContent).toBe('Add a file to this tab')
  })
})

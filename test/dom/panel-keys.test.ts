// @vitest-environment jsdom
/**
 * The digit row folds the columns, in the order they stand (§16.5).
 *
 * The key left of `1` is Files, then `1` General, `2` Annotations, `3`
 * Aesthetics and `4` Analysis — and each is the key with that digit on it
 * whatever the layout types there: AZERTY's bare `&`, `é`, `"`, `'` are the
 * row as much as QWERTY's `1` to `4` are, with Shift or Caps Lock or without.
 * Control on the key left of `1` is the console. The tab's own keys beside
 * them — `−` and `+`, `<` and `>`, `0` — are reached the same way on every
 * layout, and none of them a second time after a focused control has answered
 * it. What is pinned here is the window's own dispatch, from a real `keydown`,
 * since the matching alone is `test/unit/commands.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { connectSnapshot, disconnectFolder } from '@/browse/connected'
import { resetMounting } from '@/embed'
import type { Command } from '@/ui/commands'
import { resetLayout } from '@/ui/keyboardLayout'
import type { SidePanel } from '@/ui/SidePanel'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let connected: string[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
  resetLayout()
  connected = []
})

afterEach(async () => {
  for (const id of connected) await disconnectFolder(id)
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
  resetLayout()
})

interface Columns {
  filesPanel: SidePanel
  generalPanel: SidePanel
  annotationsPanel: SidePanel
  aestheticsPanel: SidePanel
  analysisPanel: SidePanel
  consolePanel: { isOpen: boolean } | null
}

/** A window whose tab in front is a stand-in with a file, its four columns live. */
function windowWithAFile(commands: Command[] = []): Columns {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = new App(root)
  const stand = {
    hasFile: true,
    isBrowsing: false,
    isMetacool: false,
    panels: { general: true, annotations: true, aesthetics: true, analysis: true },
    commands: () => commands,
    // A fold tells the view in front to re-measure; this one has nothing to.
    relayout: () => {},
  }
  Object.defineProperty(app, 'current', { get: () => stand })
  return app as unknown as Columns
}

function press(init: KeyboardEventInit, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

/** Which of the four are open, General to Analysis. */
const open = (app: Columns): boolean[] =>
  [app.generalPanel, app.annotationsPanel, app.aestheticsPanel, app.analysisPanel].map((panel) => !panel.isCollapsed)

describe('the digit row', () => {
  it('folds the four columns from 1 to 4 on QWERTY', () => {
    const app = windowWithAFile()
    // General and Aesthetics start open; Annotations and Analysis folded.
    expect(open(app)).toEqual([true, false, true, false])
    press({ key: '1', code: 'Digit1' })
    press({ key: '2', code: 'Digit2' })
    press({ key: '3', code: 'Digit3' })
    press({ key: '4', code: 'Digit4' })
    expect(open(app)).toEqual([false, true, false, true])
    // Shift is no different: `!` is the key with the 1 on it.
    press({ key: '!', code: 'Digit1', shiftKey: true })
    expect(open(app)).toEqual([true, true, false, true])
  })

  it('folds them from the same keys on AZERTY, bare, shifted or under Caps Lock', () => {
    const app = windowWithAFile()
    press({ key: '&', code: 'Digit1' })
    press({ key: 'é', code: 'Digit2' })
    press({ key: '"', code: 'Digit3' })
    press({ key: "'", code: 'Digit4' })
    expect(open(app)).toEqual([false, true, false, true])
    press({ key: '1', code: 'Digit1', shiftKey: true })
    press({ key: '2', code: 'Digit2', modifierCapsLock: true } as KeyboardEventInit)
    expect(open(app)).toEqual([true, false, false, true])
  })

  it('is text in a box, and the browser’s with a modifier held', () => {
    const app = windowWithAFile()
    const box = document.createElement('input')
    document.body.appendChild(box)
    box.focus()
    press({ key: '&', code: 'Digit1' }, box)
    press({ key: '1', code: 'Digit1', ctrlKey: true })
    // AltGr on an AZERTY PC, which Windows sends as Ctrl and Alt: `~` on the 2.
    press({ key: '~', code: 'Digit2', ctrlKey: true, altKey: true })
    expect(open(app)).toEqual([true, false, true, false])
  })
})

describe('the key left of 1', () => {
  function connectFolder(name: string): void {
    const folder = connectSnapshot(name, [new File([], 'sample.mcool')])
    connected.push(folder.id)
  }

  it('folds Files while a place is connected, and does nothing while none is', () => {
    const app = windowWithAFile()
    const files = document.querySelector('.panel-files') as HTMLElement
    press({ key: '`', code: 'Backquote' })
    expect(files.classList.contains('is-absent')).toBe(true)

    connectFolder('maps')
    expect(app.filesPanel.isCollapsed).toBe(false)
    // QWERTY's backtick, AZERTY's ², and either with Shift.
    press({ key: '`', code: 'Backquote' })
    expect(app.filesPanel.isCollapsed).toBe(true)
    press({ key: '²', code: 'Backquote' })
    expect(app.filesPanel.isCollapsed).toBe(false)
    press({ key: '~', code: 'Backquote', shiftKey: true })
    expect(app.filesPanel.isCollapsed).toBe(true)
  })

  it('says on the column what the keyboard has there, once it has said', () => {
    windowWithAFile()
    connectFolder('maps')
    const badge = (): string | null | undefined => document.querySelector('.panel-files .panel-column-key')?.textContent
    expect(badge()).toBe('backtick')
    // The reader's first press of it is the answer, and it folds as it answers.
    press({ key: '²', code: 'Backquote' })
    expect(badge()).toBe('²')
  })

  it('opens the console with Control held, and leaves Files where it was', () => {
    const app = windowWithAFile()
    connectFolder('maps')
    expect(app.consolePanel?.isOpen).toBe(false)
    press({ key: '²', code: 'Backquote', ctrlKey: true })
    expect(app.consolePanel?.isOpen).toBe(true)
    expect(app.filesPanel.isCollapsed).toBe(false)
    press({ key: '`', code: 'Backquote', ctrlKey: true })
    expect(app.consolePanel?.isOpen).toBe(false)
  })
})

describe('minus and plus', () => {
  /** A tab in front that answers the two keys, and counts. */
  function counting(): { coarser: number; finer: number } {
    const counts = { coarser: 0, finer: 0 }
    windowWithAFile([
      { id: 'resolution-coarser', group: 'View', title: 'Coarser resolution', keys: '-', run: () => counts.coarser++ },
      { id: 'resolution-finer', group: 'View', title: 'Finer resolution', keys: '+', run: () => counts.finer++ },
    ])
    return counts
  }

  it('reach the tab’s two commands from either half of each key, on QWERTY', () => {
    const counts = counting()
    press({ key: '-', code: 'Minus' })
    press({ key: '_', code: 'Minus', shiftKey: true })
    press({ key: '=', code: 'Equal' })
    press({ key: '+', code: 'Equal', shiftKey: true })
    expect(counts).toEqual({ coarser: 2, finer: 2 })
  })

  it('reach them on an AZERTY PC, whose minus is the 6 key', () => {
    const counts = counting()
    press({ key: '-', code: 'Digit6' })
    press({ key: '6', code: 'Digit6', shiftKey: true })
    press({ key: '6', code: 'Digit6', modifierCapsLock: true } as KeyboardEventInit)
    press({ key: '=', code: 'Equal', modifierCapsLock: true } as KeyboardEventInit)
    press({ key: '+', code: 'Equal', shiftKey: true })
    // …and AZERTY's bare 8, which types `_`, is not one of them.
    press({ key: '_', code: 'Digit8' })
    expect(counts).toEqual({ coarser: 3, finer: 2 })
  })

  it('are the browser’s page zoom with ⌘ or Ctrl', () => {
    const counts = counting()
    press({ key: '-', code: 'Minus', ctrlKey: true })
    press({ key: '=', code: 'Equal', metaKey: true })
    expect(counts).toEqual({ coarser: 0, finer: 0 })
  })
})

describe('the steps, the refit and the shortcuts', () => {
  /** A tab in front that answers `<`, `>` and `0`, and counts; `<` dead when `first`. */
  function counting(first = false): { previous: number; next: number; fit: number } {
    const counts = { previous: 0, next: 0, fit: 0 }
    windowWithAFile([
      {
        id: 'go-prev',
        group: 'Go',
        title: 'Previous sequence',
        keys: '<',
        enabled: !first,
        run: () => counts.previous++,
      },
      { id: 'go-next', group: 'Go', title: 'Next sequence', keys: '>', run: () => counts.next++ },
      { id: 'map-fit', group: 'View', title: 'Fit the view', keys: '0', run: () => counts.fit++ },
    ])
    return counts
  }

  it('step on QWERTY’s comma and full stop, with or without Shift', () => {
    const counts = counting()
    press({ key: ',', code: 'Comma' })
    press({ key: '<', code: 'Comma', shiftKey: true })
    press({ key: '.', code: 'Period' })
    press({ key: '>', code: 'Period', shiftKey: true })
    expect(counts).toEqual({ previous: 2, next: 2, fit: 0 })
  })

  it('step on AZERTY’s own key, and refit on its bare 0, which types à', () => {
    const counts = counting()
    press({ key: '<', code: 'IntlBackslash' })
    press({ key: '>', code: 'IntlBackslash', shiftKey: true })
    press({ key: 'à', code: 'Digit0' })
    press({ key: '0', code: 'Digit0', shiftKey: true })
    // AZERTY's comma and `;` carry no mark.
    press({ key: ',', code: 'KeyM' })
    press({ key: ';', code: 'Comma' })
    expect(counts).toEqual({ previous: 1, next: 1, fit: 2 })
  })

  it('never fold Files from a French Mac’s `<` key, even with nothing before this sequence', () => {
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      let previous = 0
      const app = windowWithAFile([
        { id: 'go-prev', group: 'Go', title: 'Previous sequence', keys: '<', enabled: false, run: () => previous++ },
      ])
      const folder = connectSnapshot('maps', [new File([], 'sample.mcool')])
      connected.push(folder.id)
      expect(app.filesPanel.isCollapsed).toBe(false)
      // The key beside the left Shift, which a French Mac reports as Backquote.
      press({ key: '<', code: 'Backquote' })
      press({ key: '>', code: 'Backquote', shiftKey: true })
      expect(app.filesPanel.isCollapsed).toBe(false)
      expect(previous).toBe(0)
      // Its key left of 1, `@`, is the one that folds it.
      press({ key: '@', code: 'IntlBackslash' })
      expect(app.filesPanel.isCollapsed).toBe(true)
    } finally {
      Object.defineProperty(window.navigator, 'platform', { value: '', configurable: true })
    }
  })

  it('leave a key alone that a focused control has already answered', () => {
    const counts = counting()
    // A picture with keys of its own — a dot plot's canvas — refits on `0`.
    const canvas = document.createElement('canvas')
    canvas.tabIndex = 0
    document.body.appendChild(canvas)
    canvas.addEventListener('keydown', (event) => {
      if (event.key === '0') event.preventDefault()
    })
    press({ key: '0', code: 'Digit0', cancelable: true }, canvas)
    expect(counts.fit).toBe(0)
    // Not cancelable, as every other press here: the windows of the tests above
    // still listen, and the first of them to answer a cancelable one would
    // answer it for this one too.
    press({ key: '0', code: 'Digit0' })
    expect(counts.fit).toBe(1)
  })

  it('open the shortcuts on ?, and leave ? to a box being typed into', () => {
    windowWithAFile()
    const box = document.createElement('input')
    document.body.appendChild(box)
    box.focus()
    press({ key: '?', code: 'Slash', shiftKey: true }, box)
    expect(document.querySelector('.modal-shortcuts')).toBeNull()
    box.blur()
    press({ key: '?', code: 'Slash', shiftKey: true })
    expect(document.querySelector('.modal-shortcuts')).not.toBeNull()
  })

  it('take a Control chord from a box being typed into, as they take ⌘P', () => {
    let tabs = 0
    windowWithAFile([{ id: 'prev-tab', group: 'Go', title: 'Previous tab', keys: 'ctrl+<', run: () => tabs++ }])
    const box = document.createElement('input')
    document.body.appendChild(box)
    box.focus()
    press({ key: '<', code: 'IntlBackslash', ctrlKey: true }, box)
    press({ key: '<', code: 'IntlBackslash' }, box)
    expect(tabs).toBe(1)
  })
})

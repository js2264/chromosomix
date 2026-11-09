// @vitest-environment jsdom
/**
 * When the Files column exists at all (SPECS §16.5, §24.2).
 *
 * It used to be available from the first paint and never withdrawn, and the
 * reason was a good one: its own *connect a local or remote folder* was the only door
 * to a folder, and a door nobody can see is not a door. The landing page now
 * offers the four places itself, so what is left on the first screen is an
 * empty column beside a row of buttons that say the same thing — and §8.5's
 * rule is the one the four columns beside it already follow: a panel with
 * nothing to show leaves altogether.
 *
 * So the column exists **exactly when this window has a place connected**.
 * What the tests below pin is that rule in both directions, and the thing a
 * reader would notice at once if it were wrong — that connecting a folder
 * leaves the column *open* rather than as a tab they have to go and find.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { connectSnapshot, disconnectFolder } from '@/browse/connected'
import { resetMounting } from '@/embed'
import { setUpDom, type DomTeardown, stopsWithTheDom } from '../support/dom'

let teardown: DomTeardown
/** Ids connected by a test, dropped afterwards: the list outlives a window. */
let connected: string[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
  connected = []
})

afterEach(async () => {
  for (const id of connected) await disconnectFolder(id)
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

/** A window, landed on the picker. */
function mount(): void {
  const root = document.createElement('div')
  document.body.appendChild(root)
  stopsWithTheDom(new App(root))
}

const column = (): HTMLElement => document.querySelector('.panel-files') as HTMLElement

/** The header's button for the column, which goes with it. */
const toggle = (): HTMLElement | null =>
  document.querySelector('.head-panels button[title*="Files"], .app-head button[title*="Files"]')

/** Connect a folder the way a browser with no picker does, and remember to drop it. */
function connectFolder(name: string): string {
  const folder = connectSnapshot(name, [new File([], 'sample.mcool')])
  connected.push(folder.id)
  return folder.id
}

describe('the Files column', () => {
  it('is not there when nothing is connected', () => {
    mount()
    expect(column()).not.toBeNull()
    expect(column().classList.contains('is-absent')).toBe(true)
    // The header's button goes with the column: a mark that folds nothing is
    // worse than no mark (`ui/SidePanel.ts`).
    expect(toggle()?.classList.contains('hidden')).toBe(true)
  })

  it('appears, open, the moment a folder is connected', () => {
    mount()
    connectFolder('maps')
    expect(column().classList.contains('is-absent')).toBe(false)
    // Open rather than a folded tab: the column is the answer to the gesture
    // the reader has just made, and answering into a drawer is not answering.
    expect(column().classList.contains('collapsed')).toBe(false)
    expect(toggle()?.classList.contains('hidden')).toBe(false)
  })

  it('goes again when the last folder is disconnected', async () => {
    mount()
    const id = connectFolder('maps')
    expect(column().classList.contains('is-absent')).toBe(false)
    await disconnectFolder(id)
    connected = connected.filter((one) => one !== id)
    expect(column().classList.contains('is-absent')).toBe(true)
  })

  it('stays for a window that already had one connected when it opened', () => {
    // The order a reload takes: the list is there before the window is.
    connectFolder('maps')
    mount()
    expect(column().classList.contains('is-absent')).toBe(false)
  })
})

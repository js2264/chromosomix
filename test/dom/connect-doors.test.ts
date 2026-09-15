// @vitest-environment jsdom
/**
 * The two doors to a place, and the one list behind them (SPECS §24.2, §20).
 *
 * A window connects to four places, and it is offered them twice: as the
 * landing page's *Mount a local or remote folder* buttons, and as the Connect
 * dialog's tiles. Two lists would be two things to keep in step, and the way
 * they would fall out of step is the expensive one — a build that offers a
 * place on one screen and not on the other, or offers it in a different order,
 * so a reader who learnt the row once has not learnt it. `ui/connectFronts.ts`
 * is the one list; these tests pin that both doors read it.
 *
 * They also pin the one place the two are *meant* to differ, which is the
 * reason the list carries `works` at all. Google's OAuth registers an http(s)
 * origin, so the desktop build's `app://viewer` cannot sign in: §8.5 says a
 * control that cannot keep its promise is absent, so the landing page drops
 * that button — while the dialog keeps the tile, because a reader who went
 * looking for Drive is owed the sentence saying why it is not there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

vi.mock('@/auth/google', async () => {
  const actual = await vi.importActual<typeof import('@/auth/google')>('@/auth/google')
  return { ...actual, get GOOGLE_SIGN_IN_AVAILABLE() { return googleSignIn } }
})

/** What this build can do about Google, as the mock above answers it. */
let googleSignIn = true

beforeEach(() => {
  teardown = setUpDom()
  googleSignIn = true
  window.localStorage.clear()
  // A browser that can hold a directory, so the local place is worded the way
  // Chromium and the desktop build word it on both screens.
  vi.stubGlobal('showDirectoryPicker', async () => null)
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
  window.localStorage.clear()
})

/** The landing page's row of places, by the id each button carries. */
async function landingPlaces(): Promise<{ labels: string[]; ids: string[] }> {
  const { FilePicker } = await import('@/ui/FilePicker')
  const picker = new FilePicker({
    onOpen: () => undefined,
    onOpenFiles: () => undefined,
    onStore: () => undefined,
    onConnect: () => undefined,
  })
  return {
    labels: textsOf(picker.el, '.picker-provider'),
    ids: all(picker.el, '.picker-provider').map((node) => node.getAttribute('data-provider') ?? ''),
  }
}

/** The dialog's row of tiles, by the id each carries, and the pane it opens on. */
async function dialogTiles(): Promise<{ labels: string[]; ids: string[]; pane: HTMLElement }> {
  const { openConnect } = await import('@/ui/ConnectCard')
  openConnect({ onConnected: () => undefined })
  const body = document.querySelector('.connect-body') as HTMLElement
  return {
    labels: textsOf(body, '.connect-provider'),
    ids: all(body, '.connect-provider').map((node) => node.getAttribute('data-provider') ?? ''),
    pane: body.querySelector('.connect-pane') as HTMLElement,
  }
}

describe('the two doors to a place', () => {
  it('offer the same places, in the same order', async () => {
    const landing = await landingPlaces()
    const dialog = await dialogTiles()
    expect(landing.ids).toEqual(['local', 'bucket', 'drive', 'dropbox'])
    expect(dialog.ids).toEqual(landing.ids)
    // Named differently on purpose: a tile is a tab and carries where it goes,
    // a button carries what pressing it does.
    expect(dialog.labels).toEqual(['This machine', 'A bucket', 'Google Drive', 'Dropbox'])
    expect(landing.labels).toEqual([
      'choose a folder…',
      'connect a bucket…',
      'sign in to Google…',
      'sign in to Dropbox…',
    ])
  })

  it('word *this machine* identically, because both buttons are now the same click', async () => {
    // The landing page's button runs the directory picker itself and so does
    // the pane's, so the two must agree about what the reader is about to get
    // — a grant that survives a reload, or a snapshot of this visit.
    const landing = await landingPlaces()
    const dialog = await dialogTiles()
    expect(landing.labels[0]).toBe('choose a folder…')
    expect(textsOf(dialog.pane, '.btn-signin')).toEqual(['choose a folder…'])

    vi.unstubAllGlobals()
    document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
    const plain = await landingPlaces()
    const plainDialog = await dialogTiles()
    expect(plain.labels[0]).toBe('choose a folder (this visit)…')
    expect(textsOf(plainDialog.pane, '.btn-signin')).toEqual(['choose a folder (this visit)…'])
  })

  it('part company over a sign-in this build cannot make: the button goes, the tile stays', async () => {
    googleSignIn = false
    const landing = await landingPlaces()
    expect(landing.ids).toEqual(['local', 'bucket', 'dropbox'])
    // The dialog keeps it, and its pane is where the explanation lives.
    const dialog = await dialogTiles()
    expect(dialog.ids).toEqual(['local', 'bucket', 'drive', 'dropbox'])
  })
})

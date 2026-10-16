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
 * reason the list carries `works` at all. A sign-in needs two things this page
 * does not choose: a build that can be registered — Google's OAuth registers an
 * http(s) origin, so the desktop build's `app://viewer` cannot sign in — and a
 * site built with the registration, the client id or the app key its maintainer
 * provides (§24.7). §8.5 says a control that cannot keep its promise is absent,
 * so either one missing drops the landing page's button — while the dialog keeps
 * the tile, because a reader who went looking for Drive is owed the sentence
 * saying why it is not there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStores } from '@/state/idb'
import { all, openedAs, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let asTab: () => void

vi.mock('@/auth/google', async () => {
  const actual = await vi.importActual<typeof import('@/auth/google')>('@/auth/google')
  return { ...actual, get GOOGLE_SIGN_IN_AVAILABLE() { return googleSignIn } }
})

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, mocked mutable: the test runner has no defines. */
const site = SITE_DEFAULTS as {
  googleClientId: string | null
  googleApiKey: string | null
  dropboxAppKey: string | null
}

/** What this build can do about Google, as the mock above answers it. */
let googleSignIn = true

beforeEach(() => {
  teardown = setUpDom()
  googleSignIn = true
  // A published site: built with both registrations.
  site.googleClientId = 'test.apps.googleusercontent.com'
  site.dropboxAppKey = 'a1b2c3d4e5f6g7h'
  window.localStorage.clear()
  // A browser that can hold a directory — a picker, and a database to keep the
  // grant in, here a memory one — opened as the installed app, so the local
  // place is worded the way the installed app and the desktop build word it on
  // both screens (§20.6).
  vi.stubGlobal('showDirectoryPicker', async () => null)
  vi.stubGlobal('indexedDB', {})
  useMemoryStores()
  asTab = openedAs('app')
})

afterEach(() => {
  asTab()
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

  // The same rule for the other half of what a sign-in needs. A site built
  // without the client id or the app key used to offer both buttons on the
  // first screen and answer them with a disabled button and the name of an
  // environment variable — which is the broken promise §8.5 and §24.2 exist to
  // prevent, and the reason `works` reads the registration too.
  it('part company over a sign-in this *site* cannot make, for either provider', async () => {
    site.googleClientId = null
    site.dropboxAppKey = null
    const landing = await landingPlaces()
    expect(landing.ids).toEqual(['local', 'bucket'])
    const dialog = await dialogTiles()
    expect(dialog.ids).toEqual(['local', 'bucket', 'drive', 'dropbox'])
  })
})

// @vitest-environment jsdom
/**
 * Signing in to Google from the Connect dialog (SPECS §24.7).
 *
 * The account section is the only place in this application where a reader hands
 * over a credential that is not theirs to shrug at — `drive.readonly` is read
 * access to *all* of their Drive — and almost every way it can be wrong is
 * invisible from a screenshot:
 *
 * - **The token has to reach the header bag.** A sign-in that succeeds and
 *   registers no bearer looks exactly like a sign-in that worked: the dialog
 *   says "signed in", and the private file goes on answering 403.
 * - **Both hosts, from one sign-in.** One token covers Drive and the GCS JSON
 *   API, and registering them one at a time is the arrangement where a `gs://`
 *   object keeps failing after a sign-in the reader watched succeed.
 * - **Signing out has to mean it**, for a credential as much as for a key.
 * - **Nothing may be fetched from Google before the click.** §11's rule for a
 *   third-party request is that it happens on a gesture; a script tag added at
 *   import would tell Google that somebody opened the viewer — every time
 *   anybody opened it, including the readers who only ever drop a local file.
 *
 * The token client is stubbed through `setTokenClientFactory`, which is the seam
 * that exists for exactly this: `accounts.google.com` cannot be reached from a
 * test environment (nor from the sandbox this was written in), so the choice was
 * a stub or no assertions at all about the one screen that handles a credential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  googleState,
  setTokenClientFactory,
  signOut,
  type TokenClientConfig,
  type TokenResponse,
} from '@/auth/google'
import { accessHeadersFor, bearerFor } from '@/s3/credentials'
import { all, buttonLabels, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

const DRIVE = 'https://www.googleapis.com/drive/v3/files/1Ab?alt=media&supportsAllDrives=true'
const GCS = 'https://storage.googleapis.com/storage/v1/b/lab/o/rep1.mcool?alt=media'
const CLIENT_ID = '123-abc.apps.googleusercontent.com'

let teardown: DomTeardown
let asked: TokenClientConfig | null = null

/** A token client that answers `response` the moment it is asked. */
function stub(response: TokenResponse): void {
  setTokenClientFactory((config) => {
    asked = config
    return { requestAccessToken: () => config.callback(response) }
  })
}

/** Let the sign-in promise and the redraw behind it settle. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  asked = null
  site.googleClientId = null
  site.googleApiKey = null
  setTokenClientFactory(null)
  signOut()
})

afterEach(() => {
  teardown()
  setTokenClientFactory(null)
  signOut()
  window.localStorage.clear()
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
  document.querySelectorAll('script').forEach((node) => node.remove())
})

/** The dialog's body, mounted and opened on the Google Drive provider. */
async function connectBody(): Promise<HTMLElement> {
  const { openConnect } = await import('@/ui/ConnectCard')
  openConnect({ onConnected: () => undefined, provider: 'drive' })
  const body = document.querySelector<HTMLElement>('.modal-body')
  expect(body).not.toBeNull()
  return body as HTMLElement
}

/** The Drive pane: one section, headed by the tile's own name. */
function accountSection(body: HTMLElement): HTMLElement {
  const section = all(body, '.connect-section').find((node) =>
    (node.querySelector('h3')?.textContent ?? '').includes('Google Drive'),
  )
  expect(section).toBeDefined()
  return section as HTMLElement
}

/** What the ? on the pane's title says, on hover. */
function helpText(section: HTMLElement): string {
  return section.querySelector('.connect-head .connect-tip')?.textContent ?? ''
}

/** The pane's text with the tip taken out: what is on the page before any hover. */
function visibleText(section: HTMLElement): string {
  const copy = section.cloneNode(true) as HTMLElement
  copy.querySelector('.connect-tip')?.remove()
  return copy.textContent ?? ''
}

/** Every script this page has asked Google for. */
function googleScripts(): string[] {
  return all<HTMLScriptElement>(document, 'script')
    .map((node) => node.src)
    .filter((src) => src.includes('accounts.google.com'))
}

describe('the Google Drive pane', () => {
  it('is one title with a ? at its right, and a sign-in under it — no second heading, no box', async () => {
    // The site's registrations — the client id, the API key — are built in
    // (`config/siteDefaults.ts`); a reader is offered the sign-in they make
    // possible and nothing to type. The folder box is on this same pane, and
    // it is not on screen until the sign-in has happened.
    const body = await connectBody()
    // Headed by the tile above it, not by an imperative: a tab that renames
    // its subject on being pressed reads as a further step (§20).
    expect(textsOf(body, '.connect-section h3')).toEqual(['Google Drive'])
    const section = accountSection(body)
    const head = section.querySelector('.connect-head') as HTMLElement
    expect(head.querySelector('h3')?.textContent).toBe('Google Drive')
    // The ? is a real button on the title's line, and the tip is what it
    // describes: a keyboard reaches it and a screen reader reads it.
    const help = head.querySelector<HTMLButtonElement>('.connect-help')
    expect(help?.textContent).toBe('?')
    expect(help?.getAttribute('aria-describedby')).toBe(head.querySelector('.connect-tip')?.id)
    expect(head.querySelector('.connect-tip')?.getAttribute('role')).toBe('tooltip')
    expect(buttonLabels(section)).toEqual(['?', 'sign in to Google'])
    expect(all<HTMLInputElement>(section, 'input')).toEqual([])
    expect(body.textContent).not.toMatch(/API key/i)
    expect(body.textContent).not.toMatch(/client id stored/i)
  })

  it('keeps what the grant actually is, and where the token goes, behind the ?', async () => {
    // The two sentences §24.7 requires of this dialog, and it requires them
    // because a consent screen says neither: Google's names the product, and
    // nothing anywhere tells the reader where the token ends up. Behind the ?
    // rather than on the pane: one hover away for the reader who wants them,
    // and out of the way of the one pressing the button.
    const section = accountSection(await connectBody())
    const tip = helpText(section)
    expect(tip).toMatch(/drive\.readonly is read access to all of your Drive/i)
    expect(tip).toMatch(/where a bucket key is a grant over one prefix/i)
    expect(tip).toMatch(/token lives only in this tab’s memory/i)
    expect(tip).toMatch(/never written to storage/i)
    expect(tip).toMatch(/does not know which account/i)
    expect(visibleText(section)).not.toMatch(/drive\.readonly|token lives/i)
  })

  it('says, behind the ?, that a public Drive link opens without signing in, where the site has a key', async () => {
    site.googleApiKey = 'AIzaSite'
    const section = accountSection(await connectBody())
    expect(helpText(section)).toMatch(/public Drive link opens without signing in/i)
    expect(section.textContent).not.toContain('AIzaSite')
  })

  it('pins the tip on a click of the ?, for a screen that has no hover', async () => {
    const section = accountSection(await connectBody())
    const help = section.querySelector<HTMLButtonElement>('.connect-help') as HTMLButtonElement
    const wrap = help.parentElement as HTMLElement
    expect(wrap.classList.contains('is-open')).toBe(false)
    expect(help.getAttribute('aria-expanded')).toBe('false')

    help.click()
    expect(wrap.classList.contains('is-open')).toBe(true)
    expect(help.getAttribute('aria-expanded')).toBe('true')

    help.click()
    expect(wrap.classList.contains('is-open')).toBe(false)
    expect(help.getAttribute('aria-expanded')).toBe('false')
  })

  it('fetches nothing from Google at import or when the dialog is built', async () => {
    // §11: a third-party request happens on a gesture. Importing this module and
    // opening the dialog are not gestures towards Google.
    expect(googleScripts()).toEqual([])
    await connectBody()
    expect(googleScripts()).toEqual([])
  })
})

describe('the site’s registration, which no reader is asked for', () => {
  it('says so, and offers no sign-in, on a site built without a client id', async () => {
    const section = accountSection(await connectBody())
    const signIn = buttonNamed(section, 'sign in to Google')
    // Disabled rather than absent: the sentence beside it names the one thing
    // a reader can do — ask the site's maintainer — and hiding the button
    // would hide what the sentence is about.
    expect(signIn?.disabled).toBe(true)
    expect(signIn?.title).toMatch(/built without a Google client id/i)
    expect(section.textContent).toMatch(/not set up on this site/i)
    expect(section.textContent).toContain('GOOGLE_CLIENT_ID')
    expect(section.textContent).toContain('docs/deploy.md')
    expect(googleState().configured).toBe(false)
  })

  it('offers the sign-in on a site built with one, without printing it', async () => {
    site.googleClientId = CLIENT_ID
    const section = accountSection(await connectBody())
    expect(buttonNamed(section, 'sign in to Google')?.disabled).toBe(false)
    expect(section.textContent).not.toContain(CLIENT_ID)
    expect(section.textContent).not.toMatch(/not set up/i)
    expect(googleState().configured).toBe(true)
  })
})

describe('signing in', () => {
  it('holds the token for Drive and for Cloud Storage, and says until when', async () => {
    site.googleClientId = CLIENT_ID
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    const section = accountSection(await connectBody())

    buttonNamed(section, 'sign in to Google')?.click()
    await settled()

    expect(asked?.client_id).toBe(CLIENT_ID)
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
    expect(bearerFor(GCS)).toBe('ya29.TOKEN')
    // And through the one function every remote read actually calls, because a
    // registry that holds a token no request carries is a registry that changed
    // nothing.
    expect(accessHeadersFor(DRIVE)['Authorization']).toBe('Bearer ya29.TOKEN')

    const expiry = new Date(googleState().expiresAt ?? 0).toLocaleTimeString()
    expect(visibleText(section)).toContain(`Signed in until ${expiry}`)
    // No address, because no identity scope was asked for — said behind the ?.
    expect(helpText(section)).toMatch(/does not know which account/i)
    expect(visibleText(section)).not.toMatch(/does not know which account/i)
  })

  it('opens the folder box under the sign-in, on the same pane, once signed in', async () => {
    site.googleClientId = CLIENT_ID
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    const section = accountSection(await connectBody())
    expect(all<HTMLInputElement>(section, 'input')).toEqual([])
    expect(buttonLabels(section)).not.toContain('connect this folder')

    buttonNamed(section, 'sign in to Google')?.click()
    await settled()

    // The big button is gone — there is nothing left for it to do — and the
    // two boxes and their button have taken its place, under one title still.
    expect(textsOf(section, 'h3')).toEqual(['Google Drive'])
    expect(buttonLabels(section)).toEqual(['?', 'sign out', 'connect this folder'])
    expect(all<HTMLInputElement>(section, 'input')).toHaveLength(2)
    expect(section.querySelector('.drive-folder')?.className).not.toContain('hidden')
  })

  it('offers a sign-out only once there is something to sign out of', async () => {
    site.googleClientId = CLIENT_ID
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    const section = accountSection(await connectBody())
    expect(buttonLabels(section)).not.toContain('sign out')

    buttonNamed(section, 'sign in to Google')?.click()
    await settled()
    expect(buttonLabels(section)).toContain('sign out')

    buttonNamed(section, 'sign out')?.click()

    expect(bearerFor(DRIVE)).toBeNull()
    expect(bearerFor(GCS)).toBeNull()
    expect(accessHeadersFor(DRIVE)['Authorization']).toBeUndefined()
    // The pane is back to its first state: the sign-in, and no folder box.
    expect(buttonLabels(section)).toEqual(['?', 'sign in to Google'])
    expect(all<HTMLInputElement>(section, 'input')).toEqual([])
  })

  it('fetches Google’s script on the click, and lets a failed load be pressed again', async () => {
    // The one test that drives the *real* factory, with no stub in front of it:
    // jsdom does not fetch an appended script, so what is asserted is the two
    // things this module is responsible for — that the request happens on the
    // gesture and not before (§11), and that a load which fails leaves the
    // reader able to try again rather than stuck behind a promise that will
    // never settle.
    site.googleClientId = CLIENT_ID
    setTokenClientFactory(null)
    const section = accountSection(await connectBody())
    expect(googleScripts()).toEqual([])

    buttonNamed(section, 'sign in to Google')?.click()
    await settled()

    const script = all<HTMLScriptElement>(document, 'script').find((node) =>
      node.src.includes('accounts.google.com'),
    )
    expect(script?.src).toBe('https://accounts.google.com/gsi/client')
    expect(script?.async).toBe(true)

    script?.dispatchEvent(new Event('error'))
    await settled()

    expect(section.textContent).toMatch(/could not be loaded/i)
    // The dead tag is taken out of the page, and the button comes back: a
    // network that blocked accounts.google.com for a moment must not disable
    // this for the life of the tab.
    expect(googleScripts()).toEqual([])
    expect(buttonNamed(section, 'sign in to Google')?.disabled).toBe(false)

    buttonNamed(section, 'sign in to Google')?.click()
    await settled()
    expect(googleScripts()).toEqual(['https://accounts.google.com/gsi/client'])
    // Settled rather than left pending, so this test leaves the module's
    // memoised load where it found it.
    all<HTMLScriptElement>(document, 'script')
      .find((node) => node.src.includes('accounts.google.com'))
      ?.dispatchEvent(new Event('error'))
    await settled()
  })

  it('shows what Google refused, and leaves the button pressable', async () => {
    site.googleClientId = CLIENT_ID
    stub({ error: 'access_denied', error_description: 'The user denied the request' })
    const section = accountSection(await connectBody())

    buttonNamed(section, 'sign in to Google')?.click()
    await settled()

    expect(section.textContent).toContain('access_denied')
    expect(buttonNamed(section, 'sign in to Google')?.disabled).toBe(false)
    expect(bearerFor(DRIVE)).toBeNull()
  })
})

describe('where a sign-in cannot work at all', () => {
  afterEach(() => {
    vi.doUnmock('@/version')
    vi.resetModules()
  })

  it('is absent in the desktop build, which has no origin Google will register', async () => {
    // `app://viewer` (`electron/protocol.cts`) is not an http(s) origin, and an
    // OAuth client is registered against one. Extending the desktop CSP to admit
    // Google's script would not change that, so §8.5 applies: absent, not
    // disabled. The pane keeps its title and its ?, and says under them why
    // there is no button.
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      TARGET: 'desktop',
    }))

    const body = await connectBody()

    // The Drive pane says, where the account would be, why there is none;
    // Dropbox stays a tile, because its sign-in is a code pasted from a page
    // Dropbox shows, not a registration against an origin (§24.9).
    expect(textsOf(body, '.connect-provider')).toEqual([
      'This machine',
      'A bucket',
      'Google Drive',
      'Dropbox',
    ])
    expect(textsOf(body, '.connect-section h3')).toEqual(['Google Drive'])
    expect(body.querySelector('.connect-head .connect-help')).not.toBeNull()
    expect(buttonLabels(body.querySelector('.connect-section') as HTMLElement)).toEqual(['?'])
    expect(body.textContent).toContain('Not on the desktop app')
  })
})

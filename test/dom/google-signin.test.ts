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
  writeClientId,
  type TokenClientConfig,
  type TokenResponse,
} from '@/auth/google'
import { accessHeadersFor, bearerFor } from '@/s3/credentials'
import { all, buttonLabels, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

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

/** The dialog's body, mounted. */
async function connectBody(): Promise<HTMLElement> {
  const { openConnect } = await import('@/ui/ConnectCard')
  openConnect({ onConnected: () => undefined })
  const body = document.querySelector<HTMLElement>('.modal-body')
  expect(body).not.toBeNull()
  return body as HTMLElement
}

/** The section whose heading names the account. */
function accountSection(body: HTMLElement): HTMLElement {
  const section = all(body, '.connect-section').find((node) =>
    (node.querySelector('h3')?.textContent ?? '').includes('Google account'),
  )
  expect(section).toBeDefined()
  return section as HTMLElement
}

/** Every script this page has asked Google for. */
function googleScripts(): string[] {
  return all<HTMLScriptElement>(document, 'script')
    .map((node) => node.src)
    .filter((src) => src.includes('accounts.google.com'))
}

describe('the Google account section', () => {
  it('is offered after the API key, which is the order a reader meets them in', async () => {
    const body = await connectBody()
    expect(textsOf(body, '.connect-section h3')).toEqual([
      'A folder on this machine',
      'A bucket',
      'A Google API key',
      'A Google account',
      'A Google Drive folder',
      'Dropbox',
    ])
  })

  it('says what the grant actually is, and where the token goes', async () => {
    // The two sentences §24.7 requires of this dialog, and it requires them
    // because a consent screen says neither: Google's names the product, and
    // nothing anywhere tells the reader where the token ends up.
    const text = accountSection(await connectBody()).textContent ?? ''
    expect(text).toMatch(/drive\.readonly is read access to all of your Drive/i)
    expect(text).toMatch(/where a bucket key is a grant over one prefix/i)
    expect(text).toMatch(/token lives only in this tab’s memory/i)
    expect(text).toMatch(/never written to storage/i)
  })

  it('fetches nothing from Google at import or when the dialog is built', async () => {
    // §11: a third-party request happens on a gesture. Importing this module and
    // opening the dialog are not gestures towards Google.
    expect(googleScripts()).toEqual([])
    await connectBody()
    expect(googleScripts()).toEqual([])
  })
})

describe('the client id, which is stored and is not a secret', () => {
  it('refuses to offer a sign-in until one is saved, and says why', async () => {
    const section = accountSection(await connectBody())
    const signIn = buttonNamed(section, 'sign in with Google')

    // Disabled rather than absent, which is the deliberate exception to §8.5:
    // this control becomes available by filling in the box directly above it,
    // and hiding it would hide the consequence of that box.
    expect(signIn?.disabled).toBe(true)
    expect(signIn?.title).toMatch(/client id/i)
    expect(section.textContent).toMatch(/No client id stored/)
  })

  it('saves it, prints it back, and enables the sign-in', async () => {
    const section = accountSection(await connectBody())
    const input = all<HTMLInputElement>(section, 'input')[0]
    // Not a password box, unlike the key above it: a client id is published in
    // the page of every site that uses this flow, and what a reader coming back
    // here needs to know is *which project*.
    expect(input.type).toBe('text')

    input.value = CLIENT_ID
    buttonNamed(section, 'save')?.click()

    expect(section.textContent).toContain(CLIENT_ID)
    expect(buttonNamed(section, 'sign in with Google')?.disabled).toBe(false)
    expect(googleState().configured).toBe(true)
  })

  it('forgets it for real, and does not sign out doing so', async () => {
    writeClientId(CLIENT_ID)
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    const section = accountSection(await connectBody())
    buttonNamed(section, 'sign in with Google')?.click()
    await settled()

    buttonNamed(section, 'forget')?.click()

    expect(window.localStorage.getItem('metacooler-viewer:google')).toBeNull()
    expect(section.textContent).toMatch(/No client id stored/)
    // The grant is the reader's own and is still opening the file in front of
    // them. Forgetting which project to sign in to next time is not a reason to
    // close it.
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
  })
})

describe('signing in', () => {
  it('holds the token for Drive and for Cloud Storage, and says until when', async () => {
    writeClientId(CLIENT_ID)
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    const section = accountSection(await connectBody())

    buttonNamed(section, 'sign in with Google')?.click()
    await settled()

    expect(asked?.client_id).toBe(CLIENT_ID)
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
    expect(bearerFor(GCS)).toBe('ya29.TOKEN')
    // And through the one function every remote read actually calls, because a
    // registry that holds a token no request carries is a registry that changed
    // nothing.
    expect(accessHeadersFor(DRIVE)['Authorization']).toBe('Bearer ya29.TOKEN')

    const expiry = new Date(googleState().expiresAt ?? 0).toLocaleTimeString()
    expect(section.textContent).toContain(expiry)
    // No address, because no identity scope was asked for.
    expect(section.textContent).toMatch(/does not know which account/i)
  })

  it('offers a sign-out only once there is something to sign out of', async () => {
    writeClientId(CLIENT_ID)
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    const section = accountSection(await connectBody())
    expect(buttonLabels(section)).not.toContain('sign out')

    buttonNamed(section, 'sign in with Google')?.click()
    await settled()
    expect(buttonLabels(section)).toContain('sign out')

    buttonNamed(section, 'sign out')?.click()

    expect(bearerFor(DRIVE)).toBeNull()
    expect(bearerFor(GCS)).toBeNull()
    expect(accessHeadersFor(DRIVE)['Authorization']).toBeUndefined()
    expect(section.textContent).toMatch(/Not signed in/)
    expect(buttonLabels(section)).not.toContain('sign out')
  })

  it('fetches Google’s script on the click, and lets a failed load be pressed again', async () => {
    // The one test that drives the *real* factory, with no stub in front of it:
    // jsdom does not fetch an appended script, so what is asserted is the two
    // things this module is responsible for — that the request happens on the
    // gesture and not before (§11), and that a load which fails leaves the
    // reader able to try again rather than stuck behind a promise that will
    // never settle.
    writeClientId(CLIENT_ID)
    setTokenClientFactory(null)
    const section = accountSection(await connectBody())
    expect(googleScripts()).toEqual([])

    buttonNamed(section, 'sign in with Google')?.click()
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
    expect(buttonNamed(section, 'sign in with Google')?.disabled).toBe(false)

    buttonNamed(section, 'sign in with Google')?.click()
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
    writeClientId(CLIENT_ID)
    stub({ error: 'access_denied', error_description: 'The user denied the request' })
    const section = accountSection(await connectBody())

    buttonNamed(section, 'sign in with Google')?.click()
    await settled()

    expect(section.textContent).toContain('access_denied')
    expect(buttonNamed(section, 'sign in with Google')?.disabled).toBe(false)
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
    // disabled. The API-key section stays, because a key is a string sent to a
    // host and `app://viewer` can send it.
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      TARGET: 'desktop',
    }))

    const body = await connectBody()

    // Dropbox stays: its sign-in is a code pasted from a page Dropbox shows,
    // not a registration against an origin, so `app://viewer` can do it (§24.9).
    expect(textsOf(body, '.connect-section h3')).toEqual([
      'A folder on this machine',
      'A bucket',
      'A Google API key',
      'Dropbox',
    ])
  })
})

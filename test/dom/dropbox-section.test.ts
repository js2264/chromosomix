// @vitest-environment jsdom
/**
 * The Connect dialog’s Dropbox section, which is the only one with a flow in it.
 *
 * Four things can be wrong here while a screenshot of the section looks right:
 *
 * - **The gate.** A sign-in button that is pressable without an app key opens a
 *   Dropbox page saying `invalid_client`, in another tab, about a field this
 *   dialog could have checked. It is disabled with the reason beside it rather
 *   than absent, which is the same deliberate exception to §8.5 the Google
 *   section makes: the control becomes available by filling in the box directly
 *   above it.
 * - **The code box has to appear**, because the reader has just been sent to
 *   another tab and handed a string with nowhere obvious to put it.
 * - **Finishing has to actually sign in**, and the section has to say so — a
 *   flow that swallows the answer leaves a reader pressing *finish* on a code
 *   that has already been spent.
 * - **Browsing must be offered only when it would work**, and must name the
 *   folder id the panel knows, since that string is the whole of what `done`
 *   carries.
 *
 * The token exchange goes through `setDropboxFetch`, which is the seam that
 * exists for exactly this: no Dropbox host is reachable from a test environment
 * or from the sandbox this was written in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dropboxSection } from '@/ui/DropboxSection'
import { setDropboxFetch, signOut } from '@/auth/dropbox'
import { bearerFor } from '@/s3/credentials'
import { all, buttonLabels, buttonNamed, setUpDom, type DomTeardown } from '../support/dom'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

const APP_KEY = 'a1b2c3d4e5f6g7h'
const LIST = 'https://api.dropboxapi.com/2/files/list_folder'

let teardown: DomTeardown
let opened: string[] = []

/** Answer the token exchange, and every other request, with `body`. */
function serve(body: unknown, status = 200): void {
  setDropboxFetch(
    (() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as unknown as Response)) as unknown as typeof fetch,
  )
}

/** One turn of the event loop. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Wait until `ready` holds, a turn at a time.
 *
 * The sign-in is asynchronous twice over — `crypto.subtle.digest`, and then the
 * promise chain the button wraps it in — so a fixed number of ticks is a race
 * that passes on an idle machine and fails when the suite runs seven files at
 * once. Waiting for the state the test is about to assert on is the same thing
 * a reader does, and it fails loudly rather than hanging when the flow never
 * gets there.
 */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !ready(); turn++) await tick()
  expect(ready(), 'the flow never reached the state this test is about').toBe(true)
  // One more turn, so the redraw that runs in the chain’s `finally` has landed
  // before anything is asserted about the DOM.
  await tick()
}

/** The section, mounted — `isConnected` is what its subscription checks. */
function section(done: (id: string) => void = () => undefined): HTMLElement {
  const node = dropboxSection(done)
  expect(node).not.toBeNull()
  document.body.appendChild(node as HTMLElement)
  return node as HTMLElement
}

/** Sign in through the section, the way a reader does. */
async function signInThrough(node: HTMLElement): Promise<void> {
  serve({ access_token: 'sl.TOKEN', expires_in: 14_400 })
  buttonNamed(node, 'sign in with Dropbox')?.click()
  await until(() => opened.length > 0)
  const code = all<HTMLInputElement>(node, 'input')[0]
  code.value = 'CODE-FROM-THE-PAGE'
  buttonNamed(node, 'finish')?.click()
  await until(() => bearerFor(LIST) !== null)
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  site.dropboxAppKey = APP_KEY
  opened = []
  serve({})
  signOut()
  vi.stubGlobal('open', (url: string) => {
    opened.push(url)
    return null
  })
})

afterEach(() => {
  signOut()
  setDropboxFetch(null)
  teardown()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('the site’s registration, which no reader is asked for', () => {
  it('says so, and offers no sign-in, on a site built without an app key', () => {
    site.dropboxAppKey = null
    const node = section()
    const signIn = buttonNamed(node, 'sign in with Dropbox')
    // Disabled rather than absent: the sentence beside it names the one thing
    // a reader can do — ask the site's maintainer.
    expect(signIn?.disabled).toBe(true)
    expect(signIn?.title).toMatch(/built without a Dropbox app key/i)
    expect(node.textContent).toMatch(/not set up on this site/i)
    expect(node.textContent).toContain('DROPBOX_APP_KEY')
    // And nothing to type: the one box on the section is the code's, and it is
    // hidden until a sign-in has begun.
    expect(all<HTMLInputElement>(node, 'input')).toHaveLength(1)
    expect(node.textContent).not.toMatch(/app key stored/i)
  })

  it('offers the sign-in on a site built with one, without printing it', () => {
    const node = section()
    expect(buttonNamed(node, 'sign in with Dropbox')?.disabled).toBe(false)
    expect(node.textContent).not.toContain(APP_KEY)
    expect(node.textContent).not.toMatch(/not set up/i)
  })
})

describe('signing in', () => {
  it('opens the authorize page and reveals the code box', async () => {
    site.dropboxAppKey = APP_KEY
    const node = section()
    expect(node.querySelector('.connect-code')?.className).toContain('hidden')

    buttonNamed(node, 'sign in with Dropbox')?.click()
    await until(() => opened.length > 0)

    expect(opened).toHaveLength(1)
    const url = new URL(opened[0])
    expect(`${url.origin}${url.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe(APP_KEY)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    // No redirect, which is why there is a code box at all — and the section
    // says so, because a reader handed a code with no explanation reasonably
    // assumes the sign-in has failed.
    expect(url.searchParams.get('redirect_uri')).toBeNull()

    const box = node.querySelector('.connect-code') as HTMLElement
    expect(box.className).not.toContain('hidden')
    expect(box.textContent).toMatch(/no address to be sent back to/i)
    // And the same URL as a link, for the reader whose pop-up blocker ate the
    // tab.
    expect(all<HTMLAnchorElement>(box, 'a')[0].getAttribute('href')).toBe(opened[0])
  })

  it('finishes with the pasted code, holds the token, and says until when', async () => {
    site.dropboxAppKey = APP_KEY
    const node = section()
    await signInThrough(node)

    expect(bearerFor(LIST)).toBe('sl.TOKEN')
    expect(node.textContent).toMatch(/Signed in\./)
    // No address, because nothing here asks Dropbox who the reader is.
    expect(node.textContent).toMatch(/does not know whose Dropbox it is/)
    // The box is put away once the code has been spent: pressing finish again
    // could only send a request that fails.
    expect(node.querySelector('.connect-code')?.className).toContain('hidden')
  })

  it('shows what Dropbox refused, and leaves the flow where it was', async () => {
    site.dropboxAppKey = APP_KEY
    const node = section()
    buttonNamed(node, 'sign in with Dropbox')?.click()
    await until(() => opened.length > 0)

    serve({ error: 'invalid_grant' }, 400)
    all<HTMLInputElement>(node, 'input')[0].value = 'STALE'
    buttonNamed(node, 'finish')?.click()
    await until(() => (node.textContent ?? '').includes('invalid_grant'))

    expect(node.textContent).toMatch(/invalid_grant/)
    expect(node.textContent).toMatch(/press sign in with Dropbox again/i)
    expect(bearerFor(LIST)).toBeNull()
    // Still on screen, so the reader can paste the next code into it.
    expect(node.querySelector('.connect-code')?.className).not.toContain('hidden')
  })
})

describe('the way in, and the way out', () => {
  it('offers browsing only once it would work, and names the folder', async () => {
    site.dropboxAppKey = APP_KEY
    let asked: string | null = null
    const node = section((id) => {
      asked = id
    })
    // §8.5: a button that opens a folder the account cannot list is a control
    // that cannot keep its promise.
    expect(buttonLabels(node)).not.toContain('browse my Dropbox')

    await signInThrough(node)
    buttonNamed(node, 'browse my Dropbox')?.click()

    // The constant the panel and a drag payload both carry.
    expect(asked).toBe('dropbox')
  })

  it('signs out for real, and stops offering the way in', async () => {
    site.dropboxAppKey = APP_KEY
    const node = section()
    await signInThrough(node)
    expect(buttonLabels(node)).toContain('sign out')

    buttonNamed(node, 'sign out')?.click()

    expect(bearerFor(LIST)).toBeNull()
    expect(node.textContent).toMatch(/expired at|Not signed in/)
    expect(buttonLabels(node)).not.toContain('browse my Dropbox')
    expect(buttonLabels(node)).not.toContain('sign out')
  })
})

describe('what the section says before anything is pressed', () => {
  it('names the grant and where the token lives', () => {
    const text = section().textContent ?? ''
    expect(text).toMatch(/files\.metadata\.read and files\.content\.read/)
    expect(text).toMatch(/everything in your Dropbox/i)
    expect(text).toMatch(/app’s own folder inside it/i)
    expect(text).toMatch(/token lives only in this tab’s memory/i)
    expect(text).toMatch(/never written to storage/i)
    // The four hours a temporary link lasts, said where a reader can act on it.
    expect(text).toMatch(/four hours/i)
  })

  it('contacts nobody when it is built', async () => {
    // §11: a third-party request happens on a gesture. Opening the dialog is not
    // a gesture towards Dropbox.
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      return Promise.resolve(new Response('{}'))
    })
    site.dropboxAppKey = APP_KEY
    section()
    await tick()
    expect(calls).toEqual([])
  })
})

describe('where a sign-in cannot work at all', () => {
  afterEach(() => {
    vi.doUnmock('@/version')
    vi.resetModules()
  })

  it('is absent in the single-file build, which has no network', async () => {
    // An opaque origin: every request to Dropbox fails before a byte moves, so
    // §8.5 applies — absent, not disabled. The desktop build keeps the section,
    // unlike the Google one, because nothing here is registered against an
    // origin.
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      TARGET: 'standalone',
      IS_STANDALONE: true,
    }))

    const fresh = await import('@/ui/DropboxSection')
    expect(fresh.dropboxSection(() => undefined)).toBeNull()
  })

  it('is present on the desktop, where an app:// origin sends a header as well as any', async () => {
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      TARGET: 'desktop',
      IS_STANDALONE: false,
    }))

    const fresh = await import('@/ui/DropboxSection')
    expect(fresh.dropboxSection(() => undefined)).not.toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * Connecting a Google Drive folder from the Connect dialog (SPECS §20, §24.7).
 *
 * The box is small and three things about it are not:
 *
 * - **It is not on screen before there is a token.** §8.5's doctrine — a
 *   control that cannot keep its promise is absent rather than disabled —
 *   applies here rather than the sign-in button's deliberate exception: a
 *   connect button pressed without a sign-in cannot do anything at all, and
 *   would fail with something Google wrote rather than with something this app
 *   can explain. And it is absent rather than a sentence, because the sign-in
 *   button directly above it is the whole of what a reader can do next.
 * - **It notices the sign-in that happens above it**, on the same pane, while
 *   it is on screen. A reader who signs in and finds this box still shut has
 *   to close the dialog and open it again to use the thing they just did.
 * - **It turns a link into an id.** What the reader has in hand is an address
 *   bar; what the API wants is the id in it, and a box that stored the wrong one
 *   would produce a folder that fails three screens away from the mistake.
 *
 * The token client is stubbed through `setTokenClientFactory`, which is the seam
 * that exists for exactly this: `accounts.google.com` cannot be reached from a
 * test environment, so the choice was a stub or no assertions at all about the
 * screen that hands over a credential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setTokenClientFactory,
  signIn,
  signOut,
  type TokenResponse,
} from '@/auth/google'
import { driveFolderSection } from '@/ui/DriveFolderSection'
import { readDriveRows } from '@/state/drives'
import { all, buttonLabels, buttonNamed, setUpDom, type DomTeardown } from '../support/dom'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

const CLIENT_ID = '123-abc.apps.googleusercontent.com'

let teardown: DomTeardown
let connected: string[]

/** The box, mounted — it unsubscribes itself once it is out of the document. */
function section(): HTMLElement {
  const node = driveFolderSection((id) => connected.push(id))
  expect(node).not.toBeNull()
  document.body.appendChild(node as HTMLElement)
  return node as HTMLElement
}

/** Sign this tab in, through the seam the real flow is driven by. */
async function signedIn(): Promise<void> {
  site.googleClientId = CLIENT_ID
  const response: TokenResponse = { access_token: 'ya29.TOKEN', expires_in: 3599 } as TokenResponse
  setTokenClientFactory((config) => ({ requestAccessToken: () => config.callback(response) }))
  await signIn()
}

/** The two boxes, in the order they are drawn. */
function inputs(node: HTMLElement): HTMLInputElement[] {
  return all<HTMLInputElement>(node, 'input')
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  site.googleClientId = null
  connected = []
  setTokenClientFactory(null)
  signOut()
})

afterEach(() => {
  teardown()
  setTokenClientFactory(null)
  signOut()
  window.localStorage.clear()
})

describe('before anybody has signed in', () => {
  it('is hidden and empty: the sign-in above it is the whole of what a reader can do', async () => {
    const node = section()
    expect(node.className).toContain('hidden')
    expect(node.querySelector('h3')).toBeNull()
    expect(buttonLabels(node)).toEqual([])
    expect(inputs(node)).toEqual([])
    expect(node.textContent).toBe('')
  })

  it('stays so where the site has a client id: what it waits for is the sign-in, not the registration', async () => {
    site.googleClientId = CLIENT_ID
    const node = section()
    expect(node.className).toContain('hidden')
    expect(buttonLabels(node)).toEqual([])
    expect(inputs(node)).toEqual([])
  })
})

describe('once this tab is signed in', () => {
  it('opens itself while the dialog is still on screen', async () => {
    const node = section()
    expect(buttonLabels(node)).toEqual([])

    await signedIn()

    // The subscription, and it is not decoration: the sign-in is the button
    // above this box on the same pane, and a box that opened only on the next
    // reload would make the reader close and reopen what they are looking at.
    expect(node.className).not.toContain('hidden')
    expect(buttonLabels(node)).toEqual(['connect this folder'])
    expect(inputs(node)).toHaveLength(2)
  })

  it('closes again on a sign-out, and takes its error with it', async () => {
    await signedIn()
    const node = section()
    inputs(node)[1].value = 'https://drive.google.com/file/d/1AbCdEf/view'
    buttonNamed(node, 'connect this folder')?.click()
    expect(node.textContent).toMatch(/not a Drive folder link/i)

    signOut()

    expect(node.className).toContain('hidden')
    expect(inputs(node)).toEqual([])
    expect(node.textContent).toBe('')
  })

  it('connects the folder a pasted link names, and hands the panel its id', async () => {
    await signedIn()
    const node = section()

    const [name, link] = inputs(node)
    name.value = 'Run 2024'
    link.value = 'https://drive.google.com/drive/u/0/folders/1AbCdEf?usp=sharing'
    buttonNamed(node, 'connect this folder')?.click()

    expect(readDriveRows()).toEqual([{ id: 'drive:1', label: 'Run 2024', folderId: '1AbCdEf' }])
    // The id, because the dialog's next move is to open the Files panel on it.
    expect(connected).toEqual(['drive:1'])
    // Emptied, so a second folder is not connected under the first one's name.
    expect(name.value).toBe('')
    expect(link.value).toBe('')
  })

  it('reads an empty box as My Drive, and names it that', async () => {
    await signedIn()
    const node = section()

    buttonNamed(node, 'connect this folder')?.click()

    expect(readDriveRows()).toEqual([{ id: 'drive:1', label: 'My Drive', folderId: 'root' }])
    expect(connected).toEqual(['drive:1'])
  })

  it('names an unlabelled folder by its id, so two of them can be told apart', async () => {
    await signedIn()
    const node = section()
    inputs(node)[1].value = '1AbCdEf'
    buttonNamed(node, 'connect this folder')?.click()
    expect(readDriveRows()[0].label).toBe('1AbCdEf')
  })

  /**
   * Refused at the box rather than at the listing.
   *
   * A file link passed through as a folder id would list the file's children,
   * which is nothing — and an empty folder is the one refusal a reader cannot
   * tell from a mistake of their own, three screens away from the box that
   * caused it.
   */
  it('refuses a link that is not a folder, and keeps what was typed', async () => {
    await signedIn()
    const node = section()

    const link = inputs(node)[1]
    link.value = 'https://drive.google.com/file/d/1AbCdEf/view'
    buttonNamed(node, 'connect this folder')?.click()

    expect(readDriveRows()).toEqual([])
    expect(connected).toEqual([])
    expect(node.textContent).toMatch(/not a Drive folder link/i)
    // Still in the box, so the reader can fix it rather than find it again.
    expect(link.value).toBe('https://drive.google.com/file/d/1AbCdEf/view')
  })

  it('keeps a half-typed label when the section redraws under it', async () => {
    await signedIn()
    const node = section()
    inputs(node)[0].value = 'Run 2024'

    // A sign-in announces, which redraws this section under the reader.
    await signedIn()

    expect(inputs(node)[0].value).toBe('Run 2024')
  })
})

describe('where a sign-in cannot work at all', () => {
  afterEach(() => {
    vi.doUnmock('@/version')
    vi.resetModules()
  })

  /**
   * `app://viewer` (`electron/protocol.cts`) is not an http(s) origin and an
   * OAuth client is registered against one, so there is no sign-in in the
   * desktop build and therefore no Drive folder to connect. §8.5: absent, not
   * disabled — and absent one build earlier than the rule usually bites.
   */
  it('is absent in the desktop build, which has no origin Google will register', async () => {
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      TARGET: 'desktop',
    }))

    const { driveFolderSection: desktop } = await import('@/ui/DriveFolderSection')
    expect(desktop(() => undefined)).toBeNull()
  })
})

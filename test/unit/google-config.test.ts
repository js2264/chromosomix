// @vitest-environment jsdom
/**
 * The lab's Google configuration, and what this page can say about it
 * (SPECS §24.7).
 *
 * Two halves that are kept apart on purpose, and this file is where the
 * separation is pinned:
 *
 * - **The client id is stored** and is not a secret. It names the Google project
 *   a sign-in goes to; without one the button in the dialog cannot work, so the
 *   round-trip has to hold across a reload and a junk value has to read as
 *   *absent* rather than as a string that will be rejected by Google in a popup.
 * - **The token is not stored**, ever, and lives exactly as long as its
 *   `expires_in` says. The three states {@link googleState} distinguishes —
 *   never signed in, signed in, *signed in and expired* — are the difference
 *   between an error view that offers "sign in" and one that offers "sign in
 *   again", and between one that offers either and one that explains a bucket
 *   key instead.
 *
 * The token client is stubbed throughout. Google's script cannot load in a test
 * environment and would not be worth asserting against if it could; what is
 * asserted here is this module's side of the bargain — what it asks for, what it
 * does with the answer, and when it lets go of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GOOGLE_HOSTS,
  GOOGLE_SCOPE,
  googleState,
  readClientId,
  setTokenClientFactory,
  signIn,
  signOut,
  subscribeGoogle,
  type TokenClientConfig,
  type TokenResponse,
} from '@/auth/google'
import { bearerFor } from '@/s3/credentials'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

const DRIVE = 'https://www.googleapis.com/drive/v3/files/1Ab?alt=media&supportsAllDrives=true'
const GCS = 'https://storage.googleapis.com/storage/v1/b/lab/o/rep1.mcool?alt=media'

/** What the last stubbed token client was configured with. */
let asked: TokenClientConfig | null = null

/**
 * A token client that answers immediately with `response`.
 *
 * The whole of what Google's does, from this module's point of view: it is
 * constructed with a config, and `requestAccessToken` eventually calls the
 * config's callback. Answering synchronously is a simplification a test is
 * entitled to — the flow is a promise either way.
 */
function stub(response: TokenResponse): void {
  setTokenClientFactory((config) => {
    asked = config
    return {
      requestAccessToken: () => config.callback(response),
    }
  })
}

beforeEach(() => {
  window.localStorage.clear()
  site.googleClientId = null
  asked = null
  setTokenClientFactory(null)
  signOut()
})

afterEach(() => {
  setTokenClientFactory(null)
  signOut()
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('what the page can say about the account', () => {
  it('starts unconfigured, with nothing held and no expiry, on a site built without a client id', () => {
    expect(readClientId()).toBeNull()
    expect(googleState()).toEqual({ configured: false, signedIn: false, expiresAt: null })
  })

  it('is configured by the site’s id alone, which authorises nothing', () => {
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    expect(readClientId()).toBe('123-abc.apps.googleusercontent.com')
    expect(googleState()).toEqual({ configured: true, signedIn: false, expiresAt: null })
    expect(bearerFor(DRIVE)).toBeNull()
  })

  it('asks for exactly the two read scopes, and for no identity', async () => {
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()

    expect(asked?.client_id).toBe('123-abc.apps.googleusercontent.com')
    expect(asked?.scope).toBe(GOOGLE_SCOPE)
    expect(GOOGLE_SCOPE.split(' ')).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/devstorage.read_only',
    ])
    // No `userinfo`: the app never learns who signed in, which is why the dialog
    // says "signed in" and an expiry rather than an address.
    expect(GOOGLE_SCOPE).not.toContain('userinfo')
  })

  it('holds the token for both Google hosts, until the expiry Google gave', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T10:00:00Z'))
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })

    await signIn()

    const at = Date.parse('2026-09-11T10:00:00Z') + 3599 * 1000
    expect(googleState()).toEqual({ configured: true, signedIn: true, expiresAt: at })
    // One sign-in, both hosts. Registering them one at a time is the arrangement
    // where a `gs://` object goes on failing after a sign-in the reader watched
    // succeed.
    expect(GOOGLE_HOSTS).toEqual(['www.googleapis.com', 'storage.googleapis.com'])
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
    expect(bearerFor(GCS)).toBe('ya29.TOKEN')
  })

  it('lets go of the token at its expiry, and remembers that it had one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T10:00:00Z'))
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()
    const at = Date.parse('2026-09-11T10:00:00Z') + 3599 * 1000

    vi.setSystemTime(new Date('2026-09-11T11:30:00Z'))

    // `expiresAt` outlives the token deliberately: a past expiry with
    // `signedIn: false` is what tells the error view to offer "sign in again"
    // rather than to explain what signing in is for.
    expect(googleState()).toEqual({ configured: true, signedIn: false, expiresAt: at })
    expect(bearerFor(DRIVE)).toBeNull()
    expect(bearerFor(GCS)).toBeNull()
  })

  it('defaults to an hour when Google sends no usable lifetime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T10:00:00Z'))
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ access_token: 'ya29.TOKEN' })

    await signIn()

    // Finite and wrong beats `NaN` and unfalsifiable: a `NaN` expiry compares
    // false in both directions, so the token would neither expire nor ever be
    // recognised as expired, depending on which comparison asked.
    expect(googleState().expiresAt).toBe(Date.parse('2026-09-11T10:00:00Z') + 3600 * 1000)
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
  })

  it('drops everything on sign-out, expiry included', async () => {
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()

    signOut()

    expect(googleState()).toEqual({ configured: true, signedIn: false, expiresAt: null })
    expect(bearerFor(DRIVE)).toBeNull()
    expect(bearerFor(GCS)).toBeNull()
  })
})

describe('what a sign-in refuses to do', () => {
  it('will not start on a site built without a client id, and says whose it is to provide', async () => {
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await expect(signIn()).rejects.toThrow(/GOOGLE_CLIENT_ID/)
    // Refused before Google is reached, which is the point: an empty
    // `client_id` is a popup showing Google's own `invalid_client`.
    expect(asked).toBeNull()
  })

  it('reports Google’s own refusal rather than pretending it signed in', async () => {
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ error: 'access_denied', error_description: 'The user denied the request' })

    await expect(signIn()).rejects.toThrow(/access_denied/)
    expect(googleState().signedIn).toBe(false)
    expect(bearerFor(DRIVE)).toBeNull()
  })

  it('treats an answer with no token as a failure', async () => {
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ expires_in: 3599 })

    await expect(signIn()).rejects.toThrow(/without a token/i)
    expect(bearerFor(DRIVE)).toBeNull()
  })

  it('surfaces a blocked popup through the error callback', async () => {
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    setTokenClientFactory((config) => ({
      requestAccessToken: () => config.error_callback?.({ type: 'popup_failed_to_open' }),
    }))

    await expect(signIn()).rejects.toThrow(/popup/i)
  })
})

describe('the subscription', () => {
  it('fires on every change a screen would have to redraw for', async () => {
    let changes = 0
    const off = subscribeGoogle(() => {
      changes++
    })

    // The client id is the site's and never changes under a page, so the
    // changes a screen redraws for are the sign-in and the sign-out.
    site.googleClientId = '123-abc.apps.googleusercontent.com'
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()
    expect(changes).toBe(1)

    signOut()
    expect(changes).toBe(2)

    off()
    signOut()
    expect(changes).toBe(2)
  })
})

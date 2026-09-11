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
  clearClientId,
  googleState,
  readClientId,
  setTokenClientFactory,
  signIn,
  signOut,
  subscribeGoogle,
  writeClientId,
  type TokenClientConfig,
  type TokenResponse,
} from '@/auth/google'
import { bearerFor } from '@/s3/credentials'

const KEY = 'metacooler-viewer:google'
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

describe('the client id', () => {
  it('round-trips, under the app’s own prefix', () => {
    expect(readClientId()).toBeNull()
    writeClientId('123-abc.apps.googleusercontent.com')
    expect(readClientId()).toBe('123-abc.apps.googleusercontent.com')
    // Under the prefix `state/stored.ts` sweeps, and as JSON rather than a bare
    // string, so a second field can join it without a migration.
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
    })
  })

  it('trims, and treats an empty box as forgetting', () => {
    writeClientId('  123-abc.apps.googleusercontent.com  ')
    expect(readClientId()).toBe('123-abc.apps.googleusercontent.com')
    writeClientId('   ')
    expect(readClientId()).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('reads anything it did not write as no id at all', () => {
    // Stored state outlives the build that wrote it, and the repair for a
    // malformed row would be a button that is offered, pressed, and answered by
    // Google with `invalid_client` in a popup — a refusal from a third party
    // about a field this app could have checked itself.
    for (const junk of ['', 'not json', '[]', 'null', '{}', '{"clientId":42}', '{"clientId":"  "}']) {
      window.localStorage.setItem(KEY, junk)
      expect(readClientId()).toBeNull()
    }
  })

  it('is forgotten without signing out', async () => {
    // Two separate acts. The grant is the reader's own and is still opening the
    // file in front of them; revoking it because the *id* was forgotten would
    // close a file nobody asked to close.
    writeClientId('123-abc.apps.googleusercontent.com')
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()

    clearClientId()

    expect(readClientId()).toBeNull()
    expect(googleState().configured).toBe(false)
    expect(googleState().signedIn).toBe(true)
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
  })
})

describe('what the page can say about the account', () => {
  it('starts with nothing stored, nothing held and no expiry', () => {
    expect(googleState()).toEqual({ configured: false, signedIn: false, expiresAt: null })
  })

  it('is configured by the id alone, which authorises nothing', () => {
    writeClientId('123-abc.apps.googleusercontent.com')
    expect(googleState()).toEqual({ configured: true, signedIn: false, expiresAt: null })
    expect(bearerFor(DRIVE)).toBeNull()
  })

  it('asks for exactly the two read scopes, and for no identity', async () => {
    writeClientId('123-abc.apps.googleusercontent.com')
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
    writeClientId('123-abc.apps.googleusercontent.com')
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
    writeClientId('123-abc.apps.googleusercontent.com')
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
    writeClientId('123-abc.apps.googleusercontent.com')
    stub({ access_token: 'ya29.TOKEN' })

    await signIn()

    // Finite and wrong beats `NaN` and unfalsifiable: a `NaN` expiry compares
    // false in both directions, so the token would neither expire nor ever be
    // recognised as expired, depending on which comparison asked.
    expect(googleState().expiresAt).toBe(Date.parse('2026-09-11T10:00:00Z') + 3600 * 1000)
    expect(bearerFor(DRIVE)).toBe('ya29.TOKEN')
  })

  it('drops everything on sign-out, expiry included', async () => {
    writeClientId('123-abc.apps.googleusercontent.com')
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()

    signOut()

    expect(googleState()).toEqual({ configured: true, signedIn: false, expiresAt: null })
    expect(bearerFor(DRIVE)).toBeNull()
    expect(bearerFor(GCS)).toBeNull()
  })
})

describe('what a sign-in refuses to do', () => {
  it('will not start without a client id, and says where one comes from', async () => {
    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await expect(signIn()).rejects.toThrow(/client id/i)
    // Refused before Google is reached, which is the point: an empty
    // `client_id` is a popup showing Google's own `invalid_client`.
    expect(asked).toBeNull()
  })

  it('reports Google’s own refusal rather than pretending it signed in', async () => {
    writeClientId('123-abc.apps.googleusercontent.com')
    stub({ error: 'access_denied', error_description: 'The user denied the request' })

    await expect(signIn()).rejects.toThrow(/access_denied/)
    expect(googleState().signedIn).toBe(false)
    expect(bearerFor(DRIVE)).toBeNull()
  })

  it('treats an answer with no token as a failure', async () => {
    writeClientId('123-abc.apps.googleusercontent.com')
    stub({ expires_in: 3599 })

    await expect(signIn()).rejects.toThrow(/without a token/i)
    expect(bearerFor(DRIVE)).toBeNull()
  })

  it('surfaces a blocked popup through the error callback', async () => {
    writeClientId('123-abc.apps.googleusercontent.com')
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

    writeClientId('123-abc.apps.googleusercontent.com')
    expect(changes).toBe(1)

    stub({ access_token: 'ya29.TOKEN', expires_in: 3599 })
    await signIn()
    expect(changes).toBe(2)

    signOut()
    expect(changes).toBe(3)

    off()
    clearClientId()
    expect(changes).toBe(3)
  })
})

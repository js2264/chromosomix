// @vitest-environment jsdom
/**
 * Signing in to Dropbox: PKCE, the code the reader pastes, and the token.
 *
 * No Dropbox host is reachable from a test environment — nor from the sandbox
 * this was written in — so what is asserted here is everything up to and
 * including the bytes this page would put on the wire. That is not a
 * consolation prize: almost every way this flow goes wrong is in those bytes,
 * and each one fails two gestures later, in another tab, with a message from
 * somebody else’s server.
 *
 * - **The challenge has to be the challenge.** A digest taken over UTF-16, a
 *   `+` left unswapped, padding left on: each produces an authorize page that
 *   looks perfect and a token exchange that answers `invalid_grant`. RFC 7636
 *   publishes a vector for exactly this, and it is the first test in the file.
 * - **The authorize URL must carry no `redirect_uri`.** That absence is the
 *   whole flow: it is what makes Dropbox display the code instead of sending it
 *   to an address this application does not have.
 * - **The verifier posted has to be the verifier that was hashed.** Two
 *   sign-ins in one tab, or a verifier written down in the wrong place, and the
 *   proof is of somebody else’s request.
 * - **The token has to reach the header bag, for both hosts.** A sign-in that
 *   succeeds and registers no bearer looks exactly like one that worked: the
 *   dialog says signed in, and the listing goes on answering 401.
 * - **Nothing may be fetched before the gesture** (§11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_REVOKE_URL,
  DROPBOX_SIGN_IN_AVAILABLE,
  DROPBOX_TOKEN_URL,
  beginSignIn,
  challengeOf,
  clearAppKey,
  dropboxState,
  finishSignIn,
  makeVerifier,
  readAppKey,
  setDropboxFetch,
  signOut,
  storedLines,
  subscribeDropbox,
  writeAppKey,
} from '@/auth/dropbox'
import { bearerFor } from '@/s3/credentials'

const APP_KEY = 'a1b2c3d4e5f6g7h'
const LIST = 'https://api.dropboxapi.com/2/files/list_folder'
const CONTENT = 'https://content.dropboxapi.com/2/files/download'

/**
 * RFC 7636 appendix B, verbatim.
 *
 * The document’s own worked example, which is the only reference available for
 * a computation whose failure mode is a refusal from a host no test can reach.
 */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

interface Call {
  url: string
  init: RequestInit
}

/** An answer to one request: a status, and a body as JSON or as text. */
interface Answer {
  status?: number
  body?: unknown
  text?: string
}

/** Answer each request in turn with `answers`, and record what was asked. */
function serve(...answers: Answer[]): Call[] {
  const calls: Call[] = []
  let at = 0
  setDropboxFetch(((url: string, init: RequestInit) => {
    calls.push({ url, init })
    const answer = answers[Math.min(at++, answers.length - 1)] ?? {}
    const status = answer.status ?? 200
    const text = answer.text ?? JSON.stringify(answer.body ?? {})
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      json: () => Promise.resolve(JSON.parse(text)),
      text: () => Promise.resolve(text),
    } as unknown as Response)
  }) as unknown as typeof fetch)
  return calls
}

/** The form fields one of those calls carried. */
function form(call: Call): URLSearchParams {
  return new URLSearchParams(String(call.init.body ?? ''))
}

/** Sign in, and answer the calls it made. */
async function signIn(expiresIn = 14_400): Promise<Call[]> {
  writeAppKey(APP_KEY)
  const calls = serve({ body: { access_token: 'sl.TOKEN', token_type: 'bearer', expires_in: expiresIn } })
  await beginSignIn()
  await finishSignIn('CODE-FROM-THE-PAGE')
  return calls
}

beforeEach(() => {
  window.localStorage.clear()
  // A token left by the previous test is dropped here, and the revoke that
  // fires goes into a stub rather than at a network this sandbox does not have.
  serve()
  signOut()
})

afterEach(() => {
  signOut()
  setDropboxFetch(null)
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('PKCE', () => {
  it('computes the challenge the RFC publishes for its own verifier', async () => {
    // RFC 7636 appendix B. The four ways this goes wrong — the hash over the
    // wrong encoding, standard base64 instead of base64url, padding left on, the
    // ASCII of the verifier taken as bytes of something else — all produce a
    // plausible-looking string, and all of them fail at Dropbox rather than here.
    expect(await challengeOf(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
  })

  it('makes a verifier of the length and alphabet the RFC allows', () => {
    const verifier = makeVerifier()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    // The unreserved set, which is what §4.1 permits and what survives a URL.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
  })

  it('makes a different one every time, which is the only thing it is for', () => {
    expect(makeVerifier()).not.toBe(makeVerifier())
  })
})

describe('the authorize URL', () => {
  it('asks for a code, with a challenge and no redirect', async () => {
    writeAppKey(APP_KEY)
    const { url } = await beginSignIn()
    const parsed = new URL(url)

    expect(`${parsed.origin}${parsed.pathname}`).toBe(DROPBOX_AUTHORIZE_URL)
    expect([...parsed.searchParams.keys()]).toEqual([
      'client_id',
      'response_type',
      'code_challenge',
      'code_challenge_method',
      'token_access_type',
    ])
    expect(parsed.searchParams.get('client_id')).toBe(APP_KEY)
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    // Online, so no refresh token comes back: §24.8 refuses to store one, and a
    // long-lived credential held in memory is an extra sign-in per tab bought
    // for nothing.
    expect(parsed.searchParams.get('token_access_type')).toBe('online')
    // The absence that is the feature. With a redirect URI, Dropbox sends the
    // code to an address; without one, it shows it to the reader — which is the
    // only arrangement that works from a site, a fork, `app://viewer` and a file.
    expect(parsed.searchParams.get('redirect_uri')).toBeNull()
  })

  it('fetches nothing: the reader visits that page, not this one', async () => {
    writeAppKey(APP_KEY)
    const calls = serve()
    await beginSignIn()
    expect(calls).toEqual([])
  })

  it('refuses without an app key, and names where to put one', async () => {
    await expect(beginSignIn()).rejects.toThrow(/Connect → Dropbox/)
  })

  it('is available in this build, and is absent only where there is no network', () => {
    // The web target, which is what vitest runs as. The standalone build’s
    // absence is asserted where it can be — over the dialog, in
    // `test/dom/dropbox-section.test.ts`.
    expect(DROPBOX_SIGN_IN_AVAILABLE).toBe(true)
  })
})

describe('exchanging the code', () => {
  it('posts the code and the verifier the challenge was made from', async () => {
    writeAppKey(APP_KEY)
    const calls = serve({ body: { access_token: 'sl.TOKEN', expires_in: 14_400 } })
    const { url } = await beginSignIn()
    await finishSignIn('  CODE-FROM-THE-PAGE  ')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(DROPBOX_TOKEN_URL)
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )

    const body = form(calls[0])
    // Trimmed, because a code copied off a web page arrives with whitespace
    // around it more often than not.
    expect(body.get('code')).toBe('CODE-FROM-THE-PAGE')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(APP_KEY)
    // No client secret: PKCE is what stands in for one, and a secret shipped in
    // a page anybody can read is not a secret.
    expect(body.get('client_secret')).toBeNull()

    // The proof, end to end: the verifier posted is the one whose digest was
    // shown to Dropbox. A flow that made a second verifier between the two
    // halves would pass every other assertion in this file.
    const verifier = body.get('code_verifier') ?? ''
    expect(await challengeOf(verifier)).toBe(new URL(url).searchParams.get('code_challenge'))
  })

  it('holds the token for both API hosts, until the moment the response gave', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'))
    await signIn(14_400)

    expect(bearerFor(LIST)).toBe('sl.TOKEN')
    // Both hosts from one response. Registering them one at a time is the
    // arrangement where somebody forgets the second.
    expect(bearerFor(CONTENT)).toBe('sl.TOKEN')
    expect(dropboxState().signedIn).toBe(true)
    expect(dropboxState().expiresAt).toBe(Date.parse('2026-09-11T12:00:00Z') + 14_400_000)
  })

  it('falls back to an hour when the response says nothing readable', async () => {
    // Not optimism: an unparseable `expires_in` would otherwise become a `NaN`
    // expiry, which is a token that neither expires nor is ever usable depending
    // on which comparison asked. Of the two finite wrong answers, the short one
    // fails the way every expiry already fails.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'))
    writeAppKey(APP_KEY)
    serve({ body: { access_token: 'sl.TOKEN', expires_in: 'soon' } })
    await beginSignIn()
    await finishSignIn('CODE')

    expect(dropboxState().expiresAt).toBe(Date.parse('2026-09-11T12:00:00Z') + 3_600_000)
  })

  it('stops claiming a token once it has run out, and remembers that it had one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'))
    await signIn(14_400)

    vi.setSystemTime(new Date('2026-09-11T17:00:00Z'))
    const state = dropboxState()
    expect(state.signedIn).toBe(false)
    // The expiry outlives the token, which is what lets the dialog say "sign in
    // again" rather than explaining what signing in is for.
    expect(state.expiresAt).toBe(Date.parse('2026-09-11T12:00:00Z') + 14_400_000)
    expect(bearerFor(LIST)).toBeNull()
  })

  it('says what to do about a code that has already been spent', async () => {
    writeAppKey(APP_KEY)
    serve({ status: 400, text: '{"error": "invalid_grant"}' })
    await beginSignIn()

    await expect(finishSignIn('CODE')).rejects.toThrow(/already been used|gone stale/)
    expect(bearerFor(LIST)).toBeNull()
    expect(dropboxState().signedIn).toBe(false)
  })

  it('asks for the code rather than sending an empty one', async () => {
    writeAppKey(APP_KEY)
    const calls = serve()
    await beginSignIn()
    await expect(finishSignIn('   ')).rejects.toThrow(/Paste the code/)
    expect(calls).toEqual([])
  })

  it('refuses a code it never asked for, which is what a reload leaves behind', async () => {
    // The verifier lives in memory between the two halves, so a tab reloaded in
    // between has the code and no way to prove it is its own. Saying so is the
    // difference between pressing finish forever and pressing sign in again.
    writeAppKey(APP_KEY)
    const calls = serve()
    await expect(finishSignIn('CODE')).rejects.toThrow(/no record of starting/)
    expect(calls).toEqual([])
  })
})

describe('signing out', () => {
  it('drops both bearers and tells Dropbox to forget the token', async () => {
    await signIn()
    const calls = serve()

    signOut()

    expect(bearerFor(LIST)).toBeNull()
    expect(bearerFor(CONTENT)).toBeNull()
    expect(dropboxState().signedIn).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(DROPBOX_REVOKE_URL)
    expect(calls[0].init.method).toBe('POST')
    // Written out here rather than read back from the registry, which by then is
    // empty — the local half happens first, deliberately.
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer sl.TOKEN')
  })

  it('says nothing to Dropbox when there is no token to revoke', () => {
    const calls = serve()
    signOut()
    expect(calls).toEqual([])
  })
})

describe('the app key, which is stored', () => {
  it('keeps it, reads it back, and forgets it on an empty save', () => {
    const seen: number[] = []
    const off = subscribeDropbox(() => seen.push(1))

    writeAppKey(`  ${APP_KEY}  `)
    expect(readAppKey()).toBe(APP_KEY)
    expect(dropboxState().configured).toBe(true)

    // An empty value forgets, so *save* on an empty box does what it plainly
    // looks like it does — the rule every other key box in this app follows.
    writeAppKey('')
    expect(readAppKey()).toBeNull()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    off()
  })

  it('answers null for a row that is not the shape this module wrote', () => {
    // Stored state outlives the build that wrote it, so it is validated rather
    // than repaired: the repair would be an authorize page saying
    // `invalid_client`, in another tab, about a field this app could have checked.
    for (const raw of ['not json', '[]', '{}', '{"appKey": 7}', '{"appKey": "  "}']) {
      window.localStorage.setItem('metacooler-viewer:dropbox', raw)
      expect(readAppKey()).toBeNull()
    }
  })

  it('does not sign out when it is forgotten', async () => {
    await signIn()
    clearAppKey()
    // The grant is the reader’s own and is still opening the file in front of
    // them. Forgetting which app to sign in to next time is not a reason to
    // close it.
    expect(bearerFor(LIST)).toBe('sl.TOKEN')
    expect(dropboxState().configured).toBe(false)
  })
})

describe('what the stored-data screen is told', () => {
  it('names the app key and prints it, because it is not a secret', () => {
    writeAppKey(APP_KEY)
    const lines = storedLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].label).toBe('Dropbox app key')
    expect(lines[0].detail).toContain(APP_KEY)
    // And it says what is *not* kept, which is the half a reader cannot check.
    expect(lines[0].detail).toMatch(/never stored/i)
  })

  it('says nothing at all when nothing is kept', () => {
    expect(storedLines()).toEqual([])
  })

  it('never prints a token, whatever else it prints', async () => {
    await signIn()
    expect(JSON.stringify(storedLines())).not.toContain('sl.TOKEN')
  })
})

describe('what happens at import', () => {
  it('contacts nobody', async () => {
    // §11: a third-party request happens on a gesture. Importing this module and
    // asking it what it knows are not gestures towards Dropbox.
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      return Promise.resolve(new Response('{}'))
    })
    vi.resetModules()
    const fresh = await import('@/auth/dropbox')
    fresh.dropboxState()
    fresh.readAppKey()
    expect(calls).toEqual([])
    vi.unstubAllGlobals()
  })
})

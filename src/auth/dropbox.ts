/**
 * Signing in to Dropbox, with a code the reader copies off Dropbox’s own page.
 *
 * A Dropbox folder is the one remote place in this application that cannot be
 * read without a sign-in at all. A bucket has public objects, Drive has public
 * files behind an API key, and a share link on `dl.dropboxusercontent.com` is
 * one file somebody already decided to publish (§23.5). *Browsing* a Dropbox is
 * none of those: the listing API takes a bearer token and nothing else, so the
 * reader signs in to their own account, in their own browser, and this module is
 * how.
 *
 * ## Why the code is pasted rather than redirected back
 *
 * Every other OAuth flow in the world ends at a **redirect URI** — the
 * authorization server sends the browser back to an address registered in
 * advance, with the code in the query. This application has no address it can
 * register that works: the published site has one origin, a fork has another,
 * the single-file build (§19) has an *opaque* origin, and the desktop build
 * serves itself from `app://viewer` (`electron/protocol.cts`). A redirect flow
 * would therefore be a feature of one deployment, and a lab that forked the site
 * would have to register a second URI before its readers could sign in.
 *
 * Dropbox supports the one shape that needs no address at all: an authorize
 * request **with no `redirect_uri`** makes Dropbox display the authorization
 * code on its own page, for the reader to copy into this one. It is two
 * gestures instead of one, and it is the only arrangement that works
 * identically from a website, a fork, a laptop’s desktop app and a file on a
 * USB stick — which is the property §19 and §21 both need and which no amount of
 * redirect-URI bookkeeping would buy.
 *
 * ## PKCE, and the secret that is therefore not needed
 *
 * A code is worth something to whoever holds it, and the reason a public client
 * may exchange one without a client secret is **PKCE** (RFC 7636): this page
 * makes a fresh random *verifier*, sends only its SHA-256 *challenge* to the
 * authorize endpoint, and proves it was the one that asked by presenting the
 * verifier at the token endpoint. The verifier is held in memory here between
 * the two halves and nowhere else. A client secret would be the alternative, and
 * a secret shipped in a page that anybody can read is not a secret — which is
 * exactly the case PKCE was written for.
 *
 * `token_access_type=online`, so the exchange yields **no refresh token**.
 * A refresh token is a long-lived credential, §23.8 refuses to store one, and a
 * long-lived credential held in memory and lost at every reload is a thing that
 * costs a reader an extra sign-in per tab in exchange for nothing. Asking for
 * the short-lived token is asking for exactly what this application can honestly
 * keep.
 *
 * ## What is kept, and for how long
 *
 * The **app key**, in storage — the lab’s registration of a Dropbox app, which
 * is public by construction (it is in the authorize URL, which the reader can
 * read in their own address bar) and authorises nothing on its own. The
 * **token**, in memory only and never written (§23.8), held by
 * `s3/credentials.ts`’s bearer registry for the two API hosts, which is a
 * module-level `Map` a reload empties.
 *
 * Nothing here asks Dropbox who the reader is: there is no `account_info.read`
 * in the permissions this needs, so the app never learns the address behind the
 * account. What it can say is *signed in, until 14:32*, which is the whole of
 * what a reader needs in order to read the next `401`.
 *
 * ## Where this is absent
 *
 * The **standalone build** only (§19): its origin is opaque, so every remote
 * request fails before a byte moves, and a sign-in that authorises requests
 * nothing can make is §8.5’s control that cannot keep its promise. The
 * **desktop** build keeps it, unlike the Google sign-in next door — nothing here
 * is registered against an origin, so `app://viewer` sends these requests as
 * well as any other page does.
 */

import { clearBearer, setBearer } from '../s3/credentials'
import type { StoredItem } from '../state/stored'
import { IS_STANDALONE } from '../version'

/** Where the app key is kept. One row, like the Google client id next door. */
const KEY = 'metacooler-viewer:dropbox'

/**
 * The two hosts one sign-in is registered for.
 *
 * Exact hosts rather than a `*.dropboxapi.com` glob, for the reason
 * `auth/google.ts` states about its own pair: a bearer token is a credential and
 * every host it is sent to receives it. `api.dropboxapi.com` takes the listing
 * and the temporary-link calls; `content.dropboxapi.com` is where a download
 * would go if this viewer ever made one directly. `dl.dropboxusercontent.com`,
 * which is where a temporary link actually points, is deliberately **not** here:
 * that link carries its own signature in the URL and needs no header, and
 * putting the account’s token on an unauthenticated content host would publish
 * it to one.
 */
export const DROPBOX_HOSTS = ['api.dropboxapi.com', 'content.dropboxapi.com'] as const

/** Where the reader is sent, and where the code they bring back is exchanged. */
export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize'
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
export const DROPBOX_REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke'

/**
 * The two permissions the app is registered with, named wherever Dropbox
 * refuses for want of one.
 *
 * They are set on the **app**, in Dropbox’s App Console, rather than asked for
 * per sign-in — which is why the authorize URL below carries no `scope`
 * parameter and why a missing permission is a thing the lab fixes once rather
 * than something a reader can grant from here. `docs/hosting.md` has the steps.
 */
export const DROPBOX_PERMISSIONS = ['files.metadata.read', 'files.content.read'] as const

/**
 * Whether this build can sign in at all.
 *
 * See the header: only the standalone build cannot, and it cannot because it
 * has no network rather than because of anything about Dropbox.
 */
export const DROPBOX_SIGN_IN_AVAILABLE = !IS_STANDALONE

/** What the Dropbox section and the folder backend both draw themselves from. */
export interface DropboxState {
  /** An app key is stored, so signing in is a thing that could work. */
  configured: boolean
  /** A token is held **and** has not expired. */
  signedIn: boolean
  /**
   * Epoch milliseconds, and it **outlives the token** — `auth/google.ts`’s
   * `GoogleState.expiresAt` says why: *this page had a token and it ran
   * out* is a different sentence from *this page has never signed in*, and only
   * the first is answered by "sign in again".
   */
  expiresAt: number | null
}

// ---------------------------------------------------------------------------
// The app key, which is stored
// ---------------------------------------------------------------------------

/** Storage that cannot throw — `s3/credentials.ts`’s reasoning, and its shape. */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/**
 * The app key this browser holds, or `null`.
 *
 * Validated like every other stored value in this app, because stored state
 * outlives the build that wrote it: anything that is not an object with a
 * non-empty string `appKey` is `null` rather than repaired. The repair would be
 * an authorize URL that opens a Dropbox page saying `invalid_client` — a refusal
 * from a third party, in a new tab, about a field this app could have checked
 * itself.
 */
export function readAppKey(): string | null {
  const raw = readRaw()
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const key = (parsed as Record<string, unknown>)['appKey']
  if (typeof key !== 'string') return null
  const text = key.trim()
  return text === '' ? null : text
}

/**
 * Keep `key` as the app key, replacing whatever was there.
 *
 * An empty value forgets, so *save* on an empty box does what it plainly looks
 * like it does — the rule `writeApiKey` and `writeClientId` already follow, so
 * that three boxes in one dialog behave the same way.
 */
export function writeAppKey(key: string): void {
  const text = key.trim()
  if (text === '') {
    clearAppKey()
    return
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ appKey: text }))
  } catch {
    /* a browser refusing storage still runs; the key just does not persist */
  }
  announce()
}

/**
 * Forget the app key.
 *
 * It does **not** sign out, for the reason `clearClientId` does not: the token
 * already obtained is the reader’s own grant, still good for the file they are
 * reading, and revoking it here would close something that is open. What it does
 * do is take the Dropbox folder out of the panel at the next repaint, since a
 * folder is offered only where there is an app to reach it with.
 */
export function clearAppKey(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* nothing stored is nothing to remove */
  }
  announce()
}

/**
 * What this browser keeps for Dropbox, as a line for the stored-data screen.
 *
 * One line, and it **prints the key in full** — the treatment the Google client
 * id gets and the opposite of the one the bucket secret gets, on the same rule:
 * a value that is published by construction is not made safer by being withheld,
 * and the only question a reader has about it is *which app has this browser
 * been told to sign in to*, which a count cannot answer. The token is
 * deliberately absent from this screen, because it is held in memory and never
 * written, so there is nothing on this machine for the screen to account for.
 */
export function storedLines(): StoredItem[] {
  const key = readAppKey()
  if (key === null) return []
  return [
    {
      label: 'Dropbox app key',
      detail:
        `${key} — your lab’s Dropbox app, not a secret: it identifies the app in the sign-in ` +
        'URL and authorises nothing on its own. The token signing in with it produces is held ' +
        'in memory only and is never stored.',
    },
  ]
}

// ---------------------------------------------------------------------------
// The token, which is not stored
// ---------------------------------------------------------------------------

let token: string | null = null
let expiresAt: number | null = null

/**
 * The PKCE verifier for the sign-in in progress, and nothing longer-lived.
 *
 * In memory between {@link beginSignIn} and {@link finishSignIn}, which is the
 * whole of its useful life: it is the proof that the page exchanging the code is
 * the page that asked for it, so a copy of it surviving in storage would be a
 * copy of half a credential lying about.
 */
let verifier: string | null = null

const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Drop a token that has run out, and say whether one was dropped.
 *
 * Checked when the state is asked for rather than on a timer, for `bearerFor`’s
 * reason: a timer is a thing to cancel when the page goes away, and the only
 * moment the answer matters is the moment somebody asks.
 */
function expire(): boolean {
  if (token === null || expiresAt === null || expiresAt > Date.now()) return false
  token = null
  for (const host of DROPBOX_HOSTS) clearBearer(host)
  return true
}

/**
 * What this page can say about Dropbox right now.
 *
 * Recomputed on every call rather than cached, because two of the three answers
 * change without anybody touching this module: the app key can be edited in
 * another tab, and the token expires on its own.
 */
export function dropboxState(): DropboxState {
  // Announced from a *getter*, for the reason `googleState` documents: the
  // listeners this wakes call back in, find the token already dropped and
  // return false, so it is one notification and no recursion — and without it a
  // dialog left open across an expiry would go on displaying a time that has
  // passed.
  if (expire()) announce()
  return { configured: readAppKey() !== null, signedIn: token !== null, expiresAt }
}

/** Hear about a sign-in, a sign-out, an expiry or an edited app key. */
export function subscribeDropbox(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** `+/=` out, `-_` in, padding gone: RFC 4648 §5, which is what PKCE wants. */
function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A fresh code verifier: 86 characters from the unreserved set.
 *
 * RFC 7636 §4.1 allows 43 to 128 characters and asks for cryptographic
 * randomness. 64 random bytes base64url-encode to 86 of them, which is the
 * middle of the permitted range and spends nothing to be there — and encoding
 * the bytes rather than drawing characters from the alphabet by index is what
 * keeps the distribution flat, since 256 does not divide by the 66 unreserved
 * characters and the naive loop would favour the first 58 of them.
 */
export function makeVerifier(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/**
 * The S256 challenge for a verifier: `BASE64URL(SHA256(ASCII(verifier)))`.
 *
 * Exported because it is the one piece of this flow with a **published test
 * vector** behind it (RFC 7636 appendix B), and a challenge computed slightly
 * wrong — the padding left on, `+` and `/` not swapped, the hash taken over
 * UTF-16 — produces an authorize page that looks perfect and a token exchange
 * that answers `invalid_grant` two gestures later, from a host no test
 * environment can reach.
 */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

let fetchImpl: typeof fetch | null = null

/**
 * Use `impl` instead of the global `fetch`, or `null` to put it back.
 *
 * The seam the tests drive the token exchange through, and the counterpart of
 * `auth/google.ts`’s `setTokenClientFactory`: no Dropbox host is reachable from
 * a test environment (nor from the sandbox this was written in), so the choice
 * was a stub or no assertions at all about the one module here that obtains a
 * credential. A module-level setter rather than a parameter, because the callers
 * are two buttons and threading a `fetch` from each of them would put a test’s
 * concern into the production call sites.
 */
export function setDropboxFetch(impl: typeof fetch | null): void {
  fetchImpl = impl
}

function doFetch(url: string, init: RequestInit): Promise<Response> {
  return (fetchImpl ?? globalThis.fetch)(url, init)
}

/**
 * An hour, used only when the token response carries no readable `expires_in`.
 *
 * Deliberately short rather than optimistic. The fallback matters more than it
 * looks — an unparseable value would become a `NaN` expiry, and `NaN > now` is
 * false in one direction while `NaN <= now` is false in the other, which is a
 * token that neither expires nor is ever usable depending on which comparison
 * asked — and of the two finite wrong answers, the short one fails the way every
 * expiry already fails (an offer to sign in again) while the long one would have
 * the dialog claim a token is good hours after Dropbox stopped honouring it.
 */
const DEFAULT_LIFETIME_SECONDS = 3600

/**
 * Start a sign-in: a fresh verifier, and the URL the reader opens.
 *
 * Answers the URL rather than opening it, because opening a tab is a thing a
 * **click handler** may do and this is not one — a popup opened from a promise
 * callback is blocked by every browser — and because the section wants the URL
 * for the link it shows beside the button, for the reader whose pop-up blocker
 * ate the tab.
 *
 * Nothing is fetched here. The authorize URL is a page the *reader* visits;
 * this page contacts Dropbox for the first time in {@link finishSignIn}, which
 * is the gesture §11 asks a third-party request to sit behind.
 */
export async function beginSignIn(): Promise<{ url: string }> {
  if (!DROPBOX_SIGN_IN_AVAILABLE) {
    throw new Error(
      'This build cannot sign in to Dropbox: the single-file build has an opaque origin, so ' +
        'every request to Dropbox fails before a byte moves. Open a Dropbox file by its share ' +
        'link in the web or desktop build, or download it and drop it here.',
    )
  }
  const appKey = readAppKey()
  if (appKey === null) {
    throw new Error(
      'No Dropbox app key is stored, so there is no app to sign in to. Save the one your lab ' +
        'registered under Connect → Dropbox; docs/hosting.md has the four steps.',
    )
  }
  const fresh = makeVerifier()
  const challenge = await challengeOf(fresh)
  // Kept only once the challenge is computed, so a failed digest leaves the
  // previous attempt's verifier alone rather than replacing it with one no
  // authorize page was ever shown for.
  verifier = fresh

  // Built with `URLSearchParams` rather than by concatenation, so an app key
  // with a character that needs escaping is escaped once and correctly. There
  // is **no `redirect_uri`**, and that absence is the feature: it is what makes
  // Dropbox display the code instead of sending it somewhere (see the header).
  const query = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'online',
  })
  return { url: `${DROPBOX_AUTHORIZE_URL}?${query.toString()}` }
}

/**
 * Exchange the code the reader pasted for a token, and hold it for both hosts.
 *
 * Rejects rather than reporting quietly, because the caller is a button: the
 * section shows the message under the box. The messages name the fix, as §10
 * requires, and the two that can happen before Dropbox is ever contacted — no
 * verifier, an empty box — are worth distinguishing precisely because both look
 * like "finish did nothing".
 */
export async function finishSignIn(code: string): Promise<void> {
  const text = code.trim()
  if (text === '') {
    throw new Error(
      'Paste the code Dropbox showed on its own page, then press finish. It is a long string ' +
        'on the page that opened when you pressed sign in.',
    )
  }
  const appKey = readAppKey()
  if (appKey === null) {
    throw new Error(
      'The app key was forgotten while this sign-in was open. Save it again under ' +
        'Connect → Dropbox and start the sign-in over; the code on the other tab is no longer ' +
        'good for anything.',
    )
  }
  const held = verifier
  if (held === null) {
    throw new Error(
      'This page has no record of starting that sign-in, so it cannot prove the code is its ' +
        'own. That happens when the tab was reloaded in between. Press sign in with Dropbox ' +
        'again and use the new code.',
    )
  }

  // Form-encoded, which is what the token endpoint takes — and no client
  // secret, because PKCE is what stands in for one (see the header). The
  // verifier goes here and travels nowhere else.
  const body = new URLSearchParams({
    code: text,
    grant_type: 'authorization_code',
    client_id: appKey,
    code_verifier: held,
  })

  let response: Response
  try {
    response = await doFetch(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (cause) {
    throw new Error(
      `Could not reach ${DROPBOX_TOKEN_URL} to exchange the code. A network that blocks ` +
        'Dropbox blocks this feature entirely. Underlying error: ' +
        (cause instanceof Error ? cause.message : String(cause)),
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // A code is good once and for a few minutes. Saying so is the difference
    // between a reader pressing finish again with the same string forever and a
    // reader pressing sign in again, which is the fix.
    throw new Error(
      `Dropbox refused the code (${response.status}${detail === '' ? '' : `: ${detail}`}). An ` +
        'authorization code may be exchanged once and expires within minutes, so the usual ' +
        'cause is a code that has already been used or has gone stale — press sign in with ' +
        'Dropbox again and paste the new one.',
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(
      'Dropbox answered the code exchange with something that is not JSON, so there is no token ' +
        'in it. Trying the sign-in again is the only thing to do about it.',
    )
  }
  const granted = (payload as Record<string, unknown>)?.['access_token']
  if (typeof granted !== 'string' || granted === '') {
    throw new Error(
      'Dropbox answered the code exchange without a token, so nothing was granted. Trying the ' +
        'sign-in again is the only thing to do about it.',
    )
  }

  const seconds = Number((payload as Record<string, unknown>)['expires_in'])
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LIFETIME_SECONDS
  const until = Date.now() + lifetime * 1000
  // Both hosts from one response, because one sign-in produced one token that
  // covers both. Registering them one at a time is the arrangement where
  // somebody forgets the second and a download fails after a sign-in the reader
  // watched succeed.
  for (const host of DROPBOX_HOSTS) setBearer(host, granted, until)
  token = granted
  expiresAt = until
  // The code has been spent; keeping the verifier would leave a second `finish`
  // able to send a request that can only fail.
  verifier = null
  announce()
}

/**
 * Drop the token, and tell Dropbox to forget it.
 *
 * The local half is what matters and happens first: the bearers go, so the next
 * listing is refused rather than sent with a credential the reader has just
 * disclaimed. The revoke is best effort — it is a network call on a page that
 * may be closing — and nothing here waits for it or reports its failure,
 * because a reader who pressed *sign out* has already got what they asked for
 * from this browser’s side. It is sent at all because the alternative is a token
 * that goes on being valid at Dropbox for its remaining hours; the header is
 * written out here rather than read back from the registry, which by then is
 * empty.
 */
export function signOut(): void {
  const held = token
  token = null
  expiresAt = null
  verifier = null
  for (const host of DROPBOX_HOSTS) clearBearer(host)
  if (held !== null) {
    void doFetch(DROPBOX_REVOKE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${held}` },
    }).catch(() => {
      /* best effort: the grant is Dropbox's record, the token is already gone here */
    })
  }
  announce()
}

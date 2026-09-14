/**
 * Signing in to Google, for the files a key cannot reach (SPECS §24.7).
 *
 * A Google API key opens a *public* Drive file and nothing more: the Drive API
 * refuses a request without one even for a file anyone can read, and it refuses
 * one *with* a key for a file that is not public. The second half of that
 * sentence is the whole reason this module exists. A private Drive file, and a
 * private GCS object read through the JSON API, need `Authorization: Bearer
 * <token>` on every request, and the only way a page with no backend obtains one
 * is for the reader to sign in to their own Google account, in their own
 * browser, through Google's own script.
 *
 * ## What the lab supplies, and what the reader supplies
 *
 * The lab supplies a **client id**: a registration in a Google Cloud project
 * saying "this origin may ask my users for these scopes". It is not a secret —
 * it ships in the HTML of every site that uses this flow, and it authorises
 * nothing on its own — which is why it is kept in `localStorage` like a
 * preference rather than like the bucket secret, and why the stored-data screen
 * prints it instead of merely admitting it exists. It cannot be shipped in this
 * repository: it is bound to *an origin*, so a fork served from somewhere else
 * needs its own, and `docs/hosting.md` says how to make one.
 *
 * The reader supplies the **grant**, and it is much wider than the client id
 * suggests. `drive.readonly` is read access to **all of their Drive**, where a
 * bucket scope (§20.3) is one prefix of one bucket. The dialog says so in those
 * words, because a consent screen buries it under a product name and because
 * this is the one place in the application where a reader hands over something
 * they cannot see the edges of.
 *
 * ## What is kept, and for how long
 *
 * The client id, in storage. The token, **in memory only and never written**
 * (§24.8) — it is held by `s3/credentials.ts`'s bearer registry, which is a
 * module-level `Map` a reload empties, and it expires inside the hour anyway.
 * Storing it would buy a reader nothing and would cost the stored-data screen
 * the one thing it cannot offer for a short-lived secret: an honest answer.
 * Nothing here asks for an identity scope, so the app never learns who signed
 * in; what it can say is *signed in, until 14:32*, which is the whole of what a
 * reader needs to interpret the next `401`.
 *
 * ## The script is fetched on a click, and on no other occasion
 *
 * `https://accounts.google.com/gsi/client` is a third-party script, and §11's
 * rule for third-party requests is that they happen on a gesture. Loading it at
 * module scope would tell Google that somebody opened the viewer — every time
 * anybody opened the viewer, including the readers who only ever drop a local
 * file. So the load is inside {@link signIn}, behind {@link loadGis}'s single
 * promise, and `test/dom/google-signin.test.ts` asserts that importing this
 * module and building the dialog append no script tag.
 *
 * That same seam is what makes the flow testable at all. Google's script cannot
 * load in a test environment — nor, as it happens, in the sandbox this was
 * written in — so what the flow talks to is a {@link TokenClientFactory}, which
 * is Google's `initTokenClient` in the browser and a stub in a test. The
 * alternative was a module nothing could assert anything about, in the one place
 * in the app that handles a credential.
 *
 * ## Where this is absent, and why
 *
 * The **standalone build** (§19) has an opaque origin: there is no origin to
 * register, so there is no client id that could be made to work. The **desktop
 * build** serves itself from `app://viewer` (`electron/protocol.cts`), and
 * Google's OAuth client registration accepts `http`/`https` JavaScript origins
 * only — a custom scheme cannot be registered, so the token client would refuse
 * the request whatever the page's Content-Security-Policy allowed. Both are
 * §8.5's case — a control that cannot keep its promise is absent rather than
 * disabled — and {@link GOOGLE_SIGN_IN_AVAILABLE} is the one place that is
 * decided.
 */

import { clearBearer, setBearer } from '../s3/credentials'
import { TARGET } from '../version'
import { SITE_DEFAULTS } from '../config/siteDefaults'

/** Where the client id is kept. The API key stays in its own row (§24.7). */
const KEY = 'metacooler-viewer:google'

/**
 * What the token is asked to be good for.
 *
 * Two scopes because one sign-in serves both Google hosts this viewer reads —
 * Drive through `www.googleapis.com`, GCS through the JSON API on
 * `storage.googleapis.com` — and asking for them separately would mean two
 * consent screens for one gesture. Both are read-only, and deliberately so:
 * §13's "the app never modifies a file it opened" should be true of the *grant*
 * as well as of the code, and a `drive.file`-shaped narrowing is not available
 * here because the file is named by a URL the reader pasted rather than picked
 * through Google's own picker.
 *
 * There is no `userinfo` scope, so this app never learns the reader's address.
 * It would make the dialog read better — *signed in as …* — and that is a
 * second grant asked for a label, which is not a trade this app makes.
 */
export const GOOGLE_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/devstorage.read_only'

/**
 * The hosts one sign-in is registered for.
 *
 * Exact hosts, not the `*.googleapis.com` glob `setBearer` would accept. A
 * bearer token is a credential and every host it is sent to receives it; the two
 * below are the two endpoints §24.7 names as taking one, and `oauth2.googleapis.com`
 * or any other future subdomain of the same parent has no business being handed
 * the reader's Drive token because a URL happened to be typed at it.
 */
export const GOOGLE_HOSTS = ['www.googleapis.com', 'storage.googleapis.com'] as const

/** Google Identity Services, fetched on a click and never on load. */
export const GIS_SCRIPT = 'https://accounts.google.com/gsi/client'

/**
 * Whether this build can sign in at all.
 *
 * See the header: the standalone build has no origin and the desktop build's
 * `app://viewer` is not an origin Google's console will register. The web build
 * is the one that can, and this constant is what the dialog and the error view
 * both ask rather than each spelling out a target comparison of its own.
 */
export const GOOGLE_SIGN_IN_AVAILABLE = TARGET === 'web'

/** What the account section and the error view draw themselves from. */
export interface GoogleState {
  /** A client id is stored, so signing in is a thing that could work. */
  configured: boolean
  /** A token is held **and** has not expired. */
  signedIn: boolean
  /**
   * Epoch milliseconds, and it **outlives the token**.
   *
   * A past `expiresAt` with `signedIn: false` is the state that says *this page
   * had a token and it ran out*, which is a different sentence from *this page
   * has never signed in* — the first is answered by "sign in again" beside a
   * `401` the reader has just met, and the second by an explanation of what
   * signing in is for. `null` only before the first sign-in and after
   * {@link signOut}.
   */
  expiresAt: number | null
}

/**
 * Google's three shapes under local names, so a caller — a test's stub, above
 * all — does not have to reach into a global namespace to write one down.
 */
export type TokenResponse = google.accounts.oauth2.TokenResponse
export type TokenClientConfig = google.accounts.oauth2.TokenClientConfig
export type TokenClient = google.accounts.oauth2.TokenClient

/**
 * How a token client is obtained: Google's own, or a test's.
 *
 * Allowed to answer synchronously or with a promise, because the two
 * implementations genuinely differ — the real one has a script to fetch first,
 * a stub has nothing to wait for and should not have to pretend it does.
 */
export type TokenClientFactory = (
  config: google.accounts.oauth2.TokenClientConfig,
) => google.accounts.oauth2.TokenClient | Promise<google.accounts.oauth2.TokenClient>

// ---------------------------------------------------------------------------
// The client id, which is stored
// ---------------------------------------------------------------------------

/** Storage that cannot throw — `s3/credentials.ts`'s reasoning, and its shape. */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/**
 * The client id a sign-in goes to: the reader's own where one is stored, and
 * the site's otherwise (`config/siteDefaults.ts`), or `null` where neither.
 */
export function readClientId(): string | null {
  return ownClientId() ?? SITE_DEFAULTS.googleClientId
}

/**
 * The client id this browser holds, or `null` — the site's not counted.
 *
 * Validated like every other stored value in this app, because stored state
 * outlives the build that wrote it: anything that is not an object with a
 * non-empty string `clientId` is `null` rather than repaired. The repair would
 * be a sign-in button that is offered, pressed, and answers with Google's own
 * `invalid_client` in a popup — a refusal from a third party about a field this
 * app could have checked itself.
 */
export function ownClientId(): string | null {
  const raw = readRaw()
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const id = (parsed as Record<string, unknown>)['clientId']
  if (typeof id !== 'string') return null
  const text = id.trim()
  return text === '' ? null : text
}

/**
 * Keep `id` as the client id, replacing whatever was there.
 *
 * An empty value forgets, so *save* on an empty box does what it plainly looks
 * like it does — the rule `writeApiKey` already follows next door, stated the
 * same way so the two boxes in one dialog behave the same.
 */
export function writeClientId(id: string): void {
  const text = id.trim()
  if (text === '') {
    clearClientId()
    return
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ clientId: text }))
  } catch {
    /* a browser refusing storage still runs; the id just does not persist */
  }
  announce()
}

/**
 * Forget the client id.
 *
 * It does **not** sign out. The two are separate acts: forgetting the id says
 * *this browser should stop offering to sign in to that project*, and the token
 * already obtained is the reader's own grant, still good for the file they are
 * reading. Revoking it here would close a file that is open, which nobody asked
 * for.
 */
export function clearClientId(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* nothing stored is nothing to remove */
  }
  announce()
}

// ---------------------------------------------------------------------------
// The token, which is not stored
// ---------------------------------------------------------------------------

let token: string | null = null
let expiresAt: number | null = null

const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Drop a token that has run out, and say whether one was dropped.
 *
 * Checked when the state is asked for rather than on a timer, for
 * `bearerFor`'s reason: a timer is a thing to cancel when the page goes away,
 * and the only moment the answer matters is the moment somebody asks. The
 * bearer registry expires its own copy on the way out too — this is the half
 * that makes the *dialog* stop claiming a token exists, and that keeps
 * {@link GoogleState.expiresAt} standing afterwards so the offer beside the next
 * `401` can read "sign in again".
 */
function expire(): boolean {
  if (token === null || expiresAt === null || expiresAt > Date.now()) return false
  token = null
  for (const host of GOOGLE_HOSTS) clearBearer(host)
  return true
}

/**
 * What this page can say about Google right now.
 *
 * Recomputed on every call rather than cached, because two of the three answers
 * change without anybody touching this module: the client id can be edited in
 * another tab, and the token expires on its own.
 */
export function googleState(): GoogleState {
  // Announced from a *getter*, which is worth one sentence: the listeners this
  // wakes call `googleState()` in turn, and the second call finds `token` already
  // null and returns false. One notification, no recursion — and without it a
  // dialog left open across an expiry would go on displaying a time that has
  // passed.
  if (expire()) announce()
  return {
    configured: readClientId() !== null,
    signedIn: token !== null,
    expiresAt,
  }
}

/** Hear about a sign-in, a sign-out, an expiry or an edited client id. */
export function subscribeGoogle(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Google's script, and the seam in front of it
// ---------------------------------------------------------------------------

let loading: Promise<void> | null = null
let factory: TokenClientFactory | null = null

/**
 * Use `made` instead of Google's `initTokenClient`, or `null` to put it back.
 *
 * The injection point the DOM tests drive the whole flow through, and the reason
 * this module can be asserted about in an environment that has no network and no
 * Google. It is exported from the module rather than taken as a constructor
 * parameter because the thing that signs in is not an object anybody constructs:
 * it is a function the dialog and the error view both call, and threading a
 * factory from each of them to here would put a test's concern into two
 * production call sites.
 */
export function setTokenClientFactory(made: TokenClientFactory | null): void {
  factory = made
}

/**
 * Fetch Google Identity Services, once.
 *
 * The promise is memoised so that two clicks are one script, and it is cleared
 * on failure so that a reader whose network dropped can press the button again
 * rather than being told forever that the script "is loading".
 */
function loadGis(): Promise<void> {
  if (loading !== null) return loading
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SCRIPT
    script.async = true
    script.defer = true
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => {
      loading = null
      script.remove()
      reject(
        new Error(
          `${GIS_SCRIPT} could not be loaded, so there is nothing to sign in with. A network ` +
            'that blocks accounts.google.com blocks this feature entirely; a public Drive file ' +
            'still opens with the API key alone.',
        ),
      )
    })
    document.head.appendChild(script)
  })
  return loading
}

/** Google's own token client, after its script has arrived. */
async function googleTokenClient(
  config: google.accounts.oauth2.TokenClientConfig,
): Promise<google.accounts.oauth2.TokenClient> {
  await loadGis()
  // `typeof` rather than a truth test: the name is not bound until the script
  // runs, and reading an unbound identifier is a `ReferenceError` rather than
  // `undefined`.
  if (typeof google === 'undefined' || typeof google.accounts?.oauth2?.initTokenClient !== 'function') {
    throw new Error(
      'Google Identity Services loaded but did not install its token client. This is Google’s ' +
        'script changing shape under a page that pins no version of it; a public Drive file ' +
        'still opens with the API key alone.',
    )
  }
  return google.accounts.oauth2.initTokenClient(config)
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * An hour, which is what a Google access token lives for.
 *
 * Used only when a response arrives without a readable `expires_in`, and the
 * fallback matters more than it looks: an unparseable value would become a `NaN`
 * expiry, and `NaN > Date.now()` is false in one direction and `NaN <= now` is
 * false in the other — a token that neither expires nor is ever usable,
 * depending on which comparison asked. A wrong-but-finite hour fails the way
 * every expiry fails, which is a `401` with an offer beside it.
 */
const DEFAULT_LIFETIME_SECONDS = 3600

/**
 * Ask Google for a token, and hold it for the two hosts it is good for.
 *
 * Rejects rather than reporting quietly, because every caller is a button: the
 * dialog shows the message under the button and the error view puts it where the
 * refusal was. The messages name the fix, as §10 requires of a refusal, and the
 * three that can happen before Google is ever contacted — no client id, a build
 * that cannot register an origin, a script that will not load — are worth
 * distinguishing precisely because they all look like "sign in did nothing".
 */
export async function signIn(): Promise<void> {
  if (!GOOGLE_SIGN_IN_AVAILABLE) {
    throw new Error(
      'This build cannot sign in to Google: an OAuth client id is registered against an origin, ' +
        'and neither the single-file build (which has none) nor the desktop build (which serves ' +
        'itself from app://viewer, a scheme Google’s console will not accept) has one to register.',
    )
  }
  const clientId = readClientId()
  if (clientId === null) {
    throw new Error(
      'No Google client id is stored, so there is no project to sign in to. Save the one your ' +
        'lab registered for this origin under Connect → A Google account.',
    )
  }

  // Settled from Google's callback, which is the only channel the token client
  // has: `requestAccessToken` returns nothing, and a refusal at the consent
  // screen arrives as a field on the same object the token would have been on.
  let settle!: (response: google.accounts.oauth2.TokenResponse) => void
  let fail!: (error: Error) => void
  const answer = new Promise<google.accounts.oauth2.TokenResponse>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const make = factory ?? googleTokenClient
  const client = await make({
    client_id: clientId,
    scope: GOOGLE_SCOPE,
    callback: (response) => settle(response),
    error_callback: (error) =>
      fail(
        new Error(
          `Google did not complete the sign-in (${error.type ?? 'unknown'}${
            error.message === undefined ? '' : `: ${error.message}`
          }). A blocked popup is the usual cause; allow popups for this page and try again.`,
        ),
      ),
  })
  client.requestAccessToken()
  const response = await answer

  if (typeof response.error === 'string' && response.error !== '') {
    throw new Error(
      `Google refused the sign-in: ${response.error}${
        response.error_description === undefined ? '' : ` — ${response.error_description}`
      }.`,
    )
  }
  const granted = response.access_token
  if (typeof granted !== 'string' || granted === '') {
    throw new Error(
      'Google answered the sign-in without a token, so nothing was granted. Trying again is the ' +
        'only thing to do about it.',
    )
  }

  const seconds = Number(response.expires_in)
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LIFETIME_SECONDS
  const until = Date.now() + lifetime * 1000
  // Both hosts from one response, because one sign-in produced one token that
  // covers both scopes. Registering them one at a time is the arrangement where
  // somebody forgets the second and a `gs://` object goes on failing after a
  // sign-in the reader watched succeed.
  for (const host of GOOGLE_HOSTS) setBearer(host, granted, until)
  token = granted
  expiresAt = until
  announce()
}

/**
 * Drop the token, and tell Google to forget the grant.
 *
 * The local half is what matters and happens first: the bearers go, so the next
 * request for a private Drive file is refused rather than sent with a credential
 * the reader has just disclaimed. The revoke is best effort — it is a network
 * call to a script that may not be loaded, on a page that may be closing — and
 * nothing here waits for it or reports its failure, because a reader who pressed
 * *sign out* has already got what they asked for from this browser's side.
 */
export function signOut(): void {
  const held = token
  token = null
  expiresAt = null
  for (const host of GOOGLE_HOSTS) clearBearer(host)
  if (held !== null && typeof google !== 'undefined' && typeof google.accounts?.oauth2?.revoke === 'function') {
    try {
      google.accounts.oauth2.revoke(held)
    } catch {
      /* best effort: the grant is Google's record, the token is already gone here */
    }
  }
  announce()
}

/**
 * Which key signs which bucket, and where the app keeps them.
 *
 * A scope is one line the user fills in: a URL prefix, and the credential that
 * unlocks everything under it. `https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/`
 * with a read-only key is the case this was written for — a lab bucket whose
 * `demo/` prefix is public and whose `collections/` prefix is not, reached by
 * the same app in the same session, with only the requests that need signing
 * signed.
 *
 * **A scope may carry no key at all**, and that is a scope over public data
 * rather than a broken one. What a credential buys is a *signature*; what a
 * scope buys is a *name for a prefix somebody wants to browse*, and those turned
 * out to be separable the moment folders became a thing the app shows. A public
 * bucket then costs one field — its URL — instead of six, and everything
 * downstream of here is unchanged: an unsigned read is what a public object
 * always took, and {@link credentialOf} answers `null` where it used to answer a
 * credential nobody could have filled in.
 *
 * The keyless half needs one permission it is easy to assume comes free. Reading
 * a public object is `s3:GetObject` and *listing* the prefix it sits in is
 * `s3:ListBucket`, and a bucket published for downloads usually grants the first
 * to `*` and not the second. So a public scope that cannot be browsed is a
 * normal, correct configuration rather than a fault, `s3/list.ts` says so in
 * those words, and files under it still open by URL.
 *
 * **Matching is by longest prefix**, so a scope over `collections/` and a
 * narrower one over `collections/hum53/` can coexist and the narrower one wins.
 * That is the rule that lets a project key with tighter IAM permissions sit
 * inside a general one without either being edited — and it is what lets a
 * *public* scope over `demo/` sit inside a signed one over the bucket without
 * the public half acquiring a signature it does not want.
 *
 * ## Where this runs, and where it cannot
 *
 * `localStorage` exists on the main thread and **not in a worker**, which is
 * where every byte is actually read. So this module is main-thread only, and
 * the credential travels to the worker inside the message that opens a file —
 * see `worker/protocol.ts`. That is a deliberate shape rather than an accident
 * of the storage API: the worker is handed the one credential the URL it was
 * given needs, so a compromised or confused worker path has no way to enumerate
 * the others.
 *
 * ## On keeping a secret in `localStorage`
 *
 * It is readable by any script running on this origin, and it survives the tab.
 * There is no arrangement that avoids this: the app has no backend by
 * construction (SPECS C1), so whatever signs a request holds the key. What
 * bounds the damage is the *scope of the key*, not where it is parked — an IAM
 * user with `s3:GetObject` and `s3:ListBucket` on one prefix and nothing else.
 * The dialog says so, and `docs/hosting.md` has the policy to paste.
 *
 * `sessionStorage` was the obvious alternative and is the wrong trade: it would
 * mean retyping a forty-character secret in every new tab, which is the kind of
 * friction that ends with the key in a text file on the desktop instead.
 */

import { forgetSigningKey, type S3Credential } from './sigv4'

const KEY = 'metacooler-viewer:buckets'

/** One bucket prefix, and the credential that reads it. */
export interface BucketScope {
  /** Stable across edits, so a row can be replaced rather than matched by name. */
  id: string
  /** What the user calls it. Shown in the picker; never sent anywhere. */
  label: string
  /**
   * The URL prefix this credential covers, always ending in `/`.
   *
   * A prefix rather than a bucket, because the interesting case is a bucket
   * that is partly public: signing the `demo/` requests too would work, and
   * would turn every one of them into a preflight plus a signature for no
   * reason, and would fail outright the moment the key is scoped to
   * `collections/*` as it should be.
   */
  base: string
  /**
   * The signing half, and it is **all three fields or none of them**.
   *
   * None is a public prefix: nothing is signed, nothing is stored that could
   * leak, and the scope is a bookmark with a folder view behind it. All three is
   * the private case this module was written for.
   *
   * There is no meaningful state in between, which is why {@link readScopes}
   * drops a row holding one or two rather than keeping it. A scope with a key id
   * and no secret cannot sign, and *falling back* to an unsigned request would
   * turn a mistyped secret into a bucket that 403s on data the reader believed
   * they had a key for — the failure would be attributed to the bucket, and the
   * field two lines up would look right.
   */
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Present for STS or SSO credentials, absent for a long-lived access key. */
  sessionToken?: string
}

/**
 * Whether this scope signs.
 *
 * One predicate rather than a check on whichever field a caller happened to
 * think of: the three travel together by {@link readScopes}'s rule, so any one
 * of them answers, and naming the question keeps every call site from having to
 * know that.
 */
export function isSigned(scope: BucketScope): boolean {
  return (
    scope.accessKeyId !== undefined &&
    scope.accessKeyId !== '' &&
    scope.secretAccessKey !== undefined &&
    scope.secretAccessKey !== ''
  )
}

/** Storage that cannot throw — mirrors `state/UiMemory.ts`'s reasoning. */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/**
 * Every stored scope, validated.
 *
 * Untrusted input, exactly like the URL hash and the session snapshot: stored
 * state outlives the build that wrote it. A row missing a field is dropped
 * rather than repaired, because the repair would be a scope that signs with a
 * blank secret — a 403 the user cannot explain, in place of a row that is
 * visibly not there.
 *
 * "Missing a field" now means *some of the three*, not *any of them*. A row with
 * none is a public prefix and is kept, which is also what makes this backwards
 * compatible in the direction that matters: nothing already stored has an empty
 * key half, so no reader loses a bucket to this change.
 */
export function readScopes(): BucketScope[] {
  const raw = readRaw()
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: BucketScope[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const text = (name: string): string => (typeof row[name] === 'string' ? row[name] : '')
    const id = text('id')
    const base = normaliseBase(text('base'))
    if (id === '' || base === null || seen.has(id)) continue
    const filled = [text('region'), text('accessKeyId'), text('secretAccessKey')]
    const given = filled.filter((value) => value !== '').length
    // All three or none. See {@link BucketScope.region} for why the middle is
    // dropped rather than downgraded to an unsigned scope.
    if (given !== 0 && given !== 3) continue
    seen.add(id)
    const token = text('sessionToken')
    out.push({
      id,
      label: text('label') === '' ? base : text('label'),
      base,
      ...(given === 0
        ? {}
        : {
            region: filled[0],
            accessKeyId: filled[1],
            secretAccessKey: filled[2],
            ...(token === '' ? {} : { sessionToken: token }),
          }),
    })
  }
  return out
}

/**
 * Replace the stored list.
 *
 * The derived signing key is dropped on the way out. Without that, editing a
 * secret in the dialog would keep signing with the old one until the day
 * rolled over — every request 403ing, with a form on screen showing the right
 * value.
 */
export function writeScopes(scopes: readonly BucketScope[]): void {
  forgetSigningKey()
  try {
    window.localStorage.setItem(KEY, JSON.stringify(scopes))
  } catch {
    /* a browser refusing storage still runs; the scopes just do not persist */
  }
}

/**
 * A URL prefix in the one form comparison can trust, or `null`.
 *
 * Two files with the same meaning must not compare unequal, and the ways a
 * typed URL can differ from itself are all here: a missing scheme, a missing
 * trailing slash, a query string or fragment pasted along with it.
 *
 * The scheme must end up `https:`, and that holds for a public prefix as much as
 * a signed one though the reason it started from does not. An `http://` bucket
 * would send the `Authorization` header in clear, which is what this refused
 * outright rather than normalising; a keyless scope sends no such header and is
 * refused all the same, because the page itself is served over `https:` and the
 * browser blocks a mixed-content read before it is sent. Both roads end at a
 * request that cannot work, and one refusal at the point of typing beats two
 * different failures much later.
 */
export function normaliseBase(value: string): string | null {
  const text = value.trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.href
}

/**
 * The scope covering `url`, or `null` when nothing does.
 *
 * Longest match wins, and the comparison is on the whole prefix string rather
 * than on host-then-path — so `…/collections/` does not match
 * `…/collections-public/`, which a naive `startsWith` on the path would. The
 * trailing slash `normaliseBase` guarantees is what makes that true.
 */
export function scopeFor(url: string, scopes: readonly BucketScope[] = readScopes()): BucketScope | null {
  let best: BucketScope | null = null
  for (const scope of scopes) {
    if (!url.startsWith(scope.base)) continue
    if (best === null || scope.base.length > best.base.length) best = scope
  }
  return best
}

/**
 * The signing half of a scope, or `null` where there is none.
 *
 * A scope is what the *user* fills in; a credential is what the signer takes,
 * and the difference is three fields nobody outside this module should be
 * copying by hand. It was being copied by hand in four places — the lookup
 * below, the listing request, and both of the screens that open a file they
 * have just listed — and the spread that carries `sessionToken` only when it is
 * present is exactly the line an omission hides in: a temporary credential
 * signed without its token is a 403 that names nothing.
 *
 * `null` for a public prefix, which every caller already had a branch for: the
 * lookup below has answered `null` for an unknown URL since the day it was
 * written, and `s3/attach.ts` stamps nothing when it gets one. A public scope is
 * therefore not a new state anywhere downstream — it is the state a URL under no
 * scope at all has always been in.
 */
export function credentialOf(scope: BucketScope): S3Credential | null {
  if (!isSigned(scope)) return null
  return {
    // Non-null by `isSigned`, which is the predicate that makes the three
    // travel together. Asserted rather than re-tested, so there is one rule
    // about what a signed scope is and it is stated once.
    accessKeyId: scope.accessKeyId as string,
    secretAccessKey: scope.secretAccessKey as string,
    region: scope.region as string,
    ...(scope.sessionToken === undefined ? {} : { sessionToken: scope.sessionToken }),
  }
}

/**
 * The credential covering `url`, in the shape the signer wants, or `null`.
 *
 * Two different `null`s, deliberately not told apart: no scope covers this URL,
 * and a public scope covers it and has no key. Both mean *send this unsigned*,
 * which is the only thing a caller does with the answer.
 */
export function credentialFor(
  url: string,
  scopes: readonly BucketScope[] = readScopes(),
): S3Credential | null {
  const scope = scopeFor(url, scopes)
  return scope === null ? null : credentialOf(scope)
}

// ---------------------------------------------------------------------------
// The other kind of credential: a header, not a signature
// ---------------------------------------------------------------------------

/**
 * Where the non-signing credentials live.
 *
 * A second key beside the bucket one, and not a second field on a scope, because
 * these are not scoped to a prefix and never could be: a Google API key is an
 * attribute of the *project* it was made in, and it is presented to two hosts
 * this browser did not name — `www.googleapis.com` for Drive, the GCS JSON API
 * for `gs://` — that no reader will ever have typed into a bucket dialog. Making
 * it a scope would mean a scope with no bucket, which `addressOf` refuses and
 * `s3/list.ts` would try to list.
 */
const ACCESS = 'metacooler-viewer:access'

/**
 * One stored access credential.
 *
 * A union of one member today, and written as one so it can take a second:
 * `kind` is what tells a Google key apart from whatever an institutional portal
 * turns out to need, and a row whose `kind` this build does not know is dropped
 * by {@link readAccessRows} rather than guessed at.
 *
 * There is **exactly one `google-api-key` row at a time**. A key is a property of
 * a project, a reader has one project, and a list would raise a question — which
 * key for which host? — that has no answer the dialog could ask for.
 */
export interface AccessRow {
  id: string
  kind: 'google-api-key'
  key: string
}

/**
 * The stored access rows, validated the way {@link readScopes} validates scopes.
 *
 * Same doctrine, same reasons: this is untrusted input that outlives the build
 * that wrote it, and a row missing its key is dropped rather than repaired —
 * an empty `x-goog-api-key` header is a 403 from Google that names the header
 * and looks exactly like a wrong key.
 */
export function readAccessRows(): AccessRow[] {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(ACCESS)
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: AccessRow[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (row['kind'] !== 'google-api-key') continue
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    const key = typeof row['key'] === 'string' ? row['key'].trim() : ''
    if (id === '' || key === '') continue
    out.push({ id, kind: 'google-api-key', key })
  }
  return out
}

/** Replace the stored rows. */
function writeAccessRows(rows: readonly AccessRow[]): void {
  try {
    window.localStorage.setItem(ACCESS, JSON.stringify(rows))
  } catch {
    /* a browser refusing storage still runs; the key just does not persist */
  }
}

/** The Google API key this browser holds, or `null`. */
export function readApiKey(): string | null {
  const row = readAccessRows().find((held) => held.kind === 'google-api-key')
  return row === undefined ? null : row.key
}

/**
 * Keep `key` as *the* Google API key, replacing whatever was there.
 *
 * An empty value forgets instead of storing an unusable row, so the dialog's
 * save button on an empty box does what it plainly looks like it does.
 */
export function writeApiKey(key: string): void {
  const text = key.trim()
  if (text === '') {
    clearApiKey()
    return
  }
  const kept = readAccessRows().filter((row) => row.kind !== 'google-api-key')
  writeAccessRows([...kept, { id: 'google-api-key', kind: 'google-api-key', key: text }])
}

/** Forget the Google API key. */
export function clearApiKey(): void {
  const kept = readAccessRows().filter((row) => row.kind !== 'google-api-key')
  if (kept.length === 0) {
    try {
      window.localStorage.removeItem(ACCESS)
    } catch {
      /* nothing stored is nothing to remove */
    }
    return
  }
  writeAccessRows(kept)
}

// ---------------------------------------------------------------------------
// Bearer tokens, which are never stored
// ---------------------------------------------------------------------------

/**
 * The bearer tokens this page holds, by host pattern.
 *
 * **In memory, deliberately, and this is the one credential that is never
 * written down** (SPECS §24.7). A bucket key is a long-lived secret whose whole
 * bargain is that the reader chose to park it here and can see it listed and
 * delete it; an OAuth token is a short-lived one that expires inside the session
 * that obtained it. Storing it would buy nothing — it is dead within the hour —
 * and would cost the one thing the stored-data screen cannot offer for it: a
 * reader who pressed *forget everything* after the tab was closed would have been
 * told a secret was gone that had already been useless for a day.
 *
 * A module-level `Map` rather than a field on something, because the thing that
 * would hold it is a session and a token is about a *host*: two tabs of the same
 * origin are two pages and get their own, which is correct, and two sessions in
 * one page share it, which is also correct.
 */
const bearers = new Map<string, { token: string; expiresAt: number }>()

/**
 * Hold `token` for every host matching `hostPattern` until `expiresAt`.
 *
 * The pattern is a wildcard glob over the host — `*.googleapis.com`, which is the
 * spelling igv-utils uses for the same job — because one sign-in produces one
 * token that is good for several hosts: Drive is `www.googleapis.com` and GCS is
 * `storage.googleapis.com`, and registering them one at a time would be two
 * places to forget the second.
 *
 * `expiresAt` is epoch milliseconds, and it is required rather than optional
 * because every token that reaches here has one: an OAuth response carries
 * `expires_in`, and a caller with nothing to put here is holding something that
 * is not a bearer token.
 */
export function setBearer(hostPattern: string, token: string, expiresAt: number): void {
  const pattern = hostPattern.trim().toLowerCase()
  if (pattern === '' || token === '') return
  bearers.set(pattern, { token, expiresAt })
}

/** Drop the token held for exactly this pattern. */
export function clearBearer(hostPattern: string): void {
  bearers.delete(hostPattern.trim().toLowerCase())
}

/**
 * The unexpired token for this URL's host, or `null`.
 *
 * Expiry is checked on the way *out* rather than swept on a timer: a timer would
 * be a thing to cancel when the page goes away, and the only moment the answer
 * matters is the moment it is asked for. An expired entry is deleted as it is
 * found, so a host whose token has died does not keep one row of this map alive
 * for the life of the page.
 */
export function bearerFor(url: string): string | null {
  if (bearers.size === 0) return null
  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return null
  }
  const now = Date.now()
  for (const [pattern, held] of bearers) {
    if (!hostMatches(pattern, host)) continue
    if (held.expiresAt <= now) {
      bearers.delete(pattern)
      continue
    }
    return held.token
  }
  return null
}

/**
 * Whether a wildcard host pattern covers a host.
 *
 * `*` stands for any run of characters, anchored at both ends, so
 * `*.googleapis.com` covers `storage.googleapis.com` and `www.googleapis.com`
 * and does **not** cover `googleapis.com.example.org` — which is the attack the
 * anchoring is there for, and the reason this is a converted regex rather than an
 * `endsWith`.
 *
 * `*.example.org` does not match the bare `example.org`, which is what the glob
 * plainly says: a pattern for both is `*example.org`, or two calls.
 */
function hostMatches(pattern: string, host: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').split('*').join('.*')
  return new RegExp(`^${escaped}$`).test(host)
}

/**
 * The static headers this URL needs, from everything stored and held.
 *
 * Two hosts take the API key and no others, and the narrowness is the point: a
 * key is a credential, and sending one to a host that did not ask for it
 * publishes it to that host. Google's own two endpoints for reading a byte are
 * `www.googleapis.com` (Drive, which refuses without a key even for a public
 * file) and the GCS **JSON API** under `storage.googleapis.com/storage/v1`
 * (which needs none for a public object, and needs one for a private one). The
 * plain `storage.googleapis.com/<bucket>/<object>` XML host is deliberately not
 * included: it is a bucket scope's base, signed with SigV4 when it is private
 * (§20.3), and a Google key means nothing to it.
 *
 * A header and not the `key=` query parameter that igv-utils uses. Both reach
 * the same API; the header keeps the credential out of the URL, which in this
 * application is the string that goes into the hash, into `#session=` and into a
 * link a reader sends a colleague (§11). A key pasted into a share link is a key
 * published, and no amount of care at the other end takes it back.
 */
export function accessHeadersFor(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return out
  }
  const host = parsed.host.toLowerCase()
  const googleApi =
    host === 'www.googleapis.com' ||
    (host === 'storage.googleapis.com' && parsed.pathname.startsWith('/storage/v1'))
  if (googleApi) {
    const key = readApiKey()
    if (key !== null) out['x-goog-api-key'] = key
  }
  const bearer = bearerFor(url)
  if (bearer !== null) out['Authorization'] = `Bearer ${bearer}`
  return out
}

// ---------------------------------------------------------------------------
// Taking a bucket URL apart, for the listing API
// ---------------------------------------------------------------------------

/**
 * What `ListObjectsV2` needs that a plain URL does not say.
 *
 * Reading an object needs only its URL. *Listing* needs the bucket and the key
 * prefix as separate things, because they go in different places — the bucket
 * addresses the request and the prefix is a query parameter — and which part of
 * the URL is which depends on how the endpoint addresses buckets.
 */
export interface BucketAddress {
  /** Where the listing request goes, with no path. */
  endpoint: string
  bucket: string
  /**
   * The key prefix, with no leading slash and a trailing one unless empty.
   *
   * A **key** prefix, not a URL path: decoded, so a scope based at
   * `…/Hi-C%20runs/` yields `Hi-C runs/`. That is the space `listPrefix` and
   * `FolderEntry.path` work in, and it is the one S3 compares against.
   */
  prefix: string
}

/**
 * Undo the percent-encoding a `URL` pathname carries, one segment at a time.
 *
 * A `URL`'s `pathname` is escaped — a space typed into the bucket dialog is
 * stored by {@link normaliseBase} as `%20` — while an S3 key prefix is the
 * literal text of the key, which the listing request encodes once for itself.
 * Passing the escaped form through encoded it a second time, so S3 was asked
 * for keys whose text really did begin `Hi-C%20runs/`: a 200 with an empty
 * `ListBucketResult`, and a bucket full of files drawn as an empty folder with
 * no error to act on. `canonicalPath` in `sigv4.ts` states the same rule for
 * the signature, and for the same reason.
 *
 * Per segment, because `/` separates keys and must survive as itself. Inside a
 * `try`, because a literal `%` is a legal thing for a key to contain and a
 * `URL` leaves it alone, so a prefix such as `100%_reads/` would throw here:
 * keeping that segment raw loses only the prefix that was already ambiguous,
 * where throwing would lose the whole address and with it the ability to list
 * anything.
 */
function decodeKey(value: string): string {
  return value
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

/**
 * Split a scope's base URL into an endpoint, a bucket and a key prefix.
 *
 * Two addressing styles, told apart by the host:
 *
 * - **Virtual-hosted** — `https://<bucket>.s3.<region>.amazonaws.com/<key>` —
 *   which is what AWS issues today and what the demo bucket uses. The whole
 *   path is key.
 * - **Path-style** — `https://<endpoint>/<bucket>/<key>` — which is what
 *   MinIO, Ceph and Cloudflare R2 hand out, and what AWS still answers. The
 *   first path segment is the bucket.
 *
 * The test is `<something>.s3` or `<something>.s3-<region>` at the front of the
 * host, which is AWS's own naming and is deliberately narrow: a bucket named
 * `s3` on a self-hosted MinIO would otherwise be read as virtual-hosted and
 * listed as the wrong bucket. Guessing wrong is a 404 on the listing and
 * nothing worse — objects are still read by their own URLs, which need none of
 * this.
 */
export function addressOf(base: string): BucketAddress | null {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return null
  }
  // The split for the bucket happens on the still-encoded path, because `/` is
  // the one character a pathname never escapes: the segment arithmetic is
  // therefore exact, and a bucket name is DNS-safe so it has nothing to decode.
  // Only the key half goes through `decodeKey`.
  const path = url.pathname.replace(/^\/+/, '')
  const virtualHosted = /^([^.]+)\.s3([.-]|$)/i.exec(url.host)
  if (virtualHosted !== null) {
    return { endpoint: url.origin, bucket: virtualHosted[1], prefix: decodeKey(path) }
  }
  const slash = path.indexOf('/')
  if (path === '') return null
  return slash === -1
    ? { endpoint: url.origin, bucket: path, prefix: '' }
    : {
        endpoint: url.origin,
        bucket: path.slice(0, slash),
        prefix: decodeKey(path.slice(slash + 1)),
      }
}

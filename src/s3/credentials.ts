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
 * **Matching is by longest prefix**, so a scope over `collections/` and a
 * narrower one over `collections/hum53/` can coexist and the narrower one wins.
 * That is the rule that lets a project key with tighter IAM permissions sit
 * inside a general one without either being edited.
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
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Present for STS or SSO credentials, absent for a long-lived access key. */
  sessionToken?: string
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
    if (text('accessKeyId') === '' || text('secretAccessKey') === '' || text('region') === '') {
      continue
    }
    seen.add(id)
    const token = text('sessionToken')
    out.push({
      id,
      label: text('label') === '' ? base : text('label'),
      base,
      region: text('region'),
      accessKeyId: text('accessKeyId'),
      secretAccessKey: text('secretAccessKey'),
      ...(token === '' ? {} : { sessionToken: token }),
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
 * trailing slash, a query string or fragment pasted along with it. The scheme
 * must end up `https:` — an `http://` bucket would send the `Authorization`
 * header in clear, which is the one mistake this refuses outright rather than
 * normalising.
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
 * The signing half of a scope, without the label and the id.
 *
 * A scope is what the *user* fills in; a credential is what the signer takes,
 * and the difference is three fields nobody outside this module should be
 * copying by hand. It was being copied by hand in four places — the lookup
 * below, the listing request, and both of the screens that open a file they
 * have just listed — and the spread that carries `sessionToken` only when it is
 * present is exactly the line an omission hides in: a temporary credential
 * signed without its token is a 403 that names nothing.
 */
export function credentialOf(scope: BucketScope): S3Credential {
  return {
    accessKeyId: scope.accessKeyId,
    secretAccessKey: scope.secretAccessKey,
    region: scope.region,
    ...(scope.sessionToken === undefined ? {} : { sessionToken: scope.sessionToken }),
  }
}

/** The credential covering `url`, in the shape the signer wants, or `null`. */
export function credentialFor(
  url: string,
  scopes: readonly BucketScope[] = readScopes(),
): S3Credential | null {
  const scope = scopeFor(url, scopes)
  return scope === null ? null : credentialOf(scope)
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
  /** The key prefix, with no leading slash and a trailing one unless empty. */
  prefix: string
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
  const path = url.pathname.replace(/^\/+/, '')
  const virtualHosted = /^([^.]+)\.s3([.-]|$)/i.exec(url.host)
  if (virtualHosted !== null) {
    return { endpoint: url.origin, bucket: virtualHosted[1], prefix: path }
  }
  const slash = path.indexOf('/')
  if (path === '') return null
  return slash === -1
    ? { endpoint: url.origin, bucket: path, prefix: '' }
    : { endpoint: url.origin, bucket: path.slice(0, slash), prefix: path.slice(slash + 1) }
}

/**
 * AWS Signature Version 4, for S3, computed synchronously.
 *
 * What this exists for is one line in `sources/RemoteRangeSource.ts`:
 *
 * ```ts
 * xhr.open('GET', this.url, false)
 * ```
 *
 * A synchronous request cannot await anything, so the headers it carries have
 * to be computable in a straight line. `sha256.ts` supplies the hashing; this
 * supplies the four-step derivation around it, and the result is a plain
 * `Record<string, string>` the caller sets on an `XMLHttpRequest`, hands to
 * `fetch`, or gives to `generic-filehandle2`. One signer, every network path.
 *
 * ## What is signed, and what is deliberately not
 *
 * Three headers: `host`, `x-amz-date`, and `x-amz-content-sha256` — plus
 * `x-amz-security-token` when the credential is a temporary one. That is the
 * smallest set S3 accepts, and keeping it small is not laziness:
 *
 * - **`Range` is not signed.** It does not have to be, and signing it would
 *   mean re-deriving a signature for every chunk of every read — thousands per
 *   session — instead of once per request. More to the point, it would break
 *   the fallback path: a host that ignores `Range` gets sent a request whose
 *   signature covers a header the request no longer usefully has.
 * - **`host` is signed but never set.** Browsers forbid setting `Host` on a
 *   request, and rightly. It is put in the canonical request, computed from the
 *   URL, and the browser sets the identical value on the wire. This is the
 *   standard arrangement for browser-side SigV4 and is why the signature
 *   verifies despite the header never being touched here.
 *
 * ## Two things the caller has to know
 *
 * **Every signed request costs a CORS preflight.** `Authorization` is not a
 * safelisted request header, so the browser sends an `OPTIONS` first and will
 * not send the real request until the bucket answers it. The bucket's CORS
 * policy must name `Authorization`, `x-amz-date` and `x-amz-content-sha256` in
 * `AllowedHeaders`; a policy written for public data names `Range` and stops
 * there, so the same bucket serves the demos and refuses every signed request.
 * `AllowedOrigins` may stay `*` — these headers are set from script and no
 * cookies ride along, so this is not a *credentialed* request in the CORS sense
 * and a wildcard origin answers it. `docs/hosting.md` has the policy.
 *
 * **The secret is in the browser.** There is no arrangement in which it is not:
 * the app has no backend by construction (SPECS C1), so whatever signs a request
 * holds the key that signs it. That is a real cost and it is bounded by scoping
 * the key — an IAM user with `s3:GetObject` and `s3:ListBucket` on one prefix
 * and nothing else — never by hiding it, which cannot be done.
 */

import { EMPTY_SHA256, hex, hmacSha256, sha256, utf8 } from './sha256'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'

/** What a user typed into the buckets dialog, minus the part naming a scope. */
export interface S3Credential {
  accessKeyId: string
  secretAccessKey: string
  /** For temporary credentials (STS, SSO). Signed, and sent, when present. */
  sessionToken?: string
  /** `eu-west-3`, and so on. Part of the signature, so a wrong one is a 403. */
  region: string
}

export interface SignOptions {
  method: string
  /** The absolute URL, query string included. */
  url: string
  credential: S3Credential
  /** Injected by the tests, which sign against published vectors. */
  now?: Date
  /**
   * Hex SHA-256 of the request body.
   *
   * Defaults to the empty-string digest, which is right for every request this
   * app makes: it reads, it never writes. A caller that ever sends a body must
   * pass the real digest — `UNSIGNED-PAYLOAD` would also be accepted by S3 over
   * HTTPS, but it is a weaker claim for no gain when the body is empty.
   */
  payloadHash?: string
}

/**
 * `YYYYMMDDTHHMMSSZ`, which is the only timestamp format SigV4 accepts.
 *
 * Built by hand from the UTC getters rather than by cutting up
 * `toISOString()`. The slicing version is shorter and is wrong for a date
 * before year 1000 or after 9999, where `toISOString` emits a six-digit
 * expanded year and every offset shifts — a hypothetical here, but the kind of
 * hypothetical that turns into a signature mismatch nobody can read.
 */
export function amzDate(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  )
}

/**
 * Percent-encode one path segment or query component, AWS's way.
 *
 * `encodeURIComponent` is close and not close enough: it leaves `!`, `'`, `(`,
 * `)` and `*` alone, and AWS's unreserved set is exactly `A-Za-z0-9-_.~`. A key
 * containing an apostrophe — which is a perfectly ordinary thing for a file
 * named after a person to contain — would sign one way and be sent another.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * The canonical path: every segment encoded, the separators left alone.
 *
 * S3 signs the path **as sent**, without normalising `.` or `..` segments — it
 * is the one service that does — so the split-and-rejoin here must not tidy
 * anything. A `URL`'s `pathname` has already encoded some characters, so it is
 * decoded per segment first: encoding an already-encoded `%20` would sign
 * `%2520` and mismatch every time.
 */
function canonicalPath(pathname: string): string {
  if (pathname === '') return '/'
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/')
}

/**
 * The canonical query string: sorted by name, then by value, all encoded.
 *
 * `URLSearchParams` iterates in insertion order and AWS demands byte order, so
 * the sort is the whole point of doing this by hand. Ties on the name are
 * broken by the value, which matters for the repeated parameters S3's list API
 * does not use today and might tomorrow.
 */
function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = []
  params.forEach((value, name) => pairs.push([encodeRfc3986(name), encodeRfc3986(value)]))
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([name, value]) => `${name}=${value}`).join('&')
}

/**
 * The date-scoped signing key, cached.
 *
 * Four chained HMACs, and the input to all four changes at most once a day, so
 * deriving it per request would be four hashes of pure waste on a path that
 * runs thousands of times a session. The cache key includes the secret, so
 * editing a credential in the dialog cannot be answered from the old entry.
 *
 * A plain object rather than a `Map` keyed on the secret: it holds one entry,
 * replaced whenever anything about the scope changes, which bounds how long a
 * derived key stays in memory to "until the next request against a different
 * bucket". The secret itself is in `localStorage` regardless — this is tidiness,
 * not a security boundary, and calling it one would be a lie.
 */
let cachedKey: { id: string; key: Uint8Array } | null = null

function signingKey(secret: string, date: string, region: string): Uint8Array {
  const id = `${secret}|${date}|${region}`
  if (cachedKey !== null && cachedKey.id === id) return cachedKey.key
  const dateKey = hmacSha256(utf8(`AWS4${secret}`), utf8(date))
  const regionKey = hmacSha256(dateKey, utf8(region))
  const serviceKey = hmacSha256(regionKey, utf8(SERVICE))
  const key = hmacSha256(serviceKey, utf8(TERMINATOR))
  cachedKey = { id, key }
  return key
}

/** Drop the derived key. Called when credentials are edited or removed. */
export function forgetSigningKey(): void {
  cachedKey = null
}

/**
 * The headers that make `options` an authenticated S3 request.
 *
 * Returned rather than applied, because the three callers apply them
 * differently — `xhr.setRequestHeader`, a `fetch` init, and
 * `generic-filehandle2`'s header bag — and a function that took a request
 * object would have to know which of the three it had.
 *
 * `host` is in the signature and **not** in the returned map, for the reason in
 * the module docstring: setting it is forbidden, and the browser will send the
 * same value anyway.
 */
export function signS3Request(options: SignOptions): Record<string, string> {
  const url = new URL(options.url)
  const now = options.now ?? new Date()
  const timestamp = amzDate(now)
  const date = timestamp.slice(0, 8)
  const payloadHash = options.payloadHash ?? EMPTY_SHA256
  const { credential } = options

  // Insertion order is the canonical order here: `host` < `x-amz-content-sha256`
  // < `x-amz-date` < `x-amz-security-token` sorts correctly as written, and
  // writing them in order rather than sorting them keeps the two lists — the
  // canonical headers and `SignedHeaders` — impossible to get out of step.
  const signed: Array<[string, string]> = [
    ['host', url.host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', timestamp],
  ]
  if (credential.sessionToken !== undefined && credential.sessionToken !== '') {
    signed.push(['x-amz-security-token', credential.sessionToken])
  }

  const canonicalHeaders = signed.map(([name, value]) => `${name}:${value.trim()}\n`).join('')
  const signedHeaders = signed.map(([name]) => name).join(';')

  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${date}/${credential.region}/${SERVICE}/${TERMINATOR}`
  const stringToSign = [
    ALGORITHM,
    timestamp,
    scope,
    hex(sha256(utf8(canonicalRequest))),
  ].join('\n')

  const signature = hex(
    hmacSha256(signingKey(credential.secretAccessKey, date, credential.region), utf8(stringToSign)),
  )

  const headers: Record<string, string> = {
    Authorization:
      `${ALGORITHM} Credential=${credential.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  }
  if (credential.sessionToken !== undefined && credential.sessionToken !== '') {
    headers['x-amz-security-token'] = credential.sessionToken
  }
  return headers
}

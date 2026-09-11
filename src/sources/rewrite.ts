/**
 * The one table that turns a link somebody pasted into a link that serves bytes.
 *
 * Four of the five commonest ways to publish a file hand out an address that is
 * not the file: a Dropbox share link is an HTML page, a Drive share link is an
 * HTML page, `gs://` is not a scheme a browser has ever heard of, and `s3://` is
 * a name for an object rather than a way to reach it. In every one of those
 * cases the bytes are somewhere else, at a URL derivable from the one in hand by
 * pure string work. igv-utils and hic-straw have carried the same table since
 * 2018 (`docs/remote-sources.md` §3.2), and the measurements in §2 of that note
 * confirm each destination answers CORS and serves ranges.
 *
 * ## Why it is applied where a URL becomes a URI, and not at the fetch
 *
 * A URI in this application is a **public artifact**: it goes into the hash, into
 * `#session=`, into a workspace file somebody publishes beside their data. If the
 * rewrite happened at the last moment — inside `RemoteRangeSource`, say — then
 * every link this viewer wrote would carry the *broken* form, work for the reader
 * who pasted it because their build rewrites it, and keep working only for as
 * long as this table does. Rewriting at the door means the address a reader
 * shares is the address that was read, which is the same rule
 * `state/shareLink.ts` applies to everything else that travels.
 *
 * So it is applied at the picker's URL box, the Tracks card, the Contact maps
 * card, the deck's add row, `inferSource` (which is `#uri=`), `resolveConfig`
 * and `Session.openConfigUrl` (which is `?config=`).
 *
 * ## The rules of the table itself
 *
 * **Pure, idempotent, and it never throws.** Idempotent because a rewritten URL
 * passes through this function again on every later hop — a link is
 * canonicalised when it is typed, again when the config naming it is resolved,
 * again when it arrives in somebody else's hash — and a table whose output is its
 * own input must therefore be a fixed point. Every destination host below is
 * outside every source pattern, so that holds by construction rather than by a
 * guard. It never throws because it sits on the path of *every* URL, including
 * the ones that are not URLs at all: a bare filename reaches `inferSource` and
 * must come back unchanged rather than as an exception.
 *
 * **A link the table does not recognise passes through untouched.** Dropbox has
 * changed its share-link format twice and Google has retired two Drive link
 * shapes; the failure mode of a rewrite that guesses is a URL that cannot be
 * debugged from the address bar, because the address bar no longer holds what the
 * reader typed.
 *
 * `https://storage.googleapis.com/<bucket>/<object>` is deliberately **not**
 * rewritten, unlike its two siblings: it is the form a bucket scope is based at,
 * the one `s3/list.ts` lists and `s3/sigv4.ts` signs. Rewriting it would take a
 * browsable prefix and turn it into an endpoint neither of those understands.
 */

import { addressOf, readScopes, type BucketScope } from '../s3/credentials'

/**
 * The address a request should actually go to, given the one a reader has.
 *
 * `scopes` is the one impure corner, and it is a parameter for that reason: the
 * `s3://` rule resolves against the bucket entries this browser has stored, which
 * live in `localStorage` and therefore exist on the main thread alone
 * (`s3/credentials.ts`). Passing them makes the whole table testable under node,
 * and the default — reading them — is only ever reached by an `s3://` URI, which
 * is a thing a reader types rather than a thing a worker is handed.
 */
export function canonicalUrl(raw: string, scopes?: readonly BucketScope[]): string {
  if (typeof raw !== 'string' || raw === '') return raw
  const text = raw.trim()
  // `file::group` names a place *inside* the file (`ui/labels.ts`), so the group
  // half is not part of the address and must survive whatever happens to the
  // other half. Split on `::` and not on `:`, which every scheme here contains.
  const entry = text.indexOf('::')
  const address = entry < 0 ? text : text.slice(0, entry)
  const group = entry < 0 ? '' : text.slice(entry)
  // `#bins=` and `#index=` are this application's own fragments and name a
  // second file (§3.9, §8.13). A fragment is never sent to a host, so carrying
  // it across a rewrite costs nothing and dropping it would silently lose the
  // sidecar a reader spelled out by hand.
  const hash = address.indexOf('#')
  const base = hash < 0 ? address : address.slice(0, hash)
  const fragment = hash < 0 ? '' : address.slice(hash)

  const rewritten = rewrite(base, scopes)
  // The identity case returns the argument itself, whitespace and all: "anything
  // else unchanged" is a rule about the string, not about its trimmed form.
  return rewritten === null ? raw : `${rewritten}${fragment}${group}`
}

/**
 * Whether this URL carries its own authorisation in the query string.
 *
 * Three shapes, all of them a signature over a URL and a moment: `X-Amz-Signature`
 * for a presigned S3 URL, `X-Goog-Signature` for a signed GCS one, and the `sig`
 * plus `sv` pair of an Azure SAS. What they have in common is what matters here —
 * the signature covers a **method**, so the `HEAD` this viewer probes with is
 * refused even where the `GET` behind it would have been served (SPECS §11).
 * Recognising them is what turns a documented refusal into a link that opens and
 * later expires.
 *
 * The Azure pair needs both halves because `sig` alone is a common enough
 * parameter name to appear on a URL that means nothing of the kind, and `sv` —
 * the storage service version — is what makes it a SAS.
 *
 * Parsed by hand rather than through `URL`, so a relative or malformed address
 * answers `false` instead of throwing on the probe path.
 */
export function isSignedUrl(url: string): boolean {
  const names = queryNames(url)
  if (names.has('x-amz-signature') || names.has('x-goog-signature')) return true
  return names.has('sig') && names.has('sv')
}

/**
 * The lower-cased names of every `name=value` in a URL's query.
 *
 * The fragment is cut off **first**, not last: `#index=<url>` names a second
 * file (§8.13), that URL may itself carry a signature, and a `?` inside the
 * fragment is part of the inner address rather than a parameter of this one. Cut
 * the other way round, `…/x.cool#index=…/y?sig=a&sv=b` reads as a SAS and the
 * outer file skips a probe it needs.
 */
function queryNames(url: string): Set<string> {
  const out = new Set<string>()
  if (typeof url !== 'string') return out
  const fragment = url.indexOf('#')
  const address = fragment < 0 ? url : url.slice(0, fragment)
  const start = address.indexOf('?')
  if (start < 0) return out
  const query = address.slice(start + 1)
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    out.add(pair.slice(0, equals).toLowerCase())
  }
  return out
}

/** The table. `null` means no rule fired, which is most URLs. */
function rewrite(base: string, scopes: readonly BucketScope[] | undefined): string | null {
  // `gs://` before anything is parsed, because `URL` accepts the scheme and then
  // reports a `pathname` for it that differs between engines.
  const gs = /^gs:\/\/([^/]+)\/(.+)$/i.exec(base)
  if (gs !== null) return gcsMedia(gs[1], gs[2])

  const s3 = /^s3:\/\/([^/]+)\/(.+)$/i.exec(base)
  if (s3 !== null) return s3Url(s3[1], s3[2], scopes)

  let url: URL
  try {
    url = new URL(base)
  } catch {
    // A bare filename, a relative name, a scheme nobody here knows. All of them
    // are somebody else's question: `inferSource` answers `null` for them and
    // the picker opens a file dialog.
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.host.toLowerCase()

  // Dropbox: the host, and nothing else. There is no `dl=0` → `dl=1` rewrite in
  // any of the five igv repositories, and the query is what carries `rlkey` on a
  // modern `/scl/fi/` link — dropping it would turn a working share link into a
  // 404 (`docs/remote-sources.md` §4.1).
  if (host === 'www.dropbox.com') {
    url.host = 'dl.dropboxusercontent.com'
    return url.href
  }

  if (host === 'drive.google.com') {
    const id = driveId(url)
    // `supportsAllDrives` so a file on a shared drive resolves rather than
    // 404ing, which is what igv-utils sends and costs nothing for a file that is
    // not on one. The API key, when this browser has one, travels as a header
    // rather than in this URL — see `accessHeadersFor` in `s3/credentials.ts`.
    return id === null
      ? null
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}` +
          '?alt=media&supportsAllDrives=true'
  }

  // The console's own "download" link for a GCS object. Same destination as
  // `gs://`, because it names the same two things.
  if (host === 'storage.cloud.google.com') {
    const cut = url.pathname.replace(/^\/+/, '')
    const slash = cut.indexOf('/')
    if (slash <= 0 || slash === cut.length - 1) return null
    return gcsMedia(cut.slice(0, slash), cut.slice(slash + 1))
  }

  return null
}

/**
 * The Drive file id in a share link, or `null`.
 *
 * Two spellings, which are the three link shapes: `/file/d/<id>/…` is what the
 * *Share* button produces, and an `id` query parameter is what both `open?id=`
 * and `uc?export=download&id=` carry. Matching the parameter rather than the two
 * path names means a fourth Google spelling using the same parameter arrives
 * working, and a link carrying neither is left alone.
 */
function driveId(url: URL): string | null {
  const path = /\/file\/d\/([^/?#]+)/.exec(url.pathname)
  if (path !== null) return path[1]
  const query = url.searchParams.get('id')
  return query === null || query === '' ? null : query
}

/**
 * The JSON-API media URL for one GCS object.
 *
 * Not the XML host, and that is the whole point of the rewrite: measured against
 * the live service, `storage.googleapis.com/storage/v1/b/<b>/o/<o>?alt=media`
 * echoes the request origin and exposes `Content-Length` and `Content-Range` for
 * a public object in a bucket with **no CORS policy at all**, while the plain
 * `storage.googleapis.com/<b>/<o>` host sends no CORS headers until the owner
 * sets one (`docs/remote-sources.md` §2). A `gs://` link therefore opens for a
 * bucket nobody configured, which is the case a reader following a paper is in.
 */
function gcsMedia(bucket: string, object: string): string {
  return (
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}` +
    `/o/${encodeURIComponent(decodeOnce(object))}?alt=media`
  )
}

/**
 * `s3://<bucket>/<key>` as an https URL.
 *
 * A stored scope wins where one names the bucket, because that scope is this
 * browser's statement of *which endpoint that bucket lives on* — an `s3://` URI
 * for a MinIO or R2 bucket has no other way to learn it, and guessing AWS for it
 * would be a DNS failure with nothing to point at. Every scope over one bucket
 * yields the same URL (the endpoint and the addressing style are properties of
 * the bucket, not of the prefix), so the first match is taken rather than the
 * longest one `scopeFor` would pick.
 *
 * Without a scope it is AWS's virtual-hosted form, which is what `s3://` means
 * everywhere else it is written — the AWS CLI, `boto3`, every data availability
 * statement that carries one.
 */
function s3Url(bucket: string, key: string, scopes: readonly BucketScope[] | undefined): string {
  for (const scope of scopes ?? storedScopes()) {
    const address = addressOf(scope.base)
    if (address === null || address.bucket !== bucket) continue
    let root: URL
    try {
      root = new URL(scope.base)
    } catch {
      continue
    }
    // The same test `addressOf` makes, and it has to stay the same test: it
    // decided whether the bucket was in the host or in the first path segment,
    // and this decides where to put it back.
    const hosted = /^([^.]+)\.s3([.-]|$)/i.test(root.host)
    return `${root.origin}/${hosted ? '' : `${bucket}/`}${encodeKey(key)}`
  }
  return `https://${bucket}.s3.amazonaws.com/${encodeKey(key)}`
}

/** The stored scopes, or none where there is no storage to read them from. */
function storedScopes(): readonly BucketScope[] {
  try {
    return readScopes()
  } catch {
    return []
  }
}

/**
 * A key as the path of a URL: every segment escaped, the separators kept.
 *
 * Per segment because `/` separates keys and must survive as itself — the same
 * rule, in the other direction, that `decodeKey` in `s3/credentials.ts` and
 * `canonicalPath` in `s3/sigv4.ts` are both written to.
 */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(decodeOnce(segment)))
    .join('/')
}

/**
 * Percent-decode once, or return the text unchanged.
 *
 * Decoding before encoding is what makes the rewrite idempotent over an address
 * that was pasted already-escaped: `my%20run.cool` and `my run.cool` are the same
 * object and must produce the same URL. A literal `%` is a legal thing for a key
 * to contain and makes `decodeURIComponent` throw, and there the raw text is the
 * right answer — `100%_reads.cool` encodes to `100%25_reads.cool`, which is the
 * URL for the object that is actually there.
 */
function decodeOnce(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

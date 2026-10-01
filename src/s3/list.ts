/**
 * Reading a private prefix as a directory.
 *
 * This is the half of "put the lab's datasets on S3" that a URL box cannot do.
 * A reader who knows the URL of a file can already open it — that is what the
 * signer bought — but nobody remembers the key of a `.mcool` inside
 * `collections/hum53/2026-03-run2/`, and asking them to keep a list beside the
 * bucket is asking them to keep it in step with the bucket.
 *
 * `ListObjectsV2` with a delimiter answers exactly the question a folder view
 * asks: given a prefix, what are the immediate sub-prefixes and what are the
 * keys directly under it. S3 does the grouping, so one signed request draws one
 * level and nothing walks the whole bucket.
 *
 * ## The permission this needs, and the one it does not
 *
 * Listing is `s3:ListBucket` **on the bucket**, with a condition on the prefix
 * if the key should not see the rest — a different permission from
 * `s3:GetObject` on the objects, and one a reader may reasonably not have. So a
 * failure here is reported as "this key cannot list, but can still open files
 * by URL" rather than as a broken bucket: those are different problems with
 * different fixes and only one of them stops someone working.
 *
 * ## Signed and unsigned are the same request with one header fewer
 *
 * A scope may carry no credential (`s3/credentials.ts`), and a public prefix is
 * then listed by exactly the request below minus its `Authorization`. That is
 * not a lesser path: it is the *correct* request for public data, and it is
 * cheaper in a way worth naming, because it changes what can go wrong. An
 * unsigned `GET` with no custom headers is a **simple** CORS request, so it is
 * not preflighted — which means a bucket whose CORS policy was written for
 * public downloads (`GET`, `HEAD`, `Range`) already answers it, and the whole
 * class of preflight failures the signed path spends a paragraph explaining
 * cannot happen here.
 *
 * What is left is one permission, and it is the one a published bucket most
 * often lacks: `s3:ListBucket` granted to `*` in the **bucket policy**, as
 * against the `s3:GetObject` that makes the objects downloadable. A public
 * bucket that refuses to be listed is a normal configuration and not a fault,
 * and with no backend (SPECS C1) there is nothing this app can do about it — so
 * the 403 says which of the two grants is missing, and says that files under the
 * prefix still open by URL.
 *
 * ## Why the XML is parsed by hand
 *
 * `DOMParser` is not available in a worker and this runs on the main thread,
 * so it would be available — but the response is a fixed, flat shape of four
 * element names, and reaching for a parser means reaching for its failure modes
 * too: an XML document with an entity declaration in it is a class of problem
 * this has no reason to be exposed to. Two regular expressions over
 * S3's own output is the smaller surface.
 */

import { ViewerError } from '../errors'
import { addressOf, credentialOf, type BucketScope } from './credentials'
import { signS3Request } from './sigv4'

/** A sub-prefix: a folder, in the sense the UI means. */
export interface BucketFolder {
  /** The full key prefix, ending in `/`. */
  prefix: string
  /** Just the last segment, which is what the row shows. */
  name: string
}

/** One object under the prefix being listed. */
export interface BucketObject {
  key: string
  name: string
  size: number
  /** The URL that opens it, which is the scope's base with the key on the end. */
  url: string
}

export interface BucketListing {
  folders: BucketFolder[]
  objects: BucketObject[]
  /**
   * `true` when S3 stopped early.
   *
   * A thousand keys is the per-request cap and paging past it is one more
   * signed request per page. The UI says so rather than silently drawing a
   * partial folder, because "my file is not here" and "my file is on page two"
   * look identical otherwise.
   */
  truncated: boolean
}

/** Every `<Contents>` or `<CommonPrefixes>` block, whichever is asked for. */
function blocks(xml: string, tag: string): string[] {
  const out: string[] = []
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) out.push(match[1])
  return out
}

/**
 * The text of one element, with XML's five entities resolved.
 *
 * S3 escapes exactly these, and a key containing an ampersand is not exotic —
 * `ChIP_H3K4me3_&_input.bw` is the kind of name that comes off a sequencer
 * run sheet. Left unresolved it would produce a URL that 404s while looking
 * correct in the list.
 */
function field(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)
  if (match === null) return ''
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last, or an escaped `&amp;lt;` would decode twice.
    .replace(/&amp;/g, '&')
}

/**
 * One level of `prefix`, signed with `scope`'s credential.
 *
 * `prefix` is a full key prefix — what {@link BucketFolder.prefix} carries — so
 * navigating down is passing back what the previous call returned, and there is
 * no path arithmetic anywhere but here.
 */
export async function listPrefix(
  scope: BucketScope,
  prefix: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<BucketListing> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const address = addressOf(scope.base)
  if (address === null) {
    throw new ViewerError(
      'bad-uri',
      `${scope.base} does not look like a bucket URL: the viewer could not work out which ` +
        'part of it is the bucket name. Reading files under it by URL still works — only ' +
        'browsing needs this.',
      { base: scope.base },
    )
  }

  // Path-style endpoints put the bucket in the path; virtual-hosted ones have
  // it in the host already, and adding it again would list a bucket named after
  // a bucket.
  const root = scope.base.startsWith(`${address.endpoint}/${address.bucket}`)
    ? `${address.endpoint}/${address.bucket}`
    : address.endpoint
  const url = new URL(`${root}/`)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('delimiter', '/')
  url.searchParams.set('prefix', prefix)
  url.searchParams.set('max-keys', '1000')

  const credential = credentialOf(scope)
  const where = prefix === '' ? scope.base : prefix

  let response: Response
  try {
    response = await doFetch(url.href, {
      method: 'GET',
      // Unsigned where the scope has no key, which is a public prefix and not a
      // degraded private one. `headers: {}` rather than a branch at the call:
      // the request is otherwise identical, and writing it twice is how the two
      // paths would come to differ in a query parameter nobody noticed.
      headers:
        credential === null ? {} : signS3Request({ method: 'GET', url: url.href, credential }),
    })
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause)
    // The two paths fail for different reasons and the fix is different, so
    // guessing wrong here costs a reader the afternoon this message exists to
    // save. A signed request always preflights, so the first thing a
    // misconfigured bucket refuses is the `OPTIONS`; an unsigned one is a simple
    // request that is never preflighted, so reaching here means the bucket has
    // no CORS rule for this origin at all — or there is nothing at the URL.
    //
    // **Plain text, every name in it bare** (§26.4). These sentences are drawn
    // as DOM text in the Files column and the Connect dialog, where nothing
    // renders Markdown, so backticks round a header or a permission were two
    // stray marks either side of the one word a reader copies into a policy.
    throw new ViewerError(
      'remote-cors',
      credential === null
        ? `Could not list ${where} on ${address.bucket}. The request was unsigned and simple, so ` +
          'it was not preflighted — which leaves two causes. Either the bucket has no CORS ' +
          'configuration answering this origin (a bucket serving public downloads usually has ' +
          'one naming GET, HEAD and Range, and that policy answers this request as it stands), ' +
          'or the host is not an S3 endpoint. Files under this prefix still open by URL either ' +
          `way. Underlying error: ${why}`
        : `Could not list ${where} on ${address.bucket}. A signed ` +
          'request is preflighted, so the bucket CORS policy has to name Authorization, ' +
          'x-amz-date and x-amz-content-sha256 in AllowedHeaders. A public-data policy names ' +
          'Range and nothing else, which answers every unsigned read and refuses every signed ' +
          'one — so a bucket that serves the demos perfectly still fails here. AllowedOrigins ' +
          '["*"] is fine: the request sets Authorization from script and sends no cookies, so ' +
          `it is not credentialed in the CORS sense. Underlying error: ${why}`,
      { base: scope.base, prefix },
    )
  }

  if (response.status === 403) {
    throw new ViewerError(
      'bad-uri',
      credential === null
        ? `${address.bucket} does not allow anonymous listing of ${where}. Browsing a public ` +
          'prefix needs s3:ListBucket granted to everyone ("*") in the bucket policy, which is ' +
          'a different grant from the s3:GetObject that makes the objects downloadable — most ' +
          'published buckets grant the second and not the first. Files under this prefix still ' +
          'open by URL; add a key for it if you have one, or paste the file URL directly.'
        : `The key for ${scope.label} is not allowed to list ${address.bucket}. Browsing needs ` +
          's3:ListBucket on the bucket, which is a different permission from s3:GetObject on ' +
          'the objects — this key may well still open files under it by URL. Add s3:ListBucket ' +
          'scoped to the prefix, or paste the file URL directly.',
      { base: scope.base, prefix, status: 403 },
    )
  }
  if (!response.ok) {
    throw new ViewerError(
      'bad-uri',
      `${address.bucket} answered ${response.status} ${response.statusText} to a listing of ` +
        `${prefix === '' ? 'its root' : prefix}.`,
      { base: scope.base, prefix, status: response.status },
    )
  }

  const xml = await response.text()
  const folders = blocks(xml, 'CommonPrefixes')
    .map((block) => field(block, 'Prefix'))
    .filter((value) => value !== '')
    .map((value) => ({ prefix: value, name: value.slice(prefix.length).replace(/\/$/, '') }))

  const objects: BucketObject[] = []
  for (const block of blocks(xml, 'Contents')) {
    const key = field(block, 'Key')
    // S3 returns the prefix itself as a zero-byte key when someone has created
    // a "folder" through the console. It is not a file and listing it as one
    // produces a row that opens nothing.
    if (key === '' || key === prefix || key.endsWith('/')) continue
    objects.push({
      key,
      name: key.slice(prefix.length),
      size: Number(field(block, 'Size')) || 0,
      url: `${address.endpoint}/${
        root === address.endpoint ? '' : `${address.bucket}/`
      }${key.split('/').map(encodeURIComponent).join('/')}`,
    })
  }

  return { folders, objects, truncated: field(xml, 'IsTruncated') === 'true' }
}

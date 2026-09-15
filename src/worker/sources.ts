/**
 * The one place that constructs a byte source.
 *
 * `LocalFileSource` and `RemoteRangeSource` are built by other milestones (M1
 * and M5); isolating their constructors here means the worker body is written
 * against {@link ByteSource} alone and a change in how either is built touches
 * exactly this file.
 */

import { ViewerError } from '../errors'
import type { ByteSource } from '../types'
import { LocalFileSource } from '../sources/LocalFileSource'
import { RemoteRangeSource } from '../sources/RemoteRangeSource'
import { accessHeaders } from '../sources/access'
import type { S3Credential } from '../s3/sigv4'
import type { SourceSpec } from './protocol'
import { decodeAnnotationBytes } from '../annotations/parse'

/**
 * Build the byte source described by `spec`.
 *
 * The local path never touches the network: the `File` handed over by the drop
 * target is mounted directly, which is what makes "nothing is uploaded" a
 * property of the code rather than a promise in the README (spec §11).
 */
export async function createSource(spec: SourceSpec, watch?: ReadWatch): Promise<ByteSource> {
  if (spec.kind === 'local') {
    // Retained across opens of the *same* file, exactly as a remote one is.
    // Stepping through an mcool's resolutions or an mmetacool's entries reopens
    // the same object at a different group, and without this each click threw
    // away the mount and its slice cache and rebuilt both.
    const reused = borrowLocal(spec.file)
    if (reused !== null) return reused
    releaseSources()
    return keepLocal(spec.file, new LocalFileSource(spec.file))
  }
  // The reader answered the §12 gate with *download it whole*: one request for
  // the object, and every read after it is a memory read. Not cached under
  // `borrowRemote`'s key alongside a ranged mount of the same URL — they are
  // different objects with different costs, and handing back the ranged one
  // would silently ignore the choice that was just made.
  if (spec.reading === 'whole') {
    const held = borrowWhole(spec.url)
    if (held !== null) return held
    return keepWhole(spec.url, await wholeObjectOf(spec.url, accessOf(spec), watch))
  }
  const reading = spec.reading ?? ''
  const reused = borrowRemote(spec.url, reading)
  if (reused !== null) return reused
  // Present only for a private bucket or a host that wants a key; `undefined` is
  // the public path and is the one every demo takes. See `SourceSpec` on why
  // both arrive with the URL rather than being configured on this worker.
  const access = accessOf(spec)
  try {
    return keep(
      spec.url,
      reading,
      await RemoteRangeSource.open(spec.url, {
        ...access,
        // `fine` is the other half of the gate's answer: read the scattered
        // metadata in small pieces rather than dragging a megabyte across for
        // every 500-byte record of it.
        ...(spec.reading === 'fine'
          ? {
              chunkSize: FINE_CHUNK_SIZE,
              ...(watch?.onRead === undefined ? {} : { onRead: watch.onRead.bind(watch) }),
            }
          : {}),
      }),
    )
  } catch (err) {
    if (err instanceof ViewerError && err.code === 'remote-compressed') {
      // Retained like any other remote source, and here it matters most: this
      // path has already downloaded the whole object once.
      return keep(spec.url, reading, await wholeObject(spec.url, err, access))
    }
    if (err instanceof ViewerError) throw err
    // A failed probe is almost always one of two things, and the two need
    // different fixes, so they must not be reported as one (spec §10).
    const host = hostOf(spec.url)
    throw new ViewerError(
      'remote-cors',
      `Could not read ${spec.url}. The host ${host} either did not allow this ` +
        `page to read it (CORS must permit GET and HEAD and expose Content-Length ` +
        `and Content-Range) or refused the request outright. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { url: spec.url, host },
    )
  }
}

/**
 * The same source, built **outside** the cache above and owned by the caller.
 *
 * Everything else in this module keeps one local and one remote mount alive, so
 * that stepping through an `.mcool`'s resolutions reuses a slice cache rather
 * than rebuilding one. That is exactly wrong for a *second* file opened
 * alongside the first: {@link createSource}'s local road calls
 * {@link releaseSources} when the `File` differs, which would close the mount
 * the worker is already answering questions from — the map on screen, mid-task.
 *
 * So a caller that wants a second file for the length of one computation builds
 * it here and closes it itself. It has no slice cache to share and does not want
 * one: it is read once, sequence by sequence, and thrown away.
 */
export async function createDetachedSource(spec: SourceSpec): Promise<ByteSource> {
  if (spec.kind === 'local') return new LocalFileSource(spec.file)
  // Through {@link accessOf}, like every other road out of this module, and not
  // through `spec.credential` alone. A bare credential is what a bucket needs
  // and it is only half of what a request may carry: a store, a portal share link,
  // Google Drive and Dropbox are authorised by a **header**, and a second mount
  // built from the credential alone would send those bare. It would typecheck,
  // and the 401 would be reported against the file rather than against the
  // missing token.
  const access = accessOf(spec)
  if (spec.reading === 'whole') return await wholeObjectOf(spec.url, access)
  return await RemoteRangeSource.open(spec.url, {
    ...access,
    ...(spec.reading === 'fine' ? { chunkSize: FINE_CHUNK_SIZE } : {}),
  })
}

/**
 * The `.px2` beside a pairs file, or `null` when there is not one.
 *
 * Opportunistic in §3.4's exact sense: an index makes the import's cost known
 * before it starts and lets it be scoped, and its absence changes nothing
 * except that the whole file is read. So every failure here is `null` rather
 * than a throw — a 404, a CORS refusal, a bucket that does not have it. The one
 * thing that is *not* swallowed is a present-but-unreadable index, which
 * `parsePx2` refuses by name from the caller's side.
 *
 * Locally the index cannot be guessed at all — a `File` has no directory to
 * look in — so it arrives on the spec, paired by the drop target the way a
 * `.bai` is (`annotations/sidecar.ts`). Remotely it is `<url>.px2`, which is
 * what `pairix` writes.
 */
export async function openIndexSource(spec: SourceSpec): Promise<ByteSource | null> {
  if (spec.kind === 'local') {
    return spec.index === undefined ? null : new LocalFileSource(spec.index)
  }
  const url = `${stripQuery(spec.url)}.px2`
  try {
    // The matrix's own access, on its index: the two are one object published
    // twice, under the same prefix and behind the same key. The headers travel
    // for the same reason the credential does.
    return await RemoteRangeSource.open(url, accessOf(spec))
  } catch {
    return null
  }
}

/** A URL with its query string removed, so `.px2` lands on the object name. */
function stripQuery(url: string): string {
  const at = url.search(/[?#]/)
  return at < 0 ? url : url.slice(0, at)
}

/**
 * What authorises a request for this source: a signature, a header bag, both or
 * neither.
 *
 * One accessor because the two fields travel together at all five remote reads
 * in this file, and the spread that carries only the fields that are present is
 * exactly the line an omission hides in — `exactOptionalPropertyTypes` makes an
 * explicit `credential: undefined` a type error, so each site would otherwise
 * write the same two ternaries, and a site that wrote only the first would send
 * a Google object's request without its key and report the 403 against the file.
 */
function accessOf(spec: { credential?: S3Credential; headers?: Record<string, string> }): Access {
  return {
    ...(spec.credential === undefined ? {} : { credential: spec.credential }),
    ...(spec.headers === undefined ? {} : { headers: spec.headers }),
  }
}

/** What {@link accessOf} builds: the two things a request may need, or neither. */
interface Access {
  credential?: S3Credential
  headers?: Record<string, string>
}

/**
 * The access bag, or the bare credential that stood for it before there were
 * headers.
 *
 * {@link wholeObjectOf} and {@link wholeObject} take the bag {@link accessOf}
 * builds. A change landing beside this one adds a caller — a second file
 * opened for the length of one computation, outside the cache above — written
 * against the earlier shape, which passed the credential itself. Accepting
 * both is what lets the two land in either order without that call going
 * quietly unsigned in between: a parameter read only as `{ credential, headers }`
 * finds neither on a credential, sends the request bare, and the 403 is
 * reported against the file. A credential is told apart by `accessKeyId`,
 * which every credential carries and no bag does. Once both are in, that
 * caller moves to {@link accessOf} and this arm goes.
 */
export function asAccess(access: Access | S3Credential | undefined): Access {
  if (access === undefined) return {}
  return 'accessKeyId' in access ? { credential: access } : access
}

// ---------------------------------------------------------------------------
// Reusing one remote file across opens
// ---------------------------------------------------------------------------

/**
 * The remote file this worker currently has probed and mounted, if any.
 *
 * Opening a collection at its root is *two* opens of the same object: the first
 * discovers that an `.mcool` or `.mmetacool` is a container and names its
 * entries, the second opens the chosen entry, which is a group in the very same
 * file. Building a second {@link RemoteRangeSource} for it re-issued the `HEAD`
 * probe, the `bytes=0-0` range probe and every metadata chunk the first open had
 * already fetched — measured at 10 requests against 6 for the same file
 * addressed at its entry, with about 1.6 MB re-downloaded.
 *
 * So the source outlives the handle that borrowed it. It is released when a
 * *different* URL is opened, or when the session is closed.
 */
let remote: { url: string; reading: string; source: ByteSource } | null = null

/**
 * The dropped file this worker currently has mounted, if any.
 *
 * Keyed on the `File`/`Blob` object itself: the drop target hands the same
 * object across an entry switch, and object identity is the only honest test —
 * two files can share a name and a size, and a user who re-drops a file they
 * have edited must get the new bytes.
 */
let local: { file: unknown; source: ByteSource } | null = null

function keepLocal(file: unknown, source: ByteSource): ByteSource {
  local = { file, source }
  return retained(source)
}

function borrowLocal(file: unknown): ByteSource | null {
  if (local === null) return null
  if (local.file !== file) return null
  return retained(local.source)
}

/** Retain `source` as the worker's one remote file, and lend it out. */
function keep(url: string, reading: string, source: ByteSource): ByteSource {
  remote = { url, reading, source }
  return retained(source)
}

/**
 * A view of `source` whose `close()` does nothing.
 *
 * `Hdf5Handle` documents that it takes ownership of its byte source and closes
 * it, and that contract is worth keeping: it is what guarantees a dropped file
 * is released. The lending is expressed here instead, where the lifetime is
 * actually known, rather than by weakening the handle.
 */
function retained(source: ByteSource): ByteSource {
  return {
    id: source.id,
    size: source.size,
    isRemote: source.isRemote,
    mount: () => source.mount(),
    readBytes: (position, length) => source.readBytes(position, length),
    stats: () => source.stats(),
    close: () => {
      // Deliberately empty: {@link releaseSources} owns this one.
    },
  }
}

/** The mounted remote file for `url`, if this worker still holds it. */
function borrowRemote(url: string, reading: string): ByteSource | null {
  if (remote === null) {
    // A remote open after a local one: the dropped file is finished with, and
    // nothing else would free its slice cache.
    releaseSources()
    return null
  }
  // The *reading* is part of the identity, not just the URL. Re-opening a
  // container with the reader's answer to the §12 gate on it is the same object
  // read a different way, and handing back the mount built for the other way
  // silently discarded the answer — which left the gate asking the same
  // question of a source that could never satisfy it.
  if (remote.url !== url || remote.reading !== reading) {
    releaseSources()
    return null
  }
  return retained(remote.source)
}

/**
 * Drop the retained remote file. Called when the session closes, and whenever a
 * different URL is opened — one file at a time is all the worker ever holds.
 */
export function releaseSources(): void {
  remote?.source.close()
  remote = null
  local?.source.close()
  local = null
  wholeHeld?.source.close()
  wholeHeld = null
}

/**
 * Upper bound on a whole-object fallback, in **encoded** bytes — what actually
 * crosses the wire, which is the number the user waits on and the only one the
 * probe knows before committing.
 */
const MAX_WHOLE_OBJECT_BYTES = 128 << 20

/**
 * Download the whole object and mount it from memory.
 *
 * The escape hatch for a host that applies transfer compression: ranges cannot
 * address the file, but one unranged `GET` can, because the browser inflates a
 * *complete* encoded stream correctly. What comes back is bytes in memory —
 * exactly the state a dropped file is already in — so this reuses
 * {@link LocalFileSource} rather than inventing a third source.
 *
 * It is a fallback and not the default for the obvious reason: it abandons the
 * §12 bounded-read property, which is the whole point of the remote path. It is
 * still much better than the alternative, because the alternative is that the
 * published demo files do not open at all — GitHub Pages compresses every one
 * of them and gives no way to stop it (see docs/deploy.md).
 */
async function wholeObject(
  url: string,
  cause: ViewerError,
  access: Access | S3Credential = {},
): Promise<ByteSource> {
  const encoded = cause.detail['encodedLength']
  const size = typeof encoded === 'number' ? encoded : null
  if (size !== null && size > MAX_WHOLE_OBJECT_BYTES) {
    throw new ViewerError(
      'remote-too-large',
      `${cause.message} Downloading it whole is the only way left to read it, and at ` +
        `${Math.round(size / (1 << 20))} MB encoded that is too much to ask a browser tab for. ` +
        'Download it and drop it here instead.',
      { ...cause.detail, limit: MAX_WHOLE_OBJECT_BYTES },
    )
  }
  let bytes: Uint8Array
  try {
    // Authorised like every other read of the same object: this is a `GET` of
    // the whole thing rather than a range of it, which changes nothing about
    // what the host requires to answer it.
    const response = await fetch(url, {
      headers: accessHeaders({ url, method: 'GET', ...asAccess(access) }),
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (err) {
    // Re-raise the *original* diagnosis: the compression is the finding, and a
    // secondary network error while working around it should not replace it.
    throw new ViewerError(
      'remote-compressed',
      `${cause.message} Falling back to downloading it whole also failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      cause.detail,
    )
  }
  return new LocalFileSource(bytes, { name: url })
}

// ---------------------------------------------------------------------------
// The reader's answer to the §12 scool gate
// ---------------------------------------------------------------------------

/**
 * Chunk size for `reading: 'fine'` — the small-reads half of the gate.
 *
 * 16 KiB, from the measurement the gate exists for: the reads that list a
 * container's cells average about 500 bytes and are spread roughly 320 KB
 * apart, so every chunk size between the two extremes fetches most of the file.
 * At 16 KiB the listing pulls about 5% of the object; below it the request
 * count climbs with no further saving, since a chunk still costs a round trip
 * whatever its size.
 */
const FINE_CHUNK_SIZE = 16 << 10

/**
 * Upper bound on a whole-object download the reader **asked for**.
 *
 * Distinct from {@link MAX_WHOLE_OBJECT_BYTES}, and larger, because it is a
 * different question. That limit guards an involuntary fallback: nobody chose
 * it, nobody was told what it would cost, so it must not surprise a tab with a
 * quarter-gigabyte download. This one is the answer to a dialog that quoted the
 * size, so the only thing left to protect against is a tab that cannot hold the
 * bytes at all.
 */
// `2 * (1 << 30)`, not `2 << 30`: the shift operators coerce to *signed 32-bit*,
// so `2 << 30` is -2147483648 and every size on earth exceeds it. Which is not
// a hypothetical — it refused a 114 kB file with "more than a browser tab can
// hold", and the arithmetic is the only place that could have come from.
const MAX_CHOSEN_WHOLE_BYTES = 2 * (1 << 30)

/** The whole-object source a gated open asked for, downloaded and mounted. */
async function wholeObjectOf(
  url: string,
  access: Access | S3Credential = {},
  watch?: ReadWatch,
): Promise<ByteSource> {
  let bytes: Uint8Array
  try {
    const response = await fetch(url, {
      headers: accessHeaders({ url, method: 'GET', ...asAccess(access) }),
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const declared = Number(response.headers.get('Content-Length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_CHOSEN_WHOLE_BYTES) {
      throw new ViewerError(
        'remote-too-large',
        `${url} is ${(declared / (1 << 30)).toFixed(1)} GB, which is more than a browser tab ` +
          'can hold in memory. Download it and drop it here instead, where it is read from ' +
          'disk rather than held.',
        { url, size: declared, limit: MAX_CHOSEN_WHOLE_BYTES },
      )
    }
    bytes = await drain(response, watch)
  } catch (err) {
    if (err instanceof ViewerError || isAbort(err)) throw err
    throw new ViewerError(
      'remote-cors',
      `Could not download ${url} whole: ${err instanceof Error ? err.message : String(err)}`,
      { url, host: hostOf(url) },
    )
  }
  return new LocalFileSource(bytes, { name: url })
}

/**
 * The whole-object mount this worker is holding, if any.
 *
 * Its own slot rather than a value in {@link remote}, because the two are
 * different readings of one URL: opening a cell of a container already held
 * whole must find the whole one, and must not be handed a ranged mount that
 * would re-fetch everything the download already has.
 */
let wholeHeld: { url: string; source: ByteSource } | null = null

function keepWhole(url: string, source: ByteSource): ByteSource {
  releaseSources()
  wholeHeld = { url, source }
  return retained(source)
}

function borrowWhole(url: string): ByteSource | null {
  if (wholeHeld === null) return null
  if (wholeHeld.url !== url) {
    wholeHeld.source.close()
    wholeHeld = null
    return null
  }
  return retained(wholeHeld.source)
}

/**
 * Read a file whole, un-gzipping it if it is gzipped.
 *
 * The road for a container with **no index**, which is HiC-Pro and only
 * HiC-Pro (§3.9): both halves of the pair are read entirely by construction, so
 * neither belongs in the range-request LRU that exists to keep bounded reads
 * bounded. A `RemoteRangeSource` would fetch the same bytes in megabyte chunks,
 * evict them against its own cache ceiling as it went, and end up having
 * downloaded the file once anyway — with the extra property that a 1 GB matrix
 * would thrash a 64 MB cache the whole way.
 *
 * So this is one `GET`, or one `File` read, and then the bytes are parsed and
 * released. Nothing is retained: after the parse the map is typed arrays, and
 * the source has nothing left to answer.
 */
export async function readWhole(
  spec: SourceSpec | NonNullable<SourceSpec['bins']>,
  watch?: ReadWatch,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  if (spec.kind === 'local') {
    bytes = new Uint8Array(await spec.file.arrayBuffer())
  } else {
    let response: Response
    try {
      response = await fetch(spec.url, {
        headers: accessHeaders({ url: spec.url, method: 'GET', ...accessOf(spec) }),
      })
    } catch (err) {
      throw new ViewerError(
        'remote-cors',
        `Could not read ${spec.url}: ${err instanceof Error ? err.message : String(err)}. ` +
          `The host ${hostOf(spec.url)} must allow this page to GET it.`,
        { url: spec.url, host: hostOf(spec.url) },
      )
    }
    if (!response.ok) {
      throw new ViewerError(
        'remote-cors',
        `${spec.url} answered ${response.status} ${response.statusText}.`,
        { url: spec.url, status: response.status },
      )
    }
    bytes = await drain(response, watch)
  }
  // The two halves are shipped gzipped as often as not — `.matrix.gz` beside a
  // plain `.bed`, or both — and this is the same un-gzipping every text format
  // in the application already goes through, BGZF included.
  return decodeAnnotationBytes(bytes)
}

/**
 * What a whole-file read reports to, and asks whether to keep going.
 *
 * One object rather than two parameters because the two always travel together:
 * a read worth reporting is a read long enough to want stopping, and the two
 * paths that read a whole file — a gated remote object and a HiC-Pro pair — are
 * exactly the ones that offer a cancel.
 */
export interface ReadWatch {
  onProgress?(received: number, total: number): void
  cancelled?(): boolean
  /** Every ranged request of a source read in small pieces, as it lands. */
  onRead?(requests: number, bytes: number): void
}

/** Raised when the reader calls a download off; the shell reads it as a no-op. */
function abortError(): Error {
  const err = new Error('cancelled')
  err.name = 'AbortError'
  return err
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Collect a response body, reporting bytes as they land.
 *
 * `arrayBuffer()` is one await and no news, which is fine for a bounded read
 * and wrong for this one: a HiC-Pro matrix is read whole, so the download *is*
 * most of the wait, and a reader watching a spinner has no way to tell a slow
 * connection from a hung one. Streaming the body costs one loop and turns that
 * into a bar.
 *
 * `Content-Length` is the denominator where the host states one *and the
 * response was not re-encoded in transit*. Where it does not — a chunked
 * response, a proxy that strips it, or the compressed case below — the total is
 * reported as `0`, which the bar reads as *indeterminate* rather than as
 * *finished*.
 *
 * The one thing this function must never do is return a short buffer as though
 * it were the file. Both ways that can happen are refused rather than passed
 * on: a body that outruns its stated length keeps every byte, and one that
 * falls short of it raises.
 *
 * Falls back to `arrayBuffer()` where the platform has no streaming body, which
 * is only very old runtimes and the odd test double.
 */
async function drain(response: Response, watch?: ReadWatch): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length') ?? Number.NaN)
  // `Content-Length` counts the octets the host put on the wire, and on a
  // response it re-encoded in transit those are the *compressed* ones — while
  // the browser inflates the body and hands JS the decoded stream. Believing
  // the header there cut the file to a fraction of its length and returned it
  // as complete: a 100,000-byte HiC-Pro `.matrix` served pre-gzipped with
  // `Content-Encoding: gzip` and `Content-Length: 189` came back from here as
  // 189 bytes, and `parseMatrix` drew a contact map out of the surviving 0.2%
  // without raising. Nothing is wrong with the bytes — an unranged encoded
  // stream inflates correctly, which is the whole basis of the whole-object
  // fallback (docs/hosting.md, "Transfer compression breaks ranges") — so it is
  // the *number* that is distrusted: no denominator, an indeterminate bar, and
  // every byte kept.
  const stated = Number.isFinite(declared) && declared > 0 ? declared : 0
  const total = reEncoded(response) ? 0 : stated
  const body = response.body
  const onProgress = watch?.onProgress
  if (body === null || watch === undefined) {
    return new Uint8Array(await response.arrayBuffer())
  }
  const reader = body.getReader()
  // A cancel arriving mid-download is answered here rather than after it: the
  // download *is* most of the wait on the one path that offers a cancel at all,
  // and a button that does nothing until the thing it is stopping has finished
  // is worse than no button.
  const stop = (): never => {
    void reader.cancel()
    throw abortError()
  }
  let received = 0
  // Where the host states a length, the buffer is allocated **once** and filled
  // in place. That is not a micro-optimisation on this path: these files are
  // read whole, so holding the chunks and then copying them into a second
  // buffer means peak memory of twice the file — 540 MB transient on a 270 MB
  // matrix, on top of the arrays the parse is about to build.
  if (total > 0) {
    const out = new Uint8Array(total)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (watch.cancelled?.() === true) stop()
      if (value === undefined) continue
      // The body has outrun its own `Content-Length`. This used to keep what
      // fit and "let the parser judge the result", which is the same silent
      // truncation the paragraph above describes, reached by the other door:
      // a browser need not expose `Content-Encoding` to JS, so a re-encoded
      // response can arrive here with the header apparently absent and the
      // decoded body overflowing the encoded length. It is the identical tell
      // `RemoteRangeSource.windowOf` reads as transfer compression, and it
      // reaches the identical verdict — truncating to the claimed length "is
      // exactly the silent corruption this class exists to refuse". The parser
      // does not save it either: driven over 400 consecutive cut points, the
      // real `parseMatrix` accepted 111 of them without a word, one of which
      // built a plausible map from 28% of the contacts.
      //
      // Every byte arriving here is real file content, so the length is what
      // gets thrown away, not the data: hand the tail to the same collect-and-
      // join the no-length path uses and let the bar go indeterminate.
      if (received + value.length > total) {
        const held = [out.subarray(0, received), value]
        return await collectRest(reader, watch, stop, held, received + value.length)
      }
      out.set(value, received)
      received += value.length
      onProgress?.(received, total)
    }
    onProgress?.(received, total)
    if (received < total) {
      // The other direction: the stream ended before the length the host
      // promised. Returning `out.subarray(0, received)`, which is what this
      // did, is indistinguishable to every caller from a complete file —
      // `readWhole` hands it straight to a parser, and `wholeObjectOf` mounts
      // it as a `LocalFileSource` whose `length` then understates the object.
      // Missing bytes cannot be recovered from here the way surplus ones can,
      // so this is a refusal (§10). `remote-cors` is the union's general "the
      // host did not deliver the bytes" code — the same one `failCrossOrigin`
      // settles for — and the message carries the two numbers that matter.
      // `response.url` is empty on a synthesized response and on a test double.
      const where = response.url ?? ''
      throw new ViewerError(
        'remote-cors',
        `${where === '' ? 'The response' : where} ` +
          `ended after ${received} bytes, short of the ${total} its \`Content-Length\` promised. ` +
          'The transfer was cut off; a partial file is not opened as though it were whole. ' +
          'Retry it, or download the file and drop it here.',
        { url: response.url, received, declared: total },
      )
    }
    return out
  }
  // No length stated: collect, then join once. The bar is indeterminate here
  // and the second buffer is unavoidable, since the size is unknown until the
  // stream ends.
  return await collectRest(reader, watch, stop, [], 0)
}

/**
 * Read what is left of a body into `chunks` and join it once.
 *
 * The tail shared by the two indeterminate cases: a response that stated no
 * length, and one whose body outran the length it stated. `received` counts
 * what `chunks` already holds, so the bar keeps climbing across the switch from
 * the single-allocation path rather than restarting from zero.
 */
async function collectRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  watch: ReadWatch,
  stop: () => never,
  chunks: Uint8Array[],
  received: number,
): Promise<Uint8Array> {
  const onProgress = watch.onProgress
  if (received > 0) onProgress?.(received, 0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (watch.cancelled?.() === true) stop()
    if (value === undefined) continue
    chunks.push(value)
    received += value.length
    onProgress?.(received, 0)
  }
  const out = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/**
 * Whether the host re-encoded this response in transit.
 *
 * The empty header and the explicit `identity` are both "it did not"; anything
 * else — `gzip`, `br`, `deflate`, or a list of them — means the `Content-Length`
 * beside it counts encoded octets while `response.body` streams decoded ones.
 *
 * A deliberate twin of the private `reEncoding()` in `RemoteRangeSource`, which
 * asks the same question of a probe. Duplicated rather than shared because the
 * two live on opposite sides of the source/worker boundary and neither module
 * imports the other's internals; if a third caller appears, promote it.
 */
function reEncoded(response: Response): boolean {
  const raw = (response.headers.get('Content-Encoding') ?? '').trim().toLowerCase()
  return raw !== '' && raw !== 'identity'
}

/** Host part of a URL, or the raw string when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

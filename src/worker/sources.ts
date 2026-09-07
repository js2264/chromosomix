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
import { signS3Request, type S3Credential } from '../s3/sigv4'
import type { SourceSpec } from './protocol'

/**
 * Build the byte source described by `spec`.
 *
 * The local path never touches the network: the `File` handed over by the drop
 * target is mounted directly, which is what makes "nothing is uploaded" a
 * property of the code rather than a promise in the README (spec §11).
 */
export async function createSource(spec: SourceSpec): Promise<ByteSource> {
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
    return keepWhole(spec.url, await wholeObjectOf(spec.url, spec.credential))
  }
  const reading = spec.reading ?? ''
  const reused = borrowRemote(spec.url, reading)
  if (reused !== null) return reused
  // Present only for a private bucket; `undefined` is the public path and is
  // the one every demo takes. See `SourceSpec` on why the credential arrives
  // with the URL rather than being configured on this worker.
  const credential = spec.credential
  try {
    return keep(
      spec.url,
      reading,
      await RemoteRangeSource.open(spec.url, {
        ...(credential === undefined ? {} : { credential }),
        // `fine` is the other half of the gate's answer: read the scattered
        // metadata in small pieces rather than dragging a megabyte across for
        // every 500-byte record of it.
        ...(spec.reading === 'fine' ? { chunkSize: FINE_CHUNK_SIZE } : {}),
      }),
    )
  } catch (err) {
    if (err instanceof ViewerError && err.code === 'remote-compressed') {
      // Retained like any other remote source, and here it matters most: this
      // path has already downloaded the whole object once.
      return keep(spec.url, reading, await wholeObject(spec.url, err, credential))
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
    const credential = spec.credential
    return await RemoteRangeSource.open(url, credential === undefined ? {} : { credential })
  } catch {
    return null
  }
}

/** A URL with its query string removed, so `.px2` lands on the object name. */
function stripQuery(url: string): string {
  const at = url.search(/[?#]/)
  return at < 0 ? url : url.slice(0, at)
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
  credential?: S3Credential,
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
    // Signed like every other read of the same object: this is a `GET` of the
    // whole thing rather than a range of it, which changes nothing about what
    // the bucket requires to answer it.
    const response = await fetch(url, {
      headers: credential === undefined ? {} : signS3Request({ method: 'GET', url, credential }),
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
async function wholeObjectOf(url: string, credential?: S3Credential): Promise<ByteSource> {
  let bytes: Uint8Array
  try {
    const response = await fetch(url, {
      headers: credential === undefined ? {} : signS3Request({ method: 'GET', url, credential }),
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
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (err) {
    if (err instanceof ViewerError) throw err
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

/** Host part of a URL, or the raw string when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

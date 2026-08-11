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
  const reused = borrowRemote(spec.url)
  if (reused !== null) return reused
  // Present only for a private bucket; `undefined` is the public path and is
  // the one every demo takes. See `SourceSpec` on why the credential arrives
  // with the URL rather than being configured on this worker.
  const credential = spec.credential
  try {
    return keep(
      spec.url,
      await RemoteRangeSource.open(spec.url, credential === undefined ? {} : { credential }),
    )
  } catch (err) {
    if (err instanceof ViewerError && err.code === 'remote-compressed') {
      // Retained like any other remote source, and here it matters most: this
      // path has already downloaded the whole object once.
      return keep(spec.url, await wholeObject(spec.url, err, credential))
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
let remote: { url: string; source: ByteSource } | null = null

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
function keep(url: string, source: ByteSource): ByteSource {
  remote = { url, source }
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
    mount: () => source.mount(),
    readBytes: (position, length) => source.readBytes(position, length),
    stats: () => source.stats(),
    close: () => {
      // Deliberately empty: {@link releaseSources} owns this one.
    },
  }
}

/** The mounted remote file for `url`, if this worker still holds it. */
function borrowRemote(url: string): ByteSource | null {
  if (remote === null) {
    // A remote open after a local one: the dropped file is finished with, and
    // nothing else would free its slice cache.
    releaseSources()
    return null
  }
  if (remote.url !== url) {
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

/** Host part of a URL, or the raw string when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

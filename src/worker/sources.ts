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
import type { SourceSpec } from './protocol'

/**
 * Build the byte source described by `spec`.
 *
 * The local path never touches the network: the `File` handed over by the drop
 * target is mounted directly, which is what makes "nothing is uploaded" a
 * property of the code rather than a promise in the README (spec §11).
 */
export async function createSource(spec: SourceSpec): Promise<ByteSource> {
  if (spec.kind === 'local') return new LocalFileSource(spec.file)
  try {
    return await RemoteRangeSource.open(spec.url)
  } catch (err) {
    if (err instanceof ViewerError && err.code === 'remote-compressed') {
      return await wholeObject(spec.url, err)
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
async function wholeObject(url: string, cause: ViewerError): Promise<ByteSource> {
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
    const response = await fetch(url)
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

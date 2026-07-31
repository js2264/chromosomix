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

/** Host part of a URL, or the raw string when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * `file::group` URI parsing — a line-for-line mirror of `metacooler.uri`.
 *
 * The same syntax addresses an mmetacool entry, names a file in an error
 * message and serialises into the URL hash (spec §3.5), so all three agree by
 * construction rather than by convention.
 */

import { ViewerError } from './errors'
import { pyRepr } from './format'

/** A URI split into the file it names and the HDF5 group inside it. */
export interface ParsedUri {
  /** File path, exactly as written (never resolved or normalised). */
  path: string
  /** Absolute HDF5 group path; `'/'` for a plain `.metacool`. */
  group: string
}

/**
 * Split `file::group` into its two halves.
 *
 * ```
 * f.metacool                 → { path: 'f.metacool',  group: '/' }
 * f.mmetacool::entries/rep1  → { path: 'f.mmetacool', group: '/entries/rep1' }
 * f.mmetacool::              → { path: 'f.mmetacool', group: '/' }
 * ```
 *
 * Both halves are trimmed and the group is forced absolute, matching
 * `parse_uri`. Only the *first* `::` splits, so a group path may itself
 * contain one.
 *
 * @throws ViewerError `bad-uri` when the file half is empty (`''`, `'::g'`).
 */
export function parseUri(raw: string): ParsedUri {
  const sep = raw.indexOf('::')
  let path: string
  let group: string
  if (sep !== -1) {
    path = raw.slice(0, sep).trim()
    const groupPart = raw.slice(sep + 2).trim()
    if (!groupPart || groupPart === '/') {
      group = '/'
    } else {
      group = groupPart.startsWith('/') ? groupPart : `/${groupPart}`
    }
  } else {
    path = raw.trim()
    group = '/'
  }
  if (!path) {
    throw new ViewerError('bad-uri', `URI has an empty file path: ${pyRepr(raw)}`, { uri: raw })
  }
  return { path, group }
}

/**
 * Rebuild a URI from its halves. The inverse of {@link parseUri} for every
 * input it accepts, so a round-trip through the URL hash is stable.
 */
export function formatUri(path: string, group: string): string {
  return group === '/' ? path : `${path}::${group}`
}

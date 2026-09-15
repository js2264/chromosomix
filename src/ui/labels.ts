/**
 * Display-only URI helpers.
 *
 * The authoritative parser is `src/uri.ts`, which mirrors
 * `metacooler.uri.parse_uri` and is what the reader uses. What the UI needs is
 * narrower and purely cosmetic — a short crumb label, and the file part of a
 * `file::group` URI so the byte source is pointed at the file rather than at
 * the group — so it is done here rather than pulling the reader's parser into
 * the view layer.
 */

import { NameIndex } from '../genome/naming'
import { fmt } from './dom'

/** Split a `file::group` URI into its two parts, without validating either. */
export function splitUri(raw: string): { path: string; group: string } {
  const index = raw.indexOf('::')
  if (index < 0) return { path: raw.trim(), group: '/' }
  const path = raw.slice(0, index).trim()
  const group = raw.slice(index + 2).trim()
  if (group === '' || group === '/') return { path, group: '/' }
  return { path, group: group.startsWith('/') ? group : `/${group}` }
}

/** The last path segment of a URI: the file's own name, without any entry. */
export function fileBaseLabel(uri: string): string {
  const { path } = splitUri(uri)
  const last = path.split(/[\\/]/).pop() ?? path
  // A query string or a fragment is never part of a name: a presigned URL
  // carries its signature in the one and a Drive API address its `alt=media`,
  // a HiC-Pro matrix names its bins in the other. Shown without them, so a
  // tab reads as the file rather than as the request for it.
  const bare = last.split(/[?#]/)[0]
  return bare === '' ? last : bare
}

/**
 * The entry a `file::group/name` URI names, or `undefined` for a plain file.
 *
 * The *last* segment, so `file.mcool::/resolutions/1000` and
 * `file.mcool::resolutions/1000` both come back `1000` — the group is a fact
 * about the format and the entry is the thing a reader picked.
 */
export function entryLabel(uri: string): string | undefined {
  const { group } = splitUri(uri)
  if (group === '/') return undefined
  return group.split('/').filter((part) => part !== '').pop()
}

/** The last path segment of a URI, plus the entry name when there is one. */
export function fileLabel(uri: string): string {
  const base = fileBaseLabel(uri)
  const entry = entryLabel(uri)
  return entry === undefined ? base : `${base}::${entry}`
}

/**
 * The entry `delta` steps away in `names`, or `null` at either end.
 *
 * Not wrapping is deliberate: `›` on the last genome should look spent, not
 * jump to the first one and leave the user wondering how they got there.
 */
export function neighbour(names: string[], current: string, delta: number): string | null {
  const index = names.indexOf(current)
  if (index < 0) return null
  const next = index + delta
  return next >= 0 && next < names.length ? names[next] : null
}

/**
 * Which contig a region names, or `null` when it names none of them.
 *
 * The whole string is tried against the contig list *first*: a contig name may
 * legally contain a colon, and a file with a contig literally called `NODE_1:2`
 * must not have it read as coordinates on `NODE_1`. Only if that fails is the
 * text after the last colon treated as a coordinate suffix.
 *
 * Both attempts are made twice: once against the spelling the file uses, and —
 * only where that found nothing — once through {@link NameIndex}, so a region
 * carried in from a link, a bookmark or another file's nomenclature resolves to
 * this file's name for the same sequence (§5.9). The second pass is where the
 * cost is, and it is behind the first because it is only ever reached by a name
 * this file does not itself write: a session that opened one file and stayed
 * there never builds an index at all, which matters on the 154 k-contig
 * metacool where building one is not free.
 *
 * The name handed back is always **this file's**, whichever spelling arrived,
 * because every caller goes on to index a list with it.
 */
export function contigOf(region: string, names: readonly string[]): string | null {
  if (names.includes(region)) return region
  const colon = region.lastIndexOf(':')
  const head = colon < 0 ? null : region.slice(0, colon)
  if (head !== null && names.includes(head)) return head

  const index = NameIndex.for(names)
  const whole = index.find(region)
  if (whole !== null) return whole.name
  if (head === null) return null
  return index.find(head)?.name ?? null
}

/**
 * How a session describes the file it was made from, for the note that asks for
 * it back.
 *
 * Its own function, and a pure one, because the sentence is doing real work
 * rather than decorating: a local file is named in a config by its bare
 * filename, and `rep1.cool` is a name a reader may well have several of. "the
 * one that is 4.2 GB and was modified on 3 June" is the difference between
 * finding the right file and finding *a* file with the right name.
 *
 * `null` where the session cannot say — every session written before the field
 * existed, and every one made from a remote file, whose identity is its URL.
 * The caller then keeps the sentence it always had, rather than printing an
 * emptier version of a better one.
 *
 * Dates are the reader's own locale and to the day: the hour a file was written
 * is not what anybody recognises it by, and a full timestamp in a sentence about
 * finding a file is noise around the two numbers that identify it.
 */
export function sourceNote(
  source: { name: string; size?: number; lastModified?: number } | undefined,
): string | null {
  if (source === undefined) return null
  const parts: string[] = []
  if (source.size !== undefined && Number.isFinite(source.size)) parts.push(fmt.bytes(source.size))
  if (source.lastModified !== undefined && Number.isFinite(source.lastModified)) {
    const when = new Date(source.lastModified)
    if (!Number.isNaN(when.getTime())) {
      parts.push(
        `modified ${when.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}`,
      )
    }
  }
  return parts.length === 0 ? null : parts.join(', ')
}

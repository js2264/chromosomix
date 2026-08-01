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

/** Split a `file::group` URI into its two parts, without validating either. */
export function splitUri(raw: string): { path: string; group: string } {
  const index = raw.indexOf('::')
  if (index < 0) return { path: raw.trim(), group: '/' }
  const path = raw.slice(0, index).trim()
  const group = raw.slice(index + 2).trim()
  if (group === '' || group === '/') return { path, group: '/' }
  return { path, group: group.startsWith('/') ? group : `/${group}` }
}

/** The last path segment of a URI, plus the entry name when there is one. */
export function fileLabel(uri: string): string {
  const { path, group } = splitUri(uri)
  const base = path.split(/[\\/]/).pop() ?? path
  if (group === '/') return base
  const entry = group.split('/').filter((part) => part !== '').pop()
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
 */
export function contigOf(region: string, names: string[]): string | null {
  if (names.includes(region)) return region
  const colon = region.lastIndexOf(':')
  if (colon < 0) return null
  const head = region.slice(0, colon)
  return names.includes(head) ? head : null
}

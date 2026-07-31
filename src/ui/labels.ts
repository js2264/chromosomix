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

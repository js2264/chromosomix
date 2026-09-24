/**
 * A saved workspace, made ready for a window that cannot be handed a file (§27).
 *
 * A workspace names its files three ways, and `metacooler-plot` has to turn
 * every one of them into an address the headless page can read:
 *
 * - **An address** — `https://…`, `s3://…`, `gs://…`. Left as it is: the page
 *   reads it exactly as a reader's browser would, signed or not, and a host
 *   that serves the app's own site serves it to this page too.
 * - **A name relative to the workspace** — what a *published* workspace
 *   carries, `Yeast_ATAC.bw` beside `Yeast_microC.metacooler.json`, so a folder
 *   of data opens wherever it is copied (`state/SessionConfig.ts`'s
 *   `resolveConfig`). Resolved against the workspace's own directory — or its
 *   URL, when it was read from one.
 * - **A dropped file's name** — what a workspace saved from local files carries:
 *   `rep1.cool`, with no directory, because no page ever knew one. Looked for in
 *   the workspace's directory and in every `--data` directory.
 *
 * A file found on this machine is then served by the command itself, at a URL
 * whose last segment is the file's own name (`cli/serve.ts`) — so the labels,
 * the captions and the map names come out as a reader opening the same files
 * would see them.
 *
 * Every field of a tab that names a file is rewritten **through one function**,
 * which is `resolveConfig`'s own rule and for its reason: a companion's lanes,
 * looks and name are keyed on the companion's address, so rewriting the deck
 * and not the keys would put every placed track on the first map, every clip
 * on the lead's scale and every name back on its file — each a legal deck, and
 * none the one that was saved.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseMaps, serialiseMaps, withLocalCompanions } from '../panels/deck'
import type { SessionConfig } from '../state/SessionConfig'
import type { StoredEntry } from '../annotations/types'
import { formatUri, parseUri } from '../uri'
import { safeName, stemOf } from './names'

/** Where a workspace was read from, which is what its relative names are relative to. */
export type WorkspaceBase = { kind: 'dir'; path: string } | { kind: 'url'; url: string }

/** How a name arrived: a URI or a track's URL written in the file, or a dropped file's bare name. */
export type NameKind = 'named' | 'dropped'

/** What a name turned out to be. */
export type Located =
  | { kind: 'address'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'missing'; name: string }

/**
 * Whether a string is an address rather than a path.
 *
 * A scheme of two letters or more: `C:\data\x.cool` has a one-letter "scheme"
 * and is a path on Windows, which is the one place that distinction is real.
 * `file:` is an address that names this machine, so it is read as the path it is.
 */
export function isAddress(name: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(name) && !/^file:/i.test(name)
}

/** Whether a path names a file that exists. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Find what a name in a workspace refers to.
 *
 * `data` directories are searched by the name as written and then by its last
 * segment, because a workspace saved on another machine names files by paths
 * that machine had.
 */
export function locate(
  name: string,
  how: NameKind,
  base: WorkspaceBase,
  data: readonly string[],
): Located {
  const trimmed = name.trim()
  if (/^file:/i.test(trimmed)) {
    try {
      return found(fileURLToPath(trimmed), data)
    } catch {
      return { kind: 'missing', name }
    }
  }
  if (isAddress(trimmed)) return { kind: 'address', url: trimmed }
  if (isAbsolute(trimmed)) return found(trimmed, data)
  // A name written into a published workspace is relative to where the
  // workspace is: a folder copied to a bucket takes its data with it.
  if (how === 'named' && base.kind === 'url') {
    return { kind: 'address', url: new URL(trimmed, base.url).href }
  }
  const beside = base.kind === 'dir' ? [base.path] : []
  // A dropped file's name was never relative to anything, so the directories
  // the reader named are asked first; a named one is the workspace's own.
  const order = how === 'dropped' ? [...data, ...beside] : [...beside, ...data]
  for (const dir of order) {
    const path = join(dir, trimmed)
    if (isFile(path)) return { kind: 'file', path: resolve(path) }
  }
  for (const dir of order) {
    const path = join(dir, basename(trimmed))
    if (isFile(path)) return { kind: 'file', path: resolve(path) }
  }
  return { kind: 'missing', name }
}

/** An absolute path, or the same file under a `--data` directory, or missing. */
function found(path: string, data: readonly string[]): Located {
  if (isFile(path)) return { kind: 'file', path: resolve(path) }
  for (const dir of data) {
    const moved = join(dir, basename(path))
    if (isFile(moved)) return { kind: 'file', path: resolve(moved) }
  }
  return { kind: 'missing', name: path }
}

/** A name that could not be found, and which part of the tab it was. */
export interface MissingFile {
  name: string
  role: string
}

/**
 * The tab with every file it names pointed at the address `place` gives.
 *
 * `place` answers a name with the URL the page should read it at, or `null`
 * when there is nothing to read; each `null` is reported with what the file
 * was for. A missing *lead* leaves the tab's URI as it was — the command
 * refuses such a tab before it gets here — and a missing companion, second
 * file or track leaves the slot a reader's own window would leave: a vacancy,
 * no second map, a detached row.
 */
export function rewriteTab(
  tab: SessionConfig,
  place: (name: string, how: NameKind) => string | null,
): { tab: SessionConfig; missing: MissingFile[] } {
  const missing: MissingFile[] = []
  const at = (uri: string, role: string, how: NameKind = 'named'): string | null => {
    let parsed
    try {
      parsed = parseUri(uri)
    } catch {
      return uri
    }
    const url = place(parsed.path, how)
    if (url === null) {
      missing.push({ name: parsed.path, role })
      return null
    }
    return formatUri(url, parsed.group)
  }
  // The same answer for the same name, so the maps and the keys beside them —
  // lanes, looks, names — agree by construction rather than by two calls that
  // happen to return the same string.
  const cache = new Map<string, string | null>()
  const keyed = (uri: string): string => {
    if (!cache.has(uri)) {
      let parsed
      try {
        parsed = parseUri(uri)
      } catch {
        cache.set(uri, uri)
        return uri
      }
      const url = place(parsed.path, 'named')
      cache.set(uri, url === null ? null : formatUri(url, parsed.group))
    }
    return cache.get(uri) ?? uri
  }

  const uri = at(tab.state.uri, 'the map this tab is of') ?? tab.state.uri
  const uri2 =
    tab.state.uri2 === undefined ? undefined : (at(tab.state.uri2, 'the second map in the square') ?? undefined)
  // The local second file is the hash's `uri2` once it has an address: that is
  // the only difference between the two fields (§5.7).
  const compare =
    uri2 === undefined && tab.compare !== undefined
      ? (at(tab.compare, 'the second map in the square', 'dropped') ?? undefined)
      : undefined

  let maps = tab.state.maps
  if (maps !== undefined) {
    const refs = withLocalCompanions(parseMaps(maps), tab.deck?.locals).map((ref) => {
      if (ref.kind !== 'remote' && ref.kind !== 'local') return ref
      const url = at(ref.uri, 'a map beside the first', ref.kind === 'local' ? 'dropped' : 'named')
      // A dropped companion's lanes and look are keyed on its name, as a
      // remote one's are on its address: both keys now mean this URL.
      if (url !== null) cache.set(ref.uri, url)
      return url === null ? { kind: 'vacant' as const } : { kind: 'remote' as const, uri: url }
    })
    maps = serialiseMaps(refs)
  }

  const tracks = tab.tracks.map((track) => rewriteTrack(track, at))
  const lanes = tab.lanes?.map((lane) => ({ ...lane, uri: keyed(lane.uri) }))
  const deck: SessionConfig['deck'] = {
    ...(tab.deck?.starred === undefined ? {} : { starred: tab.deck.starred }),
    ...(tab.deck?.columns === undefined ? {} : { columns: tab.deck.columns }),
    ...(tab.deck?.looks === undefined
      ? {}
      : { looks: tab.deck.looks.map((look) => ({ ...look, uri: keyed(look.uri) })) }),
  }
  const mapNames =
    tab.mapNames === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(tab.mapNames).map(([key, name]) => [parseUri(keyed(key)).path, name]),
        )

  const out: SessionConfig = {
    ...tab,
    state: {
      ...tab.state,
      uri,
      ...(uri2 !== undefined ? { uri2 } : compare !== undefined ? { uri2: compare } : {}),
      ...(maps === undefined ? {} : { maps }),
    },
    tracks,
    deck,
    ...(lanes === undefined ? {} : { lanes }),
    ...(mapNames === undefined ? {} : { mapNames }),
  }
  if (uri2 === undefined && compare === undefined) delete out.state.uri2
  // The local second file has become an address, or there is none to open.
  delete out.compare
  // The identity of a local file, which the page compares against a file it
  // was *handed*; this one is read from an address, so there is nothing to
  // compare and the note it would write is about a different road.
  delete out.source
  return { tab: out, missing }
}

/** One track, pointed at an address — or left detached, as a reload leaves it. */
function rewriteTrack(
  track: StoredEntry,
  at: (uri: string, role: string, how?: NameKind) => string | null,
): StoredEntry {
  const source = track.source
  const role = `the track ${JSON.stringify(track.label)}`
  if (source.kind === 'remote' && source.url !== undefined) {
    const url = at(source.url, role)
    if (url === null) return track
    const index = source.index === undefined ? undefined : (at(source.index, `${role}'s index`) ?? undefined)
    return { ...track, source: { ...source, url, ...(index === undefined ? {} : { index }) } }
  }
  if (source.kind === 'local') {
    const url = at(source.name, role, 'dropped')
    if (url === null) return track
    return { ...track, source: { ...source, kind: 'remote', url } }
  }
  return track
}

/**
 * The tab, of another file (`--over`).
 *
 * Everything the tab is — the view, the tracks, the deck beside it, the marks,
 * the colour scale, the recorded analyses and the figures' styles — applied to
 * a different first map, which is what `metacooler-run replay --over` does for
 * the numbers. Three things go, because each was a fact about the file being
 * replaced: the tab's name and the first map's own name (a label for *that*
 * sample), and the identity of the local file it was saved from.
 *
 * A group is carried across where the new file names none and has the old
 * one's kind: `sample.mcool::/resolutions/5000` over `rep2.mcool` is `rep2`'s
 * 5 kb rung, which is the picture the tab was of.
 */
export function overTab(tab: SessionConfig, file: string): SessionConfig {
  const was = parseUri(tab.state.uri)
  const next = parseUri(file)
  const group = next.group !== '/' ? next.group : kindOf(was.path) === kindOf(next.path) ? was.group : '/'
  const out: SessionConfig = { ...tab, state: { ...tab.state, uri: formatUri(next.path, group) } }
  delete out.name
  delete out.source
  if (out.mapNames !== undefined) {
    const names = { ...out.mapNames }
    delete names[was.path]
    out.mapNames = names
  }
  return out
}

/** A file's kind by its extension, compression aside: `x.pairs.gz` and `y.pairs` are one kind. */
function kindOf(path: string): string {
  const name = basename(path).toLowerCase().replace(/\.(gz|bgz)$/, '')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}

/**
 * The stem every file one tab writes starts with.
 *
 * The tab's name where the reader gave it one — that is what they call this
 * piece of work — and its file's stem otherwise, as `metacooler-run` names a
 * result. Over another file, that file's stem, since the saved name was a name
 * for a different sample.
 */
export function tabStem(tab: SessionConfig): string {
  return tab.name !== undefined && tab.name.trim() !== '' ? safeName(tab.name) : safeName(stemOf(tab.state.uri))
}

/**
 * Make every stem in a list unique, the second of a name taking `-2`.
 *
 * Against every stem already handed out, not only against its own earlier
 * copies: tabs called `a`, `a` and `a-2` are three sets of files, and a
 * suffix that landed on the third tab's own name would write one over the other.
 */
export function uniqueStems(stems: readonly string[]): string[] {
  // Every name a tab has of its own, which no suffix may take from it.
  const own = new Set(stems)
  const used = new Set<string>()
  return stems.map((stem) => {
    let name = stem
    for (let count = 2; used.has(name); count++) {
      name = `${stem}-${count}`
      if (own.has(name)) name = stem
    }
    used.add(name)
    return name
  })
}

/**
 * The files one `--over` names: a path, an address, or a glob.
 *
 * A path is the shell's, so it is resolved against the directory the command
 * was run in — not the workspace's, which is what a name *inside* the workspace
 * is relative to. A glob is expanded here rather than by the shell because
 * `--over` takes one value, and `--over data/*.mcool` unquoted would hand it the
 * first file and the rest to nobody; quoted, it is every match, in order. `*`,
 * `?` and `[…]` match within one segment, and a group after `::` is kept on
 * every match, so `'runs/*.mcool::resolutions/5000'` is each file's 5 kb rung.
 * An empty result is the caller's to refuse: a pattern that names nothing is a
 * mistyped one.
 */
export function expandOver(value: string, cwd: string = process.cwd()): string[] {
  if (isAddress(value)) return [value]
  const { path, group } = parseUri(value)
  const local = /^file:/i.test(path) ? fileURLToPath(path) : path
  if (!/[*?[]/.test(local)) return [formatUri(resolve(cwd, local), group)]
  const absolute = resolve(cwd, local)
  const { root } = parsePath(absolute)
  const segments = absolute.slice(root.length).split(sep).filter((part) => part !== '')
  let found = [root]
  for (const [at, segment] of segments.entries()) {
    const last = at === segments.length - 1
    const next: string[] = []
    for (const dir of found) {
      if (!/[*?[]/.test(segment)) {
        next.push(join(dir, segment))
        continue
      }
      const pattern = globPattern(segment)
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names.sort()) {
        if (pattern.test(name)) next.push(join(dir, name))
      }
    }
    found = last ? next.filter(isFile) : next.filter(isDirectory)
  }
  return found.map((file) => formatUri(file, group))
}

/** One segment of a glob as a pattern: `*` and `?` within it, `[…]` as a class, a dotfile only by name. */
function globPattern(segment: string): RegExp {
  let out = ''
  for (let at = 0; at < segment.length; at++) {
    const char = segment[at]
    if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else if (char === '[') {
      const close = segment.indexOf(']', at + 2)
      if (close < 0) {
        out += '\\['
        continue
      }
      const body = segment.slice(at + 1, close)
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
      at = close
    } else out += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${segment.startsWith('.') ? '' : '(?!\\.)'}${out}$`)
}

/** Where a workspace path or URL lives, for resolving the names inside it. */
export function baseOf(workspace: string): WorkspaceBase {
  if (isAddress(workspace)) return { kind: 'url', url: workspace }
  const path = /^file:/i.test(workspace) ? fileURLToPath(workspace) : workspace
  return { kind: 'dir', path: dirname(resolve(path)) }
}

/** Whether a path is a directory — for `--data`, which is refused when it is not one. */
export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

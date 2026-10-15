/**
 * Where a local file is, in a folder the installed app keeps — so a session,
 * and a workspace exported from one, finds it there again (§20.6).
 *
 * A local file is named by its bare name everywhere in this app (`rep1.cool`),
 * and a name is not a place: no page can re-open a file by name, which is why a
 * reloaded session asks for its file (`state/handles.ts` covers a file the
 * reader chose with the open dialog). A file picked out of a *connected
 * folder* has a place, though — the folder, and its path inside it — and the
 * folder's grant reaches every file under it. So when the installed app keeps
 * folders, it keeps this too: the bare name, the folder it was in, and the path
 * from that folder's root. A session that comes back, here or from a workspace
 * file, asks for `rep1.cool` and finds it at `run2/hic/rep1.cool` through the
 * grant on `run2`, and nobody is asked to find it.
 *
 * ## Only where folders are kept
 *
 * Written to storage and into exported workspaces only in the installed app
 * ({@link directoriesKept}), for the reason folders are kept only there: a path
 * is a fact about somebody's disk, and a browser tab is a page on whatever
 * machine opened it. In a tab a location is held for the visit, like the folder
 * it is in.
 *
 * ## Found by the folder's id, then by its name
 *
 * The id is the one the app that connected the folder minted, and it is what a
 * session written on this machine names. A workspace opened by another
 * installation — another machine, a reinstall — knows a different id for the
 * same folder, or none, and there the folder's **name** is what is left to go
 * on, and then any kept folder the path is found in. Whichever folder answers,
 * the file found must carry the name asked for, the guard `state/handles.ts`
 * keeps for the same reason: a wrong file with every label agreeing with it is
 * worse than none.
 */

import { directoriesKept, directoryRows, directoryUsable, type DirectoryRow } from './directories'
import { handleKey, resolveHandle } from './handles'
import { fileInDirectory } from '../browse/local'
import type { PickedFile } from '../browse/folder'

/** One file's place in a connected folder. */
export interface FileLocation {
  /** The folder's id, in the app that connected it. */
  folder: string
  /** What the folder was called when it was connected: how another installation knows it. */
  name: string
  /** The path from the folder's root to the file: `hic/rep1.cool`. */
  path: string
}

/**
 * The locations a workspace carries, grouped by folder: each folder by its id
 * and name, and its files by name, each with its path inside it (§20.6).
 */
export interface FolderRecord {
  id: string
  name: string
  files: Record<string, string>
}

/** The one key the kept locations are under, under the prefix `state/stored.ts` sweeps. */
const KEY = 'chromosomix:locations'
/**
 * How many locations are kept: past this, the oldest go. A location is a few
 * dozen bytes, and a reader who has opened a thousand files from kept folders
 * is not reopening the first of them by name.
 */
const MAX_LOCATIONS = 500

/** Every location known, by `handleKey` — in memory always, in storage where kept. */
const locations = new Map<string, FileLocation>()
let hydrated = false

function hydrate(): void {
  if (hydrated) return
  hydrated = true
  if (!directoriesKept()) return
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return
    const stored = JSON.parse(raw) as Record<string, unknown>
    for (const [key, value] of Object.entries(stored)) {
      const location = asLocation(value)
      if (location !== null) locations.set(key, location)
    }
  } catch {
    // Nothing kept, which is a state every caller handles: the file is asked for.
  }
}

function persist(): void {
  if (!directoriesKept()) return
  while (locations.size > MAX_LOCATIONS) {
    const oldest = locations.keys().next().value
    if (oldest === undefined) break
    locations.delete(oldest)
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(locations)))
  } catch {
    // A storage that refuses holds nothing: the location lasts the visit.
  }
}

function asLocation(value: unknown): FileLocation | null {
  if (typeof value !== 'object' || value === null) return null
  const { folder, name, path } = value as Partial<FileLocation>
  return typeof folder === 'string' && typeof name === 'string' && typeof path === 'string' && path !== ''
    ? { folder, name, path }
    : null
}

/** Remember where a file picked out of a connected folder is — its sidecar index too. */
export function noteLocation(picked: PickedFile): void {
  const from = picked.folder
  if (from === undefined || picked.source.kind !== 'local') return
  hydrate()
  const note = (uri: string, path: string): void => {
    const key = handleKey(uri)
    // Re-inserted, so the order the cap trims by is the order of last use.
    locations.delete(key)
    locations.set(key, { folder: from.id, name: from.name, path })
  }
  note(picked.uri, from.path)
  if (picked.index !== undefined) {
    const slash = from.path.lastIndexOf('/')
    note(picked.index.name, `${slash === -1 ? '' : from.path.slice(0, slash + 1)}${picked.index.name}`)
  }
  persist()
}

/** Where a file is, by the name a session knows it by, or `null`. */
export function locationOf(uri: string): FileLocation | null {
  hydrate()
  return locations.get(handleKey(uri)) ?? null
}

/** Whether a file has a known place, for wording a note before it is asked for. */
export function hasLocation(uri: string): boolean {
  return locationOf(uri) !== null
}

/**
 * The folders a session's files are in, for a workspace to carry (§20.6) —
 * empty outside the installed app, which writes no path anywhere.
 */
export function foldersOf(uris: readonly string[]): FolderRecord[] {
  if (!directoriesKept()) return []
  const byFolder = new Map<string, FolderRecord>()
  for (const uri of uris) {
    const location = locationOf(uri)
    if (location === null) continue
    const held = byFolder.get(location.folder) ?? { id: location.folder, name: location.name, files: {} }
    held.files[handleKey(uri)] = location.path
    byFolder.set(location.folder, held)
  }
  return [...byFolder.values()]
}

/**
 * Take a workspace's folders as known places for its files — in the installed
 * app only, which is the one place a path is kept. A file this installation
 * already places somewhere keeps its own place: the reader picked it here.
 */
export function adoptFolders(records: readonly FolderRecord[] | undefined): void {
  if (records === undefined || records.length === 0 || !directoriesKept()) return
  hydrate()
  let changed = false
  for (const record of records) {
    for (const [name, path] of Object.entries(record.files)) {
      const key = handleKey(name)
      if (locations.has(key)) continue
      locations.set(key, { folder: record.id, name: record.name, path })
      changed = true
    }
  }
  if (changed) persist()
}

/**
 * The folders a workspace's files are in that this app has no grant for: what
 * a reader is asked to connect, by name, for the files to be found.
 */
export function missingFolders(records: readonly FolderRecord[] | undefined): FolderRecord[] {
  if (records === undefined || !directoriesKept()) return []
  const rows = directoryRows()
  return records.filter(
    (record) => !rows.some((row) => row.id === record.id || row.name === record.name),
  )
}

/**
 * The folder a file is known to be in that this app has no grant for — what
 * a session waiting on that file asks the reader to connect — or `null`.
 */
export function missingFolderOf(uri: string): FileLocation | null {
  const location = locationOf(uri)
  if (location === null || !directoriesKept()) return null
  const rows = directoryRows()
  return rows.some((row) => row.id === location.folder || row.name === location.name) ? null : location
}

/**
 * The file a known location points at, through its folder's grant, or `null`.
 *
 * `prompt` only from a gesture, for `state/handles.ts`'s reason: the folder's
 * permission is asked for here when it has lapsed, and without activation the
 * question is never shown.
 */
export async function resolveLocated(
  uri: string,
  options: { prompt?: boolean } = {},
): Promise<File | null> {
  const location = locationOf(uri)
  if (location === null) return null
  const name = handleKey(uri).split('/').pop() ?? ''
  const rows = directoryRows()
  // The folder by its id, then by its name, then any kept folder at all — the
  // path is checked in each, so a folder that merely shares a name answers only
  // if the file is where the workspace says.
  const candidates: DirectoryRow[] = [
    ...rows.filter((row) => row.id === location.folder),
    ...rows.filter((row) => row.id !== location.folder && row.name === location.name),
    ...rows.filter((row) => row.id !== location.folder && row.name !== location.name),
  ]
  for (const row of candidates) {
    if (!(await directoryUsable(row, options))) continue
    const handle = await fileInDirectory(row.handle, location.path)
    if (handle === null) continue
    try {
      const file = await handle.getFile()
      if (file.name === name) return file
    } catch {
      // Moved, or on a volume no longer mounted: the next candidate.
    }
  }
  return null
}

/**
 * A local file by its name: the grant the reader gave for the file itself,
 * then its place in a kept folder (§20.6). `null` when neither answers.
 */
export async function resolveLocal(uri: string, options: { prompt?: boolean } = {}): Promise<File | null> {
  return (await resolveHandle(uri, options)) ?? (await resolveLocated(uri, options))
}

/**
 * The files whose places are **stored** on this browser, by name — for the
 * stored-data screen, read from storage whether or not this page keeps them
 * (`directories.ts`'s `storedDirectoryNames` gives the reason).
 */
export function storedLocationNames(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return []
    return Object.keys(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return []
  }
}

/**
 * Forget every location: the copy in memory, and the key — part of what the
 * stored-data screen's "forget everything" does.
 */
export function forgetLocations(): void {
  locations.clear()
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // Nothing was stored, so nothing has to be removed.
  }
}

/** Forget every location held, and read storage afresh next time. **Tests only.** */
export function resetLocationsForTests(): void {
  locations.clear()
  hydrated = false
}

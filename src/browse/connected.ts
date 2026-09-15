/**
 * Every folder this window has connected, in one list.
 *
 * The two kinds are kept in two places, and deliberately: a bucket is a line in
 * `localStorage` (`s3/credentials.ts`) because it is a URL and possibly a key,
 * and a local directory is a capability object in IndexedDB
 * (`state/directories.ts`) because it is not text. Neither belongs in the
 * other's store. What was missing was the one place that reads both and answers
 * *what is connected* — which is the only question the Files panel asks.
 *
 * ## Rebuilt on demand rather than held
 *
 * {@link connectedFolders} reads both stores each time. That is a `localStorage`
 * parse and a walk of a `Map` — nothing that touches the network or the disk —
 * and it is what makes a key edited in the buckets dialog, or a bucket removed
 * there, show up in the panel without either screen knowing the other exists.
 * A held list would need invalidating from four places, and the one that forgot
 * would leave a folder on screen that no longer resolves.
 *
 * The exception is the **snapshot** folders, which have nothing behind them to
 * be rebuilt from: a `File[]` handed over by an `<input webkitdirectory>` lives
 * for as long as the page does and no longer. They are held here, in a module
 * variable, which is exactly the lifetime they have.
 */

import { readScopes, writeScopes } from '../s3/credentials'
import {
  directoryRows,
  directoryUsable,
  forgetDirectory,
  hydrateDirectories,
  mintDirectoryId,
  rememberDirectory,
} from '../state/directories'
import { bucketFolder } from './bucket'
import {
  chooseDirectory,
  chooseDirectoryFiles,
  directoryPickerSupported,
  handleFolder,
  snapshotFolder,
} from './local'
import type { ConnectedFolder } from './folder'

/**
 * Folders that exist only for this page load.
 *
 * See the header. Keyed by id so {@link disconnectFolder} can drop one.
 */
const snapshots = new Map<string, ConnectedFolder>()

/** Listeners for "the set of connected folders changed". */
const listeners = new Set<() => void>()

/**
 * Every connected folder: local directories first, then buckets.
 *
 * Local first because a reader who has just connected a directory is looking for
 * it, and because a bucket is reachable from three other places in the app while
 * this is the only door to a directory.
 */
export function connectedFolders(): ConnectedFolder[] {
  const local = directoryRows().map((row) => handleFolder(row.id, row.name, row.handle))
  const buckets = readScopes().map(bucketFolder)
  const others = sources.flatMap((source) => source.folders())
  return [...local, ...snapshots.values(), ...buckets, ...others]
}

/**
 * A third kind of place, registered by the module that knows how to list it.
 *
 * The disk and the bucket are composed above by name because they were here
 * first; a Drive folder or a Dropbox (§24.9) registers itself instead, so that
 * this file — the one every panel subscribes to — imports nothing that reaches
 * for a token, and a backend that is absent from a build (§19) simply never
 * registers. Rebuilt on demand like the rest: `folders()` reads its own store.
 */
export interface FolderSource {
  kind: ConnectedFolder['kind']
  /** Every folder of this kind, from wherever this backend keeps its rows. */
  folders(): ConnectedFolder[]
  /**
   * Whether a folder of this kind can be listed right now — a Drive folder
   * needs a signed-in account, and a reload signs nobody in. Default: yes.
   */
  usable?(folder: ConnectedFolder, options: { prompt?: boolean }): Promise<boolean>
  /**
   * Forget one folder of this kind — the panel's ×. A Drive row is one entry in
   * its own store; a Dropbox is its app key and the sign-in. Default: nothing.
   */
  disconnect?(id: string): void | Promise<void>
}

const sources: FolderSource[] = []

/** Register once, at module load; a second registration of a kind replaces the first. */
export function registerFolderSource(source: FolderSource): void {
  const at = sources.findIndex((held) => held.kind === source.kind)
  if (at < 0) sources.push(source)
  else sources[at] = source
}

/** One folder by the id a drag payload or a stored choice carries, or `null`. */
export function folderById(id: string): ConnectedFolder | null {
  return connectedFolders().find((folder) => folder.id === id) ?? null
}

/**
 * Read the durable half into memory. Called once, early, beside the file grants.
 *
 * Awaited by the panel before its first paint, so a reader who connected a
 * folder yesterday sees it there rather than watching it appear.
 */
export async function hydrateFolders(): Promise<void> {
  await hydrateDirectories()
}

/**
 * Connect a folder that lives only for this page load.
 *
 * The snapshot backend's door, and the whole of it: buckets and granted
 * directories are written to their own stores by the code that obtains them and
 * appear here on the next read, while this one has nowhere to be written, so it
 * is built and held in the same call. Answers the folder, because the caller's
 * next move is to show it.
 */
export function connectSnapshot(label: string, files: readonly File[]): ConnectedFolder {
  let id: string
  for (let n = snapshots.size; ; n++) {
    id = `snap:${n}-${Math.floor(Math.random() * 1e6).toString(36)}`
    if (!snapshots.has(id)) break
  }
  const folder = snapshotFolder(id, label, files)
  snapshots.set(id, folder)
  announce()
  return folder
}

/**
 * Ask the reader for a directory and connect whatever they point at.
 *
 * The one door to a directory on this machine, and it is here rather than in
 * the Connect dialog because two screens now open it — the dialog's *this
 * machine* pane and the landing page's *choose a folder…* — and the thing they
 * must not disagree about is which of the two shapes this browser gets.
 * Chromium and the desktop build hold a **grant**, which is written to
 * IndexedDB and is still connected after a reload; Firefox and Safari hand
 * over a **snapshot** of the file list, which is not (`browse/local.ts` has the
 * argument in full). Both end as a folder in the Files column, which is why one
 * function can answer both with an id.
 *
 * `null` when the reader cancels, which is not an error and wants no message:
 * neither picker rejects, so a caller has nothing to catch.
 *
 * **Call it from the click itself.** Both pickers need transient user
 * activation, so a caller that awaits anything first — a dynamic import, a
 * confirmation — is a caller whose picker may never open.
 */
export async function connectDirectory(): Promise<string | null> {
  if (directoryPickerSupported()) {
    const handle = await chooseDirectory()
    if (handle === null) return null
    const id = mintDirectoryId()
    await rememberDirectory(id, handle, handle.name)
    // `state/directories.ts` writes the row; this list is rebuilt on demand and
    // has to be told that something it reads from has changed.
    announce()
    return id
  }
  const files = await chooseDirectoryFiles()
  if (files.length === 0) return null
  // The first segment of `webkitRelativePath` is the directory's own name and
  // is the only place this path can learn it — there is no handle to ask.
  const name = (files[0].webkitRelativePath ?? '').split('/')[0]
  return connectSnapshot(name === '' ? 'folder' : name, files).id
}

/**
 * Disconnect one folder, whichever kind it is.
 *
 * A bucket's row carries its key, so disconnecting one is also the deletion of a
 * stored secret — which is the same thing the buckets dialog's × does, and is
 * why this goes through `writeScopes` rather than reaching into storage.
 */
export async function disconnectFolder(id: string): Promise<void> {
  if (snapshots.delete(id)) {
    announce()
    return
  }
  if (id.startsWith('bucket:')) {
    const scopeId = id.slice('bucket:'.length)
    writeScopes(readScopes().filter((scope) => scope.id !== scopeId))
    announce()
    return
  }
  // A registered kind forgets its own (§24.9): the source that lists a folder
  // is the one that knows what forgetting it means.
  const owner = sources.find((source) => source.folders().some((folder) => folder.id === id))
  if (owner !== undefined) {
    await owner.disconnect?.(id)
    announce()
    return
  }
  await forgetDirectory(id)
  announce()
}

/**
 * Whether a local folder can still be read, asking the reader where allowed.
 *
 * `prompt` may only be `true` inside a user gesture — `state/directories.ts`
 * says why. A bucket and a snapshot are always usable: one needs no permission
 * and the other is bytes already in hand.
 */
export async function folderUsable(
  folder: ConnectedFolder,
  options: { prompt?: boolean } = {},
): Promise<boolean> {
  if (folder.kind === 'bucket' || snapshots.has(folder.id)) return true
  const source = sources.find((held) => held.kind === folder.kind)
  if (source !== undefined) return source.usable === undefined ? true : source.usable(folder, options)
  const row = directoryRows().find((entry) => entry.id === folder.id)
  if (row === undefined) return false
  return directoryUsable(row, options)
}

/** Hear about folders being connected or disconnected. Returns the unsubscribe. */
export function subscribeFolders(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Tell every listener the list has changed.
 *
 * Exported because the two stores are written by the code that owns them — a
 * bucket by `ui/bucketForm.ts`, a directory by `state/directories.ts` — and
 * neither should have to import this module to be allowed to say so.
 */
export function announce(): void {
  for (const listener of listeners) listener()
}

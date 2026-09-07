/**
 * Permission to read a directory, kept across a reload.
 *
 * The same arrangement `state/handles.ts` makes for a single file, one level up,
 * and worth restating because the grant is genuinely wider. A
 * `FileSystemDirectoryHandle` is a **capability**: it cannot be read as text, it
 * names nothing a server could act on, and no byte of any file passes through
 * this module. What it allows is listing the directory and opening what is in it
 * — which is what makes a connected folder a folder rather than a bookmark — and
 * it allows that again tomorrow, without the reader being asked a second time.
 *
 * That is a real thing to have granted, so it is a thing the reader can see and
 * take back: every connected directory is a line in the stored-data screen with
 * the rest, and "forget everything" drops them (`state/stored.ts`). §11 is
 * untouched — nothing is uploaded and nothing is duplicated — and the read is
 * still `LocalFileSource` over a `File`, a slice at a time.
 *
 * ## Keyed by an id this module mints
 *
 * Not by name, and not by path — a handle has no path to key by. Two directories
 * called `run2/` on two disks are two connections, and a reader who wants both
 * should get both. The id is what a drag payload carries and what the panel's
 * "last folder" remembers, so it has to be stable across reloads and unique
 * across kinds; `folder.ts`'s prefixing rule is the other half of that.
 *
 * ## Hydrated once, like the file grants, and for the same reason
 *
 * `requestPermission` needs transient activation — a live user gesture — and a
 * gesture does not survive an IndexedDB round trip on a cold cache. So the rows
 * are read once at boot and the click path never awaits storage before it asks.
 */

import { STORES, store } from './idb'
import { crossOriginFrame } from '../embed'

/** One connected directory, and what it was called when it was connected. */
export interface DirectoryRow {
  id: string
  handle: FileSystemDirectoryHandle
  /** The directory's own name, which is what the panel shows. */
  name: string
  /** ISO stamp, for the account of what is stored. */
  seenAt: string
}

const directoryStore = store(STORES.directories)

/** Hydrated once at boot; every synchronous reader reads this, not IDB. */
const rows = new Map<string, DirectoryRow>()
/** The one hydration, memoised, so every caller awaits the same read. */
let hydration: Promise<void> | null = null

/**
 * `true` where this browser can remember a directory at all.
 *
 * Both halves are needed and neither implies the other, exactly as for file
 * grants: Safari has `FileSystemDirectoryHandle` for the origin-private
 * filesystem and no picker, so a check for the type alone would promise a
 * feature that cannot be granted.
 */
export function directoriesSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function' &&
    // And not from a frame somebody else's page put this window in, where the
    // picker is present and rejects — `handlesSupported` carries the argument.
    !crossOriginFrame() &&
    typeof indexedDB !== 'undefined'
  )
}

/**
 * Read the stored grants into memory. Called once, early.
 *
 * Failures are silent and total: a browser that cannot answer holds no grants,
 * which is the state every browser was in before this existed.
 */
export function hydrateDirectories(): Promise<void> {
  hydration ??= (async () => {
    if (!directoriesSupported()) return
    try {
      for (const key of await directoryStore.keys()) {
        const row = await directoryStore.get<DirectoryRow>(key)
        if (row !== null && row.handle !== undefined) rows.set(key, row)
      }
    } catch {
      /* no grants, which is a state the whole app already handles */
    }
  })()
  return hydration
}

/** Every remembered directory, in the order they were connected. */
export function directoryRows(): DirectoryRow[] {
  return [...rows.values()]
}

/** An id no stored row is using. Mirrors `ui/bucketForm.ts`'s reasoning. */
export function mintDirectoryId(): string {
  for (let n = rows.size; ; n++) {
    const id = `dir:${n}-${Math.floor(Math.random() * 1e6).toString(36)}`
    if (!rows.has(id)) return id
  }
}

/** Remember a directory the reader has just granted. */
export async function rememberDirectory(
  id: string,
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const row: DirectoryRow = { id, handle, name, seenAt: new Date().toISOString() }
  // Held in memory whether or not storage takes it, so a browser that refuses
  // IndexedDB still has the folder connected for this session — which is the
  // snapshot backend's behaviour, arrived at from the other direction.
  rows.set(id, row)
  if (!directoriesSupported()) return
  await directoryStore.set(id, row)
}

/**
 * Whether this grant is still good, asking the reader if `prompt` allows it.
 *
 * **`prompt` must be `true` only from inside a user gesture**, for
 * `state/handles.ts`'s reason: without transient activation
 * `requestPermission` resolves `'prompt'` without ever showing a dialog, so a
 * boot path that passed `true` would leave every folder dead and look like the
 * feature simply not working. Boot asks `queryPermission` and nothing else; a
 * click may ask for more.
 */
export async function directoryUsable(
  row: DirectoryRow,
  options: { prompt?: boolean } = {},
): Promise<boolean> {
  const query = row.handle.queryPermission
  // No permission methods at all is not a failure: it is a handle whose
  // permissions the browser does not model, and the first listing is the honest
  // test of whether it can still be read.
  if (typeof query !== 'function') return true
  let state: PermissionState
  try {
    state = await query.call(row.handle, { mode: 'read' })
  } catch {
    return false
  }
  if (state === 'granted') return true
  if (state === 'denied') {
    // A refusal is durable and the reader made it deliberately. Keeping the row
    // would mean asking again on every reload.
    await forgetDirectory(row.id)
    return false
  }
  if (options.prompt !== true) return false
  const request = row.handle.requestPermission
  if (typeof request !== 'function') return false
  try {
    return (await request.call(row.handle, { mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

/** Drop one grant. */
export async function forgetDirectory(id: string): Promise<void> {
  rows.delete(id)
  await directoryStore.delete(id)
}

/** Forget every grant. Part of what the "forget everything" control clears. */
export async function forgetAllDirectories(): Promise<void> {
  rows.clear()
  await directoryStore.clear()
}

/** Drop the memory copy so a test can hydrate a fresh one. **Tests only.** */
export function resetDirectoriesForTests(): void {
  rows.clear()
  hydration = null
}

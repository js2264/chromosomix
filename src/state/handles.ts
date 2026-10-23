/**
 * Permission to re-read a local file, kept across a reload.
 *
 * A dropped `File` is a set of bytes the page was handed once, and no browser
 * will hand them over again without a fresh gesture — which is a privacy
 * property and not a limitation (§11). A `FileSystemFileHandle` is the same
 * privacy property with a memory: the reader grants access to a *file*, the page
 * keeps the grant rather than the bytes, and a reload can ask for the same file
 * again without asking the reader to find it again.
 *
 * ## What is stored, and what is emphatically not
 *
 * A handle is a **capability**, not a path and not a copy. It cannot be read as
 * text, it cannot be sent anywhere, and it names nothing a server could act on.
 * No byte of any file passes through this module: `resolveHandle` answers with
 * the same kind of `File` object a drop produces, and `LocalFileSource` reads it
 * a slice at a time exactly as before. §11 and §12 are untouched — nothing is
 * uploaded and nothing is duplicated.
 *
 * ## Keyed by the file, not by the tab
 *
 * The key is `splitUri(uri).path` — the *second half* of what `fileMemoryKey`
 * builds, with the session id deliberately left off. A handle is a fact about a
 * file on disk rather than about a tab: two tabs on `rep1.cool` must share one
 * grant, or re-granting in the first leaves the second stale for no reason the
 * reader could deduce. It is also the only key three of the four callers *can*
 * use — a deck companion, an annotation track and the compare file are files
 * that no tab is "of".
 *
 * Stripping the group half (`::resolutions/1000`) comes free with `splitUri` and
 * is right for the same reason it is right in `UiMemory`: one `.mcool` at five
 * resolutions is one file, and one grant.
 *
 * ## Which means two files can collide, so the name is checked
 *
 * A local file's URI is its bare name, so `rep1.cool` from two directories is
 * one key. That is why a row carries the `name`, `size` and `lastModified` seen
 * at grant time and why {@link resolveHandle} refuses on a name mismatch rather
 * than opening: showing the wrong file with every label on screen agreeing with
 * it is the worst outcome available here, and strictly worse than asking the
 * reader to drop it again.
 *
 * A changed `size` or `lastModified` is **not** refused. Re-running a pipeline
 * over a file somebody is looking at is a legitimate thing to do, and the
 * reader asked for *that file*.
 *
 * ## Why the rows are held in memory as well
 *
 * `requestPermission` needs transient activation — a live user gesture — and a
 * gesture does not survive an IndexedDB round trip on a cold cache. So the rows
 * are hydrated once at boot and the click path never awaits storage before it
 * asks. It is also what lets {@link knownPaths} be synchronous, which the tab
 * strip needs: `Session.tabHint` is a getter, read in a loop by `paintTabs`, and
 * an async one would make the strip repaint a frame late on every state change.
 */

import { STORES, store } from './idb'
import { crossOriginFrame } from '../embed'
import { splitUri } from '../ui/labels'

/** One granted file, and what it looked like when the grant was made. */
export interface HandleRow {
  /** `splitUri(uri).path` — the key. */
  path: string
  handle: FileSystemFileHandle
  /** The file's own name at grant time; the collision guard. */
  name: string
  size: number
  lastModified: number
  /** ISO stamp, for the account of what is stored. */
  seenAt: string
}

const handleStore = store(STORES.handles)

/** Hydrated once at boot; the click path and `knownPaths` read this, not IDB. */
const rows = new Map<string, HandleRow>()
/** The one hydration, memoised, so every caller awaits the same read. */
let hydration: Promise<void> | null = null

/** The key for a URI: the file half, with any `::group` dropped. */
export function handleKey(uri: string): string {
  return splitUri(uri).path
}

/**
 * `true` where this browser can remember a file at all.
 *
 * All three parts are needed and none implies the others. Safari has
 * `FileSystemFileHandle` for the origin-private filesystem and no picker, so a
 * check for the type alone would promise a feature that cannot be granted — and
 * a **cross-origin frame** has the picker as a function that rejects when it is
 * called, which is the same promise made in a way `typeof` cannot see
 * (`src/embed.ts`).
 */
export function handlesSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showOpenFilePicker === 'function' &&
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
export function hydrateHandles(): Promise<void> {
  hydration ??= (async () => {
    if (!handlesSupported()) return
    try {
      for (const key of await handleStore.keys()) {
        const row = await handleStore.get<HandleRow>(key)
        if (row !== null && row.handle !== undefined) rows.set(key, row)
      }
    } catch {
      /* no grants, which is a state the whole app already handles */
    }
  })()
  return hydration
}

/**
 * The files this browser holds a grant for.
 *
 * Synchronous, and a snapshot: what it is used for is the wording of a tab's
 * tooltip and whether a picker says "drop it again" or "click to reopen", and
 * both are decisions that must not wait on storage.
 */
export function knownPaths(): ReadonlySet<string> {
  return new Set(rows.keys())
}

/** `true` when this URI is one {@link resolveHandle} could plausibly answer. */
export function hasHandle(uri: string): boolean {
  return rows.has(handleKey(uri))
}

/**
 * Remember the grant behind `file`, if there is one.
 *
 * Called where a file is *opened* rather than where it arrives, so a file
 * dropped on the window and never looked at leaves nothing behind.
 */
export async function rememberHandle(
  uri: string,
  handle: FileSystemFileHandle,
  file: File,
): Promise<void> {
  if (!handlesSupported()) return
  const row: HandleRow = {
    path: handleKey(uri),
    handle,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    seenAt: new Date().toISOString(),
  }
  rows.set(row.path, row)
  await handleStore.set(row.path, row)
}

/**
 * The file behind a remembered grant, or `null`.
 *
 * `null` covers every way this can fail to produce bytes — no grant, permission
 * refused, the file moved or deleted since, a different file now wearing the
 * name — because there is exactly one thing every caller does about all of
 * them, and it is what the app already does for a local file today: show the
 * picker, with its note, and wait for a gesture.
 *
 * **`prompt` must be `true` only from inside a user gesture.** Without transient
 * activation `requestPermission` resolves `'prompt'` without ever showing a
 * dialog, so a boot path that passed `true` would leave every tab detached
 * forever and look like the feature simply not working. The boot path asks
 * `queryPermission` and nothing else; a click may ask for more.
 */
export async function resolveHandle(
  uri: string,
  options: { prompt?: boolean } = {},
): Promise<File | null> {
  // Awaited rather than assumed, so no caller has to know whether boot has got
  // this far. In practice it is a settled promise long before any click — the
  // shell starts it as it is built — so this costs a microtask, which does not
  // spend the transient activation a permission prompt needs.
  await hydrateHandles()
  const row = rows.get(handleKey(uri))
  if (row === undefined) return null

  // No permission methods at all is not a failure: it is a browser whose handles
  // do not carry permissions, and the `getFile` below is the honest test of
  // whether this one can still be read.
  const query = row.handle.queryPermission
  if (typeof query === 'function') {
    let state: PermissionState
    try {
      state = await query.call(row.handle, { mode: 'read' })
    } catch {
      return null
    }
    if (state === 'denied') {
      // A refusal is durable and the reader made it deliberately. Keeping the
      // row would mean asking again on every reload.
      await forgetHandle(uri)
      return null
    }
    if (state !== 'granted') {
      if (options.prompt !== true) return null
      const request = row.handle.requestPermission
      if (typeof request !== 'function') return null
      try {
        if ((await request.call(row.handle, { mode: 'read' })) !== 'granted') return null
      } catch {
        return null
      }
    }
  }

  let file: File
  try {
    file = await row.handle.getFile()
  } catch {
    // Moved, renamed, deleted, or on a volume that is no longer mounted. The
    // grant is spent; keeping it would offer a file that cannot be opened.
    await forgetHandle(uri)
    return null
  }

  // The collision guard. Two files may share a name and therefore a key, and
  // opening the wrong one is worse than opening none: every label on screen
  // would agree with it. See the header.
  if (file.name !== row.name) {
    await forgetHandle(uri)
    return null
  }

  // A changed size or timestamp is *not* refused — a re-run pipeline overwriting
  // a file somebody is reading is a legitimate thing to want — but it is worth
  // keeping the row current, so the account of what is stored describes the file
  // as it is now.
  if (file.size !== row.size || file.lastModified !== row.lastModified) {
    const updated: HandleRow = { ...row, size: file.size, lastModified: file.lastModified }
    rows.set(updated.path, updated)
    void handleStore.set(updated.path, updated)
  }

  return file
}

/** Every tab, waiting to hear that a grant was renewed (§5.6). */
const listeners = new Set<() => void>()

/** Hear about a grant the reader renewed. Returns the unsubscribe. */
export function subscribeGrants(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Ask the reader to allow **every** remembered file again — the *allow access*
 * button, and nothing else.
 *
 * After a restart a stored grant comes back as `'prompt'`: the browser still
 * knows the file and will not hand it over until the reader says so, and saying
 * so needs the live gesture {@link resolveHandle} documents. So this is called
 * from inside a click, and is the one caller that passes `prompt`.
 *
 * The file the button was pressed for is asked first, so the prompt the reader
 * sees names the file they were looking at; then every other grant this browser
 * holds, in the same gesture, so one press brings back the map, its tracks,
 * their indexes and every other tab's files. Chromium's restore prompt answers
 * for all of them at once, and each later ask is then already granted and shows
 * nothing; a browser that asks file by file asks each while the click's
 * activation lasts, and any it does not reach keeps a button of its own. A
 * refusal of the first stops there: a reader who said no to the file they
 * pressed for has not asked to be asked about the rest.
 *
 * A success is announced, and each tab tries its waiting map and its detached
 * tracks again without a gesture.
 */
export async function allowHandles(first: string): Promise<File | null> {
  const file = await resolveHandle(first, { prompt: true })
  if (file === null) return null
  const pressed = handleKey(first)
  for (const key of [...rows.keys()]) {
    if (key === pressed) continue
    try {
      await resolveHandle(key, { prompt: true })
    } catch {
      /* one file the browser would not answer about costs that file alone */
    }
  }
  for (const listener of listeners) listener()
  return file
}

/** Drop one grant. */
export async function forgetHandle(uri: string): Promise<void> {
  const key = handleKey(uri)
  rows.delete(key)
  await handleStore.delete(key)
}

/** Every grant held, for the account of what is stored. */
export function handleRows(): HandleRow[] {
  return [...rows.values()]
}

/** Forget every grant. Part of what the "forget everything" control clears. */
export async function forgetAllHandles(): Promise<void> {
  rows.clear()
  await handleStore.clear()
}

/** Drop the memory copy so a test can hydrate a fresh one. **Tests only.** */
export function resetHandlesForTests(): void {
  rows.clear()
  listeners.clear()
  hydration = null
}

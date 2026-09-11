/**
 * Everything this browser is keeping on the reader's behalf, and the one call
 * that ends all of it.
 *
 * The app writes to four places — `localStorage` for preferences about this
 * window, `sessionStorage` for the train of thought inside one, and two
 * IndexedDB stores for what has to outlive the browser being closed — and until
 * now nothing could say so in one screen. That was defensible while everything
 * expired on its own. It stops being defensible the moment a record survives a
 * restart: a reader working on unpublished data, on a machine that may not be
 * theirs (§11), is owed both halves of the answer — what is held, and a way to
 * hold none of it.
 *
 * **The completeness of this module is the promise.** A "forget everything"
 * that cleared the new IndexedDB half while thirteen `localStorage` keys stayed
 * put — one of them holding an S3 secret key in cleartext — would be worse than
 * having no control at all, because the reader would believe it. So the sweep is
 * written as *one rule over a prefix* rather than as a list of key names: a
 * future key that forgets to register here is still caught, which a list cannot
 * promise.
 *
 * That the rule actually holds is checked rather than asserted.
 * `test/unit/stored.test.ts` reads every `setItem` in `src/`, resolves the ones
 * whose key is a literal or a module const and requires them to be under
 * {@link PREFIX} — and, for the four helpers whose key arrives as a parameter
 * and so cannot be settled by reading one file, pins the set so that a *fifth*
 * fails the test. An indirect writer is precisely where an unprefixed key would
 * hide from this sweep, so adding one should be a decision somebody makes with
 * the callers in front of them.
 */

import { readClientId } from '../auth/google'
import { clearAll as clearDurableStores } from './idb'
import { forgetAllDirectories, directoryRows, hydrateDirectories } from './directories'
import { forgetAllHandles, handleRows, hydrateHandles } from './handles'
import { forgetWorkspace, readWorkspace, suspendWorkspace } from './workspace'
import { readHubRows } from './hubs'
import { storedLines as driveStoredLines } from './drives'
import { storedLines as dropboxStoredLines } from '../auth/dropbox'

/** The one prefix every key this app writes begins with. */
export const PREFIX = 'metacooler-viewer:'

/** One line of the account: what is held, and how much of it. */
export interface StoredItem {
  label: string
  detail: string
}

/** Keys under our prefix in one storage, or `[]` where there is no storage. */
function keysOf(storage: Storage | undefined): string[] {
  const found: string[] = []
  try {
    if (storage === undefined) return found
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key !== null && key.startsWith(PREFIX)) found.push(key)
    }
  } catch {
    // A browser that refuses storage holds nothing, which is the honest answer
    // to the question this module is asked.
  }
  return found
}

function localKeys(): string[] {
  return keysOf(typeof window === 'undefined' ? undefined : window.localStorage)
}

function sessionKeys(): string[] {
  return keysOf(typeof window === 'undefined' ? undefined : window.sessionStorage)
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

/**
 * What is being kept, as lines a dialog can print.
 *
 * Counts rather than contents, with three deliberate exceptions: granted files,
 * connected folders and connected hubs are named, and bucket keys are called
 * what they are. Every other line describes something whose loss costs a reader
 * a preference; those describe what this browser knows about the reader's work,
 * and somebody deciding whether to press "forget everything" on a borrowed
 * machine needs to know it is there without having to press it to find out.
 */
export async function storedItems(): Promise<StoredItem[]> {
  const items: StoredItem[] = []

  const workspace = await readWorkspace()
  if (workspace !== null) {
    const when = workspace.savedAt === '' ? '' : `, saved ${workspace.savedAt.slice(0, 10)}`
    items.push({
      label: 'Remembered workspace',
      detail: `${count(workspace.sessions.length, 'tab', 'tabs')}${when}`,
    })
  }

  await hydrateHandles()
  const granted = handleRows()
  if (granted.length > 0) {
    items.push({
      label: 'Files you allowed',
      // Named rather than counted, because the names are the sensitive part:
      // a reader on a borrowed machine is owed the chance to see that
      // `patient_04_hic.cool` is in the list before deciding what to do.
      detail: granted.map((row) => row.name).join(', '),
    })
  }

  await hydrateDirectories()
  const folders = directoryRows()
  if (folders.length > 0) {
    items.push({
      label: 'Folders you connected',
      // Named for the same reason the files are, and with the grant spelled out
      // because it is wider than the one above: a directory grant is permission
      // to list *and read whatever is in it*, again after a restart, and a
      // reader deciding whether to press "forget everything" on a borrowed
      // machine should not have to infer that from the word "folder".
      detail: `${folders.map((row) => row.name).join(', ')} — this browser may list and read ` +
        'what is in them until you disconnect them',
    })
  }

  const session = sessionKeys()
  if (session.length > 0) {
    items.push({
      label: 'This window',
      detail: `${count(session.length, 'entry', 'entries')} — open tabs, filters, marks and bookmarks`,
    })
  }

  // Named rather than counted, on the rule the folders line follows: a hub is
  // somewhere the reader *connected to*, and the labels are the only part of it
  // worth reading back — a count would say a thing has been kept without saying
  // what. Nothing secret is in a row (a label and a URL), so the whole of it can
  // be shown; what it discloses is which lab's shelf this browser has been at,
  // which is exactly the fact a reader on a borrowed machine came here for.
  const hubs = readHubRows()
  if (hubs.length > 0) {
    items.push({
      label: 'Hubs you connected',
      detail: `${hubs.map((row) => row.label).join(', ')} — catalogue URLs, fetched only when ` +
        'you open one',
    })
  }

  // Remembered Drive folders (§24.9): named by label, the way folders are.
  items.push(...driveStoredLines())
  // The Dropbox app key (§24.9): a credential, named the way the bucket keys are.
  items.push(...dropboxStoredLines())

  const local = localKeys()
  // The keys that have a line of their own above or below, so none is also
  // counted as a *preference*: a reader told "3 settings — theme, column
  // widths, overlays" when one of the three is their bucket secret has been
  // told something false.
  const named = local.filter(
    (key) =>
      key === `${PREFIX}buckets` ||
      key === `${PREFIX}access` ||
      key === `${PREFIX}hubs` ||
      key === `${PREFIX}google` ||
      key === `${PREFIX}drives` ||
      key === `${PREFIX}dropbox`,
  )
  const access = local.filter((key) => key === `${PREFIX}access`)
  const preferences = local.length - named.length
  if (preferences > 0) {
    items.push({
      label: 'Preferences',
      detail: `${count(preferences, 'setting', 'settings')} — theme, column widths, overlays`,
    })
  }
  if (named.includes(`${PREFIX}buckets`)) {
    items.push({
      label: 'Bucket keys',
      // Named, not counted. See the docstring above.
      detail: 'Access keys for private buckets, stored in this browser in plain text',
    })
  }
  if (access.length > 0) {
    items.push({
      label: 'Google API key',
      // The second secret, and named for the first one's reason: it is a
      // credential to the reader's own Google project, it is readable by any
      // script on this origin, and a reader on a borrowed machine should not
      // have to press "forget everything" to find out it is there. Its own line
      // rather than a second sentence under Bucket keys, because a reader who
      // set one and not the other is owed a screen that says which.
      //
      // The bearer token a signed-in account produces is deliberately *not*
      // here: it is held in memory and never written, so there is nothing on
      // this machine for this screen to account for (SPECS §24.7).
      detail: 'Google API key, stored in this browser in plain text',
    })
  }

  // The client id, and it is the one row on this screen that is **printed in
  // full**. Every other named line withholds its value because the value is a
  // secret; a client id is the opposite — it is published in the page of every
  // site that uses Google sign-in, it authorises nothing on its own, and the
  // only question a reader has about it is *which project has this browser been
  // told to sign in to*, which a count cannot answer. Listed even so, because
  // "forget everything" removes it and a screen that claims to list what is kept
  // must not quietly leave one out.
  const clientId = readClientId()
  if (clientId !== null) {
    items.push({
      label: 'Google client id',
      detail:
        `${clientId} — your lab’s OAuth client, not a secret. The token signing in with it ` +
        'produces is held in memory only and is never stored.',
    })
  }

  return items
}

/**
 * Clear every store this app writes to.
 *
 * One prefix sweep over both web storages plus both IndexedDB stores. It does
 * *not* reload the page: what the reader asked for is that nothing be kept, and
 * a live tab holding a file it already opened is not something that was kept —
 * it is something they are looking at, and closing it for them would be
 * answering a question they did not ask.
 *
 * **And it stops this window writing the durable workspace again**, which is a
 * separate act from clearing the store and was for a while the missing one. See
 * `workspace.ts`'s {@link suspendWorkspace}: deleting the record answers the
 * question only until the reader's next pan, because `App.rememberDurably()`
 * runs on every state change and writes unconditionally — so the sweep was
 * honest for about half a second and the reader was told it was permanent.
 */
export async function forgetEverything(): Promise<void> {
  for (const key of localKeys()) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      /* nothing was stored, so nothing has to be removed */
    }
  }
  for (const key of sessionKeys()) {
    try {
      window.sessionStorage.removeItem(key)
    } catch {
      /* as above */
    }
  }
  // The workspace record, in both halves. Suspending is what makes the delete
  // mean anything past this moment — the store is cleared below by
  // `clearDurableStores` either way, and `App.rememberDurably()` would write a
  // fresh record on the reader's next state change or on `pagehide`, naming the
  // file they had been reading to whoever opened the site next (§11). Done
  // first and synchronously, before any `await` below yields to an event that
  // could queue a write behind the delete; `forgetWorkspace` then drops the key
  // itself, which is the call its own docstring already claimed this one makes.
  suspendWorkspace()
  await forgetWorkspace()
  // Both halves of the durable side. `clearDurableStores` empties the object
  // stores; these also drop the copies `handles.ts` and `directories.ts` hold in
  // memory, without which the sweep would report success while the current page
  // went on offering to reopen files whose grants it had just deleted — and, for
  // the folders, went on listing a directory it no longer had permission for.
  await forgetAllHandles()
  await forgetAllDirectories()
  await clearDurableStores()
}

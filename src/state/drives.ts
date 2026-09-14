/**
 * The Google Drive folders this browser has been told to keep (SPECS §20, §24.7).
 *
 * A Drive folder is the same kind of thing as a remembered store or a bucket
 * scope: a place the reader connected to by pasting an address, which they will
 * want again next week and should not have to find twice. So it is kept the same
 * way — one `localStorage` key under the app's prefix, so the stored-data screen
 * can name it and *forget everything* sweeps it without knowing it exists
 * (`state/stored.ts`) — and it is kept *only* that way. A row is a label and a
 * folder id, never a listing and never a token: the listing is a round trip made
 * with the reader's own account when they open the folder, and the token that
 * authorises it is held in memory by `s3/credentials.ts`'s bearer registry and
 * is never written down (§24.8).
 *
 * **Nothing here fetches anything, and nothing here knows what Drive is.** A
 * stored row becomes a `ConnectedFolder` in `browse/gdrive.ts`, which is the
 * module that talks to the API; this one is fifty lines of storage, which is why
 * it can be read in a build that has no sign-in at all.
 *
 * ## Why a folder id and not a link
 *
 * What the reader has in their hand is a browser address bar —
 * `https://drive.google.com/drive/u/0/folders/1AbC…` — and what the API wants is
 * the id in it. Storing the link and parsing it at every listing would be the
 * same parse run a thousand times against a value that cannot change; storing
 * the id means a row that fails is a row whose *id* is wrong, which is a
 * sentence a refusal can say. {@link folderIdFrom} is the one place the two
 * forms meet, and it answers `null` rather than guessing, because the guess is
 * a folder that 404s at the moment the reader opens it rather than at the moment
 * they paste it.
 *
 * The id `root` is Drive's own name for My Drive, not an invention here: the
 * files API accepts it wherever it accepts a folder id, so "the whole of my
 * Drive" needs no special case anywhere downstream.
 */

import type { StoredItem } from './stored'

const KEY = 'metacooler-viewer:drives'

/** One connected Drive folder: what to call it, and which folder it is. */
export interface DriveRow {
  /** `drive:<n>`, minted here and stable across edits. */
  id: string
  /** What the reader calls it. Shown in the panel; never sent anywhere. */
  label: string
  /** A Drive folder id, or `root` for My Drive. */
  folderId: string
}

const listeners = new Set<() => void>()

/** Storage that cannot throw — `s3/credentials.ts`'s reasoning, and its shape. */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(rows: readonly DriveRow[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows))
  } catch {
    /* a browser refusing storage still runs; the folder just is not kept */
  }
  for (const listener of listeners) listener()
}

/**
 * Every connected Drive folder, validated.
 *
 * Untrusted input like every other stored value in this app: a row is dropped
 * rather than repaired, because the repair for a missing folder id is a row in
 * the Files panel that answers a refusal when it is clicked. The label is the
 * one field that is repaired, to the folder id, since a row with no name is
 * still a folder the reader connected and a nameless button is worse than an
 * ugly one.
 */
export function readDriveRows(): DriveRow[] {
  const raw = readRaw()
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: DriveRow[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    const folderId = typeof row['folderId'] === 'string' ? row['folderId'] : ''
    if (id === '' || folderId === '' || seen.has(id)) continue
    seen.add(id)
    const label = typeof row['label'] === 'string' && row['label'] !== '' ? row['label'] : folderId
    out.push({ id, label, folderId })
  }
  return out
}

/**
 * Connect a Drive folder, or rename one already connected.
 *
 * Keyed on the **folder id** rather than on a minted id, which is what makes
 * connecting My Drive twice one row rather than two rows called the same thing
 * pointing at the same place — the rule `state/stores.ts` states for a URL, for
 * the same reason. The label of the later press wins, because it is the one the
 * reader has just typed.
 *
 * Answers with the stored row, because the caller's next move is to open the
 * folder and it needs the id to name it by.
 */
export function addDriveRow(row: { label: string; folderId: string }): DriveRow {
  const rows = readDriveRows()
  const label = row.label.trim() === '' ? row.folderId : row.label.trim()
  const found = rows.findIndex((held) => held.folderId === row.folderId)
  if (found >= 0) {
    const updated: DriveRow = { ...rows[found], label }
    rows[found] = updated
    write(rows)
    return updated
  }
  // The highest `drive:<n>` in use plus one, rather than the list's length: rows
  // are removed, and a length-based id would hand a new folder the id of one the
  // reader had just disconnected — which is the Files panel's remembered "last
  // folder" opening somebody else's Drive on the next reload.
  let next = 1
  for (const held of rows) {
    const number = /^drive:(\d+)$/.exec(held.id)
    if (number !== null) next = Math.max(next, Number(number[1]) + 1)
  }
  const added: DriveRow = { id: `drive:${next}`, label, folderId: row.folderId }
  rows.push(added)
  write(rows)
  return added
}

/** Forget one. Unknown ids are not an error — the row may be gone already. */
export function removeDriveRow(id: string): void {
  const rows = readDriveRows()
  const kept = rows.filter((row) => row.id !== id)
  if (kept.length === rows.length) return
  write(kept)
}

/**
 * Hear about a folder being connected or disconnected. Returns the unsubscribe.
 *
 * The Connect dialog and the Files panel can be looking at this list at the same
 * moment — the dialog is opened *from* the panel — so a list that refreshed only
 * on reload would show a folder in one of them and not the other.
 */
export function subscribeDrives(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * What this browser is keeping about Drive, as a line for the stored-data screen.
 *
 * Named rather than counted, on the rule `state/stored.ts` follows for the
 * folders and the stores: a Drive folder is somewhere the reader connected to, and
 * the labels are the part worth reading back before deciding what to do on a
 * borrowed machine. What is *not* here is the credential, and the line says so —
 * the token that lists these folders is held in memory and never written (§24.8),
 * so a reader who sees this line has been told the whole of what is on the disk.
 */
export function storedLines(): StoredItem[] {
  const rows = readDriveRows()
  if (rows.length === 0) return []
  return [
    {
      label: 'Drive folders you connected',
      detail:
        `${rows.map((row) => row.label).join(', ')} — a name and a folder id each, listed with ` +
        'your own Google account when you are signed in. No token is kept here.',
    },
  ]
}

/**
 * The folder id in whatever the reader pasted, or `null` if there is none.
 *
 * Three shapes, which are the three things somebody can have in hand: the
 * address bar of a folder they are looking at (`/drive/folders/<id>`, and the
 * `/drive/u/0/folders/<id>` form that appears once a browser is signed in to
 * more than one Google account), the id on its own, and nothing at all — which
 * is My Drive, because a reader who wants their whole Drive has no link to
 * copy for it.
 *
 * The query is dropped (`?usp=sharing` rides on every link the *Share* button
 * produces) and so is anything after the id, so the trailing-slash and the
 * `/view` spellings both land on the same id.
 *
 * Everything else answers `null` rather than being passed through as an id. A
 * file link — `/file/d/<id>/view` — is the one that matters: it is not a folder,
 * the API would answer an empty listing rather than an error for it, and an
 * empty folder is the one refusal a reader cannot tell from a mistake of their
 * own. `sources/rewrite.ts` is where a *file* link belongs, and it already opens
 * one.
 */
export function folderIdFrom(pasted: string): string | null {
  const text = pasted.trim()
  if (text === '') return 'root'
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.host.toLowerCase() !== 'drive.google.com') return null
  // `/folders/` rather than the whole path, so the `u/0` account segment and any
  // future one like it arrive working rather than as a fourth case to add here.
  const folder = /\/folders\/([^/?#]+)/.exec(url.pathname)
  if (folder !== null) return decodeURIComponent(folder[1])
  // Drive's own name for the top of an account, which is what the *My Drive*
  // link in its sidebar reads. Answered here so that pasting it does what it
  // plainly looks like it does, rather than refusing a link to the one folder
  // this box already offers by leaving the box empty.
  return /\/my-drive\/?$/.test(url.pathname) ? 'root' : null
}

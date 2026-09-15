/**
 * A Google Drive folder, as a folder (SPECS §20, §24.7).
 *
 * The third backend behind `browse/folder.ts`, and the first one that needs a
 * *credential the reader obtains for themselves*. A bucket prefix is opened with
 * a key the lab parked in this browser and a directory with a grant the browser
 * itself hands over; a Drive folder is listed with the reader's own Google
 * account, signed in through `auth/google.ts`, with a bearer token that lives in
 * memory for an hour and is never written down (§24.8). Everything odd about
 * this module follows from that one fact.
 *
 * ## Registered rather than composed
 *
 * `browse/connected.ts` names the disk and the bucket because they were there
 * first; this one calls `registerFolderSource` at its own module load, so the
 * file every panel subscribes to imports nothing that reaches for a token and a
 * build that leaves this module out simply has no Drive folders. The
 * registration is the last statement in the file, and importing the module is
 * the whole of wiring it up.
 *
 * ## Paths are ids, and that is why `labelOf` exists
 *
 * Drive has no paths. A folder is an id, a file is an id, and the only way to
 * ask *what is in this folder* is to query for the files whose `parents`
 * contains it. So a folder path here is the chain of ids from the connected
 * root, ending in the folder's own — `1Abc/1Def/` — which is what the crumb
 * trail needs to be able to rebuild a clickable path back up
 * (`ui/folderBrowse.ts` accumulates its crumb targets from the root by
 * appending segments), and **the last segment is the folder that gets listed**.
 * A path that is only `1Def/` therefore means the same folder, which is what a
 * bare folder id amounts to and what a path stored or dragged from somewhere
 * else may well carry.
 *
 * Nobody can read a chain of ids, so {@link ConnectedFolder.labelOf} answers
 * with the name Drive gave each id, from a map this module fills as it lists.
 * The map is **module-level and not per folder object**, which is the one thing
 * here that would be wrong if it were tidier: `connectedFolders()` rebuilds
 * every folder from its stored row on demand (that is how a row edited in one
 * dialog shows up in the panel), so a map held on the object would be emptied by
 * a repaint and the crumb trail would drop back to printing ids at the moment
 * the reader looked away. Ids are globally unique in Drive, so one map for the
 * window is not only cheaper but more correct.
 *
 * ## What is listed, and what is not
 *
 * `trashed=false`, because a trashed file is one the reader deleted. Google's
 * own document types — a Doc, a Sheet, a Slide, a shortcut — are **skipped
 * entirely** rather than drawn dimmed as an unopenable local file is (§20.5):
 * they have no bytes at all, so there is no download URL for one and nothing to
 * say about it beyond "this is not a file", which the reader knows. Everything
 * else is listed with its size, including the formats this viewer cannot open,
 * which the row draws dimmed for the reason §20.5 gives.
 *
 * `supportsAllDrives` and `includeItemsFromAllDrives` are on both calls, so a
 * folder on a **shared drive** — the arrangement most labs actually use — lists
 * and opens instead of answering as though it did not exist.
 *
 * ## Reading costs what a Drive read costs
 *
 * A pick resolves to the API's media URL, which is byte-for-byte what
 * `sources/rewrite.ts` produces for a pasted share link of the same file: a file
 * opened from this folder and the same file pasted into the URL box are one URI,
 * one grant and one tab memory rather than two. No headers travel on the source
 * — the worker boundary stamps them from the bearer registry (`s3/attach.ts`'s
 * `withAccess`), which is the only place that knows what a URL needs at the
 * moment it is read rather than at the moment it was chosen. And §24.7's warning
 * applies from here as much as from the URL box: Drive meters ranged reads
 * against the project that owns the client id, so this is a host the viewer
 * reads, not one it recommends.
 */

import { googleState } from '../auth/google'
import { ViewerError } from '../errors'
import { bearerFor } from '../s3/credentials'
import { applyAccess } from '../sources/access'
import { readDriveRows, type DriveRow, removeDriveRow } from '../state/drives'
import { registerFolderSource } from './connected'
import {
  LISTING_CAP,
  ordered,
  type ConnectedFolder,
  type FolderEntry,
  type FolderListing,
  type PickedFile,
} from './folder'

/** The Drive API's files collection — the one endpoint this module talks to. */
const FILES = 'https://www.googleapis.com/drive/v3/files'

/** The host the bearer token is registered for, named in a refusal's detail. */
const HOST = 'www.googleapis.com'

/** What Drive calls a folder. Everything else under the prefix has no bytes. */
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Docs, Sheets, Slides, shortcuts — Google's own types. See the header. */
const GOOGLE_APPS = 'application/vnd.google-apps.'

/**
 * Every folder id this window has seen a name for, filled as listings arrive.
 *
 * Module-level on purpose — see the header. Unbounded in principle and bounded
 * in practice by how many folders one reader opens in one page load, which is
 * the same bound `s3/credentials.ts`'s bearer map lives under.
 */
const names = new Map<string, string>()

/**
 * The folder a stored row describes.
 *
 * Built fresh from the row rather than held, as a bucket scope's folder is: the
 * row is what `localStorage` holds, so a folder renamed in the Connect dialog
 * takes effect without anything having to be told.
 */
export function driveFolder(row: DriveRow): ConnectedFolder {
  const root = `${row.folderId}/`

  return {
    id: row.id,
    label: row.label,
    kind: 'drive',
    root,
    // A row in `localStorage`, like a bucket. What a reload loses is the token,
    // not the folder — and that is what `usable` below is for, so that the panel
    // says "sign in" rather than drawing a folder whose every click fails.
    durable: true,

    labelOf(path: string): string {
      const id = folderIdIn(path) ?? row.folderId
      // The root is named by the reader, not by Drive: this app never asks the
      // API what the connected folder is called, because the reader typed a
      // label for it and that is the name they will recognise.
      if (id === row.folderId) return row.label
      return names.get(id) ?? id
    },

    async list(path: string): Promise<FolderListing> {
      const folderId = folderIdIn(path) ?? row.folderId
      // What a child's own path hangs off, so the crumb trail can walk back up.
      const under = path === '' ? root : path.endsWith('/') ? path : `${path}/`

      const entries: FolderEntry[] = []
      let pageToken: string | null = null
      let truncated = false
      for (;;) {
        const page = await listPage(row, folderId, pageToken)
        for (const file of page.files) {
          const entry = entryOf(file, under)
          if (entry !== null) entries.push(entry)
        }
        pageToken = page.nextPageToken
        // The cap is this application's, not Drive's: a page is a thousand
        // files and a folder may have forty thousand, so the walk stops here
        // and says so rather than drawing rows nobody asked for (§20.1).
        if (entries.length >= LISTING_CAP) {
          truncated = pageToken !== null || entries.length > LISTING_CAP
          break
        }
        if (pageToken === null) break
      }
      // Drive is asked for `orderBy=folder,name` and answers in that order;
      // running the shared `ordered` over it anyway is what makes a Drive folder
      // agree with a bucket and a disk, and it costs nothing on a sorted list.
      return { entries: ordered(entries).slice(0, LISTING_CAP), truncated }
    },

    async pick(entry: FolderEntry): Promise<PickedFile> {
      const url = driveMediaUrl(entry.path)
      return {
        uri: url,
        // No headers here, deliberately: what this URL needs is decided at the
        // worker boundary from the bearer registry, at the moment it is read
        // (§24.7). A copy taken now would be a token pasted into a session.
        source: { kind: 'remote', url },
        // The URL is an id, so nothing downstream could work the name out — and
        // the session names the map with it (§16.10).
        name: entry.name,
      }
    },
  }
}

/**
 * The media URL for one Drive file id.
 *
 * Identical to what `sources/rewrite.ts` builds for a pasted share link, down to
 * the `supportsAllDrives`, and that identity is the point rather than a
 * coincidence: `state/handles.ts` keys a grant by URI and `UiMemory` keys a
 * tab's memory by it, so two spellings of one file would be two sets of
 * colours and two entries in the reader's history for the same map.
 */
export function driveMediaUrl(fileId: string): string {
  return `${FILES}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`
}

/**
 * The URL that lists one folder, page by page.
 *
 * Written out rather than assembled with `URLSearchParams`, which would
 * percent-encode the quotes and the `=` inside `q` and produce a string nobody
 * can compare with Drive's own documentation — the query is a little language,
 * not a bag of values, and this is the one place its spelling is decided. The
 * folder id is encoded even so, because it is the one part that comes from
 * something a reader pasted.
 *
 * `pageSize` is {@link LISTING_CAP} so that one page is one screenful of the
 * cap: a folder under a thousand entries costs exactly one round trip.
 */
export function driveListUrl(folderId: string, pageToken: string | null): string {
  return (
    `${FILES}?q='${encodeURIComponent(folderId)}'+in+parents+and+trashed=false` +
    '&fields=nextPageToken,files(id,name,mimeType,size)' +
    `&pageSize=${LISTING_CAP}` +
    '&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=folder,name' +
    (pageToken === null ? '' : `&pageToken=${encodeURIComponent(pageToken)}`)
  )
}

/** One file as the API answers it, before anything has been believed about it. */
interface DriveFile {
  id?: unknown
  name?: unknown
  mimeType?: unknown
  size?: unknown
}

interface DrivePage {
  files: DriveFile[]
  nextPageToken: string | null
}

/**
 * One page of a listing, or a refusal that names the fix (§10).
 *
 * Four things can go wrong and a reader can act on three of them, so they are
 * told apart rather than reported as "could not list": there is no token, the
 * token is not accepted, the folder is not there, or the network never reached
 * Google. The first is by far the most common — a reload signs nobody in — and
 * it is the one that must not cost a request: nothing is fetched at all until
 * there is a credential to fetch with.
 */
async function listPage(
  row: DriveRow,
  folderId: string,
  pageToken: string | null,
): Promise<DrivePage> {
  const url = driveListUrl(folderId, pageToken)
  // Asked of the registry rather than of the sign-in module alone, because the
  // registry is what the request would actually carry: a token that expired
  // between the panel's check and this call is gone from here first.
  const token = googleState().signedIn ? bearerFor(url) : null
  if (token === null) {
    throw new ViewerError(
      'remote-cors',
      `${row.label} is a Google Drive folder and this tab is not signed in to Google, so there ` +
        'is nothing to list it with. Sign in under Connect → Google Drive. The folder is ' +
        'listed with your own account, and the token that does it lives only in this tab.',
      { host: HOST, folderId },
    )
  }

  let response: Response
  try {
    // Through `applyAccess` rather than a header literal, so this backend gets
    // whatever else a URL comes to need (§24.7's header bag, a signature) from
    // the one module that decides the merge order.
    response = await fetch(url, applyAccess(undefined, { url, headers: bearerHeader(token) }))
  } catch (cause) {
    throw new ViewerError(
      'remote-cors',
      `Could not reach ${HOST} to list ${row.label}. The browser refused or dropped the request ` +
        'before Drive answered, which is a network that blocks googleapis.com, or no network at ' +
        `all. Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { host: HOST, folderId },
    )
  }

  if (response.status === 401 || response.status === 403) {
    // `bad-uri` with the status and the host on it, which is the shape
    // `ui/ErrorView.ts` reads to decide whether to offer a sign-in — the same
    // refusal a private file's `HEAD` raises, so one screen answers both.
    throw new ViewerError(
      'bad-uri',
      `Google answered ${response.status} to a listing of ${row.label}. Either the token has ` +
        'run out — it lasts about an hour, and signing in again under Connect → Google Drive ' +
        'gets a new one — or this folder is not shared with the account that is signed ' +
        'in. Opening the folder in Drive with that account is the quickest way to tell which.',
      { host: HOST, folderId, status: response.status },
    )
  }
  if (response.status === 404) {
    throw new ViewerError(
      'bad-uri',
      `Google has no folder with the id ${folderId}, so ${row.label} points at nothing. A folder ` +
        'link looks like https://drive.google.com/drive/folders/<id> and the id is the part ' +
        'after the last slash; My Drive itself is the id root. Disconnect this folder and ' +
        'connect it again with the link from your browser’s address bar.',
      { host: HOST, folderId, status: 404 },
    )
  }
  if (!response.ok) {
    throw new ViewerError(
      'bad-uri',
      `Google answered ${response.status} ${response.statusText} to a listing of ${row.label}.`,
      { host: HOST, folderId, status: response.status },
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ViewerError(
      'format',
      `${HOST} answered a listing of ${row.label} with something that is not JSON, which is a ` +
        'captive portal or a proxy rather than Drive.',
      { host: HOST, folderId },
    )
  }
  const answer = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const files = Array.isArray(answer['files']) ? (answer['files'] as DriveFile[]) : []
  const next = answer['nextPageToken']
  return { files, nextPageToken: typeof next === 'string' && next !== '' ? next : null }
}

/** The one header a listing carries, in the shape `applyAccess` merges. */
function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/**
 * One API row as a folder entry, or `null` for a row with nothing behind it.
 *
 * A folder's name is remembered on the way past, which is the only moment this
 * module learns what an id is called — the crumb trail asks for it later, when
 * there is nothing left to ask Drive about.
 */
function entryOf(file: DriveFile, under: string): FolderEntry | null {
  const id = typeof file.id === 'string' ? file.id : ''
  const name = typeof file.name === 'string' && file.name !== '' ? file.name : id
  const mimeType = typeof file.mimeType === 'string' ? file.mimeType : ''
  if (id === '') return null

  if (mimeType === FOLDER_MIME) {
    names.set(id, name)
    return { kind: 'folder', name, path: `${under}${id}/`, size: null }
  }
  // A Doc, a Sheet, a shortcut. See the header: there are no bytes to offer and
  // no refusal worth drawing a row for.
  if (mimeType.startsWith(GOOGLE_APPS)) return null

  return { kind: 'file', name, path: id, size: sizeOf(file.size) }
}

/**
 * Drive's `size`, which arrives as a decimal **string** because a file may be
 * larger than a JSON number is trusted to carry.
 *
 * `null` rather than `0` where it is missing or unreadable: the folder view
 * prints nothing for an unknown size and `0 B` for a known empty one, and a
 * contact map reported as empty is a row a reader will not click.
 */
function sizeOf(size: unknown): number | null {
  if (typeof size === 'number') return Number.isFinite(size) ? size : null
  if (typeof size !== 'string' || size === '') return null
  const parsed = Number(size)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The folder a path names: its **last** segment, or `null` for an empty path.
 *
 * See the header. A listing and the crumb trail both hand back `1Abc/1Def/`,
 * and a bare id is `1Def/`; both mean the folder `1Def`, so this reads from the
 * end rather than the start and no caller has to know what the others do.
 */
function folderIdIn(path: string): string | null {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length === 0 ? null : parts[parts.length - 1]
}

/**
 * The registration, and the whole of this backend's wiring.
 *
 * `folders()` reads the store on every call, like every other source: a folder
 * connected in the dialog appears in the panel because the panel repaints, not
 * because anybody told it. `usable` is what the seam grew a `usable` for — a
 * reload signs nobody in, so a Drive folder that was perfectly good yesterday
 * cannot be listed this morning, and the panel should say so before the reader
 * clicks into a refusal.
 */
registerFolderSource({
  kind: 'drive',
  folders: () => readDriveRows().map(driveFolder),
  usable: async () => googleState().signedIn,
  // The panel's × forgets the row and nothing else: the account it was listed
  // with is the reader's, and signing out is a different button.
  disconnect: (id) => removeDriveRow(id),
})

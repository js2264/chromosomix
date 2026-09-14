/**
 * A signed-in Dropbox, as a folder.
 *
 * One folder per account and no rows to keep: where a bucket scope is a URL and
 * possibly a key, and a Drive folder is an id somebody pasted, a Dropbox is
 * simply *whatever the app was granted* — the whole account, or the app’s own
 * folder inside it, depending on how the lab registered the app (§24.7,
 * `docs/hosting.md`). There is nothing to choose and therefore nothing to store,
 * so the backend answers one folder whenever an app key exists and none when it
 * does not, and `auth/dropbox.ts` holds the only stored thing there is.
 *
 * ## Paths are Dropbox’s own, with one adjustment at the boundary
 *
 * A Dropbox path is already what `browse/folder.ts` asks for — a readable,
 * slash-separated string — so a file is `/Hi-C/2024/rep1.mcool`, a folder is
 * `/Hi-C/2024/` with the trailing slash this interface requires, and the crumb
 * trail splits on it with no `labelOf` needed. The API disagrees in exactly two
 * places and both are handled here rather than upstream: it wants **`''` for the
 * root** (a lone `/` is an error) and it wants **no trailing slash** on anything
 * else. That is `apiPath` below, one line, and it is the only path arithmetic
 * in this file.
 *
 * ## What a pick hands over, and how long it is good for
 *
 * `get_temporary_link` answers a URL on `dl.dropboxusercontent.com` that is
 * **unsigned in the header sense and expires after four hours** — it carries its
 * own authorisation in the URL, which is why the account’s bearer token must not
 * be registered for that host and is not (`DROPBOX_HOSTS`). Two consequences
 * worth stating rather than discovering:
 *
 * - It is a working range-readable URL for those four hours, so the session
 *   opened from it behaves exactly like one opened from a share link — which is
 *   also what makes it shareable-looking and short-lived at the same time. A
 *   link copied out of the address bar into a message stops working the same
 *   afternoon.
 * - When it expires, the read fails the way any expired link fails, and there
 *   is deliberately **nothing special** for it here: a `401` or `409` on a file
 *   that has been open for hours is answered by picking the file again, which
 *   mints a new link. Watching the clock and silently re-minting would be this
 *   module holding a token on behalf of a session that did not ask it to.
 *
 * ## Everything goes through the bearer registry
 *
 * Every request below is a `POST` through {@link applyAccess} over
 * `accessHeadersFor`, which is the pair that turns the bearer held for
 * `api.dropboxapi.com` into an `Authorization` header. So the token is read at
 * the moment of the request rather than captured when the folder was built, and
 * a folder object that outlives a sign-out stops working the instant the
 * sign-out happens rather than one repaint later.
 */

import { ViewerError } from '../errors'
import { accessHeadersFor } from '../s3/credentials'
import { applyAccess } from '../sources/access'
import { DROPBOX_PERMISSIONS, dropboxState, readAppKey, clearAppKey, signOut } from '../auth/dropbox'
import { registerFolderSource } from './connected'
import {
  LISTING_CAP,
  ordered,
  type ConnectedFolder,
  type FolderEntry,
  type FolderListing,
  type PickedFile,
} from './folder'

/**
 * The id of the one Dropbox folder.
 *
 * A constant rather than a minted id, because there is exactly one of these per
 * window and nothing to number: the id space is shared with `bucket:<n>` and
 * `dir:<n>` (`browse/bucket.ts` says why it is prefixed at all), and `dropbox`
 * collides with neither. It is what the Connect dialog hands to `done` and what
 * a dragged row carries.
 */
export const DROPBOX_FOLDER_ID = 'dropbox'

/** Where the three calls this backend makes live. */
const API = 'https://api.dropboxapi.com'

/**
 * The Dropbox this account has granted the app.
 *
 * Built fresh on every read of the folder list rather than held, for
 * `bucketFolder`’s reason: the panel rebuilds from the store whenever it
 * repaints, and a held object would be a second answer about what is connected.
 */
export function dropboxFolder(): ConnectedFolder {
  return {
    id: DROPBOX_FOLDER_ID,
    label: 'Dropbox',
    kind: 'dropbox',
    root: '/',
    // The app key is a line in `localStorage`, so the folder is still here after
    // a reload — the *sign-in* is not, which is a different question and the one
    // `usable` below answers.
    durable: true,

    async list(path: string): Promise<FolderListing> {
      const where = path === '/' ? 'your Dropbox' : path
      const entries: FolderEntry[] = []
      let truncated = false
      let page = await call(
        '/2/files/list_folder',
        {
          path: apiPath(path),
          limit: LISTING_CAP,
          // Dropbox Paper documents and other cloud-editable entries have no
          // bytes to read, so they are asked not to be listed at all — the same
          // decision the Drive backend makes about a Google Doc, made by the
          // API instead of by a filter here.
          include_non_downloadable_files: false,
        },
        where,
      )
      for (;;) {
        for (const raw of asArray(page['entries'])) {
          // One past the cap is enough to know there are more, and this is
          // where the count stops: asking Dropbox for the next page of a folder
          // with forty thousand files in it would be round trips spent on rows
          // nothing will draw.
          if (entries.length >= LISTING_CAP) {
            truncated = true
            break
          }
          const entry = entryOf(raw)
          if (entry !== null) entries.push(entry)
        }
        if (truncated || page['has_more'] !== true) break
        const cursor = page['cursor']
        if (typeof cursor !== 'string' || cursor === '') {
          // `has_more` with nothing to continue from. Not a thing the API does,
          // but the listing is demonstrably short either way, and saying so is
          // what stops "my file is not here" reading as "my file does not
          // exist".
          truncated = true
          break
        }
        page = await call('/2/files/list_folder/continue', { cursor }, where)
      }
      // Sorted here rather than trusted: `list_folder` documents no order, and
      // a reader who connects a bucket and a Dropbox of the same data and sees
      // two different orders has been given two folder views rather than one.
      return { entries: ordered(entries).slice(0, LISTING_CAP), truncated }
    },

    async pick(entry: FolderEntry): Promise<PickedFile> {
      const answer = await call('/2/files/get_temporary_link', { path: entry.path }, entry.path)
      const link = answer['link']
      if (typeof link !== 'string' || link === '') {
        throw new ViewerError(
          'bad-uri',
          `Dropbox answered with no download link for ${entry.name}, so there is nothing to ` +
            'open. Picking it again is the only thing to do about it.',
          { path: entry.path },
        )
      }
      return {
        uri: link,
        source: { kind: 'remote', url: link },
        // The name, because the link does not carry it in any form worth
        // parsing — a temporary link is an opaque `/apitl/` path — and a session
        // named after one would be named after a URL that has since expired
        // (§16.10).
        name: entry.name,
      }
    },
  }
}

/**
 * The path the API wants for the path this interface uses.
 *
 * `''` for the root, because `list_folder` rejects a lone `/`; and no trailing
 * slash for anything else, because `browse/folder.ts` requires one and Dropbox
 * refuses one. Two rules, one place.
 */
function apiPath(path: string): string {
  return path.replace(/\/+$/, '')
}

/** One entry of a listing, or `null` for a row this viewer has no use for. */
function entryOf(raw: unknown): FolderEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const tag = row['.tag']
  if (tag !== 'folder' && tag !== 'file') return null
  const name = typeof row['name'] === 'string' ? row['name'] : ''
  // `path_display` is the cased path meant to be shown; `path_lower` is the one
  // the API always has. The display form is preferred because it is what the
  // reader sees in Dropbox itself, and either is accepted back by every call
  // here — so falling back costs nothing but the capitals.
  const path =
    typeof row['path_display'] === 'string' && row['path_display'] !== ''
      ? row['path_display']
      : typeof row['path_lower'] === 'string'
        ? row['path_lower']
        : ''
  if (name === '' || path === '') return null
  if (tag === 'folder') return { kind: 'folder', name, path: `${path}/`, size: null }
  const size = Number(row['size'])
  return { kind: 'file', name, path, size: Number.isFinite(size) ? size : null }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * One API call, with the token on it and every refusal named.
 *
 * `where` is what the message calls the thing that was being read — a path, or
 * "your Dropbox" for the root — because the four refusals below are all about
 * *something*, and a message that names only the status leaves the reader
 * looking for which folder it was about.
 */
async function call(
  endpoint: string,
  body: Record<string, unknown>,
  where: string,
): Promise<Record<string, unknown>> {
  // Asked before the request rather than let the `401` answer it: a reader who
  // has not signed in gets a sentence naming the gesture, instead of a status
  // code from a host they never knowingly contacted.
  if (!dropboxState().signedIn) {
    throw new ViewerError(
      'remote-cors',
      `Sign in to Dropbox to read ${where}. Connect → Dropbox has the button; the listing API ` +
        'takes a token and nothing else, so there is no public way to browse a Dropbox the way ' +
        'a public bucket can be browsed.',
      { where },
    )
  }
  const url = `${API}${endpoint}`
  let response: Response
  try {
    response = await globalThis.fetch(
      url,
      // Through `applyAccess` over `accessHeadersFor`, which is the pair every
      // main-thread request in this app uses (`state/store.ts`, `app/Session.ts`):
      // the bearer is read from the registry at the moment of the request
      // (SPECS §24.7) rather than captured when the folder was built, and the
      // `Content-Type` below rides under it rather than over it.
      applyAccess(
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        { url, method: 'POST', headers: accessHeadersFor(url) },
      ),
    )
  } catch (cause) {
    throw new ViewerError(
      'remote-cors',
      `Could not reach Dropbox to read ${where}. A network that blocks api.dropboxapi.com ` +
        'blocks browsing entirely; a file already opened from a temporary link keeps working ' +
        'until the link expires. Underlying error: ' +
        (cause instanceof Error ? cause.message : String(cause)),
      { where },
    )
  }

  if (!response.ok) throw refusal(response.status, await response.text().catch(() => ''), where)

  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new ViewerError(
      'bad-uri',
      `Dropbox answered a request for ${where} with something that is not JSON, so there is ` +
        'nothing to list. Trying again is the only thing to do about it.',
      { where },
    )
  }
}

/**
 * The refusal a status and a body deserve.
 *
 * Four cases with four different fixes, and telling them apart is the whole
 * value of this function: an expired token, an app that was never given the
 * permissions, a folder that has been moved or deleted, and everything else.
 * Dropbox puts the machine-readable half in `error_summary` — `path/not_found/.`
 * and `missing_scope/…` — which is matched as a substring rather than parsed,
 * because the trailing detail after the slash is not a fixed vocabulary.
 */
function refusal(status: number, body: string, where: string): ViewerError {
  const summary = body.toLowerCase()
  const scope = DROPBOX_PERMISSIONS.join(' and ')
  // Checked before the `401` below, because a missing permission arrives as one
  // and "sign in again" is the wrong fix for it — signing in again with the same
  // app grants the same nothing.
  if (status === 403 || summary.includes('missing_scope') || summary.includes('insufficient_scope')) {
    return new ViewerError(
      'remote-cors',
      `Dropbox refused to read ${where} because the app is not allowed to. The app your lab ` +
        `registered needs the ${scope} permissions, set under its App Console entry; adding a ` +
        'permission does not apply to a token already granted, so sign out and sign in again ' +
        'afterwards.',
      { where, status },
    )
  }
  if (status === 401) {
    return new ViewerError(
      'remote-cors',
      `The Dropbox sign-in has expired, so ${where} cannot be read. Sign in again under ` +
        'Connect → Dropbox — the token is held in this tab only and is never stored, which is ' +
        'why a reload asks for it too.',
      { where, status },
    )
  }
  if (status === 409 && summary.includes('path/not_found')) {
    return new ViewerError(
      'bad-uri',
      `${where} is not in this Dropbox any more. It has been moved, renamed or deleted since ` +
        'this listing was drawn; go back up a level and look again.',
      { where, status },
    )
  }
  return new ViewerError(
    'bad-uri',
    `Dropbox answered ${status} to a request for ${where}${body === '' ? '' : `: ${body}`}.`,
    { where, status },
  )
}

/**
 * Registered at module load, which is the whole of the wiring.
 *
 * `folders()` reads the store each time, so an app key saved in the dialog puts
 * the folder in the panel without either screen knowing the other exists — and
 * a browser that has never been given one is a browser this backend contributes
 * nothing to. `usable` is the sign-in, asked rather than assumed: a reload
 * empties the bearer registry, so the folder that was browsable yesterday is
 * there and not usable this morning, which is exactly what the panel should say.
 */
registerFolderSource({
  kind: 'dropbox',
  folders: () => (readAppKey() === null ? [] : [dropboxFolder()]),
  usable: async () => dropboxState().signedIn,
  // There is one Dropbox and it exists because an app key is saved, so the
  // panel's × is sign-out plus forgetting the key — after which nothing of
  // Dropbox is left in this browser, which is what × should mean (§20.6).
  disconnect: () => {
    signOut()
    clearAppKey()
  },
})

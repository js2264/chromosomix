// @vitest-environment jsdom
/**
 * A Google Drive folder, listed (SPECS §20, §24.7).
 *
 * The third backend behind one folder interface, and the first one whose every
 * request carries a credential. Almost nothing about it can be checked by
 * looking: the sandbox this was written in cannot reach `www.googleapis.com`
 * with a real token and neither can a test environment, so `fetch` is stubbed
 * and what is pinned here is the half that is this module's own — the request it
 * builds, what it believes about the answer, and what it says when there is no
 * answer at all. The other half is a manual check, written down in
 * `docs/hosting.md`.
 *
 * Five things can go wrong while every piece looks right:
 *
 * - **A request before there is a token.** Not signed in is the *common* state —
 *   a reload signs nobody in — and a listing that goes out anyway is a 403 from
 *   Google where the honest answer was already in hand.
 * - **The query.** Drive has no paths: `'<id>' in parents` is the whole of what
 *   "list this folder" means, and a `q` that is subtly wrong lists something
 *   else rather than failing.
 * - **The Google-only types.** A folder full of Docs is a folder full of rows
 *   with no bytes behind them, and a reader who clicks one gets a refusal about
 *   a file that was never a file.
 * - **The cap, and the page after it.** A thousand entries is where this app
 *   stops (§20.1); one more page fetched past that is a round trip spent on rows
 *   nobody will see.
 * - **The crumb trail.** A Drive path is a chain of ids, so a folder that cannot
 *   say what an id was called leaves the reader a breadcrumb of gibberish.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setTokenClientFactory,
  signIn,
  signOut,
  type TokenResponse,
} from '@/auth/google'
import { driveFolder, driveListUrl, driveMediaUrl } from '@/browse/gdrive'
import type { FolderEntry } from '@/browse/folder'
import { ViewerError } from '@/errors'
import { canonicalUrl } from '@/sources/rewrite'
import type { DriveRow } from '@/state/drives'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

const CLIENT_ID = '123-abc.apps.googleusercontent.com'
const FOLDER = 'application/vnd.google-apps.folder'
const BINARY = 'application/octet-stream'

const ROW: DriveRow = { id: 'drive:1', label: 'Lab Drive', folderId: 'root' }

/** One answer the stubbed Drive gives, in the order the calls are made. */
interface Answer {
  status?: number
  statusText?: string
  body?: unknown
  /** Answer with a rejected `fetch`, which is what a blocked host looks like. */
  fail?: string
}

let requested: string[]
let sent: Array<RequestInit | undefined>
let heldFetch: unknown

/** Install a `fetch` that answers each call in turn and records what was asked. */
function answering(...answers: readonly Answer[]): void {
  const queue = [...answers]
  ;(globalThis as Record<string, unknown>)['fetch'] = (url: unknown, init?: RequestInit) => {
    requested.push(String(url))
    sent.push(init)
    const answer = queue.shift() ?? { status: 500, statusText: 'no answer queued' }
    if (answer.fail !== undefined) return Promise.reject(new TypeError(answer.fail))
    const status = answer.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: answer.statusText ?? '',
      json: () => Promise.resolve(answer.body),
    } as unknown as Response)
  }
}

/** Sign this tab in, through the seam the real flow is driven by. */
async function signedIn(): Promise<void> {
  site.googleClientId = CLIENT_ID
  const response: TokenResponse = { access_token: 'ya29.TOKEN', expires_in: 3599 } as TokenResponse
  setTokenClientFactory((config) => ({ requestAccessToken: () => config.callback(response) }))
  await signIn()
}

/** `n` files, named so the natural ordering is the obvious one. */
function manyFiles(n: number, from = 0): unknown[] {
  return Array.from({ length: n }, (_, at) => ({
    id: `f${String(from + at).padStart(5, '0')}`,
    name: `f${String(from + at).padStart(5, '0')}.bw`,
    mimeType: BINARY,
    size: '10',
  }))
}

/** The refusal a call made, as the typed error it is. */
async function refusal(run: Promise<unknown>): Promise<ViewerError> {
  try {
    await run
  } catch (cause) {
    expect(cause).toBeInstanceOf(ViewerError)
    return cause as ViewerError
  }
  throw new Error('expected a refusal, got an answer')
}

beforeEach(() => {
  window.localStorage.clear()
  requested = []
  sent = []
  heldFetch = (globalThis as Record<string, unknown>)['fetch']
  setTokenClientFactory(null)
  signOut()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>)['fetch'] = heldFetch
  setTokenClientFactory(null)
  signOut()
  window.localStorage.clear()
})

describe('a Drive folder with nobody signed in', () => {
  /**
   * The common state, not the exceptional one: a reload signs nobody in, and the
   * token expires inside the hour either way. Refusing before the request is
   * what keeps the answer *"sign in"* rather than Google's own `403`, which says
   * nothing a reader can act on.
   */
  it('refuses without fetching anything, and names the one thing to do', async () => {
    answering({ body: { files: [] } })
    const folder = driveFolder(ROW)

    const error = await refusal(folder.list(folder.root))
    expect(error.code).toBe('remote-cors')
    expect(error.message).toMatch(/not signed in/i)
    expect(error.message).toMatch(/Connect → A Google account/)
    // The whole point: no round trip was spent finding out what was already known.
    expect(requested).toEqual([])
  })
})

describe('listing one level', () => {
  beforeEach(async () => {
    await signedIn()
  })

  it('asks the query Drive documents, and carries the token on it', async () => {
    answering({ body: { files: [] } })
    const folder = driveFolder(ROW)
    await folder.list(folder.root)

    expect(requested).toEqual([
      "https://www.googleapis.com/drive/v3/files?q='root'+in+parents+and+trashed=false" +
        '&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000' +
        '&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=folder,name',
    ])
    // Through the bearer registry, which is where the sign-in put it — a
    // listing that went out unauthenticated would 403 on a folder the reader
    // can see perfectly well in Drive.
    expect((sent[0]?.headers as Record<string, string>)['Authorization']).toBe('Bearer ya29.TOKEN')
  })

  it('lists sub-folders first, then files, with the sizes Drive reports', async () => {
    answering({
      body: {
        files: [
          { id: '1raw', name: 'raw', mimeType: FOLDER },
          { id: '1map', name: 'rep1.mcool', mimeType: BINARY, size: '2000' },
          { id: '1sig', name: 'ATAC.bw', mimeType: BINARY },
        ],
      },
    })
    const listing = await driveFolder(ROW).list('root/')

    expect(listing.entries.map((entry) => entry.name)).toEqual(['raw', 'ATAC.bw', 'rep1.mcool'])
    // A decimal string in the API, a number here: `size` is a string because a
    // file may be larger than a JSON number is trusted to carry.
    expect(listing.entries.map((entry) => entry.size)).toEqual([null, null, 2000])
    expect(listing.truncated).toBe(false)
  })

  /**
   * A Doc has no bytes, so there is no row to draw and nothing to say about it.
   *
   * This is the one place a listing deliberately disagrees with the folder
   * (§20.5 draws an unopenable *file* dimmed rather than hiding it): what is
   * hidden here is not a file this viewer cannot open, it is an object that has
   * no download at all.
   */
  it('skips Google’s own document types, and keeps its folders', async () => {
    answering({
      body: {
        files: [
          { id: '1raw', name: 'raw', mimeType: FOLDER },
          { id: '1doc', name: 'Protocol', mimeType: 'application/vnd.google-apps.document' },
          { id: '1sheet', name: 'Samples', mimeType: 'application/vnd.google-apps.spreadsheet' },
          { id: '1cut', name: 'a shortcut', mimeType: 'application/vnd.google-apps.shortcut' },
          { id: '1map', name: 'rep1.mcool', mimeType: BINARY, size: '7' },
        ],
      },
    })
    const listing = await driveFolder(ROW).list('root/')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['raw', 'rep1.mcool'])
  })

  it('hands back a path that lists the folder that was clicked', async () => {
    const map = { id: '1map', name: 'rep1.mcool', mimeType: BINARY, size: '7' }
    const inner = { body: { files: [map] } }
    answering({ body: { files: [{ id: '1raw', name: 'raw', mimeType: FOLDER }] } }, inner, inner)
    const folder = driveFolder(ROW)
    const listing = await folder.list(folder.root)
    const sub = listing.entries[0]
    // A chain from the root, because that is what the crumb trail rebuilds its
    // targets from (`ui/folderBrowse.ts`).
    expect(sub.path).toBe('root/1raw/')

    const inside = await folder.list(sub.path)
    expect(inside.entries.map((entry) => entry.name)).toEqual(['rep1.mcool'])
    // The **last** segment is the folder that gets listed, so a chain and a bare
    // id mean the same thing — which is what lets a stored or dragged path work
    // as well as one a listing just handed back.
    expect(requested[1]).toContain("q='1raw'+in+parents")

    await folder.list('1raw/')
    expect(requested[2]).toContain("q='1raw'+in+parents")
  })

  it('reports a file’s path as its id, which is all Drive has', async () => {
    answering({ body: { files: [{ id: '1map', name: 'rep1.mcool', mimeType: BINARY }] } })
    const listing = await driveFolder(ROW).list('root/')
    expect(listing.entries[0].path).toBe('1map')
  })
})

describe('the listing cap', () => {
  beforeEach(async () => {
    await signedIn()
  })

  /**
   * Truncation is reported, not silently applied — "my file is not here" and "my
   * file is past the cap" look identical otherwise, and only one is actionable.
   */
  it('follows the page token to the cap and then says the list is not the folder', async () => {
    answering(
      { body: { files: manyFiles(900), nextPageToken: 'PAGE2' } },
      { body: { files: manyFiles(300, 900) } },
    )
    const listing = await driveFolder(ROW).list('root/')

    expect(listing.entries).toHaveLength(1000)
    expect(listing.truncated).toBe(true)
    expect(requested).toHaveLength(2)
    expect(requested[1]).toContain('&pageToken=PAGE2')
  })

  it('stops asking the moment the cap is full, rather than draining the folder', async () => {
    answering({ body: { files: manyFiles(1000), nextPageToken: 'PAGE2' } })
    const listing = await driveFolder(ROW).list('root/')

    expect(listing.entries).toHaveLength(1000)
    expect(listing.truncated).toBe(true)
    // One round trip. A second page fetched here is a request spent on rows that
    // the cap has already decided nobody will see.
    expect(requested).toHaveLength(1)
  })

  it('is not truncated by a folder that happens to be exactly the cap', async () => {
    answering({ body: { files: manyFiles(1000) } })
    const listing = await driveFolder(ROW).list('root/')
    expect(listing.entries).toHaveLength(1000)
    expect(listing.truncated).toBe(false)
  })
})

describe('the crumb trail over a chain of ids', () => {
  beforeEach(async () => {
    await signedIn()
  })

  it('names a folder it has listed, the root, and nothing else', async () => {
    answering({ body: { files: [{ id: '1raw', name: 'raw reads', mimeType: FOLDER }] } })
    const folder = driveFolder(ROW)
    await folder.list(folder.root)

    expect(folder.labelOf?.('root/1raw/')).toBe('raw reads')
    // The root is named by the reader, because this app never asks Drive what
    // the connected folder is called.
    expect(folder.labelOf?.(folder.root)).toBe('Lab Drive')
    // An id nothing has listed is printed as itself: a crumb that lied would be
    // worse than one that is ugly.
    expect(folder.labelOf?.('root/1nevermentioned/')).toBe('1nevermentioned')
  })

  /**
   * The names outlive the folder object, and they have to.
   *
   * `connectedFolders()` rebuilds every folder from its stored row on demand —
   * that is how a row edited in one dialog reaches the panel — so a name map
   * held on the object would be emptied by a repaint, and the crumb trail would
   * drop back to ids at the moment the reader looked away.
   */
  it('still names a folder after the panel has rebuilt the folder object', async () => {
    answering({ body: { files: [{ id: '1deep', name: 'deep', mimeType: FOLDER }] } })
    await driveFolder(ROW).list('root/')
    expect(driveFolder(ROW).labelOf?.('root/1deep/')).toBe('deep')
  })
})

describe('picking a file out of a Drive folder', () => {
  const entry: FolderEntry = { kind: 'file', name: 'rep1.mcool', path: '1map', size: 2000 }

  it('opens it at the API’s media URL, under the name Drive gave it', async () => {
    const picked = await driveFolder(ROW).pick(entry)
    expect(picked.uri).toBe(
      'https://www.googleapis.com/drive/v3/files/1map?alt=media&supportsAllDrives=true',
    )
    // No headers on the source: what this URL needs is stamped at the worker
    // boundary from the bearer registry, at the moment it is read (§24.7).
    expect(picked.source).toEqual({ kind: 'remote', url: picked.uri })
    // The URL is an id, so nothing downstream could work the name out.
    expect(picked.name).toBe('rep1.mcool')
  })

  /**
   * A picked file and a pasted share link are the same address, and that is not
   * a coincidence to be re-derived here: `state/handles.ts` keys a grant by URI
   * and `UiMemory` keys a tab's memory by it, so two spellings would be two sets
   * of colours for one map.
   */
  it('resolves to exactly what a pasted share link for the same file resolves to', async () => {
    const picked = await driveFolder(ROW).pick(entry)
    expect(canonicalUrl('https://drive.google.com/file/d/1map/view')).toBe(picked.uri)
    expect(driveMediaUrl('1map')).toBe(picked.uri)
  })

  it('fetches nothing to do it', async () => {
    answering({ body: { files: [] } })
    await driveFolder(ROW).pick(entry)
    expect(requested).toEqual([])
  })
})

describe('what Drive says no with', () => {
  beforeEach(async () => {
    await signedIn()
  })

  /**
   * `401` and `403` are the same two causes in one answer and the message says
   * both, because the page cannot tell them apart: a token that ran out, or a
   * folder that was never shared with this account. They are raised as `bad-uri`
   * carrying the status and the host, which is the shape `ui/ErrorView.ts` reads
   * to decide whether to offer a sign-in.
   */
  it('answers a 401 with both causes, and the detail a sign-in offer needs', async () => {
    answering({ status: 401, statusText: 'Unauthorized' })
    const error = await refusal(driveFolder(ROW).list('root/'))

    expect(error.code).toBe('bad-uri')
    expect(error.message).toMatch(/run out/i)
    expect(error.message).toMatch(/not shared with the account/i)
    expect(error.detail).toMatchObject({ status: 401, host: 'www.googleapis.com' })
  })

  it('answers a 403 the same way, because it means the same two things', async () => {
    answering({ status: 403, statusText: 'Forbidden' })
    const error = await refusal(driveFolder(ROW).list('root/'))
    expect(error.message).toContain('403')
    expect(error.message).toMatch(/not shared with the account/i)
    expect(error.detail['status']).toBe(403)
  })

  it('answers a 404 by naming the id that is wrong and where a right one comes from', async () => {
    answering({ status: 404, statusText: 'Not Found' })
    const folder = driveFolder({ id: 'drive:2', label: 'Run 2024', folderId: '1Missing' })
    const error = await refusal(folder.list(folder.root))

    expect(error.message).toContain('1Missing')
    expect(error.message).toContain('drive.google.com/drive/folders')
    expect(error.detail['status']).toBe(404)
  })

  it('names any other status rather than swallowing it', async () => {
    answering({ status: 500, statusText: 'Internal Server Error' })
    const error = await refusal(driveFolder(ROW).list('root/'))
    expect(error.message).toContain('500 Internal Server Error')
  })

  /**
   * A `fetch` that rejects carries no status, which is what a blocked host looks
   * like from script — so it is `remote-cors`, the code this app uses for a
   * refusal that happened before there was an answer to read.
   */
  it('says a host it could not reach was not reached, rather than blaming the folder', async () => {
    answering({ fail: 'Failed to fetch' })
    const error = await refusal(driveFolder(ROW).list('root/'))
    expect(error.code).toBe('remote-cors')
    expect(error.message).toMatch(/could not reach www\.googleapis\.com/i)
    expect(error.message).toContain('Failed to fetch')
  })

  it('says so when the answer is not JSON at all', async () => {
    ;(globalThis as Record<string, unknown>)['fetch'] = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response)
    const error = await refusal(driveFolder(ROW).list('root/'))
    expect(error.message).toMatch(/not JSON/i)
  })
})

describe('the URL builders, spelled out once', () => {
  it('puts a page token on the second page and nothing on the first', () => {
    expect(driveListUrl('root', null)).not.toContain('pageToken')
    expect(driveListUrl('root', 'PAGE2')).toContain('&pageToken=PAGE2')
  })

  it('encodes the folder id, which is the one part a reader pasted', () => {
    expect(driveListUrl('a b&c', null)).toContain("q='a%20b%26c'+in+parents")
    expect(driveMediaUrl('a b')).toContain('/files/a%20b?')
  })
})

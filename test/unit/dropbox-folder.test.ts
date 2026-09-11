// @vitest-environment jsdom
/**
 * A signed-in Dropbox as a folder: what goes on the wire, and what comes back.
 *
 * No Dropbox host is reachable from a test environment, so `fetch` is stubbed
 * and the assertions are about the four things this backend can get wrong while
 * every piece of it looks right:
 *
 * - **The root is spelled `''`, and nothing else has a trailing slash.**
 *   `browse/folder.ts` requires a folder path to end in `/` and the API refuses
 *   one, so there is a translation at the boundary; getting it wrong lists the
 *   root of the account for every folder clicked, which looks like a folder that
 *   will not open rather than like a bug.
 * - **A page is not a folder.** `list_folder` answers a cursor, and a backend
 *   that forgets to follow it draws the first page of a directory and calls it
 *   the directory — the failure the cap exists to make visible, arriving
 *   silently.
 * - **A pick has to answer the link *and* the name.** A temporary link is an
 *   opaque `/apitl/` path, so a session opened from one would otherwise be named
 *   after a URL that expires the same afternoon (§16.10).
 * - **Four refusals, four different fixes.** An expired token, an app without
 *   the permissions, a folder that has been moved, and everything else. Telling
 *   them apart is the whole value of the error path, and three of the four are
 *   `4xx` responses that a naive reading would report as one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DROPBOX_FOLDER_ID, dropboxFolder } from '@/browse/dropbox'
import { beginSignIn, finishSignIn, setDropboxFetch, signOut, writeAppKey } from '@/auth/dropbox'
import type { FolderEntry } from '@/browse/folder'

interface Call {
  url: string
  init: RequestInit
}

/** An answer to one request: a status, and a body as JSON or as text. */
interface Answer {
  status?: number
  body?: unknown
  text?: string
}

let calls: Call[] = []

/** Answer each request in turn with `answers`, and record what was asked. */
function serve(...answers: Answer[]): void {
  let at = 0
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const answer = answers[Math.min(at++, answers.length - 1)] ?? {}
    const status = answer.status ?? 200
    const text = answer.text ?? JSON.stringify(answer.body ?? {})
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      json: () => Promise.resolve(JSON.parse(text)),
      text: () => Promise.resolve(text),
    } as unknown as Response)
  })
}

/** What one of those calls sent as its JSON body. */
function sent(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body ?? '{}')) as Record<string, unknown>
}

/** The `Authorization` header one of those calls carried, if any. */
function auth(call: Call): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.['Authorization']
}

/** One `file` entry as `list_folder` returns it. */
function file(path: string, size: number): Record<string, unknown> {
  return { '.tag': 'file', name: path.split('/').pop(), path_display: path, size }
}

/** One `folder` entry as `list_folder` returns it. */
function folder(path: string): Record<string, unknown> {
  return { '.tag': 'folder', name: path.split('/').pop(), path_display: path }
}

/** Sign in for real, through the token exchange, with the response stubbed. */
async function signIn(): Promise<void> {
  writeAppKey('a1b2c3d4e5f6g7h')
  setDropboxFetch(
    (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: 'sl.TOKEN', expires_in: 14_400 }),
        text: () => Promise.resolve(''),
      } as unknown as Response)) as unknown as typeof fetch,
  )
  await beginSignIn()
  await finishSignIn('CODE')
  setDropboxFetch(null)
}

beforeEach(() => {
  window.localStorage.clear()
  calls = []
  serve()
  signOut()
  calls = []
})

afterEach(() => {
  signOut()
  setDropboxFetch(null)
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('the folder itself', () => {
  it('is one folder, rooted at the whole Dropbox, and survives a reload', () => {
    const at = dropboxFolder()
    expect(at.id).toBe(DROPBOX_FOLDER_ID)
    expect(at.kind).toBe('dropbox')
    // The root is `/`, which `crumbsOf` splits into nothing — a Dropbox path is
    // readable, so unlike a Drive folder this backend needs no `labelOf`.
    expect(at.root).toBe('/')
    expect(at.labelOf).toBeUndefined()
    // The app key is a line in `localStorage`; the sign-in is not, and that is
    // what `usable` answers rather than this.
    expect(at.durable).toBe(true)
  })
})

describe('listing', () => {
  it('asks for the root as the empty string, which is what the API wants', async () => {
    await signIn()
    serve({ body: { entries: [folder('/Hi-C'), file('/notes.txt', 12)], has_more: false } })

    const listing = await dropboxFolder().list('/')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.dropboxapi.com/2/files/list_folder')
    expect(calls[0].init.method).toBe('POST')
    // A lone `/` is an error at Dropbox, and `''` is its spelling for the root.
    expect(sent(calls[0])).toEqual({
      path: '',
      limit: 1000,
      // Dropbox Paper and other cloud-editable entries have no bytes to read,
      // so they are never listed — the API filters them rather than this code.
      include_non_downloadable_files: false,
    })
    // Through `applyAccess`, so the token rides every request (§24.7).
    expect(auth(calls[0])).toBe('Bearer sl.TOKEN')
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['Hi-C', 'notes.txt'])
  })

  it('strips the trailing slash a folder path carries, and keeps the case', async () => {
    await signIn()
    serve({ body: { entries: [], has_more: false } })
    await dropboxFolder().list('/Hi-C/2024/')
    expect(sent(calls[0])['path']).toBe('/Hi-C/2024')
  })

  it('puts folders first and hands back paths that can be handed in', async () => {
    await signIn()
    serve({
      body: {
        entries: [file('/Hi-C/rep2.mcool', 900), folder('/Hi-C/2024'), file('/Hi-C/rep1.mcool', 512)],
        has_more: false,
      },
    })

    const listing = await dropboxFolder().list('/Hi-C/')

    expect(listing.entries.map((entry) => entry.name)).toEqual(['2024', 'rep1.mcool', 'rep2.mcool'])
    // A folder path ends in `/` and a file path does not, because the crumb
    // trail is built by splitting on it.
    expect(listing.entries[0].path).toBe('/Hi-C/2024/')
    expect(listing.entries[1].path).toBe('/Hi-C/rep1.mcool')
    expect(listing.entries.map((entry) => entry.size)).toEqual([null, 512, 900])
  })

  it('follows the cursor until the API runs out', async () => {
    await signIn()
    serve(
      { body: { entries: [file('/a.mcool', 1)], has_more: true, cursor: 'CURSOR-1' } },
      { body: { entries: [file('/b.mcool', 2)], has_more: false } },
    )

    const listing = await dropboxFolder().list('/')

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.dropboxapi.com/2/files/list_folder',
      'https://api.dropboxapi.com/2/files/list_folder/continue',
    ])
    expect(sent(calls[1])).toEqual({ cursor: 'CURSOR-1' })
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.mcool', 'b.mcool'])
    expect(listing.truncated).toBe(false)
  })

  it('stops at a thousand entries and says the list is not the folder', async () => {
    // "My file is not here" and "my file is past the cap" look identical on
    // screen, and only one of them is something a reader can act on.
    await signIn()
    const page = (from: number): Record<string, unknown>[] =>
      Array.from({ length: 600 }, (_, at) => file(`/f${String(from + at).padStart(5, '0')}.bw`, 1))
    serve(
      { body: { entries: page(0), has_more: true, cursor: 'CURSOR-1' } },
      { body: { entries: page(600), has_more: true, cursor: 'CURSOR-2' } },
    )

    const listing = await dropboxFolder().list('/')

    expect(listing.entries).toHaveLength(1000)
    expect(listing.truncated).toBe(true)
    // Two pages, and no third: a folder of forty thousand files would be round
    // trips spent on rows nothing will draw.
    expect(calls).toHaveLength(2)
  })

  it('skips a row that is neither a file nor a folder', async () => {
    await signIn()
    serve({
      body: {
        entries: [{ '.tag': 'deleted', name: 'gone.bw', path_display: '/gone.bw' }, file('/here.bw', 3)],
        has_more: false,
      },
    })
    const listing = await dropboxFolder().list('/')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['here.bw'])
  })
})

describe('picking a file', () => {
  it('mints a temporary link and hands over the name with it', async () => {
    await signIn()
    const link = 'https://dl.dropboxusercontent.com/apitl/1/AbCdEf'
    serve({ body: { metadata: file('/Hi-C/rep1.mcool', 512), link } })

    const picked = await dropboxFolder().pick({
      kind: 'file',
      name: 'rep1.mcool',
      path: '/Hi-C/rep1.mcool',
      size: 512,
    })

    expect(calls[0].url).toBe('https://api.dropboxapi.com/2/files/get_temporary_link')
    expect(sent(calls[0])).toEqual({ path: '/Hi-C/rep1.mcool' })
    expect(picked.uri).toBe(link)
    expect(picked.source).toEqual({ kind: 'remote', url: link })
    // The name, because the link does not carry one: a session named after a
    // temporary link would be named after a URL that expires in four hours.
    expect(picked.name).toBe('rep1.mcool')
  })

  it('puts no header on the source, because the link carries its own', async () => {
    // `dl.dropboxusercontent.com` is not in `DROPBOX_HOSTS` and must not be: the
    // link authorises itself in its URL, and sending the account's bearer token
    // to an unauthenticated content host would publish it to one.
    await signIn()
    serve({ body: { link: 'https://dl.dropboxusercontent.com/apitl/1/AbCdEf' } })
    const picked = await dropboxFolder().pick({
      kind: 'file',
      name: 'rep1.mcool',
      path: '/Hi-C/rep1.mcool',
      size: 512,
    })
    expect(picked.source).not.toHaveProperty('headers')
    expect(picked.source).not.toHaveProperty('credential')
  })
})

describe('the four refusals', () => {
  const entry: FolderEntry = { kind: 'file', name: 'rep1.mcool', path: '/rep1.mcool', size: 1 }

  it('says to sign in, and contacts nobody, when nobody is signed in', async () => {
    writeAppKey('a1b2c3d4e5f6g7h')
    serve()
    await expect(dropboxFolder().list('/')).rejects.toThrow(/Sign in to Dropbox/)
    await expect(dropboxFolder().pick(entry)).rejects.toThrow(/Connect → Dropbox/)
    // Not one request, because there is nothing to put on it: a reader who has
    // not signed in gets a sentence naming the gesture rather than a status code
    // from a host they never knowingly contacted.
    expect(calls).toEqual([])
  })

  it('says the sign-in has expired on a 401', async () => {
    await signIn()
    serve({ status: 401, text: 'expired_access_token/...' })
    await expect(dropboxFolder().list('/')).rejects.toThrow(/expired/i)
    await expect(dropboxFolder().list('/')).rejects.toThrow(/Connect → Dropbox/)
  })

  it('names the two permissions when the app was never given them', async () => {
    // Checked before the 401 above, because a missing permission arrives as one
    // and "sign in again" is the wrong fix: signing in again with the same app
    // grants the same nothing.
    await signIn()
    serve({ status: 401, text: '{"error_summary": "missing_scope/.", "error": {".tag": "missing_scope"}}' })
    await expect(dropboxFolder().list('/')).rejects.toThrow(/files\.metadata\.read and files\.content\.read/)

    serve({ status: 403, text: 'forbidden' })
    await expect(dropboxFolder().list('/')).rejects.toThrow(/files\.metadata\.read and files\.content\.read/)
  })

  it('says a folder is gone on a 409 that names the path', async () => {
    await signIn()
    serve({ status: 409, text: '{"error_summary": "path/not_found/.", "error": {".tag": "path"}}' })
    await expect(dropboxFolder().list('/Hi-C/2024/')).rejects.toThrow(/not in this Dropbox any more/)
  })

  it('reports anything else with its status and its body', async () => {
    await signIn()
    serve({ status: 500, text: 'internal error' })
    await expect(dropboxFolder().list('/')).rejects.toThrow(/500.*internal error/)
  })

  it('explains a request that never arrived', async () => {
    await signIn()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Failed to fetch')))
    await expect(dropboxFolder().list('/')).rejects.toThrow(/Could not reach Dropbox/)
  })
})

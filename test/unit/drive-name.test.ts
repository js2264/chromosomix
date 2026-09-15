/**
 * Naming a Drive file by asking Drive (SPECS §24.9).
 *
 * A pasted share link opens under an id, and the id is what the loading
 * screen, the tab and the router used to see. Four things about the one
 * request that fixes it are worth pinning:
 *
 * - **It goes to `files.get`, with the site's key or the reader's token** — the
 *   same header bag the read itself carries, so a file the key can read is a
 *   file the key can name.
 * - **It is asked once.** The sniff and the map door open the same file inside
 *   one open, and a Drive request is the better part of a second.
 * - **It is never in the way.** A refusal, a network failure, a body that is
 *   not JSON, an address that is not Drive's: `null`, and the open goes ahead
 *   under the id as it always did.
 * - **Nothing is asked with nothing to ask with.** Google refuses an anonymous
 *   `files.get` even for a public file, so a site with no key and no sign-in
 *   spends no round trip finding that out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTokenClientFactory, signIn, signOut, type TokenResponse } from '@/auth/google'
import { driveFileIdOf, driveFileName } from '@/browse/driveName'
import { driveMediaUrl } from '@/browse/gdrive'
import { canonicalUrl } from '@/sources/rewrite'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: { googleClientId: null, googleApiKey: null, dropboxAppKey: null },
}))

import { SITE_DEFAULTS } from '@/config/siteDefaults'

/** The site's registrations, as this file sets them: the build's values, mocked mutable. */
const site = SITE_DEFAULTS as { googleClientId: string | null; googleApiKey: string | null; dropboxAppKey: string | null }

const SHARE = 'https://drive.google.com/file/d/1Vs9WgmiQj3CMSaDrXNBzzV3tp72GTLu6/view?usp=sharing'
const MEDIA = 'https://www.googleapis.com/drive/v3/files/1Vs9WgmiQj3CMSaDrXNBzzV3tp72GTLu6?alt=media&supportsAllDrives=true'

interface Answer {
  status?: number
  body?: unknown
  /** Answer with a rejected `fetch`, which is what a blocked host looks like. */
  fail?: string
}

let calls: Array<{ url: string; headers: Record<string, string> }>

/** Install a `fetch` that answers each call in turn (the last answer repeats) and records what was asked. */
function answering(...answers: readonly Answer[]): void {
  let at = 0
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
    const answer = answers[Math.min(at++, answers.length - 1)] ?? {}
    if (answer.fail !== undefined) return Promise.reject(new TypeError(answer.fail))
    const status = answer.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      json: () =>
        answer.body === undefined ? Promise.reject(new SyntaxError('not JSON')) : Promise.resolve(answer.body),
    } as unknown as Response)
  })
}

/** Sign this tab in, through the seam the real flow is driven by. */
async function signedIn(): Promise<void> {
  site.googleClientId = '123-abc.apps.googleusercontent.com'
  const response = { access_token: 'ya29.TOKEN', expires_in: 3599 } as TokenResponse
  setTokenClientFactory((config) => ({ requestAccessToken: () => config.callback(response) }))
  await signIn()
}

beforeEach(() => {
  calls = []
  site.googleApiKey = null
  site.googleClientId = null
  signOut()
  setTokenClientFactory(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  signOut()
  setTokenClientFactory(null)
})

describe('the id in a Drive address', () => {
  it('is read off the media URL a share link becomes, and off the one a folder pick makes', () => {
    expect(driveFileIdOf(canonicalUrl(SHARE))).toBe('1Vs9WgmiQj3CMSaDrXNBzzV3tp72GTLu6')
    expect(driveFileIdOf(driveMediaUrl('1AbCdEf'))).toBe('1AbCdEf')
    // Encoded on the way in, decoded on the way out.
    expect(driveFileIdOf(driveMediaUrl('a b'))).toBe('a b')
  })

  it('is null for every other address, the listing URL included', () => {
    expect(driveFileIdOf('https://www.googleapis.com/drive/v3/files?q=%27root%27+in+parents')).toBeNull()
    expect(driveFileIdOf('https://storage.googleapis.com/storage/v1/b/lab/o/rep1.mcool?alt=media')).toBeNull()
    expect(driveFileIdOf('https://bucket.example.org/Hum53.mcool')).toBeNull()
    expect(driveFileIdOf(SHARE)).toBeNull()
    expect(driveFileIdOf('not a url')).toBeNull()
  })
})

describe('asking Drive for the name', () => {
  it('asks files.get with the site’s key, and answers the name', async () => {
    site.googleApiKey = 'AIzaSite'
    answering({ body: { name: 'SB112b^mapped_CalTech4^B0AGU2.mcool' } })

    expect(await driveFileName(MEDIA)).toBe('SB112b^mapped_CalTech4^B0AGU2.mcool')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      'https://www.googleapis.com/drive/v3/files/1Vs9WgmiQj3CMSaDrXNBzzV3tp72GTLu6?fields=name&supportsAllDrives=true',
    )
    // The key as the header the reads carry, never in the URL.
    expect(calls[0].headers['x-goog-api-key']).toBe('AIzaSite')
    expect(calls[0].url).not.toContain('AIzaSite')
  })

  it('asks once per file, whatever door asks', async () => {
    site.googleApiKey = 'AIzaSite'
    answering({ body: { name: 'once.bw' } })
    const url = driveMediaUrl('1Once')

    expect(await driveFileName(url)).toBe('once.bw')
    expect(await driveFileName(url)).toBe('once.bw')
    expect(await driveFileName(`${url}#index=https://x.example/once.bai`)).toBe('once.bw')

    expect(calls).toHaveLength(1)
  })

  it('carries the sign-in’s token as well, for a file only the account can see', async () => {
    await signedIn()
    answering({ body: { name: 'private.mcool' } })

    expect(await driveFileName(driveMediaUrl('1Private'))).toBe('private.mcool')

    expect(calls[0].headers['Authorization']).toBe('Bearer ya29.TOKEN')
  })

  it('asks nothing where there is nothing to ask with', async () => {
    // No key on this site and no sign-in: Google would answer 403 to an
    // anonymous files.get even for a public file, so the round trip is not
    // spent, and the open goes ahead under the id.
    answering({ body: { name: 'never.mcool' } })

    expect(await driveFileName(driveMediaUrl('1Nothing'))).toBeNull()

    expect(calls).toEqual([])
  })

  it('answers null on a refusal, and asks again next time', async () => {
    // Not memoised: the reader may sign in next, and a name refused before
    // the sign-in is not the answer after it.
    site.googleApiKey = 'AIzaSite'
    answering({ status: 404, body: { error: { message: 'File not found' } } }, { body: { name: 'found.mcool' } })
    const url = driveMediaUrl('1Refused')

    expect(await driveFileName(url)).toBeNull()
    expect(await driveFileName(url)).toBe('found.mcool')

    expect(calls).toHaveLength(2)
  })

  it('answers null for a network that never answered, and for a body that is not a name', async () => {
    site.googleApiKey = 'AIzaSite'
    answering({ fail: 'Failed to fetch' })
    expect(await driveFileName(driveMediaUrl('1Blocked'))).toBeNull()

    answering({ body: undefined })
    expect(await driveFileName(driveMediaUrl('1NotJson'))).toBeNull()

    answering({ body: { name: '   ' } })
    expect(await driveFileName(driveMediaUrl('1Blank'))).toBeNull()

    answering({ body: 'a string' })
    expect(await driveFileName(driveMediaUrl('1String'))).toBeNull()
  })

  it('answers null for an address that is not Drive’s, without a request', async () => {
    site.googleApiKey = 'AIzaSite'
    answering({ body: { name: 'never' } })

    expect(await driveFileName('https://bucket.example.org/Hum53.mcool')).toBeNull()
    expect(await driveFileName(SHARE)).toBeNull()

    expect(calls).toEqual([])
  })
})

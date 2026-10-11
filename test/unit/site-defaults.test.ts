// @vitest-environment jsdom
/**
 * The credentials the site ships (`config/siteDefaults.ts`), and the places
 * they must and must not reach.
 *
 * Three rules. The site's value is the only value: each reader is answered
 * from the build and nothing a browser stores counts. Nothing about them is
 * listed as stored, because nothing is. And the Files panel lists a Dropbox
 * only while a sign-in is live (§24.9). The defaults are mocked in, because a
 * build in this runner makes none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: {
    googleClientId: 'site-123.apps.googleusercontent.com',
    googleApiKey: 'AIzaSite',
    dropboxAppKey: 'sitekey',
  },
}))

import { beginSignIn, finishSignIn, readAppKey, setDropboxFetch, signOut } from '@/auth/dropbox'
import { googleState, readClientId } from '@/auth/google'
import { connectedFolders, folderUsable } from '@/browse/connected'
import { DROPBOX_FOLDER_ID } from '@/browse/dropbox'
import { readApiKey } from '@/s3/credentials'
import { storedItems } from '@/state/stored'

beforeEach(() => {
  window.localStorage.clear()
})

describe('the site’s registrations', () => {
  it('are the client id, the API key and the app key every reader signs in with', () => {
    expect(readClientId()).toBe('site-123.apps.googleusercontent.com')
    expect(googleState().configured).toBe(true)
    expect(readApiKey()).toBe('AIzaSite')
    expect(readAppKey()).toBe('sitekey')
  })

  it('are not read from this browser’s storage, whatever an older build left there', () => {
    window.localStorage.setItem('chromosomix:google', '{"clientId":"mine.apps.googleusercontent.com"}')
    window.localStorage.setItem('chromosomix:dropbox', '{"appKey":"minekey"}')
    window.localStorage.setItem('chromosomix:access', '[{"id":"google-api-key","kind":"google-api-key","key":"AIzaMine"}]')
    expect(readClientId()).toBe('site-123.apps.googleusercontent.com')
    expect(readAppKey()).toBe('sitekey')
    expect(readApiKey()).toBe('AIzaSite')
  })
})

describe('where the site’s registrations do not reach', () => {
  afterEach(() => {
    signOut()
    setDropboxFetch(null)
  })

  it('the About screen lists nothing for them, because this browser keeps nothing', async () => {
    const labels = (await storedItems()).map((item) => item.label)
    expect(labels).not.toContain('Google client id')
    expect(labels).not.toContain('Google API key')
    expect(labels).not.toContain('Dropbox app key')
  })

  it('the Files panel lists a Dropbox only while signed in', async () => {
    const dropbox = () => connectedFolders().find((folder) => folder.kind === 'dropbox')
    // Every reader's page carries the site's key; not every reader has a Dropbox.
    expect(dropbox()).toBeUndefined()

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
    const folder = dropbox()
    expect(folder?.id).toBe(DROPBOX_FOLDER_ID)
    expect(await folderUsable(folder!)).toBe(true)

    // Signing out is the × of §20.6: nothing of Dropbox is left, the row included.
    signOut()
    expect(dropbox()).toBeUndefined()
  })
})

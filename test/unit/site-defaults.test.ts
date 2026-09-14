// @vitest-environment jsdom
/**
 * The credentials the site ships (`config/siteDefaults.ts`).
 *
 * Two rules, each pinned for all three values: the site's value stands in
 * where a reader has stored nothing, and a reader's own always wins over it —
 * forgetting the reader's own falls back to the site's rather than to nothing.
 * And two places a site value must *not* reach: the About screen's list of
 * what this browser stores, and the Files panel, which lists a Dropbox under
 * the site's key only while a sign-in is live (§24.9). The defaults are mocked
 * in, because a build in this runner makes none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/siteDefaults', () => ({
  SITE_DEFAULTS: {
    googleClientId: 'site-123.apps.googleusercontent.com',
    googleApiKey: 'AIzaSite',
    dropboxAppKey: 'sitekey',
  },
}))

import {
  beginSignIn,
  clearAppKey,
  finishSignIn,
  ownAppKey,
  readAppKey,
  setDropboxFetch,
  signOut,
  writeAppKey,
} from '@/auth/dropbox'
import { clearClientId, googleState, ownClientId, readClientId, writeClientId } from '@/auth/google'
import { connectedFolders, folderUsable } from '@/browse/connected'
import { DROPBOX_FOLDER_ID } from '@/browse/dropbox'
import { clearApiKey, ownApiKey, readApiKey, writeApiKey } from '@/s3/credentials'
import { storedItems } from '@/state/stored'

beforeEach(() => {
  window.localStorage.clear()
})

describe('the site’s defaults', () => {
  it('stand in for a Google client id nobody stored, and a stored one wins', () => {
    expect(ownClientId()).toBeNull()
    expect(readClientId()).toBe('site-123.apps.googleusercontent.com')
    // …which is enough to offer the sign-in.
    expect(googleState().configured).toBe(true)
    writeClientId('mine.apps.googleusercontent.com')
    expect(readClientId()).toBe('mine.apps.googleusercontent.com')
    clearClientId()
    expect(readClientId()).toBe('site-123.apps.googleusercontent.com')
  })

  it('stand in for a Google API key, and a stored one wins', () => {
    expect(ownApiKey()).toBeNull()
    expect(readApiKey()).toBe('AIzaSite')
    writeApiKey('AIzaMine')
    expect(readApiKey()).toBe('AIzaMine')
    clearApiKey()
    expect(readApiKey()).toBe('AIzaSite')
  })

  it('stand in for a Dropbox app key, and a stored one wins', () => {
    expect(ownAppKey()).toBeNull()
    expect(readAppKey()).toBe('sitekey')
    writeAppKey('minekey')
    expect(readAppKey()).toBe('minekey')
    clearAppKey()
    expect(readAppKey()).toBe('sitekey')
  })
})

describe('where the site’s defaults do not reach', () => {
  afterEach(() => {
    signOut()
    setDropboxFetch(null)
  })

  it('the About screen lists a client id or app key this browser stores, never the site’s', async () => {
    const labels = (await storedItems()).map((item) => item.label)
    expect(labels).not.toContain('Google client id')
    expect(labels).not.toContain('Dropbox app key')

    writeClientId('mine.apps.googleusercontent.com')
    writeAppKey('minekey')
    const items = await storedItems()
    const client = items.find((item) => item.label === 'Google client id')
    expect(client?.detail).toContain('mine.apps.googleusercontent.com')
    expect(client?.detail).not.toContain('site-123')
    const app = items.find((item) => item.label === 'Dropbox app key')
    expect(app?.detail).toContain('minekey')
    expect(app?.detail).not.toContain('sitekey')
  })

  it('the Files panel lists a Dropbox under the site’s key only while signed in', async () => {
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

    // A key of the reader's own keeps the folder listed, signed in or not, as
    // it always has — listed and not usable is the honest pair for a saved key.
    writeAppKey('minekey')
    expect(dropbox()?.id).toBe(DROPBOX_FOLDER_ID)
    expect(await folderUsable(dropbox()!)).toBe(false)
  })
})

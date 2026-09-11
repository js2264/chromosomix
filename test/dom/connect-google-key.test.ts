// @vitest-environment jsdom
/**
 * The Google API key section of the Connect dialog (SPECS §24.7).
 *
 * A key box is three lines of DOM and four ways to be wrong, and three of them
 * are invisible from a screenshot:
 *
 * - **Saving has to reach storage**, because nothing else in the application
 *   will tell the reader it did not — a Drive link simply goes on failing with
 *   the 403 it failed with before, which is the symptom they came here to fix.
 * - **Forgetting has to mean it.** This is a credential; a "forget" that clears
 *   the box and leaves the row is the worst button in the dialog.
 * - **The key must never be printed back.** The status line answers *is one
 *   stored*, which is the question a reader returning to this dialog has, and
 *   answering it with the key itself would make a screenshot of this screen a
 *   leak.
 *
 * The fourth is §19: the standalone build has an opaque origin and cannot make
 * the request this key would authorise, so §8.5's rule applies — the control is
 * absent rather than disabled, exactly as the bucket half is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readApiKey, writeApiKey } from '@/s3/credentials'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  vi.resetModules()
  window.localStorage.clear()
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
})

/** The dialog's body, mounted, with the modal cleaned up after. */
async function connectBody(): Promise<HTMLElement> {
  const { openConnect } = await import('@/ui/ConnectCard')
  openConnect({ onConnected: () => undefined })
  const body = document.querySelector<HTMLElement>('.modal-body')
  expect(body).not.toBeNull()
  return body as HTMLElement
}

/** The section whose heading names the key. */
function googleSection(body: HTMLElement): HTMLElement {
  const section = all(body, '.connect-section').find((node) =>
    (node.querySelector('h3')?.textContent ?? '').includes('Google API key'),
  )
  expect(section).toBeDefined()
  return section as HTMLElement
}

describe('the Google API key section', () => {
  it('is offered beside the folder and the bucket, and before the account', async () => {
    // The key comes before the account because that is the order a reader meets
    // the two in: a public Drive link fails without a key, and a private one
    // fails afterwards with a key in place. `test/dom/google-signin.test.ts`
    // owns the section below it.
    const body = await connectBody()
    expect(textsOf(body, '.connect-section h3')).toEqual([
      'A folder on this machine',
      'A bucket',
      'A Google API key',
      'A Google account',
      'A Google Drive folder',
      'Dropbox',
    ])
  })

  it('says what it is for, and what does not need it', async () => {
    // The one sentence that keeps a reader from pasting a key to open a `gs://`
    // object that needs none, and from expecting a key to open a *private* Drive
    // file, which is the account section's job and not this one's.
    const text = googleSection(await connectBody()).textContent ?? ''
    expect(text).toMatch(/public Google Drive file/i)
    expect(text).toMatch(/Cloud Storage object needs none/i)
    expect(text).toMatch(/account sign-in/i)
  })

  it('saves the key, and says one is stored without showing it', async () => {
    const section = googleSection(await connectBody())
    const input = all<HTMLInputElement>(section, 'input')[0]
    // A password field, as the bucket secret is: this box is opened in front of
    // an audience precisely when somebody is demonstrating the feature.
    expect(input.type).toBe('password')

    input.value = 'AIzaSECRET'
    buttonNamed(section, 'save')?.click()

    expect(readApiKey()).toBe('AIzaSECRET')
    expect(input.value).toBe('')
    const status = section.textContent ?? ''
    expect(status).toMatch(/A key is stored in this browser/)
    expect(status).not.toContain('AIzaSECRET')
  })

  it('forgets the key for real', async () => {
    writeApiKey('AIzaSECRET')
    const section = googleSection(await connectBody())
    expect(section.textContent).toMatch(/A key is stored/)

    buttonNamed(section, 'forget')?.click()

    expect(readApiKey()).toBeNull()
    expect(window.localStorage.getItem('metacooler-viewer:access')).toBeNull()
    expect(section.textContent).toMatch(/No key stored/)
  })

  it('is absent in the standalone build, exactly as the bucket half is', async () => {
    // §19: an opaque origin cannot make the request this key authorises, and
    // §8.5 says a control that cannot keep its promise is absent rather than
    // disabled. Asserted together with the bucket section so a change that
    // exempted one from the rule fails here.
    vi.resetModules()
    vi.doMock('@/version', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@/version')),
      IS_STANDALONE: true,
    }))
    try {
      const body = await connectBody()
      expect(textsOf(body, '.connect-section h3')).toEqual(['A folder on this machine'])
    } finally {
      vi.doUnmock('@/version')
    }
  })
})

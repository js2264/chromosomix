// @vitest-environment jsdom
/**
 * Taking a store's catalogue away with you.
 *
 * Until this there was no way to: a built-in's URL is never shown on the page,
 * RSG has no URL at all because it ships inline, and *copy link* copies a
 * `?store=` link carrying an id rather than the JSON behind it. A reader who
 * wanted to see what a store actually says — to check a row, to build their own
 * from the shape of one that works — had to guess the address.
 *
 * Two things are asserted, and the second is the one with teeth. The button is
 * **absent until there is a catalogue**, which is §8.5 rather than decoration:
 * a store read over the network has none for as long as the request takes, and
 * a greyed button there would say the file exists and this build will not hand
 * it over. And what lands **opens again**: shards merged into the one file on
 * screen, every `uri` absolute, `kind` and `version` still on it — a download
 * that could not be re-read is a download of nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STORE_KIND, STORE_VERSION, parseStore, type StoreFile } from '@/state/store'
import { StoreDrawer } from '@/ui/StoreDrawer'
import { storeFailure } from '@/ui/stores/PortalView'
import type { StoreHost } from '@/ui/stores/host'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let saved: Array<{ name: string; blob: Blob }>
let restore: () => void

/** What the store behind every URL says in this file. */
function storeBody(name: string): string {
  return JSON.stringify({
    kind: STORE_KIND,
    version: STORE_VERSION,
    name,
    columns: [{ key: 'assay', label: 'Assay' }],
    entries: [{ label: 'One', uri: 'one.mcool', kind: 'map', fields: { assay: 'Hi-C' } }],
  })
}

/** `downloadBlob` hands the browser an object URL and clicks a link; jsdom has neither. */
function captureDownloads(): () => void {
  let pending: Blob | null = null
  const urls = URL as unknown as {
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
  }
  const realCreate = urls.createObjectURL
  const realRevoke = urls.revokeObjectURL
  const realClick = HTMLAnchorElement.prototype.click
  urls.createObjectURL = (blob) => {
    pending = blob
    return 'blob:test'
  }
  urls.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (pending !== null) saved.push({ name: this.download, blob: pending })
    pending = null
  }
  return () => {
    urls.createObjectURL = realCreate
    urls.revokeObjectURL = realRevoke
    HTMLAnchorElement.prototype.click = realClick
  }
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  saved = []
  restore = captureDownloads()
  vi.stubGlobal('fetch', (url: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(storeBody(String(url))),
    }),
  )
})

afterEach(() => {
  restore()
  teardown()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function build(): StoreDrawer {
  const host: StoreHost = {
    open: () => undefined,
    add: () => undefined,
    openTogether: () => undefined,
    tabEmpty: () => true,
  }
  const drawer = new StoreDrawer({ host })
  const body = document.createElement('div')
  body.className = 'app-body'
  body.appendChild(drawer.el)
  document.body.appendChild(body)
  return drawer
}

/** The head's download, or `null` while there is nothing to download. */
function downloadButton(drawer: StoreDrawer): HTMLButtonElement | null {
  return drawer.el.querySelector<HTMLButtonElement>('.store-head-actions button')
}

/** Let the store's fetch and the paint that follows it settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('downloading a store’s catalogue', () => {
  it('offers the lab’s inline store at once, since nothing is fetched for it', () => {
    const drawer = build()
    drawer.open('rsg')
    expect(downloadButton(drawer)).not.toBeNull()
  })

  it('offers nothing until a store read over the network has arrived', async () => {
    const drawer = build()
    drawer.open('4dn')
    // The request is out and no catalogue is in hand: absent, not disabled.
    expect(downloadButton(drawer)).toBeNull()
    await settle()
    expect(downloadButton(drawer)).not.toBeNull()
  })

  it('writes a file that parses back as a store', async () => {
    const drawer = build()
    drawer.open('4dn')
    await settle()
    downloadButton(drawer)?.click()
    expect(saved).toHaveLength(1)
    const parsed = parseStore(await saved[0].blob.text())
    expect('reason' in parsed, 'the file it wrote is not a store').toBe(false)
    expect((parsed as StoreFile).entries.length).toBeGreaterThan(0)
    expect((parsed as StoreFile).kind).toBe(STORE_KIND)
  })

  it('resolves every address, so what lands does not need the store it came from', async () => {
    const drawer = build()
    drawer.open('4dn')
    await settle()
    downloadButton(drawer)?.click()
    const parsed = parseStore(await saved[0].blob.text()) as StoreFile
    // `one.mcool` was relative to the store's own URL; a copy of the bytes
    // would still say `one.mcool` and resolve against wherever it was saved.
    for (const entry of parsed.entries) expect(entry.uri).toMatch(/^[a-z][a-z0-9+.-]*:/i)
  })

  it('names a built-in after itself, and is a JSON file', async () => {
    const drawer = build()
    drawer.open('rsg')
    downloadButton(drawer)?.click()
    expect(saved[0].name).toBe('rsg.json')
    expect(saved[0].blob.type).toBe('application/json')
  })

  it('goes away again when the drawer moves to a store still being read', async () => {
    const drawer = build()
    drawer.open('rsg')
    expect(downloadButton(drawer)).not.toBeNull()
    drawer.open('encode')
    expect(downloadButton(drawer)).toBeNull()
    // Let the shards land before the stubs go: a fetch still in flight at
    // teardown resolves against the real `fetch` and paints into a torn-down
    // document, which surfaces as an error attached to no test.
    await settle()
  })
})

describe('a store that did not answer with a store', () => {
  /**
   * The message a dev server earns by answering `index.html` for a store it has
   * not generated. It used to come from the *workspace* reader — "is not a JSON
   * file, so it is not a saved workspace" — which named a kind of file nobody
   * in this drawer was trying to open.
   */
  it('says it is not a store, and does not mention workspaces', () => {
    const text = storeFailure(
      { ok: false, reason: 'refused', refusal: { reason: 'not-json' }, message: '' },
      { id: 'encode', label: 'ENCODE', url: 'https://host/stores/encode.json', builtin: true },
    )
    expect(text).toContain('is not a store')
    expect(text).not.toContain('workspace')
    expect(text).toContain('https://host/stores/encode.json')
  })
})

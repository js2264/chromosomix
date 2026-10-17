// @vitest-environment jsdom
/**
 * The store drawer: a page down the left, the address bar it writes, and the
 * way back in.
 *
 * Three promises, each easy to break without noticing. **Nothing is fetched
 * until a store is opened** (§24.2): building the drawer and drawing its tiles
 * cost no request. **The address says what is open**, so a narrowed store is a
 * link and a reload lands where the reader was; closing takes it out again.
 * And **a store reopened comes back where it was left**, which is the
 * difference between a drawer and a dialog.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_VIEW } from '@/state/facets'
import { STORE_KIND, STORE_VERSION, type StoreEntry } from '@/state/store'
import { addStoreRow } from '@/state/stores'
import { StoreDrawer } from '@/ui/StoreDrawer'
import type { StoreHost } from '@/ui/stores/host'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let requested: string[]

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  requested = []
  vi.stubGlobal('fetch', (url: unknown) => {
    requested.push(String(url))
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            kind: STORE_KIND,
            version: STORE_VERSION,
            name: 'Lab shelf',
            columns: [
              { key: 'assay', label: 'Assay' },
              { key: 'lab', label: 'Lab' },
            ],
            entries: [
              { label: 'One', uri: 'one.mcool', kind: 'map', fields: { assay: 'Hi-C', lab: 'A' } },
              { label: 'Two', uri: 'two.bw', kind: 'genome', fields: { assay: 'ChIP-seq', lab: 'A' } },
            ],
          }),
        ),
    })
  })
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

function build(): { drawer: StoreDrawer; opened: StoreEntry[]; layouts: number } {
  const opened: StoreEntry[] = []
  let layouts = 0
  const host: StoreHost = {
    open: (entry) => opened.push(entry),
    openWithTracks: (entry) => opened.push(entry),
    add: () => undefined,
    openTogether: () => undefined,
    tabEmpty: () => true,
  }
  const drawer = new StoreDrawer({
    host,
    onLayout: () => {
      layouts++
    },
  })
  const body = document.createElement('div')
  body.className = 'app-body'
  body.appendChild(drawer.el)
  document.body.appendChild(body)
  return {
    drawer,
    opened,
    get layouts() {
      return layouts
    },
  }
}

describe('opening', () => {
  it('starts closed, fetches nothing, and opens on the lab’s store by default', () => {
    const { drawer } = build()
    expect(drawer.isOpen).toBe(false)
    expect(drawer.el.classList.contains('collapsed')).toBe(true)
    expect(requested).toEqual([])
    drawer.open()
    expect(drawer.isOpen).toBe(true)
    expect(drawer.storeId).toBe('rsg')
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('RSG lab data')
    expect(all(drawer.el, '.gallery-card').length).toBeGreaterThan(0)
    // The lab's store is inline: still nothing fetched.
    expect(requested).toEqual([])
  })

  it('links out to the store’s own site, beside the download', () => {
    const { drawer } = build()
    drawer.open('dnazoo')
    const link = drawer.el.querySelector('.store-head-actions .store-home') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('https://www.dnazoo.org/')
    // A new tab, and `noopener` — the page it opens is somebody else's, and a
    // link that hands over `window.opener` hands over this one.
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('title')).toContain('DNA Zoo')
    // Found on the turn `open` returns, before the catalogue it asked for has
    // answered: whose shelf this is does not wait on the read, and the reader
    // whose catalogue *failed* is exactly the one who wants the site behind it.
    // The download beside it is the opposite, and absent until there is a file.
    expect(drawer.el.querySelector('.store-head-actions .btn-icon:not(.store-home)')).toBeNull()
  })

  it('leaves the link out for a store that declares no home', () => {
    const { drawer } = build()
    // The custom door is a URL box; there is no site behind it to point at, so
    // there is no button rather than a dead one.
    drawer.open('custom')
    expect(drawer.el.querySelector('.store-head-actions .store-home')).toBeNull()
  })

  it('offers every store as a tile in its head, the open one marked', () => {
    const { drawer } = build()
    drawer.open('4dn')
    // The DNA Bacterial Zoo is a dev feature (§29), and the switch is off here.
    expect(textsOf(drawer.el, '.store-head-tiles .store-tile-name')).toEqual([
      'RSG lab data',
      'IGV genomes',
      '4DN open data',
      'ENCODE',
      'DNA Zoo',
      'Roadmap (UCSC hub)',
      'Connect to a UCSC hub',
      'Add a custom store',
    ])
    expect(drawer.el.querySelector('.store-tile.is-on .store-tile-name')?.textContent).toBe('4DN open data')
    // …and opening a portal is the gesture that reads its rows, and the
    // sessions beside them.
    expect(requested.some((url) => /stores\/4dn\.json$/.test(url))).toBe(true)
    expect(requested.some((url) => /stores\/4dn-sessions\.json$/.test(url))).toBe(true)
  })

  it('reopens the store it was last in, from the header button', () => {
    const { drawer } = build()
    drawer.open('igv')
    drawer.close()
    drawer.toggle.click()
    expect(drawer.storeId).toBe('igv')
    drawer.toggle.click()
    expect(drawer.isOpen).toBe(false)
  })

  it('can be aimed at a store without opening, for the header button to land on (§30)', () => {
    // The tutorial's first step is that button, and what it opens has to be
    // the lab's store whatever the browser remembers from an earlier visit.
    const earlier = build()
    earlier.drawer.open('4dn')
    earlier.drawer.destroy()
    const { drawer } = build()
    drawer.toggle.click()
    expect(drawer.storeId).toBe('4dn')
    drawer.close()
    drawer.aim('rsg')
    drawer.aim('not-a-store')
    expect(drawer.isOpen).toBe(false)
    drawer.toggle.click()
    expect(drawer.storeId).toBe('rsg')
  })

  it('says what the header button opens without a list of stores to go stale', () => {
    // It named four — the lab's data, IGV's genomes, 4DN, ENCODE — beside a
    // drawer whose tiles were seven of the shipped ones; the tiles are the list.
    const { drawer } = build()
    expect(drawer.toggle.title).toMatch(/^Open the stores — every data store this viewer ships with/)
    expect(drawer.toggle.title).not.toContain('IGV’s genomes')
    drawer.toggle.click()
    expect(drawer.toggle.title).toMatch(/^Close the stores/)
  })

  it('tells the shell about its layout on open and close', () => {
    const built = build()
    built.drawer.open()
    built.drawer.close()
    expect(built.layouts).toBe(2)
  })
})

describe('the address bar', () => {
  it('names the store while it is open, and not once it is closed', () => {
    const { drawer } = build()
    drawer.open('igv')
    expect(window.location.search).toBe('?store=igv')
    drawer.close()
    expect(window.location.search).toBe('')
  })

  it('carries the view of a portal as the reader narrows it', async () => {
    const { drawer } = build()
    drawer.open('4dn')
    await vi.waitFor(() => expect(all(drawer.el, '.facet-value').length).toBeGreaterThan(0))
    const box = drawer.el.querySelector('.facet-value input') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    // The first value on the rail: the two assays tie on count, so the
    // alphabetical one leads.
    expect(window.location.search).toBe('?store=4dn&assay=ChIP-seq')
    ;(all<HTMLButtonElement>(drawer.el, '.portal-mode')[1]).click()
    expect(window.location.search).toBe('?store=4dn&assay=ChIP-seq&view=matrix')
  })

  it('leaves the page’s own parameters and the hash alone', () => {
    window.history.replaceState(null, '', '/?config=c.json#view=genomes')
    const { drawer } = build()
    drawer.open('igv')
    expect(window.location.search).toBe('?config=c.json&store=igv')
    expect(window.location.hash).toBe('#view=genomes')
    drawer.close()
    expect(window.location.search).toBe('?config=c.json')
    expect(window.location.hash).toBe('#view=genomes')
  })

  it('lands on what a link named: a shipped id with its view, or a URL', async () => {
    const { drawer } = build()
    drawer.openLink('4dn', { ...EMPTY_VIEW, mode: 'matrix' })
    await vi.waitFor(() => expect(drawer.el.querySelector('.matrix-table')).not.toBeNull())
    drawer.openLink('https://lab.example/store.json', EMPTY_VIEW)
    expect(drawer.storeId).toBe('custom')
    await vi.waitFor(() => expect(all(drawer.el, '.portal-row').length).toBe(2))
    expect(window.location.search).toBe('?store=https%3A%2F%2Flab.example%2Fstore.json')
    // Put down and picked up again, it is the same store by URL — not the
    // shipped one the browser remembers across reloads.
    drawer.close()
    drawer.toggle.click()
    expect(drawer.storeId).toBe('custom')
    await vi.waitFor(() => expect(all(drawer.el, '.portal-row').length).toBe(2))
    expect(window.location.search).toBe('?store=https%3A%2F%2Flab.example%2Fstore.json')
    // A name nothing answers to opens nothing.
    drawer.close()
    drawer.openLink('nothing-like-it', EMPTY_VIEW)
    expect(drawer.isOpen).toBe(false)
  })
})

describe('coming back', () => {
  it('reopens a store where it was left', async () => {
    const { drawer } = build()
    drawer.open('4dn')
    await vi.waitFor(() => expect(all(drawer.el, '.facet-value').length).toBeGreaterThan(0))
    const box = drawer.el.querySelector('.facet-value input') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    drawer.close()
    drawer.open('4dn')
    await vi.waitFor(() => expect(all(drawer.el, '.facet-value').length).toBeGreaterThan(0))
    expect(window.location.search).toBe('?store=4dn&assay=ChIP-seq')
    expect(all(drawer.el, '.portal-row')).toHaveLength(1)
  })

  it('puts the drawer down on Escape, unless a caret is in one of its boxes', () => {
    const { drawer } = build()
    drawer.open('igv')
    const box = drawer.el.querySelector('.portal-search') as HTMLInputElement
    box.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(drawer.isOpen).toBe(true)
    box.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(drawer.isOpen).toBe(false)
  })
})

describe('a store the reader connected', () => {
  it('appears as a tile, opens on its own rows, and can be forgotten from its page', async () => {
    const row = addStoreRow({ label: 'Lab shelf', url: 'https://lab.example/store.json' })
    const { drawer } = build()
    drawer.open(row.id)
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('Lab shelf')
    expect(textsOf(drawer.el, '.store-head-tiles .store-tile-name')).toContain('Lab shelf')
    await vi.waitFor(() => expect(all(drawer.el, '.portal-row').length).toBe(2))
    // The address names the URL, which is what another reader can open.
    expect(window.location.search).toBe('?store=https%3A%2F%2Flab.example%2Fstore.json')
    ;(buttonNamed(drawer.el, 'forget this store') as HTMLButtonElement).click()
    expect(textsOf(drawer.el, '.store-head-tiles .store-tile-name')).not.toContain('Lab shelf')
  })
})

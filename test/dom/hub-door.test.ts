// @vitest-environment jsdom
/**
 * The track-hub door, end to end (§24.10).
 *
 * `test/unit/hub.test.ts` pins the translation — what the stanzas mean and what
 * the store comes out as. What is pinned here is the claim the translation
 * exists to make, which is that a hub is **first class**: pasted into the door
 * on the landing page, it lands in the same page every other store does, with
 * its assemblies as headings, the hub's own composite names as a facet, and
 * *open with its tracks* on each heading — a verb that exists for the portals
 * because somebody published a session file, and exists here because the genome
 * row carries its shelf.
 *
 * And the other half: a hub arriving through `?store=` lands on the hub door
 * rather than the store one, because `fetchStore` reads either from either and
 * the only thing left to get right is which tile is lit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_VIEW } from '@/state/facets'
import { StoreDrawer } from '@/ui/StoreDrawer'
import type { StoreEntry } from '@/state/store'
import type { StoreHost } from '@/ui/stores/host'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let requested: string[]

const HUB_URL = 'https://lab.example.org/myHub/hub.txt'

const FILES: Record<string, string> = {
  [HUB_URL]: 'hub lab\nshortLabel Lab hub\nlongLabel The lab’s 2026 tracks\ngenomesFile genomes.txt\n',
  'https://lab.example.org/myHub/genomes.txt':
    'genome galGal7\ntrackDb trackDb.txt\ntwoBitPath galGal7.2bit\norganism Chicken\n',
  'https://lab.example.org/myHub/trackDb.txt': [
    'track signal',
    'compositeTrack on',
    'shortLabel Signal',
    'type bigWig',
    '',
    '    track rep1',
    '    parent signal on',
    '    shortLabel Rep 1',
    '    bigDataUrl rep1.bw',
    '    type bigWig',
    '',
    'track loops',
    'shortLabel Loops',
    'bigDataUrl loops.inter.bb',
    'type bigInteract',
    '',
    'track reads',
    'shortLabel Reads',
    'bigDataUrl sample.cram',
    'type cram',
    '',
  ].join('\n'),
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  requested = []
  vi.stubGlobal('fetch', (url: unknown) => {
    requested.push(String(url))
    const body = FILES[String(url)]
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      statusText: body === undefined ? 'Not Found' : 'OK',
      text: () => Promise.resolve(body ?? ''),
    })
  })
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

function build(): { drawer: StoreDrawer; opened: StoreEntry[] } {
  const opened: StoreEntry[] = []
  const host: StoreHost = {
    open: (entry) => opened.push(entry),
    add: () => undefined,
    openTogether: () => undefined,
    tabEmpty: () => true,
  }
  const drawer = new StoreDrawer({ host })
  const body = document.createElement('div')
  body.className = 'app-body'
  body.appendChild(drawer.el)
  document.body.appendChild(body)
  return { drawer, opened }
}

/** Let the three chained fetches and the paint that follows them settle. */
async function settled(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('the hub door', () => {
  it('opens as a door with a box and fetches nothing until a URL is given', () => {
    const { drawer } = build()
    drawer.open('hub')
    expect(drawer.storeId).toBe('hub')
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('A track hub')
    // The sentence over the box says *hub*, which is the whole reason this is a
    // door of its own rather than a line in the store one.
    expect(drawer.el.querySelector('.custom-form .hint')?.textContent).toContain('track hub')
    expect((drawer.el.querySelector('.custom-url') as HTMLInputElement).placeholder).toContain(
      'hub.txt',
    )
    expect(requested).toEqual([])
  })

  it('reads a hub’s three files and draws it as a store', async () => {
    const { drawer } = build()
    drawer.open('hub')
    const box = drawer.el.querySelector('.custom-url') as HTMLInputElement
    box.value = HUB_URL
    buttonNamed(drawer.el, 'open')?.click()
    await settled()

    expect(requested).toEqual([
      HUB_URL,
      'https://lab.example.org/myHub/genomes.txt',
      'https://lab.example.org/myHub/trackDb.txt',
    ])
    // The hub's own name is the store's name.
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('Lab hub')
    // Grouped by assembly, which is what a hub is.
    expect(textsOf(drawer.el, '.portal-group-key')).toEqual(['galGal7'])
    // Every drawable track, and the assembly hub's own sequence, as rows.
    expect(textsOf(drawer.el, '.portal-name')).toEqual(['Chicken (galGal7)', 'Rep 1', 'Loops'])
    // …and not the CRAM, which gets no row at all.
    expect(textsOf(drawer.el, '.portal-name')).not.toContain('Reads')
  })

  it('offers *open with its tracks* on the assembly, from the row that carries them', async () => {
    const { drawer, opened } = build()
    drawer.open('hub')
    const box = drawer.el.querySelector('.custom-url') as HTMLInputElement
    box.value = HUB_URL
    buttonNamed(drawer.el, 'open')?.click()
    await settled()

    const verb = drawer.el.querySelector('.portal-session') as HTMLButtonElement
    expect(verb).not.toBeNull()
    verb.click()
    // The genome row, which is the hub's own `.2bit` — and it arrives carrying
    // the shelf, which is what the verb promises.
    expect(opened).toHaveLength(1)
    expect(opened[0].uri).toBe('https://lab.example.org/myHub/galGal7.2bit')
    expect(opened[0].tracks?.map((track) => track.label)).toEqual(['Rep 1', 'Loops'])
  })

  it('lands a ?store= hub link on the hub door rather than the store one', async () => {
    const { drawer } = build()
    drawer.openLink(HUB_URL, EMPTY_VIEW)
    await settled()
    expect(drawer.storeId).toBe('hub')
    expect(drawer.el.querySelector('.store-tile.is-on .store-tile-name')?.textContent).toBe(
      'A track hub',
    )
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('Lab hub')
  })

  it('offers to remember a hub, as it does any other store', async () => {
    const { drawer } = build()
    drawer.open('hub')
    const box = drawer.el.querySelector('.custom-url') as HTMLInputElement
    box.value = HUB_URL
    buttonNamed(drawer.el, 'open')?.click()
    await settled()
    expect(buttonNamed(drawer.el, 'remember this store')).not.toBeNull()
    buttonNamed(drawer.el, 'remember this store')?.click()
    // …and it comes back as a tile of its own, under the hub's mark.
    const names = textsOf(drawer.el, '.store-head-tiles .store-tile-name')
    expect(names).toContain('Lab hub')
    const marks = all(drawer.el, '.store-head-tiles .store-tile')
      .filter((tile) => tile.textContent?.includes('Lab hub'))
      .map((tile) => tile.querySelector('.store-mark')?.textContent)
    expect(marks[0]).toContain('HUB')
  })
})

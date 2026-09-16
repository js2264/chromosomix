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

function build(): { drawer: StoreDrawer; opened: StoreEntry[]; withTracks: StoreEntry[] } {
  const opened: StoreEntry[] = []
  const withTracks: StoreEntry[] = []
  const host: StoreHost = {
    open: (entry) => opened.push(entry),
    openWithTracks: (entry) => withTracks.push(entry),
    add: () => undefined,
    openTogether: () => undefined,
    tabEmpty: () => true,
  }
  const drawer = new StoreDrawer({ host })
  const body = document.createElement('div')
  body.className = 'app-body'
  body.appendChild(drawer.el)
  document.body.appendChild(body)
  return { drawer, opened, withTracks }
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
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('Add a UCSC hub')
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
    const { drawer, opened, withTracks } = build()
    drawer.open('hub')
    const box = drawer.el.querySelector('.custom-url') as HTMLInputElement
    box.value = HUB_URL
    buttonNamed(drawer.el, 'open')?.click()
    await settled()

    const verb = drawer.el.querySelector('.portal-session') as HTMLButtonElement
    expect(verb).not.toBeNull()
    verb.click()
    // Through the verb that *loads* them, not the one that merely opens: the
    // words on the button are a promise, and a reader who presses them and gets
    // a genome with an offer beside it has been handed the thing they pressed
    // past (`ui/stores/host.ts`).
    expect(opened).toHaveLength(0)
    expect(withTracks).toHaveLength(1)
    expect(withTracks[0].uri).toBe('https://lab.example.org/myHub/galGal7.2bit')
    expect(withTracks[0].tracks?.map((track) => track.label)).toEqual(['Rep 1', 'Loops'])
    // …while a row's own open verb stays the plain one.
    ;(drawer.el.querySelector('.portal-row .row-verb-new') as HTMLButtonElement)?.click()
    expect(opened.length + withTracks.length).toBeGreaterThan(1)
  })

  it('promises only the tracks the hub switched on', async () => {
    const { drawer, withTracks } = build()
    drawer.open('hub')
    const text = drawer.el.querySelector('.custom-text') as HTMLTextAreaElement
    text.value = [
      'hub big',
      'shortLabel Big hub',
      '',
      'genome hg19',
      '',
      'track chip',
      'compositeTrack on',
      'shortLabel ChIP',
      'type bigWig',
      'visibility dense',
      '',
      '    track one',
      '    parent chip on',
      '    shortLabel One',
      '    bigDataUrl https://lab.example.org/one.bw',
      '    type bigWig',
      '',
      '    track two',
      '    parent chip off',
      '    shortLabel Two',
      '    bigDataUrl https://lab.example.org/two.bw',
      '    type bigWig',
      '',
      'track hidden',
      'compositeTrack on',
      'shortLabel Hidden',
      'type bigWig',
      'visibility hide',
      '',
      '    track three',
      '    parent hidden on',
      '    shortLabel Three',
      '    bigDataUrl https://lab.example.org/three.bw',
      '    type bigWig',
      '',
    ].join('\n')
    buttonNamed(drawer.el, 'open what is pasted')?.click()
    await settled()

    // All three have rows — off by default is not absent.
    const names = textsOf(drawer.el, '.portal-name')
    expect(names).toContain('One')
    expect(names).toContain('Two')
    expect(names).toContain('Three')
    // …and the button says what it will do, which on a real hub is the whole
    // difference between a shelf and four hundred bigWigs at one press.
    const verb = drawer.el.querySelector('.portal-session') as HTMLButtonElement
    expect(verb.title).toContain('its 1 track')
    verb.click()
    expect(withTracks[0].tracks?.map((track) => track.label)).toEqual(['One'])
  })

  it('reads a hub pasted into the box, with nothing fetched', async () => {
    const { drawer } = build()
    drawer.open('hub')
    requested.length = 0
    const text = drawer.el.querySelector('.custom-text') as HTMLTextAreaElement
    expect(text).not.toBeNull()
    text.value = [
      'hub pasted',
      'shortLabel Pasted hub',
      '',
      'genome hg38',
      'organism Human',
      '',
      'track cov',
      'shortLabel Coverage',
      'bigDataUrl https://lab.example.org/data/cov.bw',
      'type bigWig',
      '',
    ].join('\n')
    buttonNamed(drawer.el, 'open what is pasted')?.click()
    await settled()

    // The whole point: a shelf on screen and not one request made, which is what
    // gets past a host that will not allow a cross-origin GET.
    expect(requested).toEqual([])
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('Pasted hub')
    expect(textsOf(drawer.el, '.portal-name')).toEqual(['Human (hg38)', 'Coverage'])
    // Nothing to remember: a pasted shelf has no address, and offering to keep
    // one would be keeping a URL that does not exist.
    expect(buttonNamed(drawer.el, 'remember this store')).toBeNull()
  })

  it('fills the box with an example that then opens', async () => {
    const { drawer } = build()
    drawer.open('hub')
    requested.length = 0
    buttonNamed(drawer.el, 'fill in an example')?.click()
    const text = drawer.el.querySelector('.custom-text') as HTMLTextAreaElement
    expect(text.value).toContain('hub exampleHub')
    // The point of the button: what it puts in the box is a thing that *reads*,
    // so the reader's first edit is to something that already drew a shelf.
    buttonNamed(drawer.el, 'open what is pasted')?.click()
    await settled()
    expect(requested).toEqual([])
    expect(drawer.el.querySelector('.store-title')?.textContent).toBe('Example hub')
    expect(textsOf(drawer.el, '.portal-name')).toContain('MNase')
  })

  it('asks before replacing a box that is not empty', () => {
    const { drawer } = build()
    drawer.open('hub')
    const text = drawer.el.querySelector('.custom-text') as HTMLTextAreaElement
    text.value = 'hub halfWritten'
    // The box is where somebody's unfinished hub lives; the one thing this
    // button must not be is a way to lose it to a misclick.
    vi.stubGlobal('confirm', () => false)
    buttonNamed(drawer.el, 'fill in an example')?.click()
    expect(text.value).toBe('hub halfWritten')
    vi.stubGlobal('confirm', () => true)
    buttonNamed(drawer.el, 'fill in an example')?.click()
    expect(text.value).toContain('hub exampleHub')
  })

  it('says what is missing when only the hub.txt is pasted', async () => {
    const { drawer } = build()
    drawer.open('hub')
    const text = drawer.el.querySelector('.custom-text') as HTMLTextAreaElement
    text.value = 'hub lab\nshortLabel Lab hub\ngenomesFile genomes.txt\n'
    buttonNamed(drawer.el, 'open what is pasted')?.click()
    await settled()
    const status = drawer.el.querySelector('.portal-status')?.textContent ?? ''
    expect(status).toContain('hub.txt alone')
    expect(status).toContain('genomes.txt')
  })

  it('lands a ?store= hub link on the hub door rather than the store one', async () => {
    const { drawer } = build()
    drawer.openLink(HUB_URL, EMPTY_VIEW)
    await settled()
    expect(drawer.storeId).toBe('hub')
    expect(drawer.el.querySelector('.store-tile.is-on .store-tile-name')?.textContent).toBe(
      'Add a UCSC hub',
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

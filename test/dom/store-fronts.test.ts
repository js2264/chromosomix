// @vitest-environment jsdom
/**
 * The three fronts that are not the portal: the lab's gallery, IGV's genomes
 * and a store by URL.
 *
 * Each is a different page over the same file format, and what is pinned is
 * that each draws what its store is *for*: a figure as a card with one button,
 * a genome as a card whose button is its pre-configured session, and a URL box
 * that becomes a portal with the offer to remember it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_VIEW } from '@/state/facets'
import { STORE_KIND, STORE_VERSION, type StoreEntry } from '@/state/store'
import { readStoreRows } from '@/state/stores'
import { CustomView } from '@/ui/stores/CustomView'
import { GalleryView } from '@/ui/stores/GalleryView'
import { GenomesView } from '@/ui/stores/GenomesView'
import type { StoreHost } from '@/ui/stores/host'
import { customStore, frontById } from '@/ui/stores/registry'
import { storeMark } from '@/ui/stores/marks'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function host(opened: StoreEntry[], empty = true): StoreHost {
  return {
    open: (entry) => opened.push(entry),
    add: () => undefined,
    openTogether: () => undefined,
    tabEmpty: () => empty,
  }
}

function store(name: string, entries: StoreEntry[], columns: Array<{ key: string; label: string }> = []): string {
  return JSON.stringify({ kind: STORE_KIND, version: STORE_VERSION, name, columns, entries })
}

/** A `fetch` answering each URL with the body its path is mapped to, 404 otherwise. */
function serving(bodies: Record<string, string>): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: unknown) => {
    const address = String(url)
    requested.push(address)
    const body = Object.entries(bodies).find(([suffix]) => address.endsWith(suffix))?.[1]
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      statusText: body === undefined ? 'Not Found' : 'OK',
      text: () => Promise.resolve(body ?? ''),
    })
  })
  return requested
}

describe('the lab’s gallery', () => {
  it('draws one card per figure: the name and its one verb, the chips, the line, and its files under a fold', () => {
    const opened: StoreEntry[] = []
    const front = frontById('rsg')
    expect(front).not.toBeNull()
    const view = new GalleryView({ front: front as NonNullable<typeof front>, host: host(opened) })
    document.body.appendChild(view.el)
    // No headings and no section of files apart from the figures: every file
    // is under the figure it belongs to.
    expect(all(view.el, '.gallery-heading')).toHaveLength(0)
    const cards = all(view.el, '.gallery-card')
    expect(cards.length).toBe(4)
    // The first line is the name and the one verb, an icon with the words in its title.
    const head = cards[0].querySelector('.gallery-card-head') as HTMLElement
    expect(head.querySelector('.gallery-card-title')?.textContent).toBe('Yeast micro-C, G2/M')
    const open = head.querySelector('.gallery-card-open') as HTMLButtonElement
    expect(open.textContent).toBe('')
    expect(open.title).toContain('new session')
    expect(textsOf(cards[0], '.gallery-card-chips .portal-chip')[0]).toBe('S288C (syn XIII-40)')
    expect(cards[0].querySelector('.gallery-card-line')?.textContent).toContain('One map, with the sequence')
    open.click()
    expect(opened[0]?.kind).toBe('workspace')
    expect(opened[0]?.uri).toMatch(/Yeast_microC\.metacooler\.json$/)
    // The figure's own files, each a store row with the two verbs.
    const fold = cards[0].querySelector('.gallery-card-more') as HTMLElement
    expect(fold.querySelector('summary')?.textContent).toBe('8 files')
    expect(all(fold, '.portal-row')).toHaveLength(8)
    expect(all(fold, '.row-verb-add')).toHaveLength(8)
    // The deck's four, the tracks-only figure's eleven, the metagenome's two.
    expect(textsOf(view.el, '.gallery-card-more > summary').slice(0, 4)).toEqual([
      '8 files',
      '11 files',
      '4 files',
      '2 files',
    ])
    // …and the files no figure names — two maps, the shotgun coverage and the
    // synthetic barChart, which is deliberately in none: every figure here
    // carries a DOI, and a lane of generated numbers does not belong in one.
    // They are still offered, under the cards.
    const loose = view.el.querySelector('.gallery-loose') as HTMLElement
    expect(loose.querySelector('summary')?.textContent).toBe('4 more files, in no figure')
    expect(all(loose, '.portal-row')).toHaveLength(4)
  })
})

describe('IGV’s genomes', () => {
  it('draws one card per genome from the sessions, with its files under a fold', async () => {
    const requested = serving({
      'igv-sessions.json': store('IGV genome sessions', [
        {
          label: 'hg38 and its 1 track',
          uri: 'sessions/igv-hg38.metacooler.json',
          kind: 'workspace',
          note: 'hg38 · s3.amazonaws.com',
          fields: { assembly: 'hg38', subject: 'Human (GRCh38/hg38)', tracks: '2', dataset: 'hg38' },
        },
      ]),
      'igv.json': store('IGV genomes', [
        {
          label: 'hg38 sequence',
          uri: 'https://igv.example/hg38.fa',
          kind: 'genome',
          fields: { assembly: 'hg38', genome: 'Human (GRCh38/hg38)', role: 'sequence' },
        },
        {
          label: 'hg38 genes',
          uri: 'https://igv.example/hg38.gtf.gz',
          kind: 'genome',
          fields: { assembly: 'hg38', genome: 'Human (GRCh38/hg38)', role: 'annotation' },
        },
        {
          label: 'mm10 sequence',
          uri: 'https://igv.example/mm10.fa',
          kind: 'genome',
          fields: { assembly: 'mm10', genome: 'Mouse (mm10)', role: 'sequence' },
        },
      ]),
    })
    const opened: StoreEntry[] = []
    const front = frontById('igv')
    const view = new GenomesView({ front: front as NonNullable<typeof front>, host: host(opened) })
    document.body.appendChild(view.el)
    await vi.waitFor(() => expect(all(view.el, '.genomes-card').length).toBe(2))
    expect(requested.length).toBe(2)
    const cards = all(view.el, '.genomes-card')
    // The name without the assembly IGV brackets after it — that is the chip.
    expect(textsOf(cards[0], '.gallery-card-head .gallery-card-title')).toEqual(['Human'])
    expect(cards[0].querySelector('.gallery-card-title')?.getAttribute('title')).toBe('Human (GRCh38/hg38)')
    expect(textsOf(cards[0], '.gallery-card-chips .portal-chip')).toEqual(['hg38', '2 tracks'])
    // The one verb, at the end of the name's line, an icon with the words in its title.
    const open = cards[0].querySelector('.gallery-card-head .gallery-card-open') as HTMLButtonElement
    expect(open.textContent).toBe('')
    expect(open.title).toContain('every track IGV ships')
    open.click()
    expect(opened[0]?.kind).toBe('workspace')
    expect(cards[0].querySelector('.gallery-card-more > summary')?.textContent).toBe('2 files')
    expect(all(cards[0], '.portal-row').length).toBe(2)
    // A genome with rows and no session says so rather than offering nothing.
    expect(cards[1].querySelector('.gallery-card-open')).toBeNull()
    expect(cards[1].textContent).toContain('No session was published')

    const box = view.el.querySelector('.portal-search') as HTMLInputElement
    box.value = 'mouse'
    box.dispatchEvent(new Event('input'))
    expect(all(view.el, '.genomes-card').length).toBe(1)
  })

  it('says what generates the store when neither file is there yet', async () => {
    serving({})
    const front = frontById('igv')
    const view = new GenomesView({ front: front as NonNullable<typeof front>, host: host([]) })
    document.body.appendChild(view.el)
    await vi.waitFor(() =>
      expect(view.el.querySelector('.portal-status')?.textContent).toContain('not generated yet'),
    )
  })
})

describe('a store by URL', () => {
  it('reads the typed URL into a portal, offers to remember it, and forgets it again', async () => {
    serving({
      'store.json': store(
        'Lab shelf',
        [{ label: 'One', uri: 'one.mcool', kind: 'map', fields: { assay: 'Hi-C' } }],
        [{ key: 'assay', label: 'Assay' }],
      ),
    })
    const targets: string[] = []
    let changes = 0
    const view = new CustomView({
      front: customStore(),
      host: host([]),
      view: EMPTY_VIEW,
      onView: () => undefined,
      onTarget: (url) => targets.push(url),
      onChanged: () => {
        changes++
      },
    })
    document.body.appendChild(view.el)
    expect(all(view.el, '.portal-row')).toHaveLength(0)
    const box = view.el.querySelector('.custom-url') as HTMLInputElement
    box.value = 'https://lab.example/store.json'
    ;(buttonNamed(view.el, 'open') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(all(view.el, '.portal-row').length).toBe(1))
    expect(targets).toEqual(['https://lab.example/store.json'])
    ;(buttonNamed(view.el, 'remember this store') as HTMLButtonElement).click()
    expect(readStoreRows().map((row) => row.label)).toEqual(['Lab shelf'])
    expect(changes).toBe(1)
    ;(buttonNamed(view.el, 'forget this store') as HTMLButtonElement).click()
    expect(readStoreRows()).toEqual([])
  })

  it('refuses an address that is not http(s) before fetching anything', () => {
    const requested = serving({})
    const view = new CustomView({ front: customStore(), host: host([]), view: EMPTY_VIEW, onView: () => undefined })
    document.body.appendChild(view.el)
    const box = view.el.querySelector('.custom-url') as HTMLInputElement
    box.value = 'ftp://lab.example/store.json'
    ;(buttonNamed(view.el, 'open') as HTMLButtonElement).click()
    expect(view.el.querySelector('.portal-status')?.textContent).toContain('not an http(s) URL')
    expect(requested).toEqual([])
  })

  it('says which kind of file it got when it was not a store', async () => {
    serving({ 'store.json': '{"kind":"metacooler.workspace","tabs":[]}' })
    const view = new CustomView({ front: customStore(), host: host([]), view: EMPTY_VIEW, onView: () => undefined })
    document.body.appendChild(view.el)
    const box = view.el.querySelector('.custom-url') as HTMLInputElement
    box.value = 'https://lab.example/store.json'
    ;(buttonNamed(view.el, 'open') as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect(view.el.querySelector('.portal-status')?.textContent).toContain('not a store'),
    )
  })
})

describe('a mark', () => {
  it('is the word in the colour, scaled to fit, and its short form on a small tile', () => {
    const large = storeMark({ text: 'ENCODE', short: 'ENC', colour: '#5a4fa2' }, 72)
    expect(large.textContent).toBe('ENCODE')
    expect(large.style.width).toBe('72px')
    const small = storeMark({ text: 'ENCODE', short: 'ENC', colour: '#5a4fa2' }, 26)
    expect(small.textContent).toBe('ENC')
    // Longer words are set smaller so they stay inside the square.
    expect(Number.parseInt(large.style.fontSize, 10)).toBeLessThan(
      Number.parseInt(storeMark({ text: 'IGV', colour: '#000' }, 72).style.fontSize, 10),
    )
  })
})

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
import { STORE_KIND, STORE_VERSION, type StoreEntry, type StoreFile } from '@/state/store'
import { readStoreRows } from '@/state/stores'
import { CustomView } from '@/ui/stores/CustomView'
import { GalleryView } from '@/ui/stores/GalleryView'
import { GenomesView } from '@/ui/stores/GenomesView'
import type { StoreHost } from '@/ui/stores/host'
import { customStore, frontById } from '@/ui/stores/registry'
import { storeMark } from '@/ui/stores/marks'
import { resetDevFeatures } from '@/state/devFeatures'
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
    openWithTracks: (entry) => opened.push(entry),
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
  // Every figure, the metagenome's included, is what the gallery draws with
  // the dev features switch on; the last case here is what it draws with it off.
  beforeEach(() => resetDevFeatures(true))
  afterEach(() => resetDevFeatures())

  it('draws no card and no file of the multi-genome format while dev features are off (§29)', () => {
    resetDevFeatures(false)
    const front = frontById('rsg')
    const view = new GalleryView({ front: front as NonNullable<typeof front>, host: host([]) })
    document.body.appendChild(view.el)
    expect(all(view.el, '.gallery-card')).toHaveLength(7)
    expect(view.el.textContent ?? '').not.toMatch(/\.m?metacool(?!er)|mock (microbial )?community|\bMAGs?\b/i)
  })

  it('files the figures under Demo and Papers, in the order the store gives them', () => {
    const front = frontById('rsg')
    const view = new GalleryView({ front: front as NonNullable<typeof front>, host: host([]) })
    document.body.appendChild(view.el)
    // One heading a section, over its own run of cards — what the viewer does,
    // then the figures of the lab's papers.
    expect(textsOf(view.el, '.gallery-heading')).toEqual(['Demo', 'Papers'])
    const sections = all(view.el, '.gallery-section')
    expect(textsOf(sections[0], '.gallery-card-title')).toEqual([
      'Yeast micro-C',
      'Yeast chromatin landscape',
      'Hi-C, micro-C and PCP',
      'Splicing on human chrX',
      'Mitotic chromosome formation',
      'Mock microbial community',
    ])
    expect(textsOf(sections[1], '.gallery-card-title')).toEqual([
      'Chromlens, Fig. 1',
      'Bacterial chromosomes in a yeast nucleus',
    ])
    // The files no figure names are still the gallery's, not a section's.
    expect(view.el.querySelector('.gallery-section .gallery-loose')).toBeNull()
  })

  it('draws a store whose figures name no section as one run of cards, with no heading', () => {
    const entries: StoreEntry[] = [
      { label: 'One', uri: 'https://lab.example.org/one.metacooler.json', kind: 'workspace' },
      { label: 'Two', uri: 'https://lab.example.org/two.metacooler.json', kind: 'workspace' },
    ]
    const front = frontById('rsg') as NonNullable<ReturnType<typeof frontById>>
    const rows = front.rows as NonNullable<typeof front.rows>
    const inline: StoreFile = { kind: STORE_KIND, version: STORE_VERSION, name: 'Two figures', columns: [], entries }
    const view = new GalleryView({ front: { ...front, rows: { ...rows, inline } }, host: host([]) })
    document.body.appendChild(view.el)
    expect(all(view.el, '.gallery-heading')).toHaveLength(0)
    expect(all(view.el, '.gallery-section')).toHaveLength(0)
    expect(textsOf(view.el, '.gallery-card-title')).toEqual(['One', 'Two'])
  })

  it('draws one card per figure: the name and its one verb, the chips, the line, and its files under a fold', () => {
    const opened: StoreEntry[] = []
    const front = frontById('rsg')
    expect(front).not.toBeNull()
    const view = new GalleryView({ front: front as NonNullable<typeof front>, host: host(opened) })
    document.body.appendChild(view.el)
    const cards = all(view.el, '.gallery-card')
    expect(cards.length).toBe(8)
    // The first line is the name and the one verb, an icon with the words in its title.
    const head = cards[0].querySelector('.gallery-card-head') as HTMLElement
    expect(head.querySelector('.gallery-card-title')?.textContent).toBe('Yeast micro-C')
    const open = head.querySelector('.gallery-card-open') as HTMLButtonElement
    expect(open.textContent).toBe('')
    expect(open.title).toContain('new tab')
    expect(textsOf(cards[0], '.gallery-card-chips .portal-chip')[0]).toBe('S288C (R64)')
    expect(cards[0].querySelector('.gallery-card-line')?.textContent).toContain('One map at 1.6 kb')
    open.click()
    expect(opened[0]?.kind).toBe('workspace')
    expect(opened[0]?.uri).toMatch(/store\/yeast\/Yeast_microC\.metacooler\.json$/)
    // The figure's own files, each a store row with the two verbs.
    const fold = cards[0].querySelector('.gallery-card-more') as HTMLElement
    expect(fold.querySelector('summary')?.textContent).toBe('9 files')
    expect(all(fold, '.portal-row')).toHaveLength(9)
    expect(all(fold, '.row-verb-add')).toHaveLength(9)
    // The landscape's seven, the three maps' five, human chrX's five, the time
    // course's fifteen, the metagenome's two; then the papers: Fig. 1's seven
    // and the Meneu paper's sixteen.
    expect(textsOf(view.el, '.gallery-card-more > summary').slice(0, 8)).toEqual([
      '9 files',
      '7 files',
      '5 files',
      '5 files',
      '15 files',
      '2 files',
      '7 files',
      '16 files',
    ])
    // A file one figure reaches into another's folder for is one row, under
    // both: the deck's Hi-C is the Meneu paper's G1 map.
    const deck = cards[2].querySelector('.gallery-card-more') as HTMLElement
    const meneu = cards[7].querySelector('.gallery-card-more') as HTMLElement
    expect(deck.textContent).toContain('Hi-C, M. mycoides, G1')
    expect(meneu.textContent).toContain('Hi-C, M. mycoides, G1')
    // …and the files no figure names: the micro-C map as a `.hic` and the
    // sequence as a `.2bit`, which the paste box's hub example points at
    // (§8.21, §24.10), and three junction tables of the human samples no
    // figure draws — two more STAR tables and one as regtools writes it.
    const loose = view.el.querySelector('.gallery-loose') as HTMLElement
    expect(loose.querySelector('summary')?.textContent).toBe('5 more files, in no figure')
    expect(all(loose, '.portal-row')).toHaveLength(5)
  })

  it('says nothing of the synthetic chromosome the old yeast demo was built on', () => {
    const front = frontById('rsg')
    const view = new GalleryView({ front: front as NonNullable<typeof front>, host: host([]) })
    document.body.appendChild(view.el)
    expect(view.el.textContent ?? '').not.toMatch(/syn ?XIII|XIII-?syn|syn-?40/i)
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
    expect(cards[1].textContent).toContain('IGV published no session')

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
      expect(view.el.querySelector('.portal-status')?.textContent).toContain(
        'Nothing has been published for',
      ),
    )
  })
})

describe('the DNA Bacterial Zoo', () => {
  it('reads its one file on the gesture and draws a card a species, its session the button', async () => {
    const requested = serving({
      'dbz/store.json': JSON.stringify({
        kind: STORE_KIND,
        version: STORE_VERSION,
        name: 'DNA Bacterial Zoo',
        columns: [{ key: 'species', label: 'Species' }],
        entries: [
          {
            label: 'V_cholerae — map with 8 tracks',
            uri: 'V/V.metacooler.json',
            kind: 'workspace',
            fields: { species: 'V_cholerae', id: 'CC340', sequences: '2 sequences', tracks: '8' },
          },
          { label: 'V_cholerae', uri: 'V/V.mcool', kind: 'map', fields: { species: 'V_cholerae', id: 'CC340' } },
        ],
      }),
    })
    const opened: StoreEntry[] = []
    const front = frontById('dbz')
    const view = new GenomesView({ front: front as NonNullable<typeof front>, host: host(opened) })
    document.body.appendChild(view.el)
    await vi.waitFor(() => expect(all(view.el, '.genomes-card').length).toBe(1))
    // One request, for the rows: the sessions are among them, not beside them.
    expect(requested).toEqual(['https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.json'])
    const [card] = all(view.el, '.genomes-card')
    expect(textsOf(card, '.gallery-card-title')).toEqual(['V_cholerae'])
    expect(textsOf(card, '.gallery-card-chips .portal-chip')).toEqual(['CC340', '2 sequences', '8 tracks'])
    ;(card.querySelector('.gallery-card-open') as HTMLButtonElement).click()
    expect(opened[0]?.kind).toBe('workspace')
    // The filter names the column the file calls the group, once the file is read.
    expect((view.el.querySelector('.portal-search') as HTMLInputElement).placeholder).toBe('filter by species')
    expect(view.fileNow()?.name).toBe('DNA Bacterial Zoo')
  })

  it('says what publishes it while it has not been uploaded — not the Stores workflow', async () => {
    serving({})
    const front = frontById('dbz')
    const view = new GenomesView({ front: front as NonNullable<typeof front>, host: host([]) })
    document.body.appendChild(view.el)
    await vi.waitFor(() =>
      expect(view.el.querySelector('.portal-status')?.textContent).toContain(
        'Nothing has been published for DNA Bacterial Zoo yet; scripts/dbz-store.sh builds it',
      ),
    )
    expect(view.el.querySelector('.portal-status')?.textContent).not.toContain('Stores workflow')
    expect(view.el.querySelector('.portal-search')?.closest('.hidden')).not.toBeNull()
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

  it('draws one card per group when the file asks for cards, its session the button', async () => {
    serving({
      'store.json': JSON.stringify({
        kind: STORE_KIND,
        version: STORE_VERSION,
        name: 'Bacteria',
        layout: 'cards',
        group: 'species',
        headline: ['id', 'sequences'],
        columns: [
          { key: 'species', label: 'Species' },
          { key: 'id', label: 'Sample ID' },
        ],
        entries: [
          {
            label: 'B_subtilis — map with 2 tracks',
            uri: 'bsub/bsub.metacooler.json',
            kind: 'workspace',
            note: 'Coverage, Insulation',
            fields: { species: 'B_subtilis', id: 'CC339', sequences: '1 sequence', tracks: '2' },
          },
          {
            label: 'B_subtilis',
            uri: 'bsub/bsub.mcool',
            kind: 'map',
            fields: { species: 'B_subtilis', id: 'CC339', sequences: '1 sequence' },
          },
          {
            label: 'B_subtilis · Insulation boundaries',
            uri: 'bsub/insulation.bed',
            kind: 'genome',
            note: '112 called',
            fields: { species: 'B_subtilis' },
          },
          // No session: the map carrying a shelf is the card's button instead.
          {
            label: 'V_cholerae',
            uri: 'vcho/vcho.mcool',
            kind: 'map',
            fields: { species: 'V_cholerae', id: 'CC340', sequences: '2 sequences' },
            tracks: [{ label: 'Coverage', url: 'vcho/coverage.bw' }],
          },
          { label: 'README', uri: 'notes.bed', kind: 'genome' },
        ],
      }),
    })
    const opened: StoreEntry[] = []
    const view = new CustomView({ front: customStore(), host: host(opened), view: EMPTY_VIEW, onView: () => undefined })
    document.body.appendChild(view.el)
    const box = view.el.querySelector('.custom-url') as HTMLInputElement
    box.value = 'https://lab.example/store.json'
    ;(buttonNamed(view.el, 'open') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(all(view.el, '.genomes-card').length).toBe(2))
    // Cards, not the portal: no facet rail and no flat rows over them.
    expect(view.el.querySelector('.facet-rail')).toBeNull()
    expect(view.fileNow()?.name).toBe('Bacteria')

    const [bsub, vcho] = all(view.el, '.genomes-card')
    expect(textsOf(bsub, '.gallery-card-title')).toEqual(['B_subtilis'])
    expect(textsOf(bsub, '.gallery-card-chips .portal-chip')).toEqual(['CC339', '1 sequence', '2 tracks'])
    // What the card is of, solid; its count, dim — as IGV's assembly and count are.
    expect(textsOf(bsub, '.gallery-card-chips .portal-chip-dim')).toEqual(['2 tracks'])
    // The session is the button and not also a row; the rows under the fold are
    // named without the card's own name, which stays in the tooltip.
    expect(bsub.querySelector('.gallery-card-more > summary')?.textContent).toBe('2 files')
    expect(textsOf(bsub, '.portal-name')).toEqual(['B_subtilis', 'Insulation boundaries'])
    expect(all(bsub, '.portal-name')[1].getAttribute('title')).toBe('B_subtilis · Insulation boundaries — 112 called')
    ;(bsub.querySelector('.gallery-card-open') as HTMLButtonElement).click()
    expect(opened.at(-1)?.kind).toBe('workspace')

    const lead = vcho.querySelector('.gallery-card-open') as HTMLButtonElement
    expect(lead.title).toContain('with its 1 track already on')
    lead.click()
    expect(opened.at(-1)?.label).toBe('V_cholerae')

    // A row in no group is kept, under the cards.
    expect(view.el.querySelector('.gallery-loose > summary')?.textContent).toBe('1 more file, in no species')

    const filter = view.el.querySelector('.portal-search') as HTMLInputElement
    expect(filter.placeholder).toBe('filter by species')
    filter.value = 'cc340'
    filter.dispatchEvent(new Event('input'))
    expect(textsOf(view.el, '.genomes-card .gallery-card-title')).toEqual(['V_cholerae'])
    expect(view.el.querySelector('.gallery-loose')).toBeNull()
  })

  it('draws a store that asks for cards with no group as the list', async () => {
    serving({
      'store.json': JSON.stringify({
        kind: STORE_KIND,
        version: STORE_VERSION,
        name: 'No group',
        layout: 'cards',
        columns: [],
        entries: [{ label: 'One', uri: 'one.mcool', kind: 'map' }],
      }),
    })
    const view = new CustomView({ front: customStore(), host: host([]), view: EMPTY_VIEW, onView: () => undefined })
    document.body.appendChild(view.el)
    const box = view.el.querySelector('.custom-url') as HTMLInputElement
    box.value = 'https://lab.example/store.json'
    ;(buttonNamed(view.el, 'open') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(all(view.el, '.portal-row').length).toBe(1))
    expect(all(view.el, '.genomes-card')).toHaveLength(0)
  })

  it('folds the list under a heading per group when the file names one and asks for no cards', async () => {
    serving({
      'store.json': JSON.stringify({
        kind: STORE_KIND,
        version: STORE_VERSION,
        name: 'Grouped',
        group: 'species',
        columns: [{ key: 'species', label: 'Species' }],
        entries: [
          { label: 'One', uri: 'one.mcool', kind: 'map', fields: { species: 'E_coli' } },
          { label: 'Two', uri: 'two.bw', kind: 'genome', fields: { species: 'E_coli' } },
          { label: 'Three', uri: 'three.mcool', kind: 'map', fields: { species: 'V_cholerae' } },
        ],
      }),
    })
    const view = new CustomView({ front: customStore(), host: host([]), view: EMPTY_VIEW, onView: () => undefined })
    document.body.appendChild(view.el)
    const box = view.el.querySelector('.custom-url') as HTMLInputElement
    box.value = 'https://lab.example/store.json'
    ;(buttonNamed(view.el, 'open') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(all(view.el, '.portal-row').length).toBe(3))
    expect(textsOf(view.el, '.portal-group .portal-group-key')).toEqual(['E_coli', 'V_cholerae'])
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

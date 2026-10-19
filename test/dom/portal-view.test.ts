// @vitest-environment jsdom
/**
 * A portal store on screen: the rail, the rows, the matrix and the tray.
 *
 * `state/facets.ts` owns the arithmetic and `test/unit/facets.test.ts` pins
 * it; what is worth pinning here is the wiring a screenshot cannot show. A tick
 * on the rail must narrow the rows *and* the view the drawer writes into the
 * address; a cell of the matrix must tick both of its values and hand the
 * reader back to the list; a group's *open with its tracks* must open the
 * session the generator paired with it; and the tray's *open together* must
 * hand over what was ticked, in the order it was ticked.
 *
 * Nothing here fetches: the store is handed over in hand, which is the custom
 * front's road and the cheapest one for a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_VIEW, type StoreView } from '@/state/facets'
import { STORE_KIND, STORE_VERSION, type StoreEntry, type StoreFile } from '@/state/store'
import { PortalView } from '@/ui/stores/PortalView'
import { countLine, DRAWN } from '@/ui/stores/ResultList'
import { traySummary } from '@/ui/stores/SelectionTray'
import type { StoreHost } from '@/ui/stores/host'
import type { StoreFront } from '@/ui/stores/registry'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
})

const FILE: StoreFile = {
  kind: STORE_KIND,
  version: STORE_VERSION,
  name: 'A portal',
  columns: [
    { key: 'assembly', label: 'Assembly' },
    { key: 'assay', label: 'Assay' },
    { key: 'biosource', label: 'Biosource' },
    { key: 'set', label: 'Experiment set' },
  ],
  entries: [
    {
      label: 'HFF map',
      uri: 'https://data.example/a.mcool',
      kind: 'map',
      size: 1000,
      fields: { assembly: 'GRCh38', assay: 'Hi-C', biosource: 'HFF', set: 'SET1' },
    },
    {
      label: 'HFF CTCF',
      uri: 'https://data.example/a.bw',
      kind: 'genome',
      fields: { assembly: 'GRCh38', assay: 'ChIP-seq', biosource: 'HFF', set: 'SET1' },
    },
    {
      label: 'K562 map',
      uri: 'https://data.example/b.hic',
      kind: 'map',
      fields: { assembly: 'hg19', assay: 'Hi-C', biosource: 'K562', set: 'SET2' },
    },
    {
      label: 'A loose sequence',
      uri: 'https://data.example/ref.fa',
      kind: 'genome',
      fields: { assembly: 'GRCh38' },
    },
  ],
}

const SESSION: StoreEntry = {
  label: 'SET1 with its tracks',
  uri: 'https://data.example/sessions/set1.chromosomix.json',
  kind: 'workspace',
  fields: { assembly: 'GRCh38', dataset: 'SET1', tracks: '2' },
}

const FRONT: StoreFront = {
  id: 'portal',
  label: 'A portal',
  blurb: '',
  kind: 'portal',
  mark: { text: 'P', colour: '#000' },
  builtin: false,
  group: 'set',
  headline: ['biosource', 'assay'],
  axes: ['assay', 'biosource'],
}

interface Built {
  view: PortalView
  el: HTMLElement
  opened: StoreEntry[]
  added: StoreEntry[]
  together: StoreEntry[][]
  views: StoreView[]
  dragged: StoreEntry[]
}

function build(options: { view?: StoreView; empty?: boolean; front?: StoreFront } = {}): Built {
  const opened: StoreEntry[] = []
  const added: StoreEntry[] = []
  const together: StoreEntry[][] = []
  const views: StoreView[] = []
  const dragged: StoreEntry[] = []
  const host: StoreHost = {
    open: (entry) => opened.push(entry),
    openWithTracks: (entry) => opened.push(entry),
    add: (entry) => added.push(entry),
    openTogether: (entries) => together.push([...entries]),
    drag: (entry) => void dragged.push(entry),
    tabEmpty: () => options.empty ?? true,
  }
  const view = new PortalView({
    front: options.front ?? FRONT,
    host,
    view: options.view ?? EMPTY_VIEW,
    onView: (next) => views.push(next),
    file: FILE,
  })
  document.body.appendChild(view.el)
  return { view, el: view.el, opened, added, together, views, dragged }
}

/** The rows' names, top to bottom. */
function names(el: HTMLElement): string[] {
  return textsOf(el, '.portal-name')
}

/** The rail's value rows under one heading, as `label count`. */
function facet(el: HTMLElement, label: string): string[] {
  const group = all(el, '.facet-group').find(
    (node) => (node.querySelector('.facet-label')?.textContent ?? '') === label,
  )
  expect(group, `no facet called ${label}`).toBeDefined()
  return all(group as HTMLElement, '.facet-value').map(
    (row) => `${row.querySelector('.facet-value-text')?.textContent} ${row.querySelector('.facet-count')?.textContent}`,
  )
}

function tick(el: HTMLElement, label: string, value: string): void {
  const group = all(el, '.facet-group').find(
    (node) => (node.querySelector('.facet-label')?.textContent ?? '') === label,
  ) as HTMLElement
  const row = all(group, '.facet-value').find(
    (node) => node.querySelector('.facet-value-text')?.textContent === value,
  ) as HTMLElement
  const box = row.querySelector('input') as HTMLInputElement
  box.checked = !box.checked
  box.dispatchEvent(new Event('change'))
}

describe('the rows', () => {
  it('draws every row under its group, the loose ones last, and counts them', () => {
    const { el } = build()
    expect(textsOf(el, '.portal-group-key')).toEqual(['SET1', 'SET2', 'not in a set'])
    expect(names(el)).toEqual(['HFF map', 'HFF CTCF', 'K562 map', 'A loose sequence'])
    expect(el.querySelector('.portal-count')?.textContent).toBe('4 files.')
    // The group heading repeats what the front said to: biosource, then assay.
    const first = el.querySelector('.portal-group') as HTMLElement
    expect(textsOf(first, '.portal-chip')).toEqual(['HFF', 'Hi-C'])
  })

  it('opens a row by its name, and carries the same two verbs on every file row', () => {
    const empty = build()
    ;(all<HTMLButtonElement>(empty.el, '.portal-name')[0]).click()
    expect(empty.opened.map((entry) => entry.label)).toEqual(['HFF map'])
    // Both marks whatever the tab holds — on an empty one they land in the same
    // place, and the tooltips say so rather than one of them vanishing.
    expect(all(empty.el, '.row-verb-add')).toHaveLength(4)
    expect(all(empty.el, '.row-verb-new')).toHaveLength(4)
    expect(all<HTMLButtonElement>(empty.el, '.row-verb-add')[0].title).toContain('which is empty')

    const holding = build({ empty: false })
    const adds = all<HTMLButtonElement>(holding.el, '.row-verb-add')
    expect(adds).toHaveLength(4)
    adds[1].click()
    expect(holding.added.map((entry) => entry.label)).toEqual(['HFF CTCF'])
    expect(adds[0].title).toContain('as a panel of the deck')
    expect(adds[1].title).toContain('as a track')
    all<HTMLButtonElement>(holding.el, '.row-verb-new')[2].click()
    expect(holding.opened.map((entry) => entry.label)).toEqual(['K562 map'])
    // Icons only: the words are in the tooltips.
    expect(adds[0].textContent).toBe('')
  })

  it('lets every file row be dragged, as a row of the Files column is, and no workspace (§24.2)', () => {
    const { el, dragged } = build()
    const rows = all<HTMLElement>(el, '.portal-row')
    expect(rows.map((row) => row.draggable)).toEqual([true, true, true, true])
    // The hand takes the row it began on, wherever on the row that was — the
    // name, a chip — and the shell is what marks the drag (`ui/fileDrag.ts`).
    const chip = rows[1].querySelector('.portal-name') as HTMLElement
    chip.dispatchEvent(new window.Event('dragstart', { bubbles: true }))
    expect(dragged.map((entry) => entry.label)).toEqual(['HFF CTCF'])

    // A saved session is tabs, not a file: there is nowhere to aim one.
    const sessions = new PortalView({
      front: FRONT,
      host: {
        open: () => undefined,
        openWithTracks: () => undefined,
        add: () => undefined,
        openTogether: () => undefined,
        drag: () => undefined,
        tabEmpty: () => true,
      },
      view: EMPTY_VIEW,
      onView: () => undefined,
      file: { ...FILE, entries: [...FILE.entries, SESSION] },
    })
    const row = all<HTMLElement>(sessions.el, '.portal-row').find(
      (node) => node.querySelector('.portal-name')?.textContent === SESSION.label,
    )
    expect(row?.draggable).toBe(false)
  })
})

describe('the rail', () => {
  it('counts every value, and recounts the others when one is ticked', () => {
    const built = build()
    expect(facet(built.el, 'Assay')).toEqual(['Hi-C 2', 'ChIP-seq 1', 'unspecified 1'])
    tick(built.el, 'Assay', 'Hi-C')
    // The rows narrow, the ticked facet keeps its counts, the others follow.
    expect(names(built.el)).toEqual(['HFF map', 'K562 map'])
    expect(facet(built.el, 'Assay')).toEqual(['Hi-C 2', 'ChIP-seq 1', 'unspecified 1'])
    expect(facet(built.el, 'Assembly')).toEqual(['GRCh38 1', 'hg19 1'])
    expect(built.el.querySelector('.portal-count')?.textContent).toBe('2 of 4 files.')
    // …and the view the drawer writes carries the tick.
    const last = built.views[built.views.length - 1]
    expect([...(last.facets.get('assay') ?? [])]).toEqual(['Hi-C'])
  })

  it('clears one facet from its heading, and everything from the toolbar', () => {
    const built = build()
    tick(built.el, 'Assay', 'Hi-C')
    tick(built.el, 'Assembly', 'GRCh38')
    expect(names(built.el)).toEqual(['HFF map'])
    ;(buttonNamed(built.el, 'clear') as HTMLButtonElement).click()
    expect(names(built.el)).toEqual(['HFF map', 'K562 map'])
    ;(buttonNamed(built.el, 'clear filters') as HTMLButtonElement).click()
    expect(names(built.el)).toHaveLength(4)
  })

  it('opens on the view a link carried', () => {
    const built = build({
      view: { text: '', facets: new Map([['biosource', new Set(['K562'])]]), mode: 'list' },
    })
    expect(names(built.el)).toEqual(['K562 map'])
    expect(facet(built.el, 'Biosource')[0]).toBe('K562 1')
  })
})

describe('the search', () => {
  it('narrows on every word, after a breath', async () => {
    vi.useFakeTimers()
    try {
      const built = build()
      const box = built.el.querySelector('.portal-search') as HTMLInputElement
      box.value = 'hff hi-c'
      box.dispatchEvent(new Event('input'))
      expect(names(built.el)).toHaveLength(4)
      vi.advanceTimersByTime(200)
      expect(names(built.el)).toEqual(['HFF map'])
      expect(built.views[built.views.length - 1].text).toBe('hff hi-c')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the matrix', () => {
  it('pivots the front’s axes, and a cell ticks both values and shows the list', () => {
    const built = build()
    ;(all<HTMLButtonElement>(built.el, '.portal-mode')[1]).click()
    expect(built.el.querySelector('.matrix-table')).not.toBeNull()
    expect(textsOf(built.el, '.matrix-row-text')).toEqual(['Hi-C', 'ChIP-seq', 'unspecified'])
    expect(textsOf(built.el, '.matrix-col-text')).toEqual(['HFF', 'K562', 'unspecified'])
    expect(built.views[built.views.length - 1].mode).toBe('matrix')
    const cells = all<HTMLButtonElement>(built.el, '.matrix-cell-button')
    expect(cells.map((cell) => cell.textContent)).toEqual(['1', '1', '1', '1'])
    cells[1].click()
    expect(built.el.querySelector('.matrix-table')).toBeNull()
    expect(names(built.el)).toEqual(['K562 map'])
    const last = built.views[built.views.length - 1]
    expect([...(last.facets.get('assay') ?? [])]).toEqual(['Hi-C'])
    expect([...(last.facets.get('biosource') ?? [])]).toEqual(['K562'])
  })

  it('swaps an axis from its select', () => {
    const built = build({ view: { ...EMPTY_VIEW, mode: 'matrix' } })
    const selects = all<HTMLSelectElement>(built.el, '.matrix-axis')
    selects[0].value = 'assembly'
    selects[0].dispatchEvent(new Event('change'))
    expect(textsOf(built.el, '.matrix-row-text')).toEqual(['GRCh38', 'hg19'])
    expect(built.views[built.views.length - 1].axes).toEqual(['assembly', 'biosource'])
  })
})

describe('the tray', () => {
  it('is absent until something is ticked, then opens what was ticked together', () => {
    const built = build()
    expect(built.el.querySelector('.portal-tray')?.classList.contains('hidden')).toBe(true)
    const boxes = all<HTMLInputElement>(built.el, '.portal-row .portal-box')
    boxes[1].checked = true
    boxes[1].dispatchEvent(new Event('change'))
    boxes[0].checked = true
    boxes[0].dispatchEvent(new Event('change'))
    expect(built.el.querySelector('.portal-tray-text')?.textContent).toBe('2 selected — 1 map, 1 track')
    ;(buttonNamed(built.el, 'open together') as HTMLButtonElement).click()
    // In the order they were ticked; the host picks the lead among them.
    expect(built.together).toEqual([[FILE.entries[1], FILE.entries[0]]])
    ;(buttonNamed(built.el, 'clear') as HTMLButtonElement).click()
    expect(built.el.querySelector('.portal-tray')?.classList.contains('hidden')).toBe(true)
  })

  it('ticks a whole group from its heading', () => {
    const built = build()
    const box = all<HTMLInputElement>(built.el, '.portal-group .portal-box')[0]
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(all(built.el, '.portal-row.is-on')).toHaveLength(2)
  })

  it('words the summary', () => {
    expect(traySummary(3, 1, 2, 0)).toBe('3 selected — 1 map, 2 tracks')
    expect(traySummary(1, 0, 0, 1)).toBe('1 selected — 1 session')
  })
})

describe('sessions', () => {
  it('offers a group’s pre-configured session on its heading, when the store has one', async () => {
    // The sessions are fetched beside the rows, from a URL of their own; the
    // stub answers each address with its own file.
    vi.stubGlobal('fetch', (url: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () =>
          Promise.resolve(
            JSON.stringify(
              String(url).endsWith('sessions.json')
                ? { kind: STORE_KIND, version: STORE_VERSION, name: 'sessions', columns: [], entries: [SESSION] }
                : FILE,
            ),
          ),
      }),
    )
    const front: StoreFront = {
      ...FRONT,
      rows: { id: 'p', label: 'A portal', url: 'https://data.example/store.json', builtin: false },
      sessions: { id: 's', label: 'sessions', url: 'https://data.example/sessions.json', builtin: false },
    }
    // Not in hand this time: the rows are fetched too, from the same stub.
    const opened: StoreEntry[] = []
    const view = new PortalView({
      front,
      host: {
        open: (entry) => opened.push(entry),
        openWithTracks: (entry) => opened.push(entry),
        add: () => undefined,
        openTogether: () => undefined,
        drag: () => undefined,
        tabEmpty: () => true,
      },
      view: EMPTY_VIEW,
      onView: () => undefined,
    })
    document.body.appendChild(view.el)
    await vi.waitFor(() => expect(all(view.el, '.portal-session').length).toBeGreaterThan(0))
    ;(buttonNamed(view.el, 'open with its tracks') as HTMLButtonElement).click()
    expect(opened[0]?.uri).toBe(SESSION.uri)
  })
})

describe('the line over the list', () => {
  it('says how many of how many, and when the cap bit', () => {
    expect(countLine(0, 0, false)).toBe('This store lists nothing.')
    expect(countLine(4, 4, false)).toBe('4 files.')
    expect(countLine(4, 0, true)).toBe('Nothing matches. 4 files in this store.')
    expect(countLine(4, 2, true)).toBe('2 of 4 files.')
    expect(countLine(50000, DRAWN + 1, true)).toContain(`The first ${DRAWN.toLocaleString('en-US')} are drawn`)
  })
})

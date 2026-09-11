// @vitest-environment jsdom
/**
 * The hub table: choosing a hub, then choosing a row of it.
 *
 * Everything here is about the two claims the section makes that a reader
 * cannot check for themselves. **Nothing is fetched until somebody asks**
 * (§23.2) — so the stub below counts requests, and a table that has merely been
 * built must have made none. And **filtering never refetches** (§23.1): the
 * catalogue is in hand, so narrowing it is arithmetic, and a filter that reached
 * the network would be a signed request per keystroke against an answer that
 * cannot change.
 *
 * The 404 case is the third, and it is the one that reads as a bug if it is
 * wrong: the two generated hubs do not exist until the Hubs workflow has run,
 * so a fresh fork meets a 404 on a URL that is perfectly correct and has to be
 * told which of the two things is missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HubTable, hubLabelFor, note } from '@/ui/HubTable'
import { HUB_KIND, HUB_VERSION, type Hub, type HubEntry, type HubRef } from '@/state/hub'
import { readHubRows, addHubRow } from '@/state/hubs'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let requested: string[]
let heldFetch: unknown

/** The hub every case below is drawn from: two columns, three rows. */
const BODY = JSON.stringify({
  kind: HUB_KIND,
  version: HUB_VERSION,
  name: 'Lab shelf',
  base: 'https://data.example/maps/',
  columns: [
    { key: 'assembly', label: 'Assembly' },
    { key: 'lab', label: 'Lab' },
  ],
  entries: [
    {
      label: 'Beta map',
      uri: 'beta.mcool',
      kind: 'map',
      size: 2000,
      note: 'in situ',
      fields: { assembly: 'hg38', lab: 'Dekker' },
      tracks: [{ label: 'CTCF', url: 'ctcf.bw' }],
    },
    {
      label: 'Alpha map',
      uri: 'alpha.hic',
      kind: 'map',
      size: 100,
      note: 'micro-C',
      fields: { assembly: 'mm10', lab: 'Aiden' },
    },
    {
      label: 'Gamma session',
      uri: 'gamma.metacooler.json',
      note: 'a composed figure',
      fields: { assembly: 'hg38' },
    },
  ],
})

/** Install a `fetch` that answers `status`/`body` and records what was asked. */
function answering(status: number, body: string): void {
  ;(globalThis as Record<string, unknown>)['fetch'] = (url: unknown) => {
    requested.push(String(url))
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'Error',
      text: () => Promise.resolve(body),
    } as unknown as Response)
  }
}

interface Built {
  table: HubTable
  el: HTMLElement
  picked: Array<{ entry: HubEntry; hub: Hub }>
  remembered: HubRef[]
}

function build(hubs: readonly HubRef[] = []): Built {
  const picked: Array<{ entry: HubEntry; hub: Hub }> = []
  const remembered: HubRef[] = []
  const table = new HubTable({
    hubs,
    onPick: (entry, hub) => picked.push({ entry, hub }),
    onRemember: (ref) => {
      remembered.push(ref)
      if (ref.url !== undefined) addHubRow({ label: ref.label, url: ref.url })
    },
  })
  return { table, el: table.el, picked, remembered }
}

/** The visible rows, as their name cells. */
function names(el: HTMLElement): string[] {
  return textsOf(el, '.hub-cell-name')
}

function status(el: HTMLElement): string {
  return (el.querySelector('.hub-status')?.textContent ?? '').trim()
}

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  requested = []
  heldFetch = (globalThis as Record<string, unknown>)['fetch']
  answering(200, BODY)
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>)['fetch'] = heldFetch
  window.localStorage.clear()
  teardown()
})

const SHELF: HubRef = {
  id: 'shelf',
  label: 'Lab shelf',
  url: 'https://lab.example/hub.json',
  builtin: false,
}

describe('the hub table', () => {
  it('fetches nothing until a hub is asked for', () => {
    const { el } = build([SHELF])
    expect(requested).toEqual([])
    // A selector with a placeholder and one hub, and no table under it.
    expect(all<HTMLOptionElement>(el, 'option').map((node) => node.textContent)).toEqual([
      'choose a hub…',
      'Lab shelf',
    ])
    expect(el.querySelector('.hub-grid')).toBeNull()
  })

  it('loads a hub and draws a row per entry, with the hub’s own columns', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    expect(requested).toEqual(['https://lab.example/hub.json'])
    expect(textsOf(built.el, '.hub-th')).toEqual([
      'Name',
      'Kind',
      'Assembly',
      'Lab',
      'Size',
      'Note',
    ])
    expect(names(built.el)).toEqual(['Beta map', 'Alpha map', 'Gamma session'])
    // The kind badge, including the one read off the file name.
    expect(textsOf(built.el, '.hub-badge')).toEqual(['map', 'map', 'workspace'])
    // The size, formatted the way the app formats bytes everywhere else.
    expect(textsOf(built.el, '.hub-cell-size')).toEqual(['2.0 kB', '100 B', ''])
    expect(status(built.el)).toContain('3 entries')
  })

  it('gives every column a filter box, and the name one as well', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    expect(all<HTMLInputElement>(built.el, '.hub-filter').map((box) => box.placeholder)).toEqual([
      'filter by name or note',
      'Assembly',
      'Lab',
    ])
  })

  it('filters by name and by note without going back to the network', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    const box = built.el.querySelector('.hub-filter') as HTMLInputElement

    box.value = 'alpha'
    box.dispatchEvent(new Event('input'))
    expect(names(built.el)).toEqual(['Alpha map'])
    expect(status(built.el)).toContain('Showing 1 of 3')

    // The note is part of what the box searches: an accession or a condition is
    // exactly what a reader remembers about a row whose name is an experiment.
    box.value = 'micro-C'
    box.dispatchEvent(new Event('input'))
    expect(names(built.el)).toEqual(['Alpha map'])

    box.value = 'nothing here'
    box.dispatchEvent(new Event('input'))
    expect(names(built.el)).toEqual([])
    expect(status(built.el)).toContain('Nothing here matches')

    // One request, for the load. Every keystroke above was arithmetic.
    expect(requested).toHaveLength(1)
  })

  it('filters by a column, and combines that with the name box', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    const boxes = all<HTMLInputElement>(built.el, '.hub-filter')
    boxes[1].value = 'hg38'
    boxes[1].dispatchEvent(new Event('input'))
    expect(names(built.el)).toEqual(['Beta map', 'Gamma session'])

    boxes[0].value = 'session'
    boxes[0].dispatchEvent(new Event('input'))
    expect(names(built.el)).toEqual(['Gamma session'])
    expect(requested).toHaveLength(1)
  })

  it('sorts on a header, and reverses on the second press', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    const header = (label: string): HTMLButtonElement =>
      all<HTMLButtonElement>(built.el, '.hub-sort').find(
        (node) => (node.textContent ?? '').startsWith(label),
      ) as HTMLButtonElement

    header('Name').click()
    expect(names(built.el)).toEqual(['Alpha map', 'Beta map', 'Gamma session'])
    header('Name').click()
    expect(names(built.el)).toEqual(['Gamma session', 'Beta map', 'Alpha map'])

    // Size is numeric, not lexicographic — `100` before `2000` — and the row
    // with no size sorts last whichever way round it is asked.
    header('Size').click()
    expect(names(built.el)).toEqual(['Alpha map', 'Beta map', 'Gamma session'])
    expect(requested).toHaveLength(1)
  })

  it('hands a picked row back with the hub it came from', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    ;(built.el.querySelector('.hub-name') as HTMLButtonElement).click()
    expect(built.picked).toHaveLength(1)
    expect(built.picked[0].entry.label).toBe('Beta map')
    // Absolute, resolved against the hub's `base` on the way in — the picker
    // opens what it is handed and does no resolution of its own.
    expect(built.picked[0].entry.uri).toBe('https://data.example/maps/beta.mcool')
    expect(built.picked[0].entry.tracks).toEqual([
      { label: 'CTCF', url: 'https://data.example/maps/ctcf.bw' },
    ])
    expect(built.picked[0].hub.name).toBe('Lab shelf')
  })

  it('picks from a click anywhere on the row, and not twice from the name', async () => {
    const built = build([SHELF])
    await built.table.load(SHELF)
    const row = built.el.querySelector('.hub-row') as HTMLElement
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(built.picked).toHaveLength(1)
    // A click that landed on the name button is that button's; without the
    // guard the row handler would pick a second time.
    ;(built.el.querySelector('.hub-name') as HTMLButtonElement).click()
    expect(built.picked).toHaveLength(2)
  })
})

describe('a hub that is not there', () => {
  const BUILTIN: HubRef = {
    id: '4dn',
    label: '4DN open data',
    url: 'https://raw.githubusercontent.com/js2264/metacooler.js/hubs/4dn.json',
    builtin: true,
  }

  it('says a built-in is not generated yet, and names what generates it', async () => {
    answering(404, 'Not Found')
    const built = build([BUILTIN])
    await built.table.load(BUILTIN)
    expect(status(built.el)).toContain('not generated yet')
    expect(status(built.el)).toContain('Hubs workflow')
    // Not an error, because nothing is wrong: a fresh fork has simply not run
    // the workflow, and red text would send somebody to check the URL.
    expect(built.el.querySelector('.hub-status')?.classList.contains('hub-error')).toBe(false)
  })

  it('reports a 404 on somebody else’s hub as a 404', async () => {
    answering(404, 'Not Found')
    const built = build([SHELF])
    await built.table.load(SHELF)
    expect(status(built.el)).toContain('404')
    expect(status(built.el)).not.toContain('workflow')
  })

  it('says which kind of file it got when it was not a hub', async () => {
    answering(200, '{"kind":"metacooler.workspace","version":1,"tabs":[]}')
    const built = build([SHELF])
    await built.table.load(SHELF)
    expect(status(built.el)).toContain('not a hub')
    expect(built.el.querySelector('.hub-status')?.classList.contains('hub-error')).toBe(true)
  })
})

describe('a hub added by hand', () => {
  it('loads it on the button, and offers to remember it', async () => {
    const built = build([])
    const box = built.el.querySelector('.hub-url') as HTMLInputElement
    box.value = ' https://lab.example/hub.json '
    expect(requested).toEqual([])

    ;(buttonNamed(built.el, 'add') as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(requested).toEqual(['https://lab.example/hub.json'])
    expect(names(built.el)).toHaveLength(3)

    const remember = buttonNamed(built.el, 'remember this hub')
    expect(remember).not.toBeNull()
    remember?.click()
    // The hub's own name, not the URL-derived one: by now the file has been
    // read and it says what it is called.
    expect(built.remembered.map((ref) => ref.label)).toEqual(['Lab shelf'])
    expect(readHubRows()).toEqual([
      { id: 'hub:1', label: 'Lab shelf', url: 'https://lab.example/hub.json' },
    ])
    // And once it is kept, the offer is gone and the menu has it.
    expect(buttonNamed(built.el, 'remember this hub')).toBeNull()
    expect(textsOf(built.el, 'optgroup[label="Hubs you connected"] option')).toEqual(['Lab shelf'])
  })

  it('offers to forget a hub that is already remembered, from the same spot', async () => {
    addHubRow({ label: 'Lab shelf', url: 'https://lab.example/hub.json' })
    const built = build([])
    // The remembered row is in the menu; choose it there.
    await built.table.load({ id: 'hub:1', label: 'Lab shelf', url: 'https://lab.example/hub.json', builtin: false })
    expect(names(built.el)).toHaveLength(3)
    expect(buttonNamed(built.el, 'remember this hub')).toBeNull()
    const forget = buttonNamed(built.el, 'forget this hub')
    expect(forget).not.toBeNull()
    forget?.click()
    expect(readHubRows()).toEqual([])
    // The menu has dropped it, and the table has not lost what it was showing.
    expect(textsOf(built.el, 'optgroup[label="Hubs you connected"] option')).toEqual([])
    expect(names(built.el)).toHaveLength(3)
  })

  it('reads a gs:// shelf typed into the box as its https URL', async () => {
    const built = build([])
    const box = built.el.querySelector('.hub-url') as HTMLInputElement
    box.value = 'gs://bucket/shelf.json'
    ;(buttonNamed(built.el, 'add') as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(requested).toEqual([
      'https://storage.googleapis.com/storage/v1/b/bucket/o/shelf.json?alt=media',
    ])
  })

  it('refuses a box that is not an http(s) URL before fetching anything', async () => {
    const built = build([])
    const box = built.el.querySelector('.hub-url') as HTMLInputElement
    box.value = 'javascript:alert(1)'
    ;(buttonNamed(built.el, 'add') as HTMLButtonElement).click()
    await Promise.resolve()
    expect(requested).toEqual([])
    expect(status(built.el)).toContain('nothing to fetch')
  })

  it('never offers to remember a built-in, which is already in the menu', async () => {
    const builtin: HubRef = { ...SHELF, id: 'demos', builtin: true }
    const built = build([builtin])
    await built.table.load(builtin)
    expect(buttonNamed(built.el, 'remember this hub')).toBeNull()
  })
})

describe('showing a hub directly', () => {
  const HUB: Hub = {
    kind: HUB_KIND,
    version: HUB_VERSION,
    name: 'Search results',
    columns: [],
    entries: [{ label: 'a hit', uri: 'https://h/a.hic', kind: 'map' }],
  }

  it('draws it with no fetch and no reference — what a portal search hands over', () => {
    const built = build([SHELF])
    built.table.show(HUB)
    expect(requested).toEqual([])
    expect(names(built.el)).toEqual(['a hit'])
    // No reference, so nothing to remember.
    expect(buttonNamed(built.el, 'remember this hub')).toBeNull()
  })

  it('clears back to nothing', () => {
    const built = build([SHELF])
    built.table.show(HUB)
    built.table.clear()
    expect(built.el.querySelector('.hub-grid')).toBeNull()
    expect(status(built.el)).toBe('')
  })
})

describe('the wording under the table', () => {
  const HUB = { name: 'Lab shelf' } as Hub

  it('counts plainly when nothing is filtered', () => {
    expect(note(HUB, 3, 3)).toBe('3 entries.')
    expect(note(HUB, 1, 1)).toBe('1 entry.')
  })

  it('says how many of how many when something is', () => {
    // The line that keeps "not in this hub" from reading as "not anywhere".
    expect(note(HUB, 40, 2)).toContain('Showing 2 of 40')
    expect(note(HUB, 40, 0)).toContain('40 entries in this hub')
  })

  it('names an empty hub rather than saying nothing about it', () => {
    expect(note(HUB, 0, 0)).toBe('Lab shelf lists nothing.')
  })
})

describe('naming a hub from its URL alone', () => {
  it('is the file name, or the host when there is none', () => {
    expect(hubLabelFor('https://raw.githubusercontent.com/o/r/hubs/4dn.json')).toBe('4dn')
    expect(hubLabelFor('https://lab.example/')).toBe('lab.example')
    expect(hubLabelFor('not a url')).toBe('not a url')
  })
})

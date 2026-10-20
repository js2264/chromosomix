// @vitest-environment jsdom
/**
 * A store published in shards, read several at a time.
 *
 * ENCODE is twelve files chosen by genome and by kind of file (§24.3), and
 * the two choices are facets like any other: tick two genomes and both
 * shards are read and their rows shown together, untick one and its rows go
 * without a second read. What is pinned is that nothing is read for a value
 * nobody ticked, that a shard read once is not read again, and that a shard
 * the workflow has not written is a sentence beside the rows that were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_VIEW, type StoreView } from '@/state/facets'
import { STORE_KIND, STORE_VERSION, type StoreEntry } from '@/state/store'
import type { StoreHost } from '@/ui/stores/host'
import { PortalView } from '@/ui/stores/PortalView'
import type { StoreFront } from '@/ui/stores/registry'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let requested: string[]

beforeEach(() => {
  teardown = setUpDom()
  requested = []
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
})

function shard(name: string, rows: Array<[string, string]>): string {
  return JSON.stringify({
    kind: STORE_KIND,
    version: STORE_VERSION,
    name,
    columns: [
      { key: 'assay', label: 'Assay' },
      { key: 'lab', label: 'Lab' },
    ],
    entries: rows.map(([label, assay]) => ({
      label,
      uri: `${label}.bw`,
      kind: 'genome',
      fields: { assay, lab: 'A' },
    })),
  })
}

/** Two genomes by two kinds; only three of the four files exist. */
function serve(): void {
  const bodies: Record<string, string> = {
    'x-hg38-signal.json': shard('hg38 signal', [['s1', 'Hi-C'], ['s2', 'ChIP-seq']]),
    'x-mm10-signal.json': shard('mm10 signal', [['m1', 'Hi-C']]),
    'x-hg38-peaks.json': shard('hg38 peaks', [['p1', 'ChIP-seq'], ['p2', 'ChIP-seq'], ['p3', 'ATAC-seq']]),
  }
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
}

const FRONT: StoreFront = {
  id: 'x',
  label: 'X',
  blurb: '',
  kind: 'portal',
  mark: { text: 'X', colour: '#000' },
  builtin: true,
  shards: {
    facets: [
      { key: 'group', label: 'Genome', values: [{ id: 'hg38', label: 'GRCh38' }, { id: 'mm10', label: 'mouse' }] },
      { key: 'category', label: 'Files', values: [{ id: 'signal', label: 'signal' }, { id: 'peaks', label: 'peaks' }] },
    ],
    url: (a, b) => `https://s.example/x-${a}-${b}.json`,
  },
}

function build(view: StoreView = EMPTY_VIEW): { view: PortalView; opened: StoreEntry[]; views: StoreView[] } {
  const opened: StoreEntry[] = []
  const views: StoreView[] = []
  const host: StoreHost = {
    open: (entry) => opened.push(entry),
    openWithTracks: (entry) => opened.push(entry),
    add: () => undefined,
    openTogether: () => undefined,
    drag: () => undefined,
    tabEmpty: () => true,
  }
  const made = new PortalView({ front: FRONT, host, view, onView: (next) => views.push(next) })
  document.body.appendChild(made.el)
  return { view: made, opened, views }
}

function names(root: HTMLElement): string[] {
  return textsOf(root, '.portal-name')
}

function tickShard(root: HTMLElement, key: string, label: string): void {
  const group = all<HTMLElement>(root, '.facet-group-shard').find(
    (node) => node.querySelector('.facet-label')?.textContent === (key === 'group' ? 'Genome' : 'Files'),
  ) as HTMLElement
  const row = all<HTMLElement>(group, '.facet-value').find(
    (node) => node.querySelector('.facet-value-text')?.textContent === label,
  ) as HTMLElement
  const box = row.querySelector('input') as HTMLInputElement
  box.checked = !box.checked
  box.dispatchEvent(new Event('change'))
}

describe('reading shards', () => {
  it('reads the first of each on open and nothing else, and counts what it read', async () => {
    serve()
    const built = build()
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2']))
    expect(requested.filter((url) => url.includes('x-'))).toEqual(['https://s.example/x-hg38-signal.json'])
    // Checkboxes, not radios: the two choices are facets like any other.
    expect(all(built.view.el, '.facet-group-shard input[type="checkbox"]')).toHaveLength(4)
    expect(all(built.view.el, '.facet-group-shard input[type="radio"]')).toHaveLength(0)
    // The shard read has a count; the ones not read say what a tick would do.
    const counts = textsOf(built.view.el, '.facet-group-shard .facet-count')
    expect(counts).toEqual(['2', 'on request', '2', 'on request'])
  })

  it('shows two genomes together when both are ticked, and narrows without a second read when one is unticked', async () => {
    serve()
    const built = build()
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2']))
    tickShard(built.view.el, 'group', 'mouse')
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2', 'm1']))
    // Both are on, and the link says so as two values of one facet.
    const last = built.views[built.views.length - 1]
    expect([...(last.facets.get('group') ?? [])]).toEqual(['hg38', 'mm10'])
    expect(textsOf(built.view.el, '.facet-group-shard .facet-count')).toEqual(['2', '1', '3', 'on request'])
    // The rows say which shard they came from, so an ordinary facet over them still works.
    const reads = requested.filter((url) => url.includes('x-')).length
    tickShard(built.view.el, 'group', 'GRCh38')
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['m1']))
    expect(requested.filter((url) => url.includes('x-')).length).toBe(reads)
    // …and ticking it back reads nothing again either.
    tickShard(built.view.el, 'group', 'GRCh38')
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2', 'm1']))
    expect(requested.filter((url) => url.includes('x-')).length).toBe(reads)
  })

  it('keeps the rows it could read when another shard is not there, and says which', async () => {
    serve()
    const built = build()
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2']))
    tickShard(built.view.el, 'category', 'peaks')
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2', 'p1', 'p2', 'p3']))
    tickShard(built.view.el, 'group', 'mouse')
    // hg38 signal, hg38 peaks and mm10 signal exist; mm10 peaks does not. The
    // rows come genome by genome, in the order the facets list them.
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['s1', 's2', 'p1', 'p2', 'p3', 'm1']))
    expect(built.view.el.querySelector('.portal-count')?.textContent).toContain('mouse · peaks')
  })

  it('keeps the shard choice on screen when every ticked shard failed, so another can be picked', async () => {
    // mouse · peaks is the one file the workflow has not written. With nothing
    // read, the rows give way to the sentence and the toolbar goes with them —
    // but the two groups that chose the shard are the way to one that exists,
    // and they used to go too, leaving a red line and nothing to press.
    serve()
    const built = build({
      ...EMPTY_VIEW,
      facets: new Map([
        ['group', new Set(['mm10'])],
        ['category', new Set(['peaks'])],
      ]),
    })
    const status = (): HTMLElement => built.view.el.querySelector('.portal-status-error') as HTMLElement
    await vi.waitFor(() => expect(status()).not.toBeNull())
    expect(status().classList.contains('hidden')).toBe(false)
    const rail = built.view.el.querySelector('.facet-group-shard')?.parentElement as HTMLElement
    expect(rail.classList.contains('hidden')).toBe(false)
    expect(all(built.view.el, '.facet-group-shard input[type="checkbox"]')).toHaveLength(4)
    // …and a tick there reads the shard that was written.
    tickShard(built.view.el, 'category', 'signal')
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['m1']))
  })

  it('opens on the shards a link named', async () => {
    serve()
    const built = build({
      ...EMPTY_VIEW,
      facets: new Map([
        ['group', new Set(['mm10'])],
        ['category', new Set(['signal'])],
      ]),
    })
    await vi.waitFor(() => expect(names(built.view.el)).toEqual(['m1']))
    expect(requested.filter((url) => url.includes('x-'))).toEqual(['https://s.example/x-mm10-signal.json'])
  })
})

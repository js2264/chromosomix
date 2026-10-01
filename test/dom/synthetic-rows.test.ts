// @vitest-environment jsdom
/**
 * A computed track is a **row of the Tracks card** (§18.5).
 *
 * §18.5's claim is that a per-bin result *is* a track: same colour chip, same
 * name, same eye, same four edges, same reorder, because it joins the same store
 * a dropped bigWig joins and goes through the same implementation. It used to be
 * listed on a card of its own, *Synthetic tracks*, which carried the colour, the
 * name, the eye, the exports, the edges, the style and the scale — and nothing
 * else: no height, no limits, no group, no flip, and no tick box, so it could
 * not join a batch with the bigWig it was being compared against.
 *
 * So the rows moved, and these tests pin what moving them has to keep and what
 * it has to add: the mark that says a row is not in any file (`*`, the one a
 * resolution the file does not store wears), the provenance, the exports and
 * Recompute that only a synthetic row has — and every control a loaded row has.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { LEAD_MAP } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationEntry, ComputedSource } from '@/annotations/types'
import type { ProfileOutput } from '@/analysis/types'
import { AnnotationCard } from '@/ui/AnnotationCard'
import { syntheticEntry, type SyntheticFormat } from '@/ui/synthetic'
import { all, setUpDom, type DomTeardown } from '../support/dom'
import { openEveryRow } from '../support/tracksCard'

let teardown: DomTeardown
const built: AnnotationCard[] = []

beforeEach(() => {
  teardown = setUpDom()
  sessionStorage.clear()
})

afterEach(() => {
  for (const card of built.splice(0, built.length)) card.destroy()
  teardown()
  sessionStorage.clear()
})

const SOURCE: ComputedSource = {
  kind: 'computed',
  name: 'insulation',
  task: 'insulation',
  recipe: { taskVersion: 1, params: {} },
  framing: 'chrIV:1–1,531,933 at 1 kb',
}

function profile(id: string): ProfileOutput {
  return {
    kind: 'profile',
    id,
    label: id,
    values: Float32Array.from([1, 2, 3]),
    binsize: 1000,
    firstBin: 0,
  } as unknown as ProfileOutput
}

interface Made {
  store: AnnotationStore
  card: AnnotationCard
  id: string
  exported: Array<[string, SyntheticFormat]>
  recomputed: string[]
}

/** A loaded bigWig's row, ready, the way the loader leaves one. */
function loaded(store: AnnotationStore, name: string): AnnotationEntry {
  const entry = store.begin({
    card: 'linear',
    kind: 'track',
    id: name,
    label: name,
    source: { kind: 'remote', url: `${name}.bw`, name },
    placement: {},
  })
  store.update(entry.id, { status: 'ready' })
  return entry
}

/** One computed row put in the store exactly as the workspace puts one. */
function computed(store: AnnotationStore): string {
  const seed = syntheticEntry(profile('insulation'), SOURCE, '#0072b2')
  const entry = store.begin({
    card: seed.card,
    kind: seed.kind,
    id: seed.id,
    label: seed.label,
    source: SOURCE,
    placement: seed.placement,
    style: seed.style,
    visible: seed.visible,
  })
  store.update(entry.id, { status: 'ready' })
  return entry.id
}

/** A Tracks card holding one computed row, over a deck of `maps` named cells. */
function make(
  options: { maps?: Array<{ id: string; label: string }>; also?: string[]; open?: boolean } = {},
): Made {
  const store = new AnnotationStore(`synthetic-${Math.random()}.cool`, { persist: false })
  for (const name of options.also ?? []) loaded(store, name)
  const id = computed(store)
  const exported: Array<[string, SyntheticFormat]> = []
  const recomputed: string[] = []
  const card = new AnnotationCard({
    store,
    loader: new AnnotationLoader(
      store,
      { request: () => Promise.resolve(null), drop: () => {} } as never,
      [],
    ),
    ...(options.maps === undefined ? {} : { maps: () => options.maps ?? [] }),
    onExport: (entry, format) => exported.push([entry.id, format]),
    onRecompute: (entry) => recomputed.push(entry.id),
  })
  built.push(card)
  document.body.append(card.el)
  if (options.open !== false) openEveryRow(card.el)
  return { store, card, id, exported, recomputed }
}

function rowOf(card: AnnotationCard, id: string): HTMLElement {
  const row = card.el.querySelector<HTMLElement>(`.ann-row[data-id="${id}"]`)
  if (row === null) throw new Error(`no row for ${id}`)
  return row
}

/** The four edge buttons of one map's row, by the order they are drawn. */
function edges(card: AnnotationCard, at = 0): HTMLButtonElement[] {
  const rows = all<HTMLElement>(card.el, '.ann-places')
  const row = rows[at]
  if (row === undefined) throw new Error(`no edge row ${at}`)
  return all<HTMLButtonElement>(row, '.ann-place')
}

describe('a computed track on the Tracks card', () => {
  it('is listed with the loaded tracks, in the one list', () => {
    const made = make({ also: ['ATAC', 'MNase'], open: false })
    const ids = all<HTMLElement>(made.card.el, '.ann-row').map((row) => row.dataset.id)
    expect(ids).toEqual(['ATAC', 'MNase', made.id])
  })

  it('wears the mark a resolution the file does not store wears, and a loaded row does not', () => {
    const made = make({ also: ['ATAC'], open: false })
    const mark = rowOf(made.card, made.id).querySelector('.ann-synthetic')
    expect(mark?.textContent).toBe('*')
    // Its tooltip is the provenance: what made it, and from what.
    expect(mark?.getAttribute('title')).toContain('Diamond insulation')
    expect(mark?.getAttribute('title')).toContain(SOURCE.framing)
    expect(rowOf(made.card, 'ATAC').querySelector('.ann-synthetic')).toBeNull()
  })

  it('says what made it on the line a loaded row’s summary takes', () => {
    const made = make({ open: false })
    const notes = all<HTMLElement>(rowOf(made.card, made.id), '.ann-note').map(
      (node) => node.textContent,
    )
    expect(notes).toEqual(['Diamond insulation'])
  })

  it('has every control a loaded track has', () => {
    const made = make({ also: ['ATAC'] })
    const labelsOn = (id: string): string[] =>
      all<HTMLElement>(rowOf(made.card, id), '.field-label').map((node) => node.textContent ?? '')
    const synthetic = labelsOn(made.id)
    for (const label of labelsOn('ATAC')) expect(synthetic).toContain(label)
    // Named, because these four are the ones the old card never had.
    for (const label of ['height', 'limits', 'group', 'style', 'scale']) {
      expect(synthetic).toContain(label)
    }
    expect(rowOf(made.card, made.id).querySelector('.ann-flip')).not.toBeNull()
  })

  it('takes a height, limits and a group through the same store calls', () => {
    const made = make()
    const row = rowOf(made.card, made.id)
    const height = row.querySelector<HTMLInputElement>('.ann-size')
    height!.value = '90'
    height!.dispatchEvent(new Event('change'))
    expect(made.store.byId(made.id)?.style.size).toBe(90)
    const [low, high] = all<HTMLInputElement>(row, '.ann-limits input')
    low.value = '-1'
    high.value = '2'
    high.dispatchEvent(new Event('change'))
    expect(made.store.byId(made.id)?.style.limits).toEqual({ auto: false, min: -1, max: 2 })
  })

  it('can be ticked into a batch with a loaded track', () => {
    const made = make({ also: ['ATAC'], open: false })
    for (const box of all<HTMLInputElement>(made.card.el, '.ann-tick')) {
      box.checked = true
      box.dispatchEvent(new Event('change'))
    }
    expect(made.card.el.querySelector('.ann-batch-count')?.textContent).toBe('2 selected')
  })

  it('carries its exports and its framing in its settings', () => {
    const made = make()
    const row = rowOf(made.card, made.id)
    const labels = all<HTMLButtonElement>(row, '.ann-exports button').map((node) => node.textContent)
    expect(labels).toEqual(['bigWig', 'bedGraph', 'TSV'])
    all<HTMLButtonElement>(row, '.ann-exports button')[0].click()
    expect(made.exported).toEqual([[made.id, 'bigwig']])
    expect(all<HTMLElement>(row, '.ann-origin').map((node) => node.textContent)).toEqual([
      SOURCE.framing,
    ])
  })

  it('offers Recompute when it came back from a reload without its numbers', () => {
    const made = make({ open: false })
    made.store.update(made.id, { status: 'detached' })
    const run = all<HTMLButtonElement>(rowOf(made.card, made.id), 'button').find(
      (node) => node.textContent === 'recompute',
    )
    expect(run).toBeDefined()
    run!.click()
    expect(made.recomputed).toEqual([made.id])
    // …and no exports, since there is nothing to write until it has run again.
    openEveryRow(made.card.el)
    expect(rowOf(made.card, made.id).querySelector('.ann-exports')).toBeNull()
  })
})

describe('where a computed track is drawn', () => {
  it('carries the location control a loaded track has', () => {
    const made = make()
    expect(all<HTMLElement>(made.card.el, '.ann-field-places')).toHaveLength(1)
    expect(edges(made.card).map((node) => node.dataset.edge)).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ])
  })

  it('opens on the left, which is the one edge a dropped file never takes', () => {
    const made = make()
    const left = edges(made.card).find((node) => node.dataset.edge === 'left')
    expect(left?.getAttribute('aria-pressed')).toBe('true')
  })

  it('moves to another edge of its own map', () => {
    const made = make()
    edges(made.card).find((node) => node.dataset.edge === 'bottom')?.click()
    expect(made.store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)
  })

  it('names each map once there is more than one to choose between', () => {
    const made = make({
      maps: [
        { id: LEAD_MAP, label: 'rep1.cool' },
        { id: 'p3', label: 'rep2.cool' },
      ],
    })
    expect(all<HTMLElement>(made.card.el, '.ann-place-map')).toHaveLength(2)
    expect(all<HTMLElement>(made.card.el, '.ann-place-name').map((node) => node.textContent))
      .toEqual(['rep1.cool', 'rep2.cool'])
  })

  it('draws it on a companion without touching the lead', () => {
    const made = make({
      maps: [
        { id: LEAD_MAP, label: 'rep1.cool' },
        { id: 'p3', label: 'rep2.cool' },
      ],
    })
    edges(made.card, 1).find((node) => node.dataset.edge === 'bottom')?.click()
    expect(made.store.drawnOnMap('p3', 'bottom')).toHaveLength(1)
    expect(made.store.drawnOnMap(LEAD_MAP, 'left')).toHaveLength(1)
    expect(made.store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
  })
})

/**
 * A comparison of two loaded tracks is a track this app made, so it is marked
 * and exported as one — and it is listed under the two it was made from.
 */
describe('a derived track’s row', () => {
  function derived(): { store: AnnotationStore; card: AnnotationCard; id: string; asked: string[][] } {
    const store = new AnnotationStore(`derived-${Math.random()}.cool`, { persist: false })
    for (const name of ['treated', 'control']) loaded(store, name)
    const entry = store.begin({
      card: 'synthetic',
      kind: 'track',
      source: { kind: 'derived', name: 'treated / control' },
      label: 'treated / control',
      placement: {},
    })
    store.update(entry.id, {
      derivedFrom: { a: 'treated', b: 'control', op: 'ratio' },
      status: 'ready',
    })
    const asked: string[][] = []
    const card = new AnnotationCard({
      store,
      loader: new AnnotationLoader(
        store,
        { request: () => Promise.resolve(null), drop: () => {} } as never,
        [],
      ),
      onExport: (row, format) => asked.push([row.id, format]),
    })
    built.push(card)
    document.body.append(card.el)
    openEveryRow(card.el)
    return { store, card, id: entry.id, asked }
  }

  it('is listed after the two it was made from, marked', () => {
    const made = derived()
    const ids = all<HTMLElement>(made.card.el, '.ann-row').map((row) => row.dataset.id)
    expect(ids).toEqual(['treated', 'control', made.id])
    expect(rowOf(made.card, made.id).querySelector('.ann-synthetic')).not.toBeNull()
  })

  it('says what it is made of, and claims no framing of its own', () => {
    const made = derived()
    const row = rowOf(made.card, made.id)
    const notes = all<HTMLElement>(row, '.ann-note').map((node) => node.textContent)
    expect(notes.join(' ')).toMatch(/ratio/)
    expect(all<HTMLElement>(row, '.ann-origin')).toHaveLength(0)
  })

  it('hands the export the row it was pressed on', () => {
    const made = derived()
    const bigwig = all<HTMLButtonElement>(rowOf(made.card, made.id), 'button').find(
      (node) => node.textContent === 'bigWig',
    )
    bigwig?.click()
    expect(made.asked).toEqual([[made.id, 'bigwig']])
  })
})

/**
 * The style picker, and the colours picker that comes with it (§18.11): the
 * same pair a loaded track has, which is the point — a heatmap mode offered on
 * one kind of row only would be a mode the four insulation scales could never
 * be drawn in, and they are the set it was added for.
 */
describe('a computed track’s drawing style', () => {
  function styleSelect(card: AnnotationCard): HTMLSelectElement {
    const found = all<HTMLSelectElement>(card.el, 'select').find((node) =>
      all<HTMLOptionElement>(node, 'option').some((option) => option.value === 'heatmap'),
    )
    if (found === undefined) throw new Error('no style select on the row')
    return found
  }

  function coloursField(card: AnnotationCard): HTMLElement {
    const found = all<HTMLSelectElement>(card.el, 'select').find(
      (node) => all<HTMLOptionElement>(node, 'option')[0]?.textContent === 'auto',
    )
    const field = found?.closest('.ann-field')
    if (!(field instanceof HTMLElement)) throw new Error('no colours field on the row')
    return field
  }

  it('offers the heatmap', () => {
    const made = make()
    expect(all<HTMLOptionElement>(styleSelect(made.card), 'option').map((one) => one.value)).toContain(
      'heatmap',
    )
  })

  it('shows the colours on the pick that asks for them, without waiting for a rebuild', () => {
    const made = make()
    expect(coloursField(made.card).classList.contains('hidden')).toBe(true)
    const style = styleSelect(made.card)
    style.value = 'heatmap'
    style.dispatchEvent(new Event('change'))
    expect(made.store.byId(made.id)?.style.mode).toBe('heatmap')
    expect(coloursField(made.card).classList.contains('hidden')).toBe(false)
  })
})

/**
 * A row's grip starts a drag that every place a row can land accepts (§16.9):
 * moved up and down the list and onto a map's edge, placed — a copy — on a
 * cell of the deck. It allowed `move` alone, and a browser refuses a drop whose
 * target answers an effect the source did not allow, so an empty cell answering
 * `copy` never received the row at all.
 */
describe('dragging a row by its grip', () => {
  it('allows the row to be moved or copied, and names it by id', () => {
    const made = make({ also: ['ATAC'] })
    const grip = rowOf(made.card, 'ATAC').querySelector<HTMLElement>('.ann-grip')
    if (grip === null) throw new Error('no grip')
    const data = new Map<string, string>()
    const transfer = {
      setData: (type: string, value: string) => data.set(type, value),
      setDragImage: () => undefined,
      effectAllowed: '',
    }
    const start = new window.Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(start, 'dataTransfer', { value: transfer })
    grip.dispatchEvent(start)
    expect(transfer.effectAllowed).toBe('copyMove')
    expect(data.get('application/x-metacooler-track')).toBe('ATAC')
  })

  it('says in its tooltip where it can be let go: any edge of any map, a + or an empty cell', () => {
    const made = make({ also: ['ATAC'] })
    const grip = rowOf(made.card, 'ATAC').querySelector<HTMLElement>('.ann-grip')
    // It named the map's bottom and right edges, two of the four, on one map.
    expect(grip?.title).toContain('any edge of any map')
    expect(grip?.title).toContain('a + or an empty cell')
    expect(grip?.title).not.toContain('bottom or right edge')
  })
})

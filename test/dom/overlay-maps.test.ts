// @vitest-environment jsdom

/**
 * Which maps an overlay is drawn on (§8.1).
 *
 * A loop set or a set of called boundaries is drawn on the matrix's face, and
 * every map used to draw every one: a deck of six maps circled the loops called
 * on one of them on all six, with nothing on the row to say otherwise. An
 * overlay is placed per map now, as a lane is, and its row carries the location
 * field's shape for it — a line per contact map with one mark, then *every
 * map*, *no map* and how many — under the label `maps`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { LEAD_MAP } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import { emptyPlacement, type AnnotationEntry } from '@/annotations/types'
import { AnnotationCard } from '@/ui/AnnotationCard'
import { overlayMapsField, type PlacementMap } from '@/ui/lanePlacement'
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
  vi.restoreAllMocks()
})

/** Three maps and a tracks cell, as `PanelDeck.mapList` lists them. */
const DECK: PlacementMap[] = [
  { id: LEAD_MAP, label: 'MP275_10M' },
  { id: 'p2', label: 'MP275_100M' },
  { id: 'p3', label: 'MP275_500M' },
  { id: 'p4', label: 'tracks', edges: ['bottom'], tracks: true },
]

function store(): AnnotationStore {
  return new AnnotationStore(`overlay-maps-${Math.random()}.cool`, { persist: false })
}

/** A loaded loop set, as the loader begins a BEDPE: on the session's own map. */
function loops(held: AnnotationStore, id = 'loops'): AnnotationEntry {
  const entry = held.begin({
    card: 'overlay',
    kind: 'pairs',
    id,
    label: id,
    source: { kind: 'remote', url: `${id}.bedpe`, name: `${id}.bedpe` },
  })
  held.update(entry.id, { status: 'ready' })
  return held.byId(entry.id)!
}

function marks(field: HTMLElement): HTMLButtonElement[] {
  return all<HTMLButtonElement>(field, '.ann-place[data-face]')
}

describe('the maps an overlay is drawn on', () => {
  it('are the maps it has a lane on, and only those', () => {
    const held = store()
    const entry = loops(held)
    // Imported, it is on the session's own map, as a track is.
    expect(held.overlays(LEAD_MAP).map((row) => row.id)).toEqual([entry.id])
    expect(held.overlays('p2')).toEqual([])
    held.placeOn(entry.id, 'p2', entry.placement)
    expect(held.overlays('p2').map((row) => row.id)).toEqual([entry.id])
    held.unplaceFrom(entry.id, LEAD_MAP)
    expect(held.overlays(LEAD_MAP)).toEqual([])
    // Hidden is hidden everywhere: the eye is the row's, the maps are the lanes'.
    held.update(entry.id, { visible: false })
    expect(held.overlays('p2')).toEqual([])
  })

  it('are remembered as a track’s lanes are: off the lead by name, on a companion by its file', () => {
    const uri = `overlay-maps-kept-${Math.random()}.cool`
    const held = new AnnotationStore(uri)
    const entry = loops(held)
    held.noteMapFiles(new Map([['p2', 'rep2.cool']]))
    held.placeOn(entry.id, 'p2', entry.placement)
    held.unplaceFrom(entry.id, LEAD_MAP)
    const [row] = AnnotationStore.stored(uri)
    expect(row.lead).toBeNull()
    expect(held.parkedFor()).toEqual([expect.objectContaining({ track: entry.id, uri: 'rep2.cool' })])
    // Begun again from what was written, as a reload begins it: not on the lead.
    const back = new AnnotationStore(`${uri}-back`, { persist: false })
    back.begin({
      card: row.card,
      kind: row.kind,
      id: row.id,
      label: row.label,
      source: { kind: 'remote', url: row.source.url!, name: row.source.name },
      placement: row.placement,
      style: row.style,
      lead: row.lead,
    })
    back.update(row.id, { status: 'ready' })
    expect(back.overlays(LEAD_MAP)).toEqual([])
    back.seedHomes(held.parkedFor())
    back.adoptHome('p7', 'rep2.cool')
    expect(back.overlays('p7').map((one) => one.id)).toEqual([entry.id])
  })

  it('are left alone by a withdrawal from other maps', () => {
    const held = store()
    const entry = loops(held)
    held.propagateTo(entry.id, ['lead', 'p2', 'p4'])
    held.withdrawFrom(entry.id, ['lead', 'p2'])
    expect(held.mapsDrawing(entry.id)).toEqual(['p4'])
    held.withdrawFrom(entry.id)
    expect(held.mapsDrawing(entry.id)).toEqual([])
  })
})

describe('the maps field', () => {
  it('is not offered with one map the overlay is on — the eye says that already', () => {
    const held = store()
    const entry = loops(held)
    expect(overlayMapsField(held, entry, [{ id: LEAD_MAP, label: '' }])).toBeNull()
  })

  it('offers the one map when the overlay is on none, as the way back', () => {
    const held = store()
    const entry = loops(held)
    held.withdrawFrom(entry.id)
    const field = overlayMapsField(held, entry, [{ id: LEAD_MAP, label: '' }])!
    expect(field.querySelector('.field-label')?.textContent).toBe('maps')
    const [mark] = marks(field)
    expect(mark.getAttribute('aria-pressed')).toBe('false')
    mark.click()
    expect(held.overlays(LEAD_MAP).map((row) => row.id)).toEqual([entry.id])
  })

  it('lists every contact map by name, lit where it is drawn, and not the tracks cell', () => {
    const held = store()
    const entry = loops(held)
    const field = overlayMapsField(held, entry, DECK)!
    document.body.append(field)
    expect(field.classList.contains('is-named')).toBe(true)
    expect(all(field, '.ann-place-name').map((node) => node.textContent)).toEqual([
      'MP275_10M',
      'MP275_100M',
      'MP275_500M',
    ])
    expect(marks(field).map((mark) => mark.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect(marks(field).map((mark) => mark.getAttribute('aria-label'))).toEqual([
      'on MP275_10M',
      'on MP275_100M',
      'on MP275_500M',
    ])
    // One mark per map, never the four edges a lane has.
    expect(field.querySelector('[data-edge]')).toBeNull()
    expect(field.querySelector('.ann-place-count')?.textContent).toBe('on 1 of 3')
  })

  it('draws it on a map with a press, and takes it off with another', () => {
    const held = store()
    const entry = loops(held)
    marks(overlayMapsField(held, entry, DECK)!)[2].click()
    expect(held.overlays('p3').map((row) => row.id)).toEqual([entry.id])
    expect(held.overlays(LEAD_MAP).map((row) => row.id)).toEqual([entry.id])
    // Rebuilt, as the card rebuilds on every change: the lead's mark is lit.
    marks(overlayMapsField(held, entry, DECK)!)[0].click()
    expect(held.overlays(LEAD_MAP)).toEqual([])
    expect(held.mapsDrawing(entry.id)).toEqual(['p3'])
  })

  it('puts it on every map, and takes it off every map but the tracks cell it was dropped in', () => {
    const held = store()
    const entry = loops(held)
    held.placeOn(entry.id, 'p4', entry.placement)
    const every = all<HTMLButtonElement>(overlayMapsField(held, entry, DECK)!, '.ann-place-all .btn')
    expect(every.map((node) => node.textContent)).toEqual(['every map', 'no map'])
    every[0].click()
    for (const map of ['lead', 'p2', 'p3']) expect(held.overlays(map)).toHaveLength(1)
    const again = overlayMapsField(held, entry, DECK)!
    expect(again.querySelector('.ann-place-count')?.textContent).toBe('on every map')
    all<HTMLButtonElement>(again, '.ann-place-all .btn')[1].click()
    for (const map of ['lead', 'p2', 'p3']) expect(held.overlays(map)).toEqual([])
    expect(held.mapsDrawing(entry.id)).toEqual(['p4'])
    // Still in the list, with its settings, to be put back.
    expect(held.byId(entry.id)).toBeDefined()
  })

  it('takes a called set from where the analysis put it', () => {
    // `AnalysisWorkspace.adoptIntervals` on a starred companion: begun with no
    // edges, then moved off the lead onto the map it was computed from.
    const held = store()
    const entry = held.begin({
      card: 'overlay',
      kind: 'segments',
      id: 'analysis:p3:insulation:insulation-boundaries',
      label: 'Insulation boundaries · MP275_500M',
      source: {
        kind: 'computed',
        name: 'Insulation boundaries',
        task: 'insulation',
        recipe: {},
        framing: 'MP275_500M · 10 kb',
      },
      placement: emptyPlacement(),
    })
    held.update(entry.id, { status: 'ready' })
    held.placeOn(entry.id, 'p3', emptyPlacement())
    held.unplaceFrom(entry.id, LEAD_MAP)
    expect(held.overlays(LEAD_MAP)).toEqual([])
    expect(held.overlays('p3')).toHaveLength(1)
    const field = overlayMapsField(held, held.byId(entry.id)!, DECK)!
    expect(marks(field).map((mark) => mark.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })
})

/** The Tracks card over a deck, every row open, with `ticked` ticked. */
function card(held: AnnotationStore, ticked: string[] = []): AnnotationCard {
  const made = new AnnotationCard({
    store: held,
    loader: new AnnotationLoader(held, { request: () => Promise.resolve(null), drop: () => {} } as never, []),
    maps: () => DECK,
  })
  built.push(made)
  document.body.append(made.el)
  for (const id of ticked) {
    const box = made.el.querySelector<HTMLInputElement>(`.ann-tick[data-tick="${id}"]`)
    if (box === null) throw new Error(`no tick for ${id}`)
    box.checked = true
    box.dispatchEvent(new Event('change'))
  }
  return made
}

function fieldsOf(host: Element): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>()
  for (const field of all<HTMLElement>(host, '.field')) {
    const label = field.querySelector(':scope > .field-label')?.textContent
    if (label !== undefined && label !== null) out.set(label, field)
  }
  return out
}

describe('an overlay row, dragged', () => {
  it('says it is one, so a map can offer it its face alone', () => {
    const held = store()
    loops(held)
    const bigwig = held.begin({
      card: 'linear',
      kind: 'track',
      id: 'atac',
      label: 'atac',
      source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
    })
    held.update(bigwig.id, { status: 'ready' })
    const made = card(held)
    const typesOf = (id: string): string[] => {
      const set = new Map<string, string>()
      const start = new window.Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperty(start, 'dataTransfer', {
        value: {
          effectAllowed: 'none',
          setData: (type: string, value: string) => set.set(type, value),
          setDragImage: () => {},
        },
      })
      made.el.querySelector(`[data-grip="${id}"]`)?.dispatchEvent(start)
      return [...set.keys()]
    }
    expect(typesOf('loops')).toContain('application/x-chromosomix-overlay')
    expect(typesOf('loops')).toContain('application/x-chromosomix-track')
    expect(typesOf('atac')).not.toContain('application/x-chromosomix-overlay')
  })
})

describe('on the Tracks card, in a deck', () => {
  it('gives an overlay row its maps, and a lane row its location', () => {
    const held = store()
    loops(held)
    const bigwig = held.begin({
      card: 'linear',
      kind: 'track',
      id: 'atac',
      label: 'atac',
      source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
    })
    held.update(bigwig.id, { status: 'ready' })
    const made = card(held)
    openEveryRow(made.el)
    const rows = all<HTMLElement>(made.el, '.ann-row')
    const overlay = rows.find((row) => row.textContent?.includes('loops'))!
    const lane = rows.find((row) => row.textContent?.includes('atac'))!
    expect([...fieldsOf(overlay).keys()]).toEqual(expect.arrayContaining(['radius', 'opacity', 'maps']))
    expect(fieldsOf(overlay).has('location')).toBe(false)
    expect(fieldsOf(lane).has('location')).toBe(true)
    expect(fieldsOf(lane).has('maps')).toBe(false)
    // …and the mark on the row is the store's door, not a copy of it.
    marks(fieldsOf(overlay).get('maps')!)[1].click()
    expect(held.overlays('p2').map((row) => row.id)).toEqual(['loops'])
  })

  it('edits several ticked overlays at once, mixed where they differ', () => {
    const held = store()
    loops(held, 'rep1')
    loops(held, 'rep2')
    held.placeOn('rep2', 'p2', emptyPlacement())
    const made = card(held, ['rep1', 'rep2'])
    const batch = made.el.querySelector<HTMLElement>('.ann-batch')!
    const field = fieldsOf(batch).get('maps')!
    expect(marks(field).map((mark) => mark.getAttribute('aria-pressed'))).toEqual(['true', 'mixed', 'false'])
    // A press on a mixed map puts both there…
    marks(field)[1].click()
    expect(held.overlays('p2').map((row) => row.id)).toEqual(['rep1', 'rep2'])
    // …and on a lit one takes both off it.
    const lit = marks(fieldsOf(made.el.querySelector('.ann-batch')!).get('maps')!)[0]
    expect(lit.getAttribute('aria-pressed')).toBe('true')
    lit.click()
    expect(held.overlays(LEAD_MAP)).toEqual([])
    const buttons = all<HTMLButtonElement>(
      fieldsOf(made.el.querySelector('.ann-batch')!).get('maps')!,
      '.ann-place-all .btn',
    )
    buttons[0].click()
    for (const map of ['lead', 'p2', 'p3']) expect(held.overlays(map)).toHaveLength(2)
  })
})

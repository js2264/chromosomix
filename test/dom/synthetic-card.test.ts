// @vitest-environment jsdom
/**
 * A computed track, as a **row** — and the control it was missing.
 *
 * §18.5's claim is that a per-bin result *is* a track: same colour chip, same
 * name, same eye, same four edges, same reorder, because it joins the same store
 * a dropped bigWig joins and goes through the same implementation. The Synthetic
 * card was the one place that claim was not true. It carried the colour, the
 * name, the eye and the exports, and nothing at all about **where the lane is
 * drawn** — so an eigenvector opened on the left of the map it was computed on
 * and the only way to move it was to find the lane on the picture and drag it,
 * with no way whatever to say *also draw it beside the second replicate*.
 *
 * The control is now the Tracks card's own, from one module, so a computed lane
 * and a loaded one are moved by one gesture rather than two that can drift.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LEAD_MAP } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import type { ComputedSource } from '@/annotations/types'
import type { ProfileOutput } from '@/analysis/types'
import { SyntheticCard, syntheticEntry } from '@/ui/SyntheticCard'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: SyntheticCard[] = []

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
  card: SyntheticCard
  id: string
}

/** A card holding one computed row, over a deck of `maps` named cells. */
function make(maps?: Array<{ id: string; label: string }>): Made {
  const store = new AnnotationStore(`synthetic-${Math.random()}.cool`, { persist: false })
  const seed = syntheticEntry(profile('insulation'), SOURCE, '#0072b2')
  // The three fields `begin` derives for itself — a status, a fetch and an
  // extent — are not its to be handed, which is what keeps a row's lifecycle in
  // one place. The card puts a synthetic row in exactly this way.
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
  const card = new SyntheticCard({
    store,
    ...(maps === undefined ? {} : { maps: () => maps }),
    onExport: () => {},
    onRecompute: () => {},
  })
  built.push(card)
  document.body.append(card.el)
  return { store, card, id: entry.id }
}

/** The four edge buttons of one map's row, by the order they are drawn. */
function edges(card: SyntheticCard, at = 0): HTMLButtonElement[] {
  const rows = all<HTMLElement>(card.el, '.ann-places')
  const row = rows[at]
  if (row === undefined) throw new Error(`no edge row ${at}`)
  return all<HTMLButtonElement>(row, '.ann-place')
}

describe('a computed track’s row', () => {
  it('carries the location control a loaded track has', () => {
    const made = make()
    expect(all<HTMLElement>(made.card.el, '.ann-field-places')).toHaveLength(1)
    expect(edges(made.card).map((node) => node.textContent)).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ])
  })

  it('opens on the left, which is the one edge a dropped file never takes', () => {
    const made = make()
    const left = edges(made.card).find((node) => node.textContent === 'left')
    expect(left?.getAttribute('aria-pressed')).toBe('true')
  })

  it('moves to another edge of its own map', () => {
    const made = make()
    edges(made.card).find((node) => node.textContent === 'bottom')?.click()
    expect(made.store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(1)
  })

  it('names each map once there is more than one to choose between', () => {
    // The row per map appears only in a deck: "which map" is not a question a
    // session with one map is asking, so one map keeps the shape it always had.
    const made = make([
      { id: LEAD_MAP, label: 'rep1.cool' },
      { id: 'p3', label: 'rep2.cool' },
    ])
    expect(all<HTMLElement>(made.card.el, '.ann-place-map')).toHaveLength(2)
    expect(all<HTMLElement>(made.card.el, '.ann-place-name').map((node) => node.textContent))
      .toEqual(['rep1.cool', 'rep2.cool'])
  })

  it('draws it on a companion without touching the lead', () => {
    const made = make([
      { id: LEAD_MAP, label: 'rep1.cool' },
      { id: 'p3', label: 'rep2.cool' },
    ])
    // The second row is the companion's.
    edges(made.card, 1).find((node) => node.textContent === 'bottom')?.click()
    expect(made.store.drawnOnMap('p3', 'bottom')).toHaveLength(1)
    // The lead keeps the edge the result opened on.
    expect(made.store.drawnOnMap(LEAD_MAP, 'left')).toHaveLength(1)
    expect(made.store.drawnOnMap(LEAD_MAP, 'bottom')).toHaveLength(0)
  })

  it('takes it off a map when its last edge goes, keeping the row', () => {
    const made = make([
      { id: LEAD_MAP, label: 'rep1.cool' },
      { id: 'p3', label: 'rep2.cool' },
    ])
    edges(made.card).find((node) => node.textContent === 'left')?.click()
    expect(made.store.drawnOnMap(LEAD_MAP, 'left')).toHaveLength(0)
    // Still an import, with its colour and its exports — the eye is what hides
    // a track, and this is not it.
    expect(made.store.entries.map((entry) => entry.id)).toEqual([made.id])
  })
})

/**
 * A comparison of two loaded tracks is a track this app made.
 *
 * It used to open on the **Tracks** card, among the files it was computed from,
 * which put it in the one place a reader does not look for a result and — more
 * to the point — the one card with no exports on it. There was no way to get a
 * ratio out of the app at all.
 */
describe('a derived track’s row', () => {
  function derived(): { store: AnnotationStore; card: SyntheticCard; id: string } {
    const store = new AnnotationStore(`derived-${Math.random()}.cool`, { persist: false })
    for (const name of ['treated', 'control']) {
      store.begin({
        card: 'linear',
        kind: 'track',
        id: name,
        label: name,
        source: { kind: 'remote', url: `${name}.bw`, name },
        placement: {},
      })
      store.update(name, { status: 'ready' })
    }
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
    const card = new SyntheticCard({ store, onExport: () => {}, onRecompute: () => {} })
    built.push(card)
    document.body.append(card.el)
    return { store, card, id: entry.id }
  }

  it('is listed here, beside what the analysis panel computed', () => {
    const made = derived()
    const rows = all<HTMLElement>(made.card.el, '.ann-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].dataset.id).toBe(made.id)
    expect(made.card.el.classList.contains('hidden')).toBe(false)
  })

  it('says what it is made of, and claims no framing of its own', () => {
    // It holds no numbers: it is recomputed from its two operands every time it
    // is drawn, so what it is a reading of is whatever they are.
    const made = derived()
    const notes = all<HTMLElement>(made.card.el, '.ann-note').map((node) => node.textContent)
    expect(notes.join(' ')).toMatch(/ratio/)
    expect(all<HTMLElement>(made.card.el, '.ann-origin')).toHaveLength(0)
  })

  it('offers the two files a genome browser opens, and the table', () => {
    const made = derived()
    const labels = all<HTMLButtonElement>(made.card.el, 'button')
      .map((node) => node.textContent ?? '')
      .filter((text) => text !== '')
    expect(labels).toContain('bigWig')
    expect(labels).toContain('bedGraph')
    expect(labels).toContain('TSV')
  })

  it('hands the export the row it was pressed on', () => {
    const store = new AnnotationStore(`derived-${Math.random()}.cool`, { persist: false })
    const entry = store.begin({
      card: 'synthetic',
      kind: 'track',
      source: { kind: 'derived', name: 'a / b' },
      label: 'a / b',
      placement: {},
    })
    store.update(entry.id, { derivedFrom: { a: 'a', b: 'b', op: 'ratio' }, status: 'ready' })
    const asked: Array<[string, string]> = []
    const card = new SyntheticCard({
      store,
      onExport: (row, format) => asked.push([row.id, format]),
      onRecompute: () => {},
    })
    built.push(card)
    document.body.append(card.el)
    const bigwig = all<HTMLButtonElement>(card.el, 'button').find(
      (node) => node.textContent === 'bigWig',
    )
    bigwig?.click()
    expect(asked).toEqual([[entry.id, 'bigwig']])
  })
})

/**
 * The style picker, and the colours picker that comes with it (§18.11).
 *
 * This card is the **only** one that lists a computed row — the Tracks card
 * leaves it out on purpose, so that a result is not in the panel twice under two
 * rows that rename independently — which makes it the only place a computed lane
 * can be given a style at all. A heatmap mode offered only on the Tracks card
 * would be a mode the four insulation scales could never be drawn in, which is
 * the one set it was added for.
 *
 * The colours picker is **conditional**, and deliberately not a fifth control
 * sitting inert beside the others: on a line the colour is the chip on the row's
 * head, so a second colour control there is two answers to one question. It has
 * to appear on the pick that asks for it, which is why the two are built as a
 * pair — a `<select>` keeps focus after a pick and this card, like every other,
 * defers its rebuild while a control holds a value the reader may still be
 * giving.
 */
describe('a computed track’s drawing style', () => {
  function selects(card: SyntheticCard): HTMLSelectElement[] {
    return all<HTMLSelectElement>(card.el, 'select')
  }

  function fieldOf(select: HTMLSelectElement): HTMLElement {
    const field = select.closest('.ann-field')
    if (field === null) throw new Error('no field around the select')
    return field as HTMLElement
  }

  /** The style select, by the modes it offers rather than by its position. */
  function styleSelect(card: SyntheticCard): HTMLSelectElement {
    const found = selects(card).find((node) =>
      all<HTMLOptionElement>(node, 'option').some((option) => option.value === 'heatmap'),
    )
    if (found === undefined) throw new Error('no style select on the row')
    return found
  }

  /** The colours select — the one whose first option is *auto*. */
  function coloursSelect(card: SyntheticCard): HTMLSelectElement {
    const found = selects(card).find(
      (node) => all<HTMLOptionElement>(node, 'option')[0]?.textContent === 'auto',
    )
    if (found === undefined) throw new Error('no colours select on the row')
    return found
  }

  it('offers the heatmap, on the one card a computed row is listed on', () => {
    const made = make()
    expect(all<HTMLOptionElement>(styleSelect(made.card), 'option').map((one) => one.value)).toContain(
      'heatmap',
    )
  })

  it('keeps the colours picker out of the way until there are colours to pick', () => {
    const made = make()
    expect(fieldOf(coloursSelect(made.card)).classList.contains('hidden')).toBe(true)
  })

  it('shows it on the pick that asks for it, without waiting for a rebuild', () => {
    const made = make()
    const style = styleSelect(made.card)
    style.value = 'heatmap'
    style.dispatchEvent(new Event('change'))
    expect(made.store.entries[0].style.mode).toBe('heatmap')
    // The card has *not* rebuilt — the select still holds focus as far as it is
    // concerned — so this is the picker that was already there, revealed.
    expect(fieldOf(coloursSelect(made.card)).classList.contains('hidden')).toBe(false)
  })

  it('writes the reader’s colours onto the row, and their empty choice as none', () => {
    const made = make()
    const colours = coloursSelect(made.card)
    colours.value = 'magma'
    colours.dispatchEvent(new Event('change'))
    expect(made.store.entries[0].style.colormap).toBe('magma')
    colours.value = ''
    colours.dispatchEvent(new Event('change'))
    expect(made.store.entries[0].style.colormap).toBe('')
  })
})

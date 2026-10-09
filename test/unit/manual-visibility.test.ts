/**
 * The reader's marks, drawn or not (§8.1).
 *
 * Every picture draws from the store's `lines`, `arrowheads` and `rects` — the
 * map, the lanes beside it, the 1D browser, a tracks cell — and the model from
 * `shown`, so what is asserted here is the whole of what *hidden* means on
 * screen. What is worth pinning down is the second half: the two hands a mark
 * can be put away by, and that each brings back only what it hid. A reader who
 * hid one mark for a figure and then hid everything to look at the pixels must
 * get that figure back, not every mark.
 */

import { describe, expect, it } from 'vitest'

import { ManualStore, isShown, type ManualMark } from '@/annotations/manual'
import { remember } from '@/state/UiMemory'

const line = (id: string, bp: number): ManualMark => ({
  id,
  kind: 'line',
  axis: 'vertical',
  at: { contig: 'IV', bp },
  colour: '#111318',
})
const arrowhead = (id: string): ManualMark => ({
  id,
  kind: 'arrowhead',
  a: { contig: 'IV', bp: 1_140_000 },
  b: { contig: 'IV', bp: 1_262_000 },
  colour: '#1f5fa9',
})
const rect = (id: string): ManualMark => ({
  id,
  kind: 'rect',
  a: { contig: 'IV', from: 1_040_000, to: 1_110_000 },
  b: { contig: 'IV', from: 1_040_000, to: 1_110_000 },
  colour: '#0f8a5f',
})

/** A store of four marks on a file of its own: two lines, an arrowhead and a box. */
function four(): ManualStore {
  const store = new ManualStore(`visibility-${Math.random()}.cool`)
  for (const mark of [line('k1', 1_200_000), line('k2', 1_330_000), arrowhead('k3'), rect('k4')]) store.add(mark)
  return store
}

/** Each mark's id and why it is hidden, `-` for drawn. */
const states = (store: ManualStore): string[] => store.marks.map((mark) => `${mark.id}:${mark.hidden ?? '-'}`)

describe('a mark drawn or hidden', () => {
  it('is drawn when made, and every picture reads only the drawn ones', () => {
    const store = four()
    expect(store.marks.every(isShown)).toBe(true)
    expect(store.anyShown).toBe(true)
    store.setShown('k1', false)
    // What the map, the lanes and the browser paint from…
    expect(store.lines.map((mark) => mark.id)).toEqual(['k2'])
    expect(store.arrowheads.map((mark) => mark.id)).toEqual(['k3'])
    expect(store.rects.map((mark) => mark.id)).toEqual(['k4'])
    // …and the model, while the card, the export and a reopen still hold all four.
    expect(store.shown.map((mark) => mark.id)).toEqual(['k2', 'k3', 'k4'])
    expect(store.marks.map((mark) => mark.id)).toEqual(['k1', 'k2', 'k3', 'k4'])
    expect(store.hiddenCount).toBe(1)
  })

  it('is hidden from its own row on its own, and shown again by it', () => {
    const store = four()
    store.setShown('k3', false)
    expect(states(store)).toEqual(['k1:-', 'k2:-', 'k3:own', 'k4:-'])
    store.setShown('k3', true)
    expect(states(store)).toEqual(['k1:-', 'k2:-', 'k3:-', 'k4:-'])
    // Drawn, a mark carries nothing: the field is gone, not `undefined`.
    expect('hidden' in store.marks[2]).toBe(false)
  })

  it('says nothing when nothing moved', () => {
    const store = four()
    let told = 0
    store.subscribe(() => told++)
    store.setShown('k1', true)
    store.showAll()
    store.setShown('nowhere', false)
    expect(told).toBe(0)
    store.setShown('k1', false)
    store.setShown('k1', false)
    expect(told).toBe(1)
  })
})

describe('every mark at once', () => {
  it('hides what is drawn, and brings back exactly that — a mark hidden by hand stays hidden', () => {
    const store = four()
    store.setShown('k2', false)
    store.hideAll()
    expect(states(store)).toEqual(['k1:all', 'k2:own', 'k3:all', 'k4:all'])
    expect(store.anyShown).toBe(false)
    store.showAll()
    expect(states(store)).toEqual(['k1:-', 'k2:own', 'k3:-', 'k4:-'])
  })

  it('brings every mark back where each was hidden by hand, there being nothing hidden together', () => {
    const store = four()
    for (const id of ['k1', 'k2', 'k3', 'k4']) store.setShown(id, false)
    expect(store.anyShown).toBe(false)
    store.showAll()
    expect(store.marks.every(isShown)).toBe(true)
  })

  it('is a switch: off while any is drawn, back to the same picture on the second press', () => {
    const store = four()
    store.setShown('k4', false)
    const before = states(store)
    expect(store.toggleAll()).toBe(false)
    expect(store.shown).toEqual([])
    expect(store.toggleAll()).toBe(true)
    expect(states(store)).toEqual(before)
  })

  it('takes one mark shown from its own row back out of the ones hidden together', () => {
    const store = four()
    store.hideAll()
    store.setShown('k3', true)
    expect(states(store)).toEqual(['k1:all', 'k2:all', 'k3:-', 'k4:all'])
    // One mark drawn makes the switch a hide again; the second press is every mark back.
    store.toggleAll()
    expect(store.anyShown).toBe(false)
    store.toggleAll()
    expect(store.marks.every(isShown)).toBe(true)
  })

  it('lets a mark drawn while the rest are hidden be drawn, and leaves the rest hidden', () => {
    const store = four()
    store.hideAll()
    store.add(line('k5', 1_250_000))
    expect(store.shown.map((mark) => mark.id)).toEqual(['k5'])
  })
})

describe('one mark alone', () => {
  it('puts the other drawn marks away together, and a second asking brings back exactly those', () => {
    const store = four()
    store.setShown('k1', false)
    store.showAlone('k4')
    expect(states(store)).toEqual(['k1:own', 'k2:all', 'k3:all', 'k4:-'])
    store.showAlone('k4')
    expect(states(store)).toEqual(['k1:own', 'k2:-', 'k3:-', 'k4:-'])
  })

  it('shows a hidden mark alone', () => {
    const store = four()
    store.setShown('k2', false)
    store.showAlone('k2')
    expect(store.shown.map((mark) => mark.id)).toEqual(['k2'])
  })

  it('is *show the marks* undone, as the switch is', () => {
    const store = four()
    store.showAlone('k3')
    store.showAll()
    expect(store.marks.every(isShown)).toBe(true)
  })
})

describe('a hidden mark kept', () => {
  it('comes back hidden, for the same reason, with the file', () => {
    const uri = `kept-${Math.random()}.cool`
    const store = new ManualStore(uri)
    store.add(line('k1', 1_200_000))
    store.add(rect('k2'))
    store.setShown('k1', false)
    store.hideAll()
    expect(states(new ManualStore(uri))).toEqual(['k1:own', 'k2:all'])
  })

  it('is drawn where what was stored is no reason this build knows', () => {
    const uri = `odd-${Math.random()}.cool`
    remember(uri, 'manual-annotations', [
      { ...line('k1', 1), hidden: 'sometimes' },
      { ...line('k2', 2), hidden: true },
      { ...line('k3', 3), hidden: 'own' },
    ])
    expect(states(new ManualStore(uri))).toEqual(['k1:-', 'k2:-', 'k3:own'])
  })

  it('stays hidden when it is moved by typing over its row, and stays where it is when it is shown', () => {
    const store = four()
    store.setShown('k1', false)
    // The editor's copy of the mark is the row's, from before anything changed.
    store.reshape({ ...line('k1', 1_210_000), colour: '#000000' })
    expect(store.marks[0]).toMatchObject({ id: 'k1', hidden: 'own', colour: '#111318', at: { bp: 1_210_000 } })
    store.setShown('k1', true)
    expect(store.marks.map((mark) => mark.id)).toEqual(['k1', 'k2', 'k3', 'k4'])
  })

  it('does not come back drawn from a stale editor, nor go hidden from one', () => {
    const store = four()
    const row = store.marks[1]
    store.hideAll()
    store.reshape({ ...row, kind: 'line', at: { contig: 'IV', bp: 1_331_000 } } as ManualMark)
    expect(store.marks[1].hidden).toBe('all')
  })
})

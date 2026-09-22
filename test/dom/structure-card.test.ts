// @vitest-environment jsdom
/**
 * The Structures card (§25): every model as a row, with the two things a model
 * row is for — into the deck by its eye, out as a bed3d — and the provenance of
 * a computed one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationLoader } from '@/annotations/loader'
import type { AnnotationEntry, ComputedSource } from '@/annotations/types'
import { defaultStyle } from '@/annotations/types'
import { STRUCTURE_DRAG_TYPE } from '@/ui/dom'
import { StructureCard } from '@/ui/StructureCard'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: StructureCard[] = []

beforeEach(() => {
  teardown = setUpDom()
  sessionStorage.clear()
})

afterEach(() => {
  for (const card of built.splice(0, built.length)) card.destroy()
  teardown()
  sessionStorage.clear()
})

const G3D = Array.from({ length: 6 }, (_, i) => `chr1\t${i * 5000}\t${i}\t0\t${i * 0.5}`).join('\n')

const COMPUTED: ComputedSource = {
  kind: 'computed',
  name: '3D model · chr1',
  task: 'reconstruct3d',
  recipe: { taskVersion: 1, params: { alpha: 3 } },
  framing: 'chr1:1–30,000 at 5 kb',
}

function seed(store: AnnotationStore, id: string, source: Parameters<AnnotationStore['begin']>[0]['source'] | { kind: 'detached'; name: string }, status: AnnotationEntry['status'] = 'ready'): void {
  store.begin({
    card: 'structure',
    kind: 'structure',
    id,
    label: id,
    source: source as never,
    style: defaultStyle('structure', '#1f5fa9'),
  })
  store.update(id, {
    status,
    ...(status === 'ready' ? { payload: { kind: 'features', data: parseG3d(G3D) } } : {}),
  })
}

function make(options: { onShow?: (entry: AnnotationEntry) => void; onHide?: (entry: AnnotationEntry) => void; shown?: (id: string) => boolean; onRecompute?: (entry: AnnotationEntry) => void } = {}) {
  const store = new AnnotationStore(`structures-${Math.random()}.cool`, { persist: false })
  const added: string[] = []
  const loader = {
    addFiles: (files: File[]) => added.push(...files.map((file) => file.name)),
    addUrl: (url: string) => added.push(url),
  } as unknown as AnnotationLoader
  const card = new StructureCard({ store, loader, ...options })
  built.push(card)
  document.body.appendChild(card.el)
  return { store, card, added }
}

describe('the Structures card', () => {
  it('lists structure rows only, loaded and computed alike, with what each holds', () => {
    const { store, card } = make()
    seed(store, 'model.g3d', { kind: 'detached', name: 'model.g3d' })
    seed(store, 'analysis:reconstruct3d:reconstructed-model', COMPUTED)
    store.begin({ card: 'linear', kind: 'track', id: 'atac', label: 'atac', source: { kind: 'detached', name: 'atac.bw' } as never })
    const rows = all<HTMLElement>(card.el, '.ann-row')
    expect(rows.map((row) => row.dataset['id'])).toEqual(['model.g3d', 'analysis:reconstruct3d:reconstructed-model'])
    expect(rows[0].textContent).toMatch(/6 beads/)
    expect(rows[0].textContent).toMatch(/5 kb/)
    // A computed row says what made it and what it was made from.
    expect(rows[1].textContent).toMatch(/Model from the map/)
    expect(rows[1].querySelector('.ann-origin')?.textContent).toBe('chr1:1–30,000 at 5 kb')
    expect(card.el.querySelector('.ann-drop-label')?.textContent).toBe('Load a structure')
  })

  it('gives every row a grip that carries the model into the deck', () => {
    const { store, card } = make()
    seed(store, 'a.g3d', { kind: 'detached', name: 'a.g3d' })
    seed(store, 'b.g3d', { kind: 'detached', name: 'b.g3d' })
    const rows = all<HTMLElement>(card.el, '.ann-row')
    expect(rows).toHaveLength(2)
    // One per row, and each carrying its own model — the point of the gesture
    // being *that one, there* where the row's button always means the one cell.
    for (const row of rows) {
      const grip = row.querySelector<HTMLElement>('.ann-grip')
      expect(grip?.getAttribute('draggable')).toBe('true')
      expect(grip?.dataset['grip']).toBe(row.dataset['id'])
    }
    // The drag carries the id under this app's own type, which is what lets an
    // empty cell tell a model apart from a file while the drag is still up.
    const carried = new Map<string, string>()
    const transfer = {
      effectAllowed: '',
      setData: (type: string, value: string) => carried.set(type, value),
      setDragImage: () => {},
    }
    const grip = rows[1].querySelector<HTMLElement>('.ann-grip')
    const event = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown }
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    grip?.dispatchEvent(event)
    expect(carried.get(STRUCTURE_DRAG_TYPE)).toBe('b.g3d')
    // …and something under `text/plain` too, because a browser cancels a drag
    // that carries nothing at all.
    expect(carried.get('text/plain')).toBeDefined()
  })

  /**
   * **The eye is the row's one show/hide.** There was a *show in the deck* text
   * button here as well, which did the same thing, relabelled itself *shown in
   * the deck* while the cell was drawing the row, and went on calling `onShow`
   * when pressed in that state — so the obvious gesture, pressing the lit one to
   * un-show, did nothing. §26.3 and §26.7: the lit control is the state, and no
   * button is labelled with what is already true.
   */
  it('puts a model in the deck with the eye, and says which one is there', () => {
    const shown: string[] = []
    const hidden: string[] = []
    const drawn = new Set<string>()
    const { store, card } = make({
      onShow: (entry) => shown.push(entry.id),
      onHide: (entry) => hidden.push(entry.id),
      shown: (id) => drawn.has(id),
    })
    seed(store, 'a.g3d', { kind: 'detached', name: 'a.g3d' })
    seed(store, 'b.g3d', { kind: 'detached', name: 'b.g3d' })
    expect(all(card.el, '.structure-show')).toHaveLength(0)
    const eyes = all<HTMLButtonElement>(card.el, '.ann-eye')
    expect(eyes).toHaveLength(2)
    expect(eyes.map((eye) => eye.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    eyes[1].click()
    expect(shown).toEqual(['b.g3d'])
    drawn.add('b.g3d')
    card.refresh()
    const after = all<HTMLButtonElement>(card.el, '.ann-eye')
    expect(after.map((eye) => eye.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(all<HTMLElement>(card.el, '.ann-row.is-shown').map((row) => row.dataset['id'])).toEqual(['b.g3d'])
    // …and the lit one takes *that row's* cell back out, which is what a reader
    // presses it for. Per row, since each model has a cell of its own (§25.3).
    after[1].click()
    expect(hidden).toEqual(['b.g3d'])
  })

  it('offers no eye where no deck is possible, and disables the export until the row is ready', () => {
    const { store, card } = make()
    seed(store, 'late.g3d', { kind: 'detached', name: 'late.g3d' }, 'loading')
    expect(card.el.querySelector<HTMLButtonElement>('.ann-eye')?.disabled).toBe(true)
    const bed3d = card.el.querySelector<HTMLButtonElement>('.structure-bed3d')
    expect(bed3d?.disabled).toBe(true)
    expect(card.el.querySelector('.ann-row')?.textContent).toMatch(/reading…/)
  })

  it('offers a detached computed row its recipe again', () => {
    const recomputed: string[] = []
    const { store, card } = make({ onRecompute: (entry) => recomputed.push(entry.id) })
    seed(store, 'analysis:reconstruct3d:reconstructed-model', COMPUTED, 'detached')
    const row = card.el.querySelector('.ann-row')
    expect(row?.textContent).toMatch(/not carried across the reload/)
    const button = Array.from(all<HTMLButtonElement>(card.el, 'button')).find((b) => b.textContent === 'recompute')
    expect(button).toBeDefined()
    button?.click()
    expect(recomputed).toEqual(['analysis:reconstruct3d:reconstructed-model'])
  })

  it('renames and removes through the store, like every other row', () => {
    const { store, card } = make()
    seed(store, 'model.g3d', { kind: 'detached', name: 'model.g3d' })
    const name = card.el.querySelector<HTMLInputElement>('.ann-name')
    if (name === null) throw new Error('no name box')
    name.value = 'my model'
    name.dispatchEvent(new Event('change'))
    expect(store.byId('model.g3d')?.label).toBe('my model')
    card.el.querySelector<HTMLButtonElement>('.btn-close')?.click()
    expect(store.byId('model.g3d')).toBeUndefined()
    expect(all(card.el, '.ann-row')).toHaveLength(0)
  })

  it('shows and hides the model in the deck from the eye, not a flag nothing reads', () => {
    let shown: string | null = null
    const { store, card } = make({
      onShow: (entry) => { shown = entry.id },
      onHide: () => { shown = null },
      shown: (id) => shown === id,
    })
    seed(store, 'model.g3d', COMPUTED)
    const eye = (): HTMLButtonElement | null => card.el.querySelector<HTMLButtonElement>('.ann-eye')
    expect(eye()?.getAttribute('aria-pressed')).toBe('false')
    eye()?.click()
    card.refresh()
    expect(shown).toBe('model.g3d')
    expect(eye()?.getAttribute('aria-pressed')).toBe('true')
    // …and the same button takes it out of the deck again.
    eye()?.click()
    card.refresh()
    expect(shown).toBeNull()
    expect(eye()?.getAttribute('aria-pressed')).toBe('false')
    // The row's own `visible` flag is untouched: a model has no lane to hide.
    expect(store.byId('model.g3d')?.visible).toBe(true)
  })

  it('takes a file dropped anywhere on the card, not only on the Tracks card', () => {
    const { card, added } = make()
    const file = new File(['chr1\t0\t5000\t1\t2\t3\n'], 'model.g3d', { type: 'text/plain' })
    const transfer = { files: [file], items: [{ kind: 'file', type: 'text/plain' }], types: ['Files'] }
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    card.el.dispatchEvent(drop)
    expect(added).toEqual(['model.g3d'])
  })

  it('offers no box to paste a URL into, here or on any other card', () => {
    // The card is the target and nothing under it (§5.11): a remote structure
    // arrives by the address bar, by a session or by the Files column, and a
    // text box under the drop zone was a third way of saying *open something*
    // on a card that already says it twice.
    const { card } = make()
    expect(card.el.querySelector('details.ann-url')).toBeNull()
    expect(card.el.querySelector('input[type="url"]')).toBeNull()
    expect(card.el.textContent).not.toContain('by URL')
  })
})

// @vitest-environment jsdom
/**
 * The ticked rows' settings, edited as one (§8.1).
 *
 * The batch box used to carry four actions: a group, a colour, the tallest
 * height, hide and remove. Limits, style, scale, flip and the edges were one
 * trip per row — and those are what six replicates are ticked together for. So
 * the box carries a row's settings now, and these tests pin the three rules it
 * runs on: it **shows what the rows share** and *mixed* where they differ; a
 * control is **written to every ticked row it means something to** and to no
 * other; and **nothing changes until the reader picks**.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { LEAD_MAP } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationEntry, AnnotationKind } from '@/annotations/types'
import { AnnotationCard } from '@/ui/AnnotationCard'
import { all, setUpDom, type DomTeardown } from '../support/dom'

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

interface Made {
  store: AnnotationStore
  card: AnnotationCard
  /** How many times the store announced a change since the box was built. */
  changes(): number
}

function row(store: AnnotationStore, name: string, kind: AnnotationKind = 'track'): AnnotationEntry {
  const entry = store.begin({
    card: 'linear',
    kind,
    id: name,
    label: name,
    source: { kind: 'remote', url: `${name}.${kind === 'track' ? 'bw' : 'bed'}`, name },
  })
  store.update(entry.id, { status: 'ready' })
  return entry
}

/** A Tracks card over `names`, with `ticked` of them ticked. */
function make(names: Array<[string, AnnotationKind?]>, ticked: string[]): Made {
  const store = new AnnotationStore(`batch-${Math.random()}.cool`, { persist: false })
  for (const [name, kind] of names) row(store, name, kind)
  const card = new AnnotationCard({
    store,
    loader: new AnnotationLoader(
      store,
      { request: () => Promise.resolve(null), drop: () => {} } as never,
      [],
    ),
  })
  built.push(card)
  document.body.append(card.el)
  for (const id of ticked) {
    const box = card.el.querySelector<HTMLInputElement>(`.ann-tick[data-tick="${id}"]`)
    if (box === null) throw new Error(`no tick for ${id}`)
    box.checked = true
    box.dispatchEvent(new Event('change'))
  }
  let changes = 0
  store.subscribe(() => changes++)
  return { store, card, changes: () => changes }
}

function box(made: Made): HTMLElement {
  const found = made.card.el.querySelector<HTMLElement>('.ann-batch')
  if (found === null) throw new Error('no batch box')
  return found
}

/** The control in the field labelled `label`. */
function control<T extends HTMLElement>(made: Made, label: string, selector: string): T {
  const field = all<HTMLElement>(box(made), '.field').find(
    (node) => node.querySelector('.field-label')?.textContent === label,
  )
  const found = field?.querySelector<T>(selector)
  if (found === null || found === undefined) throw new Error(`no ${selector} under ${label}`)
  return found
}

function labels(made: Made): string[] {
  return all<HTMLElement>(box(made), '.field-label').map((node) => node.textContent ?? '')
}

describe('the batch box', () => {
  it('appears with two ticks and carries a row’s settings', () => {
    const made = make([['ATAC'], ['MNase'], ['Pol2']], ['ATAC', 'MNase'])
    expect(box(made).querySelector('.ann-batch-count')?.textContent).toBe('2 selected')
    for (const label of ['colour', 'height', 'style', 'scale', 'limits', 'group', 'location']) {
      expect(labels(made)).toContain(label)
    }
    expect(box(made).querySelector('.ann-flip')).not.toBeNull()
  })

  it('is not there for one tick', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC'])
    expect(made.card.el.querySelector('.ann-batch')).toBeNull()
  })

  it('shows a value the rows share, and mixed where they differ', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    made.store.restyle('ATAC', { size: 40 })
    made.store.restyle('MNase', { size: 40 })
    expect(control<HTMLInputElement>(made, 'height', 'input').value).toBe('40')

    made.store.restyle('MNase', { size: 90, mode: 'line' })
    const height = control<HTMLInputElement>(made, 'height', 'input')
    expect(height.value).toBe('')
    expect(height.placeholder).toBe('mixed')
    const style = control<HTMLSelectElement>(made, 'style', 'select')
    expect(style.selectedOptions[0]?.textContent).toBe('mixed')
  })

  it('changes nothing until a pick is made', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    expect(made.changes()).toBe(0)
  })
})

describe('a setting given to the ticked rows', () => {
  it('writes one pair of limits to all of them, as one change', () => {
    const made = make([['ATAC'], ['MNase'], ['Pol2']], ['ATAC', 'Pol2'])
    const [low, high] = all<HTMLInputElement>(box(made), '.ann-limits input')
    low.value = '0'
    high.value = '20'
    high.dispatchEvent(new Event('change'))
    expect(made.store.byId('ATAC')?.style.limits).toEqual({ auto: false, min: 0, max: 20 })
    expect(made.store.byId('Pol2')?.style.limits).toEqual({ auto: false, min: 0, max: 20 })
    // The unticked row keeps its own.
    expect(made.store.byId('MNase')?.style.limits.auto).toBe(true)
    expect(made.changes()).toBe(1)
  })

  it('waits for both bounds, and refuses two equal ones', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    const [low, high] = all<HTMLInputElement>(box(made), '.ann-limits input')
    low.value = '5'
    low.dispatchEvent(new Event('change'))
    expect(made.changes()).toBe(0)
    high.value = '5'
    high.dispatchEvent(new Event('change'))
    expect(made.changes()).toBe(0)
    expect(high.classList.contains('is-bad')).toBe(true)
  })

  it('takes a pair that runs backwards as a flip of every row (§8.8)', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    const [low, high] = all<HTMLInputElement>(box(made), '.ann-limits input')
    low.value = '5'
    high.value = '1'
    high.dispatchEvent(new Event('change'))
    for (const id of ['ATAC', 'MNase']) {
      expect(made.store.byId(id)?.style.limits).toEqual({ auto: false, min: 1, max: 5 })
      expect(made.store.byId(id)?.style.flip).toBe(true)
    }
  })

  it('goes back to auto keeping each row’s own pair', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    made.store.restyle('ATAC', { limits: { auto: false, min: 0, max: 20 } })
    made.store.restyle('MNase', { limits: { auto: false, min: 1, max: 9 } })
    const auto = box(made).querySelector<HTMLButtonElement>('.clip-auto')
    auto?.click()
    expect(made.store.byId('ATAC')?.style.limits).toEqual({ auto: true, min: 0, max: 20 })
    expect(made.store.byId('MNase')?.style.limits).toEqual({ auto: true, min: 1, max: 9 })
  })

  it('gives a style to the rows that have one, and leaves a feature set alone', () => {
    const made = make(
      [['ATAC'], ['peaks', 'segments'], ['MNase']],
      ['ATAC', 'peaks', 'MNase'],
    )
    const style = control<HTMLSelectElement>(made, 'style', 'select')
    // Said, rather than left to be discovered: two of the three take it.
    expect(style.closest('.field')?.getAttribute('title')).toContain('2 of the 3')
    style.value = 'bar'
    style.dispatchEvent(new Event('change'))
    expect(made.store.byId('ATAC')?.style.mode).toBe('bar')
    expect(made.store.byId('MNase')?.style.mode).toBe('bar')
    expect(made.store.byId('peaks')?.style.mode).not.toBe('bar')
  })

  it('shows the colours on the pick of a heatmap, before any rebuild', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    const colours = control<HTMLSelectElement>(made, 'colours', 'select').closest('.field')
    expect(colours?.classList.contains('hidden')).toBe(true)
    const style = control<HTMLSelectElement>(made, 'style', 'select')
    style.value = 'heatmap'
    style.dispatchEvent(new Event('change'))
    expect(colours?.classList.contains('hidden')).toBe(false)
  })

  it('flips a mixed set all one way', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    made.store.restyle('MNase', { flip: true })
    const flip = box(made).querySelector<HTMLButtonElement>('.ann-flip')
    expect(flip?.getAttribute('aria-pressed')).toBe('mixed')
    flip?.click()
    expect(made.store.byId('ATAC')?.style.flip).toBe(true)
    expect(made.store.byId('MNase')?.style.flip).toBe(true)
  })

  it('puts them all on an edge, and takes them all off it', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    const edge = (name: string): HTMLButtonElement => {
      const found = all<HTMLButtonElement>(box(made), '.ann-place').find(
        (node) => node.dataset.edge === name,
      )
      if (found === undefined) throw new Error(`no ${name} edge`)
      return found
    }
    // A loaded track opens on the bottom, so the bottom is lit for both.
    expect(edge('bottom').getAttribute('aria-pressed')).toBe('true')
    made.store.placeAt('MNase', LEAD_MAP, { bottom: true, right: true })
    expect(edge('right').getAttribute('aria-pressed')).toBe('mixed')
    edge('right').click()
    expect(made.store.laneFor('ATAC', LEAD_MAP)?.placement.right).toBe(true)
    expect(made.store.laneFor('MNase', LEAD_MAP)?.placement.right).toBe(true)
    edge('right').click()
    expect(made.store.laneFor('ATAC', LEAD_MAP)?.placement.right).toBe(false)
    expect(made.store.laneFor('MNase', LEAD_MAP)?.placement.right).toBe(false)
    expect(made.store.laneFor('ATAC', LEAD_MAP)?.placement.bottom).toBe(true)
  })

  it('names a new group, puts them in it, and clears the ticks', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    vi.spyOn(window, 'prompt').mockReturnValue('replicates')
    const group = control<HTMLSelectElement>(made, 'group', 'select')
    group.value = ' new'
    group.dispatchEvent(new Event('change'))
    expect(made.store.byId('ATAC')?.style.group).toBe('replicates')
    expect(made.store.byId('MNase')?.style.group).toBe('replicates')
    expect(made.card.el.querySelector('.ann-batch')).toBeNull()
  })

  it('hides them all, and then shows them all', () => {
    const made = make([['ATAC'], ['MNase']], ['ATAC', 'MNase'])
    const press = (text: string): void => {
      const found = all<HTMLButtonElement>(box(made), 'button').find(
        (node) => node.textContent === text,
      )
      if (found === undefined) throw new Error(`no ${text} button`)
      found.click()
    }
    press('hide')
    expect(made.store.entries.every((entry) => !entry.visible)).toBe(true)
    press('show')
    expect(made.store.entries.every((entry) => entry.visible)).toBe(true)
  })
})

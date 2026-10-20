// @vitest-environment jsdom
/**
 * Tab between the fields of one kind (§26.8).
 *
 * A field edited in place is one of a run of fields of its kind — a track's
 * name among the tracks' names, one end of a range among the ranges' ends, a
 * map's name among the deck's — and Tab in one is Enter that goes on: what was
 * typed is taken, and the caret is put in the next field of the run, Shift+Tab
 * the one before; past either end it is let go, as Enter lets it go, and a
 * value the field refuses keeps the caret where it is. Pinned here for the
 * helper every always-on field uses, for the caret laid over a lane's small
 * print, for the colour key's two numbers and the keys of a deck, for the
 * tabs' names, and for the dialog whose own Tab must not answer first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TabStrip, type TabSpec } from '@/app/TabStrip'
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle } from '@/annotations/types'
import type { LimitBox, NameBox } from '@/render/laneLabel'
import { el } from '@/ui/dom'
import { LaneEditor, tabAlong, type EditorAt, type TabStop } from '@/ui/LaneEditor'
import { MapKey } from '@/ui/MapKey'
import { Modal } from '@/ui/Modal'
import { TAB_WALKS, tabAmong, tabStep } from '@/ui/tabWalk'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** A key pressed in a field, as the browser delivers one: cancelable, bubbling. */
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('which way a key walks', () => {
  it('is on for Tab, back for Shift+Tab, and nothing for any other key', () => {
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(1)
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBe(-1)
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Enter' }))).toBeNull()
  })

  it('leaves a Tab with a modifier to the browser and the system, and one mid-composition to the IME', () => {
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true }))).toBeNull()
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Tab', altKey: true }))).toBeNull()
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Tab', metaKey: true }))).toBeNull()
    expect(tabStep(new KeyboardEvent('keydown', { key: 'Tab', isComposing: true }))).toBeNull()
  })
})

describe('a run of fields always on the page', () => {
  /**
   * A card's list of names, each taking what was typed on `change` as the
   * cards do — and, as the Tracks card does, building its rows again on a
   * commit, so the field that had the caret is not on the page afterwards.
   */
  function card(names: string[], rebuilds = false): { list: HTMLElement; fields: () => HTMLInputElement[]; taken: string[] } {
    const list = el('div', { class: 'ann-list' })
    const taken: string[] = []
    const build = (): void => {
      list.replaceChildren(
        ...names.map((name, at) => {
          const field = el('input', { class: 'input ann-name', type: 'text', value: name })
          field.addEventListener('change', () => {
            names[at] = field.value
            taken.push(field.value)
            if (rebuilds) build()
          })
          field.addEventListener('keydown', (event) => {
            tabAmong(event, field, '.ann-list', 'input.ann-name')
          })
          return el('div', { class: 'ann-row' }, el('button', { text: 'eye' }), field, el('button', { text: '×' }))
        }),
      )
    }
    build()
    document.body.appendChild(list)
    return { list, fields: () => [...list.querySelectorAll<HTMLInputElement>('input.ann-name')], taken }
  }

  /** Type into a field the way a reader does: focus, then a new value. */
  function type(field: HTMLInputElement, text: string): void {
    field.focus()
    field.value = text
  }

  it('takes what was typed and puts the caret in the next name, past the row’s own buttons', () => {
    const { fields, taken } = card(['ATAC', 'Pol II', 'genes'])
    const [first, second] = fields()
    type(first, 'ATAC rep1')
    const event = press(first, 'Tab')
    expect(event.defaultPrevented).toBe(true)
    // jsdom fires no `change` on a blur, so the commit is the card's to show.
    first.dispatchEvent(new Event('change'))
    expect(taken).toEqual(['ATAC rep1'])
    expect(document.activeElement).toBe(second)
  })

  it('goes back with Shift+Tab, and lets the caret go past either end', () => {
    const { fields } = card(['ATAC', 'Pol II', 'genes'])
    const [first, second, third] = fields()
    second.focus()
    press(second, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(first)
    third.focus()
    press(third, 'Tab')
    expect(document.activeElement).not.toBe(third)
    expect(fields().includes(document.activeElement as HTMLInputElement)).toBe(false)
    first.focus()
    press(first, 'Tab', { shiftKey: true })
    expect(fields().includes(document.activeElement as HTMLInputElement)).toBe(false)
  })

  it('finds the next name after a commit that built the rows again', () => {
    const { fields } = card(['ATAC', 'Pol II', 'genes'], true)
    const [first] = fields()
    type(first, 'ATAC rep1')
    // The commit a real blur fires, rebuilding the list before the caret moves.
    first.addEventListener('blur', () => first.dispatchEvent(new Event('change')), { once: true })
    press(first, 'Tab')
    expect(first.isConnected).toBe(false)
    expect(document.activeElement).toBe(fields()[1])
    expect(fields()[0].value).toBe('ATAC rep1')
  })

  it('skips a field that cannot be typed into', () => {
    const { fields } = card(['ATAC', 'Pol II', 'genes'])
    const [first, second, third] = fields()
    second.readOnly = true
    first.focus()
    press(first, 'Tab')
    expect(document.activeElement).toBe(third)
  })
})

describe('the caret over a lane’s small print', () => {
  function store(): AnnotationStore {
    const held = new AnnotationStore(`tab-${Math.random()}.cool`, { persist: false })
    for (const id of ['a', 'b']) {
      held.begin({
        card: 'linear',
        kind: 'track',
        id,
        label: id === 'a' ? 'ATAC' : 'Pol II',
        source: { kind: 'local', name: `${id}.bw`, file: new File([], `${id}.bw`) },
        placement: { top: false, right: false, bottom: true, left: false },
        style: defaultStyle('track', '#0072b2'),
        visible: true,
      })
    }
    return held
  }

  const NAME: NameBox = { id: 'a', text: 'ATAC', box: [10, 10, 30, 12], along: 30, font: '' }
  const MIN: LimitBox = { part: 'min', value: '0', box: [10, 30, 8, 12], along: 8 }

  function editor(held: AnnotationStore, tabs: Array<{ from: EditorAt; step: 1 | -1 }>): { editor: LaneEditor; host: HTMLElement } {
    const host = el('div')
    document.body.appendChild(host)
    return {
      host,
      editor: new LaneEditor({
        host,
        store: held,
        shownLimits: () => ({ min: 0, max: 10 }),
        onChange: () => {},
        onTab: (from, step) => tabs.push({ from, step }),
      }),
    }
  }

  it('takes a name on Tab and asks for the next box of its kind, saying which box it left', () => {
    const held = store()
    const tabs: Array<{ from: EditorAt; step: 1 | -1 }> = []
    const { editor: lanes, host } = editor(held, tabs)
    lanes.openName({ entry: held.byId('a')!, hit: NAME }, { left: 0, top: 0 }, 'bottom')
    const input = host.querySelector('input') as HTMLInputElement
    expect(input.hasAttribute(TAB_WALKS)).toBe(true)
    input.value = 'ATAC rep1'
    press(input, 'Tab')
    expect(held.byId('a')?.label).toBe('ATAC rep1')
    expect(host.querySelector('input')).toBeNull()
    expect(tabs).toEqual([{ from: { kind: 'name', id: 'a', place: 'bottom' }, step: 1 }])
  })

  it('goes on from an end left as it was, which is no decision', () => {
    const held = store()
    const tabs: Array<{ from: EditorAt; step: 1 | -1 }> = []
    const { editor: lanes, host } = editor(held, tabs)
    lanes.openLimit({ entries: [held.byId('a')!], hit: MIN }, { left: 0, top: 0 })
    press(host.querySelector('input') as HTMLInputElement, 'Tab', { shiftKey: true })
    expect(held.byId('a')?.style.limits.auto).toBe(true)
    expect(tabs).toEqual([{ from: { kind: 'limit', id: 'a', part: 'min', place: '' }, step: -1 }])
  })

  it('keeps the caret on a number the range refuses, as Enter does', () => {
    const held = store()
    const tabs: Array<{ from: EditorAt; step: 1 | -1 }> = []
    const { editor: lanes, host } = editor(held, tabs)
    lanes.openLimit({ entries: [held.byId('a')!], hit: MIN }, { left: 0, top: 0 })
    const input = host.querySelector('input') as HTMLInputElement
    // Not a number at all. (A bottom above the top is a flip, §8.8, and taken.)
    input.value = 'twenty'
    press(input, 'Tab')
    expect(host.querySelector('input')).toBe(input)
    expect(tabs).toEqual([])
  })

  it('walks a run of boxes to the next, the one before, and nowhere past the ends', () => {
    const opened: string[] = []
    const stop = (id: string, part: 'min' | 'max'): TabStop => ({
      at: { kind: 'limit', id, part, place: 'bottom' },
      open: () => opened.push(`${id}.${part}`),
    })
    const run = [stop('a', 'min'), stop('a', 'max'), stop('b', 'min'), stop('b', 'max')]
    tabAlong(run, { kind: 'limit', id: 'a', part: 'min', place: 'bottom' }, 1)
    tabAlong(run, { kind: 'limit', id: 'a', part: 'max', place: 'bottom' }, 1)
    tabAlong(run, { kind: 'limit', id: 'b', part: 'min', place: 'bottom' }, -1)
    tabAlong(run, { kind: 'limit', id: 'b', part: 'max', place: 'bottom' }, 1)
    tabAlong(run, { kind: 'limit', id: 'a', part: 'min', place: 'bottom' }, -1)
    // The same track's box on another stack is another box.
    tabAlong(run, { kind: 'limit', id: 'a', part: 'min', place: 'right' }, 1)
    expect(opened).toEqual(['a.max', 'b.min', 'a.max'])
  })
})

describe('the colour key’s two numbers', () => {
  const CONTENT = {
    title: 'Balanced (log10)',
    lo: -4,
    hi: -1,
    loLabel: '-4',
    hiLabel: '-1',
    loColor: '#fff',
    hiColor: '#000',
    ramp: ['#fff', '#000'],
  }

  function key(changes: Array<[string, number | null]>, into: HTMLElement = document.body): MapKey {
    const made = new MapKey({ onChange: (bound, value) => changes.push([bound, value]) })
    into.appendChild(made.el)
    made.set(CONTENT)
    return made
  }
  const box = (made: MapKey, which: 'lo' | 'hi'): HTMLInputElement | null =>
    made.el.querySelector<HTMLInputElement>(`.is-${which} input`)

  it('goes from the low end to the high, taking the low', () => {
    const changes: Array<[string, number | null]> = []
    const made = key(changes)
    made.edit('lo')
    const lo = box(made, 'lo') as HTMLInputElement
    lo.value = '-3.5'
    expect(press(lo, 'Tab').defaultPrevented).toBe(true)
    expect(changes).toEqual([['lo', -3.5]])
    expect(box(made, 'lo')).toBeNull()
    expect(document.activeElement).toBe(box(made, 'hi'))
  })

  it('fixes nothing on an end tabbed through untouched', () => {
    const changes: Array<[string, number | null]> = []
    const made = key(changes)
    made.edit('lo')
    press(box(made, 'lo') as HTMLInputElement, 'Tab')
    press(box(made, 'hi') as HTMLInputElement, 'Tab', { shiftKey: true })
    expect(changes).toEqual([])
    expect(document.activeElement).toBe(box(made, 'lo'))
  })

  it('lets the caret go past a lone map’s ends', () => {
    const changes: Array<[string, number | null]> = []
    const made = key(changes)
    made.edit('hi')
    press(box(made, 'hi') as HTMLInputElement, 'Tab')
    expect(box(made, 'hi')).toBeNull()
    expect(box(made, 'lo')).toBeNull()
  })

  it('goes on to the next map’s key in a deck, in the order its cells are on the page', () => {
    const changes: Array<[string, number | null]> = []
    const deck = el('div', { class: 'deck-grid' })
    document.body.appendChild(deck)
    const first = key(changes, deck)
    const second = key(changes, deck)
    // The second file's key in a comparison, which is not the reader's to set.
    const fixed = new MapKey()
    deck.insertBefore(fixed.el, second.el)
    first.edit('hi')
    press(box(first, 'hi') as HTMLInputElement, 'Tab')
    expect(document.activeElement).toBe(box(second, 'lo'))
    press(box(second, 'lo') as HTMLInputElement, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(box(first, 'hi'))
  })
})

describe('the tabs’ names', () => {
  function strip(tabs: Array<Partial<TabSpec>>): { strip: TabStrip; renames: Array<[number, string]> } {
    const renames: Array<[number, string]> = []
    const made = new TabStrip({
      onSelect: () => undefined,
      onClose: () => undefined,
      onNew: () => undefined,
      onRename: (index, name) => renames.push([index, name]),
    })
    document.body.append(made.el)
    made.render(
      tabs.map((spec, index) => ({
        id: spec.id ?? `s${index + 1}`,
        label: spec.label ?? 'yeast.cool',
        hint: '',
        nameable: spec.nameable ?? true,
        named: false,
        active: index === 0,
        pending: false,
      })),
      true,
    )
    return { strip: made, renames }
  }
  const box = (made: TabStrip): HTMLInputElement | null => made.el.querySelector<HTMLInputElement>('.tab-rename')

  it('names the next tab that can be named, taking this one', () => {
    const { strip: made, renames } = strip([{ id: 'a' }, { id: 'b', nameable: false }, { id: 'c' }])
    made.beginRename('a')
    const first = box(made) as HTMLInputElement
    first.value = 'G1'
    press(first, 'Tab')
    expect(renames).toEqual([[0, 'G1']])
    const next = box(made) as HTMLInputElement
    expect(next).not.toBeNull()
    expect(document.activeElement).toBe(next)
    // On the third tab, the second not being one a name can be given.
    const tabs = [...made.el.querySelectorAll('.tab-rename, .tab-label')]
    expect(tabs.indexOf(next)).toBe(2)
  })

  it('lets the caret go past the last', () => {
    const { strip: made, renames } = strip([{ id: 'a' }, { id: 'b' }])
    made.beginRename('b')
    const last = box(made) as HTMLInputElement
    last.value = 'G2M'
    press(last, 'Tab')
    expect(renames).toEqual([[1, 'G2M']])
    expect(box(made)).toBeNull()
  })
})

describe('a field that walks Tab itself, in a dialog', () => {
  it('is not answered by the dialog’s own wrap first', () => {
    const walked = vi.fn()
    const field = el('input', { type: 'text', attrs: { [TAB_WALKS]: '' } })
    field.addEventListener('keydown', (event) => {
      if (tabStep(event) !== null) walked()
    })
    const modal = new Modal({ title: 'Rename', body: () => el('div', {}, el('button', { text: 'Run' }), field) })
    try {
      field.focus()
      // The field is the dialog's last stop, where the trap would wrap.
      press(field, 'Tab')
      expect(walked).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(field)
    } finally {
      modal.close()
    }
  })
})

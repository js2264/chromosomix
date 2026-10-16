// @vitest-environment jsdom
/**
 * The Manual annotations card (§8.1), and the two gestures it asks the map for.
 *
 * A line and an arrowhead are each *a place*, and the gesture for a place is a
 * click. A rectangle is *an extent*, and the gesture for an extent is a drag —
 * press at one corner, let go at the other, which is what a hand does to draw a
 * box. What is worth asserting here is that each form asks for the right one and
 * makes the right mark of what comes back, since a form that asked for clicks
 * while the map was waiting for a drag would be a mode that swallowed
 * everything and produced nothing.
 *
 * The picker is a stand-in for the mounted plot, which is what the card talks to
 * in the app: it takes the handlers the form hands over and is the same object a
 * whole deck of maps is armed through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ManualStore,
  type ManualMark,
  type ManualPoint,
  type ManualRect,
  type ManualSpan,
} from '@/annotations/manual'
import type { PickHandlers } from '@/ui/mapPick'
import { ManualCard, type MapPicker } from '@/ui/ManualCard'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
})

afterEach(() => {
  teardown()
  window.sessionStorage.clear()
})

/** A click on the map, as the panel reports one: a locus on each axis. */
const cell = (row: number, col: number, contig = 'I'): { rows: ManualPoint; cols: ManualPoint } => ({
  rows: { contig, bp: row },
  cols: { contig, bp: col },
})

/** A drag on the map, as the panel reports one: a stretch on each axis. */
const drawn = (
  rows: [number, number],
  cols: [number, number],
  contig = 'I',
): { rows: ManualSpan; cols: ManualSpan } => ({
  rows: { contig, from: rows[0], to: rows[1] },
  cols: { contig, from: cols[0], to: cols[1] },
})

interface Mounted {
  store: ManualStore
  /** The form with this title, which is where its own controls are. */
  form(title: string): HTMLElement
  press(title: string, label: string): void
  type(title: string, values: [string, string?]): void
  /** Click the plot, as the armed mode sees it. */
  click(at: { rows: ManualPoint; cols: ManualPoint }): void
  /** Drag a box out on the plot, as the armed mode sees it. */
  draw(at: { rows: ManualSpan; cols: ManualSpan }): void
  /** What the armed mode is listening for, which is what the form asked for. */
  listening(): Array<'point' | 'box'>
  /** End the mode the way the plot does — Escape, or a torn-down view. */
  endMode(): void
  bad(title: string): boolean[]
  armed(title: string): boolean
}

function mount(): Mounted {
  const store = new ManualStore(`card-${Math.random()}.cool`)
  let live: { handlers: PickHandlers; onEnd: () => void } | null = null
  const picker: MapPicker = {
    available: () => true,
    start: (handlers, onEnd) => {
      live?.onEnd()
      live = { handlers, onEnd }
      return () => {
        const mode = live
        live = null
        mode?.onEnd()
      }
    },
  }
  const card = new ManualCard({ store, picker, fileLabel: 'yeast.cool' })
  document.body.appendChild(card.el)

  const form = (title: string): HTMLElement => {
    const node = Array.from(card.el.querySelectorAll<HTMLElement>('.manual-form')).find(
      (candidate) => candidate.querySelector('.manual-form-title')?.textContent === title,
    )
    if (node === undefined) throw new Error(`no form called ${title}`)
    return node
  }
  const boxes = (title: string): HTMLInputElement[] =>
    Array.from(form(title).querySelectorAll<HTMLInputElement>('input[type=text]'))

  return {
    store,
    form,
    press: (title, label) => {
      const node = Array.from(form(title).querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label,
      )
      if (node === undefined) throw new Error(`no button called ${label} in ${title}`)
      node.click()
    },
    type: (title, [first, second]) => {
      const [one, two] = boxes(title)
      one.value = first
      if (second !== undefined) two.value = second
    },
    click: (at) => {
      if (live === null) throw new Error('no picking mode is armed')
      live.handlers.point?.(at)
    },
    draw: (at) => {
      if (live === null) throw new Error('no picking mode is armed')
      live.handlers.box?.(at)
    },
    listening: () => {
      if (live === null) throw new Error('no picking mode is armed')
      return (['point', 'box'] as const).filter((key) => live?.handlers[key] !== undefined)
    },
    endMode: () => {
      const mode = live
      live = null
      mode?.onEnd()
    },
      bad: (title) => boxes(title).map((box) => box.classList.contains('is-bad')),
    armed: (title) =>
      Array.from(form(title).querySelectorAll('button')).some((button) =>
        button.classList.contains('is-armed'),
      ),
  }
}

describe('typing a rectangle', () => {
  it('takes an interval per axis, at any ratio', () => {
    const card = mount()
    // 1-based and inclusive, as every locus box reads one (§26.1).
    card.type('Rectangles', ['I:120,001-180,000', 'IV:340001-1000000'])
    card.press('Rectangles', 'add')
    expect(card.store.rects).toHaveLength(1)
    expect(card.store.rects[0]).toMatchObject({
      a: { contig: 'I', from: 120_000, to: 180_000 },
      b: { contig: 'IV', from: 340_000, to: 1_000_000 },
    })
  })

  it('reads an empty second box as the same stretch on both axes', () => {
    // The box on the diagonal — a domain — which is not worth typing twice, the
    // same courtesy the arrowhead form does for a cell on it.
    const card = mount()
    card.type('Rectangles', ['I:120000-180000'])
    card.press('Rectangles', 'add')
    const rect = card.store.rects[0]
    expect(rect.a).toEqual(rect.b)
  })

  it('marks what it cannot read and draws nothing', () => {
    const card = mount()
    // A point is not a box: one coordinate leaves the second corner unsaid.
    card.type('Rectangles', ['I:120000', 'IV:340000-400000'])
    card.press('Rectangles', 'add')
    expect(card.store.rects).toHaveLength(0)
    expect(card.bad('Rectangles')).toEqual([true, false])
  })
})

describe('drawing a rectangle on the map', () => {
  it('asks the map for a drag rather than for clicks', () => {
    // Which is the whole difference between this form and the two above it: a
    // box is an extent, and an extent is one press and one release.
    const card = mount()
    card.press('Rectangles', 'draw on map')
    expect(card.listening()).toEqual(['box'])
    card.press('Lines', 'pick on map')
    expect(card.listening()).toEqual(['point'])
  })

  it('makes one box of one drag, both axes as drawn', () => {
    const card = mount()
    card.press('Rectangles', 'draw on map')
    card.draw(drawn([120_000, 180_000], [340_000, 400_000]))
    expect(card.store.rects).toHaveLength(1)
    expect(card.store.rects[0]).toMatchObject({
      a: { contig: 'I', from: 120_000, to: 180_000 },
      b: { contig: 'I', from: 340_000, to: 400_000 },
    })
    // Ready for the next box rather than done: marking up a figure is several.
    expect(card.armed('Rectangles')).toBe(true)
  })

  it('stays on for as many boxes as the reader draws', () => {
    const card = mount()
    card.press('Rectangles', 'draw on map')
    card.draw(drawn([1_000, 2_000], [1_000, 2_000]))
    card.draw(drawn([3_000, 4_000], [9_000, 9_500]))
    expect(card.store.rects).toHaveLength(2)
    expect(card.armed('Rectangles')).toBe(true)
  })

  it('takes a box across two sequences, which the map can hand it', () => {
    // A drag over the trans corner of a whole-genome view names two different
    // sequences, one per axis, and that is a rectangle like any other — the two
    // sides of a box were never required to be the same sequence.
    const card = mount()
    card.press('Rectangles', 'draw on map')
    card.draw({
      rows: { contig: 'I', from: 120_000, to: 180_000 },
      cols: { contig: 'IV', from: 340_000, to: 400_000 },
    })
    expect(card.store.rects[0]).toMatchObject({
      a: { contig: 'I' },
      b: { contig: 'IV' },
    })
  })

  it('places nothing on a click, since a click is not a box', () => {
    const card = mount()
    card.press('Rectangles', 'draw on map')
    card.click(cell(120_000, 340_000))
    expect(card.store.marks).toHaveLength(0)
  })

  it('gives the button back however the mode ends', () => {
    const card = mount()
    card.press('Rectangles', 'draw on map')
    expect(card.armed('Rectangles')).toBe(true)
    card.endMode()
    expect(card.armed('Rectangles')).toBe(false)

    // And arming another form ends this one, the map having only one mode.
    card.press('Rectangles', 'draw on map')
    card.press('Arrowheads', 'pick on map')
    expect(card.armed('Rectangles')).toBe(false)
    expect(card.armed('Arrowheads')).toBe(true)
    card.click(cell(120_000, 340_000))
    expect(card.store.arrowheads).toHaveLength(1)
  })
})

describe('the list', () => {
  // Grouped digits, which is what every other coordinate on screen wears
  // (§26.1) — and what the boxes above take back, since they accept commas. The
  // rows wrote the ungrouped form their own inputs *emit*, which made this card
  // the one place a locus appeared without separators, under placeholders that
  // had them.
  it('writes a box as the reader reads it, which its own form takes back', () => {
    const card = mount()
    card.type('Rectangles', ['I:120001-180000', 'IV:340001-400000'])
    card.press('Rectangles', 'add')
    card.type('Rectangles', ['I:500001-600000'])
    card.press('Rectangles', 'add')
    const rows = Array.from(document.querySelectorAll('.manual-where')).map(
      (node) => node.textContent ?? '',
    )
    // 1-based, as typed: the row says the bases the reader named.
    expect(rows[0]).toBe('▭ I:120,001-180,000 × IV:340,001-400,000')
    // One extent for a box on the diagonal, which is what its form takes back.
    expect(rows[1]).toBe('▭ I:500,001-600,000')
  })

  it('writes a box drawn on the map 1-based, as the breadcrumb writes that window', () => {
    // A drag hands the card cooler's numbers — the half-open stretch of whole
    // bins — and the row is what a reader reads, so it is the display form.
    const card = mount()
    card.store.add({
      id: 'm1',
      kind: 'rect',
      a: { contig: 'I', from: 120_000, to: 180_000 },
      b: { contig: 'I', from: 120_000, to: 180_000 },
      colour: '#000',
    })
    expect(document.querySelector('.manual-where')?.textContent).toBe('▭ I:120,001-180,000')
  })

  it('recolours and removes a box like any other mark', () => {
    const card = mount()
    card.type('Rectangles', ['I:120000-180000'])
    card.press('Rectangles', 'add')
    const rect: ManualRect = card.store.rects[0]
    card.store.update(rect.id, { colour: '#123456' })
    expect(card.store.rects[0].colour).toBe('#123456')
    card.store.remove(rect.id)
    expect(card.store.marks).toHaveLength(0)
  })
})

describe('editing a mark in its row (§8.1)', () => {
  const press = (key: string): void => {
    const box = document.activeElement
    box?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }

  it('moves a box in place — its colour, its id and its place in the list kept', () => {
    const card = mount()
    card.type('Rectangles', ['I:120001-180000'])
    card.press('Rectangles', 'add')
    card.type('Rectangles', ['I:500001-600000'])
    card.press('Rectangles', 'add')
    const first = card.store.rects[0]
    card.store.update(first.id, { colour: '#123456' })
    document.querySelector<HTMLButtonElement>('.manual-where')?.click()
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('.manual-edit-box'))
    // The row's own grouped form, ready to be changed.
    expect(boxes.map((box) => box.value)).toEqual(['I:120,001-180,000', 'I:120,001-180,000'])
    boxes[0].value = 'I:130,001-190,000'
    boxes[1].value = ''
    press('Enter')
    const moved = card.store.rects[0]
    expect(moved.id).toBe(first.id)
    expect(moved.colour).toBe('#123456')
    // An empty second box is the same stretch on both axes, as in the form.
    expect(moved.a).toEqual({ contig: 'I', from: 130000, to: 190000 })
    expect(moved.b).toEqual({ contig: 'I', from: 130000, to: 190000 })
    expect(card.store.rects[1].a.from).toBe(500000)
    expect(document.querySelector('.manual-where')?.textContent).toBe('▭ I:130,001-190,000')
  })

  it('moves one mark and goes on to the next with Tab off its last box, back with Shift+Tab (§26.8)', () => {
    const card = mount()
    card.type('Rectangles', ['I:120001-180000'])
    card.press('Rectangles', 'add')
    card.type('Rectangles', ['I:500001-600000'])
    card.press('Rectangles', 'add')
    document.querySelector<HTMLButtonElement>('.manual-where')?.click()
    const [rows, columns] = Array.from(document.querySelectorAll<HTMLInputElement>('.manual-edit-box'))
    rows.value = 'I:130,001-190,000'
    columns.value = ''
    // Between the mark's own boxes, Tab is the page's.
    rows.focus()
    const inside = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    rows.dispatchEvent(inside)
    expect(inside.defaultPrevented).toBe(false)
    columns.focus()
    columns.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    // The first mark moved, and the second's boxes are open with the caret in the first.
    expect(card.store.rects[0].a).toEqual({ contig: 'I', from: 130000, to: 190000 })
    const next = Array.from(document.querySelectorAll<HTMLInputElement>('.manual-edit-box'))
    expect(next.map((box) => box.value)).toEqual(['I:500,001-600,000', 'I:500,001-600,000'])
    expect(document.activeElement).toBe(next[0])
    // Back to the first mark, its last box.
    next[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    const back = Array.from(document.querySelectorAll<HTMLInputElement>('.manual-edit-box'))
    expect(back.map((box) => box.value)).toEqual(['I:130,001-190,000', 'I:130,001-190,000'])
    expect(document.activeElement).toBe(back[1])
  })

  it('keeps the boxes open on a place that does not read, Tab or no Tab', () => {
    const card = mount()
    card.type('Rectangles', ['I:120001-180000'])
    card.press('Rectangles', 'add')
    card.type('Rectangles', ['I:500001-600000'])
    card.press('Rectangles', 'add')
    document.querySelector<HTMLButtonElement>('.manual-where')?.click()
    const [rows, columns] = Array.from(document.querySelectorAll<HTMLInputElement>('.manual-edit-box'))
    rows.value = 'nowhere'
    columns.focus()
    columns.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(rows.isConnected).toBe(true)
    expect(rows.classList.contains('is-bad')).toBe(true)
    expect(card.store.rects[0].a.from).toBe(120000)
  })

  // THE LAW (§26.1): Enter on what the row's boxes already show moves nothing.
  it('leaves a mark exactly where it was when its own text is entered back', () => {
    const card = mount()
    card.store.add({
      id: 'm1',
      kind: 'rect',
      a: { contig: 'I', from: 120_000, to: 180_000 },
      b: { contig: 'IV', from: 340_000, to: 400_000 },
      colour: '#000',
    })
    card.store.add({ id: 'm2', kind: 'line', axis: 'vertical', at: { contig: 'IV', bp: 1_162_000 }, colour: '#000' })
    const before = card.store.marks.map((mark) => JSON.stringify(mark))
    const reshaped = vi.spyOn(card.store, 'reshape')
    for (let at = 0; at < 2; at++) {
      // Asked for afresh each time: a commit repaints the list.
      document.querySelectorAll<HTMLButtonElement>('.manual-where')[at]?.click()
      document.querySelector<HTMLInputElement>('.manual-edit-box')?.focus()
      press('Enter')
    }
    // Both rows were committed, not merely closed — and nothing moved.
    expect(reshaped).toHaveBeenCalledTimes(2)
    expect(card.store.marks.map((mark) => JSON.stringify(mark))).toEqual(before)
  })

  it('changes a line’s place and which rule it draws', () => {
    const card = mount()
    card.type('Lines', ['IV:1,200,001'])
    card.press('Lines', 'add')
    document.querySelector<HTMLButtonElement>('.manual-where')?.click()
    const axis = document.querySelector<HTMLSelectElement>('.manual-edit-axis')
    axis!.value = 'both'
    const box = document.querySelector<HTMLInputElement>('.manual-edit-box')
    // The row's own text, 1-based, and the base it names is kept 0-based.
    expect(box!.value).toBe('IV:1,200,001')
    box!.value = 'IV:1.25 Mb'
    box!.focus()
    press('Enter')
    expect(card.store.lines[0].at).toEqual({ contig: 'IV', bp: 1_249_999 })
    expect(card.store.lines[0].axis).toBe('both')
  })

  it('keeps a box it cannot read open and red, and Escape leaves the mark where it was', () => {
    const card = mount()
    card.type('Lines', ['IV:1,200,001'])
    card.press('Lines', 'add')
    document.querySelector<HTMLButtonElement>('.manual-where')?.click()
    const box = document.querySelector<HTMLInputElement>('.manual-edit-box')
    box!.value = 'nowhere'
    press('Enter')
    expect(box!.classList.contains('is-bad')).toBe(true)
    expect(document.querySelector('.manual-edit')).not.toBeNull()
    press('Escape')
    expect(document.querySelector('.manual-edit')).toBeNull()
    expect(card.store.lines[0].at).toEqual({ contig: 'IV', bp: 1200000 })
  })
})

describe('importing', () => {
  it('takes a BEDPE dropped anywhere on the card and says what it added', async () => {
    const card = mount()
    const file = new File(['I\t1000\t1001\tIV\t2000\t2001\tm9\t0\t.\t.\n'], 'marks.bedpe')
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], items: [], types: ['Files'] } })
    card.form('Rectangles').dispatchEvent(drop)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(card.store.arrowheads).toHaveLength(1)
    expect(card.form('Import').querySelector('.ann-note')?.textContent).toBe(
      'marks.bedpe: 1 added.',
    )
  })
})

describe('hiding and showing marks (§8.1)', () => {
  const line = (id: string, bp: number): ManualMark => ({
    id,
    kind: 'line',
    axis: 'vertical',
    at: { contig: 'I', bp },
    colour: '#111318',
  })
  const box = (id: string): ManualMark => ({
    id,
    kind: 'rect',
    a: { contig: 'I', from: 120_000, to: 180_000 },
    b: { contig: 'I', from: 120_000, to: 180_000 },
    colour: '#c0392b',
  })
  const eyes = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('.manual-mark .ann-eye'))
  const allEye = (): HTMLButtonElement => {
    const node = document.querySelector<HTMLButtonElement>('.manual-all-eye')
    if (node === null) throw new Error('no eye over the list')
    return node
  }
  const note = (): string => document.querySelector('.manual-list-note')?.textContent ?? ''
  const drawn = (store: ManualStore): string[] => store.shown.map((mark) => mark.id)

  it('heads the list only once there is a mark to hide', () => {
    const card = mount()
    expect(document.querySelector('.manual-list-head')).toBeNull()
    card.store.add(line('k1', 1_000))
    expect(document.querySelector('.manual-list-head')).not.toBeNull()
  })

  it('puts an eye on every row, lit while its mark is drawn, that hides it on every picture', () => {
    const card = mount()
    card.store.add(line('k1', 1_000))
    card.store.add(box('k2'))
    expect(eyes().map((eye) => eye.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
    const first = eyes()[0]
    first.focus()
    first.click()
    // Off the drawn lists every picture paints from, kept on the card's own.
    expect(card.store.lines).toHaveLength(0)
    expect(card.store.marks[0].hidden).toBe('own')
    // The same button, repainted where it stands: the hand and the focus stay on it.
    expect(eyes()[0]).toBe(first)
    expect(document.activeElement).toBe(first)
    expect(first.getAttribute('aria-pressed')).toBe('false')
    expect(first.title).toMatch(/^Show this mark again/)
    expect(note()).toBe('1 of 2 hidden')
    first.click()
    expect(drawn(card.store)).toEqual(['k1', 'k2'])
    expect(note()).toBe('')
  })

  it('hides every mark from the eye over the list, and brings back only the ones it hid', () => {
    const card = mount()
    for (const mark of [line('k1', 1_000), line('k2', 2_000), box('k3')]) card.store.add(mark)
    eyes()[1].click()
    expect(allEye().getAttribute('aria-pressed')).toBe('true')
    expect(allEye().title).toMatch(/^Hide every mark.*\(A\)$/)
    allEye().click()
    expect(drawn(card.store)).toEqual([])
    expect(note()).toBe('all 3 hidden')
    expect(allEye().getAttribute('aria-pressed')).toBe('false')
    expect(eyes().map((eye) => eye.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false'])
    allEye().click()
    // The line hidden from its own row before stays hidden.
    expect(drawn(card.store)).toEqual(['k1', 'k3'])
    expect(note()).toBe('1 of 3 hidden')
  })

  it('shows one mark alone on a double-click on its eye, and the rest back on a second', () => {
    const card = mount()
    for (const mark of [line('k1', 1_000), line('k2', 2_000), box('k3')]) card.store.add(mark)
    const doubleClick = (eye: HTMLButtonElement): void => {
      // As a browser sends one: two clicks, then the double-click.
      eye.click()
      eye.click()
      eye.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    }
    doubleClick(eyes()[2])
    expect(drawn(card.store)).toEqual(['k3'])
    expect(note()).toBe('2 of 3 hidden')
    doubleClick(eyes()[2])
    expect(drawn(card.store)).toEqual(['k1', 'k2', 'k3'])
  })

  it('writes the hidden marks with the rest, and says how many of them are hidden', () => {
    const card = mount()
    card.store.add(line('k1', 1_000))
    card.store.add(line('k2', 2_000))
    eyes()[0].click()
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('.manual-export button')).find((node) =>
      node.title.startsWith('Write'),
    )
    expect(save?.title).toMatch(/^Write 2 to a file .*, the 1 hidden among them$/)
  })
})

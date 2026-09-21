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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ManualStore,
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
    card.type('Rectangles', ['I:120000-180000', 'IV:340000-1000000'])
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
    card.type('Rectangles', ['I:120000-180000', 'IV:340000-400000'])
    card.press('Rectangles', 'add')
    card.type('Rectangles', ['I:500000-600000'])
    card.press('Rectangles', 'add')
    const rows = Array.from(document.querySelectorAll('.manual-where')).map(
      (node) => node.textContent ?? '',
    )
    expect(rows[0]).toBe('▭ I:120,000-180,000 × IV:340,000-400,000')
    // One extent for a box on the diagonal, which is what its form takes back.
    expect(rows[1]).toBe('▭ I:500,000-600,000')
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

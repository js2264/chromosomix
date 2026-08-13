// @vitest-environment jsdom
/**
 * The Manual annotations card (§8.1), and the box that takes two clicks.
 *
 * A line and an arrowhead are each one gesture — one coordinate typed, or one
 * cell clicked — and the card's own state is nothing between them. A rectangle
 * is the first mark here that is *two* of something, and everything worth
 * asserting follows from that: the mode has to survive between the clicks, say
 * which corner it is holding, refuse a pair it cannot make a box out of, and
 * forget the half-drawn one when it ends. A pending corner that outlived its
 * mode would draw a box to somewhere the reader pointed before they changed
 * their mind, and nothing on screen would say why.
 *
 * The picker is a stand-in for the mounted plot, which is what the card talks to
 * in the app: it hands back the two loci a click lands on, one per axis, and it
 * is the same object a whole deck of maps is armed through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ManualStore, type ManualPoint, type ManualRect } from '@/annotations/manual'
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

interface Mounted {
  store: ManualStore
  /** The form with this title, which is where its own controls are. */
  form(title: string): HTMLElement
  press(title: string, label: string): void
  type(title: string, values: [string, string?]): void
  /** Click the plot, as the armed mode sees it. */
  click(at: { rows: ManualPoint; cols: ManualPoint }): void
  /** End the mode the way the plot does — Escape, or a torn-down view. */
  endMode(): void
  hint(title: string): string
  bad(title: string): boolean[]
  armed(title: string): boolean
}

function mount(): Mounted {
  const store = new ManualStore(`card-${Math.random()}.cool`)
  let live: { onPoint: (point: { rows: ManualPoint; cols: ManualPoint }) => void; onEnd: () => void } | null = null
  const picker: MapPicker = {
    available: () => true,
    start: (onPoint, onEnd) => {
      live?.onEnd()
      live = { onPoint, onEnd }
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
      live.onPoint(at)
    },
    endMode: () => {
      const mode = live
      live = null
      mode?.onEnd()
    },
    hint: (title) => form(title).querySelector('.manual-hint')?.textContent ?? '',
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

describe('picking a rectangle on the map', () => {
  it('takes two clicks, and says which corner it is holding', () => {
    const card = mount()
    card.press('Rectangles', 'pick corners')
    card.click(cell(120_000, 340_000))
    // Nothing yet: half a box is a gesture in progress, not a mark, and a list
    // that flickered with one would be a list of things to un-place.
    expect(card.store.marks).toHaveLength(0)
    expect(card.hint('Rectangles')).toContain('I:120000')

    card.click(cell(180_000, 400_000))
    expect(card.store.rects).toHaveLength(1)
    expect(card.store.rects[0]).toMatchObject({
      a: { contig: 'I', from: 120_000, to: 180_000 },
      b: { contig: 'I', from: 340_000, to: 400_000 },
    })
    // Ready for the next box rather than done: marking up a figure is several.
    expect(card.hint('Rectangles')).toBe('')
    expect(card.armed('Rectangles')).toBe(true)
  })

  it('puts the corners in order, whichever one was clicked first', () => {
    const card = mount()
    card.press('Rectangles', 'pick corners')
    card.click(cell(180_000, 400_000))
    card.click(cell(120_000, 340_000))
    expect(card.store.rects[0]).toMatchObject({
      a: { contig: 'I', from: 120_000, to: 180_000 },
      b: { contig: 'I', from: 340_000, to: 400_000 },
    })
  })

  it('refuses two corners on different sequences, and keeps the first', () => {
    // A side of a box names one sequence, so a pair of corners in two different
    // blocks of a whole-genome view names four and is not a box at all.
    const card = mount()
    card.press('Rectangles', 'pick corners')
    card.click(cell(120_000, 340_000, 'I'))
    card.click(cell(180_000, 400_000, 'IV'))
    expect(card.store.marks).toHaveLength(0)
    expect(card.hint('Rectangles')).toContain('same pair of sequences')

    // The corner it already had is still the corner, so the second click is
    // simply the one that missed.
    card.click(cell(180_000, 400_000, 'I'))
    expect(card.store.rects).toHaveLength(1)
  })

  it('does not make a box out of one cell clicked twice', () => {
    const card = mount()
    card.press('Rectangles', 'pick corners')
    card.click(cell(120_000, 340_000))
    card.click(cell(120_000, 340_000))
    expect(card.store.marks).toHaveLength(0)
    card.click(cell(180_000, 400_000))
    expect(card.store.rects).toHaveLength(1)
  })

  it('forgets a half-drawn box when the mode ends', () => {
    const card = mount()
    card.press('Rectangles', 'pick corners')
    card.click(cell(120_000, 340_000))
    card.endMode()
    expect(card.hint('Rectangles')).toBe('')

    // Armed again, the next click is a *first* corner. Otherwise the box would
    // be drawn to somewhere the reader pointed before they changed their mind.
    card.press('Rectangles', 'pick corners')
    card.click(cell(500_000, 900_000))
    expect(card.store.marks).toHaveLength(0)
    expect(card.hint('Rectangles')).toContain('I:500000')
  })

  it('is ended by arming another kind, which the plot allows one of', () => {
    const card = mount()
    card.press('Rectangles', 'pick corners')
    card.click(cell(120_000, 340_000))
    card.press('Lines', 'pick on map')
    expect(card.hint('Rectangles')).toBe('')
    expect(card.armed('Rectangles')).toBe(false)

    // And the line mode is a line mode: one click, one mark.
    card.click(cell(120_000, 340_000))
    expect(card.store.lines).toHaveLength(1)
  })
})

describe('the list', () => {
  it('writes a box the way its own form would take it back', () => {
    const card = mount()
    card.type('Rectangles', ['I:120000-180000', 'IV:340000-400000'])
    card.press('Rectangles', 'add')
    card.type('Rectangles', ['I:500000-600000'])
    card.press('Rectangles', 'add')
    const rows = Array.from(document.querySelectorAll('.manual-where')).map(
      (node) => node.textContent ?? '',
    )
    expect(rows[0]).toBe('▭ I:120000-180000 × IV:340000-400000')
    // One extent for a box on the diagonal, which is what its form takes back.
    expect(rows[1]).toBe('▭ I:500000-600000')
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

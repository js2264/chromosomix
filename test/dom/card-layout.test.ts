// @vitest-environment jsdom
/**
 * Cards moved by their headings (`ui/cardLayout.ts`, §26.6).
 *
 * The drag itself is a gesture over laid-out boxes, which jsdom does not have;
 * `scripts/ui-cards.mjs` drives it in a browser. What is asserted here is the
 * part a gesture cannot show and a regression would hide: that the arrangement
 * **survives its builders**. Every column rebuilds its cards on its own schedule
 * — a new set on every navigation, the same set re-listed, a host refilled, a
 * tab's DOM swapped for another's — and after each of those the reader's
 * arrangement must be back, a card its builder let go must go, and a column
 * nobody touched must be exactly as its builder made it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CardArranger, cardsIn, homeParent, swapCard, type ArrangedColumn } from '@/ui/cardLayout'
import { cardTitle } from '@/ui/icons'

const KEY = 'chromosomix:card-layout'

/** A column as `SidePanel` makes one: a body, a session's host in it, a zone after. */
function column(id: string): ArrangedColumn & { host: HTMLElement; inner: HTMLElement } {
  const bodyEl = document.createElement('div')
  bodyEl.className = 'panel-column-body'
  const host = document.createElement('div')
  host.className = 'panel-host'
  const inner = document.createElement('aside')
  inner.className = 'side'
  host.append(inner)
  const zone = document.createElement('div')
  zone.className = 'card-zone'
  bodyEl.append(host, zone)
  document.body.append(bodyEl)
  return { id, bodyEl, zone, isOpen: true, host, inner }
}

function card(title: string): HTMLElement {
  const node = document.createElement('section')
  node.className = 'card'
  node.append(cardTitle(title, 'palette'), document.createElement('p'))
  return node
}

/** The headings a column shows, top to bottom. */
function shown(col: ArrangedColumn): string[] {
  return cardsIn(col.bodyEl).map((each) => each.querySelector('.card-head')?.textContent?.trim() ?? '')
}

/** Let the observer's pass run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let a: ReturnType<typeof column>
let b: ReturnType<typeof column>
let arranger: CardArranger
let changes: number

function arrange(): void {
  arranger = new CardArranger({ columns: () => [a, b], remembers: true, onChange: () => (changes += 1) })
}

beforeEach(() => {
  document.body.replaceChildren()
  window.localStorage.clear()
  changes = 0
  a = column('annotations')
  b = column('aesthetics')
  a.inner.append(card('Tracks'), card('Bookmarks'))
  b.inner.append(card('Export'), card('Map'))
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('a column nobody rearranged', () => {
  it('is left exactly as its builder made it', () => {
    const before = b.bodyEl.innerHTML
    arrange()
    expect(b.bodyEl.innerHTML).toBe(before)
    expect(b.bodyEl.classList.contains('is-arranged')).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
})

describe('a card placed by hand', () => {
  it('moves within its column, and the column remembers the whole order', () => {
    arrange()
    const exportCard = cardsIn(b.bodyEl)[0]!
    arranger.place(exportCard, 'aesthetics', 1)
    expect(shown(b)).toEqual(['Map', 'Export'])
    expect(b.bodyEl.classList.contains('is-arranged')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({
      v: 1,
      columns: { aesthetics: ['aesthetics/Map', 'aesthetics/Export'] },
    })
  })

  it('moves to another column, leaving its home spot held', () => {
    arrange()
    const bookmarks = cardsIn(a.bodyEl)[1]!
    arranger.place(bookmarks, 'aesthetics', 0)
    expect(shown(a)).toEqual(['Tracks'])
    expect(shown(b)).toEqual(['Bookmarks', 'Export', 'Map'])
    // Its builder's spot, still its own: a comment where it stood.
    expect(homeParent(bookmarks)).toBe(a.inner)
    expect(changes).toBe(1)
    expect(arranger.holdsForeign('aesthetics')).toBe(true)
  })

  it('comes back after a reload', () => {
    arrange()
    arranger.place(cardsIn(a.bodyEl)[1]!, 'aesthetics', 0)
    // A new page: new cards, the stored order read back.
    document.body.replaceChildren()
    a = column('annotations')
    b = column('aesthetics')
    a.inner.append(card('Tracks'), card('Bookmarks'))
    b.inner.append(card('Export'), card('Map'))
    arrange()
    expect(shown(a)).toEqual(['Tracks'])
    expect(shown(b)).toEqual(['Bookmarks', 'Export', 'Map'])
  })

  it('moves one place with ⌥↓ on its heading', () => {
    arrange()
    const head = cardsIn(b.bodyEl)[0]!.querySelector<HTMLElement>('.card-fold')!
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    expect(shown(b)).toEqual(['Map', 'Export'])
  })

  it('still folds when its heading is clicked', () => {
    arrange()
    const exportCard = cardsIn(b.bodyEl)[0]!
    exportCard.querySelector<HTMLElement>('.card-head')!.click()
    expect(exportCard.classList.contains('is-folded')).toBe(true)
  })
})

describe('an arrangement its builders rebuild under', () => {
  beforeEach(() => {
    arrange()
    arranger.place(cardsIn(a.bodyEl)[1]!, 'aesthetics', 0)
    arranger.place(cardsIn(b.bodyEl).find((each) => each.textContent?.includes('Export'))!, 'aesthetics', 2)
    expect(shown(b)).toEqual(['Bookmarks', 'Map', 'Export'])
  })

  it('is put back when a column is rebuilt with new cards', async () => {
    // A navigation: a new aside, new cards, in the builder's order.
    const side = document.createElement('aside')
    side.className = 'side'
    const fresh = [card('Export'), card('Map')]
    side.append(...fresh)
    b.host.replaceChildren(side)
    await settle()
    expect(shown(b)).toEqual(['Bookmarks', 'Map', 'Export'])
    // The new ones, not the old: the old are gone with their aside.
    expect(cardsIn(b.bodyEl).filter((each) => fresh.includes(each))).toHaveLength(2)
  })

  it('is put back when a column re-lists the same cards', async () => {
    const bookmarks = cardsIn(b.bodyEl)[0]!
    const tracks = cardsIn(a.bodyEl)[0]!
    a.inner.replaceChildren(tracks, bookmarks)
    await settle()
    expect(shown(a)).toEqual(['Tracks'])
    expect(shown(b)).toEqual(['Bookmarks', 'Map', 'Export'])
  })

  it('lets a card go when its builder rebuilds without it', async () => {
    const tracks = cardsIn(a.bodyEl)[0]!
    a.inner.replaceChildren(tracks)
    await settle()
    expect(shown(b)).toEqual(['Map', 'Export'])
    expect(changes).toBeGreaterThanOrEqual(2)
    expect(arranger.holdsForeign('aesthetics')).toBe(false)
  })

  it('puts a card that appears later after the one it follows at home', async () => {
    // Its builder puts it at the end of the aside, which is after the Map
    // card's home spot — so it goes after the Map card, wherever that is now.
    b.inner.append(card('3D structure'))
    await settle()
    expect(shown(b)).toEqual(['Bookmarks', 'Map', '3D structure', 'Export'])
  })

  it('keeps another tab’s cards out, and gives them back', async () => {
    // A tab switch: the session's host replaced by another's, the zone kept.
    const mine = b.host
    const theirs = document.createElement('div')
    theirs.className = 'panel-host'
    theirs.append(card('Export'))
    const annotationsMine = a.host
    const annotationsTheirs = document.createElement('div')
    annotationsTheirs.className = 'panel-host'
    b.bodyEl.replaceChildren(theirs, b.zone)
    a.bodyEl.replaceChildren(annotationsTheirs, a.zone)
    await settle()
    expect(shown(b)).toEqual(['Export'])
    // …and back.
    b.bodyEl.replaceChildren(mine, b.zone)
    a.bodyEl.replaceChildren(annotationsMine, a.zone)
    await settle()
    expect(shown(b)).toEqual(['Bookmarks', 'Map', 'Export'])
  })

  it('lets a builder swap a card that the reader moved', () => {
    const map = cardsIn(b.bodyEl).find((each) => each.textContent?.includes('Map'))!
    const companion = card('Map')
    expect(homeParent(map)).toBe(b.inner)
    swapCard(map, companion)
    arranger.arrange()
    expect(cardsIn(b.bodyEl)).toContain(companion)
    expect(cardsIn(b.bodyEl)).not.toContain(map)
    expect(shown(b)).toEqual(['Bookmarks', 'Map', 'Export'])
    expect(homeParent(companion)).toBe(b.inner)
    // …and back, as the star moving off does.
    swapCard(companion, map)
    arranger.arrange()
    expect(cardsIn(b.bodyEl)).toContain(map)
    expect(shown(b)).toEqual(['Bookmarks', 'Map', 'Export'])
  })

  it('is undone by a reset, card by card, into its builder’s places', () => {
    arranger.reset()
    expect(shown(a)).toEqual(['Tracks', 'Bookmarks'])
    expect(shown(b)).toEqual(['Export', 'Map'])
    expect(b.zone.children).toHaveLength(0)
    expect(b.bodyEl.classList.contains('is-arranged')).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(arranger.arranged).toBe(false)
  })
})

describe('an embed', () => {
  it('neither reads nor writes an arrangement', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, columns: { aesthetics: ['aesthetics/Map', 'aesthetics/Export'] } }))
    arranger = new CardArranger({ columns: () => [a, b], remembers: false })
    expect(shown(b)).toEqual(['Export', 'Map'])
    arranger.place(cardsIn(b.bodyEl)[0]!, 'aesthetics', 1)
    expect(shown(b)).toEqual(['Map', 'Export'])
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}').columns.aesthetics).toEqual(['aesthetics/Map', 'aesthetics/Export'])
  })
})

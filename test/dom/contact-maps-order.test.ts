// @vitest-environment jsdom
/**
 * The Contact maps card lists the maps in the grid's order, and moving a row up
 * or down it moves the map's cell (§16.9).
 *
 * The card listed the first map first whatever its cell's place, and its rows
 * could be carried onto the deck but not reordered among themselves — so the
 * order of a deck of eight maps was set one exchange of two cells at a time,
 * on the grid, with nothing on the card that listed them to say or change it.
 * A reorder on the card is an **insertion among the maps**: the fourth map
 * dragged to the top is first, not exchanged with the first, and a tracks cell,
 * a model or an empty cell keeps its seat while the maps move round it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CompareCard, LEAD_ROW, type DeckMapRow } from '@/ui/CompareCard'
import { PanelDeck } from '@/panels/PanelDeck'
import { LEAD_MAP } from '@/annotations/placement'
import type { MatrixPanel } from '@/ui/MatrixPanel'
import type { ViewState } from '@/types'
import { all, setUpDom, type DomTeardown } from '../support/dom'

class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function card(maps: DeckMapRow[], leadAt = 0) {
  const moves: Array<{ map: string; onto: string; after: boolean }> = []
  const held = new CompareCard({
    onOpen: () => undefined,
    onToggleShown: () => undefined,
    isShown: () => true,
    onClose: () => undefined,
    onSwap: () => undefined,
    primaryLabel: () => 'lead.cool',
    hasPrimary: () => true,
    deckMaps: () => maps,
    onToggleDeckMap: () => undefined,
    onCloseDeckMap: () => undefined,
    leadAt: () => leadAt,
    onReorderMap: (map, onto, after) => moves.push({ map, onto, after }),
  })
  document.body.append(held.el)
  return { card: held, moves }
}

function rowNames(held: CompareCard): string[] {
  return [...held.el.querySelectorAll('.compare-row')].map((row) => {
    const name = row.querySelector('.ann-name')
    return (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
  })
}

function rowOf(held: CompareCard, name: string): HTMLElement {
  const row = [...held.el.querySelectorAll<HTMLElement>('.compare-row')].find((node) => {
    const box = node.querySelector('.ann-name')
    return (box instanceof HTMLInputElement ? box.value : box?.textContent)?.trim() === name
  })
  if (row === undefined) throw new Error(`no row ${name}`)
  return row
}

/** A row's grip taken hold of and let go on another row, above or below its middle. */
function dragRow(from: HTMLElement, onto: HTMLElement, where: 'above' | 'below'): void {
  const data = new Map<string, string>()
  const transfer = {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    setDragImage: () => undefined,
    effectAllowed: 'copyMove',
    dropEffect: '',
  }
  // jsdom lays nothing out: the row answers a box forty pixels tall.
  onto.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) })
  const fire = (target: Element, type: string, clientY = 0): void => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    target.dispatchEvent(event)
  }
  const grip = from.querySelector('.compare-grip') as Element
  fire(grip, 'dragstart')
  const y = where === 'above' ? 105 : 135
  fire(onto, 'dragover', y)
  fire(onto, 'drop', y)
  fire(grip, 'dragend')
}

const MAPS: DeckMapRow[] = [
  { id: 'p1', label: 'rep2.cool', uri: 'rep2.cool' },
  { id: 'p2', label: 'rep3.cool', uri: 'rep3.cool' },
  { id: 'hidden-1', label: 'rep4.cool', uri: 'rep4.cool', shown: false },
]

describe('the Contact maps card’s order (§16.9)', () => {
  it('lists the first map where its cell stands, and the hidden maps after the shown', () => {
    expect(rowNames(card(MAPS).card)).toEqual(['lead.cool', 'rep2.cool', 'rep3.cool', 'rep4.cool'])
    expect(rowNames(card(MAPS, 1).card)).toEqual(['rep2.cool', 'lead.cool', 'rep3.cool', 'rep4.cool'])
    expect(rowNames(card(MAPS, 2).card)).toEqual(['rep2.cool', 'rep3.cool', 'lead.cool', 'rep4.cool'])
  })

  it('moves a map before the row it is dropped on above its middle, and after it below', () => {
    const { card: held, moves } = card(MAPS)
    dragRow(rowOf(held, 'rep3.cool'), rowOf(held, 'lead.cool'), 'above')
    dragRow(rowOf(held, 'lead.cool'), rowOf(held, 'rep3.cool'), 'below')
    expect(moves).toEqual([
      { map: 'p2', onto: LEAD_ROW, after: false },
      { map: LEAD_ROW, onto: 'p2', after: true },
    ])
  })

  it('marks where a row would land while it is carried', () => {
    const { card: held } = card(MAPS)
    const onto = rowOf(held, 'rep2.cool')
    onto.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) })
    const transfer = { setData: () => undefined, setDragImage: () => undefined, effectAllowed: 'copyMove', dropEffect: '' }
    const start = new window.Event('dragstart', { bubbles: true }) as DragEvent
    Object.defineProperty(start, 'dataTransfer', { value: transfer })
    rowOf(held, 'lead.cool').querySelector('.compare-grip')?.dispatchEvent(start)
    expect(rowOf(held, 'lead.cool').classList.contains('is-dragging')).toBe(true)
    const over = new window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 35 }) as DragEvent
    Object.defineProperty(over, 'dataTransfer', { value: transfer })
    onto.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(onto.classList.contains('drop-after')).toBe(true)
  })

  it('does not reorder a hidden map, which has no cell to move', () => {
    const { card: held, moves } = card(MAPS)
    dragRow(rowOf(held, 'rep4.cool'), rowOf(held, 'lead.cool'), 'above')
    dragRow(rowOf(held, 'rep2.cool'), rowOf(held, 'rep4.cool'), 'above')
    expect(moves).toEqual([])
  })

  it('moves a map up and down by the arrow keys on its grip, and not past either end', () => {
    const { card: held, moves } = card(MAPS)
    const key = (name: string, which: string): void => {
      rowOf(held, name)
        .querySelector('.compare-grip')
        ?.dispatchEvent(new window.KeyboardEvent('keydown', { key: which, bubbles: true }))
    }
    key('rep2.cool', 'ArrowUp')
    key('lead.cool', 'ArrowDown')
    key('lead.cool', 'ArrowUp')
    key('rep3.cool', 'ArrowDown')
    expect(moves).toEqual([
      { map: 'p1', onto: LEAD_ROW, after: false },
      { map: LEAD_ROW, onto: 'p1', after: true },
    ])
    // A grip the keyboard can reach, and one that says so.
    const grip = rowOf(held, 'rep2.cool').querySelector('.compare-grip')
    expect(grip?.getAttribute('tabindex')).toBe('0')
    expect(grip?.getAttribute('aria-label')).toContain('arrow keys')
  })
})

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

function leadPanel(): MatrixPanel {
  return {
    setViewportListener: () => {},
    setDeckExport: () => {},
    setCardFor: () => {},
    setLaneListener: () => {},
    setHoverListener: () => {},
    setLaneHoverListener: () => {},
    showLaneEcho: () => {},
    showLocusEcho: () => {},
    framedRanges: () => ({ rows: [], cols: [] }),
    turnReach: () => null,
    setLaneFloor: () => {},
    remeasure: () => {},
    bpPerCell: () => 1000,
    cellCount: () => ({ rows: 400, cols: 400 }),
    blockLevel: () => 'bin',
    blockSpan: () => ({ rows: 400_000, cols: 400_000, sequences: { rows: 1, cols: 1 } }),
    viewport: () => ({ rows: [0, 400], cols: [0, 400] }),
    get hasBlock(): boolean {
      return true
    },
    isTurned: () => false,
    showViewport: () => true,
    scale: () => ({ vmin: Number.NaN, vmax: Number.NaN, transform: 'log10', colormap: 'fall' }),
    shownScale: () => ({ vmin: -3, vmax: -1, transform: 'log10', colormap: 'fall' }),
    baseScale: () => undefined,
  } as unknown as MatrixPanel
}

function deckOf() {
  const published: Array<string | undefined> = []
  let moved = 0
  const deck = new PanelDeck({
    onMapsChange: (maps) => published.push(maps),
    memoryKey: () => 'contact-maps-order-test',
    leadName: () => 'lead.cool',
    leadLabel: () => 'lead.cool',
    onLeadShownChange: () => {
      moved++
    },
  })
  document.body.appendChild(deck.el)
  const view = document.createElement('div')
  view.appendChild(document.createElement('div')).className = 'view-head'
  deck.frame(view)
  deck.setLead(leadPanel())
  deck.apply({ uri: 'lead.cool', view: 'region', region: 'chr1' } as unknown as ViewState)
  return { deck, published, moved: () => moved }
}

/** The grid in reading order, each cell by its kind and a map by its file. */
function grid(deck: PanelDeck): string[] {
  return all<HTMLElement>(deck.el, '.deck-grid > .deck-panel').map((cell) => {
    if (cell.classList.contains('is-lead')) return 'lead'
    if (cell.classList.contains('deck-tracks')) return 'tracks'
    const name = cell.querySelector('.deck-name')
    return (name instanceof HTMLInputElement ? name.value : (name?.textContent ?? '')).trim()
  })
}

const remote = (name: string) => ({ kind: 'remote' as const, uri: `https://x.example.org/${name}` })

describe('moving a map from the card (§16.9)', () => {
  it('inserts it among the maps, and every other cell keeps its seat', () => {
    const { deck, published } = deckOf()
    deck.add(remote('rep2.cool'))
    deck.add({ kind: 'tracks' })
    deck.add(remote('rep3.cool'))
    deck.add(remote('rep4.cool'))
    expect(grid(deck)).toEqual(['lead', 'rep2.cool', 'tracks', 'rep3.cool', 'rep4.cool'])
    const rep4 = deck.companionMaps().find((map) => map.label === 'rep4.cool')?.id as string
    deck.moveMap(rep4, LEAD_MAP, false)
    // The fourth map is first; the others move down a seat, and the tracks cell
    // stays where it stood.
    expect(grid(deck)).toEqual(['rep4.cool', 'lead', 'tracks', 'rep2.cool', 'rep3.cool'])
    expect(published.at(-1)).toBe(
      'https://x.example.org/rep4.cool|tracks|https://x.example.org/rep2.cool|https://x.example.org/rep3.cool',
    )
    expect(deck.leadMapIndex).toBe(1)
  })

  it('moves the first map among the others, as a place in this session’s memory', () => {
    const { deck, published, moved } = deckOf()
    deck.add(remote('rep2.cool'))
    deck.add(remote('rep3.cool'))
    const before = published.length
    const rep3 = deck.companionMaps().find((map) => map.label === 'rep3.cool')?.id as string
    deck.moveMap(LEAD_MAP, rep3, true)
    expect(grid(deck)).toEqual(['rep2.cool', 'rep3.cool', 'lead'])
    expect(deck.leadMapIndex).toBe(2)
    // The companions' order did not move, so the link is left alone — and the
    // session is told, since its card lists the maps in the grid's order.
    expect(published.length).toBe(before)
    expect(moved()).toBe(1)
  })

  it('does nothing for a map dropped where it already stands', () => {
    const { deck, published, moved } = deckOf()
    deck.add(remote('rep2.cool'))
    const before = published.length
    const rep2 = deck.companionMaps()[0]?.id as string
    deck.moveMap(rep2, LEAD_MAP, true)
    deck.moveMap(LEAD_MAP, rep2, false)
    expect(grid(deck)).toEqual(['lead', 'rep2.cool'])
    expect(published.length).toBe(before)
    expect(moved()).toBe(0)
  })
})

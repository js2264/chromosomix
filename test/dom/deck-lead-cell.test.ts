// @vitest-environment jsdom
/**
 * The session's own cell is a cell like the others (§16.9): it has a grip and
 * moves by it, it takes another cell's drag, and it closes with a × — parked
 * out of sight rather than removed, because its view is what the rest of the
 * deck follows — and the deck's bar or its row's eye puts it back.
 *
 * It used to be cell 0 for good, with no grip and no ×: the session's view
 * re-parented into the grid, and "which file is this session of" is not a thing
 * a drag should change. Nor does a drag change it now — the session is of the
 * same file afterwards — and what a reader arranging a figure wanted was the
 * picture somewhere else, or gone: a model beside the map, or alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import { recall } from '@/state/UiMemory'
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
  // The lead's place is remembered per file, in `sessionStorage`, and every
  // deck below uses one key.
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

const KEY = 'deck-lead-test'

/** The least a lead can be for the deck to drive it: the calls it makes, answered. */
function leadPanel() {
  const state = { listened: 0, released: 0 }
  const panel = {
    setViewportListener: (listener: unknown) => {
      if (listener === null) state.released++
      else state.listened++
    },
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
  }
  return { panel: panel as unknown as MatrixPanel, state }
}

function make() {
  const published: Array<string | undefined> = []
  let shownChanges = 0
  const deck = new PanelDeck({
    onMapsChange: (maps) => published.push(maps),
    memoryKey: () => KEY,
    leadName: () => 'lead.cool',
    leadLabel: () => 'lead.cool',
    onLeadShownChange: () => {
      shownChanges++
    },
  })
  document.body.appendChild(deck.el)
  const view = document.createElement('div')
  view.appendChild(document.createElement('div')).className = 'view-head'
  deck.frame(view)
  const lead = leadPanel()
  deck.setLead(lead.panel)
  return { deck, published, lead, shownChanges: () => shownChanges }
}

function state(maps: string | undefined): ViewState {
  return { uri: 'lead.cool', view: 'region', region: 'chr1', ...(maps === undefined ? {} : { maps }) } as unknown as ViewState
}

/** The grid as a reader sees it: every cell on screen, in reading order, by kind. */
function onScreen(deck: PanelDeck): string[] {
  return all<HTMLElement>(deck.el, '.deck-grid > .deck-panel')
    .filter((cell) => !cell.classList.contains('is-parked'))
    .map((cell) =>
      cell.classList.contains('is-lead')
        ? 'lead'
        : cell.classList.contains('deck-structure')
          ? '3d'
          : cell.classList.contains('deck-tracks')
            ? 'tracks'
            : cell.classList.contains('is-vacant')
              ? 'empty'
              : 'map',
    )
}

function leadCell(deck: PanelDeck): HTMLElement {
  const cell = deck.el.querySelector<HTMLElement>('.deck-grid > .deck-panel.is-lead')
  if (cell === null) throw new Error('no lead cell')
  return cell
}

/** A cell's grip, taken hold of and dropped on another cell, as a browser fires it. */
function drag(grip: Element, onto: Element): void {
  const data = new Map<string, string>()
  const transfer = {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
  }
  const fire = (target: Element, type: string): void => {
    const event = new window.Event(type, { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    target.dispatchEvent(event)
  }
  fire(grip, 'dragstart')
  fire(onto, 'dragover')
  fire(onto, 'drop')
  fire(grip, 'dragend')
}

describe('the heading over the session’s own cell', () => {
  it('carries a grip, like every cell, and a × only while another cell is beside it', () => {
    const { deck } = make()
    const head = leadCell(deck).querySelector('.deck-head-lead')
    const grip = head?.querySelector<HTMLElement>('.deck-grip')
    expect(grip?.getAttribute('draggable')).toBe('true')
    expect(grip?.title).toContain('Drag to move lead.cool')
    const close = head?.querySelector<HTMLButtonElement>('.btn-close')
    // Alone, a × would close the deck down to nothing on screen.
    expect(close?.classList.contains('hidden')).toBe(true)
    deck.add({ kind: 'structure' })
    expect(close?.classList.contains('hidden')).toBe(false)
    expect(close?.title).toContain('Contact maps card')
  })

  it('names the first map by its name on its chain, not by a place it may have left', () => {
    const { deck } = make()
    const chain = leadCell(deck).querySelector<HTMLElement>('.deck-head-lead .deck-lock')
    expect(chain?.title).toBe('lead.cool is driving the deck. Click to move it on its own.')
  })
})

describe('moving the session’s own cell', () => {
  it('exchanges it with the cell its grip is dropped on', () => {
    const { deck, published } = make()
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'tracks' })
    expect(onScreen(deck)).toEqual(['lead', '3d', 'tracks'])
    const tracks = deck.el.querySelector('.deck-grid > .deck-tracks') as Element
    drag(leadCell(deck).querySelector('.deck-head-lead .deck-grip') as Element, tracks)
    expect(onScreen(deck)).toEqual(['tracks', '3d', 'lead'])
    // The companions' order moved, so the link says so.
    expect(published.at(-1)).toBe('tracks|3d')
  })

  it('leaves the link alone when only the lead moved among the others', () => {
    const { deck, published } = make()
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'tracks' })
    const before = published.length
    drag(
      leadCell(deck).querySelector('.deck-head-lead .deck-grip') as Element,
      deck.el.querySelector('.deck-grid > .deck-structure') as Element,
    )
    expect(onScreen(deck)).toEqual(['3d', 'lead', 'tracks'])
    // `maps` lists the companions, and theirs is still `3d|tracks`: where the
    // lead stands is this session's memory, as the column count is.
    expect(published.length).toBe(before)
    expect(recall(KEY, 'deck:lead')).toEqual({ at: 1, hidden: false })
  })

  it('takes another cell’s drag onto its own, which is the same exchange', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    const structure = deck.el.querySelector('.deck-grid > .deck-structure') as Element
    drag(structure.querySelector('.deck-grip') as Element, leadCell(deck))
    expect(onScreen(deck)).toEqual(['3d', 'lead'])
  })

  it('comes back where it was left, in the next deck of this file', () => {
    const first = make()
    first.deck.add({ kind: 'structure' })
    first.deck.add({ kind: 'tracks' })
    drag(
      leadCell(first.deck).querySelector('.deck-head-lead .deck-grip') as Element,
      first.deck.el.querySelector('.deck-grid > .deck-tracks') as Element,
    )
    first.deck.destroy()
    first.deck.el.remove()
    const second = make()
    second.deck.apply(state('tracks|3d'))
    expect(onScreen(second.deck)).toEqual(['tracks', '3d', 'lead'])
  })

  it('moves up with the grid when a cell before it closes', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'tracks' })
    drag(
      leadCell(deck).querySelector('.deck-head-lead .deck-grip') as Element,
      deck.el.querySelector('.deck-grid > .deck-tracks') as Element,
    )
    expect(onScreen(deck)).toEqual(['tracks', '3d', 'lead'])
    deck.el.querySelector<HTMLButtonElement>('.deck-grid > .deck-tracks .btn-close')?.click()
    expect(onScreen(deck)).toEqual(['3d', 'lead'])
  })

  it('keeps its row and column when the deck grows round it', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    drag(
      leadCell(deck).querySelector('.deck-head-lead .deck-grip') as Element,
      deck.el.querySelector('.deck-grid > .deck-structure') as Element,
    )
    // A row of two, the lead second; grown below, it is a 2 × 2 with the new
    // row under it — the lead still at the end of the first row.
    deck.grow('below')
    expect(onScreen(deck)).toEqual(['3d', 'lead', 'empty', 'empty'])
    expect(all(deck.el, '.deck-grid > .deck-panel')[1]?.classList.contains('is-lead')).toBe(true)
  })
})

describe('closing the session’s own cell', () => {
  it('parks it out of sight, keeps its view mounted and following, and offers it back in the bar', () => {
    const { deck, lead, shownChanges } = make()
    deck.add({ kind: 'structure' })
    leadCell(deck).querySelector<HTMLButtonElement>('.deck-head-lead .btn-close')?.click()
    expect(onScreen(deck)).toEqual(['3d'])
    expect(deck.leadShown).toBe(false)
    // Parked, not removed: still in the grid, where it is laid out and goes on
    // reporting the window the others follow.
    const cell = leadCell(deck)
    expect(cell.classList.contains('is-parked')).toBe(true)
    expect(cell.getAttribute('aria-hidden')).toBe('true')
    expect(cell.isConnected).toBe(true)
    expect(lead.state.released).toBe(0)
    expect(shownChanges()).toBe(1)
    // One cell on screen, and the grid knows it: the columns picker offers one.
    expect(all<HTMLOptionElement>(deck.el, '.deck-columns option').map((option) => option.value)).toEqual(['1'])
    expect(deck.el.querySelector('.deck-grid')?.classList.contains('is-alone')).toBe(true)
    const show = deck.el.querySelector<HTMLButtonElement>('.deck-show-lead')
    expect(show?.textContent).toBe('show lead.cool')
    show?.click()
    expect(onScreen(deck)).toEqual(['lead', '3d'])
    expect(deck.el.querySelector('.deck-show-lead')).toBeNull()
    expect(shownChanges()).toBe(2)
  })

  it('does not count a hidden map among the maps on screen', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(deck.el.querySelector('.deck-maps')?.textContent).toBe('2 maps')
    deck.hideLead()
    expect(deck.el.querySelector('.deck-maps')?.textContent).toBe('1 map')
  })

  it('hands the star to the first map still on screen', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(deck.starredMap).toBe('lead')
    deck.hideLead()
    const companion = deck.analysable()[0]?.map
    expect(companion).toBeDefined()
    expect(deck.starredMap).toBe(companion)
  })

  it('sends a star whose map closes to a map on screen, not back to the hidden one', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    deck.hideLead()
    const [first, second] = deck.analysable().map((held) => held.map)
    expect(deck.starredMap).toBe(first)
    all<HTMLButtonElement>(deck.el, '.deck-grid > .deck-panel:not(.is-lead) .deck-head .btn-close')[0]?.click()
    expect(deck.starredMap).toBe(second)
  })

  it('keeps the star where no other map is on screen to take it', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    deck.hideLead()
    expect(deck.starredMap).toBe('lead')
  })

  it('is refused while nothing else is in the deck', () => {
    const { deck } = make()
    deck.hideLead()
    expect(deck.leadShown).toBe(true)
    expect(onScreen(deck)).toEqual(['lead'])
  })

  it('comes back on its own when the last cell beside it goes', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    deck.hideLead()
    deck.hideStructure()
    expect(deck.leadShown).toBe(true)
    expect(leadCell(deck).classList.contains('is-parked')).toBe(false)
    // …and is remembered shown, so the next deck of this file does not open
    // with its first cell missing.
    expect(recall(KEY, 'deck:lead')).toEqual({ at: 0, hidden: false })
  })

  it('stays hidden across a reload of the same deck', () => {
    const first = make()
    first.deck.add({ kind: 'structure' })
    first.deck.hideLead()
    first.deck.destroy()
    first.deck.el.remove()
    const second = make()
    second.deck.apply(state('3d'))
    expect(onScreen(second.deck)).toEqual(['3d'])
    expect(second.deck.leadShown).toBe(false)
  })
})

/**
 * The first map's chain, kept as a companion's is (§16.3, §16.6): per file, in
 * the session's memory. A companion's has always been kept with its look; the
 * first map's started closed on every build of the deck, so a first map the
 * reader had set moving on its own came back driving the others.
 */
describe('the chain on the session’s own cell', () => {
  const chain = (deck: PanelDeck): HTMLButtonElement => {
    const node = leadCell(deck).querySelector<HTMLButtonElement>('.deck-head-lead .deck-lock')
    if (node === null) throw new Error('no chain on the lead’s heading')
    return node
  }

  it('stays open across a reload of the same deck', () => {
    const first = make()
    first.deck.add({ kind: 'structure' })
    chain(first.deck).click()
    expect(recall(KEY, 'deck:lead')).toEqual({ at: 0, hidden: false, locked: false })
    first.deck.destroy()
    first.deck.el.remove()
    const second = make()
    second.deck.apply(state('3d'))
    expect(chain(second.deck).getAttribute('aria-pressed')).toBe('false')
    expect(chain(second.deck).title).toBe('lead.cool is moving on its own. Click to put it back in step.')
  })

  it('is kept when the cell moves, and written no more once it is closed again', () => {
    const { deck } = make()
    deck.add({ kind: 'structure' })
    chain(deck).click()
    drag(
      leadCell(deck).querySelector('.deck-head-lead .deck-grip') as Element,
      deck.el.querySelector('.deck-grid > .deck-structure') as Element,
    )
    // One record, written whole: moving the cell does not forget its chain.
    expect(recall(KEY, 'deck:lead')).toEqual({ at: 1, hidden: false, locked: false })
    chain(deck).click()
    expect(recall(KEY, 'deck:lead')).toEqual({ at: 1, hidden: false })
  })
})

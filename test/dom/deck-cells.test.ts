// @vitest-environment jsdom

/**
 * A deck cell that is not a map (§25): the structure cell.
 *
 * What is asserted is the deck's side of the contract — the cell is built,
 * kept, counted and released like the maps around it, and the place a
 * pointer on it names reaches the maps — and the cell's own words when the
 * store has nothing for it. The picture itself is the GPU's and is not drawn
 * here: jsdom gives no WebGL context, which the cell says in its note, and
 * that sentence is asserted too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import { parseG3d } from '@/annotations/g3d'
import type { AnnotationEntry, AnnotationStyle } from '@/annotations/types'
import { defaultStyle } from '@/annotations/types'
import type { AnnotationStore } from '@/annotations/store'
import type { MatrixPanel } from '@/ui/MatrixPanel'
import type { LocusWindow } from '@/render/locus'
import { setHoverPlace } from '@/ui/hoverLocus'
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
  setHoverPlace(null)
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const G3D = Array.from({ length: 12 }, (_, i) => `chr1\t${i * 5000}\t${i * 0.9}\t${i * 0.4 - 1}\t${0.3 * i}`).join(
  '\n',
)

/** A store holding what the cell asks for: entries, a subscription, a restyle. */
function fakeStore(entries: AnnotationEntry[]) {
  const listeners = new Set<() => void>()
  const restyled: Array<{ id: string; patch: Partial<AnnotationStyle> }> = []
  const store = {
    entries,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    restyle: (id: string, patch: Partial<AnnotationStyle>) => {
      restyled.push({ id, patch })
    },
    notify: () => {
      for (const listener of listeners) listener()
    },
    restyled,
  }
  return store
}

function structureEntry(text = G3D): AnnotationEntry {
  return {
    id: 'a1',
    card: 'linear',
    kind: 'structure',
    label: 'model.g3d',
    source: { kind: 'detached', name: 'model.g3d' },
    status: 'ready',
    visible: true,
    placement: 'bottom',
    style: defaultStyle('structure', '#1f5fa9'),
    payload: { kind: 'features', data: parseG3d(text, 'model.g3d') },
  } as unknown as AnnotationEntry
}

/** A lead the deck can drive, with the two calls a structure cell reaches it by. */
function leadPanel() {
  const state = {
    viewport: null as ((rows: [number, number], cols: [number, number]) => void) | null,
    echoes: [] as Array<{ contig: string; bp: number } | null>,
    framed: 0,
  }
  const windows: { rows: LocusWindow[]; cols: LocusWindow[] } = {
    rows: [{ contig: 'chr1', start: 10000, end: 30000, unitFrom: 10, unitTo: 30 } as LocusWindow],
    cols: [{ contig: 'chr1', start: 10000, end: 30000, unitFrom: 10, unitTo: 30 } as LocusWindow],
  }
  const panel = {
    setViewportListener: (listener: typeof state.viewport) => {
      state.viewport = listener
    },
    setDeckExport: () => {},
    setLaneListener: () => {},
    setHoverListener: () => {},
    setLaneHoverListener: () => {},
    showLaneEcho: () => {},
    showLocusEcho: (locus: { contig: string; bp: number } | null) => {
      state.echoes.push(locus)
    },
    framedRanges: () => {
      state.framed++
      return windows
    },
    turnReach: () => null,
    setLaneFloor: () => {},
    remeasure: () => {},
    bpPerCell: () => 1000,
    cellCount: () => ({ rows: 400, cols: 400 }),
    blockLevel: () => 'bin',
    blockSpan: () => ({ rows: 400000, cols: 400000, sequences: { rows: 1, cols: 1 } }),
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

function make(store: ReturnType<typeof fakeStore> | undefined) {
  const published: Array<string | undefined> = []
  const went: Array<{ contig: string; start: number; end: number }> = []
  const dropped: string[] = []
  const deck = new PanelDeck({
    onMapsChange: (maps) => published.push(maps),
    memoryKey: () => 'deck-cells-test',
    leadName: () => 'lead.cool',
    leadLabel: () => 'lead.cool',
    structure: {
      store: () => store as unknown as AnnotationStore | undefined,
      onGoTo: (range) => went.push(range),
      onDrop: (file) => dropped.push(file.name),
      onDropUrl: (url) => dropped.push(url),
    },
  })
  document.body.appendChild(deck.el)
  const view = document.createElement('div')
  view.appendChild(document.createElement('div')).className = 'view-head'
  deck.frame(view)
  return { deck, published, went, dropped }
}

function state(maps: string | undefined): ViewState {
  return { uri: 'lead.cool', view: 'region', region: 'chr1', ...(maps === undefined ? {} : { maps }) } as unknown as ViewState
}

function structureCells(deck: PanelDeck): HTMLElement[] {
  return all<HTMLElement>(deck.el, '.deck-grid > .deck-structure')
}

// ---------------------------------------------------------------------------
// The deck's side
// ---------------------------------------------------------------------------

describe('a structure cell in the deck', () => {
  it('is added by the bar and written into the link as `3d`', () => {
    const { deck, published } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    expect(structureCells(deck)).toHaveLength(1)
    expect(published.at(-1)).toBe('3d')
  })

  it('is one per deck: a second press keeps the one there is, and the button says so', () => {
    const { deck, published } = make(fakeStore([structureEntry()]))
    const button = deck.el.querySelector<HTMLButtonElement>('.deck-add-structure')
    expect(button).not.toBeNull()
    expect(button?.disabled).toBe(false)
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'structure' })
    expect(structureCells(deck)).toHaveLength(1)
    expect(published).toEqual(['3d'])
    expect(deck.el.querySelector<HTMLButtonElement>('.deck-add-structure')?.disabled).toBe(true)
  })

  it('takes the first empty cell, as a map would', () => {
    const { deck, published } = make(fakeStore([structureEntry()]))
    deck.grow('beside')
    expect(all(deck.el, '.deck-grid > .deck-panel')).toHaveLength(2)
    deck.add({ kind: 'structure' })
    expect(all(deck.el, '.deck-grid > .deck-panel')).toHaveLength(2)
    expect(structureCells(deck)).toHaveLength(1)
    expect(published.at(-1)).toBe('3d')
  })

  it('is kept across a link that re-lists it, and released by one that does not', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.apply(state('https://x.example.org/b.cool|3d'))
    const [cell] = structureCells(deck)
    expect(cell).toBeDefined()
    deck.apply(state('3d|https://x.example.org/b.cool'))
    expect(structureCells(deck)[0]).toBe(cell)
    deck.apply(state('https://x.example.org/b.cool'))
    expect(structureCells(deck)).toHaveLength(0)
  })

  it('does not count as a file: it is not empty, and the maps share nothing with it', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const bar = deck.el.querySelector('.deck-bar')?.textContent ?? ''
    expect(bar).not.toMatch(/empty/)
  })

  it('closes from its own heading and leaves the link with no maps', () => {
    const { deck, published } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const close = structureCells(deck)[0]?.querySelector<HTMLButtonElement>('.btn-close')
    expect(close).not.toBeNull()
    close?.click()
    expect(structureCells(deck)).toHaveLength(0)
    expect(published.at(-1)).toBeUndefined()
  })

  it('is handed what the maps are looking at when it is built, and on every pan after', () => {
    const lead = leadPanel()
    const { deck } = make(fakeStore([structureEntry()]))
    deck.setLead(lead.panel)
    const before = lead.state.framed
    deck.add({ kind: 'structure' })
    expect(lead.state.framed).toBe(before + 1)
    lead.state.viewport?.([0, 100], [0, 100])
    expect(lead.state.framed).toBe(before + 2)
  })
})

describe('what the cell says', () => {
  it('names the row it draws, and says so when there is none', () => {
    const empty = fakeStore([])
    const { deck } = make(empty)
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    expect(cell?.querySelector<HTMLInputElement>('.deck-name')?.value).toBe('structure')
    expect(cell?.querySelector('.structure-note')?.textContent).toMatch(/No structure loaded/)
    // The row arrives.
    empty.entries.push(structureEntry())
    empty.notify()
    expect(cell?.querySelector<HTMLInputElement>('.deck-name')?.value).toBe('model.g3d')
  })

  it('reports a row that is still reading, or refused, in its own words', () => {
    const loading = { ...structureEntry(), status: 'loading', payload: undefined } as AnnotationEntry
    const store = fakeStore([loading])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const note = structureCells(deck)[0]?.querySelector('.structure-note')
    expect(note?.textContent).toMatch(/reading/)
    store.entries[0] = { ...structureEntry(), status: 'error', error: 'not a g3d' } as AnnotationEntry
    store.notify()
    expect(note?.textContent).toBe('not a g3d')
  })

  it('says where the GPU is missing, once the renderer has arrived', async () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    // The renderer is a dynamic import; give it a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const note = structureCells(deck)[0]?.querySelector('.structure-note')
    expect(note?.textContent).toMatch(/WebGL|renderer/)
  })

  it('offers the menu of how the model is drawn, writing through the store', () => {
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    cell?.querySelector<HTMLButtonElement>('.structure-menu-toggle')?.click()
    const menu = cell?.querySelector('.structure-menu')
    expect(menu?.classList.contains('hidden')).toBe(false)
    const select = menu?.querySelector<HTMLSelectElement>('select')
    expect(select).not.toBeNull()
    if (select === null || select === undefined) return
    select.value = select.options[select.options.length - 1]?.value ?? ''
    select.dispatchEvent(new Event('change'))
    expect(store.restyled.length).toBeGreaterThan(0)
    expect(store.restyled[0]?.id).toBe('a1')
    expect(store.restyled[0]?.patch.structure).toBeDefined()
  })
})

describe('the place a pointer on the cell names', () => {
  it('is echoed onto the lead as a mark on its axis, and cleared when the hand leaves', () => {
    const lead = leadPanel()
    const { deck } = make(fakeStore([structureEntry()]))
    deck.setLead(lead.panel)
    deck.add({ kind: 'structure' })
    setHoverPlace({ loci: [{ contig: 'chr1', bp: 12500 }], source: 'structure:p9' })
    expect(lead.state.echoes.at(-1)).toEqual({ contig: 'chr1', bp: 12500 })
    setHoverPlace(null)
    expect(lead.state.echoes.at(-1)).toBeNull()
  })

  it('leaves the maps alone for a pointer that is on a map already', () => {
    const lead = leadPanel()
    const { deck } = make(fakeStore([structureEntry()]))
    deck.setLead(lead.panel)
    deck.add({ kind: 'structure' })
    const before = lead.state.echoes.length
    setHoverPlace({ loci: [{ contig: 'chr1', bp: 500 }, { contig: 'chr1', bp: 900 }], source: 'map' })
    expect(lead.state.echoes.length).toBe(before)
  })
})

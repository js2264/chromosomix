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
import { AnnotationStore } from '@/annotations/store'
import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { assemblyOf } from '@/genome/assembly'
import type { TracksContext } from '@/panels/TracksPanel'
import type { AnnotationEntry, AnnotationStyle } from '@/annotations/types'
import { defaultStyle } from '@/annotations/types'
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
    /** Every stretch a tracks cell asked the lead to put on its column axis. */
    followed: [] as Array<{ contig: string; start: number; end: number }>,
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
    showLocusOnColumns: (range: { contig: string; start: number; end: number }) => {
      state.followed.push(range)
      return true
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

/** The session's machinery a tracks cell borrows, over two sequences. */
function tracksContext(): TracksContext {
  const store = new AnnotationStore(`deck-cells-${Math.random()}.cool`, { persist: false })
  return {
    assembly: assemblyOf({
      uri: 'lead.cool',
      name: 'lead.cool',
      contigs: [
        { name: 'chr1', length: 400_000 },
        { name: 'chr2', length: 200_000 },
      ],
      origin: 'cooler',
    }),
    store,
    client: { request: () => Promise.resolve(null), drop: () => {} } as never,
    groups: new GroupSettings(`deck-cells-groups-${Math.random()}`),
  }
}

function make(
  store: ReturnType<typeof fakeStore> | undefined,
  tracks?: TracksContext,
  options: { mapsAllowed?: boolean } = {},
) {
  const published: Array<string | undefined> = []
  const went: Array<{ contig: string; start: number; end: number }> = []
  const dropped: string[] = []
  const manual = new ManualStore(`deck-cells-marks-${Math.random()}`)
  const deck = new PanelDeck({
    onMapsChange: (maps) => published.push(maps),
    memoryKey: () => 'deck-cells-test',
    leadName: () => 'lead.cool',
    leadLabel: () => 'lead.cool',
    ...(options.mapsAllowed === undefined ? {} : { mapsAllowed: () => options.mapsAllowed === true }),
    structure: {
      store: () => store as unknown as AnnotationStore | undefined,
      manual: () => manual,
      contacts: () => null,
      onGoTo: (range) => went.push(range),
      onDrop: (file) => dropped.push(file.name),
      onDropUrl: (url) => dropped.push(url),
    },
    tracks: { context: () => tracks },
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

/** The row of the settings card (§25.3) whose label is `label`, or undefined. */
function settingsRow(deck: PanelDeck, label: string): HTMLElement | undefined {
  const card = deck.structureSettings()
  if (card === null) return undefined
  return all<HTMLElement>(card, '.field').find((f) => f.querySelector('.field-label')?.textContent === label)
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
    // It leads with the verb, like every other button in the row: `3D structure`
    // beside `add` read as a kind of thing the URL box takes.
    expect(button?.textContent).toBe('add a 3D structure')
    expect(button?.title).toContain('Open a cell')
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'structure' })
    expect(structureCells(deck)).toHaveLength(1)
    expect(published).toEqual(['3d'])
    const greyed = deck.el.querySelector<HTMLButtonElement>('.deck-add-structure')
    expect(greyed?.disabled).toBe(true)
    // …and says why, rather than keeping the sentence promising to open a cell
    // it can no longer open (§18.1).
    expect(greyed?.title).toBe('The deck already holds its one structure cell.')
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

  it('offers a card of how the model is drawn, for the Aesthetics panel, writing through the store', () => {
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    expect(deck.structureSettings()).toBeNull()
    deck.add({ kind: 'structure' })
    const card = deck.structureSettings()
    expect(card).not.toBeNull()
    expect(card?.querySelector('.controls-title')?.textContent).toContain('3D structure')
    // No menu in the cell any more: the corner keeps its four buttons.
    expect(structureCells(deck)[0]?.querySelector('.structure-menu')).toBeNull()
    const select = settingsRow(deck, 'colour by')?.querySelector<HTMLSelectElement>('select')
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

// ---------------------------------------------------------------------------
// The tracks cell
// ---------------------------------------------------------------------------

function tracksCells(deck: PanelDeck): HTMLElement[] {
  return all<HTMLElement>(deck.el, '.deck-grid > .deck-tracks')
}

describe('a tracks cell in the deck', () => {
  it('is added by the bar, written into the link as `tracks`, and offered as a place with one edge', () => {
    const { deck, published } = make(undefined, tracksContext())
    deck.add({ kind: 'tracks' })
    expect(tracksCells(deck)).toHaveLength(1)
    expect(published.at(-1)).toBe('tracks')
    const rows = deck.mapList
    expect(rows.map((row) => row.label)).toEqual(['lead.cool', 'tracks'])
    expect(rows[1]?.edges).toEqual(['bottom'])
    // A second one is a second place, named apart.
    deck.add({ kind: 'tracks' })
    expect(deck.mapList.map((row) => row.label)).toEqual(['lead.cool', 'tracks', 'tracks 2'])
    expect(published.at(-1)).toBe('tracks|tracks')
  })

  it('says so where the session has no track list', () => {
    const { deck } = make(undefined, undefined)
    deck.add({ kind: 'tracks' })
    expect(tracksCells(deck)[0]?.querySelector('.tracks-note')?.textContent).toMatch(/no track list/)
    expect(tracksCells(deck)[0]?.querySelector('.view-browser')).toBeNull()
  })

  it('shows what the lead is looking at, on its own axis, and does not report it back', () => {
    const lead = leadPanel()
    const { deck } = make(undefined, tracksContext())
    deck.setLead(lead.panel)
    deck.add({ kind: 'tracks' })
    const box = tracksCells(deck)[0]?.querySelector<HTMLInputElement>('.input-region')
    expect(box?.value).toBe('chr1:10,001-30,000')
    expect(lead.state.followed).toEqual([])
  })

  it('takes the maps with it when the reader moves it, and stops when unhooked', () => {
    const lead = leadPanel()
    const { deck } = make(undefined, tracksContext())
    deck.setLead(lead.panel)
    deck.add({ kind: 'tracks' })
    const cell = tracksCells(deck)[0]
    const box = cell?.querySelector<HTMLInputElement>('.input-region')
    if (box === null || box === undefined) throw new Error('no locus box')
    box.value = 'chr2:50,001-60,000'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(lead.state.followed.at(-1)).toEqual({ contig: 'chr2', start: 50000, end: 60000 })
    // Unhooked: the cell keeps its own window and the maps keep theirs.
    cell?.querySelector<HTMLButtonElement>('.deck-lock')?.click()
    expect(cell?.classList.contains('is-unlocked')).toBe(true)
    const before = lead.state.followed.length
    box.value = 'chr2:1-20,000'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(lead.state.followed.length).toBe(before)
    lead.state.viewport?.([0, 100], [0, 100])
    expect(box.value).toBe('chr2:1-20,000')
  })

  it('has its pointer echoed onto the maps, like a structure cell’s', () => {
    const lead = leadPanel()
    const { deck } = make(undefined, tracksContext())
    deck.setLead(lead.panel)
    deck.add({ kind: 'tracks' })
    setHoverPlace({ loci: [{ contig: 'chr1', bp: 12500 }], source: 'tracks:p1' })
    expect(lead.state.echoes.at(-1)).toEqual({ contig: 'chr1', bp: 12500 })
  })

  it('is kept across a link that re-lists it', () => {
    const { deck } = make(undefined, tracksContext())
    deck.apply(state('tracks|https://x.example.org/b.cool'))
    const [cell] = tracksCells(deck)
    deck.apply(state('https://x.example.org/b.cool|tracks'))
    expect(tracksCells(deck)[0]).toBe(cell)
  })
})

// ---------------------------------------------------------------------------
// A lead that is not a map (§25 stage D)
// ---------------------------------------------------------------------------

describe('the deck beside the browser', () => {
  /** A browser standing in as the lead: windows to hand out, a place to be taken. */
  function browserLead() {
    const state = {
      window: { contig: 'chr1', start: 100_000, end: 120_000 },
      shown: [] as Array<{ contig: string; start: number; end: number }>,
    }
    const axis = {
      windows: () => ({
        rows: [],
        cols: [
          {
            contig: state.window.contig,
            start: state.window.start,
            end: state.window.end,
            unitFrom: state.window.start,
            unitTo: state.window.end,
          } as LocusWindow,
        ],
      }),
      show: (range: { contig: string; start: number; end: number }) => {
        state.shown.push(range)
        state.window = range
        return true
      },
    }
    return { axis, state }
  }

  it('hands the browser’s window to its cells, when they are built and when it moves', () => {
    const lead = browserLead()
    const { deck } = make(undefined, tracksContext())
    deck.setLeadAxis(lead.axis)
    deck.add({ kind: 'tracks' })
    const box = tracksCells(deck)[0]?.querySelector<HTMLInputElement>('.input-region')
    expect(box?.value).toBe('chr1:100,001-120,000')
    lead.state.window = { contig: 'chr2', start: 0, end: 50_000 }
    deck.leadMoved()
    expect(box?.value).toBe('chr2:1-50,000')
  })

  it('takes the browser where a tracks cell was panned', () => {
    const lead = browserLead()
    const { deck } = make(undefined, tracksContext())
    deck.setLeadAxis(lead.axis)
    deck.add({ kind: 'tracks' })
    const box = tracksCells(deck)[0]?.querySelector<HTMLInputElement>('.input-region')
    if (box === null || box === undefined) throw new Error('no locus box')
    box.value = 'chr2:10,001-20,000'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(lead.state.shown.at(-1)).toEqual({ contig: 'chr2', start: 10000, end: 20000 })
  })

  it('refuses a map in its bar, and holds one a link names as the cell it would have been', () => {
    const { deck, published } = make(undefined, tracksContext(), { mapsAllowed: false })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(deck.el.querySelector('.deck-warning')?.textContent).toMatch(/tracks and a structure/)
    expect(published).toEqual([])
    deck.apply(state('https://x.example.org/b.cool|tracks'))
    expect(all(deck.el, '.deck-grid > .is-vacant')).toHaveLength(1)
    expect(all(deck.el, '.deck-grid > .deck-panel:not(.is-lead)')).toHaveLength(2)
    expect(tracksCells(deck)).toHaveLength(1)
    // The add row keeps the two cells that can join and puts the map roads away.
    deck.promptAdd()
    expect(deck.el.querySelector('.deck-add')?.classList.contains('is-cells-only')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Colourings from the session's rows, loops, and a picking mode (§25.5)
// ---------------------------------------------------------------------------

describe('what the model can be coloured by', () => {
  function trackEntry(id: string, label: string, kind: 'track' | 'segments' | 'pairs'): AnnotationEntry {
    return {
      id,
      card: 'linear',
      kind,
      label,
      source: { kind: 'detached', name: label },
      status: 'ready',
      visible: true,
      placement: 'bottom',
      style: defaultStyle(kind, '#c0392b'),
    } as unknown as AnnotationEntry
  }

  it('lists the session’s tracks and feature sets, the marks, and the pinned bead’s distance', () => {
    const store = fakeStore([structureEntry(), trackEntry('t1', 'ATAC', 'track'), trackEntry('f1', 'peaks', 'segments')])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const select = settingsRow(deck, 'colour by')?.querySelector<HTMLSelectElement>('select')
    const values = Array.from(select?.options ?? []).map((option) => option.value)
    expect(values).toContain('track:t1')
    expect(values).toContain('features:f1')
    expect(values).toContain('marks')
    expect(values).toContain('distance')
    expect(values).toContain('contacts')
    expect(values).not.toContain('track:f1')
  })

  it('offers a loops row as chords only where the list has one, beside the reader\'s own marks', () => {
    const without = make(fakeStore([structureEntry()]))
    without.deck.add({ kind: 'structure' })
    const choices = (deck: PanelDeck): string[] =>
      Array.from(settingsRow(deck, 'loops as chords')?.querySelectorAll('option') ?? []).map((o) => o.value)
    // The marks are always there to draw (the deck has a manual store), a loops row only when loaded.
    expect(choices(without.deck)).toEqual(['', 'manual'])
    const store = fakeStore([structureEntry(), trackEntry('l1', 'loops.bedpe', 'pairs')])
    const withLoops = make(store)
    withLoops.deck.add({ kind: 'structure' })
    expect(choices(withLoops.deck)).toEqual(['', 'l1', 'manual'])
  })

  it('takes part in a picking mode armed on the deck, and is let go with it', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const wrap = structureCells(deck)[0]?.querySelector('.structure-wrap')
    let ended = 0
    const cancel = deck.armPicking({ point: () => {} }, () => ended++)
    expect(wrap?.classList.contains('is-picking')).toBe(true)
    cancel()
    expect(wrap?.classList.contains('is-picking')).toBe(false)
    expect(ended).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Enlarged into a dialog, and back (§25.3)
// ---------------------------------------------------------------------------

describe('the model, enlarged', () => {
  it('moves the cell’s own picture and menu into a dialog and back, keeping what was changed', () => {
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    const wrap = cell?.querySelector('.structure-wrap')
    expect(wrap).not.toBeNull()
    cell?.querySelector<HTMLButtonElement>('.structure-expand')?.click()
    const modal = document.querySelector('.modal-structure')
    expect(modal).not.toBeNull()
    // The same element, not a copy — in the dialog's stage, with the settings card in its sidebar.
    expect(modal?.querySelector('.structure-stage > .structure-wrap')).toBe(wrap)
    const card = modal?.querySelector('.structure-side > .structure-settings')
    expect(card).not.toBeNull()
    expect(card).toBe(deck.structureSettings())
    // The camera's rows are the card's own, so the sidebar carries nothing else.
    expect(modal?.querySelector('.structure-side-camera')).toBeNull()
    expect(modal?.querySelector('.structure-side .structure-settings button[title*="whole model"]')).not.toBeNull()
    // A setting changed in the sidebar writes through the store, as in the panel.
    const select = card?.querySelector<HTMLSelectElement>('select')
    if (select) {
      select.value = select.options[select.options.length - 1]?.value ?? ''
      select.dispatchEvent(new Event('change'))
    }
    expect(store.restyled.length).toBeGreaterThan(0)
    // Escape closes it; the picture is back in the cell with the menu folded.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.modal-structure')).toBeNull()
    expect(cell?.querySelector('.structure-body > .structure-wrap')).toBe(wrap)
    // The card is the deck's again, out of the dialog.
    expect(document.querySelector('.modal-structure .structure-settings')).toBeNull()
    expect(deck.structureSettings()?.classList.contains('structure-settings')).toBe(true)
  })

  it('closes its dialog when the cell is destroyed', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    structureCells(deck)[0]?.querySelector<HTMLButtonElement>('.structure-expand')?.click()
    expect(document.querySelector('.modal-structure')).not.toBeNull()
    structureCells(deck)[0]?.querySelector<HTMLButtonElement>('.btn-close')?.click()
    expect(document.querySelector('.modal-structure')).toBeNull()
  })
})

describe('which model the cell draws (§25.6)', () => {
  const second = Array.from({ length: 8 }, (_, i) => `chr2\t${i * 5000}\t${-i}\t${i}\t0`).join('\n')

  it('draws the first structure row until told otherwise, then the one it was shown', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const { deck } = make(fakeStore([structureEntry(), two]))
    deck.add({ kind: 'structure' })
    expect(deck.shownStructure()).toBe('a1')
    deck.showStructure('a2')
    expect(deck.shownStructure()).toBe('a2')
    const cell = structureCells(deck)[0]
    expect(cell.querySelector<HTMLInputElement>('.deck-name')?.value ?? cell.textContent).toContain('second.g3d')
  })

  it('opens the cell when there is none, and offers a picker only with two rows', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const { deck } = make(fakeStore([structureEntry(), two]))
    expect(deck.hasStructure()).toBe(false)
    deck.showStructure('a2')
    expect(deck.hasStructure()).toBe(true)
    expect(deck.shownStructure()).toBe('a2')
    const picker = settingsRow(deck, 'model')
    expect(picker).toBeDefined()
    const select = picker?.querySelector<HTMLSelectElement>('select')
    expect(select?.value).toBe('a2')
    expect(Array.from(select?.options ?? []).map((o) => o.textContent)).toEqual(['model.g3d', 'second.g3d'])
    select!.value = 'a1'
    select!.dispatchEvent(new Event('change'))
    expect(deck.shownStructure()).toBe('a1')
  })

  it('remembers the choice per file and falls back to the first when the row is gone', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const first = make(fakeStore([structureEntry(), two]))
    first.deck.showStructure('a2')
    first.deck.destroy()
    const again = make(fakeStore([structureEntry(), two]))
    again.deck.add({ kind: 'structure' })
    expect(again.deck.shownStructure()).toBe('a2')
    again.deck.destroy()
    const without = make(fakeStore([structureEntry()]))
    without.deck.add({ kind: 'structure' })
    expect(without.deck.shownStructure()).toBe('a1')
    expect(settingsRow(without.deck, 'model')).toBeUndefined()
  })
})

describe('the cell empties when the model it shows is removed (§25.3)', () => {
  const second = Array.from({ length: 8 }, (_, i) => `chr2\t${i * 5000}\t${-i}\t${i}\t0`).join('\n')

  it('shows nothing, and says so, after the picked row goes; a remembered row that is gone falls back', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const store = fakeStore([structureEntry(), two])
    const { deck } = make(store)
    deck.showStructure('a2')
    expect(deck.shownStructure()).toBe('a2')
    store.entries.splice(1, 1)
    store.notify()
    expect(deck.shownStructure()).toBeNull()
    expect(deck.el.querySelector('.structure-note')?.textContent).toMatch(/was removed/)
    deck.destroy()
    // The next deck on the same file: the choice was forgotten with the row.
    const again = make(fakeStore([structureEntry()]))
    again.deck.add({ kind: 'structure' })
    expect(again.deck.shownStructure()).toBe('a1')
  })

  it('empties for the row it simply fell into, not only one the reader picked', () => {
    // The commonest shape by far: one model loaded, the cell drawing it
    // because it is the only one there is. Removing it from the Structures
    // card used to leave the cell showing the next model along, or the same
    // name over an empty stage.
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const store = fakeStore([structureEntry(), two])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    expect(deck.shownStructure()).toBe('a1')
    store.entries.splice(0, 1)
    store.notify()
    expect(deck.shownStructure()).toBeNull()
    expect(deck.el.querySelector('.structure-note')?.textContent).toMatch(/was removed/)
    // …and the cell is still usable: the other row can be shown in it.
    deck.showStructure('a2')
    expect(deck.shownStructure()).toBe('a2')
  })

  it('keeps drawing a row that was recomputed onto the same id', () => {
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    expect(deck.shownStructure()).toBe('a1')
    store.entries[0] = { ...structureEntry(second), id: 'a1', label: 'first.g3d' }
    store.notify()
    expect(deck.shownStructure()).toBe('a1')
  })
})

describe('the key (§25.5)', () => {
  it('ghosts a sequence on a click, shows it alone on a double-click, and offers its colour', async () => {
    const twoSeq = [structureEntry(), { ...structureEntry(G3D.replace(/chr1/g, 'chr2')), id: 'a2' }]
    const store = fakeStore(twoSeq)
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    // The key is painted on the next frame.
    await new Promise((r) => setTimeout(r, 60))
    const names = all<HTMLButtonElement>(cell, '.structure-key-name')
    expect(names.map((b) => b.textContent)).toEqual(['chr1'])
    names[0].click()
    await new Promise((r) => setTimeout(r, 260))
    expect(store.restyled.at(-1)?.patch.structure?.ghosted).toEqual(['chr1'])
    names[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    // One sequence has no others to ghost: solo of the only one is everything back.
    expect(store.restyled.at(-1)?.patch.structure?.ghosted).toEqual([])
    const swatch = cell.querySelector<HTMLInputElement>('.structure-key-swatch')
    expect(swatch).not.toBeNull()
    swatch!.value = '#112233'
    swatch!.dispatchEvent(new Event('input'))
    expect(store.restyled.at(-1)?.patch.structure?.sequenceColours).toEqual({ chr1: '#112233' })
  })
})

describe('select mode and the reader\'s marks (§25.4)', () => {
  it('has a badge for the mode, and a button each for a bead, a loop and a measurement', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    const press = (which: string): void => cell.querySelector<HTMLButtonElement>(which)?.click()
    expect(cell.querySelector('.structure-mode')?.textContent).toBe('turn')
    press('.structure-select')
    expect(cell.querySelector('.structure-mode')?.textContent).toBe('mark')
    expect(cell.querySelector('.structure-select')?.classList.contains('is-on')).toBe(true)
    // One mode at a time: arming the next disarms the one that was on.
    press('.structure-loop')
    expect(cell.querySelector('.structure-mode')?.textContent).toBe('loop')
    expect(cell.querySelector('.structure-select')?.classList.contains('is-on')).toBe(false)
    press('.structure-measure')
    expect(cell.querySelector('.structure-mode')?.textContent).toBe('measure')
    expect(cell.querySelector('.structure-loop')?.classList.contains('is-on')).toBe(false)
    // …and pressing the one that is on turns it off.
    press('.structure-measure')
    expect(cell.querySelector('.structure-mode')?.textContent).toBe('turn')
  })

  it('offers the reader\'s arrowheads as chords, the fog, the centre and the three drawings on the card', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const options = Array.from(settingsRow(deck, 'loops as chords')?.querySelectorAll('option') ?? []).map((o) => o.value)
    expect(options).toContain('manual')
    expect(settingsRow(deck, 'fog')?.querySelector('input')?.value).toBe('0.6')
    expect(deck.structureSettings()?.querySelector('.structure-toggle[title*="centre and axes"]')).not.toBeNull()
    // Drawn as: three toggles that combine, the tube on by default.
    const drawn = Array.from(settingsRow(deck, 'drawn as')?.querySelectorAll<HTMLButtonElement>('.structure-toggle') ?? [])
    expect(drawn.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
    // The new channels and tools are on the card too.
    for (const label of ['size by', 'depth slab', 'camera', 'frame', 'ghost opacity']) {
      expect(settingsRow(deck, label), label).toBeDefined()
    }
  })

  it('measures: two clicks are a distance kept on the card, and the cell offers its commands', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    cell.querySelector<HTMLButtonElement>('.structure-measure')?.click()
    expect(cell.querySelector('.structure-mode')?.textContent).toBe('measure')
    const ids = deck.cellCommands().map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['structure-frame', 'structure-all', 'structure-measure', 'structure-turn', 'structure-tube']))
    const turn = deck.cellCommands().find((c) => c.id === 'structure-turn')
    expect(turn?.keys).toBeUndefined()
  })

  it('binds its letters only while the model is enlarged, so the panels keep theirs', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const keyed = (): Array<string | undefined> => deck.cellCommands().map((c) => c.keys)
    // Beside a map, the cell's commands are in the palette and bind nothing:
    // `f` is the Files panel's and `a` the Annotations panel's.
    expect(keyed().every((k) => k === undefined)).toBe(true)
    expect(deck.cellCommands().length).toBeGreaterThan(6)
    // Enlarged, the model is the window and the letters are its own.
    structureCells(deck)[0]?.querySelector<HTMLButtonElement>('.structure-expand')?.click()
    const bound = new Map(deck.cellCommands().map((c) => [c.id, c.keys]))
    expect(bound.get('structure-frame')).toBe('f')
    expect(bound.get('structure-all')).toBe('a')
    expect(bound.get('structure-select')).toBe('e')
    expect(bound.get('structure-loop')).toBe('o')
    expect(bound.get('structure-measure')).toBe('m')
    expect(bound.get('structure-turn')).toBe('r')
    // …and given back on the way out.
    document.querySelector<HTMLButtonElement>('.modal .modal-close, .modal button[title*="lose" i]')?.click()
  })

  it('hides and shows the dialog\'s settings from the corner', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    structureCells(deck)[0]?.querySelector<HTMLButtonElement>('.structure-expand')?.click()
    const toggle = document.querySelector<HTMLButtonElement>('.modal-structure .stage-side-toggle')
    expect(toggle).not.toBeNull()
    toggle?.click()
    expect(document.querySelector('.modal-structure .stage-side')?.classList.contains('hidden')).toBe(true)
    toggle?.click()
    expect(document.querySelector('.modal-structure .stage-side')?.classList.contains('hidden')).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
})

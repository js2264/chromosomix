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
import { MATRIX_OPTIONS, TRACK_OPTIONS, type PlotOptionKey } from '@/ui/plotOptions'
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

/** The deck's answer to the lead's Export card, as far as these tests read it. */
interface DeckExportLike {
  save(format: string, dpi: number): Promise<boolean>
  copy(dpi: number): Promise<boolean>
}

/** A lead the deck can drive, with the two calls a structure cell reaches it by. */
function leadPanel() {
  const state = {
    viewport: null as ((rows: [number, number], cols: [number, number]) => void) | null,
    echoes: [] as Array<{ contig: string; bp: number } | null>,
    framed: 0,
    /** Every stretch a tracks cell asked the lead to put on its column axis. */
    followed: [] as Array<{ contig: string; start: number; end: number }>,
    /** What the lead's Export card is answered by, once the deck has said. */
    exporter: null as DeckExportLike | null,
  }
  const windows: { rows: LocusWindow[]; cols: LocusWindow[] } = {
    rows: [{ contig: 'chr1', start: 10000, end: 30000, unitFrom: 10, unitTo: 30 } as LocusWindow],
    cols: [{ contig: 'chr1', start: 10000, end: 30000, unitFrom: 10, unitTo: 30 } as LocusWindow],
  }
  const panel = {
    setViewportListener: (listener: typeof state.viewport) => {
      state.viewport = listener
    },
    setDeckExport: (exporter: DeckExportLike | null) => {
      state.exporter = exporter
    },
    setCardFor: () => {},
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
  options: { mapsAllowed?: boolean; sharedElsewhere?: readonly PlotOptionKey[] } = {},
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
      ...(options.sharedElsewhere === undefined
        ? {}
        : { sharedElsewhere: () => options.sharedElsewhere ?? [] }),
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
  return { deck, published, went, dropped, manual }
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

  it('opens a cell each time it is pressed, because each model has one of its own', () => {
    // It was one cell per deck and the button greyed after the first, which is
    // the rule §25.3 dropped: a model gets a cell of its own, so a reader with
    // two of them sees both at once rather than swapping back and forth.
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
    expect(structureCells(deck)).toHaveLength(2)
    expect(published.at(-1)).toBe('3d|3d')
    // …and it stays pressable, with the sentence it always had.
    const again = deck.el.querySelector<HTMLButtonElement>('.deck-add-structure')
    expect(again?.disabled).toBe(false)
    expect(again?.title).toContain('Open a cell')
  })

  it('comes back from a link as two cells, not one (§25.3)', () => {
    // A `3d` repeated in a link used to be dropped on the way in, on the
    // reasoning that both cells would draw the one model the session has. Two
    // cells of one model are two *views* of it — each has its own camera, its
    // own mirror and its own planted axes — so the link keeps what it was
    // given.
    const { deck } = make(fakeStore([structureEntry()]))
    deck.apply(state('3d|3d'))
    expect(structureCells(deck)).toHaveLength(2)
  })

  it('draws one model in two cells when a row is dropped on the second', () => {
    // The gesture that says *where* as well as *which* (§25.3): the Structures
    // card's grip, dropped on the cell that is to hold it. A cell already
    // drawing the model is not a reason to refuse — that is the whole request.
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'structure' })
    const cells = structureCells(deck)
    expect(cells).toHaveLength(2)
    // jsdom has no `DataTransfer`, so the drag carries the same two methods
    // the code reads off one — the pattern `files-panel.test.ts` uses.
    const data = new Map<string, string>([['application/x-metacooler-structure', 'a1']])
    const transfer = {
      getData: (type: string) => data.get(type) ?? '',
      types: [...data.keys()],
      dropEffect: '',
    }
    const drop = new window.Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    cells[1].querySelector('.structure-wrap')?.dispatchEvent(drop)
    expect(deck.shownStructures()).toEqual(['a1'])
    // Both cells name it, which is what `shownStructures` de-duplicates away.
    const named = structureCells(deck).map((cell) => cell.querySelector('.deck-name')?.textContent)
    expect(named).toEqual(['model.g3d', 'model.g3d'])
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

  it('is part of the figure the lead’s Export card saves and copies', async () => {
    const lead = leadPanel()
    const { deck } = make(fakeStore([structureEntry()]))
    deck.setLead(lead.panel)
    // Nothing beside the first map yet: the card exports the map's own figure.
    expect(await lead.state.exporter?.save('png', 300)).toBe(false)
    deck.add({ kind: 'structure' })
    // A model beside it: the card is asked for the arrangement, model and all.
    expect(await lead.state.exporter?.save('png', 300)).toBe(true)
    expect(await lead.state.exporter?.copy(300)).toBe(true)
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
    // A span and not an `<input>`: this name is the row's, changed on the
    // Structures card, and a box that framed itself on hover then refused every
    // keystroke was inviting a rename it cannot do.
    expect(cell?.querySelector('.deck-name')?.textContent).toBe('structure')
    expect(cell?.querySelector('.structure-note')?.textContent).toMatch(/No structure loaded/)
    // The row arrives.
    empty.entries.push(structureEntry())
    empty.notify()
    expect(cell?.querySelector('.deck-name')?.textContent).toBe('model.g3d')
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

  it('mirrors the model from the frame row, each flip on its own (§25.5)', () => {
    // A model from contacts is fixed only up to reflection, so this is how one
    // is brought into the same hand as another — and it is a property of the
    // row, like every other reading of the model.
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const frame = settingsRow(deck, 'frame')
    expect(frame).toBeDefined()
    const x = frame?.querySelector<HTMLButtonElement>('.structure-mirror-x')
    const y = frame?.querySelector<HTMLButtonElement>('.structure-mirror-y')
    expect(x?.getAttribute('aria-pressed')).toBe('false')
    x?.click()
    expect(store.restyled.at(-1)?.patch.structure?.mirrorX).toBe(true)
    expect(store.restyled.at(-1)?.patch.structure?.mirrorY).toBe(false)
    y?.click()
    expect(store.restyled.at(-1)?.patch.structure?.mirrorY).toBe(true)
  })

  it('replants the axes along the view, moving neither the model nor the centre', () => {
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const before = deck.structureSettings()
    const replant = before?.querySelector<HTMLButtonElement>('.structure-replant')
    expect(replant).toBeDefined()
    replant?.click()
    const patch = store.restyled.at(-1)?.patch.structure
    // The centre is shown — replanting axes nobody can see says nothing — and
    // the frame is the camera's, which the default three-quarter view is not.
    expect(patch?.axes).toBe(true)
    expect(patch?.axesFrame).toBeDefined()
    expect(patch?.axesFrame).not.toEqual([0, 0, 0, 1])
    expect(Math.hypot(...(patch?.axesFrame ?? [0, 0, 0, 0]))).toBeCloseTo(1, 10)
  })

  it('offers another model as a frame to be read in, beside the one it draws over it', () => {
    // `compare with` draws the other model; `in the frame of` turns this one
    // into its frame and draws nothing extra (§25.5). Both are offered, and
    // only where there is another model to name.
    const store = fakeStore([structureEntry(), { ...structureEntry(), id: 'a2', label: 'other.g3d' }])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    const into = settingsRow(deck, 'in the frame of')?.querySelector<HTMLSelectElement>('select')
    expect(into).toBeDefined()
    expect(Array.from(into?.options ?? []).map((option) => option.textContent)).toEqual(['its own', 'other.g3d'])
    if (into === null || into === undefined) return
    into.value = 'a2'
    into.dispatchEvent(new Event('change'))
    expect(store.restyled.at(-1)?.patch.structure?.align).toBe('a2')
  })

  it('turns with the other cells that are, and says so on the camera row (§25.3)', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const link = settingsRow(deck, 'camera')?.querySelector<HTMLButtonElement>('.structure-turn-with')
    expect(link?.getAttribute('aria-pressed')).toBe('false')
    link?.click()
    const after = settingsRow(deck, 'camera')?.querySelector<HTMLButtonElement>('.structure-turn-with')
    expect(after?.getAttribute('aria-pressed')).toBe('true')
  })

  it('offers the shared settings no other card in the column offers (§26.3)', () => {
    // Beside a **map**, the Map card offers all three the model reads, so the
    // row is empty: one control per column, and two copies ten lines apart
    // read as two settings.
    const { deck } = make(fakeStore([structureEntry()]), undefined, { sharedElsewhere: MATRIX_OPTIONS })
    deck.add({ kind: 'structure' })
    expect(settingsRow(deck, 'shared')).toBeUndefined()
  })

  it('offers the key beside a browser, whose own card has no key to hide', () => {
    // The 1D browser offers the crosshair and the hover card and no *legend* —
    // a browser has no key of its own. So the model's key toggle is the gap,
    // and it used to be nowhere at all: a reader in a browser-led deck could
    // turn the model's key off only by enlarging it.
    const { deck } = make(fakeStore([structureEntry()]), undefined, { sharedElsewhere: TRACK_OPTIONS })
    deck.add({ kind: 'structure' })
    const shared = settingsRow(deck, 'shared')
    expect(shared).toBeDefined()
    const offered = all<HTMLElement>(shared as HTMLElement, '.structure-shared').map((node) =>
      node.className.split(' ').find((name) => name.startsWith('structure-shared-')),
    )
    expect(offered).toEqual(['structure-shared-legend'])
  })

  it('stars one cell, and the settings card is that cell\u2019s (§25.3)', () => {
    // A deck may hold several models and the column holds one card, so the
    // card follows a cell the reader names. It used to be whichever cell was
    // built first — which a reader with two models discovers by dragging a
    // slider and watching the *other* picture change.
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const cells = () => structureCells(deck)
    // One model, one card: a radio with one option is a button that does
    // nothing, so there is no star to press.
    expect(cells()[0].querySelector('.structure-star')?.classList.contains('hidden')).toBe(true)
    deck.add({ kind: 'structure' })
    const stars = () => cells().map((cell) => cell.querySelector<HTMLButtonElement>('.structure-star'))
    expect(stars().every((star) => star?.classList.contains('hidden') === false)).toBe(true)
    // Exactly one filled — and a filled star is live, since pressing it is how
    // a reader leaves no cell starred.
    expect(stars().map((star) => star?.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expect(stars()[0]?.disabled).toBe(false)
    const first = deck.structureSettings()
    stars()[1]?.click()
    expect(stars().map((star) => star?.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    const second = deck.structureSettings()
    expect(second).not.toBe(first)
    expect(cells()[1].contains(second as Node)).toBe(false)
    // The card is the second cell's: it is the element that cell hands over.
    expect(second).not.toBeNull()
  })

  it('sets every structure cell at once while none is starred (§25.3)', () => {
    const second = { ...structureEntry(), id: 'a2', label: 'model2.g3d' } as AnnotationEntry
    const store = fakeStore([structureEntry(), second])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'structure' })
    const stars = () =>
      structureCells(deck).map((cell) => cell.querySelector<HTMLButtonElement>('.structure-star'))
    // The filled star, pressed: no cell is starred any more.
    stars()[0]?.click()
    expect(stars().map((star) => star?.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    const card = deck.structureSettings()
    expect(card?.querySelector('.structure-card-for')?.textContent).toBe('every structure — all 2')
    // Rows about one cell's own picture are not offered: a model compared
    // with itself, or one file saved for two pictures.
    expect(settingsRow(deck, 'structure')).toBeUndefined()
    expect(settingsRow(deck, 'export')).toBeUndefined()
    // A setting made on the card is made to both rows.
    store.restyled.length = 0
    const beads = card?.querySelector<HTMLButtonElement>('.structure-toggle[aria-label^="Beads"], .structure-toggle[title^="Beads"]')
    expect(beads).not.toBeNull()
    beads?.click()
    expect(store.restyled.map((write) => write.id).sort()).toEqual(['a1', 'a2'])
    // Starred again, the card is one cell's and writes to its row alone.
    stars()[1]?.click()
    store.restyled.length = 0
    deck.structureSettings()?.querySelector<HTMLButtonElement>('.structure-toggle[title^="Beads"]')?.click()
    expect(store.restyled.map((write) => write.id)).toEqual(['a2'])
  })

  it('moves the star off a cell that closes, so the card is never about a picture that is gone', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    deck.add({ kind: 'structure' })
    const cells = structureCells(deck)
    cells[1].querySelector<HTMLButtonElement>('.structure-star')?.click()
    const starred = deck.structureSettings()
    cells[1].querySelector<HTMLButtonElement>('.btn-close')?.click()
    expect(structureCells(deck)).toHaveLength(1)
    const left = deck.structureSettings()
    expect(left).not.toBeNull()
    expect(left).not.toBe(starred)
    // …and the one cell left offers no star, there being nothing to choose.
    expect(
      structureCells(deck)[0].querySelector('.structure-star')?.classList.contains('hidden'),
    ).toBe(true)
  })

  it('is resized by the bar under it, and given back to the row on a double-click', () => {
    // A model has no axis to line up with the map's, so it is the one cell
    // whose height is the reader's own business (§25.3).
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    const grip = cell.querySelector<HTMLElement>('.structure-resize')
    expect(grip).not.toBeNull()
    expect(cell.classList.contains('has-height')).toBe(false)
    grip?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(cell.classList.contains('has-height')).toBe(true)
    expect(cell.style.getPropertyValue('--structure-h')).toMatch(/^\d+px$/)
    grip?.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
    expect(cell.classList.contains('has-height')).toBe(false)
    expect(cell.style.getPropertyValue('--structure-h')).toBe('')
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

  it('opens on the model’s own five, by what each measures, and offers no score column', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const select = settingsRow(deck, 'colour by')?.querySelector<HTMLSelectElement>('select')
    const texts = Array.from(select?.options ?? []).map((option) => option.textContent)
    expect(texts.slice(0, 5)).toEqual([
      'sequence',
      'linear position along the sequence',
      'manual annotations',
      'spatial distance to pinned bin',
      'contacts with pinned bin',
    ])
    expect(Array.from(select?.options ?? []).map((option) => option.value)).not.toContain('score')
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

  it('carries every shared setting into the full viewer, whoever owns them (§26.3)', () => {
    // Enlarged, the model *is* the window and every card that owns one of
    // these is behind the dialog — so all three come in, including the ones the
    // Map card would normally be the only place to reach. The one switch for
    // the key the reader is looking at should not be the one they cannot get
    // to.
    const { deck } = make(fakeStore([structureEntry()]), undefined, { sharedElsewhere: MATRIX_OPTIONS })
    deck.add({ kind: 'structure' })
    // Nothing on the card while the Map card offers all three.
    expect(settingsRow(deck, 'shared')).toBeUndefined()
    structureCells(deck)[0]?.querySelector<HTMLButtonElement>('.structure-expand')?.click()
    const shared = all<HTMLElement>(
      document.querySelector('.modal-structure') as HTMLElement,
      '.structure-shared',
    ).map((node) => node.className.split(' ').find((name) => name.startsWith('structure-shared-')))
    expect(shared).toEqual([
      'structure-shared-legend',
      'structure-shared-crosshair',
      'structure-shared-tooltip',
    ])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    // …and they go back where they came from when the dialog closes.
    expect(settingsRow(deck, 'shared')).toBeUndefined()
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

describe('a Structures row dropped on a `+` (§16.9)', () => {
  /** The grid in reading order, by what each cell is. */
  const kinds = (deck: PanelDeck): string[] =>
    all<HTMLElement>(deck.el, '.deck-grid > .deck-panel').map((cell) =>
      cell.classList.contains('deck-structure')
        ? '3d'
        : cell.classList.contains('deck-tracks')
          ? 'tracks'
          : cell.classList.contains('is-vacant')
            ? 'empty'
            : 'map',
    )

  it('moves the model to the near end of the edge, its old cell left empty where it stood', () => {
    const { deck, published } = make(fakeStore([structureEntry()]), tracksContext())
    deck.showStructure('a1')
    deck.add({ kind: 'tracks' })
    // The session's own map first, then the two cells, in one row.
    expect(kinds(deck)).toEqual(['map', '3d', 'tracks'])
    const before = published.length
    deck.growWithStructure('below', 'a1')
    // The new row's first cell, and the cell the model was in stays where it
    // was, empty. Closing it closed the grid up in reading order, and the
    // model slid straight back into the place it had just left.
    expect(kinds(deck)).toEqual(['map', 'empty', 'tracks', '3d', 'empty', 'empty'])
    expect(deck.shownStructures()).toEqual(['a1'])
    // One write, filled: see `PanelDeck.growFilled`.
    expect(published.length - before).toBe(1)
  })

  it('fills the new row, not the hole a short last row leaves above it', () => {
    const { deck } = make(fakeStore([structureEntry()]), tracksContext())
    deck.add({ kind: 'tracks' })
    deck.add({ kind: 'tracks' })
    deck.add({ kind: 'tracks' })
    // Three across, from the bar's own control: four cells, and a second row
    // of one.
    const across = deck.el.querySelector<HTMLSelectElement>('.deck-columns')
    if (across === null) throw new Error('no columns control')
    across.value = '3'
    across.dispatchEvent(new Event('change'))
    expect(kinds(deck)).toEqual(['map', 'tracks', 'tracks', 'tracks'])
    deck.growWithStructure('below', 'a1')
    // A row below fills the short one's holes too — but the `+` below was
    // aimed at the row it opens, so the model goes there.
    expect(kinds(deck)).toEqual(['map', 'tracks', 'tracks', 'tracks', 'empty', 'empty', '3d', 'empty', 'empty'])
  })
})

describe('which model each cell draws (§25.3, §25.6)', () => {
  const second = Array.from({ length: 8 }, (_, i) => `chr2\t${i * 5000}\t${-i}\t${i}\t0`).join('\n')

  it('gives a second model a cell of its own rather than taking the first one\u2019s', () => {
    // It used to be one cell per deck, so showing a second model destroyed the
    // picture of the first — which made two models a thing you could only
    // compare by swapping back and forth, and made a reconstruction landing
    // wipe out the model it was to be judged against.
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const { deck } = make(fakeStore([structureEntry(), two]))
    deck.add({ kind: 'structure' })
    expect(deck.shownStructures()).toEqual(['a1'])
    deck.showStructure('a2')
    expect(deck.shownStructures()).toEqual(['a1', 'a2'])
    expect(structureCells(deck)).toHaveLength(2)
  })

  it('does nothing for a model a cell already draws', () => {
    // The eye is a state, not a button that adds: pressing a lit one hides.
    const { deck } = make(fakeStore([structureEntry()]))
    deck.showStructure('a1')
    deck.showStructure('a1')
    expect(structureCells(deck)).toHaveLength(1)
  })

  it('opens the cell when there is none, and offers no structure picker on its card', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const { deck } = make(fakeStore([structureEntry(), two]))
    expect(deck.hasStructure()).toBe(false)
    deck.showStructure('a2')
    expect(deck.hasStructure()).toBe(true)
    expect(deck.shownStructures()).toEqual(['a2'])
    // Which model a cell draws is the Structures card's to say — its eye, or a
    // row dropped on the cell — and not a dropdown on the settings card.
    expect(settingsRow(deck, 'structure')).toBeUndefined()
    // One cell: no star, so no line naming the starred one either.
    expect(deck.structureSettings()?.querySelector('.structure-card-for')).toBeNull()
  })

  it('names the starred cell on its card, as the Map card names the starred map', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const { deck } = make(fakeStore([structureEntry(), two]))
    deck.showStructure('a1')
    deck.showStructure('a2')
    const line = () => deck.structureSettings()?.querySelector('.structure-card-for')
    // The first cell holds the star until another is pressed.
    expect(line()?.textContent).toBe('model.g3d')
    expect(line()?.classList.contains('is-every')).toBe(false)
    expect(line()?.querySelector('.map-card-star')?.classList.contains('is-on')).toBe(true)
    const stars = () => structureCells(deck).map((cell) => cell.querySelector<HTMLButtonElement>('.structure-star'))
    stars()[1]?.click()
    expect(line()?.textContent).toBe('second.g3d')
    // …and a cell closed down to one takes the line away with the star.
    deck.hideStructure('a1')
    expect(line()).toBeNull()
  })

  it('hides one model\u2019s cell and leaves the others standing', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const { deck } = make(fakeStore([structureEntry(), two]))
    deck.showStructure('a1')
    deck.showStructure('a2')
    expect(deck.shownStructures()).toEqual(['a1', 'a2'])
    deck.hideStructure('a1')
    expect(deck.shownStructures()).toEqual(['a2'])
    // …and with no id, every one of them goes.
    deck.hideStructure()
    expect(deck.hasStructure()).toBe(false)
  })

  it('remembers the choice per file and falls back to the first when the row is gone', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const first = make(fakeStore([structureEntry(), two]))
    first.deck.showStructure('a2')
    first.deck.destroy()
    const again = make(fakeStore([structureEntry(), two]))
    again.deck.add({ kind: 'structure' })
    expect(again.deck.shownStructures()).toEqual(['a2'])
    again.deck.destroy()
    const without = make(fakeStore([structureEntry()]))
    without.deck.add({ kind: 'structure' })
    expect(without.deck.shownStructures()).toEqual(['a1'])
    expect(settingsRow(without.deck, 'structure')).toBeUndefined()
  })
})

describe('the cell empties when the model it shows is removed (§25.3)', () => {
  const second = Array.from({ length: 8 }, (_, i) => `chr2\t${i * 5000}\t${-i}\t${i}\t0`).join('\n')

  it('shows nothing, and says so, after the picked row goes; a remembered row that is gone falls back', () => {
    const two = { ...structureEntry(second), id: 'a2', label: 'second.g3d' }
    const store = fakeStore([structureEntry(), two])
    const { deck } = make(store)
    deck.showStructure('a2')
    expect(deck.shownStructures()).toEqual(['a2'])
    store.entries.splice(1, 1)
    store.notify()
    expect(deck.shownStructures()).toEqual([])
    expect(deck.el.querySelector('.structure-note')?.textContent).toMatch(/was removed/)
    deck.destroy()
    // The next deck on the same file: the choice was forgotten with the row.
    const again = make(fakeStore([structureEntry()]))
    again.deck.add({ kind: 'structure' })
    expect(again.deck.shownStructures()).toEqual(['a1'])
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
    expect(deck.shownStructures()).toEqual(['a1'])
    store.entries.splice(0, 1)
    store.notify()
    expect(deck.shownStructures()).toEqual([])
    expect(deck.el.querySelector('.structure-note')?.textContent).toMatch(/was removed/)
    // …and the cell is still usable: the other row can be shown in it.
    deck.showStructure('a2')
    expect(deck.shownStructures()).toEqual(['a2'])
  })

  it('keeps drawing a row that was recomputed onto the same id', () => {
    const store = fakeStore([structureEntry()])
    const { deck } = make(store)
    deck.add({ kind: 'structure' })
    expect(deck.shownStructures()).toEqual(['a1'])
    store.entries[0] = { ...structureEntry(second), id: 'a1', label: 'first.g3d' }
    store.notify()
    expect(deck.shownStructures()).toEqual(['a1'])
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

describe('the key of colour by manual annotations (§25.5)', () => {
  it('lists every mark, hides one on a click, shows one alone on a double-click, and recolours the mark itself', async () => {
    const entry = structureEntry()
    const byMarks = {
      ...entry,
      style: { ...entry.style, structure: { ...entry.style.structure!, colourBy: 'marks' } },
    } as AnnotationEntry
    const store = fakeStore([byMarks])
    const { deck, manual } = make(store)
    manual.add({ id: 'k1', kind: 'line', axis: 'vertical', at: { contig: 'chr1', bp: 12000 }, colour: '#111318' })
    manual.add({ id: 'k2', kind: 'rect', a: { contig: 'chr1', from: 10000, to: 20000 }, b: { contig: 'chr1', from: 10000, to: 20000 }, colour: '#c0392b' })
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    await new Promise((r) => setTimeout(r, 60))
    expect(cell.querySelector('.structure-key-title')?.textContent).toBe('manual annotations')
    const names = all<HTMLButtonElement>(cell, '.structure-key-mark .structure-key-name')
    // Named as the Manual annotations card names them.
    expect(names.map((b) => b.textContent)).toEqual(['│ chr1:12,000', '▭ chr1:10,000-20,000'])
    names[0].click()
    await new Promise((r) => setTimeout(r, 260))
    expect(store.restyled.at(-1)?.patch.structure?.marksHidden).toEqual(['k1'])
    names[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(store.restyled.at(-1)?.patch.structure?.marksHidden).toEqual(['k1'])
    // The swatch writes the mark, which is what the card and every map draw.
    const swatch = cell.querySelector<HTMLInputElement>('.structure-key-mark .structure-key-swatch')
    swatch!.value = '#112233'
    swatch!.dispatchEvent(new Event('input'))
    expect(manual.marks.find((mark) => mark.id === 'k1')?.colour).toBe('#112233')
  })

  it('says where marks come from while there are none', async () => {
    const entry = structureEntry()
    const byMarks = {
      ...entry,
      style: { ...entry.style, structure: { ...entry.style.structure!, colourBy: 'marks' } },
    } as AnnotationEntry
    const { deck } = make(fakeStore([byMarks]))
    deck.add({ kind: 'structure' })
    await new Promise((r) => setTimeout(r, 60))
    expect(structureCells(deck)[0].querySelector('.structure-key-empty')?.textContent).toMatch(/Manual annotations card/)
  })
})

describe('select mode and the reader\'s marks (§25.4)', () => {
  it('has a badge for the mode, and a button each for a bead, a loop and a measurement', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    const press = (which: string): void => cell.querySelector<HTMLButtonElement>(which)?.click()
    // Each of the three says it is on, in the class the stylesheet draws the
    // pressed look from and in the attribute a screen reader reads. All three,
    // because a mode that is on and does not look it is one the reader has to
    // guess their way out of.
    const on = (which: string): boolean => {
      const button = cell.querySelector(which)
      return button?.classList.contains('is-on') === true && button.getAttribute('aria-pressed') === 'true'
    }
    // The corner's legend lists every control and **lights the live one**
    // (§25.4); `.structure-mode` is that lit row, which is the one-chip badge
    // this grew out of. Read by the word rather than by the row's whole text,
    // since a row is its key and its word — `⇧ move`, not `move`.
    const live = (): string | undefined =>
      cell.querySelector('.structure-mode > .structure-guide-what')?.textContent ?? undefined
    expect(live()).toBe('turn')
    press('.structure-select')
    expect(live()).toBe('mark')
    expect(on('.structure-select')).toBe(true)
    // One mode at a time: arming the next disarms the one that was on.
    press('.structure-loop')
    expect(live()).toBe('loop')
    expect(on('.structure-loop')).toBe(true)
    expect(on('.structure-select')).toBe(false)
    press('.structure-measure')
    expect(live()).toBe('measure')
    expect(on('.structure-measure')).toBe(true)
    expect(on('.structure-loop')).toBe(false)
    // …and pressing the one that is on turns it off.
    press('.structure-measure')
    expect(live()).toBe('turn')
    expect(on('.structure-measure')).toBe(false)
    // The lit row names the mode, which is what the stylesheet accents it by —
    // `mark`, not the `select` the button's class is still called.
    press('.structure-select')
    expect(cell.querySelector<HTMLElement>('.structure-mode')?.dataset['mode']).toBe('mark')
    // And the controls a reader has *not* got their hand on are listed too,
    // each with its key: the legend is how the keys are found at all.
    const listed = Array.from(cell.querySelectorAll('.structure-guide-what')).map((node) => node.textContent)
    expect(listed).toEqual(expect.arrayContaining(['turn', 'zoom', 'move', 'centre', 'fog']))
  })

  it('offers the reader\'s arrowheads as chords, the fog, the centre and the three drawings on the card', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const options = Array.from(settingsRow(deck, 'loops as chords')?.querySelectorAll('option') ?? []).map((o) => o.value)
    expect(options).toContain('manual')
    // One row for the fog: the toggle that arms it and the depth that shapes
    // it, with the number beside the slider. Two rows meant a second label
    // that repeated the first — `fog`, then `fog depth`.
    const fog = settingsRow(deck, 'fog')
    expect(fog?.querySelector('.structure-toggle')).not.toBeNull()
    expect(fog?.querySelector('input')?.value).toBe('0.6')
    expect(fog?.querySelector('.structure-value')?.textContent).toBe('0.6')
    expect(settingsRow(deck, 'fog depth')).toBeUndefined()
    expect(deck.structureSettings()?.querySelector('.structure-toggle[title*="centre and axes"]')).not.toBeNull()
    // Drawn as: three toggles that combine, the tube on by default.
    const drawn = Array.from(settingsRow(deck, 'drawn as')?.querySelectorAll<HTMLButtonElement>('.structure-toggle') ?? [])
    expect(drawn.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
    // …and the ghost is one row the same way: the choice arms it, the opacity
    // shapes it.
    const ghost = settingsRow(deck, 'outside window')
    expect(ghost?.querySelector('select')).not.toBeNull()
    expect(ghost?.querySelector('input[type=range]')).not.toBeNull()
    expect(settingsRow(deck, 'ghost opacity')).toBeUndefined()
    // The tools are on the card too. *size by* is gone — a second channel
    // nobody asked for — and so is the row it had.
    for (const label of ['depth slab', 'camera', 'frame']) {
      expect(settingsRow(deck, label), label).toBeDefined()
    }
    expect(settingsRow(deck, 'size by')).toBeUndefined()
    // *overlays* sits with *drawn as*: what the model is drawn as, then what is
    // drawn over it.
    const labels = Array.from(deck.structureSettings()?.querySelectorAll('.field-label') ?? []).map(
      (node) => node.textContent,
    )
    expect(labels.indexOf('overlays')).toBe(labels.indexOf('drawn as') + 1)
  })

  it('measures: two clicks are a distance kept on the card, and the cell offers its commands', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.add({ kind: 'structure' })
    const cell = structureCells(deck)[0]
    cell.querySelector<HTMLButtonElement>('.structure-measure')?.click()
    expect(cell.querySelector('.structure-mode > .structure-guide-what')?.textContent).toBe('measure')
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
    expect(bound.get('structure-turn')).toBe('r')
    // The three modes have none, enlarged or not (§25.4): a bare letter that
    // arms a mode is a letter pressed by accident with the pointer over the
    // model, and `e`, `o` and `m` each belonged to something else, so the
    // shortcuts dialog printed two rows for one key.
    for (const id of ['structure-select', 'structure-loop', 'structure-measure']) {
      expect(bound.get(id)).toBeUndefined()
    }
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

// ---------------------------------------------------------------------------
// An empty cell takes what a deck can hold (§16.9)
// ---------------------------------------------------------------------------

describe('an empty cell', () => {
  /** A deck whose session carries tracks, with a store that records placements. */
  function withTracks() {
    const placed: Array<{ id: string; map: string }> = []
    const loaded: Array<{ uri: string; map: string }> = []
    const tracks = tracksContext()
    const store = {
      byId: (id: string) => (id === 't1' ? { id } : undefined),
      placeAt: (id: string, map: string) => placed.push({ id, map }),
      keepMaps: () => {},
      noteMapFiles: () => {},
      adoptHome: () => {},
    }
    const deck = new PanelDeck({
      onMapsChange: () => {},
      memoryKey: () => 'deck-cells-empty',
      leadName: () => 'lead.cool',
      tracks: { context: () => tracks },
      annotations: () => ({ store }) as never,
      onTrackFile: (picked, map) => loaded.push({ uri: picked.uri, map }),
    })
    document.body.appendChild(deck.el)
    const view = document.createElement('div')
    view.appendChild(document.createElement('div')).className = 'view-head'
    deck.frame(view)
    return { deck, placed, loaded }
  }

  function dropOn(target: Element, data: Map<string, string>, files: File[] = []): void {
    const transfer = {
      getData: (type: string) => data.get(type) ?? '',
      types: [...data.keys(), ...(files.length > 0 ? ['Files'] : [])],
      files,
      dropEffect: '',
    }
    const drop = new window.Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    target.dispatchEvent(drop)
  }

  it('offers to take a map, a track or a structure, not a map alone', () => {
    const { deck } = withTracks()
    deck.grow('beside')
    const label = deck.el.querySelector('.deck-vacant .ann-drop-label')?.textContent
    expect(label).toBe('Drop a map, a track or a structure')
    expect(label).not.toContain('Drop a map here')
  })

  it('does not promise a track where the session carries none', () => {
    const { deck } = make(fakeStore([structureEntry()]))
    deck.grow('beside')
    expect(deck.el.querySelector('.deck-vacant .ann-drop-label')?.textContent).toBe(
      'Drop a map or a structure',
    )
  })

  it('becomes a tracks cell drawing a row dragged from the Tracks card', () => {
    const { deck, placed } = withTracks()
    deck.grow('beside')
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    dropOn(zone, new Map([['application/x-metacooler-track', 't1']]))
    expect(all(deck.el, '.deck-grid > .deck-tracks')).toHaveLength(1)
    expect(all(deck.el, '.deck-vacant')).toHaveLength(0)
    // Placed on the cell that opened there, which is the map id its lanes
    // are drawn under.
    const cell = deck.mapList.find((map) => map.label === 'tracks')
    expect(placed).toEqual([{ id: 't1', map: cell?.id }])
  })

  it('answers a drag with an effect its source allows, so the browser lets it drop', () => {
    // A browser refuses a drop whose target answers an effect the source did
    // not allow, with no `drop` event at all. A row whose source allows `move`
    // alone is still taken; the tests that dispatch a `drop` never see this.
    const { deck } = withTracks()
    deck.grow('beside')
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    const transfer = {
      types: ['application/x-metacooler-track'],
      effectAllowed: 'move',
      dropEffect: 'none',
      getData: () => '',
      files: [],
    }
    const over = new window.Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(over, 'dataTransfer', { value: transfer })
    zone.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(transfer.dropEffect).toBe('move')
  })

  it('becomes a tracks cell loading a track file dropped on it', () => {
    const { deck, loaded } = withTracks()
    deck.grow('beside')
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    dropOn(zone, new Map(), [new File(['chr1\t0\t10\n'], 'peaks.bed')])
    expect(all(deck.el, '.deck-grid > .deck-tracks')).toHaveLength(1)
    const cell = deck.mapList.find((map) => map.label === 'tracks')
    expect(loaded).toEqual([{ uri: 'peaks.bed', map: cell?.id }])
  })

  it('still opens a map dropped on it as a map', () => {
    const { deck, loaded } = withTracks()
    deck.grow('beside')
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    dropOn(zone, new Map(), [new File(['x'], 'rep2.cool')])
    expect(all(deck.el, '.deck-grid > .deck-tracks')).toHaveLength(0)
    expect(loaded).toEqual([])
    expect(deck.mapList.map((map) => map.label).slice(1)).toEqual(['rep2.cool'])
  })
})

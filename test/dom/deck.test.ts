// @vitest-environment jsdom
/**
 * The deck as a *thing on screen*: what its bar holds, what its grid does when
 * maps arrive and leave, and the three facts it owns that nothing else can
 * recompute — the star, the lock's window, and which maps a lane may be on.
 *
 * `test/unit/panel-deck.test.ts` has the arithmetic (the link, the block plan,
 * the budget) and `test/unit/panel-lock.test.ts` has the lock. What is left is
 * everything that only happens because a `PanelDeck` was built and pressed, and
 * it is where the deck's bugs have actually lived: a label that fell back to an
 * internal id, a star left pointing at a closed panel, a window the lock never
 * learned, lanes bound to a map that is no longer in the grid.
 *
 * A companion's worker never answers here — `Worker` is a stub that swallows
 * every message — so every panel below is one that is still opening. That is on
 * purpose and it is the harder case: the deck has to be right about a map from
 * the moment its cell exists, not from the moment its bytes arrive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recall } from '@/state/UiMemory'
import { PanelDeck } from '@/panels/PanelDeck'
import { MAX_PANELS } from '@/panels/deck'
import type { AnnotationContext } from '@/ui/MatrixPanel'
import type { MatrixPanel } from '@/ui/MatrixPanel'
import type { MapId } from '@/annotations/placement'
import type { ViewState } from '@/types'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

/** A worker that is created, listened to, and never answers. */
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
  // `UiMemory` is `sessionStorage`, and the deck remembers its columns and its
  // star there — per *file*, and every deck below uses the same key. Left over,
  // they would make each test's deck open in the state the last one was pressed
  // into.
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

// ---------------------------------------------------------------------------
// A lead the deck can drive
// ---------------------------------------------------------------------------

/**
 * The session's own map, as the deck sees it.
 *
 * Only what `PanelDeck` actually calls on a lead, which is a short list — the
 * three listeners, the lane floor, and the four questions the lock asks. It
 * reports nothing on its own, which is exactly the state a real lead is in when
 * a deck is first built around it: it was drawn before anything was listening.
 */
function leadPanel(
  options: {
    bpPerCell?: number
    cells?: number
    window?: [number, number]
    reach?: number | null
    /** What the rasteriser resolved — the numbers under the key. */
    shown?: { vmin: number; vmax: number; transform: string; colormap: string }
  } = {},
) {
  const bpPerCell = options.bpPerCell ?? 1000
  const cells = options.cells ?? 400
  const state = {
    window: options.window ?? ([0, cells] as [number, number]),
    shown: [] as Array<[number, number]>,
    floors: 0,
    /** The deck's lane listener, so a test can make the lead report geometry. */
    lanes: null as ((geometry: unknown) => void) | null,
    /** The deck's lane-hover listener, so a test can point at a track. */
    laneHover: null as ((at: { axis: 'rows' | 'cols'; unit: number } | null) => void) | null,
    /** Every mark the deck asked this map to show for another map's pointer. */
    laneEchoes: [] as Array<{ axis: 'rows' | 'cols'; unit: number } | null>,
    /** Which of the two scales the deck asked for, and how often. */
    askedShown: 0,
    askedSet: 0,
    /** What the deck last told the first map's *Map* card it sets (§16.5). */
    cardFor: undefined as unknown,
    /** Boxes a companion following the deck handed to this map (§16.3). */
    selected: [] as unknown[],
  }
  const panel = {
    setViewportListener: () => {},
    setDeckExport: () => {},
    setCardFor: (target: unknown) => {
      state.cardFor = target
    },
    selectRegion: (selection: unknown) => {
      state.selected.push(selection)
    },
    setLaneListener: (listener: (geometry: unknown) => void) => {
      state.lanes = listener
    },
    setHoverListener: () => {},
    setLaneHoverListener: (listener: (at: { axis: 'rows' | 'cols'; unit: number } | null) => void) => {
      state.laneHover = listener
    },
    showLaneEcho: (at: { axis: 'rows' | 'cols'; unit: number } | null) => {
      state.laneEchoes.push(at)
    },
    turnReach: () => options.reach ?? null,
    setLaneFloor: () => {
      state.floors++
    },
    remeasure: () => {},
    bpPerCell: () => bpPerCell,
    cellCount: () => ({ rows: cells, cols: cells }),
    // A bin-level block, which is what every deck below is of. The deck asks
    // both of these before it converts anything: above bin level a cell is a
    // whole sequence and the currency is the cell index rather than base pairs
    // (`panels/lock.ts`), and `test/dom/deck-lock-level.test.ts` is where that
    // half is pinned.
    blockLevel: () => 'bin',
    blockSpan: () => ({
      rows: cells * bpPerCell,
      cols: cells * bpPerCell,
      sequences: { rows: 1, cols: 1 },
    }),
    viewport: () => ({ rows: state.window, cols: state.window }),
    get hasBlock(): boolean {
      return true
    },
    isTurned: () => false,
    showViewport: (rows: [number, number]) => {
      state.shown.push(rows)
      return true
    },
    // What the *reader* has set. `NaN` on both bounds is how that spells "auto",
    // which is the state of every map nobody has nudged — and is exactly what
    // the deck used to read and push across the deck as a range.
    scale: () => {
      state.askedSet++
      return { vmin: Number.NaN, vmax: Number.NaN, transform: 'log10', colormap: 'fall' }
    },
    // What it is drawing with.
    shownScale: () => {
      state.askedShown++
      return (
        options.shown ?? { vmin: -3.679, vmax: -0.97, transform: 'log10', colormap: 'fall' }
      )
    },
    baseScale: () => undefined,
  }
  return { panel: panel as unknown as MatrixPanel, state }
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

interface Made {
  deck: PanelDeck
  published: Array<string | undefined>
  stars: number
  kept: Array<string[]>
  /** What the deck told the store each cell is showing, per render. */
  noted: Array<string[]>
  /** Every `map=uri` the deck asked the store to give a parked lane back to. */
  adopted: string[]
  /** What the session's own map is at, and what the deck asked it to move to. */
  leadBinsize: number | undefined
  askedBinsize: number[]
  /** Whether the session's own file can answer a rung the deck asks for. */
  leadCanMove: boolean
  scales: unknown[]
}

function make(
  props: { leadName?: string; withStore?: boolean; extra?: Partial<ConstructorParameters<typeof PanelDeck>[0]> } = {},
): Made {
  const made: Made = {
    deck: null as unknown as PanelDeck,
    published: [],
    stars: 0,
    kept: [],
    noted: [],
    adopted: [],
    leadBinsize: undefined,
    askedBinsize: [],
    leadCanMove: true,
    scales: [],
  }
  const store = {
    keepMaps: (maps: ReadonlySet<MapId>) => {
      made.kept.push([...maps].sort())
    },
    // The two halves of "a lane finds its way home": the deck tells the store
    // which file each cell is showing while it is alive, and asks for whatever
    // was parked under that file when one arrives (`annotations/store.ts`).
    noteMapFiles: (files: ReadonlyMap<MapId, string>) => {
      made.noted.push([...files].map(([map, uri]) => `${map}=${uri}`).sort())
    },
    adoptHome: (map: MapId, uri: string) => {
      made.adopted.push(`${map}=${uri}`)
    },
  }
  made.deck = new PanelDeck({
    onMapsChange: (maps) => made.published.push(maps),
    memoryKey: () => 'deck-test',
    leadName: () => props.leadName ?? 'lead.cool',
    leadLabel: () => props.leadName ?? 'lead.cool',
    onStarChange: () => {
      made.stars++
    },
    binsize: () => made.leadBinsize,
    onLeadScale: (scale) => made.scales.push(scale),
    onLeadBinsize: (binsize) => {
      made.askedBinsize.push(binsize)
      if (made.leadCanMove) made.leadBinsize = binsize
      return made.leadCanMove
    },
    ...(props.withStore === false
      ? {}
      : { annotations: () => ({ store }) as unknown as AnnotationContext }),
    ...(props.extra ?? {}),
  })
  document.body.appendChild(made.deck.el)
  // A deck only paints its lead's heading — and therefore the lead's star —
  // once it has been asked to frame a view, and it only has somewhere to put
  // its own line about how many maps there are if that view has a heading with
  // a summary in it, which every view a deck can frame does (§16.8).
  made.deck.frame(viewWithHead())
  return made
}

/**
 * The least a view state can be and still name a place a companion can answer.
 *
 * The `maps` key has to carry what the deck last published, or reconciling
 * against it would destroy the companions the test has just added — which is the
 * deck doing exactly what it should, since a state naming no maps is a state
 * with no deck in it.
 */
function view(made: Made): ViewState {
  const maps = made.published[made.published.length - 1]
  return {
    uri: 'lead.cool',
    view: 'region',
    region: 'chr1',
    ...(maps === undefined ? {} : { maps }),
  } as unknown as ViewState
}

/** A mounted view of the shape the deck hoists a heading out of. */
function viewWithHead(): HTMLElement {
  const view = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'view-head'
  const summary = document.createElement('span')
  summary.className = 'summary'
  summary.textContent = '4,000 × 4,000 bins'
  head.appendChild(summary)
  view.appendChild(head)
  return view
}

/**
 * The heading of every cell of the grid, lead first.
 *
 * A companion's name is an `<input>` — a map can be renamed, and the control is
 * a box that looks like text until it has the caret (`ui/mapNames.ts`) — while
 * the lead's and a vacancy's are plain text. Both are read here, so the test is
 * about what a cell is *called* rather than about which element says it.
 */
function cellNames(deck: PanelDeck): string[] {
  return all<HTMLElement>(deck.el, '.deck-grid > .deck-panel .deck-name').map((node) =>
    (node instanceof HTMLInputElement ? node.value : (node.textContent ?? '')).trim(),
  )
}

/** A button of the deck's own bar, by the class it carries. */
function barButton(deck: PanelDeck, kind: string): HTMLButtonElement {
  const node = deck.el.querySelector<HTMLButtonElement>(`.deck-bar .deck-${kind}`)
  if (node === null) throw new Error(`no ${kind} in the deck bar`)
  return node
}

/**
 * The first map's chain, which lives in the lead cell's own heading.
 *
 * It was in the bar, and there it was one glyph at two heights: a chain takes
 * *one* cell off the deck's navigation, so the lead's belongs where every
 * companion's is (§16.5).
 */
function leadChain(deck: PanelDeck): HTMLButtonElement {
  const node = deck.el.querySelector<HTMLButtonElement>('.deck-grid .is-lead .deck-lock')
  if (node === null) throw new Error('no chain on the lead’s heading')
  return node
}

// ---------------------------------------------------------------------------

describe('the deck’s bar', () => {
  it('holds the controls that are about the deck rather than about one map', () => {
    const { deck } = make()
    for (const kind of ['columns', 'share', 'resolutions', 'save', 'copy', 'close']) {
      expect(barButton(deck, kind)).not.toBeNull()
    }
    // …and the chain is not one of them: it takes one cell off the navigation,
    // which is a per-cell act, so the lead's sits in the lead's own heading
    // beside its star and the bar has none.
    expect(deck.el.querySelector('.deck-bar .deck-lock')).toBeNull()
    expect(leadChain(deck)).not.toBeNull()
  })

  /**
   * The two presses that put a deck on one footing.
   *
   * Named *match all scales* and *match all resolutions*, because `fix` reads as
   * repair to a reader arriving from Juicebox or HiGlass and nothing here is
   * broken — `match` is the verb §5.7 already uses for the same one-off act.
   *
   * They were switches, and a switch here made a promise it could not keep:
   * `one scale`, left on, meant every later nudge of any panel's clip either had
   * to be undone or left the deck claiming a shared scale it no longer had. A
   * press says a thing that stays true — *these are all on that one's numbers
   * now* — and the very next nudge is honestly the reader's own again.
   */
  describe('the two presses that put a deck on one footing', () => {
    it('are bordered, like everything else in the bar and not like a link', () => {
      const { deck } = make()
      for (const kind of ['share', 'resolutions']) {
        const node = barButton(deck, kind)
        expect(node.classList.contains('btn')).toBe(true)
        expect(node.classList.contains('btn-quiet')).toBe(false)
      }
    })

    it('are named for the act, not for a repair', () => {
      const { deck } = make()
      expect(barButton(deck, 'share').textContent).toBe('match all scales')
      expect(barButton(deck, 'resolutions').textContent).toBe('match all resolutions')
      // One sentence each, and no spec citation: the reasoning is the module
      // header's and the contract's, not the cursor's (§26.4).
      for (const kind of ['share', 'resolutions']) {
        expect(barButton(deck, kind).title).not.toContain('§')
      }
    })

    it('are actions, so they never come back lit', () => {
      const { deck } = make()
      for (const kind of ['share', 'resolutions']) {
        barButton(deck, kind).click()
        const after = barButton(deck, kind)
        expect(after.classList.contains('is-on')).toBe(false)
        expect(after.hasAttribute('aria-pressed')).toBe(false)
      }
    })

    it('read the deck from left to right in the order the work is done', () => {
      // Get the maps on screen, put them on one footing, decide whether they
      // move together, arrange them, take the picture — and the one control that
      // ends the deck across the gap at the far end.
      const { deck } = make()
      const bar = all<HTMLElement>(deck.el, '.deck-bar > *').map((node) => node.className)
      expect(bar[0]).toContain('deck-add-toggle')
      expect(bar[1]).toContain('deck-share')
      expect(bar[2]).toContain('deck-resolutions')
      // The chain used to sit here, fourth; it is the lead cell's own control now.
      expect(bar[3]).toContain('deck-columns')
      expect(bar[bar.length - 1]).toContain('deck-close')
      // The one that ends the deck is a bordered word rather than a bare mark,
      // so it is not the twin of the × on the cell a finger's width below it.
      const close = barButton(deck, 'close')
      expect(close.textContent).toBe('close deck')
      expect(close.classList.contains('btn')).toBe(true)
      expect(close.classList.contains('btn-close')).toBe(false)
    })

    it('name the starred map in what they promise to do', () => {
      const { deck } = make({ leadName: 'first.cool' })
      expect(barButton(deck, 'share').title).toContain('first.cool')
      expect(barButton(deck, 'resolutions').title).toContain('first.cool')

      deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
      all<HTMLButtonElement>(deck.el, '.deck-star')[1].click()
      // The star moved, so the sentence is about the other file now: it is the
      // map both presses are read *from*, which is the whole of what changed
      // when they stopped being read from the first one.
      expect(barButton(deck, 'share').title).toContain('b.cool')
      expect(barButton(deck, 'resolutions').title).toContain('b.cool')
    })

    it('remember nothing between decks, because there is no setting to keep', () => {
      const first = make()
      barButton(first.deck, 'share').click()
      barButton(first.deck, 'resolutions').click()
      first.deck.destroy()

      const next = make()
      expect(barButton(next.deck, 'share').classList.contains('is-on')).toBe(false)
      expect(barButton(next.deck, 'resolutions').classList.contains('is-on')).toBe(false)
    })
  })

  it('offers one column per cell, and no more', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    const columns = barButton(deck, 'columns') as unknown as HTMLSelectElement
    expect(all<HTMLOptionElement>(columns, 'option').map((o) => o.value)).toEqual(['1', '2', '3'])
  })

  it('says how many maps are here, and how many cells are still empty', () => {
    const { deck } = make()
    // The state a reader meets first: "add a map" builds the deck and shows its
    // bar before a file has been chosen.
    expect(deck.el.querySelector('.deck-maps')?.textContent).toContain('1 map')
    expect(deck.el.querySelector('.deck-maps')?.textContent).not.toContain('1 maps')
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(deck.el.querySelector('.deck-maps')?.textContent).toContain('2 maps')
    // A row of two grown beside is a row of three, one of them empty.
    deck.grow('beside')
    expect(deck.el.querySelector('.deck-maps')?.textContent).toContain('2 maps · 1 empty cell')
  })

  it('puts its line after the view’s own summary rather than inside it', () => {
    const { deck } = make()
    const note = deck.el.querySelector('.deck-maps')
    expect(note?.previousElementSibling?.className).toBe('summary')
    // The count alone: the separator is the stylesheet's, drawn only while the
    // summary in front of it has words, since that line is rewritten on every
    // pan and this one is not.
    expect(note?.textContent?.startsWith('1 map')).toBe(true)
  })

  it('refuses a map past the backstop in its own bar rather than on an error screen', () => {
    const { deck } = make()
    for (let n = 0; n < MAX_PANELS - 1; n++) {
      deck.add({ kind: 'remote', uri: `https://x.example.org/${n}.cool` })
    }
    expect(deck.el.querySelector('.deck-warning')?.classList.contains('hidden')).toBe(true)
    deck.add({ kind: 'remote', uri: 'https://x.example.org/over.cool' })
    const warning = deck.el.querySelector('.deck-warning')
    expect(warning?.classList.contains('hidden')).toBe(false)
    expect(warning?.textContent).toContain(String(MAX_PANELS))
    // …and the maps that are here are untouched.
    expect(cellNames(deck)).toHaveLength(MAX_PANELS)
  })
})

describe('the list of maps a track can be drawn on', () => {
  it('leads with the session’s own map', () => {
    const { deck } = make({ leadName: 'lead.cool' })
    expect(deck.mapList[0]).toEqual({ id: 'lead', label: 'lead.cool' })
  })

  /**
   * The regression. It fell back to the slot's internal id for anything that
   * was not a *remote* file — which is every companion a reader dropped — so the
   * placement control offered `p3` as the name of the map to draw a bigWig on,
   * in a list where every other row said what it was.
   */
  it('names a local companion by its file, not by the deck’s id for it', () => {
    const { deck } = make()
    deck.add({ kind: 'local', uri: 'rep2.cool' })
    expect(deck.mapList.map((entry) => entry.label)).toEqual(['lead.cool', 'rep2.cool'])
    expect(deck.mapList[1].id).not.toBe('rep2.cool')
  })

  it('names a remote companion by its file and its entry', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/rep2.mcool::resolutions/1000' })
    expect(deck.mapList[1].label).toBe('rep2.mcool::1000')
  })

  it('leaves out a cell that has no file in it', () => {
    const { deck } = make()
    deck.grow('beside')
    expect(deck.mapList).toHaveLength(1)
  })
})

describe('the hash', () => {
  it('carries a remote companion by name and a local one as a vacancy', () => {
    const { deck, published } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.add({ kind: 'local', uri: 'rep2.cool' })
    expect(published[published.length - 1]).toBe('https://x.example.org/b.cool|~')
  })

  it('keeps a drawn cell’s place in it', () => {
    const { deck, published } = make()
    deck.grow('beside')
    expect(published[published.length - 1]).toBe('~')
  })

  it('keeps the maps it is already holding when the hash comes back with no grant for them', () => {
    // The bug this is here for: a file dropped on the window arrives as a
    // `File`, not as a filesystem handle, so nothing can re-open it later. The
    // hash says `~` for each, the session resolves none of them, and the deck
    // used to replace four live panels with four vacancies reading *this cell
    // held that file and it could not be re-opened* — about files it still had
    // in hand. Dropping four coolers gave four empty cells.
    const { deck, published } = make()
    deck.add({ kind: 'local', uri: 'rep2.cool' })
    deck.add({ kind: 'local', uri: 'rep3.cool' })
    deck.add({ kind: 'local', uri: 'rep4.cool' })
    expect(published[published.length - 1]).toBe('~|~|~')
    // The state coming back round, with nothing resolved: exactly what a drop
    // produces, since a dropped file has no grant to resolve through.
    deck.apply(
      { uri: 'lead.cool', view: 'region', region: 'chr1', maps: '~|~|~' } as unknown as ViewState,
      [],
    )
    // Four panels: the lead cell, and the three companions still live.
    expect(all(deck.el, '.deck-grid > .deck-panel')).toHaveLength(4)
    expect(deck.el.textContent).not.toContain('could not be re-opened')
  })

  it('still lets a link put something else where a local map was', () => {
    // The rule is only ever over a `~`: a list that names a remote map at that
    // index means the remote map, and the live cell goes.
    const { deck } = make()
    deck.add({ kind: 'local', uri: 'rep2.cool' })
    deck.apply(
      { uri: 'lead.cool', view: 'region', region: 'chr1', maps: 'https://x.example.org/b.cool' } as unknown as ViewState,
      [],
    )
    expect(deck.el.textContent).not.toContain('rep2.cool')
  })
})

describe('growing the deck', () => {
  it('opens a column beside the maps and leaves the lead in cell 0', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.grow('beside')
    // 1 × 2 grown beside is 1 × 3: the lead, its companion, and one empty cell.
    expect(cellNames(deck)).toEqual(['lead.cool', 'b.cool', 'empty'])
  })

  it('opens a row below them, which is a cell per column', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.grow('below')
    expect(cellNames(deck)).toEqual(['lead.cool', 'b.cool', 'empty', 'empty'])
  })

  it('fills the first cell it opened when the press carried a file', () => {
    const { deck } = make()
    const dropped = new File(['x'], 'dropped.cool')
    deck.grow('beside', { uri: dropped.name, source: { kind: 'local', file: dropped } })
    expect(cellNames(deck)).toEqual(['lead.cool', 'dropped.cool'])
  })

  it('puts a map in a cell that is already empty rather than at the end', () => {
    const { deck } = make()
    deck.grow('below')
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(cellNames(deck)).toEqual(['lead.cool', 'b.cool'])
  })
})

/**
 * Opening a map that lives on a server, which is the road a *link* travels
 * (§11) and the one the deck had no control for.
 *
 * The boxes existed — a file chooser, a URL field, an `add` — and nothing on
 * screen opened them: the row was revealed by the command palette alone, so a
 * reader with a published cooler and a deck in front of them had a drop
 * rectangle for a local file and no way at all to name a remote one. What is
 * asserted here is that both roads are reachable from the deck itself and that
 * a URL typed into either produces a companion the hash can carry.
 */
describe('adding a map by URL', () => {
  /** The row of boxes, and whether the reader can see it. */
  function addRow(deck: PanelDeck): HTMLElement {
    const node = deck.el.querySelector<HTMLElement>('.deck-add')
    if (node === null) throw new Error('the deck has no add row')
    return node
  }

  it('is opened by a button in the bar, not by the command palette alone', () => {
    const { deck } = make()
    expect(addRow(deck).classList.contains('hidden')).toBe(true)
    // Named for what the row opens — a *cell* — because it also holds the 3D
    // structure and a stack of tracks, and the tracks cell has no other road on
    // screen (§16.11). It promised a map.
    expect(barButton(deck, 'add-toggle').textContent).toBe('add a cell…')
    barButton(deck, 'add-toggle').click()
    expect(addRow(deck).classList.contains('hidden')).toBe(false)
    // The way out of the row is not drawn like a mode that is on (§26.3).
    const cancel = barButton(deck, 'add-toggle')
    expect(cancel.textContent).toBe('cancel')
    expect(cancel.classList.contains('is-on')).toBe(false)
    expect(textsOf(addRow(deck), '.btn')).toEqual([
      'choose a file…',
      'add',
      'add a 3D structure',
      'add a tracks cell',
    ])
  })

  it('is put away again by the same button', () => {
    const { deck } = make()
    barButton(deck, 'add-toggle').click()
    barButton(deck, 'add-toggle').click()
    expect(addRow(deck).classList.contains('hidden')).toBe(true)
  })

  it('opens the map the URL names, and puts the row away', () => {
    const { deck, published } = make()
    barButton(deck, 'add-toggle').click()
    const url = deck.el.querySelector<HTMLInputElement>('.deck-url')
    if (url === null) throw new Error('the add row has no URL box')
    url.value = 'https://x.example.org/b.cool'
    url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(cellNames(deck)).toEqual(['lead.cool', 'b.cool'])
    // A remote companion is carried by name, which is the whole point of the
    // road: the deck the reader repaired can be shared on.
    expect(published[published.length - 1]).toBe('https://x.example.org/b.cool')
    expect(addRow(deck).classList.contains('hidden')).toBe(true)
  })

  it('is the deck’s own row, and nothing is tucked inside a vacancy', () => {
    const { deck } = make()
    deck.grow('beside')
    deck.grow('beside')
    expect(cellNames(deck)).toEqual(['lead.cool', 'empty', 'empty'])
    // An empty cell used to carry a box of its own, folded away behind *or open
    // one by URL*, and then a button onto the connected places. Both are gone:
    // the rectangle's whole message is *drop a file here*, dropping is the
    // gesture, and clicking it opens the chooser.
    expect(all(deck.el, '.deck-vacant-url')).toHaveLength(0)
    expect(all(deck.el, 'details.ann-url')).toHaveLength(0)
    expect(all(deck.el, '.deck-vacant .btn')).toHaveLength(0)
  })
})

describe('the star', () => {
  it('starts on the lead, and no star is a dead button any more', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    const stars = all<HTMLButtonElement>(deck.el, '.deck-star')
    // Filled is pressable too: pressing it is how a reader leaves no map
    // starred (§16.5), so it is live like every other star.
    expect(stars.map((node) => node.disabled)).toEqual([false, false])
    expect(stars.map((node) => node.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expect(deck.starredMap).toBe('lead')
  })

  it('leaves no map starred when the filled one is pressed, and says so', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    const before = made.stars
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[0].click()
    expect(made.deck.starredMap).toBeNull()
    expect(made.deck.starredPanel).toBeNull()
    expect(
      all<HTMLButtonElement>(made.deck.el, '.deck-star').map((node) => node.classList.contains('is-on')),
    ).toEqual([false, false])
    // The Analysis column is told, because it greys every task now (§18.1).
    expect(made.stars).toBeGreaterThan(before)
    // …and pressing an empty star puts one back.
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[1].click()
    expect(made.deck.starredMap).not.toBeNull()
    expect(made.deck.starredMap).not.toBe('lead')
  })

  it('keeps no star while the deck is up, and starts the next deck on the lead', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[0].click()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    expect(made.deck.starredMap).toBeNull()
    // A deck put down leaves the next one starting where every deck starts.
    barButton(made.deck, 'close').click()
    expect(made.deck.starredMap).toBe('lead')
  })

  it('gives the column a card naming a starred map that has not drawn yet', () => {
    // The first map's card must not stand in for it: it would set a map other
    // than the one the star is on.
    const { deck } = make()
    expect(deck.mapCard()).toBeNull()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(deck.el, '.deck-star')[1].click()
    const card = deck.mapCard()
    expect(card?.classList.contains('map-card-waiting')).toBe(true)
    expect(card?.querySelector('.map-card-for')?.textContent).toBe('b.cool')
    all<HTMLButtonElement>(deck.el, '.deck-star')[0].click()
    expect(deck.mapCard()).toBeNull()
  })

  it('greys the two presses while no map is starred, with the reason on them', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(deck.el, '.deck-star')[0].click()
    for (const kind of ['share', 'resolutions']) {
      expect(barButton(deck, kind).disabled).toBe(true)
      expect(barButton(deck, kind).title).toContain('No map is starred')
    }
    all<HTMLButtonElement>(deck.el, '.deck-star')[0].click()
    expect(barButton(deck, 'share').disabled).toBe(false)
  })

  it('tells the first map’s card what it sets: itself, or every map', () => {
    const made = make()
    const lead = leadPanel()
    made.deck.setLead(lead.panel)
    // One map is not a choice, and the card says nothing about it.
    expect(lead.state.cardFor).toBeNull()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(lead.state.cardFor).toEqual({ kind: 'starred', name: 'lead.cool' })
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[0].click()
    expect(lead.state.cardFor).toEqual({ kind: 'every', maps: 2 })
    // The star on the companion: its card is the column's now, and the first
    // map's says nothing.
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[1].click()
    expect(lead.state.cardFor).toBeNull()
  })

  it('moves to the companion whose star is pressed, and only that one', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    const stars = all<HTMLButtonElement>(made.deck.el, '.deck-star')
    stars[1].click()
    expect(made.deck.starredMap).not.toBe('lead')
    expect(
      all<HTMLButtonElement>(made.deck.el, '.deck-star').map((node) =>
        node.classList.contains('is-on'),
      ),
    ).toEqual([false, true, false])
    expect(made.stars).toBeGreaterThan(0)
  })

  it('says what it decides, and what pressing it does, in the button’s own tooltip', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    const stars = all<HTMLButtonElement>(deck.el, '.deck-star')
    expect(stars[0].title).toContain('lead.cool is starred: the Map card sets it and the analyses run on it')
    expect(stars[0].title).toContain('Click to unstar')
    expect(stars[1].title).toContain('Star b.cool')
  })

  /**
   * A star pointing at a closed panel is worse than one pointing at nothing:
   * the Analysis column would go on offering tasks priced against a file with
   * no picture on screen, and there would be no control left to move it back
   * with.
   */
  it('goes back to the lead when the map it was on is closed', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(deck.el, '.deck-star')[1].click()
    const starred = deck.starredMap
    expect(starred).not.toBe('lead')
    deck.el.querySelector<HTMLButtonElement>('.deck-panel:not(.is-lead) .btn-close')?.click()
    expect(deck.starredMap).toBe('lead')
  })

  /**
   * The regression. The star is remembered per file and a slot id is minted
   * from a counter that climbs for the life of the tab, so a deck opened after
   * one that had a companion starred restores an id it will never mint. It was
   * only reconciled where a slot *departed* — a link naming fewer maps, a cell
   * closed, the deck closed — and a deck built by "add a map" reaches none of
   * those, so the star sat on a panel that had never existed: no star filled
   * anywhere, the lead offering to become the target it already was, and every
   * task's result adopted onto a map with nothing to draw it.
   */
  it('is not left on a map from a deck that has already been put down', () => {
    const first = make()
    first.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(first.deck.el, '.deck-star')[1].click()
    const remembered = first.deck.starredMap
    first.deck.destroy()

    const next = make()
    next.deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    expect(next.deck.starredMap).not.toBe(remembered)
    expect(next.deck.starredMap).toBe('lead')
    expect(
      all<HTMLButtonElement>(next.deck.el, '.deck-star').map((node) =>
        node.classList.contains('is-on'),
      ),
    ).toEqual([true, false])
  })

  it('goes back to the lead when the whole deck is closed', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(deck.el, '.deck-star')[1].click()
    barButton(deck, 'close').click()
    expect(deck.starredMap).toBe('lead')
  })
})

describe('the lanes a track may be on', () => {
  /**
   * The regression. `keepMaps` says of itself that it is "reconciled against
   * the deck rather than driven by an event … doing it once per render cannot
   * go stale", and it was reached from exactly one place: the deck's own close.
   * So closing *one* companion out of four left that map's lanes in the store,
   * bound to a slot id nothing would ever mint again — invisible, because the
   * placement control lists the maps that exist, and still counted by
   * everything that asks a track how many maps it is on.
   */
  it('is reconciled whenever a map leaves, not only when the deck closes', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    const withCompanion = made.kept[made.kept.length - 1]
    expect(withCompanion).toHaveLength(2)
    expect(withCompanion).toContain('lead')

    made.deck.el.querySelector<HTMLButtonElement>('.deck-panel:not(.is-lead) .btn-close')?.click()
    expect(made.kept[made.kept.length - 1]).toEqual(['lead'])
  })

  it('keeps a companion that is showing no picture yet', () => {
    // A map still reading its file, or one whose current view is a table, has no
    // `MatrixPanel` for a moment and is very much still a map in the deck.
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(made.kept[made.kept.length - 1]).toHaveLength(2)
  })

  it('names only the lead once the deck is closed', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    barButton(made.deck, 'close').click()
    expect(made.kept[made.kept.length - 1]).toEqual(['lead'])
  })

  /**
   * The other half of the same reconciliation, and what makes a lane survive a
   * deck being put down and opened again.
   *
   * A `MapId` is a slot id minted per deck and never minted again, so a lane
   * parked under one could never be given back. What identifies "that map" to a
   * reader is the **file** it is showing, so that is what the deck tells the
   * store while the cell is alive, and what it asks for when one arrives.
   */
  it('tells the store which file each cell is showing, while it can', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    const last = made.noted[made.noted.length - 1]
    expect(last).toHaveLength(1)
    expect(last[0]).toContain('https://x.example.org/b.cool')
  })

  it('asks for whatever was parked under that file, on every render', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(made.adopted.some((each) => each.endsWith('=https://x.example.org/b.cool'))).toBe(true)
  })

  it('says nothing about an empty cell, which is showing no file at all', () => {
    const made = make()
    made.deck.grow('beside')
    expect(made.noted[made.noted.length - 1]).toEqual([])
  })
})

describe('the lock’s window', () => {
  /**
   * The regression, and the reason a companion could open on a different zoom
   * from the map it was put beside.
   *
   * The lock learns a window from a panel *reporting* one, and a panel reports
   * when it draws. The first map of a deck was drawn — and reported nothing,
   * because until the reader pressed "add a map" there was nothing listening —
   * so its window was invisible to the deck until they touched it again.
   * Putting the first map back in step is the plainest way to reach that state
   * on purpose.
   */
  it('is seeded from the lead when the lead is put back in step', () => {
    const { deck } = make()
    const lead = leadPanel({ window: [100, 200] })
    deck.setLead(lead.panel)
    const chain = leadChain(deck)
    chain.click() // off the lead
    const before = lead.state.shown.length
    leadChain(deck).click() // and back on it
    expect(lead.state.shown.length).toBeGreaterThan(before)
    expect(lead.state.shown[lead.state.shown.length - 1]).toEqual([100, 200])
  })

  it('is not seeded from a lead the reader has taken off the lead', () => {
    const { deck } = make()
    const lead = leadPanel({ window: [100, 200] })
    deck.setLead(lead.panel)
    leadChain(deck).click()
    expect(lead.state.shown).toEqual([])
  })
})

/**
 * §16.8's alignment, and the one number it was missing.
 *
 * A deck's promise is that its pictures are of one place and can be read against
 * each other, which holds only while they are the same size at the same height
 * in their cells — so the lead's *measured* plot is pushed onto the grid rather
 * than each panel being left to derive one from the same stylesheet.
 */
describe('the size the deck lays its cells out from', () => {
  it('publishes the lead’s plot, width and height alike', () => {
    const { deck } = make()
    const lead = leadPanel()
    deck.setLead(lead.panel)
    lead.state.lanes?.({
      lanes: { top: 0, right: 0, bottom: 0, left: 0 },
      plot: 640,
      plotHeight: 160,
    })
    const grid = deck.el.querySelector<HTMLElement>('.deck-grid')
    expect(grid?.style.getPropertyValue('--deck-plot')).toBe('640px')
    expect(grid?.style.getPropertyValue('--deck-plot-h')).toBe('160px')
  })

  /**
   * The regression. The height used to be assumed equal to the width, on the
   * grounds that a contact map is square — and a turned map is a band along its
   * diagonal, a fraction of the height of the square it was cut from. The one
   * thing sized from it is the empty cell, which then set the height of its
   * whole grid row and pushed every map in that row to the foot of a rectangle
   * of air.
   */
  it('does not call a turned map’s plot as tall as it is wide', () => {
    const { deck } = make()
    const lead = leadPanel()
    deck.setLead(lead.panel)
    lead.state.lanes?.({
      lanes: { top: 0, right: 0, bottom: 0, left: 0 },
      plot: 640,
      plotHeight: 160,
    })
    const grid = deck.el.querySelector<HTMLElement>('.deck-grid')
    expect(grid?.style.getPropertyValue('--deck-plot-h')).not.toBe(
      grid?.style.getPropertyValue('--deck-plot'),
    )
  })

  it('publishes nothing at all before anything has been measured', () => {
    const { deck } = make()
    const grid = deck.el.querySelector<HTMLElement>('.deck-grid')
    // An empty string, so the card falls back to the square the stylesheet
    // draws before there is a map to be the size of.
    expect(grid?.style.getPropertyValue('--deck-plot-h')).toBe('')
  })
})

/**
 * One resolution across the deck, and what happens to a file that has not got
 * it.
 *
 * The claim a deck makes is that its pictures are of one place and can be read
 * against each other, and half of them at 1 kb beside the rest at 10 kb is a
 * claim it is no longer making. So the first map's rung takes every companion
 * with it — and a file without that level stays where it is and says so, rather
 * than being moved to the nearest thing and leaving the deck at two resolutions
 * without a word.
 *
 * The companions here **open**, unlike everywhere else in this file, and that
 * is the point of the swap: a panel that has not opened knows nothing about its
 * own ladder, and reading its empty entry list as "this file carries one
 * resolution only" accused a still-fetching `.mcool` of lacking the very rung it
 * was about to land on — a sentence its own next read disproved, and which
 * nothing on that path cleared. Refusing is a claim about a file, so it is made
 * from a file that has answered. The last test here is the other half of that
 * rule: a companion pressed *while* it fetches is held, not accused.
 */
describe('one resolution across the deck', () => {
  /** A plain `.cool`: one rung, at 1 kb, and no block behind it. */
  class OneRungWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: unknown = null
    postMessage(message: { kind: string; id: number; uri?: string }): void {
      const reply =
        message.kind === 'open'
          ? { type: 'result', id: message.id, payload: openedAt(message.uri ?? '', 1000, []) }
          : {
              type: 'error',
              id: message.id,
              error: { name: 'Error', code: null, message: 'no block here', detail: {} },
            }
      setTimeout(() => this.onmessage?.({ data: reply }), 0)
    }
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  /**
   * A remote `.mcool`: the root is a collection and refuses, and the rung under
   * it opens — which is the shape that makes the ladder unknowable until the
   * *second* round trip, and the case the held press is about.
   */
  class McoolWorker {
    static readonly rungs = ['1000', '5000', '10000']
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: unknown = null
    postMessage(message: { kind: string; id: number; uri?: string }): void {
      const uri = message.uri ?? ''
      const reply =
        message.kind !== 'open'
          ? {
              type: 'error',
              id: message.id,
              error: { name: 'Error', code: null, message: 'no block here', detail: {} },
            }
          : uri.includes('::')
            ? {
                type: 'result',
                id: message.id,
                payload: openedAt(uri, Number(uri.split('/').pop()), McoolWorker.rungs),
              }
            : {
                type: 'error',
                id: message.id,
                error: {
                  name: 'ViewerError',
                  code: 'mcool-root',
                  message: 'an .mcool is a collection of resolutions',
                  detail: { entries: McoolWorker.rungs, group: 'resolutions' },
                },
              }
      setTimeout(() => this.onmessage?.({ data: reply }), 0)
    }
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  /** The least an `open` can answer with and still be a map a deck can hold. */
  function openedAt(uri: string, binsize: number, entries: string[]): unknown {
    return {
      uri,
      layout: { kind: 'cooler', group: '/' },
      info: { format: 'HDF5::Cooler', 'bin-size': binsize, 'storage-mode': 'symmetric-upper' },
      metadata: {},
      binsize,
      shape: [400, 400],
      nGenomes: 0,
      nContigs: 1,
      nBins: 400,
      unassigned: null,
      displayExtent: [0, 400],
      entries,
      entryGroup: 'resolutions',
      cells: [],
      activeCells: [],
      cellNnz: null,
      hasGenomes: false,
      hasWeights: false,
      scoreColumns: ['count'],
      sourceBytes: 1024,
      sourceKind: 'remote',
    }
  }

  /** Let the stubbed worker's replies land, and the reads they provoke settle. */
  async function opened(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0))
  }

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).Worker = OneRungWorker
  })

  /**
   * What each companion is saying about the resolution it was asked for.
   *
   * Its own line, and read on its own: the line above it is about the *read* and
   * is cleared by the next successful one, which for a panel whose worker never
   * answers is the permanent `opening…` these tests would otherwise pick up.
   */
  function notesUnder(deck: PanelDeck): string[] {
    return all<HTMLElement>(deck.el, '.deck-panel:not(.is-lead) .deck-res-note')
      .map((node) => (node.textContent ?? '').trim())
      .filter((text) => text !== '')
  }

  it('takes every companion with the first map when its rung changes', async () => {
    const made = make()
    made.leadBinsize = 1000
    made.deck.apply(view(made))
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    await opened()
    expect(notesUnder(made.deck).join(' ')).not.toContain('level')

    // The breadcrumb's own picker, a link, or this deck's button: all three end
    // in the session reopening its file at another bin size.
    made.leadBinsize = 5000
    made.deck.apply(view(made))
    // A bin size is spelled by `resolutionLabel` — `5 kb`, not `5.0 kb` —
    // because a resolution is a round number by construction (§26.2); the
    // decimal belongs to a measured span.
    expect(notesUnder(made.deck).join(' ')).toContain('no 5 kb level')
  })

  it('says nothing on the first view, where nothing has moved yet', () => {
    // A companion opens on the first map's bin size (§3.4), so the first sighting
    // records the number and moves nobody.
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    made.leadBinsize = 1000
    made.deck.apply(view(made))
    expect(notesUnder(made.deck)).toEqual([])
  })

  it('names the file’s own resolution and what it has instead', async () => {
    const made = make()
    made.leadBinsize = 1000
    made.deck.apply(view(made))
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    await opened()
    made.leadBinsize = 20_000
    made.deck.apply(view(made))
    const note = notesUnder(made.deck).join(' ')
    // Its own resolution, and a real one: `0 bp` is what this used to read for
    // a panel with no answer yet, which is a measurement in a sentence about
    // what a file has and is not one this panel had.
    expect(note).toContain('staying at 1 kb')
    expect(note).toContain('carries one resolution only')
  })

  describe('the press', () => {
    it('reads the bin size from the starred map', async () => {
      const made = make()
      made.leadBinsize = 2000
      made.deck.apply(view(made))
      made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
      await opened()
      barButton(made.deck, 'resolutions').click()
      // The star is on the first map, so nothing was asked of the session — it
      // is already where the deck is going.
      expect(made.askedBinsize).toEqual([])
      expect(notesUnder(made.deck).join(' ')).toContain('no 2 kb level')
    })

    it('moves the first map too, when the star is on a companion', () => {
      const made = make()
      made.leadBinsize = 1000
      made.deck.apply(view(made))
      made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
      all<HTMLButtonElement>(made.deck.el, '.deck-star')[1].click()
      barButton(made.deck, 'resolutions').click()
      // The starred companion has never opened, so it has no bin size to offer
      // and the press has nothing to do — which is the honest answer, not a
      // fallback to the first map's.
      expect(made.askedBinsize).toEqual([])
    })

    it('names in the deck’s own line the maps that could not follow', async () => {
      const made = make()
      made.leadBinsize = 4000
      made.deck.apply(view(made))
      made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
      await opened()
      barButton(made.deck, 'resolutions').click()
      const warning = made.deck.el.querySelector('.deck-warning')
      expect(warning?.classList.contains('hidden')).toBe(false)
      expect(warning?.textContent).toContain('b.cool')
      expect(warning?.textContent).toContain('4 kb')
    })

    /**
     * The press that arrives before the bytes do.
     *
     * A remote `.mcool` is two round trips from knowing its own ladder — the
     * root refuses with the list of rungs, and only then does one of them
     * open — and the button is live throughout. Pressed in that window the
     * panel used to answer out of an empty `entries`: "staying at 0 bp: this
     * file has no 5 kb level, and carries one resolution only", under a
     * three-rung file whose descent was already heading for 5 kb because
     * `preferBinsize` is that very number. Nothing on that path calls
     * `sayResolution(null)`, so the sentence stood over a panel sitting at the
     * rung it was said to lack, and the deck's own line named the file in the
     * bar. Held instead: no claim is made about a file that has not answered,
     * and the press is settled from the ladder when it lands.
     */
    it('holds a press that a companion is still too early to answer', async () => {
      ;(globalThis as Record<string, unknown>).Worker = McoolWorker
      const made = make()
      made.leadBinsize = 5000
      made.deck.apply(view(made))
      made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.mcool' })
      // Pressed while the root open is still in flight — nothing has arrived,
      // so nothing is known, so nothing may be said.
      barButton(made.deck, 'resolutions').click()
      expect(made.deck.el.querySelector('.deck-warning')?.classList.contains('hidden')).toBe(true)

      await opened()
      // …and the answer, once the ladder is known: it had the rung all along
      // and is sitting on it, so there is nothing to say afterwards either.
      expect(notesUnder(made.deck)).toEqual([])
      expect(made.deck.mapList[1].label).toBe('b.mcool::5000')
    })
  })
})

describe('one scale across the deck', () => {
  /**
   * The regression, and it made the press look like it did nothing.
   *
   * A panel has two scales: what the *reader* has set, where `NaN` on a bound
   * means "nobody has", and what the rasteriser resolved — §7.1's auto rule, run
   * once per read, and the numbers printed under the key. The deck read the
   * first. On any map whose clip had never been nudged, which is most of them,
   * that is two `NaN`s: the ramp and the transform travelled across the deck and
   * the range did not, so every other map kept its own auto range and the button
   * appeared inert.
   */
  it('reads the clip the starred map is drawing with, not the one it was set to', () => {
    const made = make()
    const lead = leadPanel()
    made.deck.setLead(lead.panel)
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })

    const before = lead.state.askedShown
    barButton(made.deck, 'share').click()
    expect(lead.state.askedShown).toBeGreaterThan(before)
    expect(lead.state.askedSet).toBe(0)
  })

  it('hands the first map a starred companion’s clip through the session', () => {
    // Straight onto the panel would be undone by the next render: the first
    // map's colour lives in the view state, and its view is rebuilt from it.
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[1].click()
    barButton(made.deck, 'share').click()
    // The starred companion has no picture yet, so there is no clip to read and
    // nothing is pushed. Deliberately *not* the first map's as a fall-back: a
    // button that says "the starred map" must not quietly answer with another.
    expect(made.scales).toEqual([])
  })

  it('asks nothing of the session while the star is on the first map', () => {
    const made = make()
    const lead = leadPanel()
    made.deck.setLead(lead.panel)
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    barButton(made.deck, 'share').click()
    expect(made.scales).toEqual([])
  })
})

describe('putting the deck down', () => {
  it('gives the view back its own heading', () => {
    const { deck } = make()
    const view = viewWithHead()
    const head = view.firstElementChild as HTMLElement
    deck.frame(view)
    expect(head.parentElement?.classList.contains('deck-lead-head')).toBe(true)
    deck.destroy()
    expect(head.parentElement).toBe(view)
    expect(view.firstElementChild).toBe(head)
    // …and the deck's own line goes with the deck, not with the heading.
    expect(head.querySelector('.deck-maps')).toBeNull()
  })

  it('leaves nothing but the lead in the grid', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(deck.isEmpty).toBe(false)
    barButton(deck, 'close').click()
    expect(deck.isEmpty).toBe(true)
    expect(cellNames(deck)).toEqual(['lead.cool'])
  })

  it('releases every companion’s worker', () => {
    const spy = vi.spyOn(DeadWorker.prototype, 'terminate')
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    spy.mockClear()
    deck.destroy()
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

/**
 * How each companion is drawn, remembered against the file it is of.
 *
 * The deck's doctrine is that the view is shared and the presentation is not:
 * every panel takes the region, the level and the score from the lead and owns
 * its transform, its ramp, its clip and its chain. All of that is a decision a
 * reader makes per map, and until now none of it survived closing the window —
 * so a deck of four replicates each clipped to their own depth, which is what a
 * deck is arranged for, came back on one clip.
 *
 * Keyed by the **file**, because a slot id is minted per deck and names nothing
 * tomorrow. That is what the assertions below are actually about.
 */
describe('how each companion was drawn', () => {
  /**
   * The chain on a companion's heading, which is the one control with no bytes
   * behind it.
   *
   * `:not(.is-lead)`, because cell 0 now carries a chain of its own: the lead's,
   * which is a preference rather than a remembered look (§16.5).
   */
  function chain(deck: PanelDeck, index = 0): HTMLButtonElement {
    return all<HTMLButtonElement>(deck.el, '.deck-grid .deck-panel:not(.is-lead) .deck-lock')[index]
  }

  function remembered(): Array<Record<string, unknown>> {
    const raw = sessionStorage.getItem('metacooler-viewer:ui:deck-test:deck:looks')
    return raw === null ? [] : (JSON.parse(raw) as Array<Record<string, unknown>>)
  }

  it('writes down a chain the reader opened, against the file', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    chain(deck).click()
    expect(remembered()).toEqual([{ uri: 'https://x.example.org/b.cool', locked: false }])
    // Never the slot id: `p1` is minted per deck, so a record keyed on one would
    // name nothing in the window that reads it back.
    expect(JSON.stringify(remembered())).not.toMatch(/"p\d+"/)
  })

  it('opens a rebuilt panel back off the lead', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    chain(deck).click()
    const off = chain(deck).getAttribute('aria-pressed')
    // The chain is genuinely open, so the comparison below is about something.
    expect(off).toBe('false')

    // A second deck over the same file, which is what a reload, a restored
    // workspace and every reconcile that rebuilds a panel all amount to.
    const again = make()
    again.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(chain(again.deck).getAttribute('aria-pressed')).toBe(off)
  })

  it('leaves a companion nobody has touched on the lead', () => {
    // The default is the argument: a panel follows the deck unless somebody has
    // said otherwise, and "nothing remembered" is not somebody saying otherwise.
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(remembered()).toEqual([])
    const again = make()
    again.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    expect(chain(again.deck).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps one entry per file however often it moves', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    chain(deck).click()
    chain(deck).click()
    chain(deck).click()
    expect(remembered()).toHaveLength(1)
    expect(remembered()[0].locked).toBe(false)
  })
})

describe('the first map’s card, with no map starred (§16.5)', () => {
  /** What the deck remembered about how each companion is drawn. */
  function looks(): Array<Record<string, unknown>> {
    return (recall<Array<Record<string, unknown>>>('deck-test', 'deck:looks') ?? []) as Array<
      Record<string, unknown>
    >
  }

  it('is copied onto every companion, one moved setting at a time', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    made.deck.apply(view(made))
    all<HTMLButtonElement>(made.deck.el, '.deck-star')[0].click()
    made.deck.apply({ ...view(made), transform: 'log2', oe: true } as ViewState)
    const look = looks().find((row) => row['uri'] === 'https://x.example.org/b.cool')
    expect(look?.['transform']).toBe('log2')
    expect(look?.['oe']).toBe(true)
  })

  it('reaches no companion while a map is starred', () => {
    const made = make()
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    made.deck.apply(view(made))
    // The star is on the first map, so its card sets it alone.
    made.deck.apply({ ...view(made), transform: 'log2', oe: true } as ViewState)
    const look = looks().find((row) => row['uri'] === 'https://x.example.org/b.cool')
    expect(look?.['transform']).toBeUndefined()
    expect(look?.['oe']).not.toBe(true)
  })
})

describe('a box drawn on a companion (§16.3)', () => {
  /** The deck's own slot for its first companion, and the hook a box on it reaches. */
  function companion(deck: PanelDeck): { slot: { id: string; locked: boolean }; box(selection: unknown): void } {
    const inner = deck as unknown as {
      slots: Array<{ id: string; locked: boolean }>
      boxDrawn(slot: unknown, selection: unknown): void
    }
    const slot = inner.slots[0]
    return { slot, box: (selection) => inner.boxDrawn(slot, selection) }
  }

  const BOX = {
    rows: { label: 'chr1', range: [40_000_000, 70_000_000] },
    cols: { label: 'chr1', range: [40_000_000, 70_000_000] },
    diagonal: true,
    level: 'bin',
    anchor: { row: 0, col: 0 },
  }

  function pill(deck: PanelDeck): HTMLElement | null {
    return deck.el.querySelector<HTMLElement>('.deck-panel:not(.is-lead) .deck-place')
  }

  it('moves the whole deck there while the companion follows it', () => {
    const made = make()
    const lead = leadPanel()
    made.deck.setLead(lead.panel)
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    companion(made.deck).box(BOX)
    // Handed to the first map, whose own road re-reads the window for every map.
    expect(lead.state.selected).toEqual([BOX])
    expect(pill(made.deck)?.classList.contains('hidden')).toBe(true)
  })

  it('reads that window for the companion alone while its chain is open', () => {
    const made = make()
    const lead = leadPanel()
    made.deck.setLead(lead.panel)
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    made.deck.el.querySelector<HTMLButtonElement>('.deck-panel:not(.is-lead) .deck-lock')?.click()
    companion(made.deck).box(BOX)
    expect(lead.state.selected).toEqual([])
    expect(pill(made.deck)?.classList.contains('hidden')).toBe(false)
    expect(pill(made.deck)?.querySelector('.deck-place-label')?.textContent).toBe('chr1:40,000,001-70,000,000')
    // Remembered with the rest of how this map is drawn, beside its open chain.
    const looks = recall<Array<Record<string, unknown>>>('deck-test', 'deck:looks') ?? []
    const look = looks.find((row) => row['uri'] === 'https://x.example.org/b.cool')
    expect(look?.['place']).toEqual({ rows: 'chr1:40000000-70000000' })
    expect(look?.['locked']).toBe(false)
  })

  it('gives the window back when the pill’s × is pressed', () => {
    const made = make()
    made.deck.setLead(leadPanel().panel)
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    made.deck.el.querySelector<HTMLButtonElement>('.deck-panel:not(.is-lead) .deck-lock')?.click()
    companion(made.deck).box(BOX)
    pill(made.deck)?.querySelector<HTMLButtonElement>('.deck-place-clear')?.click()
    expect(pill(made.deck)?.classList.contains('hidden')).toBe(true)
    const looks = recall<Array<Record<string, unknown>>>('deck-test', 'deck:looks') ?? []
    expect(looks.find((row) => row['uri'] === 'https://x.example.org/b.cool')?.['place']).toBeUndefined()
  })

  it('gives the window back when the chain is closed again', () => {
    const made = make()
    made.deck.setLead(leadPanel().panel)
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    const chain = () => made.deck.el.querySelector<HTMLButtonElement>('.deck-panel:not(.is-lead) .deck-lock')
    chain()?.click()
    companion(made.deck).box(BOX)
    chain()?.click()
    expect(companion(made.deck).slot.locked).toBe(true)
    expect(pill(made.deck)?.classList.contains('hidden')).toBe(true)
  })
})

describe('a row of the Contact maps card dropped on a cell (§16.9)', () => {
  function dropRow(target: Element, row: unknown): void {
    const data = new Map([['application/x-metacooler-map', JSON.stringify(row)]])
    const transfer = { getData: (type: string) => data.get(type) ?? '', types: [...data.keys()], files: [], dropEffect: '' }
    const drop = new window.Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    target.dispatchEvent(drop)
  }

  it('lists the companions it can be dragged from', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    expect(deck.companionMaps().map((map) => map.label)).toEqual(['b.cool', 'c.cool'])
  })

  it('moves a companion into the empty cell it is dropped on', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.grow('beside')
    expect(cellNames(deck)).toEqual(['lead.cool', 'b.cool', 'empty'])
    const id = deck.companionMaps()[0]?.id
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null || id === undefined) throw new Error('no empty cell')
    dropRow(zone, { kind: 'companion', id })
    expect(cellNames(deck)).toEqual(['lead.cool', 'empty', 'b.cool'])
  })

  it('opens the first map a second time in the empty cell it is dropped on', () => {
    const { deck } = make({
      extra: { leadPicked: () => ({ uri: 'https://x.example.org/lead.cool', source: { kind: 'remote', url: 'https://x.example.org/lead.cool' } }) },
    })
    deck.grow('beside')
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    dropRow(zone, { kind: 'lead' })
    expect(deck.companionMaps().map((map) => map.uri)).toEqual(['https://x.example.org/lead.cool'])
  })

  it('opens the cells an edge names with the first map in them', () => {
    const { deck } = make({
      extra: { leadPicked: () => ({ uri: 'https://x.example.org/lead.cool', source: { kind: 'remote', url: 'https://x.example.org/lead.cool' } }) },
    })
    deck.growWithMap('beside', { kind: 'lead' })
    expect(deck.companionMaps()).toHaveLength(1)
  })

  it('opens a hidden map in the empty cell its row is dropped on, taking it off the hidden list', () => {
    const asked: string[] = []
    const { deck } = make({
      extra: {
        hiddenPicked: (id) => {
          asked.push(id)
          return { uri: 'https://x.example.org/c.cool', source: { kind: 'remote', url: 'https://x.example.org/c.cool' } }
        },
      },
    })
    deck.grow('beside')
    const zone = deck.el.querySelector('.deck-vacant')
    if (zone === null) throw new Error('no empty cell')
    dropRow(zone, { kind: 'hidden', id: 'hidden-1' })
    expect(asked).toEqual(['hidden-1'])
    expect(cellNames(deck)).toEqual(['lead.cool', 'c.cool'])
  })
})

describe('the eye on a map’s row of the Contact maps card (§16.9)', () => {
  it('takes a companion out of its cell and hands back what opens it again', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/c.cool' })
    const id = deck.companionMaps()[0]?.id ?? ''
    const picked = deck.takeMap(id)
    expect(picked?.uri).toBe('https://x.example.org/b.cool')
    expect(cellNames(deck)).toEqual(['lead.cool', 'c.cool'])
    // …and the eye again puts it back, in a cell of its own.
    if (picked === null) throw new Error('nothing taken')
    deck.showMap(picked)
    expect(cellNames(deck)).toEqual(['lead.cool', 'c.cool', 'b.cool'])
  })

  it('reopens a hidden map in the first empty cell before growing the deck', () => {
    const { deck } = make()
    deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    deck.grow('beside')
    const picked = deck.takeMap(deck.companionMaps()[0]?.id ?? '')
    if (picked === null) throw new Error('nothing taken')
    expect(cellNames(deck)).toEqual(['lead.cool', 'empty'])
    deck.showMap(picked)
    expect(cellNames(deck)).toEqual(['lead.cool', 'b.cool'])
  })

  it('takes nothing that is not a map', () => {
    const { deck } = make()
    deck.grow('beside')
    expect(deck.takeMap('lead')).toBeNull()
    expect(deck.takeMap('nope')).toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * The deck's window across a navigation (§16.3).
 *
 * A change of place clears the lock's window, and the first map to report one
 * afterwards sets it. A companion still drawing the place the deck has just
 * left redraws while its new block is on its way — and every redraw is a
 * report — so it used to be that first word: its old window was taken as the
 * new place's, pushed onto its new block when that landed, and its zoom read
 * the stretch around it. Widening a deck of the yeast maps from 400 kb to the
 * whole of chromosome IV left one map holding the right half of it, and the
 * first map was dragged there after it.
 *
 * The companion here is a real `MapPanel` in a real deck, reading through a
 * worker whose blocks can be held on their way; the first map is a stand-in
 * that records where the deck puts it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import type { MatrixPanel } from '@/ui/MatrixPanel'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

/** A 1 Mb sequence at 10 kb: bins 0–100. */
const SEQUENCE = 'chr1'
const BINS = 100
const BINSIZE = 10_000

function opened(uri: string): unknown {
  return {
    uri,
    layout: { kind: 'cooler', group: '/' },
    info: { format: 'HDF5::Cooler', 'bin-size': BINSIZE, 'storage-mode': 'symmetric-upper' },
    metadata: {},
    binsize: BINSIZE,
    shape: [BINS, BINS],
    nGenomes: 0,
    nContigs: 1,
    nBins: BINS,
    unassigned: null,
    displayExtent: [0, BINS],
    entries: [],
    entryGroup: 'resolutions',
    cells: [],
    activeCells: [],
    cellNnz: null,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
    sourceBytes: 4096,
    contacts: null,
    sourceKind: 'remote',
  }
}

function range(text: string): unknown {
  const [label, coords] = text.split(':')
  if (coords === undefined) return { kind: 'contig', label, extent: [0, BINS] }
  const [start, end] = coords.split('-').map((part) => Number(part.replace(/,/g, '')))
  return { kind: 'contig', label, extent: [Math.floor(start / BINSIZE), Math.ceil(end / BINSIZE)] }
}

/** A block over `rows`, one cell per bin, of the sequence that begins the file. */
function block(rows: [number, number]): unknown {
  const n = rows[1] - rows[0]
  const groups = [{ label: SEQUENCE, start: 0, end: n, unitStart: 0, unitBin: 0, unitLength: BINS * BINSIZE }]
  return {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n).fill(1),
    rowExtent: rows,
    colExtent: rows,
    rowGroups: groups,
    colGroups: groups.map((group) => ({ ...group })),
    level: 'bin',
    binsPerCell: 1,
  }
}

/** Blocks held on their way while this is set, and let go by {@link release}. */
let holding = false
let held: Array<() => void> = []

class LineWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: unknown = null
  postMessage(message: { kind: string; id: number; uri?: string; range?: string; rows?: [number, number] }): void {
    const payload =
      message.kind === 'open'
        ? opened(message.uri ?? '')
        : message.kind === 'range'
          ? range(message.range ?? '')
          : message.kind === 'matrix'
            ? block(message.rows ?? [0, BINS])
            : null
    const reply =
      payload === null
        ? { type: 'error', id: message.id, error: { name: 'Error', code: null, message: 'nothing here', detail: {} } }
        : { type: 'result', id: message.id, payload }
    const send = (): void => this.onmessage?.({ data: reply })
    if (holding && message.kind === 'matrix') held.push(send)
    else setTimeout(send, 0)
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function settled(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((done) => setTimeout(done, 0))
}

function release(): void {
  holding = false
  const sends = held
  held = []
  for (const send of sends) setTimeout(send, 0)
}

/**
 * The first map, as the deck sees it: a block of 10 kb cells over the region the
 * deck is at — or none while `reading`, as a first map is between a navigation
 * and its own block landing.
 */
function leadPanel() {
  /** Every window the deck put this map at. */
  const shown: Array<[number, number]> = []
  const at = { origin: 0, cells: BINS, reading: false }
  /** The deck's listener, so a test can make this map report. */
  let listener: ((rows: [number, number], cols: [number, number]) => void) | null = null
  const panel = {
    setViewportListener: (next: typeof listener) => {
      listener = next
    },
    setDeckExport: () => {},
    setCardFor: () => {},
    selectRegion: () => {},
    setLaneListener: () => {},
    setHoverListener: () => {},
    setLaneHoverListener: () => {},
    showLaneEcho: () => {},
    turnReach: () => null,
    setLaneFloor: () => {},
    remeasure: () => {},
    bpPerCell: () => BINSIZE,
    cellCount: () => (at.reading ? { rows: 1, cols: 1 } : { rows: at.cells, cols: at.cells }),
    blockLevel: () => 'bin',
    frameSpan: () => null,
    lockOrigin: () => ({ rows: at.origin, cols: at.origin }),
    blockSpan: () => ({ rows: at.cells * BINSIZE, cols: at.cells * BINSIZE, sequences: { rows: 1, cols: 1 } }),
    viewport: () => ({ rows: [0, at.cells], cols: [0, at.cells] }),
    get hasBlock(): boolean {
      return !at.reading
    },
    isTurned: () => false,
    showViewport: (rows: [number, number]) => {
      shown.push(rows)
      return !at.reading
    },
    // What the deck asks of a first map that reports: the sequences on its rows,
    // and the stretch it frames, for the cells that light it (§25).
    blockSequences: () => ({ rows: [SEQUENCE], cols: [SEQUENCE] }),
    framedRanges: () => [],
    scale: () => ({ vmin: Number.NaN, vmax: Number.NaN, transform: 'log10', colormap: 'default' }),
    shownScale: () => ({ vmin: -3, vmax: -1, transform: 'log10', colormap: 'default' }),
    baseScale: () => undefined,
  }
  return {
    panel: panel as unknown as MatrixPanel,
    shown,
    at,
    /** This map's block lands, and it reports its window: the whole of it. */
    lands: () => {
      at.reading = false
      listener?.([0, at.cells], [0, at.cells])
    },
  }
}

/** The stretch of sequence a map is showing, in base pairs, on its rows. */
function shownBp(map: MatrixPanel): [number, number] {
  const rows = map.viewport()?.rows ?? [0, 0]
  const from = map.lockOrigin().rows
  // `+ 0` so a window from the very start is 0 and not -0.
  return [Math.round(from + rows[0] * map.bpPerCell()) + 0, Math.round(from + rows[1] * map.bpPerCell()) + 0]
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = LineWorker
  holding = false
  held = []
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

/** A deck of the stand-in and one companion, at 200–600 kb. */
async function deckAt() {
  let maps: string | undefined
  const deck = new PanelDeck({
    onMapsChange: (next) => {
      maps = next
    },
    memoryKey: () => 'deck-lock-navigation-test',
  })
  document.body.append(deck.el)
  const view = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'view-head'
  head.append(document.createElement('span'))
  view.append(head)
  deck.frame(view)
  const lead = leadPanel()
  deck.setLead(lead.panel)
  const state = (region: string): ViewState =>
    ({ uri: 'lead.cool', view: 'region', region, ...(maps === undefined ? {} : { maps }) }) as unknown as ViewState
  /** The deck to `region`; the first map's own block of it lands when the test says so. */
  const go = (region: string): void => {
    const [from, to] = (range(region) as { extent: [number, number] }).extent
    lead.at.origin = from * BINSIZE
    lead.at.cells = to - from
    lead.at.reading = true
    deck.apply(state(region))
  }
  go(`${SEQUENCE}:200000-600000`)
  lead.lands()
  deck.add({ kind: 'remote', uri: 'https://x.example.org/rep2.cool' })
  await settled()
  const companion = deck.analysable()[0]?.panel.map ?? null
  if (companion === null) throw new Error('the companion drew nothing')
  /** What the companion's own redraw tells the deck: the window it is showing. */
  const redraw = (rows: [number, number]): void =>
    (companion as unknown as { viewportListener: (r: [number, number], c: [number, number]) => void }).viewportListener(
      rows,
      rows,
    )
  return { deck, lead, companion, redraw, go }
}

describe('the deck’s window across a navigation', () => {
  it('is the companion’s while it draws the deck’s place', async () => {
    const { lead, redraw } = await deckAt()
    lead.shown.length = 0
    // Cells 10–20 of a block from 200 kb: 300–400 kb, and the first map's block is the same.
    redraw([10, 20])
    expect(lead.shown).toEqual([[10, 20]])
  })

  it('is not the window a companion is still drawing of the place the deck has left', async () => {
    const { lead, companion, redraw, go } = await deckAt()
    // The whole sequence, with neither map's block of it in yet.
    holding = true
    go(SEQUENCE)
    lead.shown.length = 0
    // The companion's block of 200–600 kb is still on screen, and it redraws.
    redraw([10, 20])
    expect(lead.shown).toEqual([])
    // Its block of the whole sequence lands first: it shows the whole of it,
    // not 300–400 kb out of the place the deck has left.
    release()
    await settled()
    expect(shownBp(companion)).toEqual([0, 1_000_000])
    // The first map's lands, and the two are one window.
    lead.lands()
    await settled()
    expect(shownBp(companion)).toEqual([0, 1_000_000])
    // …and the companion's own word counts again: 300–400 kb.
    lead.shown.length = 0
    redraw([30, 40])
    expect(lead.shown).toEqual([[30, 40]])
  })
})

// @vitest-environment jsdom
/**
 * A deck **above bin level**, where one cell is a whole sequence (§16.3, §16.4).
 *
 * Everything the deck converts — the lock's window and the two pointer echoes —
 * is stated in base pairs from each block's own start, and that is right at bin
 * level and meaningless above it. A contig-level cell is a whole chromosome: it
 * has no width in base pairs, and the number `MatrixPanel.bpPerCell` answers
 * there is the file's *bin size*, which is a fact about the file and not a
 * length of anything on screen.
 *
 * Read as one anyway, the arithmetic produced two failures of opposite kinds
 * from the same line. Two roll-ups of one 16-chromosome genome, at 1 kb and at
 * 5 kb, reported spans of 16 kb and 80 kb and were told they had "resolved
 * against different sequences" — a positive false claim about two identical
 * chromosome lists, printed under the map, in the one configuration §16 exists
 * for. And the pointer echoes, which are not gated on the lock at all, went on
 * dividing by the bin size regardless: pointing at chromosome 12 of the 1 kb
 * panel put a mark on chromosome 3 of the 5 kb panel, `inside` and confident,
 * with nothing said anywhere.
 *
 * Both are fixed by carrying what the two grids genuinely share above bin
 * level, which is the **cell index**: cell `i` is sequence `i` in both. The
 * gate that lets that happen is `MatrixPanel.blockSpan`, which measures the
 * axis in sequence rather than in cells, and the two halves are pinned
 * separately here — first the span on a real panel, then the deck built round
 * one.
 *
 * `test/unit/panel-lock.test.ts` has the lock's own half of it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

// ---------------------------------------------------------------------------
// One genome, two files
// ---------------------------------------------------------------------------

/**
 * Sixteen chromosomes of 760,500 bp — 12.168 Mb of sequence, and a length that
 * divides by neither bin size.
 *
 * Deliberately not a round number of bins. The last bin of a sequence may be
 * short (§3.3) and a cell never straddles a sequence, so each of the sixteen
 * rounds up: 761 bins apiece at 1 kb and 153 at 5 kb, which is 12.176 Mb of
 * grid against 12.240 Mb. Sixty-four kilobases apart, on files that hold
 * exactly the same assembly — well outside a one-cell allowance and well
 * inside sixteen of them, which is what makes this the case the comparison has
 * to get right rather than a pair that agrees by luck.
 */
const CONTIGS = 16
const CONTIG_BP = 760_500
const binsPer = (binsize: number, contigBp = CONTIG_BP): number => Math.ceil(contigBp / binsize)

/** A contig-level roll-up, exactly as `handleAggregate` answers one. */
function rollUp(binsize: number, contigBp = CONTIG_BP): MatrixResult {
  const groups = Array.from({ length: CONTIGS }, (_, i) => ({
    label: `chr${i + 1}`,
    start: i,
    end: i + 1,
  }))
  return {
    nrows: CONTIGS,
    ncols: CONTIGS,
    values: new Float32Array(CONTIGS * CONTIGS),
    // Bin indices on the file's own grid, which is what an aggregate reports —
    // the axes are contigs but the extent is still the block it rolled up.
    rowExtent: [0, CONTIGS * binsPer(binsize, contigBp)],
    colExtent: [0, CONTIGS * binsPer(binsize, contigBp)],
    rowGroups: groups,
    colGroups: groups.map((group) => ({ ...group })),
    level: 'contig',
    contigsPerCell: 1,
    rowContigs: CONTIGS,
    colContigs: CONTIGS,
  } as unknown as MatrixResult
}

/** The least an `open` can answer with and still be a whole-file map. */
function opened(uri: string, binsize: number, contigBp = CONTIG_BP): unknown {
  const bins = CONTIGS * binsPer(binsize, contigBp)
  return {
    uri,
    layout: { kind: 'cooler', group: '/' },
    info: { format: 'HDF5::Cooler', 'bin-size': binsize, 'storage-mode': 'symmetric-upper' },
    metadata: {},
    binsize,
    shape: [bins, bins],
    nGenomes: 0,
    nContigs: CONTIGS,
    nBins: bins,
    unassigned: null,
    displayExtent: [0, bins],
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

/** What the companion's file is binned at, for the stub below to answer with. */
let companionBinsize = 5000
/** How long each of the companion's sequences is — halved for the one test that
 * puts a genuinely different assembly under the same sixteen names. */
let companionContigBp = CONTIG_BP

/** A reader that answers a whole-file open and a contig-level roll-up. */
class RollUpWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: unknown = null
  postMessage(message: { kind: string; id: number; uri?: string }): void {
    const payload =
      message.kind === 'open'
        ? opened(message.uri ?? '', companionBinsize, companionContigBp)
        : message.kind === 'aggregate'
          ? rollUp(companionBinsize, companionContigBp)
          : null
    const reply =
      payload === null
        ? {
            type: 'error',
            id: message.id,
            error: { name: 'Error', code: null, message: 'nothing here', detail: {} },
          }
        : { type: 'result', id: message.id, payload }
    setTimeout(() => this.onmessage?.({ data: reply }), 0)
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** Let the stub's replies land and the read they provoke settle. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0))
}

let teardown: DomTeardown
let hadWorker: unknown
const built: MatrixPanel[] = []

beforeEach(() => {
  // The stub context: `HeatmapView` refuses to be constructed without one, so
  // without it there is no `MatrixPanel` to ask any of this of.
  teardown = setUpDom({ canvas: 'stub' })
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = RollUpWorker
  companionBinsize = 5000
  companionContigBp = CONTIG_BP
  sessionStorage.clear()
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

// ---------------------------------------------------------------------------
// The span, on a real panel
// ---------------------------------------------------------------------------

/** A panel holding a roll-up, built and told its resolution as `MapPanel` does. */
function rolledUpPanel(binsize: number): MatrixPanel {
  const panel = new MatrixPanel({
    binsize,
    turn: { on: false, onChange: () => {}, onAvailable: () => {} },
  })
  built.push(panel)
  document.body.append(panel.el)
  // `binsize * (result.binsPerCell ?? 1)`, which is what both call sites pass
  // and which for a roll-up — carrying no `binsPerCell` — is the bin size.
  panel.setResolution(binsize)
  panel.setData(rollUp(binsize), `${binsize} bp`)
  return panel
}

describe('how much sequence a roll-up covers', () => {
  it('is measured in sequence, not in cells times the bin size', () => {
    const fine = rolledUpPanel(1000)
    const coarse = rolledUpPanel(5000)

    // What the deck used to compare: sixteen cells times a bin size, which is
    // 16 kb of one file against 80 kb of the other and is a measurement of
    // nothing at all.
    expect(fine.cellCount()).toEqual({ rows: CONTIGS, cols: CONTIGS })
    expect(coarse.cellCount()).toEqual({ rows: CONTIGS, cols: CONTIGS })
    expect(fine.bpPerCell()).toBe(1000)
    expect(coarse.bpPerCell()).toBe(5000)

    // What it compares now: the block's bin extent, which is the genome.
    expect(fine.blockSpan().rows).toBe(CONTIGS * binsPer(1000) * 1000)
    expect(coarse.blockSpan().rows).toBe(CONTIGS * binsPer(5000) * 5000)
    expect(fine.blockSpan().sequences).toEqual({ rows: CONTIGS, cols: CONTIGS })
  })

  it('says what a cell is, so nothing has to guess from the bin size', () => {
    expect(rolledUpPanel(1000).blockLevel()).toBe('contig')
  })
})

// ---------------------------------------------------------------------------
// The deck around one
// ---------------------------------------------------------------------------

/**
 * The session's own map, as the deck sees it — a roll-up of the same genome at
 * 1 kb.
 *
 * A stand-in rather than a `MatrixPanel`, as in `test/dom/deck.test.ts`, and
 * for the extra reason that the pointer echo has no other seam: the deck wires
 * the lead's hover listener itself, and a test that wants to point at cell 12
 * has to be the thing holding that listener.
 */
function leadRollUp() {
  const state = {
    hover: null as ((cell: { row: number; col: number } | null) => void) | null,
    laneHover: null as ((at: { axis: 'rows' | 'cols'; unit: number } | null) => void) | null,
  }
  const panel = {
    setViewportListener: () => {},
    setDeckExport: () => {},
    setCardFor: () => {},
    setLaneListener: () => {},
    setHoverListener: (listener: (cell: { row: number; col: number } | null) => void) => {
      state.hover = listener
    },
    setLaneHoverListener: (
      listener: (at: { axis: 'rows' | 'cols'; unit: number } | null) => void,
    ) => {
      state.laneHover = listener
    },
    showHoverEcho: () => {},
    showLaneEcho: () => {},
    turnReach: () => null,
    setLaneFloor: () => {},
    remeasure: () => {},
    bpPerCell: () => 1000,
    cellCount: () => ({ rows: CONTIGS, cols: CONTIGS }),
    blockLevel: () => 'contig',
    blockSpan: () => ({
      rows: CONTIGS * binsPer(1000) * 1000,
      cols: CONTIGS * binsPer(1000) * 1000,
      sequences: { rows: CONTIGS, cols: CONTIGS },
    }),
    viewport: () => ({ rows: [0, CONTIGS], cols: [0, CONTIGS] }),
    get hasBlock(): boolean {
      return true
    },
    isTurned: () => false,
    showViewport: () => true,
    // A colormap this build actually has: a companion seeds its own ramp from
    // the lead's, and the rasteriser refuses a name it cannot look up.
    scale: () => ({ vmin: Number.NaN, vmax: Number.NaN, transform: 'log10', colormap: 'viridis' }),
    shownScale: () => ({ vmin: 0, vmax: 1, transform: 'log10', colormap: 'viridis' }),
    baseScale: () => undefined,
  }
  return { panel: panel as unknown as MatrixPanel, state }
}

/** A deck of the lead above and one companion, both rolled up to contigs. */
async function deckOfTwo(): Promise<{
  deck: PanelDeck
  lead: ReturnType<typeof leadRollUp>
  companion: MatrixPanel
}> {
  let maps: string | undefined
  const deck = new PanelDeck({
    onMapsChange: (next) => {
      maps = next
    },
    memoryKey: () => 'deck-lock-level-test',
  })
  document.body.append(deck.el)
  const view = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'view-head'
  head.append(document.createElement('span'))
  view.append(head)
  deck.frame(view)

  const lead = leadRollUp()
  deck.setLead(lead.panel)
  deck.apply({
    uri: 'lead.cool',
    view: 'whole',
    level: 'contig',
    ...(maps === undefined ? {} : { maps }),
  } as unknown as ViewState)
  deck.add({ kind: 'remote', uri: 'https://x.example.org/rep2.cool' })
  await settled()

  const companion = deck.analysable()[0]?.panel.map
  if (companion === undefined || companion === null) throw new Error('the companion never drew')
  return { deck, lead, companion }
}

describe('a deck at contig level', () => {
  /**
   * The false accusation, and the one §16.4 calls worse than saying nothing:
   * "the same name resolved against different sequences", printed under two
   * panels holding identical chromosome lists.
   */
  it('lets two roll-ups of one genome follow each other', async () => {
    const { deck } = await deckOfTwo()
    const cell = deck.el.querySelector<HTMLElement>('.deck-grid > .deck-panel:not(.is-lead)')
    const note = cell?.querySelector('.deck-note.deck-unlocked:not(.deck-res-note)')
    expect(note?.textContent ?? '').toBe('')
    expect(cell?.classList.contains('is-unlocked')).toBe(false)
    expect(cell?.querySelector('.deck-lock')?.getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * The other half, and the one no note ever covered: the echoes are wired
   * unconditionally, so a wrong mark appears whether the lock is on or off.
   */
  it('marks the chromosome the pointer is on, not the bin size’s idea of it', async () => {
    const { lead, companion } = await deckOfTwo()
    const marks: Array<{ row: number; col: number } | null> = []
    companion.showHoverEcho = (cell) => {
      marks.push(cell)
    }

    // Chromosome 12 of the 1 kb map. Through base pairs this was
    // `(11 + 0.5) * 1000 / 5000` — chromosome 3 of the 5 kb map, `inside`, and
    // silent about it.
    lead.state.hover?.({ row: 11, col: 11 })
    expect(marks).toEqual([{ row: 11, col: 11 }])

    lead.state.hover?.(null)
    expect(marks[1]).toBeNull()
  })

  it('carries a track’s pointer to the same chromosome too', async () => {
    const { lead, companion } = await deckOfTwo()
    const marks: Array<{ axis: 'rows' | 'cols'; unit: number } | null> = []
    companion.showLaneEcho = (at) => {
      marks.push(at)
    }
    lead.state.laneHover?.({ axis: 'cols', unit: 11.5 })
    expect(marks).toEqual([{ axis: 'cols', unit: 11.5 }])
  })

  /**
   * And the refusal is still made where it is true. A companion of a genuinely
   * different assembly — the same sixteen names over half the sequence — is not
   * a map this window is a window on, and the gate has to keep saying so.
   */
  it('still refuses a companion whose sequences are not the lead’s', async () => {
    // The same sixteen names over half the sequence — 6.08 Mb of assembly
    // against the lead's 12.17 Mb, which is another genome however the two
    // spell their chromosomes.
    companionContigBp = CONTIG_BP / 2
    const { deck } = await deckOfTwo()
    const cell = deck.el.querySelector<HTMLElement>('.deck-grid > .deck-panel:not(.is-lead)')
    const note = cell?.querySelector('.deck-note.deck-unlocked:not(.deck-res-note)')
    expect(note?.textContent ?? '').toContain('resolved against different sequences')
    expect(cell?.classList.contains('is-unlocked')).toBe(true)
  })
})

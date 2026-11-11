// @vitest-environment jsdom
/**
 * What a companion's picture is said to be of (§18.4, §16.10).
 *
 * The framing a task runs on names the window it reads — *will run on
 * chr5:1-127,100,000 · 100 kb bins* in the drawer's head, the provenance line
 * and every table a run writes — and a figure's title names it too. Both took
 * the map's heading for the region it shows, and a deck's companion is headed
 * by its map's name: starred and asked for a task, it said *will run on
 * 4DNFI18UHVRO.mcool:1-127,100,000*. The subject is now read off the block
 * itself, in the file's own spelling, while the heading and the download name
 * keep the map's.
 *
 * First the panel's half, then a real `MapPanel` in a real deck, over a file
 * that spells the sequence `chrIV` where the deck says `IV` (§5.9).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { ViewState } from '@/types'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let hadWorker: unknown
const built: MatrixPanel[] = []

/** A 1 Mb sequence at 10 kb, spelt `chrIV` by the companion's file. */
const SEQUENCE = 'chrIV'
const BINS = 100
const BINSIZE = 10_000

/** A block over `rows` of the sequence that begins the file. */
function block(rows: [number, number], label = SEQUENCE): MatrixResult {
  const n = rows[1] - rows[0]
  const groups = [{ label, start: 0, end: n, unitStart: 0, unitBin: 0, unitLength: BINS * BINSIZE }]
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
  } as unknown as MatrixResult
}

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

/** `IV:…` answered as this file's `chrIV`, as a Roman numeral is matched (§5.9). */
function range(text: string): unknown {
  const coords = text.split(':')[1]
  if (coords === undefined) return { kind: 'contig', label: SEQUENCE, extent: [0, BINS] }
  const [start, end] = coords.split('-').map((part) => Number(part.replace(/,/g, '')))
  return { kind: 'contig', label: SEQUENCE, extent: [Math.floor(start / BINSIZE), Math.ceil(end / BINSIZE)] }
}

class ChrWorker {
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
    setTimeout(() => this.onmessage?.({ data: reply }), 0)
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function settled(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((done) => setTimeout(done, 0))
}

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = ChrWorker
  sessionStorage.clear()
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

/** The framing's first part: what it says the picture is of. */
function subjectOf(panel: MatrixPanel, uri = 'f.cool'): string {
  const framing = panel.analysisFraming(uri)
  expect(framing, 'the panel has no framing to report').not.toBeNull()
  return framing!.label.split(' · ')[0]
}

describe('the subject a map panel names', () => {
  function panelWith(subject?: () => string | null): MatrixPanel {
    const panel = new MatrixPanel({
      binsize: BINSIZE,
      detachedControls: true,
      hideTitle: true,
      caption: { file: 'f.cool', ...(subject === undefined ? {} : { subject }) },
    })
    built.push(panel)
    document.body.append(panel.el)
    return panel
  }

  it('is the one it is given, where its heading is a map’s name', () => {
    const panel = panelWith(() => SEQUENCE)
    panel.setData(block([20, 60]), 'Micro-C, Costantino 2020')
    expect(subjectOf(panel)).toBe('chrIV:200,001-600,000')
  })

  it('is its heading, as on every view but a companion, where it is given none', () => {
    const panel = panelWith(() => null)
    panel.setData(block([20, 60]), 'IV:200,001-600,000')
    expect(subjectOf(panel)).toBe('IV:200,001-600,000')
    const plain = panelWith()
    plain.setData(block([0, BINS]), 'IV')
    expect(subjectOf(plain)).toBe('IV')
  })
})

describe('a companion’s framing', () => {
  async function companionAt(region: string): Promise<MatrixPanel> {
    let maps: string | undefined
    const deck = new PanelDeck({
      onMapsChange: (next) => {
        maps = next
      },
      memoryKey: () => 'deck-companion-framing-test',
    })
    document.body.append(deck.el)
    const view = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'view-head'
    head.append(document.createElement('span'))
    view.append(head)
    deck.frame(view)
    const state = (): ViewState =>
      ({ uri: 'lead.cool', view: 'region', region, ...(maps === undefined ? {} : { maps }) }) as unknown as ViewState
    deck.apply(state())
    deck.add({ kind: 'remote', uri: 'https://x.example.org/rep2.cool' })
    await settled()
    const map = deck.analysable()[0]?.panel.map ?? null
    if (map === null) throw new Error('the companion drew nothing')
    return map
  }

  it('names the sequence, as its file spells it, and not the file', async () => {
    const map = await companionAt('IV:200000-600000')
    // It said `rep2.cool:200,001-600,000`, its heading taken for the region.
    expect(subjectOf(map, 'https://x.example.org/rep2.cool')).toBe('chrIV:200,001-600,000')
  })

  it('names the sequence alone where the whole of it is on screen', async () => {
    const map = await companionAt('IV')
    expect(subjectOf(map, 'https://x.example.org/rep2.cool')).toBe('chrIV')
  })
})

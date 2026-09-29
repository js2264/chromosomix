// @vitest-environment jsdom
/**
 * `ori` and `arms` on every map of a deck (§8.15, §16.2).
 *
 * The declarations are the session's, and a deck is maps of one genome — so a
 * window the first map frames across a circle's origin, `ori`, written with its
 * end below its start, is a window across that molecule's origin in every map.
 * A companion that had not been told the molecule was round read the region as
 * a typing mistake, and drew *End coordinate less than start* where its map
 * should have been; and `arms`, which the first map's card sets for every map
 * while nothing is starred, divided the first map alone.
 *
 * The companion here is a real `MapPanel` inside a real deck, reading through a
 * worker that answers the three requests it makes — the lap, the region, the
 * block — the way the reader does, and refuses a backwards region the way
 * `parseRegionString` does unless it was told the sequence is a circle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import type { MatrixPanel } from '@/ui/MatrixPanel'
import type { DerivePresentation } from '@/ui/MatrixPanel'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

/** A 1 Mb circle at 10 kb: bins 0–100. */
const SEQUENCE = 'NC_000913.3'
const BINS = 100
const BINSIZE = 10_000
/** `ori` on it, with the origin at 250 kb: half a lap past the origin round to half a lap before it. */
const ORI = `${SEQUENCE}:750000-749999`

interface Asked {
  kind: string
  range?: string
  circular?: readonly string[]
  rows?: [number, number]
  wrap?: [number, number]
}

/** Every request the companion made, in order. */
let asked: Asked[] = []

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

/** What `parseMetacoolerRange` answers, for the one sequence this file has. */
function range(text: string, circular: readonly string[] | undefined): unknown {
  const [label, coords] = text.split(':')
  if (label !== SEQUENCE) throw new Error(`unknown label ${label}`)
  if (coords === undefined) return { kind: 'contig', label, extent: [0, BINS] }
  const [start, end] = coords.split('-').map((part) => Number(part.replace(/,/g, '')))
  if (end < start) {
    if (circular?.includes(label) !== true) {
      throw new Error(
        'End coordinate less than start — unless the sequence joins its own ends, which is a tick ' +
          'in the circular column of the Chromosomes table',
      )
    }
    return { kind: 'contig', label, extent: [Math.floor(start / BINSIZE), BINS + Math.ceil(end / BINSIZE)] }
  }
  return { kind: 'contig', label, extent: [Math.floor(start / BINSIZE), Math.ceil(end / BINSIZE)] }
}

/** A block over `rows`, one cell per bin — enough for a panel to draw. */
function block(rows: [number, number]): unknown {
  const n = rows[1] - rows[0]
  const groups = [{ label: SEQUENCE, start: 0, end: n, offset: rows[0] }]
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

class CircleWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: unknown = null
  postMessage(message: {
    kind: string
    id: number
    uri?: string
    range?: string
    circular?: readonly string[]
    rows?: [number, number]
    wrap?: [number, number]
  }): void {
    asked.push({
      kind: message.kind,
      ...(message.range === undefined ? {} : { range: message.range }),
      ...(message.circular === undefined ? {} : { circular: message.circular }),
      ...(message.rows === undefined ? {} : { rows: message.rows }),
      ...(message.wrap === undefined ? {} : { wrap: message.wrap }),
    })
    let reply: unknown
    try {
      const payload =
        message.kind === 'open'
          ? opened(message.uri ?? '')
          : message.kind === 'range'
            ? range(message.range ?? '', message.circular)
            : message.kind === 'matrix'
              ? block(message.rows ?? [0, BINS])
              : null
      if (payload === null) throw new Error(`nothing here for ${message.kind}`)
      reply = { type: 'result', id: message.id, payload }
    } catch (err) {
      reply = {
        type: 'error',
        id: message.id,
        error: { name: 'Error', code: null, message: (err as Error).message, detail: {} },
      }
    }
    setTimeout(() => this.onmessage?.({ data: reply }), 0)
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function settled(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((done) => setTimeout(done, 0))
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = CircleWorker
  asked = []
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

/** The first map's arms, as `Session.armsOf` presents them: the frame of the molecule. */
function armsOf(window: number | undefined, circular = true): DerivePresentation['arms'] {
  return {
    window,
    frame: { startBin: 0, n: BINS, origin: 25, circular, binsize: BINSIZE, length: BINS * BINSIZE, originBp: 250_000 },
    refusal: null,
    onCentre: () => {},
  }
}

/** A deck of the first map and one companion, over a circle the session may or may not declare. */
async function deckOver(options: { circular: readonly string[]; region: string; arms?: number; line?: boolean }) {
  let maps: string | undefined
  let arms = options.arms
  const deck = new PanelDeck({
    onMapsChange: (next) => {
      maps = next
    },
    memoryKey: () => 'deck-circular-test',
    circular: () => options.circular,
    derive: () =>
      ({
        expected: arms !== undefined,
        smooth: '0',
        arms: armsOf(arms, options.line !== true),
      }) as unknown as DerivePresentation,
  })
  document.body.append(deck.el)
  const view = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'view-head'
  head.append(document.createElement('span'))
  view.append(head)
  deck.frame(view)
  const state = (): ViewState =>
    ({ uri: 'lead.cool', view: 'region', region: options.region, ...(maps === undefined ? {} : { maps }), ...(arms === undefined ? {} : { arms, oe: true }) }) as unknown as ViewState
  deck.apply(state())
  deck.add({ kind: 'remote', uri: 'https://x.example.org/rep2.cool' })
  await settled()
  const companion = (): MatrixPanel | null => deck.analysable()[0]?.panel.map ?? null
  return {
    deck,
    companion,
    note: () => deck.el.querySelector('.deck-grid > .deck-panel:not(.is-lead) .deck-note')?.textContent ?? '',
    setArms: async (next: number | undefined) => {
      arms = next
      deck.apply(state())
      await settled()
    },
  }
}

describe('a companion framed on a circle’s origin', () => {
  it('reads the window across the junction, as the first map does', async () => {
    const { companion, note } = await deckOver({ circular: [SEQUENCE], region: ORI })
    // The lap first, which is what the wrap is read modulo; then the region,
    // told the sequence is a circle; then the block, wrapped round it.
    const ranges = asked.filter((request) => request.kind === 'range')
    expect(ranges.map((request) => request.range)).toEqual([SEQUENCE, ORI])
    expect(ranges[1].circular).toEqual([SEQUENCE])
    const read = asked.find((request) => request.kind === 'matrix')
    expect(read?.rows).toEqual([75, 175])
    expect(read?.wrap).toEqual([0, BINS])
    expect(note()).not.toMatch(/End coordinate less than start/)
    expect(companion()).not.toBeNull()
  })

  it('is refused as before where the sequence is not declared a circle', async () => {
    const { note } = await deckOver({ circular: [], region: ORI })
    expect(note()).toMatch(/End coordinate less than start/)
    // …and nothing asked of the lap, which is only asked of a circle.
    expect(asked.filter((request) => request.kind === 'range').map((request) => request.range)).toEqual([ORI])
  })

  it('reads a window that stays on the line as it always did, circle or not', async () => {
    await deckOver({ circular: [SEQUENCE], region: `${SEQUENCE}:100000-400000` })
    const read = asked.find((request) => request.kind === 'matrix')
    expect(read?.rows).toEqual([10, 40])
    expect(read?.wrap).toBeUndefined()
  })
})

/** Whether a word of a card's picture row is offered, and whether it is lit. */
function wordsOf(card: HTMLElement | null | undefined): Record<string, { shown: boolean; on: boolean }> {
  return Object.fromEntries(
    [...(card?.querySelectorAll('.btn-word') ?? [])].map((node) => [
      node.textContent?.trim() ?? '',
      { shown: !node.classList.contains('hidden'), on: node.getAttribute('aria-pressed') === 'true' },
    ]),
  )
}

describe('the arms on a companion', () => {
  it('follow the first map’s card while nothing is starred', async () => {
    const { deck, companion, setArms } = await deckOver({ circular: [SEQUENCE], region: SEQUENCE })
    deck.setStarred(null)
    const card = (): HTMLElement | undefined => companion()?.controlsEl
    expect(wordsOf(card())['arms']).toEqual({ shown: true, on: false })
    await setArms(50)
    // Along the arms, and the O/E with it, as the first map's press does.
    expect(wordsOf(card())['arms']).toEqual({ shown: true, on: true })
    expect(wordsOf(card())['O/E']?.on).toBe(true)
    await setArms(undefined)
    expect(wordsOf(card())['arms']?.on).toBe(false)
  })

  it('are offered on the companion’s own card, with `ori`, and set that map alone', async () => {
    const { deck, companion, setArms } = await deckOver({ circular: [SEQUENCE], region: SEQUENCE })
    const card = companion()?.controlsEl
    // Both used to be hidden there: the companion was handed no arms at all.
    expect(wordsOf(card)).toMatchObject({
      'O/E': { shown: true },
      arms: { shown: true },
      ori: { shown: true },
    })
    // Starred, its card is its own: `arms` there is this map's.
    const id = deck.analysable()[0]?.map
    if (id === undefined) throw new Error('no companion')
    deck.setStarred(id)
    ;[...(card?.querySelectorAll<HTMLButtonElement>('.btn-word') ?? [])]
      .find((node) => node.textContent?.trim() === 'arms')
      ?.click()
    expect(wordsOf(card)['arms']?.on).toBe(true)
    // …and the first map's own `arms` moving does not move it while it is starred.
    await setArms(20)
    await setArms(undefined)
    expect(wordsOf(card)['arms']?.on).toBe(true)
  })
})

/** The options of a card's score picker, by value. */
function scoresOf(card: HTMLElement | null | undefined): string[] {
  for (const field of card?.querySelectorAll('.field') ?? []) {
    if (field.querySelector('.field-label')?.textContent !== 'score') continue
    return [...(field.querySelector('select')?.options ?? [])].map((option) => option.value)
  }
  return []
}

/**
 * The baseline along both arms on a companion (§7.5, §8.15): offered where the
 * first map's frame is a circle — the molecule's, and so this map's too — and
 * drawn, once picked, from this map's own cells.
 */
describe('the baseline along both arms on a companion', () => {
  it('is offered on the companion’s picker where the first map is on a circle, and not on a line', async () => {
    const circle = await deckOver({ circular: [SEQUENCE], region: SEQUENCE })
    expect(scoresOf(circle.companion()?.controlsEl)).toContain('armbaseline')
    circle.deck.destroy()
    const line = await deckOver({ circular: [], region: SEQUENCE, line: true })
    expect(scoresOf(line.companion()?.controlsEl)).not.toContain('armbaseline')
  })

  it('is drawn once picked there, with `arms` greyed on that card', async () => {
    const { deck, companion } = await deckOver({ circular: [SEQUENCE], region: SEQUENCE })
    const id = deck.analysable()[0]?.map
    if (id === undefined) throw new Error('no companion')
    deck.setStarred(id)
    const select = [...(companion()?.controlsEl.querySelectorAll<HTMLSelectElement>('select') ?? [])].find(
      (node) => [...node.options].some((option) => option.value === 'armbaseline'),
    )
    if (select === undefined) throw new Error('no score picker offering the baseline along the arms')
    select.value = 'armbaseline'
    select.dispatchEvent(new Event('change'))
    await settled()
    expect(companion()?.figureCaption(new Date()).detail).toContain('expected along the arms')
    const arms = [...(companion()?.controlsEl.querySelectorAll<HTMLButtonElement>('.btn-word') ?? [])].find(
      (node) => node.textContent?.trim() === 'arms',
    )
    expect(arms?.disabled).toBe(true)
  })
})

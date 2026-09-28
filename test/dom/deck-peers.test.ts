// @vitest-environment jsdom
/**
 * The deck telling the session which maps have opened (§18.1).
 *
 * A task that compares two files — *Reproducibility* — applies only while a
 * second map is open, and the Analysis column asks that when it is built. A
 * deck's companion opens its file a moment later, on its own worker, and
 * nothing told the column: the row sat greyed asking for the map that was
 * already on screen beside the first, until some other run happened to
 * refresh it. `onPeersChange` is that telling — once when a companion's file
 * opens, never for the reads after it, and once more when its cell closes.
 *
 * The companion's worker here answers the one request that opens the file and
 * refuses every other, so the panel opens, fails to draw, and settles — which
 * is all the deck is asked to notice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

/** What a cooler says when it opens, as far as a companion reads it here. */
function opened(uri: string): unknown {
  return {
    uri,
    layout: { kind: 'cool' },
    info: {},
    metadata: {},
    binsize: 1000,
    shape: [100, 100],
    nGenomes: 0,
    nContigs: 1,
    nBins: 100,
    unassigned: null,
    displayExtent: [0, 100],
    entries: [],
    entryGroup: '',
    cells: [],
    activeCells: [],
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
  }
}

/** A reader worker that opens any file and reads nothing out of it. */
class OpeningWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: unknown = null
  postMessage(message: { id: number; kind: string; uri?: string }): void {
    const reply =
      message.kind === 'open'
        ? { type: 'result', id: message.id, payload: opened(message.uri ?? '') }
        : {
            type: 'error',
            id: message.id,
            error: { name: 'Error', code: null, message: 'nothing to read in this test', detail: {} },
          }
    setTimeout(() => this.onmessage?.({ data: reply }), 0)
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = OpeningWorker
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

function viewWithHead(): HTMLElement {
  const view = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'view-head'
  const summary = document.createElement('span')
  summary.className = 'summary'
  head.appendChild(summary)
  view.appendChild(head)
  return view
}

interface Made {
  deck: PanelDeck
  told: number
  published: Array<string | undefined>
}

function make(): Made {
  const made: Made = { deck: null as unknown as PanelDeck, told: 0, published: [] }
  made.deck = new PanelDeck({
    onMapsChange: (maps) => made.published.push(maps),
    memoryKey: () => 'deck-peers-test',
    leadName: () => 'lead.cool',
    leadLabel: () => 'lead.cool',
    onPeersChange: () => {
      made.told++
    },
  })
  document.body.appendChild(made.deck.el)
  made.deck.frame(viewWithHead())
  return made
}

function view(made: Made, region = 'chr1'): ViewState {
  const maps = made.published[made.published.length - 1]
  return {
    uri: 'lead.cool',
    view: 'region',
    region,
    ...(maps === undefined ? {} : { maps }),
  } as unknown as ViewState
}

describe('the maps a deck has open', () => {
  it('are told once a companion’s file opens, and not before', async () => {
    const made = make()
    made.deck.apply(view(made))
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    // A cell with a file on its way is not yet a map anything can be compared with.
    expect(made.told).toBe(0)
    await vi.waitFor(() => expect(made.told).toBe(1))
    const [companion] = made.deck.analysable()
    expect(companion.panel.openInfo?.binsize).toBe(1000)
  })

  it('are not told again for a read that changes nothing about them', async () => {
    const made = make()
    made.deck.apply(view(made))
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    await vi.waitFor(() => expect(made.told).toBe(1))
    // Another place is another block read and another settle, and the same
    // open file: the column it would refresh walks every task.
    made.deck.apply(view(made, 'chr2'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(made.told).toBe(1)
  })

  it('are told again when a companion’s cell closes', async () => {
    const made = make()
    made.deck.apply(view(made))
    made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
    await vi.waitFor(() => expect(made.told).toBe(1))
    made.deck.el.querySelector<HTMLButtonElement>('.deck-panel:not(.is-lead) .btn-close')?.click()
    expect(made.deck.analysable()).toHaveLength(0)
    expect(made.told).toBe(2)
  })
})

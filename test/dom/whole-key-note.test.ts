// @vitest-environment jsdom
/**
 * The whole-genome map's key names the resolution the line above it does
 * (§7.1).
 *
 * The view built its map at the whole file's pooled grid where the open map's
 * bin size belonged, and the key measures a block that carries no bin size of
 * its own — a block from the rung the file was opened at — from that base:
 * K562 chr7 zoomed to its open 10 kb rung was keyed `760 kb` under a line
 * reading `10 kb`, and E. coli at its open 200 bp `1.2 kb`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WholeView } from '@/ui/WholeView'
import { REFINE_DEFAULT, setRefineEnabled } from '@/ui/refine'
import type { ReaderClient } from '@/worker/client'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const views: WholeView[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  setRefineEnabled(REFINE_DEFAULT)
  teardown()
})

/** A reader of a file with no ladder, answering every `matrix` read from its open map. */
function reader(): ReaderClient {
  const answer = (request: Record<string, unknown>): MatrixResult => {
    const rows = request.rows as [number, number]
    const k = (request.binsPerCell as number | undefined) ?? 1
    const cells = Math.max(1, Math.ceil((rows[1] - rows[0]) / k))
    return {
      nrows: cells,
      ncols: cells,
      values: new Float32Array(cells * cells).fill(1),
      rowExtent: [rows[0] / k, rows[0] / k + cells],
      colExtent: [rows[0] / k, rows[0] / k + cells],
      rowGroups: [{ label: 'chr1', start: 0, end: cells, unitStart: 0 }],
      colGroups: [{ label: 'chr1', start: 0, end: cells, unitStart: 0 }],
      level: 'bin',
      binsPerCell: k,
    } as unknown as MatrixResult
  }
  return {
    request: async (request: Record<string, unknown>) => answer(request),
    cancellable: (request: Record<string, unknown>) => ({
      promise: Promise.resolve().then(() => answer(request)),
      cancel: () => {},
    }),
  } as unknown as ReaderClient
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 30; tick++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('the whole-genome map’s key', () => {
  it('names the grid the line above it names, for a block of the open map', async () => {
    setRefineEnabled(true)
    // 3,088 Mb at 10 kb: 308,827 bins, which the whole file's own plan pools
    // seventy-odd to the cell.
    const nBins = 308_827
    const view = new WholeView({
      client: reader(),
      binsize: 10_000,
      nBins,
      displayExtent: [0, nBins],
      nnz: null,
      nContigs: 24,
      level: 'bin',
      scale: {},
      balance: true,
      hasWeights: true,
      noun: 'chromosome',
      namesGenomes: false,
      onScoreChange: () => {},
      onScaleChange: () => {},
      onOpenRegion: () => {},
      onError: () => {},
    })
    views.push(view)
    document.body.append(view.el)
    await settle()
    // A file with no ladder is read whole behind the gate, which says what that
    // costs — at the pooled grid the old base was.
    const compute = [...view.el.querySelectorAll('button')].find((node) => node.textContent === 'compute whole genome')
    compute?.click()
    await settle()
    const line = view.el.textContent ?? ''
    const said = /effective resolution: ([\d.]+ (?:bp|kb|Mb))/.exec(line)?.[1]
    expect(said).toBeDefined()
    const note = view.el.querySelector('.map-key-note')?.textContent ?? ''
    expect(note).toBe(said)
  })
})

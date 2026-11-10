// @vitest-environment jsdom
/**
 * A region view's first read (§2, §7.2).
 *
 * While *Refine on zoom* is on, which is the default, the first read is
 * **screen-sized**: the stored rung and the pooling within it that put about a
 * cell on each pixel of the panel, so a chromosome opened at a fine resolution
 * is a few hundred kilobytes rather than tens of megabytes, and the ladder reads
 * finer as the reader zooms. No coarser stand-in goes before it: it is already
 * the cheapest picture of the window there is. Off, the window is read as
 * memory allows — from the rung that pools it for nothing — with a preview first
 * where one is worth a read, as before.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RegionView } from '@/ui/RegionView'
import { REFINE_DEFAULT, setRefineEnabled } from '@/ui/refine'
import type { ReaderClient } from '@/worker/client'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const views: RegionView[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  setRefineEnabled(REFINE_DEFAULT)
  teardown()
})

/** chr1 of a 10 kb `.mcool` with a zoomify ladder: 19,547 bins. */
const BINS = 19_547
const RUNGS = ['10000', '20000', '40000', '80000', '160000', '320000', '640000']

type Asked = Record<string, unknown> & { kind: string }

/** A reader that answers the two questions a region view asks, and remembers them. */
function reader(asked: Asked[]): ReaderClient {
  const answer = (request: Asked): unknown => {
    asked.push(request)
    if (request.kind === 'range') return { kind: 'contig', label: 'chr1', extent: [0, BINS] }
    if (request.kind === 'matrix') {
      const rows = request.rows as [number, number]
      const rung = request.rung === undefined ? 10_000 : Number(request.rung)
      const span = Math.ceil(((rows[1] - rows[0]) * 10_000) / rung)
      // Pooled as the worker's own plan pools a read that names none, so the
      // block stays a picture's size.
      const k = (request.binsPerCell as number | undefined) ?? Math.max(1, Math.ceil(span / 4096))
      const cells = Math.max(1, Math.ceil(span / k))
      return {
        nrows: cells,
        ncols: cells,
        values: new Float32Array(cells * cells),
        rowExtent: [0, span],
        colExtent: [0, span],
        rowGroups: [{ label: 'chr1', start: 0, end: cells, unitStart: 0 }],
        colGroups: [{ label: 'chr1', start: 0, end: cells, unitStart: 0 }],
        level: 'bin',
        binsPerCell: k,
        ...(request.rung === undefined ? {} : { binsize: rung, source: { rows, cols: rows } }),
      } as unknown as MatrixResult
    }
    throw new Error(`not asked of this reader: ${request.kind}`)
  }
  return {
    request: async (request: Asked) => answer(request),
    cancellable: (request: Asked) => ({ promise: Promise.resolve().then(() => answer(request)), cancel: () => {} }),
  } as unknown as ReaderClient
}

function open(asked: Asked[]): RegionView {
  const view = new RegionView({
    client: reader(asked),
    binsize: 10_000,
    rungs: RUNGS,
    region: 'chr1',
    scale: { transform: 'log10', colormap: 'default' },
    balance: false,
    hasWeights: false,
    noun: 'chromosome',
    onScoreChange: () => {},
    onChangeRegion: () => {},
    onScaleChange: () => {},
    onOpenGenome: () => {},
    onError: (err: unknown) => {
      throw err
    },
  } as unknown as ConstructorParameters<typeof RegionView>[0])
  views.push(view)
  document.body.append(view.el)
  return view
}

/** The matrix reads asked for, once the view has made its first picture. */
async function matrixReads(asked: Asked[]): Promise<Asked[]> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
  return asked.filter((request) => request.kind === 'matrix')
}

describe('a region view’s first read', () => {
  it('is screen-sized with refine on: one read, from the rung that fills the panel', async () => {
    setRefineEnabled(true)
    const asked: Asked[] = []
    open(asked)
    const reads = await matrixReads(asked)
    // The panel is not laid out under jsdom, so it is sized from the window:
    // 70% of 768 pixels is 538, and 195 Mb over 538 pixels is a cell of 363 kb
    // — the 320 kb rung, read as it is. No preview went before it.
    expect(reads).toHaveLength(1)
    expect(reads[0].preview).toBeUndefined()
    expect(reads[0].rung).toBe('320000')
    expect(reads[0].binsPerCell).toBeUndefined()
  })

  it('is read as memory allows with refine off, a preview first', async () => {
    setRefineEnabled(false)
    const asked: Asked[] = []
    open(asked)
    const reads = await matrixReads(asked)
    // The preview from the coarsest rung that still puts 256 cells across it,
    // then the block, pooled for nothing from the rung that is its own grid.
    expect(reads[0].preview).toBe(true)
    expect(reads[0].rung).toBe('640000')
    // The reader pools 19,547 bins five to a cell, and no rung is that grid (a
    // 50 kb cell is not a whole number of 20 or 40 kb bins): the open map, with
    // the plan left to the reader.
    const block = reads[1]
    expect(block.preview).toBeUndefined()
    expect(block.rung).toBeUndefined()
    expect(block.binsPerCell).toBeUndefined()
  })
})

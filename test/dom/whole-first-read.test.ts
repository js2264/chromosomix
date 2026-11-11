// @vitest-environment jsdom
/**
 * The whole-genome view's first read (§2, §3.4).
 *
 * It used to be planned from the entry the link opened the file at: that map's
 * bins pooled to 4,096 cells, then the coarsest stored rung no bigger than such
 * a cell. A K562 `.mcool` was drawn at 1 Mb — 3,102 bins, 17 MB — from its 1 Mb
 * entry, and at 500 kb — 6,188 bins, 57 MB — from its 25 kb one. It is now
 * planned by the rule every map view's first read is: with *Refine on zoom* on,
 * the stored rung nearest a cell to each pixel of the panel, whichever entry
 * was opened; off, the resolution picked — the open map's where none is — or
 * the finest stored rung that fits a block where the genome is too wide for it.
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

/** A 4DN `.mcool`'s ladder, and a 3,088 Mb human genome. */
const RUNGS = ['1000', '2000', '5000', '10000', '25000', '50000', '100000', '250000', '500000', '1000000', '2500000']
const GENOME_BP = 3_088_269_832

type Asked = Record<string, unknown> & { kind: string }

/** A reader that answers a whole-genome `matrix` read, and remembers what it was asked. */
function reader(asked: Asked[], binsize: number): ReaderClient {
  const answer = (request: Asked): unknown => {
    asked.push(request)
    if (request.kind !== 'matrix') throw new Error(`not asked of this reader: ${request.kind}`)
    const rows = request.rows as [number, number]
    const rung = request.rung === undefined ? binsize : Number(request.rung)
    const span = Math.ceil(((rows[1] - rows[0]) * binsize) / rung)
    const k = (request.binsPerCell as number | undefined) ?? 1
    const cells = Math.max(1, Math.ceil(span / k))
    return {
      nrows: cells,
      ncols: cells,
      values: new Float32Array(1),
      rowExtent: [0, span],
      colExtent: [0, span],
      rowGroups: [{ label: 'chr1', start: 0, end: cells, unitStart: 0 }],
      colGroups: [{ label: 'chr1', start: 0, end: cells, unitStart: 0 }],
      level: 'bin',
      binsPerCell: k,
      ...(request.rung === undefined ? {} : { binsize: rung, source: { rows, cols: rows } }),
    } as unknown as MatrixResult
  }
  return {
    request: async (request: Asked) => answer(request),
    cancellable: (request: Asked) => ({ promise: Promise.resolve().then(() => answer(request)), cancel: () => {} }),
  } as unknown as ReaderClient
}

/** The genome opened at `binsize`, with `pick` picked; its first `matrix` read. */
async function firstRead(binsize: number, pick: number | null = null): Promise<Asked> {
  const asked: Asked[] = []
  const nBins = Math.ceil(GENOME_BP / binsize)
  const view = new WholeView({
    client: reader(asked, binsize),
    binsize,
    rungs: RUNGS,
    ...(pick === null
      ? {}
      : { picked: () => ({ binsize: pick, rung: { name: String(pick), binsize: pick }, factor: 1 }) }),
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
  for (let tick = 0; tick < 20 && !asked.some((one) => one.kind === 'matrix'); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const read = asked.find((one) => one.kind === 'matrix')
  if (read === undefined) throw new Error('the whole-genome view read nothing')
  return read
}

describe('the whole-genome view’s first read', () => {
  it('is the same stored rung whichever entry the file was opened at, while the zoom picks', async () => {
    setRefineEnabled(true)
    const from25kb = await firstRead(25_000)
    const from1Mb = await firstRead(1_000_000)
    // A screen's width of cells over 3,088 Mb: the coarse end of the ladder,
    // stored, and never pooled.
    expect(from25kb.rung).toBe(from1Mb.rung)
    expect(RUNGS).toContain(from25kb.rung)
    expect(from25kb.binsPerCell).toBeUndefined()
    expect(from1Mb.binsPerCell).toBeUndefined()
  })

  it('is the open map as memory allows with the zoom off, from the finest stored rung that fits', async () => {
    setRefineEnabled(false)
    // 123,531 bins at 25 kb: the 500 kb rung's 6,177 are the finest that fit
    // a block read bin for bin.
    expect((await firstRead(25_000)).rung).toBe('500000')
    // At 1 Mb the genome fits: the open map itself, bin for bin.
    const open = await firstRead(1_000_000)
    expect(open.rung).toBeUndefined()
    expect(open.binsPerCell).toBeUndefined()
  })

  it('is the resolution picked with the zoom off, whatever entry is open', async () => {
    setRefineEnabled(false)
    expect((await firstRead(25_000, 1_000_000)).rung).toBe('1000000')
  })
})

describe('the whole-genome view’s second reading below the diagonal (§5.10)', () => {
  /** The genome opened at 25 kb with a lower reading; both triangles' first reads. */
  async function bothReads(rungs: string[]): Promise<{ upper: Asked; lower: Asked }> {
    const asked: Asked[] = []
    const lowerAsked: Asked[] = []
    const binsize = 25_000
    const nBins = Math.ceil(GENOME_BP / binsize)
    const view = new WholeView({
      client: reader(asked, binsize),
      binsize,
      rungs,
      nBins,
      displayExtent: [0, nBins],
      // A file small enough not to be asked about first (§7.3).
      nnz: 1_000,
      nContigs: 24,
      level: 'bin',
      scale: {},
      balance: true,
      hasWeights: true,
      noun: 'chromosome',
      namesGenomes: false,
      lowerRead: { client: reader(lowerAsked, binsize), onFailure: () => {} },
      onScoreChange: () => {},
      onScaleChange: () => {},
      onOpenRegion: () => {},
      onError: () => {},
    })
    views.push(view)
    document.body.append(view.el)
    for (let tick = 0; tick < 40 && !lowerAsked.some((one) => one.kind === 'matrix'); tick++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const upper = asked.find((one) => one.kind === 'matrix')
    const lower = lowerAsked.find((one) => one.kind === 'matrix')
    if (upper === undefined || lower === undefined) throw new Error('a triangle was not read')
    return { upper, lower }
  }

  it('is read by the same plan as the block above it, on a ladder or not', async () => {
    setRefineEnabled(true)
    for (const rungs of [[], RUNGS]) {
      const { upper, lower } = await bothReads(rungs)
      // Read on a grid of its own, it was a block of another shape, its cells
      // laid under the wrong half of the picture.
      expect([lower.rung, lower.binsPerCell]).toEqual([upper.rung, upper.binsPerCell])
    }
  })
})

/**
 * The import layer: the probe, the suggestion, the ladder and the scope.
 *
 * The pieces between "here is a file" and "here is a map", none of which the
 * binner or the store covers. The one worth reading is the indexed probe: a
 * `.px2` is the only thing in this application that states an exact record
 * count before a byte of data is read, and everything the dialog says about
 * cost depends on it being read correctly.
 */

import { describe, expect, it } from 'vitest'

import { binPairs } from '@/pairs/bin'
import { readPairsHeader } from '@/pairs/format'
import { aggregatePixels, ladderSizes, LADDER_MULTIPLIERS, MAX_LADDER_RUNGS } from '@/pairs/ladder'
import {
  estimateCost,
  formatBp,
  importPairs,
  indexedPairs,
  probePairs,
  roundToSeries,
  suggestBase,
} from '@/pairs/import'
import {
  BytesSource,
  bgzipped,
  pairsText,
  referenceBin,
  rng,
  sortRecords,
  type Contig,
  type Record as PairRecord,
} from '../support/pairs'
import { px2 } from '../support/px2'

const CONTIGS: Contig[] = [
  { name: 'chrI', length: 4_000 },
  { name: 'chrII', length: 2_000 },
]

function records(n: number, seed: number): PairRecord[] {
  const next = rng(seed)
  const out: PairRecord[] = []
  for (let i = 0; i < n; i++) {
    const a = CONTIGS[Math.floor(next() * CONTIGS.length)]
    const b = CONTIGS[Math.floor(next() * CONTIGS.length)]
    out.push({
      chrom1: a.name,
      pos1: 1 + Math.floor(next() * a.length),
      chrom2: b.name,
      pos2: 1 + Math.floor(next() * b.length),
    })
  }
  return sortRecords(CONTIGS, out)
}

const RECORDS = records(3_000, 5)
const FILE = bgzipped(pairsText({ contigs: CONTIGS, records: RECORDS, assembly: 'testAsm' }))

describe('probePairs', () => {
  it('reads the header and reports no index when there is none', async () => {
    const probe = await probePairs(new BytesSource(FILE), async () => null)
    expect(probe.header.contigs).toEqual(CONTIGS)
    expect(probe.index).toBeNull()
    expect(probe.records).toBeNull()
    expect(probe.genomeLength).toBe(6_000)
    expect(probe.sourceBytes).toBe(FILE.length)
  })

  it('takes the exact record count from a .px2 when one is beside the file', async () => {
    const index = px2({
      entries: [
        { key: 'chrI|chrI', from: 0, to: 0 },
        { key: 'chrI|chrII', from: 0, to: 0 },
      ],
      linecount: RECORDS.length,
    })
    const probe = await probePairs(new BytesSource(FILE), async () => new BytesSource(index, 'i.px2'))
    expect(probe.index).not.toBeNull()
    expect(probe.records).toBe(RECORDS.length)
    expect(indexedPairs(probe.index!)).toEqual([
      ['chrI', 'chrI'],
      ['chrI', 'chrII'],
    ])
  })

  it('treats a broken index as no index rather than as a failure', async () => {
    // An unreadable `.px2` must not cost the reader their file: without one the
    // import reads the whole thing, which is a supported road (§3.7).
    const rubbish = new BytesSource(bgzipped('not an index at all'), 'i.px2')
    const probe = await probePairs(new BytesSource(FILE), async () => rubbish)
    expect(probe.index).toBeNull()
    expect(probe.records).toBeNull()
  })
})

describe('roundToSeries', () => {
  it('rounds up to the next 1-2-5 value', () => {
    expect(roundToSeries(1)).toBe(1)
    expect(roundToSeries(3)).toBe(5)
    expect(roundToSeries(7)).toBe(10)
    expect(roundToSeries(1_500)).toBe(2_000)
    expect(roundToSeries(2_001)).toBe(5_000)
    expect(roundToSeries(999_999)).toBe(1_000_000)
  })

  it('never returns zero or a fraction, whatever it is given', () => {
    for (const value of [0, -5, 0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = roundToSeries(value)
      expect(Number.isInteger(out), String(value)).toBe(true)
      expect(out, String(value)).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('suggestBase', () => {
  it('offers a round number that a ladder can be built on', async () => {
    const probe = await probePairs(new BytesSource(FILE), async () => null)
    const base = suggestBase(probe)
    expect(base).toBeGreaterThanOrEqual(1)
    expect(roundToSeries(base)).toBe(base)
  })

  it('goes coarser when the budget is smaller', async () => {
    const probe = await probePairs(new BytesSource(FILE), async () => null)
    const generous = suggestBase(probe, 1 << 30)
    const tight = suggestBase(probe, 1 << 16)
    expect(tight).toBeGreaterThanOrEqual(generous)
  })
})

describe('estimateCost', () => {
  it('bounds the pixel table by the record count and by the triangle', async () => {
    const index = px2({ entries: [{ key: 'chrI|chrI', from: 0, to: 0 }], linecount: 100 })
    const probe = await probePairs(new BytesSource(FILE), async () => new BytesSource(index, 'i.px2'))

    // A coarse grid: the triangle is the binding constraint.
    const coarse = estimateCost(probe, 2_000)
    expect(coarse.nBins).toBe(3)
    expect(coarse.maxPixels).toBe(6)

    // A fine grid: the record count is.
    const fine = estimateCost(probe, 1)
    expect(fine.nBins).toBe(6_000)
    expect(fine.maxPixels).toBe(100)
    expect(fine.maxBytes).toBe(100 * 12)
  })
})

describe('ladderSizes', () => {
  it('walks the 1-2-5 series from the base', () => {
    expect(ladderSizes(1_000, 5)).toEqual([1_000, 2_000, 5_000, 10_000, 20_000])
    expect(ladderSizes(100, 1)).toEqual([100])
  })

  it('clamps to the series it has, in both directions', () => {
    expect(ladderSizes(10, 0)).toEqual([10])
    expect(ladderSizes(10, 99).length).toBe(MAX_LADDER_RUNGS)
    expect(ladderSizes(10, 99)).toEqual(LADDER_MULTIPLIERS.map((m) => m * 10))
  })

  it('makes every rung an exact multiple of the base, which §3.3 requires', () => {
    for (const size of ladderSizes(300, MAX_LADDER_RUNGS)) {
      expect(size % 300).toBe(0)
    }
  })
})

describe('importPairs', () => {
  it('builds every rung, and each matches an independent binning', async () => {
    const source = new BytesSource(FILE)
    const probe = await probePairs(source, async () => null)
    const notes: string[] = []
    const imported = await importPairs(source, probe, {
      base: 100,
      rungs: 4,
      onProgress: (_done, _total, note) => {
        if (note !== undefined && !notes.includes(note)) notes.push(note)
      },
    })
    expect(imported).not.toBeNull()
    expect(imported!.rungs).toEqual([100, 200, 500, 1_000])

    for (const size of imported!.rungs) {
      const table = imported!.tables.get(size)!
      const expected = referenceBin(CONTIGS, RECORDS, size)
      expect(table.nnz, `nnz at ${size}`).toBe(expected.cells.size)
      expect(table.sum, `sum at ${size}`).toBe(expected.sum)
      expect(table.nBins, `nbins at ${size}`).toBe(expected.nBins)
    }
    // The bar says what it is doing, not just how far along it is.
    expect(notes.some((note) => note.includes('reading records'))).toBe(true)
    expect(notes.some((note) => note.includes('rung'))).toBe(true)
  })

  it('can be cancelled, and hands back nothing rather than a partial map', async () => {
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records: records(40_000, 3) }), 1 << 10))
    const probe = await probePairs(source, async () => null)
    let ticks = 0
    const imported = await importPairs(source, probe, {
      base: 100,
      rungs: 3,
      cancelled: () => ++ticks > 3,
    })
    expect(imported).toBeNull()
  })

  it('refuses a grid whose pixel table would not fit, naming the resolution', async () => {
    const source = new BytesSource(FILE)
    const probe = await probePairs(source, async () => null)
    await expect(
      importPairs(source, probe, { base: 1, rungs: 1, maxPixelBytes: 512 }),
    ).rejects.toMatchObject({ code: 'dense-too-large', detail: { binSize: 1 } })
  })
})

describe('aggregatePixels', () => {
  it('refuses a rung that is not a whole multiple of the base', async () => {
    const source = new BytesSource(FILE)
    const header = await readPairsHeader(source)
    const base = await binPairs(source, {
      binSize: 300,
      contigs: header.contigs,
      columns: header.columns,
    })
    await expect(aggregatePixels(base!, 500)).rejects.toThrow(/whole multiple/)
  })

  it('returns the base itself when asked for the base', async () => {
    const source = new BytesSource(FILE)
    const header = await readPairsHeader(source)
    const base = await binPairs(source, {
      binSize: 250,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(await aggregatePixels(base!, 250)).toBe(base)
  })
})

describe('formatBp', () => {
  it('says what a reader would say', () => {
    expect(formatBp(500)).toBe('500 bp')
    expect(formatBp(1_000)).toBe('1 kb')
    expect(formatBp(2_500)).toBe('2500 bp')
    expect(formatBp(5_000)).toBe('5 kb')
    expect(formatBp(1_000_000)).toBe('1 Mb')
  })
})

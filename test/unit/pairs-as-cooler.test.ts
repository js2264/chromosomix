/**
 * An imported `.pairs`, read as an ordinary map.
 *
 * `pairs-bin.test.ts` proves the pixel table is right. This proves the rest of
 * the application can read it: `MetaCooler.matrix` over `PairsStore` and
 * `pairsHandle`, through `planRead` and `scatterDense`, with no code between
 * here and the renderer knowing the container exists.
 *
 * The three shapes `planRead` distinguishes under `symmetric-upper` are all
 * exercised deliberately, because they are where a store that emits the wrong
 * pixel set shows up: on-diagonal, off-diagonal with the rows first, and
 * off-diagonal with the *columns* first — the case §5.3 warns about, where
 * every relevant pixel is stored with its `bin1` in the column range.
 */

import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { importPairs, probePairs } from '@/pairs/import'
import type { Extent } from '@/types'
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

const CONTIGS: Contig[] = [
  { name: 'chrI', length: 2_000 },
  { name: 'chrII', length: 1_200 },
  { name: 'chrIII', length: 800 },
]
const BASE = 100

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

const RECORDS = records(6_000, 101)

async function openImported(rungs = 3): Promise<{ mc: MetaCooler; rungSizes: number[] }> {
  const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records: RECORDS })))
  const probe = await probePairs(source, async () => null)
  const imported = await importPairs(source, probe, { base: BASE, rungs })
  const mc = MetaCooler.fromPairs({
    uri: 'sample.pairs.gz',
    header: imported!.header,
    pixels: imported!.tables.get(BASE)!,
    rungs: imported!.rungs,
    indexed: false,
  })
  return { mc, rungSizes: imported!.rungs }
}

/** Every cell of a dense block, against the reference binning. */
function expectBlockMatches(
  values: Float32Array,
  rows: Extent,
  cols: Extent,
  binSize = BASE,
): void {
  const expected = referenceBin(CONTIGS, RECORDS, binSize)
  const nCols = cols[1] - cols[0]
  for (let r = rows[0]; r < rows[1]; r++) {
    for (let c = cols[0]; c < cols[1]; c++) {
      // The stored triangle is upper, and the dense block is mirrored.
      const key = r <= c ? `${r}:${c}` : `${c}:${r}`
      const want = expected.cells.get(key) ?? 0
      const got = values[(r - rows[0]) * nCols + (c - cols[0])]
      expect(got, `cell (${r}, ${c})`).toBe(want)
    }
  }
}

describe('an imported .pairs read as a map', () => {
  it('presents itself as a fixed-bin, upper-triangular cooler', async () => {
    const { mc, rungSizes } = await openImported()
    try {
      expect(mc.binsize).toBe(BASE)
      expect(mc.info['bin-type']).toBe('fixed')
      expect(mc.info['storage-mode']).toBe('symmetric-upper')
      expect(mc.hasGenomes).toBe(false)
      expect(mc.nGenomes).toBe(0)
      expect(mc.chromnames).toEqual(['chrI', 'chrII', 'chrIII'])
      // chrI 20 bins, chrII 12, chrIII 8.
      expect(mc.nBins).toBe(40)
      expect(mc.entries).toEqual(rungSizes.map(String))
      expect(mc.entryGroup).toBe('resolutions')
      expect(mc.scoreColumns).toEqual(['count'])
      expect(mc.hasWeights).toBe(false)
    } finally {
      mc.close()
    }
  })

  it('draws an on-diagonal block', async () => {
    const { mc } = await openImported()
    try {
      const rows: Extent = [0, 20]
      const block = await mc.matrix({ rows })
      expect(block.nrows).toBe(20)
      expect(block.ncols).toBe(20)
      expectBlockMatches(block.values, rows, rows)
    } finally {
      mc.close()
    }
  })

  it('draws an off-diagonal block with the rows first', async () => {
    const { mc } = await openImported()
    try {
      const rows: Extent = [0, 20]
      const cols: Extent = [20, 32]
      const block = await mc.matrix({ rows, cols })
      expect(block.nrows).toBe(20)
      expect(block.ncols).toBe(12)
      expectBlockMatches(block.values, rows, cols)
    } finally {
      mc.close()
    }
  })

  it('draws an off-diagonal block with the columns first (§5.3)', async () => {
    const { mc } = await openImported()
    try {
      // Every relevant pixel is stored with its `bin1` in the *column* range,
      // so `planRead` reads the columns and places transposed. A store that
      // ignored the plan would draw an empty block here and nowhere else.
      const rows: Extent = [32, 40]
      const cols: Extent = [0, 20]
      const block = await mc.matrix({ rows, cols })
      expect(block.nrows).toBe(8)
      expect(block.ncols).toBe(20)
      expectBlockMatches(block.values, rows, cols)

      let nonZero = 0
      for (const value of block.values) if (value > 0) nonZero++
      expect(nonZero, 'the transposed block is not empty').toBeGreaterThan(0)
    } finally {
      mc.close()
    }
  })

  it('draws the whole map', async () => {
    const { mc } = await openImported()
    try {
      const whole: Extent = [0, mc.nBins]
      const block = await mc.matrix({ rows: whole })
      expectBlockMatches(block.values, whole, whole)

      // Conservation: the mirrored dense block holds every contact twice
      // except on the diagonal, which is the definition of symmetric-upper.
      const expected = referenceBin(CONTIGS, RECORDS, BASE)
      let total = 0
      for (const value of block.values) total += value
      let diagonal = 0
      for (const [key, count] of expected.cells) {
        const [a, b] = key.split(':')
        if (a === b) diagonal += count
      }
      expect(total).toBe(expected.sum * 2 - diagonal)
    } finally {
      mc.close()
    }
  })

  it('has a per-bin pixel index, unlike a .hic', async () => {
    const { mc } = await openImported()
    try {
      const offsets = mc.store.binOffsets()
      expect(offsets.length).toBe(mc.nBins + 1)
      expect(offsets[0]).toBe(0)
      expect(offsets[mc.nBins]).toBe(mc.store.nnz)
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1])
      }
    } finally {
      mc.close()
    }
  })

  it('walks every stored pixel exactly once', async () => {
    const { mc } = await openImported()
    try {
      let seen = 0
      let total = 0
      await mc.store.scanAll({
        chunkSize: 1_000,
        onChunk: (chunk) => {
          seen += chunk.length
          for (let i = 0; i < chunk.length; i++) total += chunk.count[i]
        },
      })
      expect(seen).toBe(mc.store.nnz)
      expect(total).toBe(referenceBin(CONTIGS, RECORDS, BASE).sum)
    } finally {
      mc.close()
    }
  })

  it('serves each ladder rung at its own resolution', async () => {
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records: RECORDS })))
    const probe = await probePairs(source, async () => null)
    const imported = await importPairs(source, probe, { base: BASE, rungs: 4 })
    expect(imported!.rungs).toEqual([100, 200, 500, 1000])

    for (const size of imported!.rungs) {
      const mc = MetaCooler.fromPairs({
        uri: 'sample.pairs.gz',
        header: imported!.header,
        pixels: imported!.tables.get(size)!,
        rungs: imported!.rungs,
        indexed: false,
      })
      try {
        const expected = referenceBin(CONTIGS, RECORDS, size)
        expect(mc.binsize, `bin size ${size}`).toBe(size)
        expect(mc.nBins, `nbins at ${size}`).toBe(expected.nBins)
        expect(mc.info.nnz, `nnz at ${size}`).toBe(expected.cells.size)
        expect(mc.info.sum, `sum at ${size}`).toBe(expected.sum)

        const whole: Extent = [0, mc.nBins]
        const block = await mc.matrix({ rows: whole })
        expectBlockMatches(block.values, whole, whole, size)
      } finally {
        mc.close()
      }
    }
  })

  it('refuses a value column it does not have, by name', async () => {
    const { mc } = await openImported()
    try {
      await expect(mc.matrix({ rows: [0, 20], value: 'expected' })).rejects.toThrow(
        /no 'expected' column/,
      )
    } finally {
      mc.close()
    }
  })
})

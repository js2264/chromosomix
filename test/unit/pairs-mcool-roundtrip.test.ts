/**
 * Write an `.mcool` from a `.pairs`, then read it back and prove it is the same.
 *
 * This is the check the export was made conditional on. A written contact
 * matrix travels: it opens in cooler, in HiGlass and in this app, and every way
 * it can be silently wrong — a bin edge off by one, a triangle unnormalised, a
 * short final bin absorbed into its neighbour, a `sum` that does not match its
 * own pixels — survives every test that is not a comparison against a second
 * implementation.
 *
 * So there are two comparisons here, and they catch different things:
 *
 * 1. **Against the in-memory table**, read back through this repo's own reader.
 *    That is the round trip, and it is the one that catches a writer and a
 *    reader agreeing with each other about something untrue — which is exactly
 *    the failure §3.6 records `hic-straw` catching, when this repository's
 *    `.hic` reader and writer agreed the format was big-endian.
 * 2. **Against `referenceBin`**, the slow obvious binning in
 *    `test/support/pairs.ts`. That is what makes the round trip mean something:
 *    two implementations that agree, one of which never saw the other's code.
 *
 * What is deliberately *not* asserted is byte-identity with `cooler cload`.
 * That comparison needs a Python interpreter with cooler installed and belongs
 * in `scripts/make_fixtures.py` beside the other oracles; the note in
 * `pairs/write.ts` records the one structural difference (`bins/chrom` is
 * written as int32 codes rather than an HDF5 enum) so the golden, when it is
 * built, expects it.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { getH5 } from '@/h5/bootstrap'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { importPairs, probePairs } from '@/pairs/import'
import { writeMcool } from '@/pairs/write'
import { LocalFileSource } from '@/sources/LocalFileSource'
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
  { name: 'chrI', length: 2_300 },
  { name: 'chrII', length: 1_050 },
  { name: 'chrIII', length: 700 },
]
const BASE = 100
const RUNGS = 4 // 100, 200, 500, 1000

const workDir = mkdtempSync(join(tmpdir(), 'pairs-mcool-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

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

async function buildMcool(recs: PairRecord[]): Promise<{ path: string; imported: Awaited<ReturnType<typeof importPairs>> }> {
  const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records: recs, assembly: 'testAsm' })))
  const probe = await probePairs(source, async () => null)
  const imported = await importPairs(source, probe, { base: BASE, rungs: RUNGS })
  expect(imported).not.toBeNull()
  const bytes = await writeMcool(imported!)
  expect(bytes).not.toBeNull()
  const path = join(workDir, `export-${recs.length}.mcool`)
  writeFileSync(path, bytes!)
  return { path, imported }
}

describe('pairs → .mcool', () => {
  it('round-trips every rung through this app’s own reader', async () => {
    const recs = records(5_000, 3)
    const { path, imported } = await buildMcool(recs)

    for (const size of imported!.rungs) {
      const table = imported!.tables.get(size)!
      const source = await LocalFileSource.open(path)
      const mc = await MetaCooler.open(`${path}::resolutions/${size}`, source)
      try {
        expect(mc.binsize, `bin size at ${size}`).toBe(size)
        expect(mc.nBins, `nbins at ${size}`).toBe(table.nBins)
        expect(mc.nContigs).toBe(CONTIGS.length)
        expect(mc.info.nnz, `nnz at ${size}`).toBe(table.nnz)
        expect(mc.info.sum, `sum at ${size}`).toBe(table.sum)
        expect(mc.chromnames).toEqual(CONTIGS.map((c) => c.name))
        // The ladder is addressable as an mcool's resolutions are.
        expect(mc.entries).toEqual(imported!.rungs.map(String))
      } finally {
        mc.close()
      }
    }
  })

  it('writes pixels identical to the reference binning', async () => {
    const recs = records(4_000, 17)
    const { path } = await buildMcool(recs)
    const h5 = await getH5()
    const file = new h5.File(path, 'r')
    try {
      for (const size of [BASE, BASE * 2, BASE * 5, BASE * 10]) {
        const group = `resolutions/${size}`
        const bin1 = file.get(`${group}/pixels/bin1_id`) as { value: BigInt64Array }
        const bin2 = file.get(`${group}/pixels/bin2_id`) as { value: BigInt64Array }
        const count = file.get(`${group}/pixels/count`) as { value: Int32Array }
        const expected = referenceBin(CONTIGS, recs, size)

        expect(bin1.value.length, `nnz at ${size}`).toBe(expected.cells.size)
        let sum = 0
        for (let i = 0; i < bin1.value.length; i++) {
          const key = `${Number(bin1.value[i])}:${Number(bin2.value[i])}`
          expect(expected.cells.get(key), `cell ${key} at ${size}`).toBe(count.value[i])
          sum += count.value[i]
        }
        expect(sum, `sum at ${size}`).toBe(expected.sum)
      }
    } finally {
      file.close()
    }
  })

  it('writes a bin table whose last bin of each contig is short', async () => {
    const { path } = await buildMcool(records(500, 23))
    const h5 = await getH5()
    const file = new h5.File(path, 'r')
    try {
      const start = (file.get(`resolutions/${BASE}/bins/start`) as { value: Int32Array }).value
      const end = (file.get(`resolutions/${BASE}/bins/end`) as { value: Int32Array }).value
      const chrom = (file.get(`resolutions/${BASE}/bins/chrom`) as { value: Int32Array }).value

      // chrI is 2,300 bp: 23 whole bins, so its last bin ends exactly at 2,300.
      expect(chrom[22]).toBe(0)
      expect(start[22]).toBe(2_200)
      expect(end[22]).toBe(2_300)
      // chrII is 1,050 bp: 11 bins, the last of which is 50 bp long.
      expect(chrom[23]).toBe(1)
      expect(start[23]).toBe(0)
      expect(chrom[33]).toBe(1)
      expect(start[33]).toBe(1_000)
      expect(end[33]).toBe(1_050)
      // Every bin lies inside its own contig.
      for (let bin = 0; bin < end.length; bin++) {
        expect(end[bin]).toBeGreaterThan(start[bin])
        expect(end[bin]).toBeLessThanOrEqual(CONTIGS[chrom[bin]].length)
      }
    } finally {
      file.close()
    }
  })

  it('writes a bin1_offset that brackets the pixel table', async () => {
    const { path, imported } = await buildMcool(records(3_000, 41))
    const h5 = await getH5()
    const file = new h5.File(path, 'r')
    try {
      const table = imported!.tables.get(BASE)!
      const offsets = (file.get(`resolutions/${BASE}/indexes/bin1_offset`) as { value: BigInt64Array })
        .value
      expect(offsets.length).toBe(table.nBins + 1)
      expect(Number(offsets[0])).toBe(0)
      expect(Number(offsets[table.nBins])).toBe(table.nnz)
      // Monotone, and each bin's slice holds exactly that bin's pixels.
      for (let bin = 0; bin < table.nBins; bin++) {
        const lo = Number(offsets[bin])
        const hi = Number(offsets[bin + 1])
        expect(hi).toBeGreaterThanOrEqual(lo)
        for (let i = lo; i < hi; i++) expect(table.bin1[i]).toBe(bin)
      }
    } finally {
      file.close()
    }
  })

  it('carries the provenance a reader would need', async () => {
    const { path } = await buildMcool(records(400, 5))
    const h5 = await getH5()
    const file = new h5.File(path, 'r')
    try {
      const root = file.attrs as Record<string, { value: unknown }>
      expect(root['format'].value).toBe('HDF5::MCOOL')

      const group = file.get(`resolutions/${BASE}`) as { attrs: Record<string, { value: unknown }> }
      expect(group.attrs['format'].value).toBe('HDF5::Cooler')
      expect(group.attrs['storage-mode'].value).toBe('symmetric-upper')
      expect(group.attrs['bin-type'].value).toBe('fixed')
      expect(group.attrs['genome-assembly'].value).toBe('testAsm')
      expect(String(group.attrs['generated-by'].value)).toContain('unbalanced')

      const metadata = JSON.parse(String(group.attrs['metadata'].value)) as Record<string, unknown>
      expect(metadata['imported-from']).toBe('pairs')
      expect(metadata['balanced']).toBe(false)
      // The preamble is carried verbatim, not summarised.
      expect(String(metadata['pairs-header'])).toContain('#chromsize: chrI 2300')
    } finally {
      file.close()
    }
  })

  it('writes no balancing weights, and says so when asked for them', async () => {
    const { path } = await buildMcool(records(300, 9))
    const source = await LocalFileSource.open(path)
    const mc = await MetaCooler.open(`${path}::resolutions/${BASE}`, source)
    try {
      expect(mc.hasWeights).toBe(false)
    } finally {
      mc.close()
    }
  })

  it('answers every PixelStore method exactly as the cooler it wrote does', async () => {
    // The equivalence that matters most, and the one nothing else here covers.
    // Every view and all fourteen analysis tasks reach the pixels through this
    // interface, so a `PairsStore` that emitted a different set for the same
    // query would make a pairs-backed map and the `.mcool` written from it
    // disagree about a number — silently, and only for whichever tasks happen
    // to use the method that differs.
    const recs = records(4_000, 61)
    const { path, imported } = await buildMcool(recs)
    const fromPairs = MetaCooler.fromPairs({
      uri: 'sample.pairs.gz',
      header: imported!.header,
      pixels: imported!.tables.get(BASE)!,
      rungs: imported!.rungs,
      indexed: false,
    })
    const source = await LocalFileSource.open(path)
    const fromCool = await MetaCooler.open(`${path}::resolutions/${BASE}`, source)
    try {
      expect(fromPairs.nBins).toBe(fromCool.nBins)
      expect([...fromPairs.store.binOffsets()]).toEqual([...fromCool.store.binOffsets()])

      // `forEachWindow`, through the dense read that every view takes.
      for (const window of [
        [0, fromPairs.nBins],
        [0, 20],
        [23, 34],
      ] as Array<[number, number]>) {
        const a = await fromPairs.matrix({ rows: window })
        const b = await fromCool.matrix({ rows: window })
        expect([...a.values], `window ${window.join('-')}`).toEqual([...b.values])
      }

      // The off-diagonal case, where the plan decides which band is read.
      const offA = await fromPairs.matrix({ rows: [0, 20], cols: [23, 34] })
      const offB = await fromCool.matrix({ rows: [0, 20], cols: [23, 34] })
      expect([...offA.values]).toEqual([...offB.values])

      // `scanAll` and `forEachBands`, which the analysis tasks use directly.
      const drain = async (
        mc: MetaCooler,
        how: 'scanAll' | 'bands',
      ): Promise<{ total: number; n: number }> => {
        let total = 0
        let n = 0
        const take = (chunk: { length: number; count: Float64Array }): void => {
          for (let i = 0; i < chunk.length; i++) {
            total += chunk.count[i]
            n++
          }
        }
        if (how === 'scanAll') await mc.store.scanAll({ chunkSize: 500, onChunk: take })
        else await mc.store.forEachBands([[0, 10], [20, 30]], take)
        return { total, n }
      }
      for (const how of ['scanAll', 'bands'] as const) {
        expect(await drain(fromPairs, how), how).toEqual(await drain(fromCool, how))
      }
    } finally {
      fromPairs.close()
      fromCool.close()
    }
  })

  it('leaves nothing behind, on every road out', async () => {
    // Under `h5wasm/node` the FS is NODERAWFS — real files, in a real
    // directory — so a leaked export is a whole `.mcool` on disk rather than a
    // page of MEMFS. And on a cancel the leak is the one that matters: the
    // path is uniquified per call, so nothing later ever reclaims it.
    const scratch = process.env['TMPDIR']?.replace(/\/+$/, '') ?? '/tmp'
    const leftovers = (): string[] =>
      readdirSync(scratch).filter((name) => name.startsWith('pairs-export-'))
    const before = leftovers()

    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records: records(2_000, 87) })))
    const probe = await probePairs(source, async () => null)
    const imported = await importPairs(source, probe, { base: BASE, rungs: 2 })

    // A completed export.
    expect(await writeMcool(imported!)).not.toBeNull()
    expect(leftovers(), 'after a completed export').toEqual(before)

    // A cancelled one.
    let ticks = 0
    expect(await writeMcool(imported!, { cancelled: () => ++ticks > 1 })).toBeNull()
    expect(leftovers(), 'after a cancelled export').toEqual(before)
  })

  it('survives a table larger than one write chunk', async () => {
    // Forces the resize-and-write_slice path rather than the single-shot one.
    const recs = records(60_000, 77)
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records: recs })))
    const probe = await probePairs(source, async () => null)
    const imported = await importPairs(source, probe, { base: 1, rungs: 1 })
    const table = imported!.tables.get(1)!
    const bytes = await writeMcool(imported!)
    const path = join(workDir, 'export-chunked.mcool')
    writeFileSync(path, bytes!)

    const h5 = await getH5()
    const file = new h5.File(path, 'r')
    try {
      const count = (file.get('resolutions/1/pixels/count') as { value: Int32Array }).value
      expect(count.length).toBe(table.nnz)
      let sum = 0
      for (const value of count) sum += value
      expect(sum).toBe(table.sum)
    } finally {
      file.close()
    }
  })
})

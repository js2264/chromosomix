/**
 * The importer against `cooler cload pairs`, cell for cell.
 *
 * This is the check SPECS §18.9's narrowing was made conditional on. Every
 * other test of the `.pairs` path compares this repository to itself — the fast
 * binner against a slow one written in the same language by the same hand, and
 * the writer against the reader. Both are worth having and neither is this: a
 * shared misunderstanding of what a bin edge is round-trips perfectly and
 * produces a file that opens in cooler and is wrong.
 *
 * So the oracle is cooler's own output over the same records, built by
 * `scripts/make_pairs_golden.py` and read here. `data/README.md` already runs
 * `cooler cload pairs` on this project's real files, so the comparison is
 * between two implementations of one documented operation rather than against
 * something approximate.
 *
 * **Skipped, loudly, when the golden is absent.** It needs a Python interpreter
 * with cooler installed, which a fresh clone and a CI runner do not have — the
 * same arrangement `test:nofixtures` already makes for every other golden. A
 * skip names the command that produces it, because a test that silently passes
 * for want of its oracle is worse than one that fails.
 */

import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { binPairs } from '@/pairs/bin'
import { readPairsHeader } from '@/pairs/format'
import { aggregatePixels } from '@/pairs/ladder'
import { BytesSource } from '../support/pairs'

const GOLDEN = new URL('../golden/pairs_cload.json', import.meta.url).pathname
const FIXTURE = new URL('../fixtures/pairs/oracle.pairs', import.meta.url).pathname

interface Rung {
  nbins: number
  nnz: number
  sum: number
  storage_mode: string
  bin_start: number[]
  bin_end: number[]
  bin_chrom: number[]
  bin1_id: number[]
  bin2_id: number[]
  count: number[]
  chrom_offset: number[]
  bin1_offset: number[]
}

interface Golden {
  contigs: Array<{ name: string; length: number }>
  records: number
  assembly: string
  resolutions: Record<string, Rung>
  notes: string[]
}

const available = existsSync(GOLDEN) && existsSync(FIXTURE)
const golden: Golden | null = available
  ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden)
  : null

const suite = available ? describe : describe.skip

suite('the importer against `cooler cload pairs`', () => {
  it('agrees on every pixel, at every resolution', async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE))
    const source = new BytesSource(bytes, 'oracle.pairs')
    const header = await readPairsHeader(source)
    expect(header.contigs).toEqual(golden!.contigs)
    expect(header.assembly).toBe(golden!.assembly)

    const sizes = Object.keys(golden!.resolutions)
      .map(Number)
      .sort((a, b) => a - b)
    const base = await binPairs(source, {
      binSize: sizes[0],
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(base).not.toBeNull()

    for (const size of sizes) {
      const rung = golden!.resolutions[String(size)]
      const table = size === sizes[0] ? base! : (await aggregatePixels(base!, size))!
      const at = `at ${size} bp`

      expect(rung.storage_mode, at).toBe('symmetric-upper')
      expect(table.nBins, `nbins ${at}`).toBe(rung.nbins)
      expect(table.nnz, `nnz ${at}`).toBe(rung.nnz)
      expect(table.sum, `sum ${at}`).toBe(rung.sum)
      expect([...table.chromOffset], `chrom_offset ${at}`).toEqual(rung.chrom_offset)

      // Cell for cell, in order. cooler's pixel table is sorted by `bin1_id`
      // then `bin2_id`, and so is the importer's — so an order mismatch is a
      // failure worth seeing rather than something to sort away first.
      for (let i = 0; i < rung.nnz; i++) {
        expect(table.bin1[i], `bin1_id[${i}] ${at}`).toBe(rung.bin1_id[i])
        expect(table.bin2[i], `bin2_id[${i}] ${at}`).toBe(rung.bin2_id[i])
        expect(table.count[i], `count[${i}] ${at}`).toBe(rung.count[i])
      }
    }
  })

  it('agrees on the bin table, including every short final bin', async () => {
    const source = new BytesSource(new Uint8Array(readFileSync(FIXTURE)), 'oracle.pairs')
    const header = await readPairsHeader(source)
    const sizes = Object.keys(golden!.resolutions)
      .map(Number)
      .sort((a, b) => a - b)

    for (const size of sizes) {
      const rung = golden!.resolutions[String(size)]
      // The bin table the writer computes, by the same arithmetic §3.3 states.
      const chromOf: number[] = []
      const start: number[] = []
      const end: number[] = []
      for (let contig = 0; contig < header.contigs.length; contig++) {
        const length = header.contigs[contig].length
        const bins = Math.ceil(length / size)
        for (let bin = 0; bin < bins; bin++) {
          chromOf.push(contig)
          start.push(bin * size)
          end.push(Math.min((bin + 1) * size, length))
        }
      }
      expect(chromOf, `bins/chrom at ${size}`).toEqual(rung.bin_chrom)
      expect(start, `bins/start at ${size}`).toEqual(rung.bin_start)
      expect(end, `bins/end at ${size}`).toEqual(rung.bin_end)
    }
  })
})

if (!available) {
  describe('the `cooler cload pairs` oracle', () => {
    it.skip(
      'is absent — build it with `npm run fixtures:pairs` (needs `pip install cooler`)',
      () => undefined,
    )
  })
}

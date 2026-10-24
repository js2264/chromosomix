/**
 * `pairtools stats`, counted in the import's pass, held to pairtools (§3.7).
 *
 * The golden is pairtools 1.1.2's own `.stats` file for a committed fixture
 * drawn from the yeast Micro-C cooler — every pair type pairtools writes,
 * duplicates, the unmapped and the one-sided, and a sequence the header does
 * not declare (`scripts/make_pairstats_golden.py`). What is held is every key
 * pairtools wrote and nothing else, and every value: the counts exactly, the
 * fractions to the last bit they can differ by, the library estimate to the
 * precision two implementations of Lambert's W share, and every line spelled
 * as pairtools spells it, so a file this app writes is a file that reads as
 * pairtools' — by MultiQC, by `pairtools stats --merge`.
 *
 * And the other half of the terms the pair type is read on: nothing is decided
 * from it. The pixel table binned from the fixture is the same table binned from
 * the fixture with its `pair_type` column taken out.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { main } from '@/cli/main'

import { binPairs } from '@/pairs/bin'
import { readPairsHeader } from '@/pairs/format'
import {
  distEdges,
  lambertW0,
  libraryComplexity,
  pairtoolsStatsEntries,
  pythonFloat,
  statText,
  writePairtoolsStats,
  type PairStats,
} from '@/pairs/stats'
import { BytesSource } from '../support/pairs'

const GOLDEN = resolve(__dirname, '../golden/pairs_stats')

/** pairtools' file, as `key → value text`, in its order. */
function goldenStats(): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of readFileSync(resolve(GOLDEN, 'sample.stats'), 'utf8').split('\n')) {
    if (line === '') continue
    const [key, value] = line.split('\t')
    out.set(key, value)
  }
  return out
}

/** The importer's counts over `bytes`, binned at 10 kb. */
async function countsOf(bytes: Uint8Array): Promise<{ stats: PairStats; bin1: Int32Array; bin2: Int32Array; count: Int32Array }> {
  const source = new BytesSource(bytes)
  const header = await readPairsHeader(source)
  const binned = await binPairs(source, { binSize: 10_000, contigs: header.contigs, columns: header.columns })
  if (binned === null || binned.stats == null) throw new Error('the import produced no counts')
  return { stats: binned.stats, bin1: binned.bin1, bin2: binned.bin2, count: binned.count }
}

const fixture = (): Uint8Array => new Uint8Array(readFileSync(resolve(GOLDEN, 'sample.pairs.gz')))

describe('pairtools stats, counted in the import', () => {
  it('writes every key pairtools wrote, and only those', async () => {
    const { stats } = await countsOf(fixture())
    const ours = new Map(pairtoolsStatsEntries(stats).map(([key, value]) => [key, statText(value)]))
    const theirs = goldenStats()
    expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort())
  })

  it('agrees with pairtools on every value', async () => {
    const { stats } = await countsOf(fixture())
    const theirs = goldenStats()
    for (const [key, value] of pairtoolsStatsEntries(stats)) {
      const expected = theirs.get(key)
      if (key === 'summary/complexity_naive' && 'float' in value) {
        // Lambert's W at the edge of its branch, by two implementations.
        expect(value.float, key).toBeCloseTo(Number(expected), 6)
        expect(Math.abs(value.float - Number(expected)) / Number(expected), key).toBeLessThan(1e-12)
        continue
      }
      expect(statText(value), key).toBe(expected)
    }
  })

  it('counts a sequence the header does not declare, which the matrix leaves out', async () => {
    const { stats } = await countsOf(fixture())
    const mito = stats.chromFreq.filter(([a, b]) => a === 'mito' || b === 'mito')
    expect(mito.map(([a, b]) => `${a}/${b}`).sort()).toEqual(['mito/I', 'mito/mito'])
    expect(stats.pairTypeColumn).toBe(true)
    expect(stats.scoped).toBe(false)
  })

  it('writes a file in pairtools’ own order, a line a key', async () => {
    const { stats } = await countsOf(fixture())
    const text = writePairtoolsStats(stats)
    const keys = text.trimEnd().split('\n').map((line) => line.split('\t')[0])
    // The sections in the order `PairCounter.flatten` writes them.
    const section = (key: string): string => key.split('/')[0].replace(/^cis_\d+kb\+$/, 'cis_kb')
    const order = [...new Set(keys.map(section))]
    expect(order).toEqual([
      'total',
      'total_unmapped',
      'total_single_sided_mapped',
      'total_mapped',
      'total_dups',
      'total_nodups',
      'cis',
      'trans',
      'pair_types',
      'cis_kb',
      'summary',
      'chrom_freq',
      'dist_freq',
      'chromsizes',
    ])
    expect(keys[0]).toBe('total')
    expect(text.endsWith('\n')).toBe(true)
  })

  /**
   * The pair type is counted and nothing is decided from it: the importer bins
   * every record it can place, a duplicate included, and the table is the same
   * with the column gone.
   */
  it('bins the same table with the pair type column and without it', async () => {
    const withType = await countsOf(fixture())
    const text = new TextDecoder().decode(gunzipSync(fixture()))
    const stripped = text
      .split('\n')
      .map((line) =>
        line.startsWith('#columns:')
          ? line.replace(' pair_type', '')
          : line.startsWith('#') || line === ''
            ? line
            : line.split('\t').slice(0, 7).join('\t'),
      )
      .join('\n')
    const without = await countsOf(new TextEncoder().encode(stripped))
    expect(Array.from(without.bin1)).toEqual(Array.from(withType.bin1))
    expect(Array.from(without.bin2)).toEqual(Array.from(withType.bin2))
    expect(Array.from(without.count)).toEqual(Array.from(withType.count))
    // Without the column there is no type to count, and so no duplicate.
    expect(without.stats.pairTypeColumn).toBe(false)
    expect(without.stats.pairTypes).toEqual([])
    expect(without.stats.totalDups).toBe(0)
    expect(without.stats.total).toBe(withType.stats.total)
  })
})

describe('the pieces of the port', () => {
  it('lays the separation bins as numpy does', () => {
    const theirs = [...goldenStats().keys()]
      .filter((key) => key.startsWith('dist_freq/') && key.endsWith('/++'))
      .map((key) => Number(key.split('/')[1].split(/[-+]/)[0]))
    expect(distEdges()).toEqual(theirs)
    expect(distEdges().slice(0, 12)).toEqual([0, 1, 2, 3, 4, 6, 7, 10, 13, 18, 24, 32])
  })

  it('solves Lambert’s W as scipy does', () => {
    const cases: Array<[number, number]> = [
      [-0.1, -0.11183255915896297],
      [-0.3, -0.4894022271802149],
      [-0.36, -0.8060843159708174],
      [-0.3678, -0.9793607149578258],
      [-1e-6, -1.0000010000014999e-6],
      [-0.3673874430856, -0.949152747401149],
      [-0.2706705664732254, -0.40637573995996],
      [-0.36787925698623863, -0.9989996665554404],
    ]
    for (const [z, w] of cases) expect(Math.abs(lambertW0(z) - w), String(z)).toBeLessThan(1e-12)
    expect(lambertW0(-Math.exp(-1))).toBeNaN()
  })

  it('estimates a library as pairtools does', () => {
    expect(libraryComplexity(26862, 2311)).toBeCloseTo(147027.11952463447, 6)
    expect(libraryComplexity(100, 1)).toBeCloseTo(4966.610812827721, 8)
    expect(libraryComplexity(366157, 16833)).toBeCloseTo(3859373.108220749, 4)
    expect(libraryComplexity(1_000_000, 999_999)).toBeCloseTo(1, 9)
    // No duplicates: scipy's W is `nan` at `-exp(-1)`, which lies a hair past
    // -1/e, and pairtools writes `nan` — as it did for the validation's
    // deduplicated yeast library.
    expect(libraryComplexity(500, 0)).toBeNaN()
    expect(libraryComplexity(17_583_821, 0)).toBeNaN()
    expect(libraryComplexity(0, 0)).toBe(0)
  })

  it('spells a float as Python does', () => {
    expect(pythonFloat(0.25)).toBe('0.25')
    expect(pythonFloat(0.05)).toBe('0.05')
    expect(pythonFloat(1e-5)).toBe('1e-05')
    expect(pythonFloat(0.0001)).toBe('0.0001')
    expect(pythonFloat(0.00012345)).toBe('0.00012345')
    expect(pythonFloat(123)).toBe('123.0')
    expect(pythonFloat(0)).toBe('0.0')
    expect(pythonFloat(3859373.108220749)).toBe('3859373.108220749')
    expect(pythonFloat(1e16)).toBe('1e+16')
    expect(pythonFloat(1.5e16)).toBe('1.5e+16')
    expect(pythonFloat(123456789012345.6)).toBe('123456789012345.6')
    expect(pythonFloat(0.9999999999999999)).toBe('0.9999999999999999')
    expect(pythonFloat(Number.NaN)).toBe('nan')
    expect(pythonFloat(Infinity)).toBe('inf')
  })
})

describe('chromosomix stats', () => {
  /** What a `.stats` file says, as `key → value text`. */
  const parsed = (text: string): Map<string, string> =>
    new Map(text.trimEnd().split('\n').map((line) => line.split('\t') as [string, string]))

  it('writes the file pairtools writes, named as pairtools names it', async () => {
    const out = mkdtempSync(join(tmpdir(), 'chromosomix-stats-'))
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await main(['stats', resolve(GOLDEN, 'sample.pairs.gz'), '--out', out, '--quiet'])).toBe(0)
      const ours = parsed(readFileSync(join(out, 'sample.stats'), 'utf8'))
      const theirs = goldenStats()
      expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort())
      for (const [key, value] of theirs) {
        if (key === 'summary/complexity_naive') expect(Number(ours.get(key))).toBeCloseTo(Number(value), 6)
        else expect(ours.get(key), key).toBe(value)
      }
      // No `#` line over it: pairtools' own reader refuses one.
      expect(readFileSync(join(out, 'sample.stats'), 'utf8').startsWith('total\t')).toBe(true)
    } finally {
      quiet.mockRestore()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('writes to stdout without --out, and refuses a file that is not a .pairs', async () => {
    const said: string[] = []
    const errors: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      said.push(String(chunk))
      return true
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk))
      return true
    })
    try {
      expect(await main(['stats', resolve(GOLDEN, 'sample.pairs.gz'), '--quiet'])).toBe(0)
      expect(parsed(said.join('')).get('total')).toBe('30300')
      expect(await main(['stats', resolve(GOLDEN, 'sample.stats'), '--quiet'])).toBe(1)
      expect(errors.join('')).toMatch(/sample\.stats is not a \.pairs file/)
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  })
})

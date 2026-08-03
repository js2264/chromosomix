/**
 * A region never reaches into the next chromosome, however the file was binned.
 *
 * `cooler.Cooler.extent` computes a fixed-bin region arithmetically —
 * `chrom_offset[cid] + ceil(end / binsize)` — which assumes the bin table is
 * `binnify(chromsizes, binsize)`. Not every file's is: a trailing part-bin can
 * be absorbed into the one before it rather than given a row of its own, and
 * then a chromosome has one bin *fewer* than the division says.
 *
 * `public/demo/Yeast_mpneumoniae_G2M.mcool` (cooler 0.8.11) is such a file at
 * every resolution, and at 2 kb five chromosomes are affected — I, VI, XII, XIV
 * and XVI, the ones whose 1 kb bin count was odd. The
 * extra bin the arithmetic returns is the *first bin of the next chromosome*,
 * which is not a rounding detail: the block then spans two chromosomes, so the
 * view loses its single coordinate system, the base-pair ticks along the edge
 * disappear, and a row and a column of a different chromosome's contacts are
 * drawn as if they belonged.
 *
 * The rule under test is one line: `chrom_offset` decides where a chromosome's
 * bins end, because it is what the pixels are indexed by.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { parseMetacoolerRange } from '../../src/metacooler/range'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const FILE = decodeURIComponent(
  new URL('../../public/demo/Yeast_mpneumoniae_G2M.mcool', import.meta.url).pathname,
)

/** The five affected chromosomes at 2 kb, and what the division wrongly adds. */
const SHORT_AT_2KB = ['I', 'VI', 'XII', 'XIV', 'XVI']

async function withResolution<T>(res: string, body: (mc: MetaCooler) => Promise<T> | T): Promise<T> {
  const source = await LocalFileSource.open(FILE)
  const mc = await MetaCooler.open(`${FILE}::resolutions/${res}`, source)
  try {
    return await body(mc)
  } finally {
    mc.close()
  }
}

const suite = existsSync(FILE) ? describe : describe.skip

suite('a coarsened mcool level', () => {
  it('keeps every whole-chromosome region inside its own bins', async () => {
    await withResolution('2000', (mc) => {
      for (const name of mc.chromnames) {
        expect(mc.extent(name), name).toEqual(mc.contigExtent(name))
      }
    })
  })

  it('is a file where the arithmetic and the bin table genuinely disagree', async () => {
    // Without this the test above would pass on a file that never exercises it.
    await withResolution('2000', (mc) => {
      const short = mc.chromnames.filter((name) => {
        const [lo, hi] = mc.contigExtent(name)
        return hi - lo !== Math.ceil((mc.chromsizes.get(name) as number) / 2000)
      })
      expect(short).toEqual(SHORT_AT_2KB)
    })
  })

  it('gives chromosome XVI its own 474 bins, not XVI plus one bin of Mito', async () => {
    await withResolution('2000', (mc) => {
      const [lo, hi] = mc.extent('XVI')
      expect(hi - lo).toBe(474)
      // The bin after the last one belongs to the next chromosome; it did not
      // used to, which is what the eye caught.
      expect(mc.contigExtent('Mito')[0]).toBe(hi)
    })
  })

  it('resolves the same way through the range parser the worker uses', async () => {
    await withResolution('2000', (mc) => {
      for (const name of SHORT_AT_2KB) {
        const parsed = parseMetacoolerRange(mc, name)
        expect(parsed.extent, name).toEqual(mc.contigExtent(name))
      }
    })
  })

  it('leaves a coordinate range inside a chromosome alone', async () => {
    await withResolution('2000', (mc) => {
      const [base] = mc.contigExtent('XVI')
      expect(mc.extent('XVI:0-10000')).toEqual([base, base + 5])
      expect(mc.extent('XVI:4000-6000')).toEqual([base + 2, base + 3])
      // Past the end of the chromosome's bins, a range clamps rather than
      // spilling: the last bin of XVI is the last bin it has.
      const [, end] = mc.contigExtent('XVI')
      expect(mc.extent('XVI:940000-948066')).toEqual([base + 470, end])
    })
  })

  it('holds at the finest resolution too, which this file also merges', async () => {
    // Not only the coarsened levels: chromosome I is 230,218 bp and its 1 kb
    // level has 230 bins, ending in a 1,218 bp one — so the file was written
    // this way from the start and every resolution needs the clamp.
    await withResolution('1000', (mc) => {
      for (const name of mc.chromnames) {
        expect(mc.extent(name), name).toEqual(mc.contigExtent(name))
      }
      expect(mc.contigExtent('I')[1] - mc.contigExtent('I')[0]).toBe(230)
      expect(Math.ceil((mc.chromsizes.get('I') as number) / 1000)).toBe(231)
    })
  })
})

/**
 * A window, moved between two levels of the same `.mcool`.
 *
 * The moment a zoom is allowed to change rung, the reader has to answer a
 * question it never had before: the `matrix` request speaks bins, and **bin
 * indices are not comparable across levels**. Each level has its own
 * `chrom_offset`, and `coarse-extent.test.ts` is a whole file about this
 * particular cooler being one where the arithmetic and the bin table disagree —
 * five chromosomes at 2 kb have one bin *fewer* than the division says, because
 * a trailing part-bin was absorbed rather than given a row.
 *
 * So bin `n` at 1 kb and bin `n` at 2 kb are not the same place, and after a few
 * sequences they are not even the same chromosome. `crossResolution` is the
 * conversion, and these are the properties it has to have: the same stretch of
 * genome, never a different sequence, and outward rather than short — a window
 * that contains what was asked for, because a coarse level cannot answer a fine
 * question exactly and a picture missing its edges is worse than one with a
 * little extra.
 *
 * Run against the real file rather than a constructed one, because a
 * constructed one would have the bin table the arithmetic predicts, which is
 * exactly the case that never fails.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { crossResolution } from '../../src/metacooler/coords'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const FILE = decodeURIComponent(
  new URL('../../demo/yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool', import.meta.url).pathname,
)

async function openTwo<T>(
  fine: string,
  coarse: string,
  body: (a: MetaCooler, b: MetaCooler) => Promise<T> | T,
): Promise<T> {
  const source = await LocalFileSource.open(FILE)
  const a = await MetaCooler.open(`${FILE}::resolutions/${fine}`, source)
  const b = await MetaCooler.open(`${FILE}::resolutions/${coarse}`, source)
  try {
    return await body(a, b)
  } finally {
    a.close()
    b.close()
  }
}

const suite = existsSync(FILE) ? describe : describe.skip

suite('a window across two resolutions of one file', () => {
  it('is the identity between a level and itself', async () => {
    await openTwo('1000', '1000', (a, b) => {
      expect(crossResolution(a.coords, b.coords, [1234, 5678])).toEqual([1234, 5678])
    })
  })

  it('lands on the same chromosome, never the next one', async () => {
    await openTwo('1000', '2000', (fine, coarse) => {
      // Every chromosome, at its own first and last bin. This is the assertion
      // the file was chosen for: five of these chromosomes are exactly one bin
      // short of what `ceil(length / binsize)` predicts at 2 kb, so a conversion
      // that went through global bin arithmetic instead of `chrom_offset` would
      // put the far end of the window in the *next* sequence.
      for (let contig = 0; contig < fine.coords.nContigs; contig++) {
        const [lo, hi] = fine.coords.contigBinExtent(contig)
        if (hi <= lo) continue
        const [clo, chi] = crossResolution(fine.coords, coarse.coords, [lo, hi])
        expect(coarse.coords.contigOfBin(clo), `${contig} start`).toBe(contig)
        expect(coarse.coords.contigOfBin(chi - 1), `${contig} end`).toBe(contig)
      }
    })
  })

  it('gives a whole chromosome its whole self at the coarser level', async () => {
    await openTwo('1000', '2000', (fine, coarse) => {
      for (let contig = 0; contig < fine.coords.nContigs; contig++) {
        const fineExtent = fine.coords.contigBinExtent(contig)
        if (fineExtent[1] <= fineExtent[0]) continue
        expect(crossResolution(fine.coords, coarse.coords, fineExtent)).toEqual(
          coarse.coords.contigBinExtent(contig),
        )
      }
    })
  })

  it('contains the base pairs it was given, rather than trimming them', async () => {
    await openTwo('1000', '2000', (fine, coarse) => {
      const contig = 3
      const [start] = fine.coords.contigBinExtent(contig)
      // A window that begins and ends mid-cell on the coarse grid, which is the
      // ordinary case: a coarse cell is two fine bins, and these edges are odd.
      const window: [number, number] = [start + 101, start + 507]
      const [lo, hi] = crossResolution(fine.coords, coarse.coords, window)
      const bpOf = (mc: MetaCooler, bin: number): number =>
        (bin - mc.coords.contigBinExtent(contig)[0]) * mc.coords.binsize
      expect(bpOf(coarse, lo), 'the start is not later than asked').toBeLessThanOrEqual(
        bpOf(fine, window[0]),
      )
      expect(bpOf(coarse, hi), 'the end is not earlier than asked').toBeGreaterThanOrEqual(
        bpOf(fine, window[1]),
      )
    })
  })

  it('round-trips a whole chromosome back to itself', async () => {
    await openTwo('1000', '2000', (fine, coarse) => {
      for (let contig = 0; contig < fine.coords.nContigs; contig++) {
        const there = fine.coords.contigBinExtent(contig)
        if (there[1] <= there[0]) continue
        const across = crossResolution(fine.coords, coarse.coords, there)
        expect(crossResolution(coarse.coords, fine.coords, across)).toEqual(there)
      }
    })
  })

  it('never returns an empty or inverted window', async () => {
    await openTwo('1000', '2000', (fine, coarse) => {
      const [start, end] = fine.coords.contigBinExtent(0)
      for (const bin of [start, start + 1, start + 7, end - 2, end - 1]) {
        const [lo, hi] = crossResolution(fine.coords, coarse.coords, [bin, bin + 1])
        expect(hi, `single bin ${bin}`).toBeGreaterThan(lo)
        expect(lo).toBeGreaterThanOrEqual(0)
        expect(hi).toBeLessThanOrEqual(coarse.coords.nBins)
      }
    })
  })

  it('holds across a bigger step than a doubling', async () => {
    await openTwo('1000', '8000', (fine, coarse) => {
      for (let contig = 0; contig < fine.coords.nContigs; contig++) {
        const there = fine.coords.contigBinExtent(contig)
        if (there[1] <= there[0]) continue
        const [lo, hi] = crossResolution(fine.coords, coarse.coords, there)
        expect(coarse.coords.contigOfBin(lo)).toBe(contig)
        expect(coarse.coords.contigOfBin(hi - 1)).toBe(contig)
      }
    })
  })
})

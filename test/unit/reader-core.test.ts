/**
 * Reader-core smoke test against the real 26 MB reference file.
 *
 * Not a substitute for the M0 golden oracles — it is the check that the four
 * modules of the reader core agree with each other and with a file that was
 * actually produced by `metacooler create`, which is the failure mode unit
 * tests over synthetic fixtures cannot see.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { UNBINNED_NAME } from '../../src/constants'
import { intAttr } from '../../src/metacooler/detect'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { parseMetacoolerRange } from '../../src/metacooler/range'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { parseUri } from '../../src/uri'

const REFERENCE = new URL('../../data/Hum53.metacool', import.meta.url).pathname
const hasReference = existsSync(REFERENCE)

describe('parseUri', () => {
  it('mirrors metacooler.uri.parse_uri', () => {
    expect(parseUri('f.metacool')).toEqual({ path: 'f.metacool', group: '/' })
    expect(parseUri('f.mmetacool::entries/rep1')).toEqual({
      path: 'f.mmetacool',
      group: '/entries/rep1',
    })
    expect(parseUri('f.mmetacool::')).toEqual({ path: 'f.mmetacool', group: '/' })
    expect(parseUri('  f.metacool  ')).toEqual({ path: 'f.metacool', group: '/' })
    expect(() => parseUri('::entries/a')).toThrowError(/empty file path/)
  })
})

describe('intAttr', () => {
  it('treats the string sentinels as absent, not as a bin size', () => {
    for (const sentinel of ['', 'null', 'NULL', ' None ', 'nan']) {
      expect(intAttr({ 'bin-size': sentinel }, 'bin-size')).toBeNull()
    }
    expect(intAttr({}, 'bin-size')).toBeNull()
    expect(intAttr({ 'bin-size': 1000 }, 'bin-size')).toBe(1000)
    expect(intAttr({ 'bin-size': 1000.0 }, 'bin-size')).toBe(1000)
    expect(intAttr({ 'bin-size': '1000' }, 'bin-size')).toBe(1000)
    expect(() => intAttr({ 'bin-size': true }, 'bin-size')).toThrowError(/must be an integer/)
    expect(() => intAttr({ 'bin-size': 1000.5 }, 'bin-size')).toThrowError(/must be an integer/)
    expect(() => intAttr({ 'bin-size': 'fixed' }, 'bin-size')).toThrowError(/must be an integer/)
  })
})

describe.skipIf(!hasReference)('MetaCooler on Hum53.metacool', () => {
  const open = async (): Promise<MetaCooler> =>
    MetaCooler.open(REFERENCE, await LocalFileSource.open(REFERENCE))

  it('reports the file the way the Python API does', async () => {
    const mc = await open()
    try {
      expect(mc.layout.kind).toBe('metacool')
      expect(mc.info.format).toBe('HDF5::MetaCooler')
      expect(mc.info.ordering).toBe('genome-then-length')
      expect(mc.info['storage-mode']).toBe('symmetric-upper')
      expect(mc.binsize).toBe(1000)
      expect(mc.nGenomes).toBe(4395)
      expect(mc.nContigs).toBe(154468)
      expect(mc.nBins).toBe(422967)
      expect(mc.shape).toEqual([422967, 422967])
      expect(mc.info.nnz).toBe(4573673)
      expect(mc.countKind).toBe('i')
    } finally {
      mc.close()
    }
  })

  it('excludes __unbinned__ without renumbering anything', async () => {
    const mc = await open()
    try {
      expect(mc.genomeNames[0]).toBe(UNBINNED_NAME)
      const display = mc.displayGenomes()
      expect(display).toHaveLength(mc.nGenomes - 1)
      expect(display[0]).toBe(1) // index 1, not a renumbered 0
      const stats = mc.unassignedStats()
      expect(stats).not.toBeNull()
      expect(stats!.genomeIndex).toBe(0)
      expect(stats!.contigs).toBe(67058)
      expect(stats!.bins).toBe(100637)
      expect(() => parseMetacoolerRange(mc, UNBINNED_NAME)).toThrowError(/cannot be displayed/)
    } finally {
      mc.close()
    }
  })

  it('derives coordinates without reading /bins', async () => {
    const mc = await open()
    try {
      for (const contig of [0, 1, 1000, mc.nContigs - 1]) {
        const [lo, hi] = mc.coords.contigBinExtent(contig)
        expect(hi - lo).toBe(mc.coords.binsInContig(contig))
        expect(mc.coords.contigOfBin(lo)).toBe(contig)
        expect(mc.coords.contigOfBin(hi - 1)).toBe(contig)
        expect(mc.coords.binStart(lo)).toBe(0)
        // The last bin of a contig is short; its end is the contig length.
        expect(mc.coords.binEnd(hi - 1)).toBe(mc.chromsizes.get(mc.chromnames[contig]))
      }
    } finally {
      mc.close()
    }
  })

  it('resolves ranges the way cooler does', async () => {
    const mc = await open()
    try {
      const contig = mc.chromnames[1000]
      const whole = parseMetacoolerRange(mc, contig)
      expect(whole.kind).toBe('contig')
      expect(whole.extent).toEqual(mc.contigExtent(contig))
      // 0-based half-open, as cooler's parse_region actually implements it.
      expect(mc.extent(`${contig}:0-1000`)).toEqual([whole.extent[0], whole.extent[0] + 1])
      expect(mc.offset(`${contig}:1000-2000`)).toBe(whole.extent[0] + 1)

      const genome = mc.genomeNames[1]
      const g = parseMetacoolerRange(mc, genome)
      expect(g.kind).toBe('genome')
      expect(g.extent).toEqual(mc.genomeExtent(genome))
      expect(() => parseMetacoolerRange(mc, `${genome}:1-100`)).toThrowError(
        /coordinate suffixes are not allowed/,
      )
      expect(() => parseMetacoolerRange(mc, 'no_such_thing')).toThrowError(
        /is not a known genome or contig/,
      )
    } finally {
      mc.close()
    }
  })

  it('loads a genome matrix, and its transpose is the mirror image', async () => {
    const mc = await open()
    try {
      // The first two displayable genomes — indices 1 and 2, since genome 0 is
      // `__unbinned__` and nothing was renumbered to hide it.
      const g1 = mc.displayGenomes()[0]
      const g2 = mc.displayGenomes()[1]
      // Golden numbers: taken from the Python reference on this exact file.
      //   mc.matrix(balance=False)[100637:101948, 100637:101948] → sum 65903,
      //   diagonal 45939; the g1×g2 block sums to 19 in both orientations.
      const intra = await mc.genomeMatrix(g1)
      expect([intra.nrows, intra.ncols]).toEqual([1311, 1311])
      // Symmetry: the block is mirrored, and the diagonal is *not* doubled —
      // a diagonal of 2 × 45939 would still look symmetric, so the total is
      // what actually catches it.
      let asymmetric = 0
      let total = 0
      let diagonal = 0
      for (let i = 0; i < intra.nrows; i++) {
        for (let j = 0; j < intra.ncols; j++) {
          const v = intra.values[i * intra.ncols + j]
          total += v
          if (i === j) diagonal += v
          if (v !== intra.values[j * intra.ncols + i]) asymmetric += 1
        }
      }
      expect(asymmetric).toBe(0)
      expect(total).toBe(65903)
      expect(diagonal).toBe(45939)

      // The transpose case: this pair is stored only as (g1 row, g2 col), so
      // `ba` comes back empty unless the plan flips it.
      const ab = await mc.genomePairMatrix(g1, g2)
      const ba = await mc.genomePairMatrix(g2, g1)
      expect([ab.nrows, ab.ncols]).toEqual([ba.ncols, ba.nrows])
      let mismatched = 0
      let sumAb = 0
      for (let i = 0; i < ab.nrows; i++) {
        for (let j = 0; j < ab.ncols; j++) {
          const v = ab.values[i * ab.ncols + j]
          sumAb += v
          if (v !== ba.values[j * ba.ncols + i]) mismatched += 1
        }
      }
      expect(mismatched).toBe(0)
      expect(sumAb).toBe(19)

      // Aggregation is free, and what it conserves exactly is the **upper
      // triangle** — not the whole block. `_aggregate_sparse` maps each stored
      // pixel once and symmetrises afterwards, whereas the loaded block already
      // carries both triangles; summing it per contig would double every
      // within-contig off-diagonal pixel and inflate exactly the diagonal.
      const upper = (nrows: number, ncols: number, v: ArrayLike<number>): number => {
        let sum = 0
        for (let i = 0; i < nrows; i++) for (let j = i; j < ncols; j++) sum += v[i * ncols + j]
        return sum
      }
      const rolled = mc.aggregate(intra, 'contig')
      // (65903 + 45939) / 2 = 55921 stored pixels' worth of contacts.
      expect(upper(intra.nrows, intra.ncols, intra.values)).toBe((total + diagonal) / 2)
      expect(upper(rolled.nrows, rolled.ncols, rolled.values)).toBe(
        upper(intra.nrows, intra.ncols, intra.values),
      )
      expect(mc.aggregate(intra, 'genome').nrows).toBe(1)
    } finally {
      mc.close()
    }
  })

  it('reports a density proxy from two index lookups', async () => {
    const mc = await open()
    try {
      const g = mc.displayGenomes()[0]
      expect(mc.genomeDensity(g)).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(mc.genomeDensity(g))).toBe(true)
    } finally {
      mc.close()
    }
  })

  it('refuses the mmetacool root and opens the entry', async () => {
    const collection = REFERENCE.replace('.metacool', '.mmetacool')
    if (!existsSync(collection)) return
    await expect(
      MetaCooler.open(collection, await LocalFileSource.open(collection)),
    ).rejects.toThrowError(/No metacool entry at root/)

    const uri = `${collection}::entries/1000`
    const mc = await MetaCooler.open(uri, await LocalFileSource.open(collection))
    try {
      expect(mc.layout.kind).toBe('metacool')
      expect(mc.binsize).toBe(1000)
    } finally {
      mc.close()
    }
  })
})

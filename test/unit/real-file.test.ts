/**
 * Integration sanity against the real file.
 *
 * Every fixture in `test/fixtures/` was written by this repo's own generator,
 * so a fixture can only ever confirm what the generator already believed. This
 * file opens `data/Hum53.metacool` — 4,395 MAGs and 154,468 contigs produced by
 * a real MetaTOR run and a real `metacooler create pairs` — and checks the
 * numbers that were verified independently, by hand, with `h5py` and the Python
 * `MetaCooler`, before any of this code existed.
 *
 * The file is gitignored (26 MB), so the whole suite is skipped when it is
 * absent rather than failing. That is the one case where a green run means
 * less than it looks like, so the skip says so by name.
 *
 * Three properties get more attention than their size suggests, because each is
 * a house rule that a plausible implementation would break silently:
 *
 * 1. **`/bins` is never read** (§3.3). Asserted by recording every HDF5 path
 *    the reader touches while loading a MAG, not by reading the source.
 * 2. **`__unbinned__` is excluded at display time and *nothing* is
 *    renumbered** (§7.4). Both halves are checked: it is gone from the display
 *    list, and every `genome_id`, `genome_offset` and bin index is still
 *    exactly where the file put it.
 * 3. **An `.mmetacool` refuses at its root and opens at an entry** (§3.4).
 */

import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { UNBINNED_NAME } from '../../src/constants'
import { ViewerError } from '../../src/errors'
import type { Hdf5Handle } from '../../src/h5/api'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { parseMetacoolerRange } from '../../src/metacooler/range'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { allIntegers } from '../../src/ui/FilePicker'
import { requireGenomes } from './_golden'

const METACOOL = new URL('../../data/Hum53.metacool', import.meta.url).pathname
const MMETACOOL = new URL('../../data/Hum53.mmetacool', import.meta.url).pathname

const hasMetacool = existsSync(METACOOL)
const hasMmetacool = existsSync(MMETACOOL)

/** Numbers taken from the file itself with `h5py`, independently of this code. */
const REAL = {
  nGenomes: 4395,
  nContigs: 154468,
  nBins: 422967,
  nnz: 4573673,
  binsize: 1000,
  ordering: 'genome-then-length',
  storageMode: 'symmetric-upper',
  /** `indexes/chrom_offset[0:5]` — the first five contigs of the file. */
  chromOffsetHead: [0, 223, 427, 622, 790],
  unassignedContigs: 67058,
  unassignedBins: 100637,
  /** A mid-sized MAG: genome index 2, 369 contigs, 603 bins. */
  mag: { name: 'Hum53_metator_00002_00002', index: 2, nContigs: 369, nBins: 603 },
} as const

const open = async (uri: string, path: string): Promise<MetaCooler> =>
  MetaCooler.open(uri, await LocalFileSource.open(path))

if (!hasMetacool) {
  describe('Hum53.metacool', () => {
    it.skip(
      `skipped: ${METACOOL} is not present. data/ is gitignored because the reference ` +
        `file is 26 MB; without it these integration checks do not run at all.`,
      () => undefined,
    )
  })
}

describe.skipIf(!hasMetacool)('Hum53.metacool — the real 26 MB file', () => {
  let mc: MetaCooler

  // Opened once: `open` reads /genomes and /contigs in full, and /contigs here
  // is 154,468 rows across 19 columns. Re-reading that per test would say
  // nothing new and would dominate the suite's runtime.
  beforeAll(async () => {
    mc = await open(METACOOL, METACOOL)
  })
  afterAll(() => mc?.close())

  it('reports the counts that were verified against h5py', () => {
    expect(mc.layout.kind).toBe('metacool')
    expect(mc.info.format).toBe('HDF5::MetaCooler')
    expect(mc.info.ordering).toBe(REAL.ordering)
    expect(mc.storageMode).toBe(REAL.storageMode)
    expect(mc.info['storage-mode']).toBe(REAL.storageMode)
    expect(mc.binsize).toBe(REAL.binsize)

    expect(mc.nGenomes).toBe(REAL.nGenomes)
    expect(mc.nContigs).toBe(REAL.nContigs)
    expect(mc.nBins).toBe(REAL.nBins)
    expect(mc.shape).toEqual([REAL.nBins, REAL.nBins])

    // Declared vs. actual: the attribute and the dataset shape, separately.
    expect(mc.info.nnz).toBe(REAL.nnz)
    expect(mc.nnz).toBe(REAL.nnz)
    expect(mc.info.ngenomes).toBe(REAL.nGenomes)
    expect(mc.info.ncontigs).toBe(REAL.nContigs)
    expect(mc.info.nbins).toBe(REAL.nBins)

    // `count` is int32 at base resolution on this file; the kind is what the
    // reader resolves, and int32 vs int64 vs float64 must not be hard-coded.
    expect(['i', 'u', 'f']).toContain(mc.countKind)
    expect(mc.countKind).toBe('i')
  })

  it('starts chrom_offset at 0, 223, 427, 622, 790 and ends it at nBins', () => {
    expect(Array.from(mc.coords.chromOffset.slice(0, 5))).toEqual([...REAL.chromOffsetHead])
    expect(mc.coords.chromOffset).toHaveLength(REAL.nContigs + 1)
    expect(mc.coords.chromOffset[REAL.nContigs]).toBe(REAL.nBins)

    // §3.3: the offsets are recomputable from `contigs/length` alone, which is
    // why /bins never has to be read. Checked across the whole file, since a
    // single disagreement anywhere invalidates every bin index downstream.
    let disagreements = 0
    for (let c = 0; c < mc.nContigs; c++) {
      const width = mc.coords.chromOffset[c + 1] - mc.coords.chromOffset[c]
      if (width !== mc.coords.binsInContig(c)) disagreements += 1
    }
    expect(disagreements).toBe(0)
  })

  it('excludes __unbinned__ from display without renumbering anything', () => {
    // The file has it, at index 0, and it stays there.
    expect(mc.genomeNames).toHaveLength(REAL.nGenomes)
    expect(mc.genomeNames[0]).toBe(UNBINNED_NAME)
    expect(mc.hasGenome(UNBINNED_NAME)).toBe(true)

    const display = mc.displayGenomes()
    expect(display).toHaveLength(REAL.nGenomes - 1)
    expect(display.map((i) => mc.genomeNames[i])).not.toContain(UNBINNED_NAME)
    // Matched by name, not by index — and the surviving indices are the file's
    // own, so the first displayable genome is 1 and never a renumbered 0.
    expect(display[0]).toBe(1)
    expect(display[display.length - 1]).toBe(REAL.nGenomes - 1)
    expect(new Set(display).has(0)).toBe(false)

    // Index integrity, the other half of §7.4. Nothing is compacted to close
    // the gap that hiding genome 0 appears to leave.
    expect(mc.genomeContigExtent(0)).toEqual([0, REAL.unassignedContigs])
    expect(mc.genomeExtent(0)).toEqual([0, REAL.unassignedBins])
    // Genome 1's bins start exactly where `__unbinned__`'s end.
    expect(mc.genomeExtent(1)[0]).toBe(REAL.unassignedBins)

    let zeroes = 0
    let maxId = -1
    let nonMonotone = 0
    for (let c = 0; c < mc.nContigs; c++) {
      const gid = mc.contigGenomeIds[c]
      if (gid === 0) zeroes += 1
      if (gid > maxId) maxId = gid
      if (c > 0 && gid < mc.contigGenomeIds[c - 1]) nonMonotone += 1
    }
    expect(zeroes).toBe(REAL.unassignedContigs)
    expect(maxId).toBe(REAL.nGenomes - 1)
    expect(nonMonotone).toBe(0)
  })

  it('reports the unassigned QC statistic and nothing more', () => {
    const stats = mc.unassignedStats()
    expect(stats).not.toBeNull()
    expect(stats!.genomeIndex).toBe(0)
    expect(stats!.contigs).toBe(REAL.unassignedContigs)
    expect(stats!.bins).toBe(REAL.unassignedBins)
    expect(stats!.totalContigs).toBe(REAL.nContigs)
    expect(stats!.totalBins).toBe(REAL.nBins)
    expect(stats!.binFraction).toBeCloseTo(REAL.unassignedBins / REAL.nBins, 12)
    expect(stats!.contigFraction).toBeCloseTo(REAL.unassignedContigs / REAL.nContigs, 12)

    // It is a number, not a route in: the name is still refused at the one
    // place a user can type it, with its own message rather than "unknown".
    const refusal = (() => {
      try {
        parseMetacoolerRange(mc, UNBINNED_NAME)
        return null
      } catch (err) {
        return err as ViewerError
      }
    })()
    expect(refusal?.code).toBe('unbinned-not-displayable')
    expect(refusal?.message).toContain('cannot be displayed')
  })

  it('agrees with /genomes on every genome extent, from arithmetic alone', () => {
    // §3.3 partitioning: genome extents tile bin space contiguously and each
    // one is exactly as wide as the `n_bins` the creator recorded. Sampled
    // across the file rather than exhaustively, because `genomeExtent` runs
    // its contiguity assertion on every call.
    let previousEnd = 0
    const step = Math.floor(REAL.nGenomes / 40)
    for (let g = 0; g < REAL.nGenomes; g += step) {
      const [lo, hi] = mc.genomeExtent(g)
      expect(hi - lo).toBe(Number(requireGenomes(mc).get('n_bins', g)))
      const [c0, c1] = mc.genomeContigExtent(g)
      expect(c1 - c0).toBe(Number(requireGenomes(mc).get('n_contigs', g)))
      expect(lo).toBeGreaterThanOrEqual(previousEnd)
      previousEnd = hi
    }
  })

  it('loads a real MAG as a non-empty, square, symmetric block — touching no /bins path', async () => {
    const paths = instrument(mc.handle)
    const extent = mc.genomeExtent(REAL.mag.name)
    expect(mc.genomeId(REAL.mag.name)).toBe(REAL.mag.index)
    expect(extent[1] - extent[0]).toBe(REAL.mag.nBins)

    const m = await mc.genomeMatrix(REAL.mag.name)
    expect(m.nrows).toBe(REAL.mag.nBins)
    expect(m.ncols).toBe(REAL.mag.nBins) // square
    expect(m.rowExtent).toEqual(extent)
    expect(m.colExtent).toEqual(extent)

    let total = 0
    let diagonal = 0
    let asymmetric = 0
    for (let i = 0; i < m.nrows; i++) {
      for (let j = 0; j < m.ncols; j++) {
        const v = m.values[i * m.ncols + j]
        total += v
        if (i === j) diagonal += v
        if (v !== m.values[j * m.ncols + i]) asymmetric += 1
      }
    }
    expect(asymmetric).toBe(0) // symmetric
    expect(total).toBeGreaterThan(0) // non-empty
    expect(diagonal).toBeGreaterThan(0)
    // A block mirrored *including* its diagonal is still symmetric, so the
    // off-diagonal share is what catches a double-counted diagonal.
    expect(total).toBeGreaterThan(diagonal)

    // House rule #1, checked rather than asserted in prose. Excluding
    // variable-bin files is what removes every /bins access; a read of it here
    // would mean the coordinate model quietly grew a dependency.
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter((p) => /(^|\/)bins($|\/)/.test(p))).toEqual([])
    // What it *did* read: bin1_offset, then two of the pixel columns — each
    // pixel's row is the index's own answer, not `pixels/bin1_id` (§6.2).
    // Three reads, whatever the block's size (§4).
    expect(paths).toEqual([
      'indexes/bin1_offset',
      'pixels/bin2_id',
      'pixels/count',
    ])
  })

  it('rolls a loaded block up to contig level for free, conserving stored pixels', async () => {
    const m = await mc.genomeMatrix(REAL.mag.name)

    const paths = instrument(mc.handle)
    const rolled = mc.aggregate(m, 'contig')
    expect(paths).toEqual([]) // no I/O: the data is already here (§4)
    expect(rolled.nrows).toBe(REAL.mag.nContigs)
    expect(rolled.ncols).toBe(REAL.mag.nContigs)

    // The conserved quantity is the **upper triangle**, not the whole block.
    // A loaded block carries both triangles of an upper-triangular store, so a
    // stored pixel (i, j) with i < j sits at both (i, j) and (j, i); summing
    // the whole thing per contig would count every within-contig pixel twice
    // and inflate precisely the diagonal, where a contig-level map already has
    // its largest values. `_aggregate_sparse` maps each stored pixel once and
    // symmetrises afterwards, and this is that identity.
    const upper = (nrows: number, ncols: number, v: ArrayLike<number>): number => {
      let sum = 0
      for (let i = 0; i < nrows; i++) for (let j = i; j < ncols; j++) sum += v[i * ncols + j]
      return sum
    }
    expect(upper(rolled.nrows, rolled.ncols, rolled.values)).toBe(
      upper(m.nrows, m.ncols, m.values),
    )

    let asymmetric = 0
    let aggregated = 0
    let full = 0
    for (let i = 0; i < rolled.nrows; i++) {
      for (let j = 0; j < rolled.ncols; j++) {
        aggregated += rolled.values[i * rolled.ncols + j]
        if (rolled.values[i * rolled.ncols + j] !== rolled.values[j * rolled.nrows + i]) {
          asymmetric += 1
        }
      }
    }
    for (const v of m.values) full += v
    expect(asymmetric).toBe(0)
    // Stated as an assertion so that "fixing" the fold back into a plain sum
    // fails here rather than passing quietly: this MAG has intra-contig
    // contacts, so the naive total is strictly larger.
    expect(aggregated).toBeLessThan(full)
  })
})

if (!hasMmetacool) {
  describe('Hum53.mmetacool', () => {
    it.skip(`skipped: ${MMETACOOL} is not present (data/ is gitignored).`, () => undefined)
  })
}

describe.skipIf(!hasMmetacool)('Hum53.mmetacool — a collection, opened by entry', () => {
  it('refuses at the root and names the entries and the :: syntax', async () => {
    const error = await open(MMETACOOL, MMETACOOL).then(
      (mc) => {
        mc.close()
        return null
      },
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(ViewerError)
    const refusal = error as ViewerError
    expect(refusal.code).toBe('mmetacool-root')
    expect(refusal.message).toContain('No metacool entry at root')
    expect(refusal.message).toContain("Use '::' to specify a group path")

    const entries = refusal.detail['entries'] as string[]
    expect(entries.length).toBeGreaterThan(0)
    // This file is `zoomify` output, so every entry name is a bin size: the
    // ladder branch of §3.4.
    expect(allIntegers(entries)).toBe(true)
    for (const entry of entries) expect(refusal.message).toContain(`/entries/${entry}`)
  })

  it('opens the entry named by the URI, and the name is its bin size', async () => {
    const uri = `${MMETACOOL}::entries/1000`
    const mc = await open(uri, MMETACOOL)
    try {
      expect(mc.layout.kind).toBe('metacool')
      expect(mc.layout.group).toBe('/entries/1000')
      expect(mc.binsize).toBe(1000)
      // Same data as the standalone file, addressed through the collection.
      expect(mc.nGenomes).toBe(REAL.nGenomes)
      expect(mc.nContigs).toBe(REAL.nContigs)
      expect(mc.nBins).toBe(REAL.nBins)
      expect(mc.genomeNames[0]).toBe(UNBINNED_NAME)
      expect(mc.displayGenomes()).toHaveLength(REAL.nGenomes - 1)
    } finally {
      mc.close()
    }
  })
})

/**
 * Record every dataset path an open handle reads from, until the returned array
 * is inspected.
 *
 * The handle's methods live on its prototype, so assigning own properties here
 * shadows them for this instance only and the recording disappears with the
 * object. This is deliberately a black-box check: it proves what the reader
 * *does*, which is the only form of the `/bins` rule that survives a refactor.
 */
function instrument(handle: Hdf5Handle): string[] {
  const paths: string[] = []
  const wrap = <K extends 'readNumeric' | 'readInt32' | 'readStrings' | 'readTable'>(
    key: K,
  ): void => {
    const original = handle[key].bind(handle) as (...args: never[]) => unknown
    Object.defineProperty(handle, key, {
      configurable: true,
      value: (path: string, ...rest: never[]) => {
        paths.push(path.replace(/^\/+/, ''))
        return original(path as never, ...rest)
      },
    })
  }
  wrap('readNumeric')
  // The bin id columns go through `readInt32`, which narrows int64 straight to
  // the width they are used at. Leaving it unwrapped would make a four-read
  // block look like a two-read one and hide a scan that arrived through it.
  wrap('readInt32')
  wrap('readStrings')
  wrap('readTable')
  return paths
}

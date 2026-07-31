/**
 * `MetaCooler.open` against the Python oracle (spec §6).
 *
 * Every accepted `.metacool` map — the plain files *and* each `.mmetacool`
 * entry — is opened and compared, field by field, with the golden that
 * `scripts/make_golden.py` produced from the Python `MetaCooler`. Nothing in
 * this file states an expected value of its own: if the JS and the Python
 * reader disagree about a file, this suite says so.
 *
 * Plain cool/mcool fixtures are absent on purpose: §9's synthesised
 * single-genome view is not built yet, and `MetaCooler.fromHandle` refuses
 * them with `unsupported`. That refusal is asserted at the end so the gap
 * stays visible.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError } from '../../src/errors'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import {
  deepScrub,
  fixturePath,
  goldenEquals,
  goldenMaps,
  manifest,
  withMap,
  withoutKeys,
} from './_golden'

const MAPS = goldenMaps({ full: true })

describe('every accepted map reproduces its golden', () => {
  it('there is more than one map to check', () => {
    // Guards against a silently empty table: a broken helper would otherwise
    // make this whole file pass by running nothing.
    expect(MAPS.length).toBeGreaterThanOrEqual(9)
  })

  describe.each(MAPS.map((m) => [m.id, m] as const))('%s', (_id, map) => {
    const golden = map.golden

    it('info', async () => {
      await withMap(map, (mc) => {
        const info = withoutKeys(
          mc.info as unknown as Record<string, unknown>,
          manifest.info_volatile_keys,
        )
        expect(info).toEqual(golden.info)
        // The renames are metacooler's, not cooler's: `info.format` is the
        // *metacooler* identity even though the file's `format` attribute
        // says HDF5::Cooler, and `nchroms` is reported as `ncontigs`.
        expect(mc.info.format).toBe('HDF5::MetaCooler')
        expect(mc.info.ordering).toBe('genome-then-length')
      })
    })

    it('metadata', async () => {
      await withMap(map, (mc) => {
        // `deepScrub` is the golden's own path scrubbing, not a fudge: a
        // `binnify`d file records its absolute source path inside
        // `metadata.binnify[].source`, and `zoomify` copies that into every
        // entry, so both sides have to be made location-independent.
        const metadata = deepScrub(withoutKeys(mc.metadata, manifest.metadata_volatile_keys))
        expect(metadata).toEqual(golden.metadata)
        // `commands` is metacooler's provenance record; the golden redacts it
        // because it embeds absolute paths, but it must still be *there*.
        expect(Object.keys(mc.metadata)).toContain('commands')
      })
    })

    it('shape, binsize and the count dtype kind', async () => {
      await withMap(map, (mc) => {
        expect(mc.shape).toEqual(golden.shape)
        expect(mc.binsize).toBe(golden.binsize)
        expect(mc.nBins).toBe(golden.shape[0])
        expect(mc.nContigs).toBe(golden.contigs.length)
        expect(mc.nGenomes).toBe(golden.genomes.length)
        // Kind, never an exact dtype: `i`, `u` and `f` are all legal for
        // pixels/count (correction #2).
        expect(mc.countKind).toBe(golden.count_dtype_kind)
      })
    })

    it('/genomes, with every column the creator wrote', async () => {
      await withMap(map, (mc) => {
        expectTable(mc.genomes, golden.genomes)
      })
    })

    it('/contigs', async () => {
      await withMap(map, (mc) => {
        expectTable(mc.contigs, golden.contigs)
      })
    })

    it('chromnames and chromsizes', async () => {
      await withMap(map, (mc) => {
        expect(mc.chromnames).toEqual(golden.chromnames)
        expect(Object.fromEntries(mc.chromsizes)).toEqual(golden.chromsizes)
      })
    })

    it('genome_extent, for every genome including __unbinned__', async () => {
      await withMap(map, (mc) => {
        const extents = golden.genome_extent as Record<string, [number, number]>
        expect(Object.keys(extents).length).toBe(mc.nGenomes)
        for (const [name, expected] of Object.entries(extents)) {
          expect([name, mc.genomeExtent(name)]).toEqual([name, expected])
        }
        // The extents partition bin space with no gap and no overlap, and each
        // width is the genome's own n_bins — the property that makes a genome
        // one bounded read under `genome-then-length`.
        const ordered = mc.genomeNames.map((n) => mc.genomeExtent(n))
        let cursor = 0
        for (let g = 0; g < ordered.length; g++) {
          const [lo, hi] = ordered[g]
          if (hi === 0 && lo === 0) continue
          expect(lo).toBe(cursor)
          expect(hi - lo).toBe(Number(mc.genomes.get('n_bins', g)))
          cursor = hi
        }
        expect(cursor).toBe(mc.nBins)
      })
    })

    it('contig_extent, and the §3.3 arithmetic behind it', async () => {
      await withMap(map, (mc) => {
        const extents = golden.contig_extent as Record<string, [number, number]>
        for (const [name, expected] of Object.entries(extents)) {
          expect([name, mc.contigExtent(name)]).toEqual([name, expected])
        }
        // ceil(length / binsize) derived from `contigs/length`, never from a
        // read of /bins — and it must equal what chrom_offset says.
        for (let c = 0; c < mc.nContigs; c++) {
          const [lo, hi] = mc.coords.contigBinExtent(c)
          expect(hi - lo).toBe(mc.coords.binsInContig(c))
        }
      })
    })

    it('the offset arrays', async () => {
      await withMap(map, (mc) => {
        const indexes = golden.indexes as Record<string, number[]>
        expect(Array.from(mc.handle.readNumeric('indexes/chrom_offset'))).toEqual(
          indexes.chrom_offset,
        )
        expect(Array.from(mc.handle.readNumeric('indexes/genome_offset'))).toEqual(
          indexes.genome_offset,
        )
        expect(Array.from(mc.handle.readNumeric('indexes/bin1_offset'))).toEqual(
          indexes.bin1_offset,
        )
      })
    })

    it('the /chroms soft link that keeps the file cooler-readable', async () => {
      await withMap(map, (mc) => {
        expect(mc.handle.isSoftLink('chroms')).toBe(golden.chroms_is_soft_link)
        expect(golden.chroms_is_soft_link).toBe(true)
      })
    })

    it('__unbinned__ is excluded from display without being renumbered (§7.4)', async () => {
      await withMap(map, (mc) => {
        const displayed = mc.displayGenomes()
        expect(displayed.map((i) => mc.genomeNames[i])).toEqual(golden.displayable_genomes)

        const unbinned = golden.unbinned as Record<string, unknown>
        const stats = mc.unassignedStats()
        if (unbinned.present === false) {
          // `create --drop-unassigned` omits the row entirely, which is what
          // makes genome 0 an ordinary MAG in the cleanest files.
          expect(stats).toBeNull()
          expect(displayed[0]).toBe(0)
          return
        }
        expect(stats).not.toBeNull()
        expect(stats!.genomeIndex).toBe(unbinned.genome_id)
        expect(stats!.contigs).toBe(unbinned.n_contigs)
        expect(stats!.bins).toBe(unbinned.n_bins)
        expect(stats!.contigFraction).toBe(unbinned.frac_contigs)
        expect(stats!.binFraction).toBe(unbinned.frac_bins)
        // Nothing was compacted to close the gap: the displayable genomes keep
        // their true indices, so the first one is 1 when __unbinned__ is 0.
        expect(mc.genomeNames[unbinned.genome_id as number]).toBe(manifest.unbinned_name)
        expect(displayed).not.toContain(unbinned.genome_id)
        expect(displayed[0]).toBe(1)
      })
    })

    it('the density proxy, from two bin1_offset lookups', async () => {
      await withMap(map, (mc) => {
        for (const [name, expected] of Object.entries(
          golden.density_proxy as Record<string, number>,
        )) {
          expect([name, mc.genomeDensity(name)]).toEqual([name, expected])
        }
      })
    })
  })
})

describe('plain cooler files are detected but not yet openable as maps (§9)', () => {
  it.each(['plain.cool', 'plain.mcool::resolutions/1000'])('%s', async (uri) => {
    const file = uri.split('::')[0]
    const source = await LocalFileSource.open(fixturePath(file))
    let thrown: unknown
    try {
      const mc = await MetaCooler.open(uri.replace(file, fixturePath(file)), source)
      mc.close()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ViewerError)
    expect((thrown as ViewerError).code).toBe('unsupported')
    // The synthesised single-genome view (§9) is M4 work; until it exists the
    // refusal must say so rather than pretending the file is malformed.
    expect((thrown as ViewerError).message).toContain('synthesised single-genome view')
  })
})

// ---------------------------------------------------------------------------

/** Compare a reader `Table` with a golden's row-oriented dump. */
function expectTable(
  table: { length: number; columns: string[]; get(c: string, r: number): unknown },
  golden: { length: number; columns: string[]; rows: Record<string, unknown>[] },
): void {
  expect(table.length).toBe(golden.length)
  // Column *order* is HDF5 group order in JS and DataFrame order in Python, so
  // the sets are compared, not the sequences. What matters is that no column
  // the creator wrote was dropped (spec §5.1).
  expect([...table.columns].sort()).toEqual([...golden.columns].sort())

  const mismatches: string[] = []
  for (let row = 0; row < golden.length; row++) {
    for (const column of golden.columns) {
      const actual = table.get(column, row)
      const expected = golden.rows[row][column]
      if (!goldenEquals(actual, expected)) {
        mismatches.push(`row ${row} column ${column}: ${String(actual)} != ${String(expected)}`)
      }
    }
  }
  expect(mismatches).toEqual([])
}

/**
 * Where the naming conventions actually reach the application (§5.9).
 *
 * `naming.test.ts` pins the matcher. This pins the four places its answer
 * changes what a reader sees, and — just as importantly — the places it must
 * change nothing:
 *
 * - **the range**, which is what a companion panel resolves a shared region
 *   through, and the reason a `.hic` and a `.cool` of one genome can now be
 *   navigated as one deck;
 * - **the locus box**, on the 1D browser;
 * - **`contigOf`**, which is how a region carried in from a link or a bookmark
 *   is attributed to a sequence;
 * - **a tabix index**, where a failed match costs a whole-file read.
 *
 * The fidelity half is the first `describe`: `parseMetacoolerRange` is a port of
 * `metacooler.ops.range` and must stay one, so every label a file *does* carry
 * has to resolve exactly as it did before the matcher existed.
 */

import { describe, expect, it } from 'vitest'

import { assemblyOf, findContig, parseLocus } from '../../src/genome/assembly'
import { parseMetacoolerRange, type RangeTarget } from '../../src/metacooler/range'
import { NameIndex } from '../../src/genome/naming'
import { matchNames, type TabixIndex } from '../../src/annotations/tabix'
import { contigOf } from '../../src/ui/labels'
import type { Extent, Table } from '../../src/types'

/** The two columns `RangeTarget` reads, in the shape `Table` wants them. */
function table(names: string[], lengths: number[]): Table {
  const data: Record<string, string[] | Float64Array> = {
    name: names,
    length: Float64Array.from(lengths),
  }
  return {
    length: names.length,
    columns: ['name', 'length'],
    data,
    get: (column, row) => (column === 'name' ? names[row] : lengths[row]),
    strings: () => names,
    numbers: () => lengths,
  }
}

/**
 * A file that names its sequences `names`, at 1 kb bins.
 *
 * Hand-built rather than opened from a fixture: the fixtures need a Python
 * `metacooler` to generate and this is a test about *strings*, so tying it to
 * them would make the naming rules unverifiable on a fresh clone.
 */
function fileNaming(names: string[], lengths?: number[], genomes: string[] = []): RangeTarget {
  const sizes = lengths ?? names.map(() => 10_000)
  const contigs = table(names, sizes)
  return {
    genomes: genomes.length === 0 ? null : table(genomes, genomes.map(() => 0)),
    contigs,
    names: NameIndex.of(names.map((name, i) => ({ name, length: sizes[i] }))),
    displayGenomes: () => genomes.map((_, i) => i),
    genomeExtent: () => [0, 10] as Extent,
    extent: (region: string) => {
      const id = names.indexOf(region.split(':')[0])
      return [id * 10, id * 10 + 10] as Extent
    },
  }
}

describe('the range still resolves every name the file has, exactly as it did', () => {
  const ensembl = fileNaming(['1', '2', 'MT'])

  it('resolves a name the file carries, with no interpretation', () => {
    const parsed = parseMetacoolerRange(ensembl, '1')
    expect(parsed).toMatchObject({ kind: 'contig', label: '1' })
    expect(parsed.matched).toBeUndefined()
  })

  it('lets a genome name win over a contig of the same name, as Python does', () => {
    const both = fileNaming(['MAG_1'], undefined, ['MAG_1'])
    expect(parseMetacoolerRange(both, 'MAG_1').kind).toBe('genome')
  })

  it('still refuses a name that is nothing under any convention', () => {
    // A file with no genome layer is told about its sequences alone; the
    // genome-or-contig sentence is `ops/range.py`'s, kept for the files that
    // have genomes (§9).
    expect(() => parseMetacoolerRange(ensembl, 'no_such_thing')).toThrowError(
      /not a sequence of this file/,
    )
  })

  it('never matches a genome name across conventions', () => {
    // A metacool's genome layer is independently assembled organisms, and two
    // of them agree about a name by coincidence (§8.5). Only contigs get the
    // second hearing.
    const mags = fileNaming(['contig_1'], undefined, ['MAG_01'])
    expect(() => parseMetacoolerRange(mags, 'MAG_1')).toThrowError(/not a known genome or contig/)
  })
})

describe('the range resolves a name from a file of another convention', () => {
  const ensembl = fileNaming(['1', '2', '12', 'X', 'MT'])

  it('answers a UCSC region against an Ensembl file, and says it did', () => {
    const parsed = parseMetacoolerRange(ensembl, 'chr1')
    expect(parsed.label).toBe('1')
    expect(parsed.matched).toMatchObject({ asked: 'chr1', name: '1', tier: 'prefix' })
  })

  it('keeps the coordinate suffix through the rename', () => {
    // The bin extent is the file's own; what had to change is only the label in
    // front of the colon.
    const parsed = parseMetacoolerRange(ensembl, 'chr12:1000-2000')
    expect(parsed.label).toBe('12')
    expect(parsed.matched?.asked).toBe('chr12')
  })

  it('answers the organelle whatever it is called', () => {
    expect(parseMetacoolerRange(ensembl, 'chrM').label).toBe('MT')
  })

  it('answers a Roman numeral from a file that counts in digits', () => {
    expect(parseMetacoolerRange(ensembl, 'chrXII').label).toBe('12')
  })

  it('takes the lead’s reading of X where the lead counts in Roman', () => {
    const yeast = fileNaming(['09', '10', '11'])
    const roman = NameIndex.ofNames(['chrIX', 'chrX', 'chrXI']).context
    expect(parseMetacoolerRange(yeast, 'chrX', roman).label).toBe('10')
    // And refuses to guess it without that context, because `X` alone is the
    // sex chromosome far more often than it is ten.
    expect(() => parseMetacoolerRange(yeast, 'chrX')).toThrowError(/not a sequence of this file/)
  })

  it('does not rename an assembler’s contig into a chromosome', () => {
    const mag = fileNaming(['NODE_1_length_500_cov_2', 'NODE_2_length_400_cov_3'])
    expect(() => parseMetacoolerRange(mag, 'chr1')).toThrowError(/not a sequence of this file/)
    expect(() => parseMetacoolerRange(mag, '1')).toThrowError(/not a sequence of this file/)
  })
})

describe('the locus box', () => {
  const human = assemblyOf({
    uri: 'x.chrom.sizes',
    name: 'x',
    origin: 'sizes',
    contigs: [
      { name: '1', length: 248_956_422 },
      { name: '12', length: 133_275_309 },
      { name: 'X', length: 156_040_895 },
      { name: 'MT', length: 16_569 },
    ],
  })

  it('finds a sequence by any convention', () => {
    expect(findContig(human, 'chr1')?.name).toBe('1')
    expect(findContig(human, '01')?.name).toBe('1')
    expect(findContig(human, 'chrXII')?.name).toBe('12')
    expect(findContig(human, 'chrM')?.name).toBe('MT')
    expect(findContig(human, 'NC_000001.11')?.name).toBe('1')
  })

  it('lets a name the file really has win over an interpreted one', () => {
    const muddled = assemblyOf({
      uri: 'y',
      name: 'y',
      origin: 'sizes',
      contigs: [
        { name: 'chr1', length: 100 },
        { name: '1', length: 200 },
      ],
    })
    expect(findContig(muddled, '1')?.name).toBe('1')
    expect(findContig(muddled, 'chr1')?.name).toBe('chr1')
  })

  it('parses a window on a name written another way', () => {
    expect(parseLocus('chr1:1,001-2,000', human)).toEqual({ contig: '1', start: 1000, end: 2000 })
  })

  it('still finds nothing where there is nothing', () => {
    expect(findContig(human, 'chr7')).toBeNull()
    expect(parseLocus('scaffold_9:1-2', human)).toBeNull()
  })
})

describe('attributing a region to a sequence', () => {
  const names = ['1', '12', 'MT', 'NODE_1:2']

  it('takes the file’s own name first, whole string before head', () => {
    expect(contigOf('1', names)).toBe('1')
    expect(contigOf('NODE_1:2', names)).toBe('NODE_1:2')
  })

  it('resolves a region carried in from another convention', () => {
    expect(contigOf('chr1', names)).toBe('1')
    expect(contigOf('chr12:1000-2000', names)).toBe('12')
    expect(contigOf('chrM', names)).toBe('MT')
  })

  it('names none of them where none of them is it', () => {
    expect(contigOf('chr7', names)).toBeNull()
  })
})

describe('a tabix index, where a failed match costs a whole-file read', () => {
  const index = (names: string[]): TabixIndex => ({
    names,
    spans: new Map(),
    format: 0,
    meta: '#',
    skip: 0,
  })

  it('finds the sequences a map wants under the index’s own spelling', () => {
    expect(matchNames(index(['chr1', 'chr2', 'chrM']), ['1', '2'])).toEqual(['chr1', 'chr2'])
    expect(matchNames(index(['01', '02']), ['chrI', 'chrII'])).toEqual(['01', '02'])
  })

  it('reads the whole file where nothing matches, as it always did', () => {
    // Not "read nothing": a file about another assembly is the caller's overlap
    // report to explain, and reading it whole is what happens without an index.
    expect(matchNames(index(['chr1']), ['NODE_7'])).toEqual(['chr1'])
    expect(matchNames(index(['chr1']), [])).toEqual(['chr1'])
  })
})

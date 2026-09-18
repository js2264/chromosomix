/**
 * A window typed **across the origin** of a circular sequence (§8.15).
 *
 * `chr:2,900,000-100,000` on a 3 Mb bacterial chromosome is not a typing
 * mistake: it is the 200 kb either side of the junction, which on a circle holds
 * the most local contacts there are and is the one window a linear reading
 * cannot ask for. cooler refuses it, correctly, because a `.cool` cannot say
 * that a sequence joins its own ends — so the refusal is lifted for exactly the
 * sequences the reader has declared, and for nothing else.
 *
 * What is checked here is the arithmetic and the boundary around it: the extent
 * comes back **unwrapped**, in the space `worker/wrap.ts` consumes, and every
 * range that is not a declared sequence reading backwards keeps cooler's own
 * answer.
 */

import { describe, expect, it } from 'vitest'

import { makeTable } from '@/h5/readTable'
import {
  parseMetacoolerRange,
  parseRegion,
  parseRegionString,
  regionToExtent,
  type RangeTarget,
} from '@/metacooler/range'
import type { Extent } from '@/types'

const BINSIZE = 1_000
/** Two sequences: a 3 Mb chromosome and a 20 kb plasmid, laid end to end. */
const CONTIGS = [
  { name: 'chr', length: 3_000_000 },
  { name: 'plasmid', length: 20_000 },
]

/** `chrom_offset`, as a `.cool` writes it: one entry per contig, plus the end. */
const OFFSET = (() => {
  const out = [0]
  for (const contig of CONTIGS) out.push(out[out.length - 1] + contig.length / BINSIZE)
  return out
})()

const SIZES = new Map(CONTIGS.map((contig) => [contig.name, contig.length]))

/**
 * A reader of the shape {@link RangeTarget} asks for, and nothing more.
 *
 * `extent` is `MetaCooler.extent` line for line — cooler's `parse_region`
 * followed by `regionToExtent` — because the whole point of the wrapped path is
 * that it is built out of two *ordinary* extents, and a mock that did its own
 * arithmetic would be testing the mock.
 */
const TARGET: RangeTarget = {
  genomes: null,
  contigs: makeTable(CONTIGS.length, ['name', 'length'], {
    name: CONTIGS.map((contig) => contig.name),
    length: Float64Array.from(CONTIGS.map((contig) => contig.length)),
  }),
  displayGenomes: () => [],
  genomeExtent: () => [0, 0],
  extent(region: string): Extent {
    const [name, start, end] = parseRegion(region, SIZES)
    return regionToExtent(
      OFFSET,
      CONTIGS.findIndex((contig) => contig.name === name),
      start,
      end,
      BINSIZE,
    )
  },
}

describe('a sequence nobody has declared', () => {
  it('refuses a range that reads backwards, in cooler’s own words', () => {
    expect(() => parseMetacoolerRange(TARGET, 'chr:2900000-100000')).toThrowError(
      /End coordinate less than start/,
    )
  })

  it('refuses it just the same when *another* sequence is the circle', () => {
    expect(() =>
      parseMetacoolerRange(TARGET, 'chr:2900000-100000', undefined, ['plasmid']),
    ).toThrowError(/End coordinate less than start/)
  })

  it('says where the tick is, because the reader usually meant it', () => {
    expect(() => parseMetacoolerRange(TARGET, 'chr:2900000-100000')).toThrowError(
      /circular column of the Chromosomes table/,
    )
  })
})

describe('a sequence the reader has declared circular', () => {
  it('reads a backwards range as the window across the origin', () => {
    const parsed = parseMetacoolerRange(TARGET, 'chr:2900000-100000', undefined, ['chr'])
    // Unwrapped: 2,900 bins in, and 3,100 bins along — a hundred of which are
    // past the end of the sequence and come back on at its beginning.
    expect([...parsed.extent]).toEqual([2_900, 3_100])
    expect(parsed.kind).toBe('contig')
    expect(parsed.label).toBe('chr')
  })

  it('never returns a window wider than one lap', () => {
    const parsed = parseMetacoolerRange(TARGET, 'chr:1000-999000', undefined, ['chr'])
    // Forwards, so not a wrap at all: cooler's own extent, untouched.
    expect([...parsed.extent]).toEqual([1, 999])
  })

  it('reads a window that ends exactly at the origin as the head alone', () => {
    const parsed = parseMetacoolerRange(TARGET, 'chr:2900000-0', undefined, ['chr'])
    expect([...parsed.extent]).toEqual([2_900, 3_000])
  })

  it('leaves an ordinary forwards window alone', () => {
    const wrapped = parseMetacoolerRange(TARGET, 'chr:10000-20000', undefined, ['chr'])
    const plain = parseMetacoolerRange(TARGET, 'chr:10000-20000')
    expect([...wrapped.extent]).toEqual([...plain.extent])
  })

  it('leaves a bare sequence name alone', () => {
    const parsed = parseMetacoolerRange(TARGET, 'chr', undefined, ['chr'])
    expect([...parsed.extent]).toEqual([0, 3_000])
  })

  it('wraps the second sequence in its own bin space, not the first’s', () => {
    const parsed = parseMetacoolerRange(TARGET, 'plasmid:18000-2000', undefined, ['plasmid'])
    // The plasmid's own bins start at 3,000, so the window opens at 3,018 and
    // runs two bins past 3,020.
    expect([...parsed.extent]).toEqual([3_018, 3_022])
  })

  it('still refuses coordinates outside the sequence', () => {
    // The head is `chr:4000000-`, which is an ordinary range and out of the
    // sequence: the wrap is built from reads that bounds-check themselves, so a
    // declaration cannot buy a window the file has no bins for.
    expect(() =>
      parseMetacoolerRange(TARGET, 'chr:4000000-100000', undefined, ['chr']),
    ).toThrowError(/End cannot be less than start/)
    expect(() =>
      parseMetacoolerRange(TARGET, 'chr:2900000-4000000', undefined, ['chr']),
    ).toThrowError(/out of bounds/)
  })
})

describe('the loosened parse', () => {
  it('is opt-in, so every other caller keeps the refusal', () => {
    expect(() => parseRegionString('chr:200-100')).toThrowError(/End coordinate less than start/)
    expect(parseRegionString('chr:200-100', { reversed: true })).toEqual(['chr', 200, 100])
  })
})

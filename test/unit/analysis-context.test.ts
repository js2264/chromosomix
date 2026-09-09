/**
 * The context the Analysis panel is built from (§18).
 *
 * Two things here are worth a test rather than a read-through, and both are
 * arithmetic that fails by looking plausible.
 *
 * `startBin` is recomputed on the main thread from contig lengths, because the
 * reader has never had a reason to send `chrom_offset` and adding a field to
 * `OpenResult` for a panel is the wrong direction (`analysis/context.ts`). That
 * makes it a *second* implementation of §3.3's offset arithmetic, and a second
 * implementation is exactly the thing that drifts — so it is checked against the
 * rule the first one follows: the last bin of a contig is partial and is still a
 * bin.
 *
 * And a genome's extent is derived from where its contigs are rather than from a
 * column, which is only correct because §3.3's `genome-then-length` ordering
 * makes each genome one contiguous run. If that ever stopped being true this is
 * the test that would say so.
 */

import { describe, expect, it } from 'vitest'

import {
  binsForLength,
  buildAnalysisContext,
  contigNamed,
  framingCovers,
  type ContextInput,
} from '../../src/analysis/context'
import type { AnalysisFraming } from '../../src/analysis/types'
import { browsingBinsize } from '../../src/genome/assembly'

function table(
  names: string[],
  lengths: number[],
  genomeIds?: number[],
): ContextInput['contigs'] {
  return {
    length: names.length,
    columns: genomeIds === undefined ? ['name', 'length'] : ['name', 'length', 'genome_id'],
    data: {
      name: names,
      length: Float64Array.from(lengths),
      ...(genomeIds === undefined ? {} : { genome_id: Float64Array.from(genomeIds) }),
    },
  }
}

function input(overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    uri: 'demo.cool',
    layout: 'cool',
    binsize: 1000,
    nBins: 0,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
    contigs: null,
    genomes: null,
    displayGenomes: null,
    entries: [],
    framing: null,
    blockLoaded: false,
    blockBytes: 0,
    ...overrides,
  }
}

describe('binsForLength', () => {
  it('counts the partial last bin, because it is a bin', () => {
    expect(binsForLength(1000, 1000)).toBe(1)
    // The case the whole test exists for: one base past a boundary is a second
    // bin, and rounding down here shifts every contig after it.
    expect(binsForLength(1001, 1000)).toBe(2)
    expect(binsForLength(2500, 1000)).toBe(3)
  })

  it('answers zero rather than NaN or Infinity for a degenerate input', () => {
    expect(binsForLength(0, 1000)).toBe(0)
    expect(binsForLength(1000, 0)).toBe(0)
  })
})

describe('buildAnalysisContext', () => {
  it('lays contigs out end to end, each starting where the last one ended', () => {
    const context = buildAnalysisContext(
      input({ contigs: table(['chrI', 'chrII', 'chrIII'], [2500, 1000, 1001]) }),
    )
    expect(context.contigs.map((c) => c.bins)).toEqual([3, 1, 2])
    expect(context.contigs.map((c) => c.startBin)).toEqual([0, 3, 4])
  })

  it('has no genomes for a plain cooler, rather than an empty list', () => {
    const context = buildAnalysisContext(input({ contigs: table(['chrI'], [1000]) }))
    // `null` and `[]` mean different things to a task's `appliesTo`: one is "this
    // file has no genome layer", the other is "it has one and it is empty".
    expect(context.genomes).toBeNull()
  })

  it('derives each genome extent from the run of contigs that belong to it', () => {
    const context = buildAnalysisContext(
      input({
        layout: 'metacool',
        hasGenomes: true,
        contigs: table(
          ['a1', 'a2', 'b1', 'b2'],
          [2000, 1000, 3000, 1000],
          [0, 0, 1, 1],
        ),
        genomes: {
          length: 2,
          columns: ['name'],
          data: { name: ['MAG_A', 'MAG_B'] },
        },
      }),
    )
    expect(context.genomes).toEqual([
      { name: 'MAG_A', extent: [0, 3], contigs: 2 },
      { name: 'MAG_B', extent: [3, 7], contigs: 2 },
    ])
  })

  it('omits a genome the reader did not list for display', () => {
    // §7.4: `__unbinned__` is excluded by the reader's own `display` list and is
    // never matched by name a second time here.
    const context = buildAnalysisContext(
      input({
        layout: 'metacool',
        hasGenomes: true,
        contigs: table(['a1', 'u1'], [1000, 1000], [0, 1]),
        genomes: {
          length: 2,
          columns: ['name'],
          data: { name: ['MAG_A', '__unbinned__'] },
        },
        displayGenomes: Int32Array.from([0]),
      }),
    )
    expect(context.genomes?.map((g) => g.name)).toEqual(['MAG_A'])
  })

  it('survives a contigs table it has not been sent', () => {
    const context = buildAnalysisContext(input({ contigs: null }))
    expect(context.contigs).toEqual([])
    expect(context.genomes).toBeNull()
  })
})

describe('contigNamed', () => {
  it('finds a contig, and answers undefined rather than throwing', () => {
    const context = buildAnalysisContext(
      input({ contigs: table(['chrI', 'chrII'], [1000, 1000]) }),
    )
    expect(contigNamed(context, 'chrII')?.startBin).toBe(1)
    expect(contigNamed(context, 'chrIX')).toBeUndefined()
  })
})

describe('framingCovers', () => {
  const framing = (rows: [number, number], cols: [number, number]): AnalysisFraming => ({
    uri: 'demo.cool',
    rows,
    cols,
    binsize: 1000,
    binsPerCell: 1,
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
    label: 'demo',
  })

  it('requires both axes, not just the rows', () => {
    // The cheapest way to get this wrong is to check the rows and assume the
    // columns, which silently lets an on-diagonal task borrow an off-diagonal
    // block.
    expect(framingCovers(framing([0, 100], [0, 100]), [10, 50])).toBe(true)
    expect(framingCovers(framing([0, 100], [200, 300]), [10, 50])).toBe(false)
  })

  it('is false with no framing at all', () => {
    expect(framingCovers(null, [0, 1])).toBe(false)
  })
})

/**
 * The shape a **genome-browser session** builds a context in, pinned.
 *
 * Two facts have to hold at once and they pull in opposite directions, which is
 * why they are asserted together rather than separately. There is no matrix, so
 * every task needing one must stay `waiting` — that is `hasMap`, and `nBins` of
 * zero is what keeps it false. And yet a task answering from the *sequence* can
 * run here and produce a per-bin lane, so the grid must be real — which the bin
 * size is what decides.
 *
 * Reporting the bin size as `0` satisfied the first and quietly broke the
 * second: `binsForLength` returns zero bins for a zero bin size, so every contig
 * got no bins, and a profile registered against that grid is a lane that is
 * permanently empty rather than one that is visibly wrong. Nothing reports that.
 */
describe('a session with tracks and no contact map', () => {
  const contigs = table(['chrI', 'chrII'], [230_218, 813_184])
  const total = 230_218 + 813_184

  it('has a real bin grid, laid end to end', () => {
    const context = buildAnalysisContext(
      input({ contigs, binsize: browsingBinsize(total), nBins: 0 }),
    )
    const binsize = browsingBinsize(total)
    expect(context.contigs.map((contig) => contig.bins)).toEqual([
      Math.ceil(230_218 / binsize),
      Math.ceil(813_184 / binsize),
    ])
    expect(context.contigs[0].startBin).toBe(0)
    expect(context.contigs[1].startBin).toBe(context.contigs[0].bins)
    for (const contig of context.contigs) expect(contig.bins).toBeGreaterThan(0)
  })

  it('still says it has no map, so the tasks that need one keep waiting', () => {
    const context = buildAnalysisContext(
      input({ contigs, binsize: browsingBinsize(total), nBins: 0 }),
    )
    expect(context.hasMap).toBe(false)
  })

  it('is the case a bin size of zero got wrong', () => {
    // The regression this pair exists to catch: no bins anywhere, and so a lane
    // with nothing in it rather than a lane with the wrong thing in it.
    const context = buildAnalysisContext(input({ contigs, binsize: 0, nBins: 0 }))
    expect(context.contigs.every((contig) => contig.bins === 0)).toBe(true)
  })
})

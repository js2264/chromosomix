/**
 * The metagenome accumulators, and the one rule that makes them diagnostics.
 *
 * `__unbinned__` is not a genome (§7.4). Its bins map to `-1`, and a `-1` at
 * either end of a pixel drops that pixel entirely rather than counting it as an
 * inter-MAG contact — because counting it would make every real MAG look leakier
 * in proportion to how badly the *rest* of the file was binned, which is the
 * opposite of a per-MAG diagnostic. That is the property most worth pinning
 * here, and it is the one a reimplementation would get wrong by writing the
 * obvious `else` branch.
 *
 * At the end, the inter-MAG network run on the matrix the QC pass produces:
 * each of its three edge weights, on a file small enough to do by hand.
 */

import { describe, expect, it } from 'vitest'

import type { JobContext } from '@/analysis/job'
import {
  binContigIndex,
  binGenomeMap,
  ContigPurityAccumulator,
  GenomeContactAccumulator,
} from '@/analysis/mags'
import { runMagNetwork, runMagQc } from '@/analysis/run/mags'
import type { AnalysisFraming, Params, TableOutput } from '@/analysis/types'
import type { TaskInputs } from '@/analysis/worker/protocol'
import type { MetaCooler } from '@/metacooler/MetaCooler'

/** Two MAGs of two contigs each, plus one unassigned contig. */
const CONTIGS = [
  { startBin: 0, bins: 2, genome: 0 },
  { startBin: 2, bins: 2, genome: 0 },
  { startBin: 4, bins: 2, genome: 1 },
  { startBin: 6, bins: 2, genome: 1 },
  { startBin: 8, bins: 2, genome: 2 },
]
const N_BINS = 10
/** Genome 2 stands for `__unbinned__`: real in the file, absent from display. */
const DISPLAYED = new Set([0, 1])

describe('binGenomeMap', () => {
  it('labels every bin with its genome and leaves the rest at -1', () => {
    const map = binGenomeMap(CONTIGS, N_BINS, DISPLAYED)
    expect(Array.from(map)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, -1, -1])
  })

  it('takes every genome when nothing is filtered', () => {
    const map = binGenomeMap(CONTIGS, N_BINS, null)
    expect(Array.from(map).slice(8)).toEqual([2, 2])
  })
})

describe('binContigIndex', () => {
  it('labels every bin with its contig', () => {
    expect(Array.from(binContigIndex(CONTIGS, N_BINS))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
  })
})

describe('GenomeContactAccumulator', () => {
  it('separates intra from inter, and counts inter for both ends', () => {
    const acc = new GenomeContactAccumulator(3)
    acc.add(0, 0, 5)
    acc.add(0, 1, 3)
    expect(acc.intra[0]).toBe(5)
    expect(acc.inter[0]).toBe(3)
    expect(acc.inter[1]).toBe(3)
    expect(acc.intra[1]).toBe(0)
  })

  it('drops a contact touching a genome that is not displayable', () => {
    // The rule this file exists for. A contact with `__unbinned__` is not an
    // inter-MAG contact of the MAG at the other end.
    const acc = new GenomeContactAccumulator(3)
    acc.add(0, -1, 100)
    acc.add(-1, -1, 100)
    expect(acc.inter[0]).toBe(0)
    expect(acc.intra[0]).toBe(0)
  })

  it('skips a NaN rather than poisoning a genome total', () => {
    const acc = new GenomeContactAccumulator(2)
    acc.add(0, 0, Number.NaN)
    acc.add(0, 0, 2)
    expect(acc.intra[0]).toBe(2)
  })

  it('builds the pair matrix symmetrically, only when asked', () => {
    expect(new GenomeContactAccumulator(2).pairs).toBeNull()
    const acc = new GenomeContactAccumulator(2, { pairs: true })
    acc.add(0, 1, 7)
    acc.add(0, 0, 4)
    expect(acc.pairs?.[0 * 2 + 1]).toBe(7)
    expect(acc.pairs?.[1 * 2 + 0]).toBe(7)
    // The diagonal once, not twice: a genome's self-contact is one number.
    expect(acc.pairs?.[0]).toBe(4)
  })
})

describe('ContigPurityAccumulator', () => {
  /** Contigs 0 and 1 in MAG 0; contigs 2 and 3 in MAG 1; contig 4 unassigned. */
  const genomeOf = Int32Array.from([0, 0, 1, 1, -1])

  it('counts contact inside a MAG as own, for both contigs', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 1, 6)
    expect(acc.own[0]).toBe(6)
    expect(acc.own[1]).toBe(6)
    expect(acc.other[0]).toBe(0)
  })

  it('counts a contig’s self-contact once', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 0, 9)
    expect(acc.own[0]).toBe(9)
  })

  it('counts contact across MAGs as other, and remembers where it went', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 2, 4)
    acc.add(0, 3, 1)
    expect(acc.other[0]).toBe(5)
    expect(acc.topPartner(0)).toEqual({ genome: 1, value: 5 })
    // And the other end sees MAG 0 as its partner.
    expect(acc.topPartner(2)?.genome).toBe(0)
  })

  it('ignores a contig no displayable genome claims', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 4, 50)
    expect(acc.own[0]).toBe(0)
    expect(acc.other[0]).toBe(0)
    expect(acc.topPartner(0)).toBeNull()
  })

  it('caps the partner map and says how much it dropped', () => {
    // The one unbounded thing in the module. A contig hitting the cap has its
    // top partner computed from the partners it saw first, which is a real
    // limitation and is reported rather than left for a reader to guess at.
    const many = Int32Array.from([0, ...Array.from({ length: 10 }, (_, i) => i + 1)])
    const acc = new ContigPurityAccumulator(11, many, 3)
    for (let partner = 1; partner <= 10; partner++) acc.add(0, partner, 1)
    expect(acc.droppedPartners).toBeGreaterThan(0)
    // Everything is still counted in the totals; only the breakdown is capped.
    expect(acc.other[0]).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// The inter-MAG network, run on the matrix the QC pass hands it
// ---------------------------------------------------------------------------

/**
 * Three MAGs and `__unbinned__`, as a metagenome's tables describe them: `A`
 * two bins, `B` four, `C` one, and one unassigned bin at the end.
 */
const LAYOUT = [
  { name: 'cA', genome: 0, extent: [0, 2] as [number, number] },
  { name: 'cB', genome: 1, extent: [2, 6] as [number, number] },
  { name: 'cC', genome: 2, extent: [6, 7] as [number, number] },
  { name: 'cU', genome: 3, extent: [7, 8] as [number, number] },
]

/**
 * Every pixel of the file, which gives by hand
 *
 * | | A | B | C |
 * |---|---|---|---|
 * | A | 100 | 40 | 5 |
 * | B | | 400 | 30 |
 * | C | | | 25 |
 *
 * and nothing at all from the two pixels touching `__unbinned__`.
 */
const MAG_PIXELS: Array<[number, number, number]> = [
  [0, 0, 60],
  [0, 1, 40],
  [2, 3, 400],
  [6, 6, 25],
  [1, 2, 40],
  [0, 6, 5],
  [5, 6, 30],
  [0, 7, 500],
  [7, 7, 999],
]

function metagenome(): MetaCooler {
  return {
    nBins: 8,
    nContigs: LAYOUT.length,
    nGenomes: 4,
    binsize: 1000,
    chromnames: LAYOUT.map((contig) => contig.name),
    chromsizes: new Map(
      LAYOUT.map((contig) => [contig.name, (contig.extent[1] - contig.extent[0]) * 1000]),
    ),
    contigGenomeIds: Int32Array.from(LAYOUT, (contig) => contig.genome),
    genomeNames: ['A', 'B', 'C', '__unbinned__'],
    contigExtent: (cid: number) => LAYOUT[cid].extent,
    displayGenomes: () => [0, 1, 2],
    scanPixels: async (options: {
      onChunk(chunk: {
        bin1: Int32Array
        bin2: Int32Array
        count: Float64Array
        length: number
      }): boolean | void
    }) => {
      options.onChunk({
        bin1: Int32Array.from(MAG_PIXELS, ([a]) => a),
        bin2: Int32Array.from(MAG_PIXELS, ([, b]) => b),
        count: Float64Array.from(MAG_PIXELS, ([, , count]) => count),
        length: MAG_PIXELS.length,
      })
    },
  } as unknown as MetaCooler
}

const MAG_FRAMING: AnalysisFraming = {
  uri: 'test.metacool',
  label: 'whole file',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 8],
  cols: [0, 8],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

function jobOf(params: Params, inputs: TaskInputs = {}): JobContext {
  return {
    mc: metagenome(),
    params,
    framing: MAG_FRAMING,
    inputs,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * 1000,
    toBins: (bp: number) => Math.max(1, Math.round(bp / 1000)),
  } as unknown as JobContext
}

/** The network's edges as `[pair, weight, contacts]`, in the order it ranked them. */
async function network(normalise: string): Promise<Array<[string, number, number]>> {
  // The composite as the runner runs it: the QC pass first, its outputs handed
  // on as the network's upstream.
  const qc = await runMagQc(jobOf({}))
  const upstream = { magqc: { outputs: qc } } as unknown as TaskInputs['upstream']
  const outputs = await runMagNetwork(jobOf({ normalise }, { upstream }))
  const table = outputs.find((output): output is TableOutput => output.kind === 'table')
  if (table === undefined) throw new Error('no edge table')
  return table.rows.map((row) => [`${row['a']}–${row['b']}`, Number(row['weight']), Number(row['raw'])])
}

describe('the inter-MAG network', () => {
  it('lists the raw contacts as they are', async () => {
    expect(await network('raw')).toEqual([
      ['A–B', 40, 40],
      ['B–C', 30, 30],
      ['A–C', 5, 5],
    ])
  })

  it('divides per bin pair by the product of the two MAGs’ bin counts', async () => {
    // It fell through to the raw contacts, so the option did nothing at all:
    // 40 over A's two bins and B's four is 5, and the one-bin MAG C rises to
    // the top of the list.
    expect(await network('bins')).toEqual([
      ['B–C', 7.5, 30],
      ['A–B', 5, 40],
      ['A–C', 2.5, 5],
    ])
  })

  it('divides per coverage by the geometric mean of the two MAGs’ intra-MAG contacts', async () => {
    const edges = await network('coverage')
    expect(edges.map(([pair]) => pair)).toEqual(['B–C', 'A–B', 'A–C'])
    // 30 / √(400 · 25), 40 / √(100 · 400), 5 / √(100 · 25).
    expect(edges[0][1]).toBeCloseTo(0.3, 12)
    expect(edges[1][1]).toBeCloseTo(0.2, 12)
    expect(edges[2][1]).toBeCloseTo(0.1, 12)
  })
})

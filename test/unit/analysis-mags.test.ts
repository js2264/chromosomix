// @dev-feature metacool
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
import { runMagNetwork, runMagPurity, runMagQc, runMagSplit } from '@/analysis/run/mags'
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

function jobOf(params: Params, inputs: TaskInputs = {}, mc: MetaCooler = metagenome()): JobContext {
  return {
    mc,
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

// ---------------------------------------------------------------------------
// Files of any shape: names past the forty a picture labels, and table order
// ---------------------------------------------------------------------------

interface FakeContig {
  name: string
  genome: number
  bins: number
}

/**
 * A metagenome of the given contigs, genomes and pixels, the last genome its
 * `__unbinned__`. `matrix` and `aggregate` are the reader's, done by hand —
 * the whole block, filled symmetrically, then summed contig by contig — so a
 * runner that splits a MAG reads exactly the contacts listed here.
 */
function fakeMap(contigs: FakeContig[], genomeNames: string[], pixels: Array<[number, number, number]>): MetaCooler {
  const starts: number[] = []
  let nBins = 0
  for (const contig of contigs) {
    starts.push(nBins)
    nBins += contig.bins
  }
  const contigOfBin = new Int32Array(nBins)
  contigs.forEach((contig, cid) => contigOfBin.fill(cid, starts[cid], starts[cid] + contig.bins))
  const extentOf = (cid: number): [number, number] => [starts[cid], starts[cid] + contigs[cid].bins]
  const genomeExtent = (genome: number): [number, number] => {
    const own = contigs.flatMap((contig, cid) => (contig.genome === genome ? [cid] : []))
    return [extentOf(own[0])[0], extentOf(own[own.length - 1])[1]]
  }
  return {
    nBins,
    nContigs: contigs.length,
    nGenomes: genomeNames.length,
    binsize: 1000,
    chromnames: contigs.map((contig) => contig.name),
    chromsizes: new Map(contigs.map((contig) => [contig.name, contig.bins * 1000])),
    contigGenomeIds: Int32Array.from(contigs, (contig) => contig.genome),
    genomeNames,
    contigExtent: extentOf,
    displayGenomes: () => genomeNames.slice(0, -1).map((_, genome) => genome),
    genomeExtent,
    scanPixels: async (options: {
      onChunk(chunk: { bin1: Int32Array; bin2: Int32Array; count: Float64Array; length: number }): boolean | void
    }) => {
      options.onChunk({
        bin1: Int32Array.from(pixels, ([a]) => a),
        bin2: Int32Array.from(pixels, ([, b]) => b),
        count: Float64Array.from(pixels, ([, , count]) => count),
        length: pixels.length,
      })
    },
    matrix: async (query: { rows: [number, number] }) => {
      const [from, to] = query.rows
      const n = to - from
      const values = new Float32Array(n * n)
      for (const [a, b, count] of pixels) {
        if (a < from || a >= to || b < from || b >= to) continue
        values[(a - from) * n + (b - from)] = count
        values[(b - from) * n + (a - from)] = count
      }
      return { nrows: n, ncols: n, values, rowExtent: [from, to], colExtent: [from, to] }
    },
    aggregate: (dense: { nrows: number; values: Float32Array; rowExtent: [number, number] }) => {
      const [from, to] = dense.rowExtent
      const ids = [...new Set(Array.from(contigOfBin.subarray(from, to)))]
      const slot = new Map(ids.map((cid, k) => [cid, k]))
      const n = ids.length
      const values = new Float64Array(n * n)
      for (let r = 0; r < dense.nrows; r++) {
        for (let c = 0; c < dense.nrows; c++) {
          const row = slot.get(contigOfBin[from + r]) ?? 0
          const col = slot.get(contigOfBin[from + c]) ?? 0
          values[row * n + col] += dense.values[r * dense.nrows + c]
        }
      }
      return { nrows: n, ncols: n, values, rowIds: Int32Array.from(ids), colIds: Int32Array.from(ids), level: 'contig' }
    },
  } as unknown as MetaCooler
}

/** The table a runner wrote, by its id. */
function tableOf(outputs: Awaited<ReturnType<typeof runMagQc>>, id: string): TableOutput {
  const table = outputs.find((output): output is TableOutput => output.kind === 'table' && output.id === id)
  if (table === undefined) throw new Error(`no ${id} table`)
  return table
}

describe('the inter-MAG network of a file with more MAGs than its picture labels', () => {
  it('names every edge after its two genomes', async () => {
    // Forty-five MAGs of one contig each, every neighbour touching the next:
    // past the forty the QC matrix's picture puts names on, so its ticks are
    // empty — and the edges were `MAG 0–MAG 1` … rather than genomes.
    const n = 45
    const names = [...Array.from({ length: n }, (_, k) => `bin_${String(k).padStart(2, '0')}`), '__unbinned__']
    const contigs = names.map((_, genome) => ({ name: `contig_${genome}`, genome, bins: 1 }))
    const pixels: Array<[number, number, number]> = []
    for (let k = 0; k < n; k++) pixels.push([k, k, 100])
    for (let k = 0; k + 1 < n; k++) pixels.push([k, k + 1, k + 1])
    const map = fakeMap(contigs, names, pixels)
    const qc = await runMagQc(jobOf({}, {}, map))
    const upstream = { magqc: { outputs: qc } } as unknown as TaskInputs['upstream']
    const edges = tableOf(await runMagNetwork(jobOf({ normalise: 'raw' }, { upstream }, map)), 'magnetwork').rows
    expect(edges).toHaveLength(n - 1)
    // The strongest edge first, and every row named as the file names it.
    expect([edges[0]['a'], edges[0]['b'], edges[0]['raw']]).toEqual(['bin_43', 'bin_44', 44])
    for (const edge of edges) {
      expect(String(edge['a'])).toMatch(/^bin_\d\d$/)
      expect(String(edge['b'])).toMatch(/^bin_\d\d$/)
    }
  })

  it('refuses a QC matrix that is not this file’s rather than name its rows after other genomes', async () => {
    const qc = await runMagQc(jobOf({}))
    const upstream = { magqc: { outputs: qc } } as unknown as TaskInputs['upstream']
    const other = fakeMap(
      [
        { name: 'x', genome: 0, bins: 1 },
        { name: 'u', genome: 1, bins: 1 },
      ],
      ['X', '__unbinned__'],
      [],
    )
    await expect(runMagNetwork(jobOf({ normalise: 'raw' }, { upstream }, other))).rejects.toThrow(
      /3 MAGs and this file has 1, so its rows cannot be matched to their genomes/,
    )
  })
})

describe('the order of the metagenome tables', () => {
  /**
   * Four MAGs of four one-bin contigs each, built so that their splits are
   * known by hand, and the unassigned contig last:
   *
   * - `whole`: two pairs, 100 inside each and 50 across every cross pair — a
   *   split of the pairs crosses 200 for 200 inside, a ratio of 1;
   * - `apart`: the same two pairs with nothing across, a ratio of exactly 0;
   * - `loose`: three contigs at 100 a pair, the fourth touching one of them
   *   once, which a split peels off for 1 across and 300 inside;
   * - `alone`: contacts within each contig and none between, so the split's
   *   two sides have nothing inside to compare with: no ratio.
   *
   * `apart` used to be listed after `whole`, with `alone`, its 0 read as the 1
   * that stood in for a missing ratio.
   */
  const GENOMES = ['whole', 'apart', 'loose', 'alone', '__unbinned__']
  const contigs: FakeContig[] = [
    ...GENOMES.slice(0, 4).flatMap((name, genome) =>
      Array.from({ length: 4 }, (_, k) => ({ name: `${name}_${k}`, genome, bins: 1 })),
    ),
    { name: 'unbinned_0', genome: 4, bins: 1 },
  ]
  const pixels: Array<[number, number, number]> = [
    // whole: bins 0–3
    [0, 1, 100],
    [2, 3, 100],
    [0, 2, 50],
    [0, 3, 50],
    [1, 2, 50],
    [1, 3, 50],
    // apart: bins 4–7
    [4, 5, 100],
    [6, 7, 100],
    // loose: bins 8–11
    [8, 9, 100],
    [8, 10, 100],
    [9, 10, 100],
    [10, 11, 1],
    // alone: bins 12–15, only themselves
    [12, 12, 10],
    [13, 13, 10],
    [14, 14, 10],
    [15, 15, 10],
  ]
  const map = (): MetaCooler => fakeMap(contigs, GENOMES, pixels)

  it('lists the split MAGs from the lowest cross-block ratio up, and one with no ratio last', async () => {
    const rows = tableOf(await runMagSplit(jobOf({}, {}, map())), 'magsplit').rows
    expect(rows.map((row) => row['genome'])).toEqual(['apart', 'loose', 'whole', 'alone'])
    expect(Number(rows[0]['ratio'])).toBe(0)
    expect(Number(rows[1]['ratio'])).toBeCloseTo(1 / 300, 12)
    expect(Number(rows[2]['ratio'])).toBeCloseTo(1, 12)
    expect(Number.isNaN(Number(rows[3]['ratio']))).toBe(true)
    expect(rows.map((row) => row['flagged'])).toEqual(['yes', 'yes', '', ''])
  })

  it('lists a MAG with no contact at all after the leakiest, never among them', async () => {
    // Three MAGs: one keeps some of its contact, one sends all of it out, and
    // one — listed before it in the file — has none at all.
    const names = ['keeps', 'silent', 'leaks', '__unbinned__']
    const qc = await runMagQc(
      jobOf(
        {},
        {},
        fakeMap(
          [
            { name: 'k', genome: 0, bins: 1 },
            { name: 's', genome: 1, bins: 1 },
            { name: 'l', genome: 2, bins: 1 },
            { name: 'u', genome: 3, bins: 1 },
          ],
          names,
          [
            [0, 0, 30],
            [0, 2, 10],
          ],
        ),
      ),
    )
    const rows = tableOf(qc, 'magqc').rows
    expect(rows.map((row) => row['genome'])).toEqual(['keeps', 'leaks', 'silent'])
    expect(rows.map((row) => row['fraction'])).toEqual([0.75, 0, Number.NaN])
  })

  it('lists the contigs too poor in contact to judge after the purest, never among them', async () => {
    // One MAG of three contigs: a rich one that keeps everything, a poor one —
    // first in the file — with too little contact to judge, and a rich one that
    // sends a third of its contact to the other MAG.
    const names = ['mag', 'other', '__unbinned__']
    const outputs = await runMagPurity(
      jobOf(
        { minContacts: 10 },
        {},
        fakeMap(
          [
            { name: 'poor', genome: 0, bins: 1 },
            { name: 'pure', genome: 0, bins: 1 },
            { name: 'mixed', genome: 0, bins: 1 },
            { name: 'away', genome: 1, bins: 1 },
            { name: 'u', genome: 2, bins: 1 },
          ],
          names,
          [
            [0, 1, 2],
            [1, 1, 40],
            [2, 2, 20],
            [2, 3, 10],
          ],
        ),
      ),
    )
    const rows = tableOf(outputs, 'magpurity').rows.filter((row) => row['genome'] === 'mag')
    expect(rows.map((row) => row['contig'])).toEqual(['mixed', 'pure', 'poor'])
    expect(Number.isNaN(Number(rows[2]['outside']))).toBe(true)
  })
})

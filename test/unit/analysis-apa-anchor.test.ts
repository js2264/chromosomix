/**
 * Which point of a feature an APA window is cut about.
 *
 * The 1D metaplot has offered *start*, *centre* and *end* since it existed, and
 * the pileup — which is the same question asked of a contact map — took the
 * midpoint and never said so. On a set of genes that is a pileup at whatever is
 * half way along a gene, which is not the figure anybody draws: the one they
 * draw is at the transcription start site. Worse, the two aggregates were then
 * not of the same places, so a metaplot set to *start* and a pileup beside it
 * were two pictures of two different anchor sets under one caption.
 *
 * What is checked here is the arithmetic, through the reads the run actually
 * issues: where the window was cut, that strand decides which end is the start,
 * and that the same point is what a generated pair's separation is measured
 * between.
 */

import { describe, expect, it } from 'vitest'

import { runApa } from '@/analysis/run/apa'
import type { JobContext } from '@/analysis/job'
import { anchorAt } from '@/analysis/tasks/apa'
import type { AnalysisFraming, MatrixOutput, Params } from '@/analysis/types'
import type { FeatureSet } from '@/annotations/types'

const BINSIZE = 1_000
const NBINS = 20_000

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'I',
  binsize: BINSIZE,
  binsPerCell: 1,
  rows: [0, NBINS],
  cols: [0, NBINS],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/** One feature: where it starts and ends in bins, and which way it runs. */
interface Gene {
  from: number
  to: number
  strand: number
}

/**
 * Genes far enough apart that no two windows are read together.
 *
 * `MERGE_CAP_BINS` gathers windows near each other on both axes into one read,
 * which is the right thing for the run and useless for an assertion about
 * *where* a window was: a thousand bins between them keeps every read to one
 * window, so each read says which base it was cut about.
 */
const GENES: Gene[] = [
  { from: 1_000, to: 1_100, strand: 1 },
  { from: 5_000, to: 5_100, strand: -1 },
  { from: 9_000, to: 9_100, strand: 0 },
]

function features(genes: Gene[]): FeatureSet {
  const n = genes.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(genes.map((gene) => gene.from * BINSIZE)),
    end: Int32Array.from(genes.map((gene) => gene.to * BINSIZE)),
    strand: Int8Array.from(genes.map((gene) => gene.strand)),
    score: Float32Array.from(genes.map((_, i) => n - i)),
    name: genes.map((_, i) => `g${i}`),
    id: genes.map(() => ''),
    detail: genes.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(genes.map(() => -1)),
    cdsEnd: Int32Array.from(genes.map(() => -1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([
      Math.max(...genes.map((gene) => (gene.to - gene.from) * BINSIZE)),
    ]),
  } as unknown as FeatureSet
}

interface Read {
  rows: [number, number]
  cols: [number, number]
}

function job(params: Params, options: { genes?: Gene[]; reads?: Read[] } = {}): JobContext {
  const genes = options.genes ?? GENES
  const reads = options.reads ?? []
  const mc = {
    nBins: NBINS,
    binsize: BINSIZE,
    chromnames: ['I'],
    hasContig: (name: string) => name === 'I',
    contigId: () => 0,
    contigExtent: () => [0, NBINS] as [number, number],
    names: { find: () => null },
    coords: { binIndex: (_cid: number, bp: number) => Math.floor(bp / BINSIZE) },
    matrix: async (query: Read) => {
      reads.push({ rows: [...query.rows], cols: [...query.cols] })
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      return { values: new Float32Array(nrows * ncols).fill(1), nrows, ncols }
    },
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
    inputs: { features: { features: features(genes) } } as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

/** A fixed on-diagonal pileup, five bins a side, with no control to place. */
function fixed(at?: string): Params {
  return {
    anchors: 'features',
    features: 'features',
    mode: 'fixed',
    window: 2,
    norm: 'none',
    balance: false,
    ...(at === undefined ? {} : { at }),
  }
}

/** The first bin of every window that was read, in order. */
async function cutAt(params: Params, genes?: Gene[]): Promise<number[]> {
  const reads: Read[] = []
  await runApa(job(params, { reads, ...(genes === undefined ? {} : { genes }) }))
  // The centre of a five-bin window is two bins in.
  return reads.map((read) => read.rows[0] + 2).sort((a, b) => a - b)
}

describe('the anchor point', () => {
  it('is the centre when nothing was chosen, which is what this task always did', async () => {
    expect(anchorAt({})).toBe('centre')
    expect(await cutAt(fixed())).toEqual([1_050, 5_050, 9_050])
  })

  it('cuts about the start when the start is asked for', async () => {
    // The plus-strand gene's start is its left edge; the minus-strand one's is
    // its right edge, which is the 5′ end and the same rule the metaplot follows.
    expect(await cutAt(fixed('start'))).toEqual([1_000, 5_099, 9_000])
  })

  it('cuts about the end, which is the other end on a minus strand', async () => {
    expect(await cutAt(fixed('end'))).toEqual([1_099, 5_000, 9_099])
  })

  it('reads an unstranded feature forwards, as its own coordinates do', async () => {
    const flat = [{ from: 1_000, to: 1_100, strand: 0 }]
    expect(await cutAt(fixed('start'), flat)).toEqual([1_000])
    expect(await cutAt(fixed('end'), flat)).toEqual([1_099])
  })

  it('takes the feature’s last base, not its exclusive end', async () => {
    // A gene ending exactly on a bin boundary: the exclusive end is the first
    // base of the *next* bin, so reading it would put the window a bin late on
    // every annotation with a round number in it — which is most of them.
    const round = [{ from: 1_000, to: 1_100, strand: 1 }]
    const cut = await cutAt(fixed('end'), round)
    expect(cut).toEqual([1_099])
  })
})

describe('what the axis says', () => {
  async function matrixOf(params: Params): Promise<MatrixOutput> {
    const outputs = await runApa(job(params))
    const matrix = outputs.find((out): out is MatrixOutput => out.kind === 'matrix')
    if (matrix === undefined) throw new Error('no matrix output')
    return matrix
  }
  const label = async (params: Params): Promise<string> => (await matrixOf(params)).xLabel

  it('names the point the picture is about', async () => {
    expect(await label(fixed('start'))).toBe('Distance from the feature’s start')
    expect(await label(fixed('end'))).toBe('Distance from the feature’s end')
    expect(await label(fixed())).toBe('Distance from the feature’s centre')
  })

  it('numbers both axes in base pairs, not in bins', async () => {
    // A half-width of 2 bins at 1 kb: five cells spanning ±2 kb. Read as a
    // count of bins the same picture says `±2` at every resolution, which is a
    // number only somebody holding the bin size in their head can use.
    const matrix = await matrixOf(fixed())
    expect(matrix.ncols).toBe(5)
    expect(matrix.xTicks).toEqual(['-2 kb', '-1 kb', '0', '+1 kb', '+2 kb'])
    expect(matrix.yTicks).toEqual(matrix.xTicks)
  })
})

describe('pairs made from a feature set', () => {
  it('measures the separation between the points the windows are cut about', async () => {
    // Two genes 4 Mb apart by their starts and 4 Mb ± 99 kb by their ends, with
    // a range that only the start-to-start distance falls inside. Anchored on
    // the centre the pair is outside the range and no window is read at all;
    // anchored on the start it is inside, and one pileup comes back.
    const pair: Gene[] = [
      { from: 1_000, to: 1_100, strand: 1 },
      { from: 5_000, to: 5_400, strand: 1 },
    ]
    const near: Params = {
      anchors: 'allpairs',
      features: 'features',
      mode: 'fixed',
      window: 2,
      norm: 'none',
      balance: false,
      minSep: 3_900_000,
      maxSep: 4_050_000,
      byDistance: 0,
      seed: 1,
    }
    const byStart = await runApa(job({ ...near, at: 'start' }, { genes: pair }))
    expect(byStart.some((out) => out.kind === 'matrix')).toBe(true)
    // Centre to centre is 4,150,000 — past the top of the range.
    const byCentre = await runApa(job({ ...near, at: 'centre' }, { genes: pair }))
    expect(byCentre.some((out) => out.kind === 'matrix')).toBe(false)
  })
})

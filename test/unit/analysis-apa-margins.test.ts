/**
 * Track aggregates along a pileup's two edges.
 *
 * The figure most papers that print an APA actually print: the aggregate contact
 * map with the aggregate ChIP signal above it and beside it, which is what turns
 * *these places touch* into *these places touch, and this is what is bound where
 * they do*. Before this a reader had to run the 1D metaplot separately over
 * anchors they re-derived by hand, and the two aggregates were then over
 * different windows unless every setting happened to agree.
 *
 * Three things are worth pinning and none of them is visible in the picture:
 *
 * - the profile is over the **same windows** as the pileup, cell for cell, so a
 *   peak at the anchor lands in the middle column and not half a cell off;
 * - the **controls are excluded**, because a marginal averaged over the shifted
 *   anchors is a profile of the denominator rather than of the picture;
 * - a window running off the end of the vector contributes the part it has,
 *   rather than a run of zeroes — which would be a measurement nobody made.
 */

import { describe, expect, it } from 'vitest'

import { runApa } from '@/analysis/run/apa'
import type { JobContext } from '@/analysis/job'
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

/** Anchor bins, far enough apart that no two windows are read together. */
const ANCHORS = [2_000, 6_000, 10_000]

function features(anchors: number[]): FeatureSet {
  const n = anchors.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(anchors.map((bin) => bin * BINSIZE)),
    end: Int32Array.from(anchors.map((bin) => (bin + 1) * BINSIZE)),
    strand: new Int8Array(n),
    score: Float32Array.from(anchors.map((_, i) => n - i)),
    name: anchors.map((_, i) => `f${i}`),
    id: anchors.map(() => ''),
    detail: anchors.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(anchors.map(() => -1)),
    cdsEnd: Int32Array.from(anchors.map(() => -1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([BINSIZE]),
  } as unknown as FeatureSet
}

/**
 * A track that is 1 exactly on the anchors and 0 everywhere else.
 *
 * The sharpest thing a profile can be asked about: piled up over windows centred
 * on those anchors, the mean must be 1 in the middle cell and 0 in every other,
 * and anything else is a resampling that is off by a cell.
 */
function spikes(at: number[], value = 1): Float32Array {
  const out = new Float32Array(NBINS)
  for (const bin of at) out[bin] = value
  return out
}

function job(
  params: Params,
  options: { vectors?: Record<string, Float32Array>; anchors?: number[] } = {},
): JobContext {
  const anchors = options.anchors ?? ANCHORS
  const mc = {
    nBins: NBINS,
    binsize: BINSIZE,
    chromnames: ['I'],
    hasContig: (name: string) => name === 'I',
    contigId: () => 0,
    contigExtent: () => [0, NBINS] as [number, number],
    names: { find: () => null },
    coords: { binIndex: (_cid: number, bp: number) => Math.floor(bp / BINSIZE) },
    matrix: async (query: { rows: [number, number]; cols: [number, number] }) => {
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      return { values: new Float32Array(nrows * ncols).fill(1), nrows, ncols }
    },
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
    inputs: {
      features: { features: features(anchors) },
      ...(options.vectors === undefined ? {} : { vectors: options.vectors }),
      labels: { t1: 'CTCF', t2: 'Rad21' },
    } as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

/** A fixed on-diagonal pileup, five cells a side. */
function params(over: Params = {}): Params {
  return {
    anchors: 'features',
    features: 'features',
    mode: 'fixed',
    window: 2,
    norm: 'none',
    balance: false,
    ...over,
  }
}

async function pileup(
  p: Params,
  options: Parameters<typeof job>[1] = {},
): Promise<MatrixOutput> {
  const outputs = await runApa(job(p, options))
  const matrix = outputs.find((out): out is MatrixOutput => out.kind === 'matrix')
  if (matrix === undefined) throw new Error('no matrix output')
  return matrix
}

describe('with no track chosen', () => {
  it('draws no margins at all, which is every run before this one', async () => {
    expect((await pileup(params())).margins).toBeUndefined()
  })
})

describe('the aggregate of one track', () => {
  it('lands its peak on the same cell the pileup centres on', async () => {
    const matrix = await pileup(params({ tracks: ['t1'] }), {
      vectors: { 'tracks:t1': spikes(ANCHORS) },
    })
    expect(matrix.margins?.top?.[0].values.length).toBe(5)
    expect([...(matrix.margins?.top?.[0].values ?? [])]).toEqual([0, 0, 1, 0, 0])
  })

  it('runs along both edges, because an off-diagonal window has two axes', async () => {
    const matrix = await pileup(params({ tracks: ['t1'] }), {
      vectors: { 'tracks:t1': spikes(ANCHORS) },
    })
    expect([...(matrix.margins?.right?.[0].values ?? [])]).toEqual([0, 0, 1, 0, 0])
  })

  it('is named by the reader’s own name for the file, not its id', async () => {
    const matrix = await pileup(params({ tracks: ['t1'] }), {
      vectors: { 'tracks:t1': spikes(ANCHORS) },
    })
    expect(matrix.margins?.top?.[0].name).toBe('CTCF')
  })

  it('averages the windows rather than summing them', async () => {
    // One anchor of the three carries the signal: the mean over three windows is
    // a third of it, which is what an aggregate means.
    const matrix = await pileup(params({ tracks: ['t1'] }), {
      vectors: { 'tracks:t1': spikes([ANCHORS[0]], 3) },
    })
    expect(matrix.margins?.top?.[0].values[2]).toBeCloseTo(1, 10)
  })
})

describe('with two tracks', () => {
  it('draws both, in the order they were chosen', async () => {
    const matrix = await pileup(params({ tracks: ['t1', 't2'] }), {
      vectors: {
        'tracks:t1': spikes(ANCHORS),
        'tracks:t2': spikes(ANCHORS.map((bin) => bin + 1)),
      },
    })
    expect(matrix.margins?.top?.map((profile) => profile.name)).toEqual(['CTCF', 'Rad21'])
    // The second track's spike is one bin along, so it lands one cell along.
    expect([...(matrix.margins?.top?.[1].values ?? [])]).toEqual([0, 0, 0, 1, 0])
  })

  it('leaves out a track that is no longer loaded', async () => {
    const matrix = await pileup(params({ tracks: ['t1', 't2'] }), {
      vectors: { 'tracks:t1': spikes(ANCHORS) },
    })
    expect(matrix.margins?.top).toHaveLength(1)
    expect(matrix.margins?.top?.[0].name).toBe('CTCF')
  })
})

describe('the control windows', () => {
  it('contribute nothing to the profile', async () => {
    // A distance-matched control puts five more windows per anchor somewhere
    // else on the sequence, and the track is flat 1 everywhere except on the
    // anchors themselves. Averaged over the controls too, the middle cell would
    // be a sixth of what it is over the real windows alone.
    const flat = new Float32Array(NBINS)
    for (const bin of ANCHORS) flat[bin] = 1
    const matrix = await pileup(
      params({
        tracks: ['t1'],
        norm: 'matched',
        controls: 5,
        minShift: 200_000,
        maxShift: 400_000,
        seed: 1,
      }),
      { vectors: { 'tracks:t1': flat } },
    )
    expect(matrix.margins?.top?.[0].values[2]).toBeCloseTo(1, 10)
  })
})

describe('a window running off the end of the vector', () => {
  it('contributes the part it has rather than a run of zeroes', async () => {
    // One anchor at the very first bin: two of its five cells are before the
    // start of the sequence and have no value. The other anchors fill them, so
    // the mean stays the mean of what was actually seen.
    const at = [2, 6_000]
    const matrix = await pileup(params({ tracks: ['t1'] }), {
      anchors: at,
      vectors: { 'tracks:t1': spikes(at) },
    })
    const values = [...(matrix.margins?.top?.[0].values ?? [])]
    expect(values[2]).toBeCloseTo(1, 10)
    for (const value of values) expect(Number.isFinite(value)).toBe(true)
  })
})

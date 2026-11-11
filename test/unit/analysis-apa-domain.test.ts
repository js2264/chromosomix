/**
 * The domain pileup: a set of intervals, scaled onto one grid, with flanks.
 *
 * This is the picture the loop APA sits next to in every Hi-C paper — TADs
 * called between two insulation boundaries, every one of them stretched to the
 * same width, with padding either side — and the four things it can be
 * plausible and wrong about are all here, because all four produce a square
 * that looks like a domain pileup:
 *
 * - the window placed from the feature's **centre** rather than its two ends,
 *   which puts the body against a corner with the whole flank on the far side
 *   and is what this mode did before;
 * - the body resampled **evenly with the flanks**, which lands a short domain's
 *   boundary on one column and a long one's on another and smears both;
 * - a distance-matched control shifted by a length in **base pairs**, which on
 *   a megabase-wide window is the same cells back again and a ratio of 1;
 * - **P2LL** under the picture, whose lower-left corner in a domain window is
 *   the two neighbours of the domain and reads well above 1 with no domains in
 *   the data at all.
 *
 * Over the expected the window *is* stretched evenly, on purpose: that pileup is
 * coolpuppy's, cut, interpolated and gapped as coolpuppy does it, so the two can
 * be held to each other cell for cell (§18.10). Its tests are the last block.
 */

import { describe, expect, it } from 'vitest'

import {
  domainScore,
  evenWindow,
  resampleWindowTo,
  roundHalfEven,
  scaledEdges,
  scaledLayout,
  zoomWindow,
} from '@/analysis/apa'
import { runApa } from '@/analysis/run/apa'
import type { JobContext } from '@/analysis/job'
import { APA_TASK } from '@/analysis/tasks/apa'
import type {
  AnalysisContext,
  AnalysisFraming,
  MatrixOutput,
  Params,
  TableOutput,
} from '@/analysis/types'
import type { FeatureSet } from '@/annotations/types'

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

describe('scaledLayout', () => {
  it('gives the flank the fraction of the grid the flank fraction asks for', () => {
    // Half a body each side is a window of two bodies, so the body is the middle
    // half of it: 12 cells of 48, body, 12 cells.
    expect(scaledLayout(48, 0.5)).toEqual({ side: 48, flank: 12, body: 24 })
    // A whole body each side is a window of three, so the body is the middle
    // third — which is the picture coolpup.py's default draws.
    expect(scaledLayout(48, 1)).toEqual({ side: 48, flank: 16, body: 16 })
  })

  it('keeps a body however wide the flank was asked for', () => {
    const layout = scaledLayout(11, 20)
    expect(layout.body).toBeGreaterThan(0)
    expect(layout.flank * 2 + layout.body).toBe(11)
  })

  it('is all body when no flank was asked for', () => {
    expect(scaledLayout(21, 0)).toEqual({ side: 21, flank: 0, body: 21 })
  })
})

describe('scaledEdges', () => {
  it('pins the body to the same two grid lines whatever its length', () => {
    const layout = scaledLayout(20, 0.5)
    // Two windows of very different sizes: a 4-cell body and a 400-cell one.
    for (const [from, to] of [
      [2, 6],
      [200, 600],
    ]) {
      const pad = (to - from) * 0.5
      const edges = scaledEdges(layout, from, to, pad)
      expect(edges).toHaveLength(layout.side + 1)
      expect(edges[0]).toBeCloseTo(from - pad, 12)
      expect(edges[layout.flank]).toBeCloseTo(from, 12)
      expect(edges[layout.flank + layout.body]).toBeCloseTo(to, 12)
      expect(edges[layout.side]).toBeCloseTo(to + pad, 12)
    }
  })

  it('is one even run when there is no flank', () => {
    const layout = scaledLayout(4, 0)
    expect(Array.from(scaledEdges(layout, 0, 8, 0))).toEqual([0, 2, 4, 6, 8])
  })
})

describe('resampleWindowTo', () => {
  it('area-weights each output cell over the edges it was given', () => {
    // A 4x1 row of 1,2,3,4 onto two cells split 3/1: the first is the mean of
    // the first three, the second is the fourth on its own.
    const out = resampleWindowTo([1, 2, 3, 4], 1, 4, [0, 1], [0, 3, 4])
    expect(out[0]).toBeCloseTo(2, 12)
    expect(out[1]).toBeCloseTo(4, 12)
  })

  it('splits a source cell between two output cells that share it', () => {
    const out = resampleWindowTo([0, 10], 1, 2, [0, 1], [0, 0.5, 2])
    // The first output cell is the left half of the first source cell.
    expect(out[0]).toBeCloseTo(0, 12)
    // The second is the right half of it and the whole of the second, weighted
    // by how much of each it covers: (0.5 * 0 + 1 * 10) / 1.5.
    expect(out[1]).toBeCloseTo(10 / 1.5, 12)
  })

  it('skips gaps rather than averaging them in as zero', () => {
    const out = resampleWindowTo([1, Number.NaN, 3, 5], 2, 2, [0, 2], [0, 2])
    expect(out[0]).toBeCloseTo(3, 12)
  })

  it('answers with a gap where an output cell reached nothing finite', () => {
    const out = resampleWindowTo([Number.NaN, Number.NaN], 1, 2, [0, 1], [0, 2])
    expect(out[0]).toBeNaN()
  })
})

describe('zoomWindow', () => {
  it('is the window itself when it is already the grid’s size', () => {
    const source = Float64Array.from({ length: 25 }, (_, i) => i * 0.5)
    expect(Array.from(zoomWindow(source, 5, 5))).toEqual(Array.from(source))
  })

  it('interpolates linearly between the cells it lands between', () => {
    // 3 cells onto 5: the new cells fall half way between the old ones.
    const source = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const out = zoomWindow(source, 3, 5)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(0.5, 12)
    expect(out[5 + 1]).toBeCloseTo(2, 12)
    expect(out[24]).toBe(8)
  })

  it('takes scipy’s constant edge where a coordinate rounds past the last cell', () => {
    // 4 cells onto 306: the last output cell's coordinate, 305 · 3/305, comes out
    // a hair past 3 in floating point, and scipy's `constant` mode answers 0
    // there rather than the last cell's value. A pileup held to coolpuppy's has
    // to have the same zero along its last row and column.
    const out = zoomWindow(new Float64Array(16).fill(1), 4, 306)
    expect(out[0]).toBe(1)
    expect(out[304 * 306 + 304]).toBeCloseTo(1, 12)
    expect(out[305 * 306]).toBe(0)
    expect(out[305]).toBe(0)
  })

  it('leaves a gap in every grid cell a missing value reaches with any weight', () => {
    // One missing cell in the middle of a 9 × 9 window, onto 3 × 3: the cell it
    // sits in is a gap, the others average what they hold.
    const source = new Float64Array(81).fill(2)
    source[4 * 9 + 4] = Number.NaN
    const out = zoomWindow(source, 9, 3)
    expect(out[4]).toBeNaN()
    expect(out[0]).toBeCloseTo(2, 12)
    expect(out[8]).toBeCloseTo(2, 12)
  })
})

describe('evenWindow', () => {
  it('scales the feature about its middle and snaps out to whole bins', () => {
    // 2,000–2,400 kb at half a feature each side is 1,800–2,600 kb.
    expect(evenWindow(2_000_000, 2_400_000, 0.5, 1000)).toEqual({ from: 1800, to: 2600 })
    expect(evenWindow(2_000_500, 2_400_000, 0.5, 1000)).toEqual({ from: 1800, to: 2600 })
  })

  it('rounds a half base to the even one, as numpy and bioframe do', () => {
    // 999 bases at half a feature each side: the ends move by 499.5 to 500.5 and
    // 2,498.5, which round half to even to 500 and 2,498 — half up would give
    // 501 and 2,499.
    expect(evenWindow(1000, 1999, 0.5, 1)).toEqual({ from: 500, to: 2498 })
    expect([0.5, 1.5, 2.5, 3.5, -1.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, 4, -2, 2, 3])
  })
})

describe('domainScore', () => {
  const layout = scaledLayout(20, 0.5) // flank 5, body 10

  /** A square that is `inside` within the body and `outside` everywhere else. */
  function square(inside: number, outside: number): Float64Array {
    const values = new Float64Array(layout.side * layout.side).fill(outside)
    for (let r = layout.flank; r < layout.flank + layout.body; r++) {
      for (let c = layout.flank; c < layout.flank + layout.body; c++) {
        values[r * layout.side + c] = inside
      }
    }
    return values
  }

  it('is the ratio of the domain to what sits across its boundary', () => {
    expect(domainScore(square(6, 2), layout)).toBeCloseTo(3, 12)
  })

  it('is one where nothing stops at the boundary', () => {
    expect(domainScore(square(4, 4), layout)).toBeCloseTo(1, 12)
  })

  it('takes its denominator from across the boundary and nowhere else', () => {
    // The far off-diagonal corners — the two neighbours of the domain, which is
    // where P2LL looks — are held at a hundredth of everything else. A statistic
    // that used them would read a hundred where this one reads one.
    const values = square(4, 4)
    const quadrant = Math.floor(layout.side / 5)
    for (let r = layout.side - quadrant; r < layout.side; r++) {
      for (let c = 0; c < quadrant; c++) values[r * layout.side + c] = 0.04
    }
    expect(domainScore(values, layout)).toBeCloseTo(1, 12)
  })

  it('has no answer when there is no flank to compare against', () => {
    expect(domainScore(new Float64Array(21 * 21).fill(1), scaledLayout(21, 0))).toBeNaN()
  })
})

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const BINSIZE = 1000
const NBINS = 6000

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

/** Domains of deliberately different lengths, spread along one sequence. */
const MANY: Array<[number, number]> = [
  [100, 140],
  [400, 500],
  [800, 830],
  [1200, 1400],
]

/**
 * One domain, wide enough that no two of its windows can be coalesced.
 *
 * The read-level assertions need this. Windows near each other on both axes are
 * read as one block (`MERGE_CAP_BINS`), so on the set above a control landing
 * beside its own window comes back as one merged read and there is nothing to
 * assert about *where* either of them was. At 800 bins a window is already over
 * the merge cap, so every read is exactly one window and says where it was.
 */
const ONE: Array<[number, number]> = [[2000, 2400]]

function domains(spans: Array<[number, number]>): FeatureSet {
  const n = spans.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(spans.map(([from]) => from * BINSIZE)),
    end: Int32Array.from(spans.map(([, to]) => to * BINSIZE)),
    strand: new Int8Array(n),
    score: Float32Array.from(spans.map((_, i) => n - i)),
    name: spans.map((_, i) => `d${i}`),
    id: spans.map(() => ''),
    detail: spans.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(spans.map(() => -1)),
    cdsEnd: Int32Array.from(spans.map(() => -1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([Math.max(...spans.map(([from, to]) => (to - from) * BINSIZE))]),
  } as unknown as FeatureSet
}

/** 1 inside a domain's own square, 0 everywhere else: a perfect TAD set. */
function valueOf(spans: Array<[number, number]>, row: number, col: number): number {
  for (const [from, to] of spans) {
    if (row >= from && row < to && col >= from && col < to) return 1
  }
  return 0
}

interface Read {
  rows: [number, number]
  cols: [number, number]
}

function job(
  params: Params,
  options: { spans?: Array<[number, number]>; reads?: Read[] } = {},
): JobContext {
  const spans = options.spans ?? MANY
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
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          values[r * ncols + c] = valueOf(spans, query.rows[0] + r, query.cols[0] + c)
        }
      }
      return { values, nrows, ncols }
    },
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
    inputs: { features: { features: domains(spans) } } as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

const SCALED: Params = {
  anchors: 'features',
  features: 'features',
  mode: 'scaled',
  grid: 40,
  flankFraction: 0.5,
  norm: 'none',
  balance: false,
}

function matrixOf(outputs: Awaited<ReturnType<typeof runApa>>): MatrixOutput {
  const found = outputs.find((output): output is MatrixOutput => output.kind === 'matrix')
  if (found === undefined) throw new Error('no matrix output')
  return found
}

describe('the domain pileup, run', () => {
  it('puts the body in the middle of the grid and the flanks either side', async () => {
    const outputs = await runApa(job(SCALED))
    const matrix = matrixOf(outputs)
    const layout = scaledLayout(40, 0.5)
    expect(matrix.nrows).toBe(layout.side)

    // Every domain of the set is a solid square of 1 with 0 outside it, so a
    // window placed and resampled correctly is 1 exactly on the body's cells and
    // 0 exactly off them — on both axes, and with no cell in between.
    for (let r = 0; r < layout.side; r++) {
      for (let c = 0; c < layout.side; c++) {
        const inBody =
          r >= layout.flank &&
          r < layout.flank + layout.body &&
          c >= layout.flank &&
          c < layout.flank + layout.body
        expect(matrix.values[r * layout.side + c]).toBeCloseTo(inBody ? 1 : 0, 6)
      }
    }
  })

  it('reads the feature’s own bins with a flank each side, not a window past it', async () => {
    const reads: Read[] = []
    await runApa(job(SCALED, { spans: ONE, reads }))
    // The domain is bins 2000..2400, so half a body each side is 1800..2600.
    // The old placement read 2000..2800 — the same width, half a domain along.
    expect(reads).toEqual([{ rows: [1800, 2600], cols: [1800, 2600] }])
  })

  it('scores the picture by what stops at the boundary, not by P2LL', async () => {
    const outputs = await runApa(job(SCALED))
    const matrix = matrixOf(outputs)
    const stat = matrix.stats?.find((entry) => entry.label === 'in / out')
    expect(stat).toBeDefined()
    // Everything outside the domain is zero here, so the ratio has no
    // denominator — which is `NaN` and not a large number.
    expect(stat!.value).toBeNaN()
    expect(matrix.stats?.some((entry) => entry.label === 'P2LL')).toBe(false)
    const table = outputs.find((output): output is TableOutput => output.kind === 'table')
    expect(table?.columns.some((column) => column.label === 'In / out')).toBe(true)
  })

  it('labels the axis where the feature starts and ends', async () => {
    const matrix = matrixOf(await runApa(job(SCALED)))
    // Five evenly spaced labels in units of the feature. A grid of 40 divides
    // 10-20-10 at half a body each side, so the two boundaries land on the
    // second and fourth tick and read as 0 and 1 exactly.
    expect(matrix.xTicks).toEqual(['-0.5', '0', '0.5', '1', '1.5'])
    expect(matrix.yTicks).toEqual(matrix.xTicks)
  })

  it('reads the axis piecewise where the flank does not divide the grid', async () => {
    // 41 cells divide 10-21-10, so a cell of flank is a longer piece of the
    // feature than a cell of body and the axis is three straight lines rather
    // than one. Read as one line the two ends would come out at -0.48 and 1.48,
    // which is a caption disagreeing with the window that was read.
    const matrix = matrixOf(await runApa(job({ ...SCALED, grid: 41 })))
    expect(matrix.xTicks[0]).toBe('-0.5')
    expect(matrix.xTicks[4]).toBe('1.5')
    expect(Number(matrix.xTicks[1])).toBeCloseTo(0, 1)
    expect(Number(matrix.xTicks[3])).toBeCloseTo(1, 1)
  })

  it('shifts a distance-matched control clear of the window it controls for', async () => {
    const reads: Read[] = []
    await runApa(
      job({ ...SCALED, norm: 'matched', controls: 6, seed: 7 }, { spans: ONE, reads }),
    )
    expect(reads.length).toBeGreaterThan(1)
    // Every read that touches the real window, which is bins 1800..2600.
    const touching = reads.filter((read) => read.rows[0] < 2600 && read.rows[1] > 1800)
    // One, and it is that window: a control drawn a window's width away cannot
    // share a cell with it. Asked for in base pairs — 100 kb, a hundred bins —
    // every control would have landed inside the domain it is the denominator of.
    expect(touching).toEqual([{ rows: [1800, 2600], cols: [1800, 2600] }])
  })
})

describe('the scaled mode’s estimate', () => {
  const context = {
    hasMap: true,
    hasGenomes: false,
    blockLoaded: false,
    contigs: [{ name: 'I', bins: NBINS }],
    entries: [{ id: 'features', kind: 'segments', status: 'ready', summary: '4 features' }],
    framing: null,
  } as unknown as AnalysisContext

  it('takes observed / expected on the diagonal, where each window has its own expected', () => {
    const estimate = APA_TASK.estimate(context, { ...SCALED, norm: 'oe' })
    expect(estimate.refusal).toBeUndefined()
  })

  it('refuses observed / expected for scaled pairs before Run rather than after it', () => {
    const estimate = APA_TASK.estimate(context, { ...SCALED, anchors: 'consecutive', norm: 'oe' })
    expect(estimate.refusal).toMatch(/feature set on the diagonal/)
    expect(estimate.requests).toBe(0)
  })

  it('says the read is the feature’s own size and not the grid’s', () => {
    const estimate = APA_TASK.estimate(context, SCALED)
    expect(estimate.refusal).toBeUndefined()
    expect(estimate.note).toMatch(/feature’s own size/)
  })

  it('leaves the fixed mode’s estimate alone', () => {
    const estimate = APA_TASK.estimate(context, { ...SCALED, mode: 'fixed', norm: 'oe' })
    expect(estimate.refusal).toBeUndefined()
    expect(estimate.note).not.toMatch(/feature’s own size/)
  })
})

describe('the domain pileup over the expected', () => {
  const OVER_EXPECTED: Params = { ...SCALED, norm: 'oe', grid: 41 }

  it('labels the axis as one straight line, the feature’s ends on the second and fourth tick', async () => {
    // Pinned on 41 cells the second tick reads 0.01 ({@link scaledTickLabels});
    // stretched evenly it is a quarter of the window, which at half a feature
    // each side is where the feature starts, exactly.
    const matrix = matrixOf(await runApa(job(OVER_EXPECTED)))
    expect(matrix.xTicks).toEqual(['-0.5', '0', '0.5', '1', '1.5'])
    expect(matrix.label).toMatch(/observed \/ expected/)
  })

  it('leaves a gap along the grid’s diagonal, where the diagonals left out reach', async () => {
    // The two diagonals left out of every window reach every grid cell on the
    // diagonal once interpolated, and coolpuppy blanks those cells; resampled by
    // area they would be the mean of what is left beside them.
    const matrix = matrixOf(await runApa(job(OVER_EXPECTED)))
    for (let i = 0; i < 41; i++) expect(matrix.values[i * 41 + i]).toBeNaN()
    expect(Number.isFinite(matrix.values[5 * 41 + 30])).toBe(true)
  })
})

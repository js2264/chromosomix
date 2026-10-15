/**
 * Where an APA window meets the diagonal, and what observed / expected divides by.
 *
 * Both are coolpuppy's rules, because coolpuppy is what these pileups are held
 * to (§18.10), and both are checked here against a plain transcription of what
 * coolpuppy does rather than against this runner's own arithmetic:
 *
 * - a window is cut from the **upper triangle**, with the first `min_diag`
 *   diagonals left out — and a pileup on the diagonal is then folded onto its
 *   own transpose, which is the same picture as a window kept whole with the
 *   near diagonals left out on both sides;
 * - observed / expected divides **each window, cell by cell**, by its
 *   sequence's expected at the cell's own diagonal — cooltools' `balanced.avg`,
 *   the mean of that diagonal over the whole sequence — and averages the ratios.
 *
 * The map here was built to tell the old behaviour from the new one. It is
 * symmetric and read whole, both triangles, as the app reads a map; it has a
 * dot well above its distance law, so an expected taken from the windows about
 * the dot is not the sequence's; and it has a bin the balancer threw out.
 */

import { describe, expect, it } from 'vitest'

import { runApa } from '@/analysis/run/apa'
import type { JobContext } from '@/analysis/job'
import { APA_TASK, MIN_DIAG_DEFAULT, MIN_DIST_DEFAULT, autoMinDist } from '@/analysis/tasks/apa'
import { defaultParams } from '@/analysis/types'
import type { AnalysisContext, AnalysisFraming, MatrixOutput, Params } from '@/analysis/types'
import type { FeatureSet, PairSet } from '@/annotations/types'

const BINSIZE = 1_000
const NBINS = 600
/** A bin the balancer threw out: every cell it is part of reads `NaN`. */
const FILTERED = 150
/** Bins either side of the anchor; an 11-cell window. */
const HALF = 5
const SIDE = 2 * HALF + 1

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

/** One cell of the map: a distance decay with a texture on it, and a dot. */
function contact(i: number, j: number): number {
  if (i === FILTERED || j === FILTERED) return Number.NaN
  const lo = Math.min(i, j)
  const hi = Math.max(i, j)
  const decay = 100 / (1 + hi - lo)
  const texture = 1 + ((lo * 31 + hi * 17) % 7) / 10
  const dot = lo === 300 && hi === 340 ? 25 : 1
  // As the reader hands it over: a `Float32Array` of balanced values.
  return Math.fround(decay * texture * dot)
}

function job(
  params: Params,
  inputs: { pairs?: PairSet; features?: FeatureSet },
  notes: string[] = [],
): JobContext {
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
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) values[r * ncols + c] = contact(query.rows[0] + r, query.cols[0] + c)
      }
      return { values, nrows, ncols, rowExtent: query.rows, colExtent: query.cols }
    },
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
    inputs: {
      ...(inputs.pairs === undefined ? {} : { pairs: { pairs: inputs.pairs } }),
      ...(inputs.features === undefined ? {} : { features: { features: inputs.features } }),
    } as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: (text: string) => {
      notes.push(text)
    },
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

/** A loop set, one bin per anchor — or, given base pairs, anchors anywhere. */
function loops(pairs: Array<[number, number]>, spans?: Array<[number, number, number, number]>): PairSet {
  const n = pairs.length
  const at = spans ?? pairs.map(([a, b]): [number, number, number, number] => [
    a * BINSIZE,
    (a + 1) * BINSIZE,
    b * BINSIZE,
    (b + 1) * BINSIZE,
  ])
  return {
    contigs: ['I'],
    length: n,
    contig1: new Int32Array(n),
    start1: Int32Array.from(at.map((span) => span[0])),
    end1: Int32Array.from(at.map((span) => span[1])),
    contig2: new Int32Array(n),
    start2: Int32Array.from(at.map((span) => span[2])),
    end2: Int32Array.from(at.map((span) => span[3])),
    score: new Float32Array(n).fill(Number.NaN),
    name: pairs.map((_, i) => `l${i}`),
    detail: pairs.map(() => ''),
  }
}

/** A feature set, one bin per feature. */
function features(bins: number[]): FeatureSet {
  const n = bins.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(bins.map((bin) => bin * BINSIZE)),
    end: Int32Array.from(bins.map((bin) => (bin + 1) * BINSIZE)),
    strand: new Int8Array(n),
    score: new Float32Array(n).fill(Number.NaN),
    name: bins.map((_, i) => `f${i}`),
    id: bins.map(() => ''),
    detail: bins.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: new Int32Array(n).fill(-1),
    cdsEnd: new Int32Array(n).fill(-1),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([BINSIZE]),
  } as unknown as FeatureSet
}

/**
 * cooltools' `expected_cis` for the one sequence, `balanced.avg`: each diagonal's
 * contacts over the bin pairs on it that both survived the balancer.
 */
function expectedOf(hi: number): Float64Array {
  const out = new Float64Array(hi + 1)
  for (let d = 0; d <= hi; d++) {
    let sum = 0
    let count = 0
    for (let i = 0; i + d < NBINS; i++) {
      const value = contact(i, i + d)
      if (Number.isNaN(value)) continue
      sum += value
      count++
    }
    out[d] = sum / count
  }
  return out
}

/**
 * coolpuppy's pileup, transcribed from `_stream_snips` and `pileupsWithControl`:
 * every window cut from the upper triangle, `j − i ≥ min_diag`, divided cell by
 * cell by the expected where there is one, and averaged over the windows with a
 * value in that cell; a local pileup then `np.nanmean(np.dstack((x, x.T)), 2)`.
 */
function coolpup(
  centres: Array<[number, number]>,
  options: { minDiag: number; local?: boolean; expected?: Float64Array },
): Float64Array {
  const sum = new Float64Array(SIDE * SIDE)
  const count = new Float64Array(SIDE * SIDE)
  for (const [row, col] of centres) {
    for (let r = 0; r < SIDE; r++) {
      for (let c = 0; c < SIDE; c++) {
        const i = row - HALF + r
        const j = col - HALF + c
        if (j - i < options.minDiag) continue
        let value = contact(i, j)
        if (options.expected !== undefined) value /= options.expected[j - i]
        if (!Number.isFinite(value)) continue
        sum[r * SIDE + c] += value
        count[r * SIDE + c] += 1
      }
    }
  }
  const out = new Float64Array(SIDE * SIDE)
  for (let k = 0; k < out.length; k++) out[k] = count[k] > 0 ? sum[k] / count[k] : Number.NaN
  if (options.local !== true) return out
  const folded = new Float64Array(SIDE * SIDE)
  for (let r = 0; r < SIDE; r++) {
    for (let c = 0; c < SIDE; c++) {
      const both = [out[r * SIDE + c], out[c * SIDE + r]].filter(Number.isFinite)
      folded[r * SIDE + c] = both.length === 0 ? Number.NaN : both.reduce((a, b) => a + b, 0) / both.length
    }
  }
  return folded
}

/** The same picture, gap for gap and within float32 cell for cell. */
function expectSame(actual: ArrayLike<number>, wanted: ArrayLike<number>): void {
  expect(actual.length).toBe(wanted.length)
  for (let k = 0; k < wanted.length; k++) {
    const where = `cell (${Math.floor(k / SIDE)}, ${k % SIDE})`
    expect(Number.isFinite(actual[k]), where).toBe(Number.isFinite(wanted[k]))
    if (!Number.isFinite(wanted[k])) continue
    expect(Math.abs(actual[k] / wanted[k] - 1), where).toBeLessThan(1e-6)
  }
}

async function pileup(
  params: Params,
  inputs: { pairs?: PairSet; features?: FeatureSet },
  notes: string[] = [],
): Promise<MatrixOutput> {
  const outputs = await runApa(job({ mode: 'fixed', window: HALF, balance: false, ...params }, inputs, notes))
  const matrix = outputs.find((out): out is MatrixOutput => out.kind === 'matrix')
  if (matrix === undefined) throw new Error('no matrix output')
  return matrix
}

/**
 * Four loops: two whose windows cross the diagonal, one clear of it on the dot,
 * and one whose window holds the filtered bin.
 */
const LOOPS: Array<[number, number]> = [
  [100, 103],
  [300, 340],
  [400, 412],
  [146, 160],
]
/**
 * Every loop, the nearest included: coolpuppy run with `mindist=0`. The default
 * floor, five bins, has tests of its own at the end, and with it in force the
 * loop three bins out would not be piled up at all.
 */
const LOOP_SET = { anchors: 'pairs', pairs: 'loops', minDist: 0 }

describe('a window off the diagonal', () => {
  it('takes nothing from below the diagonal, and leaves out the first two diagonals', async () => {
    expect(MIN_DIAG_DEFAULT).toBe(2)
    const matrix = await pileup({ ...LOOP_SET, norm: 'none' }, { pairs: loops(LOOPS) })
    expectSame(matrix.values, coolpup(LOOPS, { minDiag: 2 }))
  })

  it('leaves out as many diagonals as it is asked to, and never what is below', async () => {
    for (const minDiag of [0, 1, 4]) {
      const matrix = await pileup({ ...LOOP_SET, norm: 'none', minDiag }, { pairs: loops(LOOPS) })
      expectSame(matrix.values, coolpup(LOOPS, { minDiag }))
    }
  })

  it('leaves a cell no window takes from above the diagonal as a gap, not as its mirror', async () => {
    // One loop three bins from the diagonal: its window's lower-left corner is
    // seven diagonals *below* it. Read whole, as the map is drawn, those cells
    // held the contacts the window already had above the diagonal; cut as
    // coolpuppy cuts it, they are gaps — and so is everything nearer than two.
    const matrix = await pileup({ ...LOOP_SET, norm: 'none' }, { pairs: loops([[100, 103]]) })
    for (let r = 0; r < SIDE; r++) {
      for (let c = 0; c < SIDE; c++) {
        const diagonal = 103 - HALF + c - (100 - HALF + r)
        expect(Number.isFinite(matrix.values[r * SIDE + c]), `cell (${r}, ${c})`).toBe(diagonal >= 2)
      }
    }
  })
})

describe('a window on the diagonal', () => {
  const ANCHORS = [100, 300, 400, 148]
  const centres = ANCHORS.map((bin): [number, number] => [bin, bin])
  const FEATURES = { anchors: 'features', features: 'features' }

  it('is coolpuppy’s local pileup: the near diagonals left out on both sides', async () => {
    const matrix = await pileup({ ...FEATURES, norm: 'none' }, { features: features(ANCHORS) })
    expectSame(matrix.values, coolpup(centres, { minDiag: 2, local: true }))
  })

  it('is kept whole when no diagonal is left out, which is what it always was', async () => {
    const matrix = await pileup({ ...FEATURES, norm: 'none', minDiag: 0 }, { features: features(ANCHORS) })
    expectSame(matrix.values, coolpup(centres, { minDiag: 0, local: true }))
    // And every cell has a value but those of the filtered bin's cross, which
    // one window of four holds — so nothing is a gap.
    expect(Array.from(matrix.values).every(Number.isFinite)).toBe(true)
  })
})

describe('observed / expected', () => {
  it('divides every window by its sequence’s expected at the cell’s own diagonal', async () => {
    const matrix = await pileup({ ...LOOP_SET, norm: 'oe' }, { pairs: loops(LOOPS) })
    expectSame(matrix.values, coolpup(LOOPS, { minDiag: 2, expected: expectedOf(NBINS - 1) }))
    expect(matrix.centre).toBe(1)
    expect(matrix.label).toMatch(/observed \/ expected/)
  })

  it('puts a loop at its own enrichment over the sequence, not over the diagonal', async () => {
    // The dot alone: its centre is the dot over the mean of *its* diagonal, over
    // the whole sequence. Dividing the finished pileup by the expected at the
    // pileup's own centre — what this did — divided it by the main diagonal's,
    // and took that from the windows' cells, which hold no main diagonal here.
    const matrix = await pileup({ ...LOOP_SET, norm: 'oe' }, { pairs: loops([[300, 340]]) })
    const centre = matrix.values[HALF * SIDE + HALF]
    const wanted = contact(300, 340) / expectedOf(40)[40]
    expect(centre / wanted - 1).toBeLessThan(1e-6)
    expect(centre).toBeGreaterThan(20)
  })

  it('is the local pileup over the expected, on the diagonal', async () => {
    const anchors = [100, 300, 400, 148]
    const matrix = await pileup(
      { anchors: 'features', features: 'features', norm: 'oe' },
      { features: features(anchors) },
    )
    expectSame(
      matrix.values,
      coolpup(
        anchors.map((bin): [number, number] => [bin, bin]),
        { minDiag: 2, local: true, expected: expectedOf(SIDE) },
      ),
    )
  })

  it('is priced as a band along each sequence, since that is what it reads', () => {
    const context = {
      hasMap: true,
      hasGenomes: false,
      blockLoaded: false,
      contigs: [{ name: 'I', bins: NBINS }],
      entries: [{ id: 'loops', kind: 'pairs', status: 'ready', summary: '4 pairs' }],
      framing: null,
    } as unknown as AnalysisContext
    const estimate = APA_TASK.estimate(context, { ...LOOP_SET, norm: 'oe' })
    expect(estimate.refusal).toBeUndefined()
    expect(estimate.class).toBe('scan')
    expect(estimate.note).toMatch(/read as a band along its diagonal/)
    expect(estimate.requests).toBeNull()
  })
})

describe('the distance-matched control', () => {
  it('is cut as the window it divides is, so the ratio has the window’s gaps and no others', async () => {
    // Every control of a loop is at the loop's own separation, so a control
    // masked by the same rule is masked in the same cells — and a control read
    // whole, under a window that is not, would divide what is below the
    // diagonal by something and leave a pattern in the ratio that is in neither.
    const matrix = await pileup(
      { ...LOOP_SET, norm: 'matched', controls: 5, minShift: 50, maxShift: 100, seed: 3 },
      { pairs: loops([[100, 103]]) },
    )
    expect(matrix.centre).toBe(1)
    for (let r = 0; r < SIDE; r++) {
      for (let c = 0; c < SIDE; c++) {
        const diagonal = 3 + c - r
        expect(Number.isFinite(matrix.values[r * SIDE + c]), `cell (${r}, ${c})`).toBe(diagonal >= 2)
      }
    }
  })
})

describe('the nearest loop', () => {
  const AUTO = { anchors: 'pairs', pairs: 'loops' }

  it('is five bins by default, and the run says how many loops it left out', async () => {
    // The loop three bins out is nearer than five and is left out; the rest are kept.
    const notes: string[] = []
    const matrix = await pileup({ ...AUTO, norm: 'none' }, { pairs: loops(LOOPS) }, notes)
    const kept = LOOPS.filter(([a, b]) => b - a >= MIN_DIST_DEFAULT)
    expect(kept).toHaveLength(3)
    expectSame(matrix.values, coolpup(kept, { minDiag: 2 }))
    expect(matrix.stats?.[0]?.value).toBe(3)
    expect(notes.join(' ')).toMatch(/1 of 4 loops are nearer the diagonal than 5 bins \(5\.0 kb\)/)
    expect(notes.join(' ')).not.toMatch(/coolpuppy’s default/)
  })

  it('is measured between the anchors’ centres, in base pairs, as coolpuppy measures it', async () => {
    // Bins 100 and 105, five apart, so a floor on bins would keep this loop.
    // Its centres are 100,950 and 105,050 — 4,100 bp, under 5,000 — so
    // coolpuppy leaves it out at this floor, and so does this.
    const notes: string[] = []
    const outputs = await runApa(
      job(
        { ...AUTO, mode: 'fixed', window: HALF, balance: false, norm: 'none' },
        { pairs: loops([[100, 105]], [[100_900, 101_000, 105_000, 105_100]]) },
        notes,
      ),
    )
    expect(outputs.some((out) => out.kind === 'matrix')).toBe(false)
    expect(notes.join(' ')).toMatch(/Every loop of this set is nearer the diagonal than 5 bins/)
  })

  it('is what was typed where something was', async () => {
    const matrix = await pileup({ ...AUTO, norm: 'none', minDist: 15 }, { pairs: loops(LOOPS) })
    const kept = LOOPS.filter(([a, b]) => b - a >= 15)
    expect(matrix.stats?.[0]?.value).toBe(kept.length)
    expectSame(matrix.values, coolpup(kept, { minDiag: 2 }))
  })

  it('says so when what was typed is coolpuppy’s own, twice the half-width and two', async () => {
    const notes: string[] = []
    const minDist = autoMinDist({ mode: 'fixed', window: HALF })
    expect(minDist).toBe(2 * HALF + 2)
    const matrix = await pileup({ ...AUTO, norm: 'none', minDist }, { pairs: loops(LOOPS) }, notes)
    const kept = LOOPS.filter(([a, b]) => b - a >= minDist)
    expect(matrix.stats?.[0]?.value).toBe(kept.length)
    expectSame(matrix.values, coolpup(kept, { minDiag: 2 }))
    expect(notes.join(' ')).toMatch(/nearer the diagonal than 12 bins \(12 kb\), coolpuppy’s default,/)
  })

  it('leaves a pileup on the diagonal alone, which has no loops to be near', async () => {
    const notes: string[] = []
    await pileup({ anchors: 'features', features: 'features', norm: 'none' }, { features: features([100]) }, notes)
    expect(notes.join(' ')).not.toMatch(/nearer the diagonal/)
  })
})

describe('the defaults', () => {
  it('are observed / expected, two diagonals left out and the nearest loop five bins out', () => {
    const params = defaultParams(APA_TASK.params)
    expect(params.norm).toBe('oe')
    expect(params.minDiag).toBe(MIN_DIAG_DEFAULT)
    expect(MIN_DIAG_DEFAULT).toBe(2)
    expect(params.minDist).toBe(MIN_DIST_DEFAULT)
    expect(MIN_DIST_DEFAULT).toBe(5)
  })
})

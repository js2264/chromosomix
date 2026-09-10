/**
 * The tiled insulation read, against the whole square it replaced.
 *
 * Reading a sequence as one dense square put a ceiling on this task that had
 * nothing to do with its arithmetic: one `Float32Array` of `n²` is refused past
 * 23,170 bins whatever the machine has, which is 116 Mb at 5 kb — so mouse chr9
 * could not be scored at all and chr1 could not be scored below 10 kb. The
 * diamond reaches `window` bins each side of the bin it scores and no further,
 * so the sequence is a band and the square was never needed.
 *
 * What has to hold, and what this file exists to hold it to, is that the tiled
 * read is a *substitution* and not an approximation. Two things make it one, and
 * they are different in kind:
 *
 * - **the sums are local**, so a bin whose whole diamond sits inside a tile gets
 *   the number it would have got from the square — the same cells, added in the
 *   same order;
 * - **the score is not local** — it is a log2 ratio against the mean over the
 *   whole sequence — so it is taken once, after every tile has filed its sums,
 *   and never per tile. Taking it per tile would produce a plausible track
 *   normalised in stripes, which is exactly the failure a golden over one small
 *   contig would never catch.
 */

import { describe, expect, it } from 'vitest'

import { diamondSums, insulationScore } from '@/analysis/insulation'
import { runInsulation } from '@/analysis/run/insulation'
import { INSULATION_TASK } from '@/analysis/tasks/insulation'
import { diagonalTiles } from '@/analysis/tiles'
import type { JobContext } from '@/analysis/job'
import type { AnalysisContext, AnalysisFraming, Params, ProfileOutput } from '@/analysis/types'

const BINSIZE = 1000
/** Comfortably more than one tile, so the seams are real. */
const BINS = 700
const WINDOW = 6

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'whole file',
  binsize: BINSIZE,
  binsPerCell: 1,
  rows: [0, BINS],
  cols: [0, BINS],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/**
 * A map with structure at several scales, so a stripe in the normalisation
 * would show.
 *
 * Contact falls with distance, three boundaries insulate, and a slow ramp along
 * the sequence makes the left end genuinely denser than the right — which is
 * what a per-tile mean would flatten and a whole-sequence mean must not.
 */
const BOUNDARIES = [180, 351, 522]

function valueAt(row: number, col: number): number {
  const distance = Math.abs(col - row)
  let value = 100 / (1 + distance) + (1 - Math.min(row, col) / BINS)
  for (const at of BOUNDARIES) {
    if ((row < at && col >= at) || (col < at && row >= at)) value *= 0.05
  }
  return value
}

function wholeSquare(): Float32Array {
  const values = new Float32Array(BINS * BINS)
  for (let r = 0; r < BINS; r++) {
    for (let c = 0; c < BINS; c++) values[r * BINS + c] = valueAt(r, c)
  }
  return values
}

interface Read {
  rows: [number, number]
  cols: [number, number]
}

function job(params: Params, reads: Read[] = []): JobContext {
  const mc = {
    nBins: BINS,
    nContigs: 1,
    binsize: BINSIZE,
    hasGenomes: false,
    contigGenomeIds: new Int32Array(1),
    chromnames: ['I'],
    chromsizes: new Map([['I', BINS * BINSIZE]]),
    contigExtent: () => [0, BINS] as [number, number],
    names: { find: () => null },
    matrix: async (query: Read) => {
      reads.push({ rows: [...query.rows], cols: [...query.cols] })
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          values[r * ncols + c] = valueAt(query.rows[0] + r, query.cols[0] + c)
        }
      }
      return {
        values,
        nrows,
        ncols,
        rowExtent: [...query.rows] as [number, number],
        colExtent: [...query.cols] as [number, number],
      }
    },
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
    inputs: {} as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

const SETTINGS: Params = {
  window: WINDOW,
  scales: 1,
  region: '',
  ignoreDiags: 2,
  minValid: 0.5,
  balance: false,
  call: true,
  prominence: 0.2,
  spacing: 0,
  domains: true,
}

function profileOf(outputs: Awaited<ReturnType<typeof runInsulation>>): ProfileOutput {
  const found = outputs.find((output): output is ProfileOutput => output.kind === 'profile')
  if (found === undefined) throw new Error('no profile output')
  return found
}

describe('insulation read in tiles', () => {
  it('gives the score the whole square gives, bin for bin', async () => {
    const outputs = await runInsulation(job(SETTINGS))
    const tiled = profileOf(outputs).values

    // The same kernels the runner uses, over the whole square in one go — which
    // is what the runner did before it read in tiles.
    const reference = insulationScore(
      diamondSums({ size: BINS, values: wholeSquare() }, { window: WINDOW, minValid: 0.5, ignoreDiags: 2 }),
    )

    expect(tiled).toHaveLength(BINS)
    let compared = 0
    for (let bin = 0; bin < BINS; bin++) {
      if (!Number.isFinite(reference[bin])) {
        expect(Number.isFinite(tiled[bin])).toBe(false)
        continue
      }
      // Identical, not close: the sums are the same cells added in the same
      // order, and the only narrowing is the lane's own float32.
      expect(tiled[bin]).toBe(Math.fround(reference[bin]))
      compared++
    }
    // The ends of the sequence have no whole diamond, and everything else does:
    // `diamondSums` scores `i` where `i - w >= 0` and `i + w <= size`, which is
    // `size - 2w + 1` bins.
    expect(compared).toBe(BINS - 2 * WINDOW + 1)
  })

  it('calls the same boundaries a whole square would', async () => {
    const outputs = await runInsulation(job(SETTINGS))
    const tiled = profileOf(outputs).values
    // Every boundary built into the map, and nothing between them: a
    // normalisation taken per tile would move these.
    const troughs: number[] = []
    for (let bin = 1; bin < BINS - 1; bin++) {
      if (tiled[bin] < -1 && tiled[bin] <= tiled[bin - 1] && tiled[bin] < tiled[bin + 1]) {
        troughs.push(bin)
      }
    }
    expect(troughs).toEqual(BOUNDARIES)
  })

  it('never reads the square, and covers every bin once', async () => {
    const reads: Read[] = []
    await runInsulation(job(SETTINGS, reads))
    expect(reads.length).toBeGreaterThan(1)
    for (const read of reads) {
      const side = read.rows[1] - read.rows[0]
      expect(side).toBeLessThan(BINS)
      // Square tiles, because `diamondSums` takes a square and is goldened.
      expect(read.cols[1] - read.cols[0]).toBe(side)
    }
  })
})

/**
 * The estimate has to count the reads the runner makes.
 *
 * It priced one dense square per sequence, which is what the runner did before
 * the read was tiled — four range requests for a chromosome that is now read as
 * a run of squares along its diagonal. On mouse chr1 at 5 kb that is a number
 * two orders of magnitude under the truth, on the one screen a reader consults
 * before starting something expensive, and it is also what the scan gate (§18.6)
 * is derived from. So the two share the arithmetic rather than each carrying
 * their own copy of it.
 */
describe('what a tiled read is priced at', () => {
  function context(binsize: number, bp: number): AnalysisContext {
    return {
      hasMap: true,
      hasGenomes: false,
      blockLoaded: false,
      binsize,
      contigs: [{ name: 'I', bins: Math.ceil(bp / binsize) }],
      entries: [],
      framing: null,
    } as unknown as AnalysisContext
  }

  it('counts one read per tile, not one per sequence', async () => {
    const reads: Read[] = []
    await runInsulation(job(SETTINGS, reads))
    // Unbalanced, so `squareFor` is four requests a tile: the bins, the sizes,
    // the pixel index and the pixels themselves.
    const estimate = INSULATION_TASK.estimate(context(BINSIZE, BINS * BINSIZE), SETTINGS)
    expect(estimate.requests).toBe(reads.length * 4)
    expect(estimate.note).toMatch(/along their diagonals/)
  })

  it('grows with the sequence, which is the whole point of having noticed', () => {
    // Mouse chr1 at 5 kb, scored with a 10-bin diamond: 39,095 bins in tiles of
    // 256, which is 153 reads and not one.
    const mouse = context(5000, 195_471_971)
    const priced = INSULATION_TASK.estimate(mouse, SETTINGS)
    expect(diagonalTiles(39_095, 10)).toBeGreaterThan(100)
    expect(priced.requests).toBe(diagonalTiles(39_095, 10) * 4)
  })
})

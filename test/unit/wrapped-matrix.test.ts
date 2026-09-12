/**
 * Reading a block across the junction of a circular sequence.
 *
 * `worker/wrap.ts` is checked on its own arithmetic; this is the read that uses
 * it, against a reader whose every cell is a distinct number — which is the only
 * kind of fixture that can tell a correctly assembled block from a plausible,
 * shuffled one.
 *
 * Four properties, and each is a way the picture comes out looking fine and
 * being wrong:
 *
 * - **every cell is the file's own cell** for the bins it stands over, which is
 *   what a block assembled with its strides confused would fail;
 * - **the junction is not a seam** — the cell just past the sequence's last bin
 *   is the cell of its first, so a diagonal that runs into the join comes out of
 *   it, which is the whole gesture;
 * - **the far corner is read**, since the contacts joining the two ends of a
 *   circle are stored as far from the diagonal as two bins can be, and a walk
 *   that only read the two on-diagonal squares would leave them out;
 * - and the **axis runs** place the second stretch at the sequence's own
 *   beginning rather than a lap past its end, which is what every tick, track
 *   and annotation on it is drawn from.
 */

import { describe, expect, it } from 'vitest'

import { locusAxisFrom } from '@/render/locus'
import type { Extent } from '@/types'
import type { MatrixResult, WorkerRequest } from '@/worker/protocol'
import { readWrapped, type WrapEnv } from '@/worker/wrappedMatrix'

const BINSIZE = 1000
/** Two sequences, so the circular one does not start at bin zero. */
const CONTIGS = [
  { name: 'plasmid', bins: 40 },
  { name: 'chr', bins: 25 },
]
const OFFSET = [0, CONTIGS[0].bins]
const NBINS = CONTIGS[0].bins + CONTIGS[1].bins
const WRAP: Extent = [OFFSET[0], OFFSET[0] + CONTIGS[0].bins]

/** Distinct per cell and symmetric, so a misplaced cell cannot look right. */
function valueAt(row: number, col: number): number {
  const lo = Math.min(row, col)
  const hi = Math.max(row, col)
  return lo * 1000 + hi
}

/** The stored bin an unwrapped one stands for. */
function stored(unwrapped: number): number {
  const lap = WRAP[1] - WRAP[0]
  return WRAP[0] + ((((unwrapped - WRAP[0]) % lap) + lap) % lap)
}

interface Read {
  rows: Extent
  cols: Extent
}

/** A reader that answers any rectangle from {@link valueAt}, and records it. */
function reader(reads: Read[] = []) {
  return {
    nBins: NBINS,
    chromnames: CONTIGS.map((contig) => contig.name),
    hasGenomes: false,
    contigGenomeIds: new Int32Array(CONTIGS.length),
    genomeNames: [] as string[],
    coords: {
      contigOfBin: (bin: number) => (bin < OFFSET[1] ? 0 : 1),
      contigBinExtent: (cid: number) =>
        [OFFSET[cid], OFFSET[cid] + CONTIGS[cid].bins] as [number, number],
      contigLengths: CONTIGS.map((contig) => contig.bins * BINSIZE),
    },
    matrix: async (query: Read) => {
      reads.push({ rows: [...query.rows] as Extent, cols: [...query.cols] as Extent })
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          values[r * ncols + c] = valueAt(query.rows[0] + r, query.cols[0] + c)
        }
      }
      return { values, nrows, ncols, rowExtent: [...query.rows], colExtent: [...query.cols] }
    },
    pooledMatrix: async (query: Read, plan: { binsPerCell: number }) => {
      reads.push({ rows: [...query.rows] as Extent, cols: [...query.cols] as Extent })
      const k = plan.binsPerCell
      const cellsIn = (extent: Extent): number => Math.ceil((extent[1] - extent[0]) / k)
      const nrows = cellsIn(query.rows)
      const ncols = cellsIn(query.cols)
      const values = new Float64Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          // The sum of the bins in the cell, clipped to the extent — which is
          // what a partial last cell holds.
          let sum = 0
          const rowTo = Math.min(query.rows[1], query.rows[0] + (r + 1) * k)
          const colTo = Math.min(query.cols[1], query.cols[0] + (c + 1) * k)
          for (let i = query.rows[0] + r * k; i < rowTo; i++) {
            for (let j = query.cols[0] + c * k; j < colTo; j++) sum += valueAt(i, j)
          }
          values[r * ncols + c] = sum
        }
      }
      return { values, nrows, ncols, binsPerCell: k, contigsPerCell: 1 }
    },
  }
}

/** An environment that never pools and never cancels — the bin-level read. */
function env(overrides: Partial<WrapEnv> = {}): WrapEnv {
  return {
    planFor: () => null,
    snap: (extent) => extent,
    hint: () => '',
    throwIfCancelled: () => {},
    ...overrides,
  }
}

function request(): Extract<WorkerRequest, { kind: 'matrix' }> {
  return { id: 1, kind: 'matrix', rows: [0, 1] }
}

async function read(
  rows: Extent,
  reads: Read[] = [],
  options: Partial<WrapEnv> = {},
): Promise<MatrixResult> {
  const mc = reader(reads)
  return readWrapped(mc as never, request(), rows, rows, WRAP, env(options))
}

describe('readWrapped', () => {
  it('holds the file’s own cell at every position of the block', async () => {
    // The last 10 bins of the plasmid, then its first 10.
    const from = WRAP[1] - 10
    const block = await read([from, from + 20])
    expect(block.nrows).toBe(20)
    expect(block.ncols).toBe(20)
    expect(block.wrapped).toEqual(WRAP)
    expect(block.rowExtent).toEqual([from, from + 20])

    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        expect(block.values[r * 20 + c]).toBe(valueAt(stored(from + r), stored(from + c)))
      }
    }
  })

  it('carries the diagonal through the junction without a seam', async () => {
    const from = WRAP[1] - 5
    const block = await read([from, from + 10])
    // The cell just past the sequence's last bin is the cell of its first, and
    // the two are neighbours on the diagonal: `M[last, first]` is the contact
    // that joins the two ends of the circle.
    expect(block.values[4 * 10 + 5]).toBe(valueAt(WRAP[1] - 1, WRAP[0]))
    // And the diagonal itself is unbroken across the join.
    for (let i = 0; i < 10; i++) {
      const bin = stored(from + i)
      expect(block.values[i * 10 + i]).toBe(valueAt(bin, bin))
    }
  })

  it('reads the far corner, where the ends of the circle meet', async () => {
    const reads: Read[] = []
    const from = WRAP[1] - 6
    await read([from, from + 12], reads)
    // Four sub-reads: tail × tail, tail × head, head × tail, head × head. The
    // two off-diagonal ones are the corner, and a walk that skipped them would
    // leave the join blank.
    expect(reads).toHaveLength(4)
    const corner = reads.find(
      (entry) => entry.rows[0] === WRAP[1] - 6 && entry.cols[0] === WRAP[0],
    )
    expect(corner).toBeDefined()
  })

  it('takes the ordinary road for a window that does not cross the join', async () => {
    const reads: Read[] = []
    const block = await read([WRAP[0] + 5, WRAP[0] + 15], reads)
    expect(reads).toHaveLength(1)
    expect(block.rowGroups).toHaveLength(1)
    expect(block.nrows).toBe(10)
  })

  it('places the second stretch at the sequence’s own beginning', async () => {
    const from = WRAP[1] - 10
    const block = await read([from, from + 20])
    expect(block.rowGroups).toHaveLength(2)
    const axis = locusAxisFrom({
      runs: block.rowGroups,
      blockStart: block.rowExtent[0],
      level: 'bin',
      binsize: BINSIZE,
      contigLength: () => CONTIGS[0].bins * BINSIZE,
    })
    expect(axis).not.toBeNull()
    // The block opens 10 bins from the end of a 40-bin sequence…
    expect(axis?.unitToLocus(0)).toEqual({ contig: 'plasmid', bp: 30 * BINSIZE })
    // …and the cell just past the join is its very first base pair, not a lap
    // further along.
    expect(axis?.unitToLocus(10)).toEqual({ contig: 'plasmid', bp: 0 })
    expect(axis?.unitToLocus(13)).toEqual({ contig: 'plasmid', bp: 3 * BINSIZE })
  })

  it('caps a window wider than the sequence at one lap', async () => {
    const block = await read([WRAP[0] + 5, WRAP[0] + 5 + 200])
    expect(block.nrows).toBe(40)
    expect(block.ncols).toBe(40)
  })

  it('refuses a wrap extent that is not a whole sequence', async () => {
    const mc = reader()
    await expect(
      readWrapped(mc as never, request(), [0, 10], [0, 10], [2, 20], env()),
    ).rejects.toThrow(/whole sequence/)
  })
})

/**
 * The same read, pooled.
 *
 * A wrapped window wide enough to need a coarser grid is the zoomed-out slide —
 * rotating a whole bacterial chromosome under the eye — and it is where the
 * pieces have to *tile*. They do because the grid is anchored to the sequence
 * rather than to the request: the stretch that ends at the sequence's last bin
 * keeps that end, and the stretch that begins at its first is already on a cell
 * edge. What survives is one short cell at the junction, which is the same
 * partial last cell every pooled view of every chromosome already ends with.
 */
describe('readWrapped, pooled', () => {
  const K = 4
  /** `snapToGrid`'s rule, against the fake contig table. */
  const snap = (extent: Extent): Extent => {
    const cid = extent[0] < OFFSET[1] ? 0 : 1
    const start = OFFSET[cid]
    const end = OFFSET[cid] + CONTIGS[cid].bins
    return [
      start + Math.floor((extent[0] - start) / K) * K,
      Math.min(end, start + Math.ceil((extent[1] - start) / K) * K),
    ]
  }
  const pooling = (): Partial<WrapEnv> => ({
    planFor: () => ({ binsPerCell: K, contigsPerCell: 1 }),
    snap,
  })

  it('tiles the two stretches on one grid anchored to the sequence', async () => {
    const from = WRAP[1] - 12
    const block = await read([from, from + 24], [], pooling())
    expect(block.binsPerCell).toBe(K)
    // Twelve bins each side of the join, three cells each, tiling with neither
    // overlap nor gap.
    expect(block.nrows).toBe(6)
    expect(block.ncols).toBe(6)
    expect(block.rowGroups.map((run) => [run.start, run.end])).toEqual([
      [0, 3],
      [3, 6],
    ])
  })

  it('places its coarse cells at the sequence’s own coordinates', async () => {
    const from = WRAP[1] - 12
    const block = await read([from, from + 24], [], pooling())
    const axis = locusAxisFrom({
      runs: block.rowGroups,
      blockStart: block.rowExtent[0],
      level: 'bin',
      binsize: BINSIZE * K,
      contigLength: () => CONTIGS[0].bins * BINSIZE,
    })
    // The block opens 12 bins from the end of a 40-bin sequence…
    expect(axis?.unitToLocus(0)?.bp).toBe(28 * BINSIZE)
    // …and the first cell past the junction is the sequence's own beginning.
    expect(axis?.unitToLocus(3)?.bp).toBe(0)
  })

  it('refuses a grid of whole sequences, which a circle cannot have', async () => {
    const mc = reader()
    await expect(
      readWrapped(mc as never, request(), [0, 40], [0, 40], WRAP, {
        ...env(),
        planFor: () => ({ binsPerCell: 1, contigsPerCell: 2 }),
      }),
    ).rejects.toThrow(/whole-sequence resolution/)
  })
})

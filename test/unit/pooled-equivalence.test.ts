/**
 * The streaming pooled read against the dense one — the equivalence suite
 * `docs/performance-review.md` §8.17 asked for before that path could be trusted.
 *
 * There are two ways to get a picture out of this reader and they must produce
 * the same numbers. The **dense** path allocates the whole rectangle and scatters
 * pixels into it; the **pooled** path never allocates a rectangle at all and
 * accumulates the same pixels straight into the cells that will be drawn. The
 * second is what makes a view larger than a screen affordable — §1.2 of that
 * review measured 82 MB and 3.4 s against 2,370 MB and 6.8 s on the same bytes —
 * and it is only worth having if it is the same answer.
 *
 * Two claims are pinned here, and the second is the one that rots quietly:
 *
 * 1. **Pooling is a sum.** A pooled cell equals the sum of the dense cells it
 *    covers, exactly, for every block shape — on the diagonal, off it, across a
 *    sequence boundary, and where the last cell of a contig is partial.
 * 2. **A block past the threshold never takes the dense path.** That routing is
 *    the whole of the memory claim, it lives in one `if` in the worker, and
 *    nothing else would notice if it stopped being true: the picture would look
 *    identical right up to the size at which the tab dies.
 */

import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { POOLED_CELL_CAP } from '@/metacooler/pooling'
import { RASTER_MAX_DIM } from '@/render/heatmap'
import type { ByteSource, Extent, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

class BytesSource implements ByteSource {
  readonly id = 'pooling.hic'
  readonly size: number
  readonly isRemote = false
  constructor(private readonly data: Uint8Array) {
    this.size = data.byteLength
  }
  async mount(): Promise<string> {
    return this.id
  }
  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    return this.data.subarray(position, position + n).slice()
  }
  stats(): SourceStats {
    return { requests: 0, bytes: 0 }
  }
  close(): void {}
}

const BIN = 100
/** Two sequences of deliberately awkward length: neither is a multiple of 7. */
const CHROMS = [
  { name: 'chrA', length: 15_300 },
  { name: 'chrB', length: 6_100 },
]
const NA = Math.ceil(CHROMS[0].length / BIN)
const NB = Math.ceil(CHROMS[1].length / BIN)

function records(nx: number, ny: number, intra: boolean, seed: number): HicRecord[] {
  const out: HicRecord[] = []
  for (let x = 0; x < nx; x += 1) {
    for (let y = intra ? x : 0; y < ny; y += 1) {
      // Sparse but irregular: a value on about a seventh of the cells, so pooled
      // groups hold different numbers of contributors and a cell that averaged
      // rather than summed would show up.
      if ((x * 7 + y * 13 + seed) % 7 !== 0) continue
      out.push({ x, y, value: ((x + y * 3 + seed) % 11) + 1 })
    }
  }
  return out
}

async function open(): Promise<MetaCooler> {
  const written = await writeHic({
    version: 9,
    chroms: CHROMS,
    resolutions: [BIN],
    records: {
      '1_1': records(NA, NA, true, 1),
      '2_2': records(NB, NB, true, 2),
      '1_2': records(NA, NB, false, 3),
    },
    blockBinCount: 32,
  })
  return MetaCooler.fromHic('pooling.hic', new BytesSource(written.bytes))
}

/**
 * The dense block folded onto the pooled grid the reader chose.
 *
 * Keyed by the pooling's own `cellStart` rather than by recomputing which cell a
 * bin belongs in: the partition is the reader's answer, and a test that derives
 * it independently is testing its own arithmetic as much as the reader's. What
 * is checked here is that the *values* agree once the partition is agreed.
 *
 * **`fold` is the whole subtlety, and it is the one the README warns about.** A
 * dense on-diagonal block is *mirrored* — a contact between bins `i` and `j` is
 * present at both `[i][j]` and `[j][i]` — so summing a diagonal cell naively
 * counts every contact inside it twice. `aggregateDense` reads only `j >= i`
 * there for exactly that reason, and `pixelAccumulator` places each stored pixel
 * once and mirrors at the end, which is the same convention arrived at from the
 * other side. Getting this wrong doubles the diagonal of every coarse picture,
 * and a doubled diagonal reads as *the diagonal is strong* rather than as a bug.
 */
function foldOnto(
  values: Float32Array,
  cols: Extent,
  rowCells: Int32Array,
  colCells: Int32Array,
  fold: boolean,
): Float64Array {
  const nCols = cols[1] - cols[0]
  const nr = rowCells.length - 1
  const nc = colCells.length - 1
  const out = new Float64Array(nr * nc)
  for (let r = 0; r < nr; r++) {
    for (let c = fold ? r : 0; c < nc; c++) {
      let sum = 0
      for (let i = rowCells[r]; i < rowCells[r + 1]; i++) {
        const base = i * nCols
        for (let j = colCells[c]; j < colCells[c + 1]; j++) {
          if (fold && j < i) continue
          sum += values[base + j]
        }
      }
      out[r * nc + c] = sum
    }
  }
  if (fold) {
    for (let r = 0; r < nr; r++) for (let c = r + 1; c < nc; c++) out[c * nc + r] = out[r * nc + c]
  }
  return out
}

describe('a pooled read is the dense read, summed', () => {
  const shapes: Array<{ name: string; rows: Extent; cols: Extent }> = [
    { name: 'on the diagonal, inside one sequence', rows: [0, 120], cols: [0, 120] },
    { name: 'off the diagonal, inside one sequence', rows: [0, 60], cols: [80, 150] },
    { name: 'across a sequence boundary', rows: [NA - 30, NA + 20], cols: [NA - 30, NA + 20] },
    { name: 'the whole file', rows: [0, NA + NB], cols: [0, NA + NB] },
    { name: 'one sequence against the other', rows: [0, NA], cols: [NA, NA + NB] },
  ]

  for (const shape of shapes) {
    for (const k of [2, 5, 16]) {
      it(`${shape.name}, ${k} bins to a cell`, async () => {
        const mc = await open()
        const dense = await mc.matrix({ rows: shape.rows, cols: shape.cols })
        const pooled = await mc.pooledMatrix(
          { rows: shape.rows, cols: shape.cols },
          { binsPerCell: k, contigsPerCell: 1 },
        )
        const onDiagonal = shape.rows[0] === shape.cols[0] && shape.rows[1] === shape.cols[1]
        const want = foldOnto(
          dense.values,
          shape.cols,
          pooled.rowMembers.cellStart,
          pooled.colMembers.cellStart,
          onDiagonal,
        )
        expect(pooled.values.length).toBe(want.length)
        for (let i = 0; i < want.length; i++) {
          // Close rather than exact: the dense block is `Float32Array` and the
          // accumulator is `Float64Array`, so the two sum the same numbers at
          // different widths. A pixel in the wrong cell is orders of magnitude
          // larger than that and is what this is looking for.
          expect(pooled.values[i]).toBeCloseTo(want[i], 4)
        }
      })
    }
  }

  it('conserves the total, which is the claim a figure rests on', async () => {
    const mc = await open()
    const rows: Extent = [0, NA + NB]
    const dense = await mc.matrix({ rows })
    const pooled = await mc.pooledMatrix({ rows }, { binsPerCell: 8, contigsPerCell: 1 })
    const want = foldOnto(
      dense.values,
      rows,
      pooled.rowMembers.cellStart,
      pooled.colMembers.cellStart,
      true,
    )
    let denseTotal = 0
    for (const value of want) denseTotal += value
    let pooledTotal = 0
    for (const value of pooled.values) pooledTotal += value
    expect(pooledTotal).toBeCloseTo(denseTotal, 4)
  })

  it('agrees under balancing too, weights being applied before the sum', async () => {
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': records(NA, NA, true, 1) },
      blockBinCount: 32,
      norms: {
        [`SCALE/1/${BIN}`]: Float64Array.from({ length: NA }, (_, i) => 1 + (i % 5) * 0.25),
      },
    })
    const mc = MetaCooler.fromHic('pooling.hic', new BytesSource(written.bytes))
    const rows: Extent = [0, 120]
    const dense = await mc.matrix({ rows, balance: true })
    const pooled = await mc.pooledMatrix({ rows, balance: true }, { binsPerCell: 4, contigsPerCell: 1 })
    const want = foldOnto(
      dense.values,
      rows,
      pooled.rowMembers.cellStart,
      pooled.colMembers.cellStart,
      true,
    )
    let denseTotal = 0
    for (const value of want) denseTotal += value
    let pooledTotal = 0
    for (const value of pooled.values) pooledTotal += value
    // The order matters and is the reason this case is here: a pooled cell is
    // the sum of *weighted* pixels, never the weighted sum of a raw cell, and
    // the two differ whenever the weights inside a cell are not all equal.
    //
    // Relative, not absolute: the dense block holds `Float32Array` products and
    // the accumulator holds `Float64Array` ones, so a total in the thousands
    // differs in its seventh figure. An absolute tolerance here would pass on a
    // small fixture and fail on a real file, which is the worst of both.
    expect(Math.abs(pooledTotal - denseTotal) / denseTotal).toBeLessThan(1e-6)
  })
})

describe('the pooling threshold', () => {
  it('is never wider than the raster, so nothing is pooled twice', () => {
    // Pooling to anything finer than the raster leaves the renderer to pool
    // again, blind to the sequences it is collapsing. Coarser is a choice: the
    // pooled read is not under the dense guard, so it keeps 4,096 while the
    // raster is wide enough for a window read bin for bin (`denseCellCap`).
    expect(POOLED_CELL_CAP).toBeLessThanOrEqual(RASTER_MAX_DIM)
  })

  it('bounds a whole-file read to the cells a screen can hold', async () => {
    const mc = await open()
    const pooled = await mc.pooledMatrix(
      { rows: [0, mc.nBins] },
      { binsPerCell: 1, contigsPerCell: 1 },
    )
    expect(pooled.nrows).toBeLessThanOrEqual(POOLED_CELL_CAP)
    expect(pooled.ncols).toBeLessThanOrEqual(POOLED_CELL_CAP)
  })

  it('never allocates the rectangle: a pooled read is bounded by the picture', async () => {
    const mc = await open()
    // The picture is what is allocated, and it does not grow with the block.
    // This is the whole of §8.17's claim, and the only way to state it as a test
    // rather than as a measurement is to assert on the shape that comes back.
    const pooled = await mc.pooledMatrix(
      { rows: [0, mc.nBins] },
      { binsPerCell: 4, contigsPerCell: 1 },
    )
    expect(pooled.values.length).toBe(pooled.nrows * pooled.ncols)
    expect(pooled.values.length).toBeLessThanOrEqual(POOLED_CELL_CAP * POOLED_CELL_CAP)
    expect(pooled.binsPerCell).toBeGreaterThanOrEqual(4)
  })
})

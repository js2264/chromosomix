/**
 * A coarse cell belongs to the sequence, not to the question.
 *
 * A block read at more than one bin per cell has to put its cell edges
 * somewhere, and the obvious place — the left edge of whatever was asked for —
 * is the wrong one. It makes a cell's value a function of where the reader
 * started looking: `V:1-600000` and `V:200-600000` would sum different pairs of
 * bins into the pixel over 400 bp, and neither would agree with the whole
 * chromosome. Anchoring to `contigStart + m·k` instead makes the grid a property
 * of the sequence, so every view of a base pair puts it in the same cell holding
 * the same sum — which is the only reason a region view and a chromosome view
 * can be said to show the same map.
 *
 * The two halves are tested separately because they fail separately: the grid
 * has to land on the sequence's edges, and the axis has to *say* where those
 * edges are — a cell drawn in the right place and labelled 0 bp when it is 320
 * kb into the contig is the `unitStart` failure the dense path already avoids.
 */

import { describe, expect, it } from 'vitest'

import { partitionAxis, runStarts } from '@/metacooler/pooling'
import { bpWithin } from '@/ui/blockAxes'
import type { AxisGroup } from '@/worker/protocol'

/**
 * The reader's rule, in one line: widen an extent to the contig's cell edges.
 *
 * A mirror of `snapToGrid` in `worker/reader.worker.ts`, which cannot be
 * imported here — the worker module runs `getH5()` at load. The rule is small
 * enough that restating it is safer than not testing it at all, and the numbers
 * below are the ones the reader has to produce.
 */
function snap(lo: number, hi: number, contig: [number, number], k: number): [number, number] {
  const [start, end] = contig
  return [
    start + Math.floor((lo - start) / k) * k,
    Math.min(end, start + Math.ceil((hi - start) / k) * k),
  ]
}

describe('the anchored grid', () => {
  // Chromosome V of a 100 bp cooler: 5,769 bins beginning at bin 28,911, which
  // at 4,096 cells is two bins to a cell.
  const contig: [number, number] = [28_911, 34_680]
  const k = 2

  it('widens a request to the sequence’s own cell edges', () => {
    // 32,100 bp into the chromosome is bin 321 of it; at two bins a cell that is
    // cell 160 and a half, so the read opens half a cell earlier.
    expect(snap(28_911 + 321, 28_911 + 5000, contig, k)).toEqual([28_911 + 320, 28_911 + 5000])
    // An end that falls mid-cell closes on the cell after it.
    expect(snap(28_911 + 320, 28_911 + 4999, contig, k)).toEqual([28_911 + 320, 28_911 + 5000])
    // Never past the sequence: chromosome V is 5,769 bins, an odd number, so its
    // last cell is one bin — short, as the last *bin* of a contig already is.
    expect(snap(28_911 + 5768, 34_680, contig, k)).toEqual([28_911 + 5768, 34_680])
  })

  it('puts a base pair in the same cell whatever range was asked for', () => {
    // Three requests overlapping bin 1,000 of the contig. Whichever is asked
    // for, that bin is in the cell starting at bin 1,000, holding bins 1,000
    // and 1,001 — so the number under the pointer does not move.
    const cellOf = (lo: number, bin: number): number => {
      const [from] = snap(contig[0] + lo, contig[1], contig, k)
      const n = contig[1] - from
      const part = partitionAxis(n, runStarts(new Int32Array(n)), 4096, {
        binsPerCell: k,
        contigsPerCell: 1,
      })
      // Absolute bin -> block-local index -> cell, then back to the cell's first
      // absolute bin, which is the thing that must not move.
      return from + part.cellStart[part.slot[contig[0] + bin - from]]
    }
    expect(cellOf(0, 1000)).toBe(contig[0] + 1000)
    expect(cellOf(321, 1000)).toBe(contig[0] + 1000)
    expect(cellOf(999, 1000)).toBe(contig[0] + 1000)
  })

  it('reads a cell’s position from the sequence, not from the picture', () => {
    // The reader's `anchor`: a block opening at cell 160 of the contig carries
    // `unitStart = blockStart - 160`, so `bpWithin` counts from the contig.
    const blockStart = contig[0] + 320
    const before = 160
    const group: AxisGroup = {
      label: 'V',
      start: 0,
      end: 2884,
      unitStart: blockStart - before,
    }
    const cellBp = 100 * k
    // Cell 0 of the block is 160 cells into the contig: 32,000 bp, not 0.
    expect(bpWithin(group, 0, blockStart, cellBp)).toBe(32_000)
    expect(bpWithin(group, 1, blockStart, cellBp)).toBe(32_200)
    // And the same base pair read from the whole-chromosome view, where the
    // block starts at the contig and nothing is discounted.
    const whole: AxisGroup = { label: 'V', start: 0, end: 2885, unitStart: contig[0] }
    expect(bpWithin(whole, 160, contig[0], cellBp)).toBe(32_000)
    expect(bpWithin(whole, 161, contig[0], cellBp)).toBe(32_200)
  })
})

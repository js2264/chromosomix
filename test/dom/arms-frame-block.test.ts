// @vitest-environment jsdom
/**
 * Where the rows of the block on screen sit along a bacterial chromosome's arms
 * (§7.5, §8.15), whatever grid the block was read on.
 *
 * The frame is the open map's: a sequence of `n` bins with its origin in one of
 * them. The block need not be on that grid — pooled, read from a sibling rung of
 * an `.mcool`, or read round the circle so its extents run past the end — and a
 * row placed by its index against the open grid put a coarse block's rows all on
 * one arm. Placed by base pairs, through the axis runs, every one of those reads
 * lands where it is.
 */

import { describe, expect, it } from 'vitest'

import { armsFor, originInMiddle, type ArmsPresentation } from '@/ui/MatrixPanel'
import type { AxisGroup, MatrixResult } from '@/worker/protocol'

const LENGTH = 400_000
const BINSIZE = 1_000

/** The frame the session hands over: 400 bins of 1 kb, the origin at bin 100. */
const ARMS: ArmsPresentation = {
  window: 40,
  frame: {
    startBin: 0,
    n: 400,
    origin: 100,
    circular: true,
    binsize: BINSIZE,
    length: LENGTH,
    originBp: 100_500,
  },
  refusal: null,
}

/** A square block over the given runs, with only what placement reads. */
function block(extent: [number, number], runs: AxisGroup[]): MatrixResult {
  const count = extent[1] - extent[0]
  return {
    nrows: count,
    ncols: count,
    values: new Float32Array(count * count),
    rowExtent: extent,
    colExtent: extent,
    rowGroups: runs,
    colGroups: runs,
    level: 'bin',
  }
}

describe('placing a block on the arms', () => {
  it('reads a block on the open grid bin for bin', () => {
    const placed = armsFor(block([0, 400], [{ label: 'chr', start: 0, end: 400, unitStart: 0 }]), ARMS, BINSIZE)
    expect(placed?.frame).toEqual({ n: 400, origin: 100, circular: true })
    expect(placed?.rowBins[0]).toBe(0)
    expect(placed?.rowBins[399]).toBe(399)
    expect(placed?.window).toBe(40)
  })

  it('reads a coarser block in its own cells, the origin and window carried over', () => {
    // A sibling rung at 4 kb: 100 cells, its extents in that grid.
    const placed = armsFor(block([0, 100], [{ label: 'chr', start: 0, end: 100, unitStart: 0 }]), ARMS, 4 * BINSIZE)
    expect(placed?.frame).toEqual({ n: 100, origin: 25, circular: true })
    expect([...(placed?.rowBins ?? [])]).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(placed?.window).toBe(10)
  })

  it('folds a block read round the circle back onto the sequence', () => {
    // The last 50 bins, then the first 50: one lap later, as a wrapped read's
    // second run says.
    const placed = armsFor(
      block([350, 450], [
        { label: 'chr', start: 0, end: 50, unitStart: 0 },
        { label: 'chr', start: 50, end: 100, unitStart: 400 },
      ]),
      ARMS,
      BINSIZE,
    )
    expect(placed?.rowBins[0]).toBe(350)
    expect(placed?.rowBins[49]).toBe(399)
    expect(placed?.rowBins[50]).toBe(0)
    expect(placed?.rowBins[99]).toBe(49)
  })

  it('is absent while the arms are off, or refused', () => {
    const plain = block([0, 400], [{ label: 'chr', start: 0, end: 400, unitStart: 0 }])
    expect(armsFor(plain, { ...ARMS, window: undefined }, BINSIZE)).toBeUndefined()
    expect(armsFor(plain, { ...ARMS, refusal: 'no origin' }, BINSIZE)).toBeUndefined()
  })
})

/**
 * When `ori` is lit (§8.15): the origin in the middle of the picture, to within
 * a bin or a pixel. The middle is the locus at the centre of the visible domain;
 * what the button leaves the view as, and what a zoom about the middle keeps.
 */
describe('whether the origin is in the middle', () => {
  const circle = { circular: true, length: LENGTH, originBp: 100_500 }
  const at = (bp: number): { contig: string; bp: number } => ({ contig: 'chr', bp })

  it('is lit with the origin at the middle, to within the tolerance', () => {
    expect(originInMiddle(at(100_000), circle, BINSIZE)).toBe(true)
    expect(originInMiddle(at(101_500), circle, BINSIZE)).toBe(true)
    expect(originInMiddle(at(102_000), circle, BINSIZE)).toBe(false)
  })

  it('goes out once a pan moves the origin off the middle', () => {
    expect(originInMiddle(at(110_500), circle, BINSIZE)).toBe(false)
    // …unless a pixel is wider than that, at a view of the whole circle.
    expect(originInMiddle(at(110_500), circle, 12_000)).toBe(true)
  })

  it('measures the distance round the circle', () => {
    // A middle at 399,800 is 700 bp from an origin at 500, the short way round.
    expect(originInMiddle(at(399_800), { ...circle, originBp: 500 }, BINSIZE)).toBe(true)
    expect(originInMiddle(at(200_500), circle, BINSIZE)).toBe(false)
  })

  it('is never lit on a line, or with no locus at the middle', () => {
    expect(originInMiddle(at(100_500), { ...circle, circular: false }, BINSIZE)).toBe(false)
    expect(originInMiddle(null, circle, BINSIZE)).toBe(false)
  })
})

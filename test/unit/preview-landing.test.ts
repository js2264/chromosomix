/**
 * The window a block lands on when the reader has moved its stand-in (§7.2).
 *
 * A coarse rung is drawn while the asked block reads, and it takes gestures: the
 * reader may zoom and pan it before the block arrives. The block then lands on
 * their window, carried in base pairs. `viewedPlaces` reads the window off the
 * stand-in's axis and `unitsOfPlaces` puts it on the block's (both in
 * `ui/blockAxes.ts`, called by `MatrixPanel.setData`).
 *
 * Two things set this apart from the refine ladder's carry (`spanOnAxis`, pinned
 * in `regrid-window.test.ts`). The window is **not rounded to cells**: on a
 * stand-in a cell can be half a megabase, and a reader zoomed onto a few of them
 * would otherwise see the block land a whole cell wider at each edge. And it is
 * **not clipped to the block**: a reader zoomed out past the whole picture keeps
 * that magnification.
 *
 * The numbers are a chromosome the size of chicken chr1, drawn from a 500 kb rung
 * while its 25 kb block reads: the case the preview exists for.
 */

import { describe, expect, it } from 'vitest'

import { locusAxisFrom, type AxisRun } from '@/render/locus'
import { unitsOfPlaces, viewedPlaces } from '@/ui/blockAxes'

const CHR1 = 196_449_156
const CHR2 = 149_539_284
const lengthOf = (name: string): number | undefined =>
  name === 'chr1' ? CHR1 : name === 'chr2' ? CHR2 : undefined

/** chr1 alone, from `from` to `to`, on a grid of `binsize`, as `MatrixPanel.locusAxesOf` builds it. */
function axisFor(binsize: number, from = 0, to = CHR1) {
  const first = Math.floor(from / binsize)
  const last = Math.ceil(to / binsize)
  const runs: AxisRun[] = [{ label: 'chr1', start: 0, end: last - first, unitStart: 0, unitLength: CHR1 }]
  const axis = locusAxisFrom({ runs, blockStart: first, level: 'bin', binsize, contigLength: lengthOf })
  if (axis === null) throw new Error('no axis')
  return { axis, cells: last - first }
}

/** chr1 then chr2, whole, on a grid of `binsize`: an axis across a boundary. */
function twoContigs(binsize: number) {
  const n1 = Math.ceil(CHR1 / binsize)
  const n2 = Math.ceil(CHR2 / binsize)
  const runs: AxisRun[] = [
    { label: 'chr1', start: 0, end: n1, unitStart: 0, unitLength: CHR1 },
    { label: 'chr2', start: n1, end: n1 + n2, unitStart: n1, unitLength: CHR2 },
  ]
  const axis = locusAxisFrom({ runs, blockStart: 0, level: 'bin', binsize, contigLength: lengthOf })
  if (axis === null) throw new Error('no axis')
  return { axis, n1 }
}

describe('carrying a moved stand-in onto its block', () => {
  it('lands on the same base pairs, to the base pair', () => {
    const coarse = axisFor(500_000)
    const fine = axisFor(25_000)
    // A reader zoomed onto four and a half cells of the stand-in, off any cell edge.
    const places = viewedPlaces(coarse.axis, [100.3, 104.7])
    expect(places?.from).toEqual({ contig: 'chr1', bp: 50_150_000 })
    expect(places?.to).toEqual({ contig: 'chr1', bp: 52_350_000 })
    const units = unitsOfPlaces(fine.axis, places)
    expect(units).not.toBeNull()
    const [lo, hi] = units as [number, number]
    // Not 50.0–52.5 Mb, which is the window rounded out to the stand-in's cells
    // (`MatrixPanel.framedWindows`): 14% wider, on a window four cells across.
    expect(lo * 25_000).toBeCloseTo(50_150_000, 3)
    expect(hi * 25_000).toBeCloseTo(52_350_000, 3)
  })

  it('keeps the magnification, so the block lands at the same zoom', () => {
    // `showCellWindow` fits the span it is given: a span twenty times as many
    // cells on a grid twenty times as fine is the same picture.
    const coarse = axisFor(500_000)
    const fine = axisFor(25_000)
    const [lo, hi] = unitsOfPlaces(fine.axis, viewedPlaces(coarse.axis, [37.25, 61.5])) as [number, number]
    expect(hi - lo).toBeCloseTo((61.5 - 37.25) * 20, 6)
  })

  it('survives a block that opens partway along the sequence', () => {
    // A region view of chr1:50–60 Mb: both blocks open at their own grid's cell
    // for 50 Mb, and the window is carried through each one's `blockStart`.
    const coarse = axisFor(500_000, 50_000_000, 60_000_000)
    const fine = axisFor(25_000, 50_000_000, 60_000_000)
    const places = viewedPlaces(coarse.axis, [4.5, 9])
    expect(places?.from.bp).toBe(52_250_000)
    const [lo, hi] = unitsOfPlaces(fine.axis, places) as [number, number]
    expect(lo * 25_000 + 50_000_000).toBeCloseTo(52_250_000, 3)
    expect(hi * 25_000 + 50_000_000).toBeCloseTo(54_500_000, 3)
  })

  it('carries a window wider than the block past both of its ends', () => {
    // Zoomed out past the whole stand-in: the block is a picture in the middle
    // of paper, and lands as one, at the same width, rather than refitted.
    const coarse = axisFor(500_000)
    const fine = axisFor(25_000)
    const domain: [number, number] = [-50, coarse.cells + 57]
    const places = viewedPlaces(coarse.axis, domain)
    expect(places?.before).toBe(50 * 500_000)
    expect(places?.after).toBe(57 * 500_000)
    const [lo, hi] = unitsOfPlaces(fine.axis, places) as [number, number]
    expect(lo).toBeCloseTo(-50 * 20, 6)
    // The whole window, in base pairs, on the finer grid.
    expect((hi - lo) * 25_000).toBeCloseTo((domain[1] - domain[0]) * 500_000, 0)
  })

  it('carries a window across a boundary between two sequences', () => {
    const coarse = twoContigs(500_000)
    const fine = twoContigs(25_000)
    // From 3 cells before chr2 to 2 cells into it.
    const places = viewedPlaces(coarse.axis, [coarse.n1 - 3, coarse.n1 + 2])
    expect(places?.from.contig).toBe('chr1')
    expect(places?.to).toEqual({ contig: 'chr2', bp: 1_000_000 })
    const [lo, hi] = unitsOfPlaces(fine.axis, places) as [number, number]
    expect(hi).toBeCloseTo(fine.n1 + 40, 6)
    // chr1's last coarse cell is partial, so its places are counted from chr1's
    // own start on each grid, never from the boundary.
    expect(lo).toBeCloseTo(((coarse.n1 - 3) * 500_000) / 25_000, 6)
  })

  it('declines rather than guesses', () => {
    const coarse = axisFor(500_000)
    const fine = axisFor(25_000)
    // A turned map's rows, which are distance from the diagonal.
    expect(viewedPlaces(null, [0, 10])).toBeNull()
    expect(unitsOfPlaces(null, viewedPlaces(coarse.axis, [0, 10]))).toBeNull()
    // A window that does not meet the block.
    expect(viewedPlaces(coarse.axis, [coarse.cells + 5, coarse.cells + 10])).toBeNull()
    // Nothing read.
    expect(unitsOfPlaces(fine.axis, null)).toBeNull()
    // A sequence the block does not carry.
    const other = viewedPlaces(twoContigs(500_000).axis, [twoContigs(500_000).n1 + 1, twoContigs(500_000).n1 + 4])
    expect(other?.from.contig).toBe('chr2')
    expect(unitsOfPlaces(fine.axis, other)).toBeNull()
  })
})

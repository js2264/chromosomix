/**
 * The window a refine carries across a change of grid.
 *
 * `MatrixPanel.regrid` swaps the block for one read at a different resolution
 * and has to leave the picture over the same stretch of genome. The transform it
 * would be tempting to preserve is the wrong thing to preserve: `originX` and
 * `zoom` are counted in *cells*, and a cell is a different number of base pairs
 * on every grid, so carrying them across a 4×-finer read shows a quarter of the
 * genome at four times the magnification — a picture that moved without anybody
 * asking it to.
 *
 * So the window is carried in base pairs and converted back through the incoming
 * block's own axis. `spanOnAxis` is that conversion, and these are its
 * properties: the same stretch of genome whatever the grid, a refusal rather
 * than an approximation when the incoming block cannot answer, and a clamp that
 * keeps a padded window inside the block it landed in.
 *
 * The numbers are a yeast cooler's, at the three grids `fitPlan` would actually
 * choose for chromosome IV: 1 kb bins read at 4 bins per cell, at 2, and at 1.
 */

import { describe, expect, it } from 'vitest'

import { locusAxisFrom, type AxisRun } from '@/render/locus'
import { spanOnAxis } from '@/ui/MatrixPanel'

const IV_LENGTH = 1_531_933
const lengthOf = (name: string): number | undefined => (name === 'IV' ? IV_LENGTH : undefined)

/**
 * Chromosome IV alone, read at `binsPerCell` bins to a cell off a 1 kb file.
 *
 * `blockStart` is the absolute bin the block opens at, which for a coarse read
 * is the contig's own cell-aligned start — the reader's `snapToGrid` rule. The
 * axis is built exactly as `MatrixPanel.locusAxesOf` builds it.
 */
function axisFor(binsPerCell: number, from = 0, to = IV_LENGTH) {
  const binsize = 1000 * binsPerCell
  const first = Math.floor(from / binsize)
  const last = Math.ceil(to / binsize)
  const runs: AxisRun[] = [
    { label: 'IV', start: 0, end: last - first, unitStart: 0, unitLength: IV_LENGTH },
  ]
  return {
    axis: locusAxisFrom({ runs, blockStart: first, level: 'bin', binsize, contigLength: lengthOf }),
    cells: last - first,
    binsize,
  }
}

/** What `MatrixPanel.framedEdges` produces from a visible window. */
function edges(fromBp: number, toBp: number) {
  return { from: { contig: 'IV', bp: fromBp }, to: { contig: 'IV', bp: toBp } }
}

describe('carrying a window across a change of grid', () => {
  it('lands on the same base pairs, whatever the incoming grid', () => {
    const want = edges(400_000, 500_000)
    for (const k of [1, 2, 4, 8]) {
      const { axis, cells, binsize } = axisFor(k)
      const span = spanOnAxis(axis, want, cells)
      expect(span, `k=${k}`).not.toBeNull()
      const [lo, hi] = span as readonly [number, number]
      // The cell interval is the bp interval divided by that grid's own cell
      // size — which is the whole claim. Exact, because both edges are round
      // multiples of 8 kb and every grid here divides it.
      expect(lo * binsize, `k=${k} start`).toBe(400_000)
      expect(hi * binsize, `k=${k} end`).toBe(500_000)
    }
  })

  it('keeps the span proportional, so the zoom does not jump', () => {
    // The property `regrid` actually depends on: a window that was 100 cells
    // wide on a 4 kb grid is 400 cells wide on a 1 kb grid, and the caller's
    // `showCellWindow` therefore lands on four times the zoom over the same
    // picture — which is the same picture.
    const coarse = axisFor(4)
    const fine = axisFor(1)
    const want = edges(400_000, 500_000)
    const a = spanOnAxis(coarse.axis, want, coarse.cells) as readonly [number, number]
    const b = spanOnAxis(fine.axis, want, fine.cells) as readonly [number, number]
    expect(b[1] - b[0]).toBe((a[1] - a[0]) * 4)
  })

  it('survives a block that opens partway along the sequence', () => {
    // What a refine actually asks for: a window around the view, snapped down to
    // the contig's own cell edges. The axis then starts at a non-zero bin, and
    // the conversion has to account for it — this is the `blockStart` term, and
    // getting it wrong puts the picture a whole window away from where it was.
    const { axis, cells, binsize } = axisFor(2, 380_000, 520_000)
    const span = spanOnAxis(axis, edges(400_000, 500_000), cells) as readonly [number, number]
    expect(span[0] * binsize + 380_000).toBe(400_000)
    expect(span[1] * binsize + 380_000).toBe(500_000)
  })

  it('clamps a padded window to the block it landed in', () => {
    // The ladder reads half a window wider than the view on each side, and near
    // the end of a chromosome that padding runs off the sequence. The block stops
    // at the last bin; the window must stop with it rather than name cells that
    // are not there.
    const { axis, cells } = axisFor(1)
    const span = spanOnAxis(axis, edges(1_400_000, IV_LENGTH + 200_000), cells)
    expect(span).not.toBeNull()
    expect((span as readonly [number, number])[1]).toBe(cells)
  })

  it('refuses rather than approximates when the axis cannot answer', () => {
    const { axis, cells } = axisFor(1)
    // A contig this block does not cover. Returning 0 here would draw the wrong
    // chromosome at the right zoom, which is indistinguishable from working.
    expect(spanOnAxis(axis, edges(0, 1000), cells)).not.toBeNull()
    expect(
      spanOnAxis(axis, { from: { contig: 'XVI', bp: 0 }, to: { contig: 'XVI', bp: 1000 } }, cells),
    ).toBeNull()
    // No axis at all — a turned map's rows, or an axis of whole contigs.
    expect(spanOnAxis(null, edges(0, 1000), cells)).toBeNull()
    // Nothing was framed.
    expect(spanOnAxis(axis, null, cells)).toBeNull()
  })

  it('refuses an interval that collapses to nothing', () => {
    const { axis, cells } = axisFor(4)
    // Both edges inside one 4 kb cell. A zero-width window would make
    // `showCellWindow` divide by its own epsilon and pin the zoom at its
    // ceiling; the honest answer is that this grid cannot hold that window, and
    // the caller falls back to a refit.
    expect(spanOnAxis(axis, edges(400_000, 400_000), cells)).toBeNull()
  })
})

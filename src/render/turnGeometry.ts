/**
 * A turned block as the map panel hands it to the renderer and reads it back
 * (§17).
 *
 * `render/rotate.ts` is the rotation itself — where a contact goes, which pair
 * of bins a turned cell came from — and is written against nothing but its own
 * block. `render/heatmap.ts` draws a dense block in a box and knows of a turn
 * only the numbers it is handed for its guides. Between the two sit three small
 * facts the panel needs of every block it turns: the band as the ordinary dense
 * matrix the renderer takes, which edge of its box the band stands on, and where
 * a cell of it stands on the genomic axis. They are here rather than in either
 * neighbour because each would then have to speak the other's vocabulary: the
 * rotation would need the renderer's anchor type, and the renderer already
 * imports the rotation for its guides.
 *
 * Pure — no DOM, no canvas, no panel — which is why it is not in
 * `ui/MatrixPanel.ts`, where it used to be: the tests that pin these import a
 * function of one argument, and should not have to import a panel to reach it.
 */

import type { DenseMatrix } from '../types'
import type { VerticalAnchor } from './heatmap'
import type { RotatedBlock } from './rotate'

/** The band, as an ordinary dense block the renderer can be handed. */
export function turnedDense(turned: RotatedBlock): DenseMatrix {
  return {
    nrows: turned.nrows,
    ncols: turned.ncols,
    values: turned.values,
    // The band's own extents, in the half-bin units its columns are counted in,
    // so anything downstream that measures a span in cells measures it in the
    // grid actually on screen.
    rowExtent: [0, turned.nrows],
    colExtent: [turned.originBin * 2, turned.originBin * 2 + turned.ncols],
  }
}

/**
 * Which edge of its box a turned block is pinned to — see the caller for why it
 * is pinned at all.
 *
 * `middle` for a square map, which is centred like any picture, and for a
 * **mirrored pair**, whose diagonal is the line down the middle of it rather
 * than either edge. `end` and `start` are the one-band cases, standing on
 * whichever edge their own diagonal is.
 *
 * Exported for the test: the whole of the bug it fixes is invisible until a
 * band is deeper than its box, which is two zooms away from any state a test
 * can set up directly.
 */
export function anchorFor(turned: RotatedBlock | null): VerticalAnchor {
  if (turned === null || turned.fold !== undefined) return 'middle'
  return turned.direction === 'down' ? 'start' : 'end'
}

/**
 * Where a cell of a turned map stands on the genomic axis, in cells of the
 * square block it was turned out of.
 *
 * The **midpoint** of the pair it is a contact between, which is what a turned
 * column is: the rotation puts the cell for `(i, j)` over `(i + j) / 2` and its
 * height carries the rest (`render/rotate.ts`). Half-integers are the ordinary
 * case rather than an edge one — a column is half a bin — and are passed on
 * rather than rounded, since the arithmetic below them is linear and the reader
 * is being told a position, not a bin.
 */
export function alongAxis(square: { row: number; col: number }): number {
  return (square.row + square.col) / 2
}

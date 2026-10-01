/**
 * Reading past the end of a sequence that has no end.
 *
 * A circular chromosome — a bacterial genome, a plasmid, a mitochondrion, a
 * phage — is stored as a line, because a `.cool` has no way to store anything
 * else: bins run from zero to the last one and stop. Everything the app does
 * with it is therefore correct and slightly wrong. The map has two artificial
 * corners, the diagonal runs into a wall at each end, and the contacts joining
 * the last bin to the first one — which on a circle are the most local contacts
 * there are — sit in the top-right corner of the square, as far from the
 * diagonal as two bins can be.
 *
 * So once the reader has declared the circle, two windows run **past** the end
 * and come back on at the beginning (§8.15): one typed across the origin —
 * `chrom:2,900,000-100,000` on a 3 Mb circle, a perfectly ordinary place to want
 * to look — and `ori`'s, which frames the whole circle with the origin in the
 * middle. Each is two pieces of the stored sequence: here the last 100 kb and the
 * first 100 kb. On both axes at once, so a square window across the junction is
 * up to **four** stored blocks, one of which is that far corner.
 *
 * This module is the arithmetic that says which pieces, and nothing else: no
 * file, no reading, no `MetaCooler`. `worker/reader.worker.ts` does the reads and
 * the assembly, and `test/unit/wrapped-read.test.ts` checks the pieces against
 * hand-worked cases, because an off-by-one here is a block whose two halves are
 * a bin apart — which draws as a real discontinuity at the one place the reader
 * turned the flag on to remove.
 *
 * ## The coordinates
 *
 * Two spaces, and keeping them apart is the whole discipline:
 *
 * - **Unwrapped** bins, which is what a wrapped request is written in and what
 *   the block that comes back reports as its extent. They run off both ends of
 *   the sequence: `[2_900, 3_100)` on a 3,000-bin circle is a real request, and
 *   so is `[-100, 100)`. A window across the origin is the view's ceiling in
 *   this space — a zoom inside it refines as it does anywhere, a pan stops at
 *   its edges, and no read goes past it, since the view does not slide round
 *   the circle — and it is this space because it is the only one in which that
 *   window is one interval. Written in stored bins it would open at 2,900 and
 *   close at 100, and every `covers`, `pad`, `recentre` and `clip` in
 *   `ui/refine.ts` would have to learn about a window whose end is below its
 *   start.
 * - **Stored** bins, which is what the file has: always inside the sequence.
 *
 * {@link wrapPieces} is the map from the first to the second.
 */

import type { Extent } from '../types'

/** One stored run of a wrapped window, and where it lands in the block. */
export interface WrapPiece {
  /** First stored bin of this piece — inside the sequence, always. */
  from: number
  /** One past its last stored bin. */
  to: number
  /**
   * Offset of this piece's first bin within the assembled block, in **bins**.
   *
   * Bins rather than cells, because this is settled before anything is read and
   * a pooled read does not yet know how many cells its piece will come to. The
   * assembly converts, from the sizes the sub-blocks report.
   */
  at: number
  /**
   * What to add to a stored bin of this piece to get its unwrapped bin.
   *
   * `0` for the piece the window opens on and one sequence length per lap after
   * it — which is exactly what the axis runs need in order to say *this stretch
   * is the beginning of the sequence, one lap along*. See
   * `render/locus.ts`, whose `bpStart` arithmetic is written against it.
   */
  shift: number
}

/**
 * The stored pieces of an unwrapped window on a circular sequence.
 *
 * `wrap` is the sequence's own bin extent, half-open, in the same absolute bin
 * space `extent` is written in. The window may start anywhere — before the
 * sequence, inside it, several laps past it — and the first piece always starts
 * at the bin the window actually opens on.
 *
 * **The span is capped at one lap.** A window wider than the sequence would
 * visit the same bins twice, and a block holding a stored bin in two places is
 * one where a contact is drawn twice and a click resolves to whichever copy the
 * hit test reached first. A reader who has zoomed out that far is looking at the
 * whole sequence, so the whole sequence is what they get.
 *
 * An empty or degenerate window returns no pieces at all, which is what every
 * caller here already does with one.
 */
export function wrapPieces(extent: Extent, wrap: Extent): WrapPiece[] {
  const lap = wrap[1] - wrap[0]
  if (!(lap > 0)) return []
  const span = Math.min(lap, Math.max(0, Math.round(extent[1]) - Math.round(extent[0])))
  if (span <= 0) return []

  const from = Math.round(extent[0])
  // Laps, floored — so a window opening *before* the sequence starts counts a
  // negative lap and its first piece is near the sequence's end, which is where
  // "one hundred bins before the origin" is on a circle.
  const laps = Math.floor((from - wrap[0]) / lap)
  let cursor = from - laps * lap
  let shift = laps * lap
  let at = 0
  let left = span

  const out: WrapPiece[] = []
  while (left > 0) {
    const take = Math.min(left, wrap[1] - cursor)
    out.push({ from: cursor, to: cursor + take, at, shift })
    at += take
    left -= take
    cursor = wrap[0]
    shift += lap
  }
  return out
}

/**
 * Whether a window needs the wrapped path at all.
 *
 * A window that happens to lie entirely inside the sequence is read by the
 * ordinary path — same bins, same block, same grid — and this is what says so.
 * Worth asking, because it is the common case: a reader on a circular
 * chromosome spends most of their time away from the junction, and a one-piece
 * "assembly" that copies a block into a second array of the same size is a
 * megabyte of pointless work per frame.
 */
export function needsWrapping(extent: Extent, wrap: Extent): boolean {
  const pieces = wrapPieces(extent, wrap)
  return pieces.length > 1 || (pieces.length === 1 && pieces[0].shift !== 0)
}

/**
 * The pieces of a wrapped read, laid out as one block.
 *
 * `grid[r][c]` is the sub-block for row piece `r` against column piece `c`, and
 * every one of them is a dense row-major rectangle. What comes back is the outer
 * product written into a single array — nothing is summed, nothing is scaled,
 * and every cell appears exactly once.
 *
 * Separate from the reading for one reason: this is the arithmetic that goes
 * silently wrong. A block assembled with the strides confused is a picture that
 * is *plausible* — it has a bright diagonal, it has structure — and it is
 * shuffled. `test/unit/wrapped-read.test.ts` checks it against a block whose
 * every cell is a distinct number, which is the only way to see that.
 */
export function stitch(grid: readonly (readonly Sub[])[]): Sub {
  const rowCells = grid.map((line) => line[0]?.nrows ?? 0)
  const colCells = (grid[0] ?? []).map((piece) => piece.ncols)
  const nrows = rowCells.reduce((sum, cells) => sum + cells, 0)
  const ncols = colCells.reduce((sum, cells) => sum + cells, 0)
  const values = new Float32Array(nrows * ncols)
  let atRow = 0
  for (let r = 0; r < grid.length; r++) {
    let atCol = 0
    for (let c = 0; c < grid[r].length; c++) {
      const piece = grid[r][c]
      for (let i = 0; i < piece.nrows; i++) {
        values.set(
          piece.values.subarray(i * piece.ncols, i * piece.ncols + piece.ncols),
          (atRow + i) * ncols + atCol,
        )
      }
      atCol += colCells[c]
    }
    atRow += rowCells[r]
  }
  return { nrows, ncols, values }
}

/** A dense row-major rectangle: one piece going in, or the whole block coming out. */
export interface Sub {
  nrows: number
  ncols: number
  values: Float32Array
}

/**
 * Where a wrapped axis's stretches say the sequence itself begins.
 *
 * The one number in a wrapped read that takes thought. `render/locus.ts` reads
 * a run's `unitStart` as *the position the sequence itself begins at*, and on a
 * wrapped axis that has to name a **different** place for each lap — or the
 * stretch on the far side of the junction reports a `bpStart` of a whole
 * sequence length rather than of zero, and every tick, track and annotation on
 * it is drawn a chromosome away.
 *
 * The formula inverts what `bpWithin` does: a cell at block offset `o` reports
 * `(blockStart + o − unitStart) × cellSize`, and what that has to be is the
 * distance from the sequence's own first cell. For a stretch whose first cell is
 * `at` cells into the block and `before` cells into the sequence, that is
 * `blockStart + at − before`. At bin level `before` is a bin count and the cell
 * size is the bin size, so one line serves both.
 *
 * `starts` is each stretch's own first **stored** bin, after any snap to the
 * pooling grid; `cells` is how many cells each came to.
 */
export function wrapUnitStarts(options: {
  starts: readonly number[]
  cells: readonly number[]
  /** The unwrapped bin the block opens at — its reported `rowExtent[0]`. */
  blockStart: number
  /** The sequence's own first stored bin. */
  contigStart: number
  /** Bins per cell; `1` for a bin-level read. */
  binsPerCell: number
}): number[] {
  const k = Math.max(1, options.binsPerCell)
  const out: number[] = []
  let at = 0
  for (let i = 0; i < options.starts.length; i++) {
    const before = Math.round((options.starts[i] - options.contigStart) / k)
    out.push(options.blockStart + at - before)
    at += options.cells[i] ?? 0
  }
  return out
}

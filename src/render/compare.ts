/**
 * Two files in one square: side by side across the diagonal, or reduced to the
 * one number that is the comparison itself.
 *
 * A contact matrix is symmetric, so half of every map on screen is a mirror of
 * the other half and carries no information at all. That is the room this uses:
 * the lower-left triangle is given to a *second* file, and the picture stops
 * being symmetric — which is the point, because the eye reads a broken symmetry
 * far faster than it reads two maps side by side.
 *
 * The split is the **matrix diagonal**, not the viewport's. A cell belongs to
 * the second file when its row bin is greater than its column bin, wherever the
 * view happens to be — so panning off the diagonal is not a special case and
 * needs no rule of its own: the far corner of a trans block is entirely above
 * the diagonal and shows the first file alone, and its transpose shows the
 * second. Splitting the *screen* instead would put two unrelated blocks side by
 * side and invite them to be read as one picture.
 *
 * The split answers "what do these two look like"; it does not answer "where do
 * they differ", and past a certain similarity the eye cannot get that out of two
 * triangles at all. {@link combine} is the other reading: collapse the pair to
 * one derived field — a ratio or a difference — where the *only* thing drawn is
 * the disagreement, and every cell that matches is the neutral colour. Both are
 * the same two blocks and the same alignment gate; they differ in what is thrown
 * away, which is why they are one control with three settings rather than a
 * comparison mode and a separate arithmetic feature.
 *
 * Nothing here draws. It produces one values array in the shape the renderer
 * already takes, which is what keeps `render/heatmap.ts` unaware that comparing
 * exists — pooling, colouring, pan and zoom are the same code on a compared map
 * as on any other.
 */

import type { BlockValues } from './derive'
import type { CompareOp } from '../types'

export type { CompareOp }

/**
 * The part of a read this module needs: shape, values, and where they sit.
 *
 * The same shape `render/derive.ts` works over, and named there because a single
 * file's derivations are the more basic of the two: comparing is arithmetic over
 * two of these, deriving is arithmetic over one.
 */
export type CompareBlock = BlockValues

export interface Blend {
  /** Merged values, row-major, `nrows * ncols` long. */
  values: Float32Array
  /** Cells taken from the second file — 0 when the view is all above the diagonal. */
  lower: number
  /** Cells left to the first. Both are reported so a view can say what is on screen. */
  upper: number
}

/**
 * `true` when two blocks describe the same cells and can therefore be merged.
 *
 * Shape *and* position: two reads of the same request against files with the
 * same contigs and the same bin size agree on all four, and anything that does
 * not agree is a block of something else. The caller draws the first file alone
 * rather than merging misaligned data, which would put file 2's chromosome III
 * under file 1's chromosome VII and look like a discovery.
 */
export function alignable(a: CompareBlock, b: CompareBlock): boolean {
  return (
    a.nrows === b.nrows &&
    a.ncols === b.ncols &&
    a.rowExtent[0] === b.rowExtent[0] &&
    a.rowExtent[1] === b.rowExtent[1] &&
    a.colExtent[0] === b.colExtent[0] &&
    a.colExtent[1] === b.colExtent[1] &&
    b.values.length >= b.nrows * b.ncols
  )
}

/**
 * Merge two aligned blocks across the matrix diagonal.
 *
 * On one scale, always: the same colour means the same number of contacts on
 * both sides of the line. Two files sequenced to different depths are made
 * comparable by drawing both to one total (§6.5) — the breadcrumb's *contacts*
 * box — which changes the contacts rather than the colours, so the two
 * triangles are then two libraries of one depth and not one library rescaled.
 *
 * The diagonal itself stays with the *first* file. A cell on it is one bin
 * against itself and is the brightest cell in any Hi-C map; handing alternate
 * diagonal cells to different files would draw a dashed line down the middle of
 * the picture that is an artefact of nothing.
 */
export function blendAcrossDiagonal(primary: CompareBlock, second: CompareBlock): Blend {
  const { nrows, ncols } = primary
  const values = new Float32Array(primary.values.subarray(0, nrows * ncols))
  let lower = 0

  // The two axes may cover different bin ranges — a `contig_A × contig_B` block
  // does — so "below the diagonal" is a comparison of *absolute bins*, not of
  // row and column indices. Where the extents coincide the two are the same
  // question, and the cheap form below is taken.
  const square =
    primary.rowExtent[0] === primary.colExtent[0] &&
    primary.rowExtent[1] === primary.colExtent[1] &&
    nrows === ncols

  if (square) {
    for (let r = 0; r < nrows; r++) {
      const row = r * ncols
      for (let c = 0; c < r; c++) {
        values[row + c] = second.values[row + c]
        lower++
      }
    }
    return { values, lower, upper: nrows * ncols - lower }
  }

  const rowStep = (primary.rowExtent[1] - primary.rowExtent[0]) / Math.max(1, nrows)
  const colStep = (primary.colExtent[1] - primary.colExtent[0]) / Math.max(1, ncols)
  for (let r = 0; r < nrows; r++) {
    const rowBin = primary.rowExtent[0] + r * rowStep
    const row = r * ncols
    for (let c = 0; c < ncols; c++) {
      if (primary.colExtent[0] + c * colStep >= rowBin) continue
      values[row + c] = second.values[row + c]
      lower++
    }
  }
  return { values, lower, upper: nrows * ncols - lower }
}

/**
 * Every way of putting two files together, in the order they are offered.
 *
 * `split` is the picture; the other two are the measurement. They are one
 * control because they are one question — *how* do I want these two put together
 * — and because every one of them is served by the same pair of reads and the
 * same alignment gate, so offering them anywhere but beside each other would
 * suggest they cost different amounts.
 */
export const COMPARE_OPS: readonly CompareOp[] = ['split', 'ratio', 'difference']

export function isCompareOp(value: string): value is CompareOp {
  return (COMPARE_OPS as readonly string[]).includes(value)
}

export interface Combined extends Blend {
  /**
   * The value that means "these two agree", or `null` for the split, which is
   * not a derived quantity at all but two files' own counts side by side.
   *
   * `1` for the ratio and `0` for the difference — the number the colour scale
   * is made symmetric about and the colourbar's middle tick.
   */
  neutral: number | null
}

/**
 * Put two aligned blocks together, whichever way was asked for.
 *
 * Two libraries at different depth differ by roughly a scalar, so the *ratio* of
 * their raw counts is that scalar everywhere — a flat wash whose colour is the
 * sequencing depth. The answer is not to divide a guess at that scalar out of
 * the picture but to compare the libraries at one depth: the breadcrumb's
 * *contacts* box draws both files to one total before either is read (§6.5).
 * Balanced values need neither, having already been put on one normalisation.
 *
 * The arithmetic is deliberately plain, because JavaScript's own division
 * already produces the three answers a reader needs and a guarded version would
 * have to reproduce them: `4 / 0` is `Infinity`, which the raster clamps to the
 * top of the scale and which is the truth — present in one file, absent in the
 * other; `0 / 0` is `NaN`, drawn transparent, which is also the truth, since two
 * empty cells have no ratio; and a `NaN` from either file, an unbalanced bin,
 * carries through to mean the comparison could not be made.
 */
export function combine(
  primary: CompareBlock,
  second: CompareBlock,
  options: { op: CompareOp },
): Combined {
  if (options.op === 'split') return { ...blendAcrossDiagonal(primary, second), neutral: null }

  const { nrows, ncols } = primary
  const cells = nrows * ncols
  const values = new Float32Array(cells)
  const ratio = options.op === 'ratio'
  for (let i = 0; i < cells; i++) {
    const other = second.values[i]
    values[i] = ratio ? primary.values[i] / other : primary.values[i] - other
  }
  // Both files are drawn over the whole square rather than a triangle each, so
  // neither count is a count of cells on screen any more. Reported as the whole
  // block for both, which is what a caller counting "cells from file 2" has to
  // be told when the answer is "all of them, and from file 1 as well".
  return { values, lower: cells, upper: cells, neutral: ratio ? 1 : 0 }
}

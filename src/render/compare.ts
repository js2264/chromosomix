/**
 * Two files in one square: the first above the diagonal, the second below it.
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
 * Nothing here draws. It produces one values array in the shape the renderer
 * already takes, which is what keeps `render/heatmap.ts` unaware that comparing
 * exists — pooling, colouring, pan and zoom are the same code on a compared map
 * as on any other.
 */

import { percentileOf } from './scale'

/** The part of a read this module needs: shape, values, and where they sit. */
export interface CompareBlock {
  nrows: number
  ncols: number
  values: Float32Array
  rowExtent: readonly [number, number]
  colExtent: readonly [number, number]
}

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
 * `gain` multiplies the second file's counts, which is how the two are made
 * comparable when they differ in depth — see {@link matchGain}. `1` leaves them
 * on one scale, which is the default and the honest one: the same colour then
 * means the same number of contacts on both sides of the line.
 *
 * The diagonal itself stays with the *first* file. A cell on it is one bin
 * against itself and is the brightest cell in any Hi-C map; handing alternate
 * diagonal cells to different files would draw a dashed line down the middle of
 * the picture that is an artefact of nothing.
 */
export function blendAcrossDiagonal(
  primary: CompareBlock,
  second: CompareBlock,
  options: { gain?: number } = {},
): Blend {
  const { nrows, ncols } = primary
  const gain = options.gain ?? 1
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
        values[row + c] = second.values[row + c] * gain
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
      values[row + c] = second.values[row + c] * gain
      lower++
    }
  }
  return { values, lower, upper: nrows * ncols - lower }
}

/**
 * How many values to look at when measuring a block's bright end.
 *
 * A whole-genome block is 4096² cells and the number wanted from it is one
 * percentile. Two full passes over 33.5 M floats is a visible freeze at the
 * moment a second file is dropped; a uniform subsample of a quarter of a
 * million answers the same question to more decimal places than the picture has.
 */
const GAIN_SAMPLE = 1 << 18

/**
 * The factor that puts the second file's bright end where the first file's is.
 *
 * Two Hi-C maps of the same genome at different sequencing depth differ, to
 * first order, by a scalar: the deeper one has more contacts everywhere. On one
 * shared scale the shallower of the two is a pale triangle in which nothing can
 * be read, and the reader learns only that it was sequenced less — which they
 * already knew.
 *
 * So the ratio of the two 99th percentiles is offered as a correction. It is the
 * same order statistic §7.1 uses to pick `vmax`, which is what makes the result
 * "both files saturate together" rather than an arbitrary stretch. It is offered
 * and not applied: the same colour meaning the same count is the stronger claim,
 * and it is the one a reader gets unless they ask otherwise.
 *
 * Returns `1` where either file has nothing positive to measure — an empty
 * triangle is not evidence about depth.
 */
export function matchGain(primary: CompareBlock, second: CompareBlock, percentile = 99): number {
  const top = brightEnd(primary.values, primary.nrows * primary.ncols, percentile)
  const other = brightEnd(second.values, second.nrows * second.ncols, percentile)
  if (!(top > 0) || !(other > 0)) return 1
  return top / other
}

/** One order statistic over the positive values, from a uniform subsample. */
function brightEnd(values: Float32Array, length: number, percentile: number): number {
  const step = Math.max(1, Math.floor(length / GAIN_SAMPLE))
  const kept = new Float32Array(Math.ceil(length / step))
  let at = 0
  for (let i = 0; i < length; i += step) {
    const value = values[i]
    if (Number.isFinite(value) && value > 0) kept[at++] = value
  }
  if (at === 0) return 0
  return percentileOf(kept.subarray(0, at), percentile)
}

/**
 * The virtual 4C profile: one row of the picture, summed.
 *
 * A 4C experiment fixes one locus — the viewpoint — and asks what it touches
 * across the rest of the genome. A contact map already contains the answer for
 * *every* viewpoint at once, and the operation that extracts one is arithmetic
 * a reader can do by eye and cannot do accurately: pick a band of rows, and read
 * off how dark each column is within it. Summing that band is a virtual 4C.
 *
 * **Computed from the block already on screen, never from a fresh read.** The
 * dense block the heatmap is drawing is the same numbers a query would return,
 * it is in memory, and it is already at the resolution the picture is at — so
 * the profile costs one pass over the rows of the anchor and no I/O at all. That
 * is also what makes it honest: the line under the anchor is a summary of the
 * pixels above it, at the same pooling, from the same score column, with the
 * same balancing. A separately-read profile could disagree with the picture it
 * is drawn over, and would, at every level but the finest.
 *
 * The consequence is worth stating plainly: this is the sum over the *visible*
 * columns of the *loaded* block. Pan the map and the profile is recomputed over
 * the new block; it is a reading of what is on screen rather than a genome-wide
 * track, which is what "virtual" is doing in the name.
 */

import type { DenseMatrix, Extent } from '../types'
import type { LaneFrame } from './lane'
import type { PixelProfile } from './tracks'

/**
 * Column sums of `matrix` over the rows in `anchor`, in block-local columns.
 *
 * `anchor` is a half-open range of **block-local row indices**, already clamped
 * by the caller — the anchor is defined by a gesture over the picture, so the
 * rows it names are the rows on screen by construction.
 *
 * Accumulated in `Float64Array` and not in the block's own `Float32Array`: a
 * column sum over a thousand rows of a deep map runs past what a float32 adds
 * without drift, and the drift shows up as a profile whose tall peaks are a few
 * per cent short — plausible, and wrong.
 *
 * `NaN` is skipped rather than propagated. A balanced matrix marks the bins the
 * balancer dropped as `NaN` (§6.4), and one such bin inside the anchor would
 * otherwise take the whole column with it — turning "this row was filtered" into
 * "this column touches nothing", which is the opposite claim.
 */
export function columnSums(matrix: DenseMatrix, anchor: Extent): Float64Array {
  const { nrows, ncols, values } = matrix
  const out = new Float64Array(ncols)
  const from = Math.max(0, Math.min(nrows, Math.trunc(anchor[0])))
  const to = Math.max(from, Math.min(nrows, Math.trunc(anchor[1])))
  for (let row = from; row < to; row++) {
    const base = row * ncols
    for (let col = 0; col < ncols; col++) {
      const value = values[base + col]
      if (!Number.isNaN(value)) out[col] += value
    }
  }
  return out
}

/**
 * The sums as a lane profile: one slot per canvas pixel across the data.
 *
 * The same shape a bigWig track arrives in, so the 4C line is drawn by
 * {@link drawTrack} rather than by a second renderer that would have to be kept
 * in step with it — the fill, the outline, the flip and the value axis all come
 * free, and the lane looks like the tracks beside it because it *is* one.
 *
 * Pixels are averaged over the columns that land in them rather than summed: at
 * a whole-chromosome view one pixel covers many columns, and summing them would
 * make the line's height depend on the zoom. A mean is the same quantity at
 * every zoom, which is what lets the value axis stay put while the reader pans.
 *
 * A pixel with no column in it — which happens when the map is zoomed in past
 * one column per pixel — carries `NaN` rather than zero, and the renderer draws
 * a gap. Interpolating would be inventing contacts.
 */
export function profileFromSums(sums: Float64Array, frame: LaneFrame): PixelProfile {
  const from = Math.floor(frame.alongFrom)
  const to = Math.ceil(frame.alongTo)
  const slots = Math.max(0, to - from)
  const mean = new Float32Array(slots)
  const low = new Float32Array(slots)
  const high = new Float32Array(slots)

  for (let slot = 0; slot < slots; slot++) {
    // The columns this pixel covers, from the same mapping the map is drawn
    // through — so a peak in the profile is under the column it came from at
    // every zoom, which is the whole claim the lane is making.
    const c0 = Math.floor(frame.toUnit(from + slot))
    const c1 = Math.ceil(frame.toUnit(from + slot + 1))
    let total = 0
    let seen = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let col = Math.max(0, c0); col < Math.min(sums.length, Math.max(c1, c0 + 1)); col++) {
      const value = sums[col]
      total += value
      seen++
      if (value < min) min = value
      if (value > max) max = value
    }
    if (seen === 0) {
      mean[slot] = Number.NaN
      low[slot] = Number.NaN
      high[slot] = Number.NaN
      continue
    }
    mean[slot] = total / seen
    low[slot] = min
    high[slot] = max
  }

  return {
    from,
    mean,
    low,
    high,
    // True only where a pixel genuinely covered more than one column; below that
    // `low`/`high` are copies of the mean and drawing them would be drawing the
    // line three times.
    envelope: slots > 0 && sums.length > slots,
    extent: extentOf(mean),
  }
}

/**
 * The range the line occupies, for the lane's value axis.
 *
 * From zero rather than from the smallest value: a contact profile is a count of
 * something, zero means "nothing here", and a floor at the minimum would draw
 * the emptiest column in view as though it sat on the axis. The same convention
 * every coverage track in this application uses.
 */
function extentOf(mean: Float32Array): { min: number; max: number } {
  let max = 0
  for (const value of mean) {
    if (!Number.isNaN(value) && value > max) max = value
  }
  // A degenerate axis draws every value on one line; one is a readable ceiling
  // for an all-zero window and says "nothing here" rather than dividing by zero.
  return { min: 0, max: max > 0 ? max : 1 }
}

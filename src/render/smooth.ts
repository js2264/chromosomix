/**
 * Despeckling: each cell replaced by the mean of its neighbours.
 *
 * A contact map at a fine bin size is counting Poisson noise as much as it is
 * counting contacts. At 5 kb on a bacterial genome about a tenth of the cells
 * are empty and most of the rest hold single digits, so a *ratio* of two such
 * maps is dominated by the arithmetic of small integers: `3 / 1` is a threefold
 * enrichment and `1 / 0` is an infinite one, and neither is a finding. The
 * picture that results is a haze of saturated single pixels with the structure
 * somewhere underneath it.
 *
 * The fix is the oldest one there is — average over a neighbourhood — and the
 * form here is the one Hi-C figures are usually made with, `terra::focal` in R
 * over a `(2r+1)²` window of uniform weights with **the centre weight set to
 * zero**:
 *
 * ```r
 * gauss <- matrix(1 / ((focal.size * 2 + 1)^2 - 1), ncol = ..., nrow = ...)
 * gauss[focal.size + 1, focal.size + 1] <- 0
 * terra::focal(x = r, w = gauss, fun = sum, na.rm = TRUE)
 * ```
 *
 * Leaving the centre out is what makes it a *despeckle* rather than a blur. A
 * cell that disagrees with all eight of its neighbours is evidence about the
 * neighbourhood and not about itself, and a filter that kept a ninth of its own
 * value would carry a single wild pixel into the result at a ninth strength
 * instead of removing it. The cost is that genuine single-cell features — a
 * loop at one bin pair — are removed too, which is why this is a toggle and not
 * a default.
 *
 * **Where it sits matters more than the kernel does.** This is applied per file,
 * before two files are combined (`render/derive.ts`, `ui/MatrixPanel.ts`), so a
 * ratio is `smooth(A) / smooth(B)` and never `smooth(A / B)`. The two are not
 * variations on one idea. Smoothing the ratio has to average `Infinity` and `0`
 * — the answers `x / 0` and `0 / x` give — and one infinite cell poisons every
 * window it falls in; smoothing the inputs makes those cells finite *before* the
 * division, because a zero cell with contacts around it is no longer zero. The
 * speckle does not get blurred, it stops being produced.
 *
 * Two deliberate departures from the R above, both about edges:
 *
 * 1. **The divisor is the number of cells that contributed**, not the fixed
 *    `(2r+1)² - 1`. `terra::focal` pads with `NA` and `na.rm = TRUE` drops them
 *    from the sum while the weights stay put, so a cell on the boundary is
 *    divided by a count of neighbours it did not have and comes out low. In a
 *    figure that is a dark frame a reader crops off. Here the boundary is the
 *    *viewport*, so it would be a dark frame that moved when the map was panned.
 *
 * 2. **A cell with no value keeps none.** `NaN` is what an unbalanced bin leaves
 *    behind (§6.4) and what `0 / 0` produces, and both mean "there is nothing to
 *    report here". `na.rm = TRUE` would fill those from the neighbours, painting
 *    a measurement over the one place the map is saying it has none.
 */

/**
 * The part of a block this module needs: shape and values.
 *
 * Structurally `render/derive.ts`'s `BlockValues`, and declared here rather than
 * imported from it for one reason: `deriveBlock` calls into this file, so an
 * import the other way would put a cycle in the module graph to carry a type
 * that is erased at compile time. The same reason `derive.ts` declares its own
 * `AxisRun` instead of importing the wire format's.
 */
interface Cells {
  nrows: number
  ncols: number
  values: Float32Array
}

/**
 * The radii offered, as `(2r+1) × (2r+1)` windows. `0` is off.
 *
 * Stopping at 3 is not a technical limit — the filter is O(1) per cell in the
 * radius — but a statement about what the operation is for. A 7 × 7 window
 * already averages 48 cells, which at a fine bin size is most of a
 * near-diagonal feature; anything wider is asking for a coarser bin size, and
 * that is a better way to get one because it also reads less.
 */
export const SMOOTH_RADII: readonly number[] = [0, 1, 2, 3]

/** `3 × 3` for radius 1 — the window, which is what a reader is choosing. */
export function smoothLabel(radius: number): string {
  return `${radius * 2 + 1} × ${radius * 2 + 1}`
}

/**
 * Replace every cell by the mean of the cells around it, excluding itself.
 *
 * Returns the block's own array untouched at radius `0`, which is the path
 * every reader who has not asked for this takes.
 *
 * Separable and incremental, so the cost is independent of the radius: a column
 * of running sums is carried down the block, one row entering and one leaving
 * per step, and a window slides along it across each row. The alternative —
 * `(2r+1)²` reads per cell — is 49 passes over a 16 M-cell block at radius 3,
 * which is a visible freeze on a toggle that is supposed to feel like a colour
 * change. Extra memory is two arrays the width of the block rather than two
 * copies of it, which matters at the 4096² cap where a copy is 67 MB.
 *
 * Sums are `Float64` where the values are `Float32`. A running window adds and
 * subtracts the same cell thousands of times over a wide block, and single
 * precision drifts visibly under that; double precision does not, and the
 * intermediates are two rows rather than two blocks so it costs nothing worth
 * counting.
 */
export function smoothValues(block: Cells, radius: number): Float32Array {
  const { nrows, ncols, values } = block
  if (!(radius >= 1) || nrows === 0 || ncols === 0) return values

  const span = Math.floor(radius)
  const out = new Float32Array(nrows * ncols)
  // What is in the vertical window, per column: the sum of the finite values and
  // how many there were. Both are needed — the count is the divisor, and it is
  // not `2 * span + 1` at the top and bottom edges or anywhere a bin was
  // discarded by the balancer.
  const colSum = new Float64Array(ncols)
  const colCount = new Int32Array(ncols)

  const shiftRow = (row: number, sign: 1 | -1): void => {
    if (row < 0 || row >= nrows) return
    const base = row * ncols
    for (let c = 0; c < ncols; c++) {
      const v = values[base + c]
      // Non-finite and not only `NaN`: an `Infinity` added here could never be
      // subtracted back out, and the running sum would be `NaN` for every
      // remaining row of the block.
      if (!Number.isFinite(v)) continue
      colSum[c] += sign * v
      colCount[c] += sign
    }
  }

  for (let r = 0; r <= span && r < nrows; r++) shiftRow(r, 1)

  for (let i = 0; i < nrows; i++) {
    if (i > 0) {
      shiftRow(i - span - 1, -1)
      shiftRow(i + span, 1)
    }

    let sum = 0
    let count = 0
    for (let c = 0; c <= span && c < ncols; c++) {
      sum += colSum[c]
      count += colCount[c]
    }

    const base = i * ncols
    for (let c = 0; c < ncols; c++) {
      if (c > 0) {
        const gone = c - span - 1
        if (gone >= 0) {
          sum -= colSum[gone]
          count -= colCount[gone]
        }
        const come = c + span
        if (come < ncols) {
          sum += colSum[come]
          count += colCount[come]
        }
      }

      const centre = values[base + c]
      if (Number.isNaN(centre)) {
        // Nothing to report here, and a neighbourhood mean is not a report.
        out[base + c] = Number.NaN
        continue
      }
      // The centre is taken back out of its own window. It is in `sum` and in
      // `count` only if it was finite — an infinite cell never entered either,
      // so it is despeckled by the neighbours around it rather than left to be
      // the one thing the filter could not touch.
      const finite = Number.isFinite(centre)
      const n = finite ? count - 1 : count
      out[base + c] = n > 0 ? (sum - (finite ? centre : 0)) / n : centre
    }
  }

  return out
}

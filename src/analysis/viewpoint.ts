/**
 * The genome-wide 4C accumulator: every contact an anchor makes, by where it
 * lands.
 *
 * A kernel rather than a loop inside the runner, and the reason is that it has
 * exactly one subtle rule in it and a loop inside a runner cannot be tested
 * against that rule without a mounted file.
 *
 * The rule: a stored pixel `(i, j)` with `i ≤ j` is one cell of a symmetric
 * matrix, so it is owed to **both** columns when both ends are in the anchor —
 * the profile at `i` gets it from row `j`, and the profile at `j` gets it from
 * row `i` — and to **one** column when only one end is. The diagonal is its own
 * mirror and is owed it once. Adding it twice puts a spike on the anchor itself,
 * which is exactly where a reader looks for the self-contact peak and is exactly
 * where they would not question one.
 *
 * {@link bandSums} gets the same answer from a dense square
 * by walking a mirrored block, and the cis path uses that function directly so
 * the two cannot drift. This is the sparse counterpart, for the case where there
 * is no dense square — a whole metagenome — and the test beside it checks the
 * two against each other.
 */

import type { DenseMatrix, Extent } from '../types'

/** A half-open run of absolute bins. */
export interface Band {
  from: number
  to: number
}

export class ViewpointAccumulator {
  private readonly sums: Float64Array
  private readonly seen: Uint8Array

  constructor(
    private readonly nBins: number,
    private readonly band: Band,
  ) {
    this.sums = new Float64Array(nBins)
    this.seen = new Uint8Array(nBins)
  }

  /**
   * Whether a pixel can still reach the anchor, given the file's ordering.
   *
   * Pixels are ordered by `bin1` and stored with `bin1 ≤ bin2`, so a pixel whose
   * `bin1` is past the end of the anchor has *both* ends past it. Nothing after
   * that point in the file can contribute, which is what lets the scan stop at
   * the anchor rather than at the end of the file — on average half the read.
   */
  reachable(bin1: number): boolean {
    return bin1 < this.band.to
  }

  add(bin1: number, bin2: number, value: number): void {
    if (!Number.isFinite(value)) return
    if (bin1 < 0 || bin2 < 0 || bin1 >= this.nBins || bin2 >= this.nBins) return
    const inFirst = bin1 >= this.band.from && bin1 < this.band.to
    const inSecond = bin2 >= this.band.from && bin2 < this.band.to
    if (inFirst) {
      this.sums[bin2] += value
      this.seen[bin2] = 1
    }
    if (inSecond && bin1 !== bin2) {
      this.sums[bin1] += value
      this.seen[bin1] = 1
    }
  }

  /**
   * The profile, over every bin.
   *
   * A bin with nothing is a measured **zero** and not a gap, for the reason
   * `analysis/coverage.ts` sets out at length: a cooler stores only its
   * non-zeros, so an absent pixel is a zero the file asserts. The one genuine
   * gap is a bin the balancer dropped, which `covered` is how the caller says.
   */
  finish(covered: ((bin: number) => boolean) | null = null): Float32Array {
    const out = new Float32Array(this.nBins)
    for (let bin = 0; bin < this.nBins; bin++) {
      if (covered !== null && !covered(bin)) {
        out[bin] = Number.NaN
        continue
      }
      out[bin] = this.seen[bin] === 1 ? this.sums[bin] : 0
    }
    return out
  }
}

/**
 * The band sums of `matrix`: one number per position along `along`, summed over
 * the anchor's band on the other axis.
 *
 * `along: 'cols'` is the reading a strip above or below the map makes — a band
 * of **rows** collapsed to one value per column — and `along: 'rows'` is its
 * transpose, which is what a strip down either *side* of the map is a picture
 * of. Neither is more fundamental than the other: a contact map read about its
 * diagonal says the same thing both ways round, and which one a lane wants is
 * decided entirely by which axis it is drawn along. One function rather than
 * two because a second copy of a nested loop over a dense block is a second
 * place for the `NaN` rule below to be forgotten.
 *
 * `anchor` is a half-open range of **block-local indices** on the *other* axis,
 * already clamped by the caller — the anchor is defined by a gesture over the
 * picture, so the rows it names are the rows on screen by construction.
 *
 * Accumulated in `Float64Array` and not in the block's own `Float32Array`: a
 * sum over a thousand rows of a deep map runs past what a float32 adds without
 * drift, and the drift shows up as a profile whose tall peaks are a few per
 * cent short — plausible, and wrong.
 *
 * `NaN` is skipped rather than propagated. A balanced matrix marks the bins the
 * balancer dropped as `NaN` (§6.4), and one such bin inside the anchor would
 * otherwise take the whole column with it — turning "this row was filtered" into
 * "this column touches nothing", which is the opposite claim.
 */
export function bandSums(
  matrix: DenseMatrix,
  anchor: Extent,
  along: 'cols' | 'rows' = 'cols',
): Float64Array {
  const { nrows, ncols, values } = matrix
  // The axis the band is *taken over* is the one the profile is not along.
  const depth = along === 'cols' ? nrows : ncols
  const width = along === 'cols' ? ncols : nrows
  const out = new Float64Array(width)
  const from = Math.max(0, Math.min(depth, Math.trunc(anchor[0])))
  const to = Math.max(from, Math.min(depth, Math.trunc(anchor[1])))
  for (let band = from; band < to; band++) {
    for (let at = 0; at < width; at++) {
      const value = along === 'cols' ? values[band * ncols + at] : values[at * ncols + band]
      if (!Number.isNaN(value)) out[at] += value
    }
  }
  return out
}

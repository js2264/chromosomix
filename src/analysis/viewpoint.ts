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
 * `bandSums` in `render/viewpoint.ts` gets the same answer from a dense square
 * by walking a mirrored block, and the cis path uses that function directly so
 * the two cannot drift. This is the sparse counterpart, for the case where there
 * is no dense square — a whole metagenome — and the test beside it checks the
 * two against each other.
 */

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

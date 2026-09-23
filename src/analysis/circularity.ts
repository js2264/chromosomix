/**
 * Whether a sequence joins its own ends, read off its contacts.
 *
 * §8.15 argued that nobody can infer it from the data, and the argument was
 * about the wrong test. A **bright far corner** is not evidence — a
 * translocation, an assembly error and arms zipped end to end all make one. The
 * test that separates them is the shape of the corner at its very tip: on a
 * circle the last bin and the first are **neighbours**, so the cells joining
 * them hold what the diagonal holds at the same separation — a few bins apart,
 * the most contacts there are. Anything else that brightens a corner brightens
 * it by a factor, not to the level of the diagonal itself.
 *
 * So the score is the contacts across the junction at a circular separation of
 * `s` bins, over the contacts along the diagonal at the same `s`, measured at the
 * two ends the junction joins, for `s = 1 … k` — and its median, so one noisy
 * cell does not decide. About one on a circle (0.65 on the *Pseudomonas
 * aeruginosa* PAK chromosome, 1.1 on a *Borrelia* circular plasmid), about zero
 * on a line (under 0.03 on the linear chromosomes of *Borrelia burgdorferi* and
 * *Streptomyces coelicolor*, whose telomeres are known to meet).
 *
 * Pure: three small blocks in, one number out.
 */

/** Separations, in bins, the junction is compared at. */
export const JUNCTION_BINS = 3

/**
 * The fewest bins a sequence needs for the test to mean anything.
 *
 * The diagonal it is compared with is measured on `2k` bins at each end, and a
 * sequence shorter than four times that is mostly its ends: a small plasmid at a
 * coarse resolution is two or three bins, and every bin of it is next to every
 * other whether it is a circle or not.
 */
export const MIN_JUNCTION_SEQUENCE_BINS = 4 * JUNCTION_BINS

/** At or above this the sequence is read as circular. */
export const CIRCULAR_SCORE = 0.2

/** A dense block of the sequence, in its own bins, 0-based. */
export interface JunctionBlock {
  rows: [number, number]
  cols: [number, number]
  values: ArrayLike<number>
}

/**
 * The junction score, from the three blocks the test needs.
 *
 * - `head`: rows and columns `[0, 2k)` — the diagonal at the start;
 * - `tail`: rows and columns `[n − 2k, n)` — the diagonal at the end;
 * - `corner`: rows `[0, k)` against columns `[n − k, n)` — the cells joining them,
 *   whose circular separation is `row + n − col`.
 *
 * `NaN` where either side has nothing at a separation — a balancer-dropped end,
 * a sequence too short — which the caller reads as *undecided*, never as linear.
 */
export function junctionScore(
  n: number,
  head: JunctionBlock,
  tail: JunctionBlock,
  corner: JunctionBlock,
  k = JUNCTION_BINS,
): { score: number; ratios: number[] } {
  const diagonalSum = new Float64Array(k + 1)
  const diagonalCount = new Float64Array(k + 1)
  for (const block of [head, tail]) {
    const width = block.cols[1] - block.cols[0]
    for (let r = block.rows[0]; r < block.rows[1]; r++) {
      for (let c = block.cols[0]; c < block.cols[1]; c++) {
        const s = c - r
        if (s < 1 || s > k) continue
        const value = block.values[(r - block.rows[0]) * width + (c - block.cols[0])]
        if (!Number.isFinite(value)) continue
        diagonalSum[s] += value
        diagonalCount[s] += 1
      }
    }
  }
  const junctionSum = new Float64Array(k + 1)
  const junctionCount = new Float64Array(k + 1)
  const width = corner.cols[1] - corner.cols[0]
  for (let r = corner.rows[0]; r < corner.rows[1]; r++) {
    for (let c = corner.cols[0]; c < corner.cols[1]; c++) {
      const s = r + n - c
      if (s < 1 || s > k) continue
      const value = corner.values[(r - corner.rows[0]) * width + (c - corner.cols[0])]
      if (!Number.isFinite(value)) continue
      junctionSum[s] += value
      junctionCount[s] += 1
    }
  }
  const ratios: number[] = []
  for (let s = 1; s <= k; s++) {
    if (diagonalCount[s] === 0 || junctionCount[s] === 0) continue
    const diagonal = diagonalSum[s] / diagonalCount[s]
    if (!(diagonal > 0)) continue
    ratios.push(junctionSum[s] / junctionCount[s] / diagonal)
  }
  if (ratios.length === 0) return { score: Number.NaN, ratios }
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const score = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { score, ratios }
}

/**
 * The four orientation-resolved decay curves, turned into a figure.
 *
 * Counted in `pairs/bin.ts` during the import's own pass, at a resolution far
 * finer than anything worth drawing (§3.7). This module is the other half: it
 * re-bins them onto a readable axis, normalises each to a density so the four
 * are comparable, and finds the separation at which they stop disagreeing —
 * which is the number the whole measurement is for.
 *
 * ## Why the convergence point is worth computing rather than eyeballing
 *
 * It is the answer to *how short a contact can I believe*, and every pairs-level
 * QC in the field is read for it. Below it the counts are dominated by
 * self-circles, dangling ends and undigested fragments, each of which lands in
 * one orientation and not the others; above it the four are the same
 * measurement. A reader can see roughly where that happens on the plot. Putting
 * a number under it makes it citable, and makes two libraries comparable without
 * laying their figures side by side.
 *
 * It is deliberately **reported and not acted on**. Nothing here trims a file,
 * sets a minimum separation, or warns that a map was binned below it — that
 * would be a method with choices in it, and §18.9's argument about a half-good
 * caller applies to a threshold exactly as it applies to a loop.
 */

/** Raw counts as the import accumulated them. */
export interface OrientationCounts {
  edges: Float64Array
  counts: readonly [Float64Array, Float64Array, Float64Array, Float64Array]
  total: number
}

/** One orientation's curve, re-binned and normalised. */
export interface OrientationCurve {
  name: string
  /** Bin centres, in base pairs. */
  x: Float64Array
  /** Contacts per base pair of separation, over the records in all four. */
  y: Float64Array
  /** Records behind the line. */
  n: number
}

export interface OrientationFigure {
  curves: OrientationCurve[]
  /**
   * The shortest separation above which the four agree, or `null`.
   *
   * `null` where no such separation exists inside the data — a library with a
   * genuinely broken short range, or one whose curves never settle — which is a
   * true answer rather than a missing one, and is reported as such.
   */
  convergence: number | null
  /** How much the four disagree at the convergence point, for the caption. */
  spreadAt: number
}

/** The order and the names the four are reported in. */
const NAMES = ['++', '+−', '−+', '−−'] as const

/**
 * Re-bin the import's fine histogram onto `factor`-spaced bins and normalise.
 *
 * Normalised by **one shared denominator** — the records in all four — and not
 * by each orientation's own total, which was the first thing tried and is
 * exactly wrong. The four orientations of a Hi-C library are equally likely at
 * long range, because ligation does not know which way a fragment was pointing;
 * what is *not* equal is the short-range excess the artefacts add to two of
 * them. Scaling each curve by its own total divides that excess back out again:
 * an inward curve carrying fifty times the records comes out a fiftieth lower
 * everywhere else, the four never coincide, and the convergence point —
 * the only thing this figure is for — disappears. One denominator leaves the
 * four lying on top of each other wherever they hold the same number of records,
 * which is the plot `pairtools` and `distiller` draw and the one the number
 * below is read off.
 */
export function orientationFigure(
  source: OrientationCounts,
  options: { factor?: number; minSeparation?: number } = {},
): OrientationFigure | null {
  const factor = Math.max(1.01, options.factor ?? 1.1)
  const minSeparation = Math.max(0, options.minSeparation ?? 0)
  const fineEdges = source.edges
  if (fineEdges.length < 3) return null

  const longest = fineEdges[fineEdges.length - 1]
  const from = Math.max(1, minSeparation)
  if (!(longest > from)) return null

  // The coarse axis, built the same way the fine one was so that every coarse
  // edge falls on a fine edge and no fine bin is split between two coarse ones.
  const coarse: number[] = [from]
  let at = from
  while (at < longest) {
    at = Math.max(at + 1, Math.round(at * factor))
    coarse.push(at)
  }
  if (coarse.length < 3) return null

  const bins = coarse.length - 1
  const sums: Float64Array[] = [
    new Float64Array(bins),
    new Float64Array(bins),
    new Float64Array(bins),
    new Float64Array(bins),
  ]
  const totals = [0, 0, 0, 0]

  for (let fine = 0; fine < fineEdges.length - 1; fine++) {
    // The fine bin's own **lower edge** decides which coarse bin it lands in.
    // Its midpoint would be wrong at the bottom of the axis, where a fine bin
    // spans a whole coarse one and its midpoint is in the next.
    const lo = fineEdges[fine]
    if (lo < from) continue
    let target = bisect(coarse, lo)
    if (target < 0) continue
    if (target >= bins) target = bins - 1
    for (let which = 0; which < 4; which++) {
      const value = source.counts[which][fine]
      if (value === 0) continue
      sums[which][target] += value
      totals[which] += value
    }
  }

  const shared = totals[0] + totals[1] + totals[2] + totals[3]
  if (shared === 0) return null

  const curves: OrientationCurve[] = []
  for (let which = 0; which < 4; which++) {
    if (totals[which] === 0) continue
    const x = new Float64Array(bins)
    const y = new Float64Array(bins)
    for (let bin = 0; bin < bins; bin++) {
      // The **geometric** centre, because the axis is logarithmic and the
      // arithmetic midpoint of a log bin sits visibly right of the middle of it.
      x[bin] = Math.sqrt(coarse[bin] * coarse[bin + 1])
      const width = coarse[bin + 1] - coarse[bin]
      y[bin] = width > 0 ? sums[which][bin] / (shared * width) : Number.NaN
      if (sums[which][bin] === 0) y[bin] = Number.NaN
    }
    curves.push({ name: NAMES[which], x, y, n: totals[which] })
  }
  if (curves.length < 2) return null

  const found = convergenceOf(curves)
  return { curves, convergence: found.at, spreadAt: found.spread }
}

/**
 * The shortest separation from which the curves stay within a tenth of each
 * other, walking down from the long end.
 *
 * **Down rather than up**, and that is the whole of the method. Walking up finds
 * the first bin that happens to agree, which on a noisy short range is a
 * coincidence between two of four lines; walking down from where they are known
 * to agree and stopping at the last bin that still does finds the place they
 * *start* agreeing, which is what the number means. A single noisy bin at the
 * long end therefore cannot end the search early, because the search has already
 * passed it.
 *
 * A tenth in log space is the tolerance, which is what the eye reads as "on top
 * of each other" on a decade-wide axis, and it is stated here rather than tuned:
 * this is a reported diagnostic and not a threshold anything acts on.
 */
function convergenceOf(curves: readonly OrientationCurve[]): { at: number | null; spread: number } {
  const n = curves[0].x.length
  let at: number | null = null
  let spread = Number.NaN
  for (let bin = n - 1; bin >= 0; bin--) {
    let lo = Number.POSITIVE_INFINITY
    let hi = 0
    let seen = 0
    for (const curve of curves) {
      const value = curve.y[bin]
      if (!Number.isFinite(value) || value <= 0) continue
      seen++
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
    // Every curve, or the bin says nothing about whether they agree: three lines
    // agreeing where the fourth has no data is not four lines agreeing.
    if (seen < curves.length) {
      if (at !== null) break
      continue
    }
    const disagreement = Math.log10(hi / lo)
    if (disagreement > 0.1) break
    at = curves[0].x[bin]
    spread = disagreement
  }
  return { at, spread }
}

/** The index of the bin `value` falls in, or `-1` below the first edge. */
function bisect(edges: readonly number[], value: number): number {
  if (value < edges[0]) return -1
  let lo = 0
  let hi = edges.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (edges[mid] <= value) lo = mid
    else hi = mid
  }
  return lo
}

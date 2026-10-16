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
  /** Point centres, in base pairs: a bin's geometric centre, or a pooled run's. */
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
 * The records a drawn point stands on before it is drawn on its own.
 *
 * Sixteen is a counting error of a quarter, which is a tenth of a decade — the
 * tolerance the convergence below is read at, so no point is noisier than the
 * question the figure asks of it. A bin holding fewer is pooled with the sparse
 * bins beside it (see {@link drawnCurve}); one holding more is never touched.
 */
export const MIN_RECORDS = 16

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
 *
 * **Every drawn edge is a counted edge.** The drawing axis used to be built on
 * its own — `factor` steps from the first separation, rounded — with each fine
 * bin filed under whichever drawn bin its lower edge fell in, and each drawn bin
 * divided by its own nominal width. At the default 1.1 over the import's 1.05
 * that is 1.95 fine bins to a drawn one: most drawn bins held two, and every
 * twenty-second held one and was still divided by the width of two. All four
 * curves fell by exactly half there, together, every 0.9 of a decade — at 200
 * bp, 1.6 kb, 12 kb, 98 kb and 730 kb on a *Lachancea* library — which read as
 * a notch in the data. Grouping whole fine bins ({@link drawnEdges}) and
 * dividing by the width they actually cover is the same correction
 * `densityCurve` makes for a matrix's lattice (§18.8).
 */
export function orientationFigure(
  source: OrientationCounts,
  options: { factor?: number } = {},
): OrientationFigure | null {
  const factor = Math.max(1.01, options.factor ?? 1.1)
  const fineEdges = source.edges
  if (fineEdges.length < 3) return null

  const cuts = drawnEdges(fineEdges, 1, factor)
  if (cuts === null || cuts.length < 3) return null
  const edges = cuts.map((at) => fineEdges[at])
  const bins = cuts.length - 1

  const sums: Float64Array[] = [
    new Float64Array(bins),
    new Float64Array(bins),
    new Float64Array(bins),
    new Float64Array(bins),
  ]
  const totals = [0, 0, 0, 0]
  for (let bin = 0; bin < bins; bin++) {
    for (let fine = cuts[bin]; fine < cuts[bin + 1]; fine++) {
      for (let which = 0; which < 4; which++) {
        const value = source.counts[which][fine]
        if (!(value > 0)) continue
        sums[which][bin] += value
        totals[which] += value
      }
    }
  }

  const shared = totals[0] + totals[1] + totals[2] + totals[3]
  if (shared === 0) return null

  // Two readings of the same sums. The **axis** keeps every bin, an empty one as
  // `NaN`, because the convergence compares the four bin by bin and has to know
  // where one of them has nothing; the **drawn** curves are what the figure
  // shows, with no bin left empty and no point on a handful of records.
  const axis: OrientationCurve[] = []
  const curves: OrientationCurve[] = []
  for (let which = 0; which < 4; which++) {
    if (totals[which] === 0) continue
    const x = new Float64Array(bins)
    const y = new Float64Array(bins)
    for (let bin = 0; bin < bins; bin++) {
      // The **geometric** centre, because the axis is logarithmic and the
      // arithmetic midpoint of a log bin sits visibly right of the middle of it.
      x[bin] = Math.sqrt(edges[bin] * edges[bin + 1])
      y[bin] =
        sums[which][bin] > 0 ? sums[which][bin] / (shared * (edges[bin + 1] - edges[bin])) : Number.NaN
    }
    axis.push({ name: NAMES[which], x, y, n: totals[which] })
    curves.push({ name: NAMES[which], ...drawnCurve(sums[which], edges, shared), n: totals[which] })
  }
  if (curves.length < 2) return null

  const found = convergenceOf(axis)
  return { curves, convergence: found.at, spreadAt: found.spread }
}

/**
 * The drawing axis, as indices into the fine one: every edge drawn **is** an
 * edge the records were counted on, so no fine bin is split or left out.
 *
 * Each step goes to the fine edge nearest `factor` times the last, on a log
 * scale — at least one fine bin, so a factor below the import's own 1.05 draws
 * at the resolution that was counted rather than at one that was not. `null`
 * where nothing lies past `from`.
 */
function drawnEdges(fine: Float64Array, from: number, factor: number): number[] | null {
  const last = fine.length - 1
  let at = 0
  while (at < last && fine[at] < from) at++
  if (at >= last) return null
  const cuts = [at]
  while (at < last) {
    const target = fine[at] * factor
    let next = at + 1
    while (
      next < last &&
      Math.abs(Math.log(fine[next + 1] / target)) < Math.abs(Math.log(fine[next] / target))
    ) {
      next++
    }
    cuts.push(next)
    at = next
  }
  return cuts
}

/**
 * One orientation as drawn: a bin on its own where it holds {@link MIN_RECORDS},
 * and runs of sparser bins pooled.
 *
 * **No bin is drawn empty, and none is drawn from a handful of records.** A bin
 * with no record has no density on a log axis, and was drawn as a gap: at short
 * range, where a filtered library holds one record every few base pairs, the
 * curves came apart into fragments. Dropping the empty bins alone joins the
 * fragments with lines through single records — a density read off one count,
 * divided by a width that ignores the empty bins either side of it — which is a
 * zigzag of noise at the separations the figure is read at.
 *
 * So a run of sparse bins is pooled into points of at least {@link MIN_RECORDS},
 * each divided by the whole width it spans, empty bins included: the average
 * density over that stretch, which is what the records in it can say. A run
 * holding fewer in all is one point. A bin that holds enough on its own is never
 * widened, so a real spike — `−−` at 36 bp in the same *Lachancea* library,
 * seven hundred records beside two hundred — stays a spike rather than being
 * averaged into the sparse bins before it.
 *
 * The line starts at the first record and ends at the last: empty bins before
 * and after are not a density of zero anybody measured.
 */
function drawnCurve(
  sums: Float64Array,
  edges: readonly number[],
  shared: number,
): { x: Float64Array; y: Float64Array } {
  let first = 0
  let last = sums.length - 1
  while (first <= last && !(sums[first] > 0)) first++
  while (last >= first && !(sums[last] > 0)) last--

  const x: number[] = []
  const y: number[] = []
  /** One point over bins `lo` to `hi`, inclusive, holding `records`. */
  const point = (lo: number, hi: number, records: number): void => {
    const from = edges[lo]
    const to = edges[hi + 1]
    x.push(Math.sqrt(from * to))
    y.push(records / (shared * (to - from)))
  }

  let bin = first
  while (bin <= last) {
    if (sums[bin] >= MIN_RECORDS) {
      point(bin, bin, sums[bin])
      bin++
      continue
    }
    // The run of sparse bins starting here, up to the next that stands alone.
    let end = bin
    while (end < last && sums[end + 1] < MIN_RECORDS) end++
    const pooled: Array<[number, number, number]> = []
    let start = bin
    let records = 0
    for (let at = bin; at <= end; at++) {
      records += sums[at]
      if (records < MIN_RECORDS) continue
      pooled.push([start, at, records])
      start = at + 1
      records = 0
    }
    // What is left over joins the last point of the run, or is the run's one
    // point where it never reached the threshold.
    if (start <= end) {
      const tail = pooled[pooled.length - 1]
      if (tail !== undefined) {
        tail[1] = end
        tail[2] += records
      } else if (records > 0) {
        pooled.push([start, end, records])
      }
    }
    for (const [lo, hi, held] of pooled) point(lo, hi, held)
    bin = end + 1
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y) }
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

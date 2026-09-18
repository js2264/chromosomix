/**
 * The loop spectrum: a called set's score against how far apart its anchors are.
 *
 * The plot a loop caller owes its reader, and the one thing neither of the two
 * figures beside it can show. A **pileup** is an average over windows at every
 * separation the scan covered, so a set whose 30 kb calls are loops and whose
 * 2 Mb calls are noise averages into one plausible dot. A **score histogram**
 * counts scores with no regard to where they came from, so the same set is a
 * clean unimodal peak. Both are true and neither is the question.
 *
 * Against distance, the two commonest ways a loop set is wrong are visible at a
 * glance and invisible anywhere else in the run:
 *
 * - **scores that fall away with separation** are a detector reporting the
 *   distance decay it failed to remove — the near calls score well because
 *   everything near the diagonal scores well;
 * - **scores piled against the minimum-distance cutoff** are calls made on the
 *   diagonal's own shoulder, which is where a template that looks like a blob
 *   finds a blob in every map ever sequenced.
 *
 * ## A cloud and a line through it
 *
 * The two halves answer different questions and neither substitutes for the
 * other. The **points** are where the calls actually are, spread included —
 * which is the part a summary hides, and the part that says whether *the score
 * falls with distance* is a trend or four outliers. The **line** is the median
 * in log-spaced bands, which is the trend itself: bands rather than a fit,
 * because nothing here claims the relationship has a shape, and a median rather
 * than a mean because a tail in the score distribution is precisely what this is
 * looking for.
 *
 * Log-spaced, and on a log axis, for the reason every distance plot in this
 * application is: contact falls off with separation as a power law, and a linear
 * axis spends nine tenths of its width on the decade nobody is reading.
 */

import type { CurveOutput } from './types'

/** One call: how far apart its two anchors are, and what it scored. */
export interface ScoredSeparation {
  /** Between the anchors, in base pairs. */
  separation: number
  score: number
}

export interface LoopSpectrumOptions {
  id: string
  label: string
  /** What the points are called in the legend: `calls`, `anchors`. */
  noun: string
  yLabel: string
  /** The most points drawn before the cloud is thinned; see {@link SPECTRUM_POINTS}. */
  cap?: number
}

/**
 * How many calls the cloud draws before it is thinned.
 *
 * Two thousand marks is already a solid band at any figure width, and a detector
 * on a mammalian map returns tens of thousands — which is a plot that takes a
 * second to draw, exports a megabyte of vector paths, and shows exactly what two
 * thousand of them show.
 */
export const SPECTRUM_POINTS = 2_000

/**
 * The spectrum, or `null` where there is nothing to draw.
 *
 * Nothing to draw is a run with fewer than two scored calls, and one whose
 * anchors all landed in a single bin — a diagonal pattern, or a map too coarse
 * for the separations in the set. Refused rather than drawn empty, because a
 * scatter with one mark in it is a figure that invites a reading it cannot
 * support.
 */
export function loopSpectrum(
  calls: readonly ScoredSeparation[],
  options: LoopSpectrumOptions,
): CurveOutput | null {
  const points = calls
    .filter((call) => call.separation > 0 && Number.isFinite(call.score))
    .map((call) => ({ separation: call.separation, score: call.score }))
    .sort((a, b) => a.separation - b.separation)
  if (points.length < 2) return null

  // **Thinned rather than truncated** past the cap, and thinned by *rank in
  // separation*, which is what keeps it the same picture: taking the first two
  // thousand would be a plot of the shortest-range calls under a caption saying
  // how many there were, and the shortest-range calls are the ones whose scores
  // are least like the rest.
  const step = Math.ceil(points.length / (options.cap ?? SPECTRUM_POINTS))
  const shown = step <= 1 ? points : points.filter((_, at) => at % step === 0)

  const trend = medianBands(points)

  return {
    kind: 'curve',
    id: options.id,
    label: options.label,
    series: [
      {
        name: `${points.length.toLocaleString()} ${options.noun}`,
        x: Float64Array.from(shown, (point) => point.separation),
        y: Float64Array.from(shown, (point) => point.score),
        n: points.length,
        // Points: two calls at neighbouring separations are two independent
        // measurements, and a line joining them would draw a path nothing
        // travelled — `CurveSeries.mark`'s own argument.
        mark: 'points',
      },
      { name: 'median', x: trend.x, y: trend.y, n: points.length },
    ],
    xLabel: 'Separation between anchors (bp)',
    yLabel: options.yLabel,
    xScale: 'log',
    yScale: 'linear',
  }
}

/**
 * The median score in each of a handful of log-spaced separation bands.
 *
 * `sqrt(n)` bands, clamped, which is the usual rule and the right shape here:
 * enough of them that a trend over two decades has somewhere to bend, few enough
 * that each carries a median worth plotting. Empty bands are dropped rather than
 * drawn as gaps, and each point sits at its band's **own** middle separation
 * rather than at the edge it was cut at — so a point of the line is where its
 * calls are rather than where the arithmetic put a boundary.
 *
 * `points` arrives sorted by separation.
 */
function medianBands(points: ReadonlyArray<ScoredSeparation>): {
  x: Float64Array
  y: Float64Array
} {
  const lo = points[0].separation
  const hi = points[points.length - 1].separation
  const bands = Math.max(3, Math.min(24, Math.round(Math.sqrt(points.length))))
  const width = hi > lo ? Math.log(hi / lo) / bands : 0
  const scores: number[][] = Array.from({ length: bands }, () => [])
  const spans: number[][] = Array.from({ length: bands }, () => [])
  for (const point of points) {
    const at =
      width > 0 ? Math.min(bands - 1, Math.floor(Math.log(point.separation / lo) / width)) : 0
    scores[at].push(point.score)
    spans[at].push(point.separation)
  }
  const x: number[] = []
  const y: number[] = []
  for (let band = 0; band < bands; band++) {
    if (scores[band].length === 0) continue
    x.push(medianOf(spans[band]))
    y.push(medianOf(scores[band]))
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y) }
}

/** The middle value, for an array this module is free to sort. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const half = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2
}

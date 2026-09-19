/**
 * The three summaries a distribution can be drawn as.
 *
 * A histogram, a box and a violin are the same values three ways, and none of
 * them is a plot of the data: each is a *claim* about it, made by a rule with a
 * parameter. So the rules live here, apart from the drawing, where they can be
 * read and checked — a bin width chosen badly is a bimodal distribution that
 * looks unimodal, and that is not the kind of decision to leave inside a
 * renderer.
 *
 * Everything here ignores `NaN` rather than treating it as zero, which is the
 * distinction the whole app is built on: a bin that was filtered and a bin that
 * touches nothing are different facts.
 */

/** Finite values, sorted, which every summary below starts from. */
export function sorted(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
}

/**
 * The type-7 quantile — R's default, numpy's default, and the one most readers
 * will have computed if they check this against their own analysis.
 */
export function quantile(ascending: readonly number[], p: number): number {
  if (ascending.length === 0) return Number.NaN
  if (ascending.length === 1) return ascending[0]
  const at = (ascending.length - 1) * Math.min(1, Math.max(0, p))
  const below = Math.floor(at)
  const above = Math.ceil(at)
  if (below === above) return ascending[below]
  return ascending[below] + (at - below) * (ascending[above] - ascending[below])
}

export interface BoxSummary {
  /** The whisker ends: the furthest values still within 1.5 IQR of the box. */
  low: number
  q1: number
  median: number
  q3: number
  high: number
  /** Everything outside the whiskers, drawn as points. */
  outliers: number[]
}

/**
 * Tukey's box: the quartiles, and whiskers at the furthest *observed* value
 * within 1.5 interquartile ranges.
 *
 * The whiskers stop at data rather than at `q1 - 1.5·IQR` itself, which is what
 * makes them a statement about the sample: a whisker drawn to the fence would
 * reach past every value there is and say the range is wider than it was
 * measured to be.
 */
export function boxSummary(values: readonly number[]): BoxSummary {
  const ascending = sorted(values)
  if (ascending.length === 0) {
    return { low: Number.NaN, q1: Number.NaN, median: Number.NaN, q3: Number.NaN, high: Number.NaN, outliers: [] }
  }
  const q1 = quantile(ascending, 0.25)
  const median = quantile(ascending, 0.5)
  const q3 = quantile(ascending, 0.75)
  const fence = 1.5 * (q3 - q1)
  const floor = q1 - fence
  const ceiling = q3 + fence
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  const outliers: number[] = []
  for (const value of ascending) {
    if (value < floor || value > ceiling) {
      outliers.push(value)
      continue
    }
    if (value < low) low = value
    if (value > high) high = value
  }
  if (!Number.isFinite(low)) low = median
  if (!Number.isFinite(high)) high = median
  return { low, q1, median, q3, high, outliers }
}

export interface Histogram {
  /** `bins + 1` edges, evenly spaced. */
  edges: number[]
  /** One count per bin; the last bin includes its right edge. */
  counts: number[]
}

/**
 * A histogram, with the bin count chosen if it is not given.
 *
 * Freedman–Diaconis when it is not: bin width `2·IQR/n^(1/3)`, which adapts to
 * the spread of the middle half rather than to the extremes, so one outlier
 * does not flatten the whole picture into two bars. Sturges' rule — which is
 * what a naive `log2(n)+1` gives — is famously too coarse for anything with a
 * tail, and a contact-frequency distribution is nothing but tail.
 *
 * Capped, because the bins are drawn: four hundred bars on a figure six hundred
 * pixels wide is a solid block.
 */
export function histogram(values: readonly number[], bins = 0): Histogram {
  const ascending = sorted(values)
  if (ascending.length === 0) return { edges: [], counts: [] }
  const lo = ascending[0]
  const hi = ascending[ascending.length - 1]
  if (lo === hi) return { edges: [lo, lo + 1], counts: [ascending.length] }

  let count = Math.round(bins)
  if (!(count > 0)) {
    const iqr = quantile(ascending, 0.75) - quantile(ascending, 0.25)
    const width = iqr > 0 ? (2 * iqr) / Math.cbrt(ascending.length) : 0
    count = width > 0 ? Math.ceil((hi - lo) / width) : Math.ceil(Math.sqrt(ascending.length))
  }
  count = Math.max(1, Math.min(400, count))

  const step = (hi - lo) / count
  const edges: number[] = []
  for (let i = 0; i <= count; i++) edges.push(lo + i * step)
  const counts = new Array<number>(count).fill(0)
  for (const value of ascending) {
    const at = Math.floor((value - lo) / step)
    counts[at >= count ? count - 1 : at < 0 ? 0 : at] += 1
  }
  return { edges, counts }
}

/**
 * A violin's outline: a Gaussian kernel density estimate, sampled evenly.
 *
 * Silverman's rule of thumb for the bandwidth, from the smaller of the standard
 * deviation and the IQR over 1.34 — the same default R's `density()` uses, so a
 * violin here and a violin drawn from the same numbers in R are the same shape
 * rather than two opinions about it.
 *
 * Returned as density per unit, not normalised to a width: how wide the widest
 * violin is drawn is the renderer's decision, and two violins side by side have
 * to be scaled together or the comparison is a lie.
 */
export function density(values: readonly number[], points = 64): { at: number[]; y: number[] } {
  const ascending = sorted(values)
  if (ascending.length < 2) return { at: [], y: [] }
  const n = ascending.length
  const mean = ascending.reduce((sum, value) => sum + value, 0) / n
  const variance = ascending.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  const sd = Math.sqrt(Math.max(0, variance))
  const iqr = quantile(ascending, 0.75) - quantile(ascending, 0.25)
  const spread = Math.min(sd || Number.POSITIVE_INFINITY, iqr > 0 ? iqr / 1.34 : Number.POSITIVE_INFINITY)
  const bandwidth = Number.isFinite(spread) && spread > 0 ? 0.9 * spread * Math.pow(n, -0.2) : 0
  if (!(bandwidth > 0)) return { at: [], y: [] }

  // Three bandwidths past each end, which is where a Gaussian has given up.
  const lo = ascending[0] - 3 * bandwidth
  const hi = ascending[n - 1] + 3 * bandwidth
  const step = (hi - lo) / Math.max(1, points - 1)
  const at: number[] = []
  const y: number[] = []
  const scale = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI))
  for (let i = 0; i < points; i++) {
    const x = lo + i * step
    let sum = 0
    for (const value of ascending) {
      const z = (x - value) / bandwidth
      sum += Math.exp(-0.5 * z * z)
    }
    at.push(x)
    y.push(sum * scale)
  }
  return { at, y }
}

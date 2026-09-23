/**
 * Where a bacterial chromosome's replication starts and ends, read from its
 * sequence.
 *
 * Replication leaves a mark on the sequence it copies. The leading strand is
 * richer in G than in C, and the forward strand leads on one replichore and
 * lags on the other — so the GC skew changes sign at the origin and again at the
 * terminus, and the **cumulative** skew has its minimum at one and its maximum
 * at the other (Lobry 1996; Grigoriev 1998). Those two turning points are the
 * candidates. Which of them is the terminus is then decided the way Bacchus
 * decides it, in three steps, each used only where the one before it has
 * nothing to say:
 *
 * 1. **matS** — MatP's binding sites cluster in the terminus macrodomain of the
 *    enterobacteria. Where at least ten are found, the terminus is the candidate
 *    **nearer** their cluster.
 * 2. **parS** — ParB's sites cluster round the origin in most bacteria that
 *    have a ParABS system. Where any are found, the terminus is the candidate
 *    **farther** from their cluster.
 * 3. **Coverage** — in a growing culture the origin has been copied more often
 *    than the terminus, so it is seen more. The terminus is the candidate with
 *    the **lower** smoothed coverage.
 *
 * With none of the three, the skew's own sign convention decides: minimum is
 * the origin, maximum the terminus. Every call says which step decided it, and
 * whether that step agreed with the convention — a disagreement is either an
 * unusual genome or an assembly error, and a reader wants to know which call
 * they are looking at.
 *
 * The coverage is smoothed the way Bacchus smooths it, by a **cubic spline**
 * fitted to coverage binned at a few kilobases, and the **ori/ter ratio** is
 * that curve's maximum over its minimum: how many copies of the origin there
 * were for every copy of the terminus, which is a reading of how fast the
 * culture was replicating.
 *
 * Pure and in base pairs throughout: no worker, no file, no bins of a map.
 */

// ---------------------------------------------------------------------------
// Positions on a circle
// ---------------------------------------------------------------------------

/** The distance between two positions, the short way round on a circle. */
export function separation(a: number, b: number, length: number, circular: boolean): number {
  const straight = Math.abs(a - b)
  return circular && length > 0 ? Math.min(straight, length - (straight % length)) : straight
}

/**
 * The mean of positions on a circle, in base pairs; the plain mean on a line.
 *
 * On a circle an arithmetic mean is wrong exactly where it matters: two parS
 * sites either side of an origin at position 0 — one at 5 kb, one at 6.39 Mb —
 * average to the middle of the chromosome, which is the terminus. So positions
 * are angles, and the mean is the angle of their resultant.
 */
export function positionMean(positions: readonly number[], length: number, circular: boolean): number {
  if (positions.length === 0) return Number.NaN
  if (!circular || !(length > 0)) {
    let total = 0
    for (const at of positions) total += at
    return total / positions.length
  }
  let sin = 0
  let cos = 0
  for (const at of positions) {
    const angle = (2 * Math.PI * at) / length
    sin += Math.sin(angle)
    cos += Math.cos(angle)
  }
  const angle = Math.atan2(sin, cos)
  // Into `[0, length)`: a mean a hair below zero is the origin, and adding a
  // lap to it would name the far end of the sequence instead.
  const at = (((angle / (2 * Math.PI)) * length) % length + length) % length
  return at >= length ? 0 : at
}

/**
 * Where a set of sites is densest, and how many sites are there.
 *
 * A **cluster** rather than a mean over every site, because the sites a motif
 * search returns are not all real: a sixteen-base consensus allowed one
 * mismatch still turns up the odd lookalike far from the origin, and one of
 * those in a mean of four moves the "cluster" by hundreds of kilobases. So the
 * site with the most others within `radius` is found, and the centre is the
 * mean of those — the lookalikes are simply not in it.
 */
export function siteCluster(
  sites: readonly number[],
  length: number,
  circular: boolean,
  radius: number,
): { centre: number; count: number } | null {
  if (sites.length === 0) return null
  let best = -1
  let bestCount = 0
  for (let i = 0; i < sites.length; i++) {
    let count = 0
    for (const other of sites) {
      if (separation(sites[i], other, length, circular) <= radius) count++
    }
    if (count > bestCount) {
      bestCount = count
      best = i
    }
  }
  const members = sites.filter(
    (site) => separation(sites[best], site, length, circular) <= radius,
  )
  return { centre: positionMean(members, length, circular), count: members.length }
}

// ---------------------------------------------------------------------------
// The two candidates
// ---------------------------------------------------------------------------

/**
 * The turning points of a cumulative skew: its minimum and its maximum.
 *
 * `cumulative[i]` describes the step `[i × step, (i + 1) × step)`, and each
 * turning point is reported at the **middle** of its step, which is as close as
 * a step can place it. `NaN` for both where the curve is empty.
 */
export function skewTurns(
  cumulative: Float32Array,
  step: number,
  length: number,
): { low: number; high: number } {
  let low = -1
  let high = -1
  for (let i = 0; i < cumulative.length; i++) {
    const value = cumulative[i]
    if (!Number.isFinite(value)) continue
    if (low < 0 || value < cumulative[low]) low = i
    if (high < 0 || value > cumulative[high]) high = i
  }
  const middle = (i: number): number =>
    i < 0 ? Number.NaN : Math.min(length - 1, Math.floor(i * step + step / 2))
  return { low: middle(low), high: middle(high) }
}

/** Which of the three steps, or the convention, placed the terminus. */
export type TerminusRule = 'matS' | 'parS' | 'coverage' | 'skew'

export interface OriTerCall {
  /** Base pairs, 0-based. */
  ori: number
  ter: number
  rule: TerminusRule
  /**
   * Whether the rule put the terminus where the skew's sign convention does, at
   * the cumulative maximum. Always `true` for `'skew'`.
   */
  agreesWithSkew: boolean
  /** The clusters the first two steps were read against, where there was one. */
  matS: { centre: number; count: number } | null
  parS: { centre: number; count: number } | null
}

export interface OriTerInput {
  length: number
  circular: boolean
  /** The cumulative skew's minimum and maximum, in base pairs. */
  low: number
  high: number
  /** Midpoints of the sites found, in base pairs. */
  parS: readonly number[]
  matS: readonly number[]
  /**
   * The smoothed coverage at a position, where a coverage track was given.
   * `undefined` otherwise, which skips the third step.
   */
  coverageAt?: (at: number) => number
  /** Fewer matS sites than this and the first step abstains. Bacchus uses ten. */
  minMatS?: number
}

/** Bacchus's minimum number of matS sites for the first step to decide. */
export const MIN_MATS_SITES = 10

/**
 * Place the origin and the terminus on the two skew turning points.
 *
 * The clusters are read within an eighth of the sequence, which is about the
 * reach of the terminus macrodomain matS marks out in *E. coli* (some 800 kb of
 * 4.6 Mb) and far wider than the few kilobases parS spans round an origin.
 */
export function callOriTer(input: OriTerInput): OriTerCall {
  const { length, circular, low, high } = input
  const radius = length / 8
  const matS = siteCluster(input.matS, length, circular, radius)
  const parS = siteCluster(input.parS, length, circular, radius)
  const minMatS = input.minMatS ?? MIN_MATS_SITES
  const near = (a: number, to: number): number => separation(a, to, length, circular)

  let ter = high
  let rule: TerminusRule = 'skew'
  if (matS !== null && input.matS.length >= minMatS) {
    ter = near(low, matS.centre) < near(high, matS.centre) ? low : high
    rule = 'matS'
  } else if (parS !== null) {
    ter = near(low, parS.centre) > near(high, parS.centre) ? low : high
    rule = 'parS'
  } else if (input.coverageAt !== undefined) {
    const atLow = input.coverageAt(low)
    const atHigh = input.coverageAt(high)
    if (Number.isFinite(atLow) && Number.isFinite(atHigh) && atLow !== atHigh) {
      ter = atLow < atHigh ? low : high
      rule = 'coverage'
    }
  }
  const ori = ter === high ? low : high
  return { ori, ter, rule, agreesWithSkew: ter === high, matS, parS }
}

// ---------------------------------------------------------------------------
// The coverage curve
// ---------------------------------------------------------------------------

/**
 * A cubic B-spline fitted by least squares, with `knots` evenly spaced knots.
 *
 * **Periodic on a circle**, so the curve at the end of the sequence joins its
 * beginning with no kink — the origin of most assemblies is at position zero,
 * and a curve forced flat there would put the coverage maximum anywhere but at
 * the origin. On a line the ends are free.
 *
 * Few knots on purpose: what the curve is for is the two-slope shape
 * replication leaves — high at the origin, falling to the terminus, rising
 * again — and not the bin-to-bin variation of a restriction map, which a
 * flexible spline would follow. Positions with no value (`NaN`) are left out of
 * the fit and are still given the curve's value.
 *
 * @param positions Where each value was measured, in base pairs.
 * @returns The fitted curve at every position, and a function for any other.
 */
export function splineFit(
  positions: Float64Array,
  values: Float64Array,
  length: number,
  knots: number,
  circular: boolean,
): { fitted: Float64Array; at: (x: number) => number } {
  // A periodic curve with K control points has K knots; a free one needs
  // three more control points than knot intervals.
  const intervals = Math.max(circular ? 3 : 1, Math.round(knots))
  const controls = circular ? intervals : intervals + 3
  const scale = length > 0 ? intervals / length : 0

  /** The four weights and the first control point they apply to, at `x`. */
  const basis = (x: number): { first: number; w: [number, number, number, number] } => {
    let u = x * scale
    if (!circular) u = Math.max(0, Math.min(intervals - 1e-9, u))
    const i = Math.floor(u)
    const f = u - i
    const w: [number, number, number, number] = [
      ((1 - f) ** 3) / 6,
      (3 * f ** 3 - 6 * f ** 2 + 4) / 6,
      (-3 * f ** 3 + 3 * f ** 2 + 3 * f + 1) / 6,
      f ** 3 / 6,
    ]
    // Periodic: the four control points round knot `i` are `i − 1 … i + 2`,
    // wrapped. Free: they are `i … i + 3`, which is the same curve shifted by
    // one so that it starts at the first control point.
    return { first: circular ? i - 1 : i, w }
  }
  const index = (k: number): number => (circular ? ((k % controls) + controls) % controls : k)

  const normal = new Float64Array(controls * controls)
  const right = new Float64Array(controls)
  let used = 0
  for (let n = 0; n < positions.length; n++) {
    const y = values[n]
    if (!Number.isFinite(y)) continue
    used++
    const { first, w } = basis(positions[n])
    for (let a = 0; a < 4; a++) {
      const ia = index(first + a)
      right[ia] += w[a] * y
      for (let b = 0; b < 4; b++) normal[ia * controls + index(first + b)] += w[a] * w[b]
    }
  }
  // A whisper of ridge so a knot interval with no data in it — a stretch the
  // balancer dropped, a plasmid shorter than the knots are apart — still has a
  // solution, pulled towards the curve's mean level rather than towards zero.
  let mean = 0
  let seen = 0
  for (let n = 0; n < values.length; n++) {
    if (Number.isFinite(values[n])) {
      mean += values[n]
      seen++
    }
  }
  mean = seen > 0 ? mean / seen : 0
  const ridge = 1e-6 * Math.max(1, used / controls)
  for (let k = 0; k < controls; k++) {
    normal[k * controls + k] += ridge
    right[k] += ridge * mean
  }

  const coefficients = solve(normal, right, controls)
  const at = (x: number): number => {
    if (coefficients === null) return Number.NaN
    const { first, w } = basis(x)
    let total = 0
    for (let a = 0; a < 4; a++) total += w[a] * coefficients[index(first + a)]
    return total
  }
  const fitted = new Float64Array(positions.length)
  for (let n = 0; n < positions.length; n++) fitted[n] = at(positions[n])
  return { fitted, at }
}

/**
 * Gaussian elimination with partial pivoting, on a small dense system.
 *
 * The systems here are a few dozen unknowns at most, so the textbook method is
 * the right one; `null` for a singular one, which the ridge above prevents in
 * practice.
 */
function solve(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array | null {
  const a = Float64Array.from(matrix)
  const b = Float64Array.from(rhs)
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row * n + col]) > Math.abs(a[pivot * n + col])) pivot = row
    }
    if (Math.abs(a[pivot * n + col]) < 1e-300) return null
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const held = a[col * n + k]
        a[col * n + k] = a[pivot * n + k]
        a[pivot * n + k] = held
      }
      const held = b[col]
      b[col] = b[pivot]
      b[pivot] = held
    }
    for (let row = col + 1; row < n; row++) {
      const factor = a[row * n + col] / a[col * n + col]
      if (factor === 0) continue
      for (let k = col; k < n; k++) a[row * n + k] -= factor * a[col * n + k]
      b[row] -= factor * b[col]
    }
  }
  const x = new Float64Array(n)
  for (let row = n - 1; row >= 0; row--) {
    let total = b[row]
    for (let k = row + 1; k < n; k++) total -= a[row * n + k] * x[k]
    x[row] = total / a[row * n + row]
  }
  return x
}

/**
 * The ori/ter ratio: the fitted coverage's highest value over its lowest.
 *
 * Read off the curve rather than off the raw bins, because a single bright bin
 * — a repeat, an rRNA operon — would otherwise be the maximum, and the ratio
 * would be a statement about mapping rather than about replication. `NaN` where
 * the curve does not stay above zero, which a coverage track never should.
 */
export function oriTerRatio(fitted: Float64Array): { ratio: number; highest: number; lowest: number } {
  let highest = Number.NEGATIVE_INFINITY
  let lowest = Number.POSITIVE_INFINITY
  for (const value of fitted) {
    if (!Number.isFinite(value)) continue
    if (value > highest) highest = value
    if (value < lowest) lowest = value
  }
  const ratio = lowest > 0 && Number.isFinite(highest) ? highest / lowest : Number.NaN
  return { ratio, highest, lowest }
}

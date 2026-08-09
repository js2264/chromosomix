/**
 * Diamond insulation, and the boundaries its minima call.
 *
 * The arithmetic a reader can do by eye and cannot do accurately, which is the
 * same sentence `render/viewpoint.ts` opens with and the same reason both exist:
 * slide a square window along the diagonal, and at every bin ask how much
 * contact crosses it. Where a domain boundary sits, very little does.
 *
 * Three things here are load-bearing and each is a place a reimplementation goes
 * quietly wrong.
 *
 * **The diamond never crosses a contig boundary.** It is a window over *one*
 * sequence, and a window straddling the join between `chrIV` and `chrV` sums
 * contacts between two chromosomes and reports the answer as a property of a
 * position — which on a metagenome, where the join is between two organisms, is
 * not a subtle error. Every function here works within one contig's square and
 * the caller supplies them one at a time.
 *
 * **The score is a log ratio against the contig's own mean, not the raw sum.**
 * A raw diamond sum falls with coverage and with distance from the centromere,
 * so a track of raw sums is mostly a picture of depth. Dividing by the mean over
 * the sequence is what makes two chromosomes comparable and what makes zero mean
 * *average*, which is the convention every published insulation track follows.
 *
 * **A bin whose diamond is mostly missing gets `NaN`, not a small number.** The
 * diamond at the first and last `window` bins of a contig hangs off the end, and
 * inside a balanced matrix whole rows are dropped (§6.4). Summing what is left
 * and reporting it would draw a deep, entirely artificial trough at both ends of
 * every sequence — exactly where a reader looks for a telomeric boundary.
 */

/** A dense on-diagonal square for one sequence, row-major. */
export interface ContigSquare {
  /** Bins on a side. */
  size: number
  values: Float32Array
}

export interface DiamondOptions {
  /** Half-width of the diamond, in bins. */
  window: number
  /**
   * How much of the diamond has to carry a value before the bin gets a score.
   *
   * A fraction of the `window * window` cells. Below it the answer is `NaN`.
   */
  minValid: number
}

/**
 * The diamond sum at every bin of one contig, or `NaN` where there is no answer.
 *
 * The diamond at bin `i` is the rectangle of upstream rows against downstream
 * columns — `[i - w, i) × [i, i + w)` — which is the contact *crossing* `i`. Not
 * a square centred on the diagonal: that would include the near-diagonal signal
 * on both sides of the boundary, which is the thing a boundary does *not*
 * suppress, and it is the difference between a dip and a smear.
 *
 * Accumulated in `Float64Array`, for `render/viewpoint.ts`'s reason: a sum over
 * a thousand rows of a deep map runs past what float32 adds without drift, and
 * the drift shows up as a track whose peaks are a few per cent short — plausible,
 * and wrong.
 */
export function diamondSums(square: ContigSquare, options: DiamondOptions): Float64Array {
  const { size, values } = square
  const w = Math.max(1, Math.trunc(options.window))
  const out = new Float64Array(size).fill(Number.NaN)
  const cells = w * w
  if (cells === 0 || size === 0) return out
  const needed = Math.max(1, Math.ceil(cells * options.minValid))

  for (let i = 0; i < size; i++) {
    // The whole diamond, or none of it. A partial window at the ends of a
    // contig is what produces the artificial trough this module's header warns
    // about, and clamping it to what fits would produce a *smaller* sum from
    // *fewer* cells — which reads as strong insulation rather than as no data.
    if (i - w < 0 || i + w > size) continue
    let total = 0
    let seen = 0
    for (let row = i - w; row < i; row++) {
      const base = row * size
      for (let col = i; col < i + w; col++) {
        const value = values[base + col]
        if (Number.isNaN(value)) continue
        total += value
        seen++
      }
    }
    out[i] = seen >= needed ? total : Number.NaN
  }
  return out
}

/**
 * The sums as a log2 ratio against their own mean.
 *
 * `NaN` in, `NaN` out, and a sum of exactly zero also becomes `NaN` rather than
 * `-Infinity`: a bin with no contact at all across it is a bin the data cannot
 * place a boundary at, and an infinite trough would take the value axis of the
 * whole lane with it — and could not be written to a bigWig at all (§18.7).
 *
 * The mean is over the finite sums of this contig only, which is what makes the
 * track comparable between sequences of different depth.
 */
export function insulationScore(sums: Float64Array): Float64Array {
  let total = 0
  let seen = 0
  for (const value of sums) {
    if (!Number.isFinite(value)) continue
    total += value
    seen++
  }
  const out = new Float64Array(sums.length).fill(Number.NaN)
  if (seen === 0) return out
  const mean = total / seen
  if (!(mean > 0)) return out
  for (let i = 0; i < sums.length; i++) {
    const value = sums[i]
    if (!Number.isFinite(value) || value <= 0) continue
    out[i] = Math.log2(value / mean)
  }
  return out
}

/** One called boundary, in bins local to its contig. */
export interface Boundary {
  bin: number
  /** The score at the minimum; negative is insulated. */
  score: number
  /** How far the track has to climb on both sides to escape this minimum. */
  prominence: number
}

export interface BoundaryOptions {
  /** Minimum prominence, in the score's own log2 units. */
  prominence: number
  /** Minimum gap between two calls, in bins. */
  spacing: number
}

/**
 * Local minima of the score, with a prominence each.
 *
 * Prominence rather than depth, and the distinction is the whole of why this is
 * not three lines. A score of −1.2 in a quiet region is a boundary; the same
 * −1.2 halfway down the flank of a −3 trough is one boundary reported twice. So
 * each minimum is scored by how far the track must *climb* on both sides before
 * it falls lower than the minimum itself — which is exactly the topographic
 * definition, and which collapses a ragged trough to its floor.
 *
 * A plateau — several equal minima in a row, which a coarse bin size produces
 * often — is reported once, at its first bin, rather than once per bin.
 */
export function callBoundaries(
  score: Float64Array,
  options: BoundaryOptions,
): Boundary[] {
  const found: Boundary[] = []
  const n = score.length

  for (let i = 0; i < n; i++) {
    const value = score[i]
    if (!Number.isFinite(value)) continue
    // A minimum is a bin no higher than its finite neighbours, and strictly
    // lower than at least one of them — which is what excludes a flat run from
    // being n separate minima while still admitting the floor of a plateau.
    const left = previousFinite(score, i)
    const right = nextFinite(score, i)
    const leftValue = left < 0 ? Number.POSITIVE_INFINITY : score[left]
    const rightValue = right < 0 ? Number.POSITIVE_INFINITY : score[right]
    if (value > leftValue || value > rightValue) continue
    if (value === leftValue && value === rightValue) continue
    // The first bin of a plateau, not every bin of it.
    if (value === leftValue) continue

    const prominence = Math.min(climb(score, i, -1), climb(score, i, 1))
    if (!(prominence >= options.prominence)) continue
    found.push({ bin: i, score: value, prominence })
  }

  // Strongest first, then thinned by spacing, so that where two calls are too
  // close the one that survives is the better one rather than the leftmost.
  found.sort((a, b) => b.prominence - a.prominence)
  const kept: Boundary[] = []
  for (const candidate of found) {
    if (kept.some((other) => Math.abs(other.bin - candidate.bin) < options.spacing)) continue
    kept.push(candidate)
  }
  kept.sort((a, b) => a.bin - b.bin)
  return kept
}

/** How far the track climbs from `at` before falling below it again. */
function climb(score: Float64Array, at: number, step: -1 | 1): number {
  const floor = score[at]
  let highest = floor
  for (let i = at + step; i >= 0 && i < score.length; i += step) {
    const value = score[i]
    if (!Number.isFinite(value)) break
    // A lower minimum ends the search: past it, this one is on somebody else's
    // flank and whatever is beyond belongs to them.
    if (value < floor) break
    if (value > highest) highest = value
  }
  return highest - floor
}

function previousFinite(score: Float64Array, from: number): number {
  for (let i = from - 1; i >= 0; i--) if (Number.isFinite(score[i])) return i
  return -1
}

function nextFinite(score: Float64Array, from: number): number {
  for (let i = from + 1; i < score.length; i++) if (Number.isFinite(score[i])) return i
  return -1
}

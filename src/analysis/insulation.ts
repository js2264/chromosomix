/**
 * Diamond insulation, and the boundaries its minima call.
 *
 * The arithmetic a reader can do by eye and cannot do accurately, which is the
 * same sentence `analysis/viewpoint.ts` opens with and the same reason both exist:
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
   * A fraction of the cells it is allowed to count. Below it the answer is
   * `NaN`.
   */
  minValid: number
  /**
   * Diagonals to leave out of the sum, cooltools' `ignore_diags`.
   *
   * `0` counts every cell, `1` drops the main diagonal, `2` drops it and the two
   * beside it — the rule is `|col − row| < n`, the same one the compartment
   * chain applies (`analysis/compartments.ts`).
   *
   * The diamond never touches the main diagonal, so this is about its **inner
   * corner**: the cell at `(i − 1, i)` is one bin of separation, and the corner
   * of the rectangle nearest the diagonal is where self-ligation and unligated
   * fragments land. Those cells are the largest in the matrix, so at a small
   * window the corner can be most of the sum — and a track carried by it is a
   * track of how deep the near-diagonal is rather than of what crosses the bin.
   *
   * `cells` is reduced with it, so `minValid` stays a fraction of what is
   * actually countable rather than of a rectangle two cells of which can never
   * be counted.
   */
  ignoreDiags?: number
}

/**
 * Cells of a diamond that `ignoreDiags` leaves countable.
 *
 * The diamond at bin `i` is `[i − w, i) × [i, i + w)`, so its separations run
 * `1 … 2w − 1`, with `d` cells at separation `d` up to `w` and `2w − d` past it.
 * `ignoreDiags` drops every cell below it, and at `2w` there is nothing left at
 * all: **a window is only as wide as its widest separation**, and asking to
 * ignore more diagonals than the diamond spans empties it.
 *
 * Counted rather than solved for, because the closed form has three regimes and
 * this is `2w` additions once per call. The version it replaces had two of the
 * three: it capped the ignored triangle at `w(w + 1) / 2` and so kept reporting
 * a positive cell count for a diamond with nothing countable in it. `minValid`
 * is a fraction *of this number*, so the error did not stop at bookkeeping —
 * past `ignoreDiags = w + 1` the threshold was computed against cells that could
 * never be counted, and bins with a perfectly good diamond were scored `NaN`;
 * past `2w` every bin was, and the track came back empty with nothing said.
 */
export function diamondCells(window: number, ignoreDiags: number): number {
  const w = Math.max(1, Math.trunc(window))
  const ignore = Math.max(0, Math.trunc(ignoreDiags))
  let cells = 0
  for (let d = Math.max(1, ignore); d < 2 * w; d++) cells += d <= w ? d : 2 * w - d
  return cells
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
 * Accumulated in `Float64Array`, for `analysis/viewpoint.ts`'s reason: a sum over
 * a thousand rows of a deep map runs past what float32 adds without drift, and
 * the drift shows up as a track whose peaks are a few per cent short — plausible,
 * and wrong.
 */
export function diamondSums(square: ContigSquare, options: DiamondOptions): Float64Array {
  const { size, values } = square
  const w = Math.max(1, Math.trunc(options.window))
  const ignore = Math.max(0, Math.trunc(options.ignoreDiags ?? 0))
  const out = new Float64Array(size).fill(Number.NaN)
  // The rectangle, less the cells the ignored diagonals take off its inner
  // corner — counted, because the triangle is only a triangle while the cut is
  // narrower than the window. See {@link diamondCells}.
  const cells = diamondCells(w, ignore)
  if (cells <= 0 || size === 0) return out
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
        // The inner corner, where the near-diagonal is. `col - row` is the
        // separation and is always positive here, the diamond being strictly
        // upstream-against-downstream.
        if (col - row < ignore) continue
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

/**
 * One domain: the span between two consecutive boundaries, in bins local to its
 * contig, half-open.
 *
 * `from` is the bin the upstream boundary was called at and `to` is the bin the
 * downstream one was called at, so consecutive domains **tile**: one ends where
 * the next begins, and the boundary bin belongs to the domain below it. That is
 * what makes a lane of them read as a segmentation rather than as a row of
 * boxes with gaps, and it is what puts a domain's two corners on the two bins
 * the calls were actually made at — which is what a scaled pileup lines up on.
 */
export interface Domain {
  from: number
  to: number
  /** The weaker of the two boundaries that bound it. */
  strength: number
}

/**
 * The domains between a sequence's boundary calls.
 *
 * **Two boundaries make a domain; one makes nothing, and the ends of the
 * sequence are not domains.** A chromosome with a single call has no interior
 * to report, and running the first domain back to the telomere — or the last one
 * on to it — would assert an edge the data never placed. So what comes back is
 * the gaps *between* calls and nothing else, which on a sequence with `n` calls
 * is `n - 1` domains.
 *
 * The strength is the **weaker** of the two edges, because a domain is only as
 * well defined as its worse-supported side: reporting the stronger would let one
 * good boundary vouch for a run of bad ones, and the score is what a reader
 * ranks and filters the set on.
 *
 * Sorted here rather than assumed. {@link callBoundaries} already answers in bin
 * order, but *consecutive* is the whole of what this computes, and a caller that
 * had sorted by prominence — which is the other order a boundary list comes in —
 * would otherwise get domains between calls that are not neighbours.
 */
export function domainsBetween(boundaries: readonly Boundary[]): Domain[] {
  const order = [...boundaries].sort((a, b) => a.bin - b.bin)
  const out: Domain[] = []
  for (let i = 1; i < order.length; i++) {
    const from = order[i - 1]
    const to = order[i]
    if (to.bin <= from.bin) continue
    out.push({
      from: from.bin,
      to: to.bin,
      strength: Math.min(from.prominence, to.prominence),
    })
  }
  return out
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

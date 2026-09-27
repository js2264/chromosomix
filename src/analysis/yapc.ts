/**
 * yapc's peak calling, as a port (§18.8, §18.9).
 *
 * *Yet another peak caller* (Jänes et al. 2018, eLife 7:e37344) reads a
 * **coverage track** rather than reads, which is what makes it the one caller
 * this app can run: a bigWig is all a browser has of an ATAC or a ChIP
 * experiment, and yapc was written for exactly that input — "processed signal
 * tracks … that show the most compelling peaks by visual inspection". Its idea
 * is a shape and not a threshold. The signal is smoothed, differentiated twice,
 * and every stretch where the smoothed second derivative is negative — where
 * the track **curves down** — is a candidate peak, scored by how sharply it
 * curves. A peak is found by its form rather than by its height, so the call
 * needs no background model of a signal that has already been normalised, and
 * two summits standing on one shoulder are two peaks rather than one wide one.
 *
 * What a candidate is worth is then a question for **two replicates**: each
 * scores every candidate, and IDR (`analysis/idr.ts`) asks how far down the two
 * rankings agree. With one track there is no such test, and the run says so.
 *
 * ## A port, and what that obliges
 *
 * §18.9's rule for a second caller is that it arrives with a published upstream
 * and a golden built from that upstream's own output, and that the port does
 * not improve on it. The upstream is yapc 0.1 — the release on bioconda, which
 * the paper's methods describe — and every step below is its code, in its order,
 * including four things a first reading takes for oversights:
 *
 * - **The pooled track and the concave regions are read back through a
 *   bigWig.** yapc writes the mean coverage and its second derivative to disk
 *   and calls regions on what it reads back, so both are **float32** by the time
 *   anything is decided on them, and a tie between two positions of equal
 *   curvature is a tie in float32. The *scores* are computed from each track in
 *   float64 and never written, so they are not rounded. Both roundings are kept.
 * - **`np.convolve(…, mode='same')` centres an even kernel half a base right**,
 *   and on a sequence shorter than the kernel it centres on the kernel instead
 *   — after which pyBigWig silently keeps the first `length` values. Both
 *   alignments are reproduced ({@link convolveSame}).
 * - **Flat signal is concave.** The test is `d2 < 1e-10`, and the composite
 *   kernel sums to a few times −10⁻¹¹ rather than to zero in float64, so a stretch of
 *   constant non-negative coverage — a run of zeros included — comes out as a
 *   concave region with a score near zero. It sorts to the bottom of every
 *   ranking, which is where it does no harm, and it is there.
 * - **A sequence whose concave stretches never begin after its first base has
 *   none.** `find_concave_regions_chrom` returns early when there is no rising
 *   edge, before it adds the region open at position 0 ({@link ConcaveScan}).
 *
 * Where yapc does not produce an answer at all, the port has to, and each place
 * is named where it is decided: a sequence ending on an open concave stretch
 * with no rising edge before it (yapc raises an `IndexError`), a fixed
 * half-width reaching past a sequence end (yapc writes a negative BED start),
 * and a tie in rank at the truncation cut (yapc's `quicksort` puts it wherever
 * numpy's introsort left it; here it is broken by position).
 *
 * ## Streaming, which yapc does not do
 *
 * yapc holds a whole chromosome per sample in memory — 2 GB for a human
 * chromosome 1 in float64. Nothing here needs more than one window at a time:
 * the convolution reaches 228 bases each side, so a window read with that halo
 * is computed exactly as the whole sequence would be, and {@link ConcaveScan}
 * carries an open region, its summit candidates and its values across the seam.
 * The answer is the same function of the same numbers; only the memory is not.
 */

import { numpyMean } from './stats'

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

/** yapc's own defaults, from its `argparse` help. */
export const YAPC_DEFAULTS = {
  /** `--smoothing-window-width`: "try … values ranging from 75 to 200". */
  width: 150,
  /** `--smoothing-times`. */
  times: 3,
  /** `--min-concave-region-width`. */
  minWidth: 75,
  /** `--truncate-idr-input`. */
  truncate: 100_000,
} as const

/**
 * The nine-point central difference for a second derivative, accurate to eighth
 * order — the weights yapc cites (Fornberg 1988, *Math. Comp.* 51:699).
 */
export const SECOND_DERIVATIVE_STENCIL: readonly number[] = [
  -1.0 / 560,
  8.0 / 315,
  -1.0 / 5,
  8.0 / 5,
  -205.0 / 72,
  8.0 / 5,
  -1.0 / 5,
  8.0 / 315,
  -1.0 / 560,
]

/**
 * yapc's `ADHOC_LARGE_NUMBER`: "scale to have better visualisation of d2smooth
 * in IGV". It multiplies every score, so it is part of what the numbers mean
 * and is kept, whatever it was for.
 */
export const KERNEL_SCALE = 1e6

/** `find_concave_regions_chrom`'s `tol`: a position is concave below it. */
export const CONCAVE_TOLERANCE = 1e-10

/** The composite kernel, and its running total for the run-wise convolution. */
export interface YapcKernel {
  readonly width: number
  readonly times: number
  /** `prepare_second_derivative_kernel(width, times)`: scaled and reversed. */
  readonly values: Float64Array
  /** `cumulative[m]` is the sum of `values[0, m)`; one longer than `values`. */
  readonly cumulative: Float64Array
}

/**
 * `prepare_second_derivative_kernel`: the stencil convolved `times` times with a
 * rolling mean of `width`, scaled, and reversed.
 *
 * One convolution with this is the smoothed second derivative, which is why yapc
 * builds it rather than smoothing and then differentiating: the composite is 456
 * taps at the defaults and applied once. The reversal is a no-op on a symmetric
 * kernel and is kept anyway, because the float64 composite is symmetric only to
 * about one part in 10¹⁴ and it is yapc's orientation that the numbers are in.
 */
export function yapcKernel(width: number, times: number): YapcKernel {
  let kernel: Float64Array = Float64Array.from(SECOND_DERIVATIVE_STENCIL)
  const box = new Float64Array(width).fill(1 / width)
  for (let pass = 0; pass < times; pass++) kernel = convolveFull(kernel, box)
  const values = new Float64Array(kernel.length)
  for (let k = 0; k < kernel.length; k++) values[k] = KERNEL_SCALE * kernel[kernel.length - 1 - k]
  const cumulative = new Float64Array(values.length + 1)
  for (let k = 0; k < values.length; k++) cumulative[k + 1] = cumulative[k] + values[k]
  return { width, times, values, cumulative }
}

/** `np.convolve(a, b)` in its default `'full'` mode. */
function convolveFull(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length - 1)
  for (let n = 0; n < out.length; n++) {
    let total = 0
    const from = Math.max(0, n - (b.length - 1))
    const to = Math.min(n, a.length - 1)
    for (let k = from; k <= to; k++) total += a[k] * b[n - k]
    out[n] = total
  }
  return out
}

/**
 * Where output `i` of `np.convolve(x, kernel, mode='same')` is centred: it is
 * `full[i + centre]`, so it reads `x[i + centre − (L − 1) … i + centre]`.
 *
 * numpy swaps its arguments when the kernel is the longer of the two and centres
 * the `'same'` window on *that*, so on a sequence shorter than the kernel the
 * centre is the sequence's rather than the kernel's. yapc then writes all
 * `L` values into a sequence `length` bases long, and pyBigWig keeps the first
 * `length` of them — the alignment below.
 */
export function convolutionCentre(kernel: YapcKernel, length: number): number {
  return (Math.min(length, kernel.values.length) - 1) >> 1
}

/** How far, each side of a position, the convolution reads. */
export function convolutionReach(kernel: YapcKernel, length: number): { left: number; right: number } {
  const centre = convolutionCentre(kernel, length)
  return { left: kernel.values.length - 1 - centre, right: centre }
}

// ---------------------------------------------------------------------------
// Runs: a track as it arrives
// ---------------------------------------------------------------------------

/**
 * A stretch of one sequence as abutting constant pieces, `NaN` where there is no
 * value.
 *
 * The shape a bigWig *is* — `bedGraph`-like intervals — and the shape the
 * convolution below is fastest on. Expanding it to one value per base first
 * would cost 12 MB per megabase and change nothing.
 */
export interface Runs {
  /** 0-based, half-open, ascending and abutting. */
  readonly starts: Int32Array
  readonly ends: Int32Array
  readonly values: Float64Array
  readonly length: number
}

/**
 * The pieces of `[from, to)` a track's intervals describe, with every base they
 * do not cover as `NaN`.
 *
 * `NaN` rather than zero because that is what `pyBigWig.values` returns for a
 * base with no entry, and yapc never replaces it: the mean over tracks is `NaN`
 * wherever one of them is, and the convolution carries it `reach` bases each
 * way, where nothing can be concave. A lane with a hole in it has no peaks in
 * the hole.
 *
 * Intervals are clipped to the span and to each other: a bedGraph that repeats a
 * base is read for its first interval there, which is what a bigWig built from
 * it would hold. Abutting intervals of one value are one piece — a binned bigWig
 * stores a run of equal bins bin by bin — so a piece is a stretch of constant
 * signal, which is what the flat test in `convolveSame` asks about.
 */
export function runsOver(
  starts: ArrayLike<number>,
  ends: ArrayLike<number>,
  values: ArrayLike<number>,
  from: number,
  to: number,
): Runs {
  const outStarts: number[] = []
  const outEnds: number[] = []
  const outValues: number[] = []
  const piece = (start: number, end: number, value: number): void => {
    const last = outValues.length - 1
    if (last >= 0 && outEnds[last] === start && sameValue(outValues[last], value)) {
      outEnds[last] = end
      return
    }
    outStarts.push(start)
    outEnds.push(end)
    outValues.push(value)
  }
  let at = from
  for (let i = 0; i < starts.length && at < to; i++) {
    const start = Math.max(starts[i], at)
    const end = Math.min(ends[i], to)
    if (end <= start) continue
    if (start > at) piece(at, start, Number.NaN)
    piece(start, end, values[i])
    at = end
  }
  if (at < to) piece(at, to, Number.NaN)
  return {
    starts: Int32Array.from(outStarts),
    ends: Int32Array.from(outEnds),
    values: Float64Array.from(outValues),
    length: outStarts.length,
  }
}

/**
 * `[from, to)` as one piece of zeros: a track that does not have the sequence.
 *
 * yapc's `coverage()` reads such a track as zeros — `RuntimeError suggests
 * empty chromosome; returning flat signal` — so it pulls the pooled mean down
 * rather than blanking it, and its own scores there are `-inf`.
 */
export function zeroRuns(from: number, to: number): Runs {
  return {
    starts: Int32Array.of(from),
    ends: Int32Array.of(to),
    values: Float64Array.of(0),
    length: 1,
  }
}

/**
 * The mean of several tracks over `[from, to)`, as yapc's pooled coverage track
 * holds it after the round trip through a bigWig.
 *
 * `np.mean(l_val, axis=0)` adds the tracks in order and divides by their count,
 * and `addEntries` then stores it as float32: both are here, in that order, so
 * the pooled value is bit for bit the one yapc calls regions on. One track is
 * its own mean — and already float32 — so it passes through untouched.
 */
export function pooledRuns(tracks: readonly Runs[], from: number, to: number): Runs {
  if (tracks.length === 1) return tracks[0]
  const starts: number[] = []
  const ends: number[] = []
  const values: number[] = []
  const cursor = new Int32Array(tracks.length)
  let at = from
  while (at < to) {
    let next = to
    let total = 0
    for (let t = 0; t < tracks.length; t++) {
      const runs = tracks[t]
      while (cursor[t] < runs.length && runs.ends[cursor[t]] <= at) cursor[t]++
      const r = cursor[t]
      // Every track covers the whole span by construction (`runsOver` fills its
      // gaps), so a missing piece is a caller's mistake rather than data.
      if (r >= runs.length || runs.starts[r] > at) {
        throw new Error(`pooledRuns: a track does not cover ${at}`)
      }
      total += runs.values[r]
      if (runs.ends[r] < next) next = runs.ends[r]
    }
    const value = Math.fround(total / tracks.length)
    const last = values.length - 1
    if (last >= 0 && sameValue(values[last], value)) ends[last] = next
    else {
      starts.push(at)
      ends.push(next)
      values.push(value)
    }
    at = next
  }
  return {
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    values: Float64Array.from(values),
    length: starts.length,
  }
}

/** Equal as signal: the same number, or both missing. */
function sameValue(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b)
}

// ---------------------------------------------------------------------------
// The convolution
// ---------------------------------------------------------------------------

/**
 * `np.convolve(x, kernel, mode='same')` at positions `[from, to)` of a sequence
 * `length` bases long, with `x` given as {@link Runs}.
 *
 * `runs` must cover `[from − left, to + right)` inside the sequence, where
 * `left` and `right` are {@link convolutionReach}; positions outside the sequence
 * are zeros, which is numpy's padding.
 *
 * **Run by run rather than base by base**, and it is the same sum: a piece of
 * constant value `v` over `[s, e)` contributes `v · Σ kernel` over the taps it
 * meets, and that sum is a difference of the kernel's running total. A 456-tap
 * kernel over a bigWig whose intervals average five bases is ninety pieces per
 * position instead of 456 products. What it is *not* is the same float64
 * rounding as a dot product, which numpy's own BLAS does not promise either; the
 * golden (§18.10) holds the two to where every region, summit and score agrees.
 *
 * Flat input stays what numpy makes of it: a window inside one piece is `v` times
 * the kernel's total, a few times −10⁻¹¹ · `v` in either, and a window of zeros is
 * exactly zero.
 * Any `NaN` in the window makes the output `NaN`, as it does in a dot product.
 */
export function convolveSame(
  runs: Runs,
  kernel: YapcKernel,
  length: number,
  from: number,
  to: number,
  /**
   * Set to 1 at each position whose whole window lies inside one constant piece
   * of the signal — where the second derivative is the kernel's sum times a
   * constant, which is to say flat rather than curved. See {@link ConcaveScan}.
   */
  flat?: Uint8Array,
): Float64Array {
  const taps = kernel.values.length
  const values = kernel.values
  const cumulative = kernel.cumulative
  const centre = convolutionCentre(kernel, length)
  const out = new Float64Array(Math.max(0, to - from))
  let first = 0
  for (let i = from; i < to; i++) {
    const reach = i + centre - (taps - 1)
    const low = Math.max(0, reach)
    const high = Math.min(length, i + centre + 1)
    while (first < runs.length && runs.ends[first] <= low) first++
    if (
      flat !== undefined &&
      reach >= 0 &&
      i + centre + 1 <= length &&
      first < runs.length &&
      runs.starts[first] <= low &&
      runs.ends[first] >= high
    ) {
      flat[i - from] = 1
    }
    const anchor = i + centre + 1
    let total = 0
    for (let r = first; r < runs.length; r++) {
      const start = runs.starts[r]
      if (start >= high) break
      const value = runs.values[r]
      if (value !== value) {
        total = Number.NaN
        break
      }
      const s = start > low ? start : low
      const end = runs.ends[r]
      const e = end < high ? end : high
      // One base is one tap, taken as it is: a difference of running totals is
      // accurate to their size rather than to the tap's, and a bigWig at base
      // resolution is mostly pieces one or two bases long.
      total += e - s === 1 ? value * values[anchor - 1 - s] : value * (cumulative[anchor - s] - cumulative[anchor - e])
    }
    out[i - from] = total
  }
  return out
}

// ---------------------------------------------------------------------------
// Concave regions
// ---------------------------------------------------------------------------

/** Every concave region of one sequence, with each track's score for it. */
export interface ConcaveRegions {
  readonly contig: string
  readonly starts: Int32Array
  readonly ends: Int32Array
  /** yapc's `mode`: the most concave position, the middle one of a tie. */
  readonly modes: Int32Array
  /**
   * One array per track: `-np.mean(d2)` over the region, in float64 from that
   * track's own smoothed second derivative. `-Infinity` for a track that does
   * not have the sequence, which is what yapc's `scores()` yields for one.
   */
  readonly scores: Float64Array[]
  /**
   * 1 for a region the pooled signal is **flat** across somewhere inside — a
   * position whose whole kernel window is one constant piece. Not yapc's: see
   * {@link ConcaveScan}.
   */
  readonly flat: Uint8Array
}

/**
 * `find_concave_regions_chrom` and `scores()`, fed one window at a time.
 *
 * yapc finds the rising and falling edges of `d2 < tol` over the whole
 * sequence, then patches the two ends: a region open at the first base gains a
 * start of 0, and one open at the last base gains an end of `length`. Fed in
 * windows, the edges are the same edges; the patches are applied in
 * {@link finish}, where it is known how the sequence ended.
 *
 * **No rising edge, no regions** — the early `return` that precedes both
 * patches, so a sequence that is concave from its first base and never becomes
 * concave again reports nothing, and nor does one concave throughout. Kept.
 * **A rising edge and no falling one** is where yapc stops with an `IndexError`
 * (`e[0]` of an empty array); here the one region runs to the end, which is
 * what both patches were written to say.
 *
 * **What is added is a flag, and nothing is removed for it.** A stretch of
 * constant signal passes yapc's test — its second derivative is the kernel's
 * float64 sum times the constant, zero or −10⁻¹¹ — so a run of explicit zeros
 * longer than the kernel is a concave region, scoring whatever the ringing at its
 * edges leaves (10⁻⁷, on a plateau of three kilobases). In yapc that is harmless:
 * IDR ranks it last in both replicates and drops it. A region is marked `flat`
 * where one of its positions had a window inside one constant piece
 * (`convolveSame`'s mask), which no peak has, so that a run with one track — which
 * yapc has no cut for — can leave it out without a threshold on its score.
 */
export class ConcaveScan {
  private readonly tracks: number
  private readonly absent: readonly boolean[]
  private starts: number[] = []
  private ends: number[] = []
  private modes: number[] = []
  private flats: number[] = []
  private readonly scores: number[][]
  private previous = false
  private rose = false
  private open = -1
  /** The most concave value so far in the open region, and where it is tied. */
  private best = Number.NEGATIVE_INFINITY
  private ties: number[] = []
  /** Each track's smoothed second derivative over the open region. */
  private held: Float64Array[]
  private heldLength = 0
  private openFlat = 0
  private position = 0

  constructor(
    readonly contig: string,
    readonly length: number,
    /** One flag per track: `true` for a track that does not have this sequence. */
    absent: readonly boolean[],
  ) {
    this.tracks = absent.length
    this.absent = absent
    this.scores = absent.map(() => [])
    this.held = absent.map(() => new Float64Array(1024))
  }

  /**
   * Positions `[from, from + pooled.length)`, which must follow the last ones fed.
   *
   * `pooled` is the pooled track's smoothed second derivative in float64; it is
   * rounded to float32 here, where yapc's round trip through `_d2smooth.bw`
   * would round it. `tracks` is each track's own, unrounded, over the same
   * positions — the same array as `pooled` when there is one track. `flat` is
   * `convolveSame`'s mask for the pooled track, where the caller wants it.
   */
  feed(
    from: number,
    pooled: Float64Array,
    tracks: readonly Float64Array[],
    flat?: Uint8Array,
  ): void {
    if (from !== this.position) {
      throw new Error(`ConcaveScan: fed ${from} after ${this.position}`)
    }
    for (let k = 0; k < pooled.length; k++) {
      const at = from + k
      const d2 = Math.fround(pooled[k])
      const concave = d2 < CONCAVE_TOLERANCE
      if (at === 0) {
        if (concave) this.begin(0)
      } else if (concave && !this.previous) {
        this.rose = true
        this.begin(at)
      } else if (!concave && this.previous) {
        this.close(at)
      }
      if (concave) {
        // `nanargmax_median(-d2y[i:j])`: the largest of `-d2` in float32, every
        // position that equals it, and the middle one of those at the end.
        const value = -d2
        if (value > this.best) {
          this.best = value
          this.ties = [at]
        } else if (value === this.best) {
          this.ties.push(at)
        }
        this.hold(tracks, k)
        if (flat !== undefined && flat[k] === 1) this.openFlat = 1
      }
      this.previous = concave
    }
    this.position = from + pooled.length
  }

  /** yapc's two end patches, and the early return before them. */
  finish(): ConcaveRegions {
    if (this.open >= 0) this.close(this.length)
    if (!this.rose) {
      this.starts = []
      this.ends = []
      this.modes = []
      this.flats = []
      for (const list of this.scores) list.length = 0
    }
    return {
      contig: this.contig,
      starts: Int32Array.from(this.starts),
      ends: Int32Array.from(this.ends),
      modes: Int32Array.from(this.modes),
      scores: this.scores.map((list) => Float64Array.from(list)),
      flat: Uint8Array.from(this.flats),
    }
  }

  private begin(at: number): void {
    this.open = at
    this.best = Number.NEGATIVE_INFINITY
    this.ties = []
    this.heldLength = 0
    this.openFlat = 0
  }

  private hold(tracks: readonly Float64Array[], k: number): void {
    if (this.heldLength === this.held[0].length) {
      this.held = this.held.map((values) => {
        const grown = new Float64Array(values.length * 2)
        grown.set(values)
        return grown
      })
    }
    for (let t = 0; t < this.tracks; t++) this.held[t][this.heldLength] = tracks[t][k]
    this.heldLength++
  }

  private close(at: number): void {
    this.starts.push(this.open)
    this.ends.push(at)
    this.flats.push(this.openFlat)
    this.modes.push(this.ties.length === 0 ? this.open : this.ties[this.ties.length >> 1])
    for (let t = 0; t < this.tracks; t++) {
      this.scores[t].push(
        this.absent[t] ? Number.NEGATIVE_INFINITY : -numpyMean(this.held[t], 0, this.heldLength),
      )
    }
    this.open = -1
  }
}

// ---------------------------------------------------------------------------
// From regions to peaks
// ---------------------------------------------------------------------------

/**
 * `df.rank(ascending=False)`: 1 for the highest score, ties sharing the mean of
 * the ranks they span (pandas' default `method='average'`).
 */
export function descendingRanks(scores: Float64Array): Float64Array {
  const n = scores.length
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => scores[b] - scores[a] || a - b)
  const out = new Float64Array(n)
  let i = 0
  while (i < n) {
    let j = i + 1
    while (j < n && scores[order[j]] === scores[order[i]]) j++
    const rank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) out[order[k]] = rank
    i = j
  }
  return out
}

/**
 * The regions yapc hands IDR: every track ranks them, each keeps its best rank,
 * and the `limit` best go through (`--truncate-idr-input`).
 *
 * Returned as indices in **yapc's IDR order** — sorted by sequence name, then
 * start, then end — because that is the order `fit_model_and_calc_local_idr`
 * adds its likelihoods in, and a port is held to the last place of those sums.
 *
 * A tie in best rank at the cut is broken by position. yapc sorts with pandas'
 * default `quicksort`, which leaves tied rows wherever numpy's introsort put
 * them; there is no order of theirs to reproduce, and position is one it could
 * have produced.
 */
export function strongestRegions(
  contigs: readonly string[],
  starts: Int32Array,
  ends: Int32Array,
  scores: readonly Float64Array[],
  limit: number,
): Int32Array {
  const n = starts.length
  const best = new Float64Array(n).fill(Number.POSITIVE_INFINITY)
  for (const column of scores) {
    const ranks = descendingRanks(column)
    for (let i = 0; i < n; i++) if (ranks[i] < best[i]) best[i] = ranks[i]
  }
  const byPosition = (a: number, b: number): number =>
    contigs[a] < contigs[b] ? -1 : contigs[a] > contigs[b] ? 1 : starts[a] - starts[b] || ends[a] - ends[b]
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => best[a] - best[b] || byPosition(a, b))
  const kept = order.slice(0, Math.max(0, Math.min(n, limit)))
  kept.sort(byPosition)
  return Int32Array.from(kept)
}

/**
 * yapc's final bounds: the concave region itself, or `halfWidth` bases each side
 * of its summit — `mode − h` to `mode + h + 1`.
 *
 * Clamped to the sequence, which yapc does not do: it writes the negative start
 * a summit near position 0 gives, and a BED line that no parser accepts is not a
 * peak anybody can use.
 */
export function peakBounds(
  start: number,
  end: number,
  mode: number,
  halfWidth: number,
  length: number,
): [number, number] {
  if (!(halfWidth > 0)) return [start, end]
  return [Math.max(0, mode - halfWidth), Math.min(length, mode + halfWidth + 1)]
}

/**
 * `-math.log(th, 10)`: the scaled global IDR a peak must reach at threshold `th`.
 *
 * `math.log(x, 10)` is `log(x) / log(10)`, not `log10(x)`, and at 0.001 the two
 * differ in the last place — `2.9999999999999996` against `3` — which decides
 * whether a peak whose IDR is exactly 10⁻³ is in or out. yapc's spelling is kept.
 */
export function scaledThreshold(threshold: number): number {
  return -(Math.log(threshold) / Math.log(10))
}

/** The IDR thresholds yapc writes a BED at, in its order. */
export const YAPC_IDR_THRESHOLDS: readonly number[] = [0.001, 0.005, 0.01, 0.05, 0.1, 0.2]

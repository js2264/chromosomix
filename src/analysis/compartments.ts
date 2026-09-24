/**
 * Observed/expected, the correlation matrix, the eigenvectors, and the saddle.
 *
 * The chain §18.8 describes, as four pure functions. Each is short; what is long
 * is the reasoning about missing data, because a compartment analysis is where
 * dropped bins do the most damage and where the damage is least visible.
 *
 * **A bin the balancer dropped is excluded from the matrix, not zeroed.** A
 * zeroed row asserts that its bin is uncorrelated with everything — which is a
 * strong, false claim that pulls the eigenvector towards zero there, and which
 * on a chromosome arm full of dropped bins produces a compartment track with a
 * flat region that looks exactly like a real one. So the chain works over an
 * *index* of usable bins and the caller expands the result back over the full
 * grid afterwards, restoring the gaps as gaps.
 *
 * **Phasing is reported, not assumed.** The sign of an eigenvector is arbitrary,
 * and the convention that positive means the active compartment is a convention
 * — it has to be attached to something. Attaching it to a signal the reader
 * chooses, and printing the correlation that was used, is what makes the track's
 * sign a claim rather than an accident. Below a threshold the answer is *I could
 * not tell*, which is a legitimate result and a much better one than a coin flip.
 */

import type { ExpectedCurve } from './expected'
import { expectedAt } from './expected'
import { pearson, quantileEdges } from './stats'

/**
 * The bins of a square that carry enough data to take part.
 *
 * A row is usable when it has at least `minFraction` finite cells. Everything
 * downstream works over this index, which is what keeps a dropped bin out of the
 * correlation rather than in it as a zero.
 */
export function usableBins(
  values: Float32Array,
  n: number,
  minFraction = 0.1,
): Int32Array {
  const keep: number[] = []
  const needed = Math.max(1, Math.ceil(n * minFraction))
  for (let r = 0; r < n; r++) {
    let seen = 0
    for (let c = 0; c < n; c++) if (Number.isFinite(values[r * n + c])) seen++
    if (seen >= needed) keep.push(r)
  }
  return Int32Array.from(keep)
}

/**
 * What each cell of a square is divided by — **cis and trans are two questions**.
 *
 * A square over one chromosome has one answer: the decay curve, read at the
 * separation of the two bins. A square over several has two, and conflating them
 * is the mistake that makes a genome-wide eigenvector meaningless.
 *
 * - A **cis** cell — both bins on one sequence — is divided by *that sequence's
 *   own* decay at that separation. Not a pooled one: a genome-wide curve divides
 *   a small chromosome by the average behaviour of the large ones, which shows up
 *   as a spurious gradient along the eigenvector.
 * - A **trans** cell has no separation at all. Genomic distance between two
 *   chromosomes is not a quantity, so there is no curve to read; the expectation
 *   is the **mean of that pair's own block**, which is what makes a trans cell a
 *   ratio comparable with a cis one. A per-pair mean rather than one global trans
 *   mean, because two chromosomes' mutual contact depends on how much of the
 *   nucleus they share and pooling would push every pair towards the average.
 *
 * `group` is which sequence each row of the square belongs to, and the groups are
 * **contiguous runs** of it — which is what lets a cis separation be `|col − row|`
 * rather than needing an absolute bin per row.
 */
export interface ExpectedPlan {
  /** Sequence index per row of the square; `n` long, non-decreasing. */
  group: Int32Array
  /** One decay curve per sequence, for the cells inside it. */
  cis: readonly ExpectedCurve[]
  /** Mean of each ordered pair's block, `k × k` row-major. `NaN` where empty. */
  trans: Float64Array
  /**
   * Which cells take part; the rest are gaps.
   *
   * `trans` is the one worth naming, because it is a method rather than a
   * filter. A **trans-only** correlation is what you compute when you do not
   * want the distance decay in the answer at all: the cis blocks carry a
   * near-diagonal that dominates every row, and dividing it out by an expected
   * curve is a correction rather than an absence. Excluding them makes the
   * eigenvector a statement about which sequences share a nuclear compartment
   * and nothing else — which is why it is the standard genome-wide call.
   *
   * `cis` here means *this square's* cis cells. It is not how a multi-sequence
   * cis-only run is done — see `analysis/run/compartments.ts`, which runs one
   * square per sequence for that, because a single square with its trans blocks
   * removed correlates to a **block-diagonal** matrix whose leading eigenvector
   * lives entirely on one chromosome and is zero on the rest.
   */
  contacts: 'cis' | 'trans' | 'both'
  /**
   * How many diagonals of the cis blocks to leave out, cooltools' `ignore_diags`.
   *
   * `0` keeps every cell; `1` drops the main diagonal; `2` drops it and the two
   * beside it — the rule is `|col − row| < ignoreDiags`, which is the same
   * arithmetic and the same spelling as the tool everybody compares against.
   *
   * It matters more here than the number suggests. The near-diagonal is where a
   * Hi-C map's self-ligation and unligated fragments end up, and those cells are
   * both the largest in the matrix and the least related to anything structural
   * — so a row's correlation with its neighbours is carried disproportionately
   * by the two or three cells nearest the diagonal, which say only that the two
   * bins are adjacent. Every chromosome's rows agree about that, so it enters the
   * eigenvector as a component that is really a picture of the diagonal.
   *
   * Trans cells have no separation and are never affected.
   */
  ignoreDiags: number
  /**
   * Bins in each sequence that is **circular**, `0` for one that is not; one
   * entry per group, absent for a square with no circular sequence in it.
   *
   * On a circle the separation between two bins is the shorter of the two ways
   * round (§8.15), and the decay curve in {@link cis} was accumulated that way —
   * so a cis cell must be looked up at the same separation, or its numerator
   * would be a circle's and its denominator a line's. Each group's rows are the
   * whole sequence in order, which is what makes `|col − row|` its separation
   * one way and the lap minus that the other.
   */
  laps?: Int32Array
}

/**
 * The separation a cis cell of the square is looked up at: the straight one, or
 * the short way round where its sequence is circular.
 */
export function cisSeparation(offset: number, lap: number): number {
  return lap > 0 ? Math.min(offset, lap - offset) : offset
}

/**
 * The plan a square over **one** sequence has: one curve, no trans.
 *
 * Not a special case in the arithmetic — it is the general one with `k = 1` — but
 * worth a name, because it is what a single-chromosome run and every test of the
 * chain builds.
 */
export function singleGroupPlan(n: number, curve: ExpectedCurve): ExpectedPlan {
  return {
    group: new Int32Array(n),
    cis: [curve],
    trans: Float64Array.from([Number.NaN]),
    contacts: 'both',
    ignoreDiags: 0,
  }
}

/**
 * The square as observed/expected, over the usable bins only.
 *
 * Row-major and `m × m` where `m` is `index.length`. A cell whose expected is
 * unknown — past the end of the curve, at an offset nothing was measured at, or
 * in a trans block with nothing in it — is `NaN` rather than the observed value:
 * dividing by an unknown and keeping the numerator would put raw counts and
 * ratios in the same matrix.
 */
export function observedOverExpected(
  values: Float32Array,
  n: number,
  index: Int32Array,
  plan: ExpectedPlan,
): Float64Array {
  const m = index.length
  const k = plan.cis.length
  const out = new Float64Array(m * m)
  for (let r = 0; r < m; r++) {
    const row = index[r]
    const rowGroup = plan.group[row]
    for (let c = 0; c < m; c++) {
      const col = index[c]
      const colGroup = plan.group[col]
      const same = rowGroup === colGroup
      // A cell the mode leaves out is a gap, exactly as a cell with no
      // expectation is: it takes no part in any correlation, rather than
      // entering one as a zero and asserting that these two bins do not touch.
      if (same ? plan.contacts === 'trans' : plan.contacts === 'cis') {
        out[r * m + c] = Number.NaN
        continue
      }
      const offset = same
        ? cisSeparation(Math.abs(col - row), plan.laps?.[rowGroup] ?? 0)
        : Math.abs(col - row)
      // …and the near-diagonal goes the same way, for the same reason and on the
      // same rule cooltools uses. Only in cis: a trans cell has no separation
      // for a diagonal to be measured from.
      if (same && offset < plan.ignoreDiags) {
        out[r * m + c] = Number.NaN
        continue
      }
      const observed = values[row * n + col]
      const denominator = same
        ? expectedAt(plan.cis[rowGroup], offset)
        : plan.trans[rowGroup * k + colGroup]
      out[r * m + c] =
        Number.isFinite(observed) && Number.isFinite(denominator) && denominator !== 0
          ? observed / denominator
          : Number.NaN
    }
  }
  return out
}

/**
 * The Pearson correlation between every pair of rows.
 *
 * This is the `m²` object §18.6 gates on, and it is built once and handed
 * straight to the eigensolver, which consumes it in place. The diagonal is
 * exactly 1 by construction rather than by computation — a row correlated with
 * itself over pairwise-complete cells is 1, and computing it invites a
 * floating-point 0.9999999 on the diagonal of a matrix that is about to be
 * deflated.
 */
export async function correlationMatrix(
  oe: Float64Array,
  m: number,
  /**
   * Called once per row, before it is correlated against the rows after it.
   *
   * This loop is `m²` correlations of `m` cells each — cubic, and the one step of
   * the chain that is. At a thousand bins it is a second and at four thousand it
   * is minutes, so a genome-wide run needs to be able to report where it has got
   * to and to be stopped: the callback is where the runner does both, by
   * throwing out of it. Optional, because nothing about the arithmetic needs it.
   *
   * **Awaited**, which is what makes the stopping real. A cancel arrives as a
   * message and a message is delivered in a task of its own, so a hook that
   * only ever ran synchronously asked about a cancel that could not yet have
   * been received however many times it asked (`analysis/job.ts`'s `breathe`).
   * The `await` is per *row* and the yield inside it is the runner's to make
   * every sixty-fourth, so the round trip is paid once a batch rather than
   * `m` times.
   */
  onRow?: (row: number) => void | Promise<void>,
): Promise<Float64Array> {
  const out = new Float64Array(m * m)
  const rows: Float64Array[] = []
  for (let r = 0; r < m; r++) rows.push(oe.subarray(r * m, (r + 1) * m))
  for (let r = 0; r < m; r++) {
    await onRow?.(r)
    out[r * m + r] = 1
    for (let c = r + 1; c < m; c++) {
      const value = pearson(rows[r], rows[c])
      // A pair with too little overlap gets 0 rather than NaN: the eigensolver
      // needs a real matrix, and *no evidence of correlation* is the honest
      // reading of two rows that never overlap. `pearson` returning NaN is what
      // distinguishes that from a computed zero, and it is why the substitution
      // happens here where it can be commented rather than inside the statistic.
      const filled = Number.isFinite(value) ? value : 0
      out[r * m + c] = filled
      out[c * m + r] = filled
    }
  }
  return out
}

/**
 * cooltools' ceiling on observed/expected: its 99.9th percentile, `eigs_cis`'s
 * default `clip_percentile`.
 */
export const COOLTOOLS_CLIP_PERCENTILE = 99.9

/**
 * The matrix cooltools decomposes (`cooltools.api.eigdecomp.cis_eig`), made from
 * the same observed/expected the correlation is made from.
 *
 * The default road to the eigenvectors (§18.8): observed/expected decomposed
 * **as it is**, where Lieberman-Aiden et al. (2009) decomposed the Pearson
 * correlation of its rows. The correlation did three things of its own, and
 * each is done here the way cooltools does it:
 *
 * - **clipped** — at 0 and at its 99.9th percentile, NumPy's linear one — so a
 *   handful of very bright cells cannot carry the leading component;
 * - **one subtracted**, so each cell is its departure from expected. The
 *   correlation centred every row and needed nothing of the kind; without it the
 *   leading eigenvector of an all-positive matrix is its rows' overall level, not
 *   the checkerboard;
 * - **every gap zero** — a cell with no value, and the near diagonal
 *   `ignoreDiags` removed — which after the subtraction reads *as expected*: a
 *   decomposition, unlike a correlation, cannot step over one.
 *
 * Over the usable bins alone, like the correlation: a bin the balancer dropped is
 * still left out rather than zeroed — cooltools zeroes it and then keeps the zero
 * row out of its solver, which comes to the same thing. The percentile is of the
 * cells that have a value; cooltools' also counts the dropped rows' zeros and the
 * ignored diagonals' ones, which moves the 99.9th by a hair.
 *
 * `oe` is `m × m` row-major and is left as it was — the saddle reads it later.
 */
export function cooltoolsMatrix(
  oe: Float64Array,
  m: number,
  percentile = COOLTOOLS_CLIP_PERCENTILE,
): Float64Array {
  const ceiling = upperPercentile(oe, percentile)
  const out = new Float64Array(m * m)
  for (let i = 0; i < m * m; i++) {
    const value = oe[i]
    out[i] = Number.isFinite(value) ? Math.min(Math.max(value, 0), ceiling) - 1 : 0
  }
  return out
}

/**
 * NumPy's `percentile` of the finite values — linear between the two nearest
 * ranks — from the top.
 *
 * Only the values at and above the rank are held, in a heap, rather than a sorted
 * copy of the square: at the 8,192-bin gate the square is half a gigabyte, and the
 * 99.9th percentile needs a thousandth of it.
 */
function upperPercentile(values: Float64Array, percentile: number): number {
  let n = 0
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++
  if (n === 0) return Number.NaN
  const at = (Math.min(100, Math.max(0, percentile)) / 100) * (n - 1)
  const rank = Math.floor(at)
  // A min-heap of the `n − rank` largest values: its root is the value at `rank`.
  const size = n - rank
  const heap = new Float64Array(size)
  let held = 0
  const down = (from: number, count: number): void => {
    let i = from
    for (;;) {
      const left = 2 * i + 1
      const right = left + 1
      let least = i
      if (left < count && heap[left] < heap[least]) least = left
      if (right < count && heap[right] < heap[least]) least = right
      if (least === i) return
      const swap = heap[i]
      heap[i] = heap[least]
      heap[least] = swap
      i = least
    }
  }
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) continue
    if (held < size) {
      let slot = held++
      heap[slot] = value
      while (slot > 0) {
        const parent = (slot - 1) >> 1
        if (heap[parent] <= heap[slot]) break
        const swap = heap[parent]
        heap[parent] = heap[slot]
        heap[slot] = swap
        slot = parent
      }
    } else if (value > heap[0]) {
      heap[0] = value
      down(0, held)
    }
  }
  const low = heap[0]
  const fraction = at - rank
  if (fraction === 0 || held < 2) return low
  // The next rank up is the smallest of what is left once the root is gone.
  heap[0] = heap[held - 1]
  down(0, held - 1)
  return low + (heap[0] - low) * fraction
}

/** What {@link correlationField} produces: a square the map can draw. */
export interface CorrelationField {
  /** `n * n`, row-major, `NaN` in every row and column that was dropped. */
  values: Float32Array
  /** Bins that took part. */
  kept: number
  /** Bins dropped for having too little data to correlate on. */
  dropped: number
}

/**
 * {@link correlationMatrix} over a **full square**, put back on the grid it came
 * from — the correlation map as a picture rather than as the eigensolver's
 * input.
 *
 * The same three steps the compartment chain takes, in the same order and
 * through the same two functions, which is the point: a reader looking at this
 * map is looking at the object their eigenvector was computed from, and a second
 * implementation "for display" would be a second answer that agreed with the
 * first until it did not.
 *
 * What is different is only the last step. The chain hands the correlation
 * straight to the solver over the usable index and expands the *eigenvector*
 * afterwards; a picture has to be expanded itself, and the expansion restores
 * the dropped bins **as gaps**. A dropped row drawn as zero would be a stripe of
 * "uncorrelated with everything" across a compartment map — the same false, and
 * far more visible, claim this module's header refuses to make about the track.
 *
 * `NaN` fills what the correlation could not reach. The raster draws it
 * transparent (§6.4), so a blank row on a correlation map means exactly what a
 * blank row on a balanced map means, and neither is a value.
 */
export async function correlationField(
  oe: Float32Array,
  n: number,
  onRow?: (row: number) => void | Promise<void>,
): Promise<CorrelationField> {
  const index = usableBins(oe, n)
  const m = index.length
  const values = new Float32Array(n * n).fill(Number.NaN)
  // Two bins cannot be correlated against each other and one cannot be
  // correlated at all. Returning the empty field rather than throwing: a block
  // with nothing usable in it is a legitimate thing to point the toggle at — a
  // sparse trans corner — and it should draw as blank, not as an error card.
  if (m < 2) return { values, kept: m, dropped: n - m }

  // The usable submatrix, packed. `Float64Array` because that is what
  // `correlationMatrix` takes, and it takes it because the sums inside `pearson`
  // are over `m` terms of a ratio whose tail is long.
  const packed = new Float64Array(m * m)
  for (let r = 0; r < m; r++) {
    const from = index[r] * n
    const to = r * m
    for (let c = 0; c < m; c++) packed[to + c] = oe[from + index[c]]
  }

  const correlation = await correlationMatrix(packed, m, onRow)

  for (let r = 0; r < m; r++) {
    const to = index[r] * n
    const from = r * m
    for (let c = 0; c < m; c++) values[to + index[c]] = correlation[from + c]
  }
  return { values, kept: m, dropped: n - m }
}

/** A signal the sign of a component is attached to, over the same bins. */
export interface PhasingSignal {
  name: string
  /** One value per *usable* bin, in the same order as the index. */
  values: Float64Array
}

export interface Phasing {
  /** Whether the component was flipped. */
  flipped: boolean
  /** The correlation the decision was made on. */
  r: number
  /** `false` when |r| was too small to decide. */
  confident: boolean
  signal: string
}

/**
 * Give a component's sign a meaning.
 *
 * Flips so that positive correlates with the signal, and says how strongly. The
 * threshold is the caller's, and below it nothing is flipped and `confident` is
 * `false` — because a sign chosen on an `r` of 0.04 is a coin flip wearing a
 * decision's clothes, and a reader comparing two chromosomes phased that way
 * would be comparing noise.
 */
export function phaseComponent(
  component: Float64Array,
  signal: PhasingSignal,
  threshold: number,
): Phasing {
  const r = pearson(component, signal.values)
  if (!Number.isFinite(r) || Math.abs(r) < threshold) {
    return { flipped: false, r: Number.isFinite(r) ? r : Number.NaN, confident: false, signal: signal.name }
  }
  const flipped = r < 0
  if (flipped) {
    for (let i = 0; i < component.length; i++) component[i] = -component[i]
  }
  return { flipped, r, confident: true, signal: signal.name }
}

/**
 * The saddle: observed/expected averaged by the compartment rank of both bins.
 *
 * Bins are sorted by their eigenvector value and cut into equal groups, and each
 * cell of the saddle is the mean O/E between two groups. The picture is the whole
 * compartment claim in one square — AA and BB bright at the corners, AB dark off
 * them — and the three numbers under it are what makes it a measurement.
 *
 * Quantiles of the *eigenvector*, not of the signal it was phased by: the
 * eigenvector is what the matrix says, and ranking by anything else would be
 * asking whether the matrix agrees with a track rather than what the matrix
 * itself contains.
 */
export function saddle(
  oe: Float64Array,
  m: number,
  component: Float64Array,
  bins: number,
): { values: Float32Array; edges: Float64Array; strength: { aa: number; bb: number; ab: number } } {
  const edges = quantileEdges(component, bins)
  const group = new Int32Array(m).fill(-1)
  for (let i = 0; i < m; i++) {
    const value = component[i]
    if (!Number.isFinite(value)) continue
    // The last group is closed at the top, so the maximum lands inside it
    // rather than in a group that does not exist.
    let g = 0
    while (g < bins - 1 && value >= edges[g + 1]) g++
    group[i] = g
  }

  const sum = new Float64Array(bins * bins)
  const count = new Float64Array(bins * bins)
  for (let r = 0; r < m; r++) {
    const gr = group[r]
    if (gr < 0) continue
    for (let c = 0; c < m; c++) {
      const gc = group[c]
      if (gc < 0) continue
      const value = oe[r * m + c]
      if (!Number.isFinite(value)) continue
      sum[gr * bins + gc] += value
      count[gr * bins + gc] += 1
    }
  }
  const values = new Float32Array(bins * bins)
  for (let i = 0; i < values.length; i++) {
    values[i] = count[i] > 0 ? sum[i] / count[i] : Number.NaN
  }

  // The corners, over the extreme fifth of the range at each end — which is the
  // conventional reading and is what makes the three numbers comparable between
  // runs at different quantile counts.
  const edge = Math.max(1, Math.round(bins / 5))
  const mean = (r0: number, r1: number, c0: number, c1: number): number => {
    let total = 0
    let seen = 0
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const value = values[r * bins + c]
        if (!Number.isFinite(value)) continue
        total += value
        seen++
      }
    }
    return seen === 0 ? Number.NaN : total / seen
  }
  return {
    values,
    edges,
    strength: {
      // `bb` is the *low* end of the eigenvector and `aa` the high one, which is
      // only meaningful once the component has been phased — the saddle inherits
      // whatever meaning phasing gave the sign, and inherits its uncertainty too.
      bb: mean(0, edge, 0, edge),
      aa: mean(bins - edge, bins, bins - edge, bins),
      ab: mean(0, edge, bins - edge, bins),
    },
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** One run of bins that E1 puts on the same side of zero. */
export interface CompartmentSegment {
  /** `'A'` where E1 is positive, `'B'` where it is negative. */
  side: 'A' | 'B'
  /** First and last bin of the run, **inclusive**, in the index's own numbering. */
  from: number
  to: number
  /** Mean of E1 over the run — the strength of the call. */
  mean: number
  /** How many bins are in it. */
  bins: number
}

/**
 * E1's sign, as **A and B segments** — the compartment call the track implies.
 *
 * The eigenvector is a number per bin and the thing everybody actually cites is
 * the interval: *this arm is A, that half-megabase is B*. Getting from one to
 * the other meant exporting the bigWig and thresholding it somewhere else, which
 * is a second tool for one comparison against zero — and one this app can make
 * without the ambiguity a downstream threshold introduces, because it knows
 * which bins were excluded and does not have to guess whether a gap is a zero.
 *
 * Three rules, and each is a way the naive version would be wrong.
 *
 * **A run is consecutive bins**, and consecutive means consecutive in the file's
 * own numbering rather than in the index. `index` holds only the bins that
 * carried enough data to correlate, so two entries beside each other in it can
 * be a megabase apart on the chromosome; joining them would draw a segment
 * across a stretch that took no part in the calculation and assert a compartment
 * there.
 *
 * **Zero and `NaN` end a run and start nothing.** A bin at exactly zero is not
 * evidence of A, and a bin with no value is not evidence of anything.
 *
 * **The mean is carried**, so the call has a strength: it becomes the BED's
 * score column, which is what lets an overlay be filtered on it and what a
 * downstream tool sorts by.
 *
 * @param index Bins that took part, ascending, in the file's own numbering.
 * @param vector E1 over those bins, one value per entry of `index`.
 */
export function compartmentSegments(
  index: Int32Array,
  vector: Float64Array,
): CompartmentSegment[] {
  const out: CompartmentSegment[] = []
  let from = -1
  let last = -1
  let side: 1 | -1 | 0 = 0
  let total = 0
  let bins = 0

  const flush = (): void => {
    if (from >= 0 && side !== 0) {
      out.push({
        side: side > 0 ? 'A' : 'B',
        from,
        to: last,
        mean: bins === 0 ? Number.NaN : total / bins,
        bins,
      })
    }
    from = -1
    total = 0
    bins = 0
  }

  for (let i = 0; i < index.length && i < vector.length; i++) {
    const bin = index[i]
    const value = vector[i]
    const next: 1 | -1 | 0 = Number.isFinite(value) && value > 0 ? 1 : value < 0 ? -1 : 0
    if (next !== side || bin !== last + 1) flush()
    side = next
    last = bin
    if (next === 0) continue
    if (from < 0) from = bin
    total += value
    bins++
  }
  flush()
  return out
}

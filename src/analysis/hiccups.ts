/**
 * Loop calling: HiCCUPS, as `cooltools.dots` computes it (§18.8, §18.9).
 *
 * Rao et al.'s caller (Cell 159:1665, 2014) asks of every pixel whether it holds
 * more contacts than its neighbourhood says it should. The neighbourhood is four
 * shapes about the pixel — a **donut**, a **vertical** and a **horizontal** bar
 * and the **lower-left** quarter, towards the diagonal — each of which gives a
 * locally adjusted expected: the map's own expected at the pixel's separation,
 * times what the shape holds over what the expected says it should hold. A pixel
 * is tested against each of the four with a Poisson tail, the tests are
 * corrected for multiplicity separately within chunks of similar expected
 * (λ-chunks, because a single correction over every pixel of a map would be
 * ruled by the near-diagonal ones), the pixels that pass all four are grouped
 * into clusters, and each cluster's brightest pixel is a loop if it clears the
 * enrichment and q-value filters Rao et al. tuned.
 *
 * ## The upstream, exactly
 *
 * cooltools 0.7.1's `api/dotfinder.py` — `dots()` with its defaults — and
 * nothing of this app's own: the kernels are `get_kernel`'s, the per-pixel
 * arithmetic is `get_adjusted_expected_tile_some_nans`' in its order, the
 * pixels scored are those `score_tile` keeps, the histograms, thresholds and
 * q-values are `histogram_scored_pixels` and `determine_thresholds`', the
 * clustering is `clust_2D_pixels`' sklearn BIRCH (`analysis/birch.ts`) and the
 * filter is `cluster_filtering_hiccups`. The Poisson tail is SciPy's
 * (`analysis/poisson.ts`) and the λ-chunk edges numpy's
 * (`analysis/hiccupsTables.ts`). `test/golden/analysis/hiccups.json` is the
 * package's own output at each of those stages.
 *
 * ## What is the same, and what is only equivalent
 *
 * Three things `dots` does are not done here, because their answer is the same
 * without them, and each is argued where it would be:
 *
 * - **No tiles.** `dots` convolves 5 Mb tiles padded by the kernel's half-width
 *   and counts a footprint cell outside its tile as missing. With its default
 *   `max_nans_tolerated = 1` — no missing cell in any of the four footprints —
 *   a pixel is kept only in the tile whose padding holds its whole footprint,
 *   and there its numbers are the whole map's. So a pixel is scored here exactly
 *   when its four footprints lie inside the sequence and touch nothing missing,
 *   which is the answer every tiling gives. The setting is not offered: any
 *   other value makes `dots`' answer depend on where its tiles fall, or raise.
 * - **One pass, not two.** `dots` scores every pixel once to build the
 *   histograms and again to extract the significant ones, because it keeps
 *   nothing between. A pixel can pass a chunk's threshold only if its count's
 *   Poisson tail is already below the FDR — the threshold is the first count
 *   where `fdr × (pixels at least that bright)` reaches `pixels × tail`, and
 *   there are never more pixels at least that bright than pixels — so the one
 *   pass keeps those, a few per cent of the map, and the thresholds sort them.
 * - **The expected is computed, not read.** `dots` takes `expected_cis`'s
 *   table; this computes that table's `balanced.avg` for each sequence from the
 *   band it reads, as `expected_cis` defines it at its defaults: balanced
 *   contacts over the valid bin pairs of each diagonal, the first two left out.
 */

import { birch } from './birch'
import {
  HICCUPS_KERNELS,
  MAX_LAMBDA_BINS,
  MIN_LAMBDA_BINS,
  footprintOf,
  type KernelShape,
} from './hiccupsShape'
import { LAMBDA_EDGES } from './hiccupsTables'
import { poissonSf } from './poisson'

// ---------------------------------------------------------------------------
// The kernels
// ---------------------------------------------------------------------------

export {
  HICCUPS_KERNELS,
  MAX_LAMBDA_BINS,
  MIN_LAMBDA_BINS,
  footprintOf,
  kernelMatrix,
  recommendedKernel,
  type Footprint,
  type HiccupsKernel,
  type KernelShape,
} from './hiccupsShape'

// ---------------------------------------------------------------------------
// λ-chunks
// ---------------------------------------------------------------------------

/**
 * The upper edges of `n` λ-chunks: `2^(k/3)` for `k < n`, as numpy computed them.
 *
 * `dots` cuts at `[-inf, edges…, inf]`, so there are `n + 1` chunks and the last,
 * past `2^((n − 1)/3)`, must stay empty — it raises if a pixel lands there.
 */
export function lambdaEdges(n: number): Float64Array {
  if (!Number.isInteger(n) || n < MIN_LAMBDA_BINS || n > MAX_LAMBDA_BINS) {
    throw new RangeError(`cooltools takes ${MIN_LAMBDA_BINS} to ${MAX_LAMBDA_BINS} λ-chunks, not ${n}`)
  }
  return Float64Array.from(LAMBDA_EDGES.slice(0, n))
}

/**
 * The edges of the chunks' **labels**, which is not the same thing as the edges.
 *
 * `pd.cut(x, edges)` puts each value in its chunk by the edges themselves, and
 * then names the chunks `Interval`s whose ends are the edges rounded for display
 * — to three decimals, or as many more as keep them distinct (`_format_labels`,
 * `_infer_precision`, `_round_frac`). `dots` reads those names back: the λ its
 * Poisson tail is taken at is a label's right end, `161.27` and not
 * `161.26989…`, and `annotate_pixels_with_qvalues` cuts the pixels again by the
 * labels to find their q-values. So both are reproduced, rounding and all —
 * `np.around`, which multiplies by `10^d`, rounds half to even and divides.
 */
export function labelEdges(edges: Float64Array): Float64Array {
  const rint = (x: number): number => {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }
  const roundFrac = (x: number, precision: number): number => {
    if (!Number.isFinite(x) || x === 0) return x
    const whole = Math.trunc(x)
    const digits =
      whole === 0 ? -Math.floor(Math.log10(Math.abs(x - whole))) - 1 + precision : precision
    const scale = Math.pow(10, Math.abs(digits))
    return digits >= 0 ? rint(x * scale) / scale : rint(x / scale) * scale
  }
  // `_infer_precision(3, bins)` over the bins `pd.cut` was handed, ±∞ included.
  let precision = 3
  for (let p = 3; p < 20; p++) {
    const rounded = Array.from(edges, (edge) => roundFrac(edge, p))
    if (new Set(rounded).size === edges.length) {
      precision = p
      break
    }
  }
  return Float64Array.from(edges, (edge) => roundFrac(edge, precision))
}

/**
 * The chunk a locally adjusted expected falls in, as `pd.cut(x, [-inf, …edges, inf])`
 * labels it: right-closed, so a value equal to an edge is in the chunk below it.
 */
export function lambdaChunk(value: number, edges: Float64Array): number {
  const n = edges.length
  if (!(value > edges[0])) return 0
  // The edges are 2^(k/3), so a value's binary exponent puts it within a few
  // edges of its chunk, and the exact edges then settle it: the exponent saves
  // the search and never decides it.
  EXPONENT[0] = value
  let at = 3 * (((EXPONENT_WORDS[EXPONENT_HIGH] >>> 20) & 0x7ff) - 1023)
  if (at > n) at = n
  if (at < 1) at = 1
  while (at > 0 && edges[at - 1] >= value) at--
  while (at < n && edges[at] < value) at++
  return at
}

const EXPONENT = new Float64Array(1)
const EXPONENT_WORDS = new Uint32Array(EXPONENT.buffer)
/** Which of the two words holds the exponent, on this platform's byte order. */
const EXPONENT_HIGH = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0

// ---------------------------------------------------------------------------
// The expected
// ---------------------------------------------------------------------------

/** `expected_cis`' default, and the diagonals `dots` therefore never scores near. */
export const IGNORE_DIAGS = 2

/** One sequence's raw contacts as a band: the cell `offset` along from `row`. */
export interface RawBand {
  /** Bins in the sequence. */
  n: number
  /** Widest offset held. */
  hi: number
  /** `values[offset * n + row]`: the raw count, `NaN` where nothing was read. */
  values: ArrayLike<number>
}

/**
 * `expected_cis(clr, ignore_diags=2)`'s `balanced.avg` for one sequence, `0 … hi`.
 *
 * The balanced contacts of each diagonal — `count × w₁ × w₂`, in that order, as
 * its transform multiplies — summed over the pixels both of whose bins kept a
 * weight, over the number of such bin pairs on the diagonal (`n_valid`), and
 * `NaN` on the first two diagonals and wherever a diagonal has no valid pair.
 * Summed with pandas' compensated sum, row by row, which is the order the pixel
 * table holds them in.
 */
export function expectedCis(
  band: RawBand,
  weights: ArrayLike<number>,
  ignoreDiags = IGNORE_DIAGS,
): { avg: Float64Array; nValid: Float64Array; sum: Float64Array } {
  const { n, hi, values } = band
  const avg = new Float64Array(hi + 1)
  const nValid = new Float64Array(hi + 1)
  const sum = new Float64Array(hi + 1)
  for (let d = 0; d <= hi; d++) {
    let total = 0
    let compensation = 0
    let valid = 0
    for (let i = 0; i + d < n; i++) {
      const wi = weights[i]
      const wj = weights[i + d]
      if (Number.isNaN(wi) || Number.isNaN(wj)) continue
      valid++
      const count = values[d * n + i]
      if (!(count !== 0) || Number.isNaN(count)) continue
      const y = count * wi * wj - compensation
      const t = total + y
      compensation = t - total - y
      total = t
    }
    nValid[d] = valid
    sum[d] = total
    avg[d] = d < ignoreDiags ? Number.NaN : total / valid
  }
  return { avg, nValid, sum }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Rows scored between two chances to report progress and notice a cancel. */
const ROWS_PER_PAUSE = 256

/** What one scored pixel is handed to: its place, its count, and its four λ. */
export type OnScored = (
  row: number,
  col: number,
  count: number,
  donut: number,
  vertical: number,
  horizontal: number,
  lowleft: number,
) => void

/**
 * Every pixel `score_tile` keeps, for one sequence, with its four locally adjusted expecteds.
 *
 * A pixel `(i, j)` is scored where `0 < j − i < maxSeparation` (`dots`'
 * `max_loci_separation` in bins) and every cell of every footprint is inside the
 * sequence, on a bin that kept its weight, on or above the second diagonal and on
 * a diagonal the expected has a value for — `max_nans_tolerated = 1`, every
 * footprint clean — and where `KO / KE` is finite for every kernel. Its λ for a
 * kernel is
 *
 *     E[j − i] / (wᵢ wⱼ) × (Σ O_bal over the footprint) / (Σ E_bal over it)
 *
 * with `O_bal = count × (wᵢ wⱼ)`, each sum in `convolve`'s order. A footprint on
 * clean cells has the expected of each cell's own diagonal in it and nothing
 * else, so its `KE` is a property of the separation alone and is summed once a
 * separation rather than once a pixel.
 *
 * Rows are walked in order and each pixel's footprint is read from a ring of the
 * `2w + 1` balanced rows about it, so nothing the size of the band is balanced
 * twice or held twice.
 */
export async function scoreSequence(
  band: RawBand,
  weights: ArrayLike<number>,
  expected: Float64Array,
  shape: KernelShape,
  maxSeparation: number,
  onScored: OnScored,
  pause?: (row: number) => Promise<void> | void,
): Promise<number> {
  const { n, hi, values } = band
  const { w } = shape
  const footprints = HICCUPS_KERNELS.map((type) => footprintOf(shape, type))
  const span = Math.min(maxSeparation, n)

  // Bad bins, counted so a window of them is two lookups.
  const badBefore = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) badBefore[i + 1] = badBefore[i] + (Number.isNaN(weights[i]) ? 1 : 0)
  const clean = (centre: number): boolean =>
    centre - w >= 0 && centre + w < n && badBefore[centre + w + 1] - badBefore[centre - w] === 0

  // Separations whose every footprint cell sits on a diagonal with an expected
  // — at or past the second, and inside what was read — and each kernel's KE there.
  let lowest = 0
  let highest = 0
  for (const footprint of footprints) {
    for (const dd of footprint.dd) {
      lowest = Math.min(lowest, dd)
      highest = Math.max(highest, dd)
    }
  }
  const ke = footprints.map(() => new Float64Array(span))
  const usable = new Uint8Array(span)
  for (let d = 1; d < span; d++) {
    if (d + lowest < 0 || d + highest > hi) continue
    let ok = Number.isFinite(expected[d])
    for (let k = 0; ok && k < footprints.length; k++) {
      const dd = footprints[k].dd
      let sum = 0
      for (let c = 0; c < dd.length; c++) {
        const e = expected[d + dd[c]]
        if (!Number.isFinite(e)) {
          ok = false
          break
        }
        sum += e
      }
      ke[k][d] = sum
    }
    usable[d] = ok ? 1 : 0
  }

  // The ring of balanced rows: slot `r mod (2w + 1)` holds row r, offset by offset.
  const slots = 2 * w + 1
  const stride = hi + 1
  const ring = new Float64Array(slots * stride)
  const loadRow = (r: number): void => {
    const base = (r % slots) * stride
    const wr = weights[r]
    for (let off = 0; off <= hi; off++) {
      const c = r + off
      ring[base + off] = c < n ? values[off * n + r] * (wr * weights[c]) : Number.NaN
    }
  }
  // Every kernel's cells in one list, kernel after kernel, each as its place in
  // the ring relative to the pixel's offset — recomputed once a row — and the
  // KE of each kernel at each separation in one array beside it.
  const ends = new Int32Array(4)
  let total = 0
  footprints.forEach((footprint, k) => (ends[k] = total += footprint.dr.length))
  const rowOf = new Int32Array(total)
  const deltaOf = new Int32Array(total)
  footprints.forEach((footprint, k) => {
    const from = k === 0 ? 0 : ends[k - 1]
    rowOf.set(footprint.dr, from)
    deltaOf.set(footprint.dd, from)
  })
  const cells = new Int32Array(total)
  const keAt = new Float64Array(4 * span)
  for (let k = 0; k < 4; k++) keAt.set(ke[k], k * span)
  // A bin whose ±w window is clean, once a sequence rather than once a pixel.
  const cleanBin = new Uint8Array(n)
  for (let b = 0; b < n; b++) cleanBin[b] = clean(b) ? 1 : 0
  const slotOf = new Int32Array(slots)
  const quad = new Float64Array(16)

  let scored = 0
  for (let r = 0; r < Math.min(n, w); r++) loadRow(r)
  for (let i = 0; i < n; i++) {
    if (i + w < n) loadRow(i + w)
    // Between rows, now and then, so a run over a chromosome can be watched and stopped.
    if (pause !== undefined && i % ROWS_PER_PAUSE === 0) await pause(i)
    if (cleanBin[i] === 0) continue
    for (let dr = -w; dr <= w; dr++) slotOf[dr + w] = ((i + dr) % slots) * stride
    for (let c = 0; c < total; c++) cells[c] = slotOf[rowOf[c] + w] + deltaOf[c]
    const wi = weights[i]
    const last = Math.min(span - 1, n - 1 - w - i)
    // Every footprint cell of a separation in [dLo, dHi] is inside the ring.
    const dLo = Math.max(1, -lowest)
    const dHi = Math.min(last, hi - highest)
    const emit = (d: number, donut: number, vertical: number, horizontal: number, lowleft: number): void => {
      if (usable[d] === 0 || cleanBin[i + d] === 0) return
      if (
        !Number.isFinite(donut) ||
        !Number.isFinite(vertical) ||
        !Number.isFinite(horizontal) ||
        !Number.isFinite(lowleft)
      ) {
        return
      }
      const eRaw = expected[d] / (wi * weights[i + d])
      scored++
      onScored(i, i + d, values[d * n + i], eRaw * donut, eRaw * vertical, eRaw * horizontal, eRaw * lowleft)
    }
    let d = dLo
    // Four pixels at a time, each summed in its own chain and in `convolve`'s
    // order — so every sum is bit for bit what it is alone, and the four chains
    // overlap where one would wait on its own last addition.
    for (; d + 3 <= dHi; d += 4) {
      let c = 0
      for (let k = 0; k < 4; k++) {
        const end = ends[k]
        let a0 = 0
        let a1 = 0
        let a2 = 0
        let a3 = 0
        for (; c < end; c++) {
          const at = cells[c] + d
          a0 += ring[at]
          a1 += ring[at + 1]
          a2 += ring[at + 2]
          a3 += ring[at + 3]
        }
        const ke = k * span + d
        quad[k] = a0 / keAt[ke]
        quad[4 + k] = a1 / keAt[ke + 1]
        quad[8 + k] = a2 / keAt[ke + 2]
        quad[12 + k] = a3 / keAt[ke + 3]
      }
      emit(d, quad[0], quad[1], quad[2], quad[3])
      emit(d + 1, quad[4], quad[5], quad[6], quad[7])
      emit(d + 2, quad[8], quad[9], quad[10], quad[11])
      emit(d + 3, quad[12], quad[13], quad[14], quad[15])
    }
    for (; d <= dHi; d++) {
      let c = 0
      for (let k = 0; k < 4; k++) {
        const end = ends[k]
        let a = 0
        for (; c < end; c++) a += ring[cells[c] + d]
        quad[k] = a / keAt[k * span + d]
      }
      emit(d, quad[0], quad[1], quad[2], quad[3])
    }
  }
  return scored
}

// ---------------------------------------------------------------------------
// The histograms, and the thresholds they give
// ---------------------------------------------------------------------------

/** Counts below this are a row of an array; above it, of a map. */
const DENSE_COUNTS = 1 << 14

/**
 * `histogram_scored_pixels`, summed over the run: per kernel, how many scored
 * pixels have each observed count in each λ-chunk.
 *
 * Indexed densely by count for the whole counts every map stores, with a map
 * beside it for any other — a balanced file's raw column is integers, but a
 * container is free to store a float.
 */
export class LambdaHistogram {
  readonly chunks: number
  private dense = new Float64Array(0)
  private denseRows = 0
  private readonly sparse = new Map<number, Float64Array>()

  constructor(readonly edges: Float64Array) {
    this.chunks = edges.length + 1
  }

  private row(count: number): { cells: Float64Array; at: number } {
    if (Number.isInteger(count) && count >= 0 && count < DENSE_COUNTS) {
      if (count >= this.denseRows) {
        const rows = Math.min(DENSE_COUNTS, Math.max(count + 1, this.denseRows * 2, 64))
        const next = new Float64Array(rows * 4 * this.chunks)
        next.set(this.dense)
        this.dense = next
        this.denseRows = rows
      }
      return { cells: this.dense, at: count * 4 * this.chunks }
    }
    let cells = this.sparse.get(count)
    if (cells === undefined) {
      cells = new Float64Array(4 * this.chunks)
      this.sparse.set(count, cells)
    }
    return { cells, at: 0 }
  }

  /** One pixel: its count, and the chunk each of its four λ fell in. */
  add(count: number, c0: number, c1: number, c2: number, c3: number): void {
    const chunks = this.chunks
    let cells: Float64Array
    let at: number
    if (Number.isInteger(count) && count >= 0 && count < this.denseRows) {
      cells = this.dense
      at = count * 4 * chunks
    } else {
      const row = this.row(count)
      cells = row.cells
      at = row.at
    }
    cells[at + c0]++
    cells[at + chunks + c1]++
    cells[at + 2 * chunks + c2]++
    cells[at + 3 * chunks + c3]++
  }

  /**
   * Per kernel, `[counts present, ascending; pixels per count and chunk]` — the
   * frame `determine_thresholds` is handed, its index every count any pixel had.
   */
  table(): { counts: Float64Array; cells: Float64Array[] } {
    const counts: number[] = []
    for (let c = 0; c < this.denseRows; c++) {
      const at = c * 4 * this.chunks
      let any = false
      for (let x = 0; x < this.chunks && !any; x++) any = this.dense[at + x] > 0
      if (any) counts.push(c)
    }
    for (const [count, cells] of this.sparse) {
      let any = false
      for (let x = 0; x < this.chunks && !any; x++) any = cells[x] > 0
      if (any) counts.push(count)
    }
    counts.sort((a, b) => a - b)
    const cells = HICCUPS_KERNELS.map(() => new Float64Array(counts.length * this.chunks))
    counts.forEach((count, r) => {
      const { cells: source, at } = this.row(count)
      for (let k = 0; k < 4; k++) {
        cells[k].set(source.subarray(at + k * this.chunks, at + (k + 1) * this.chunks), r * this.chunks)
      }
    })
    return { counts: Float64Array.from(counts), cells }
  }
}

/** `determine_thresholds` for one kernel: a count to reach per chunk, and the q-values. */
export interface KernelThresholds {
  /** Per chunk up to the last non-empty one: the count a pixel must reach. */
  thresholds: Float64Array
  /** The q-value of a count in a chunk; `NaN` where `dots` has none. */
  qvalue(count: number, chunk: number): number
}

/**
 * `determine_thresholds`, kernel by kernel.
 *
 * For a chunk of `N` pixels whose upper edge is `λ`, at each count `c` present in
 * the run: `R(c)`, the chunk's pixels at least that bright; `N · sf(c, λ)`, how
 * many a Poisson(λ) would give; the threshold the first `c` at which the running
 * maximum of `fdr · R(c) − N · sf(c, λ)` reaches zero (or one past the brightest
 * count, where it never does); and the q-value the running minimum of
 * `N · sf(c, λ) / R(c)`, capped at one. `sf(c, λ)` is SciPy's `P(X > c)`, which
 * is what `dots` uses — not `P(X ≥ c)`.
 *
 * `null` where a pixel landed in the last chunk, past the last edge, which `dots`
 * raises on rather than test.
 */
export function determineThresholds(
  histogram: LambdaHistogram,
  fdr: number,
): { kernels: KernelThresholds[]; counts: Float64Array; overflow: number } {
  const { counts, cells } = histogram.table()
  const chunks = histogram.chunks
  const rows = counts.length
  // The Poisson λ of a chunk is its label's right end (see `labelEdges`).
  const labels = labelEdges(histogram.edges)
  // Every pixel adds one to each kernel, so a count is present in all four or none.
  let overflow = 0
  for (let k = 0; k < 4; k++) {
    let last = 0
    for (let r = 0; r < rows; r++) last += cells[k][r * chunks + chunks - 1]
    overflow = Math.max(overflow, last)
  }
  const high = rows === 0 ? 1 : counts[rows - 1] + 1
  const rowOf = new Map<number, number>()
  counts.forEach((count, r) => rowOf.set(count, r))

  // The tail is the same for every kernel: one column of it per chunk, computed
  // as far down the counts as some kernel needs it.
  const tails: (Float64Array | null)[] = new Array(chunks).fill(null)
  const tail = (chunk: number): Float64Array => {
    let column = tails[chunk]
    if (column === null) {
      column = new Float64Array(rows)
      const lambda = labels[chunk]
      let zero = false
      for (let r = 0; r < rows; r++) {
        // Once the tail has underflowed it stays at zero for every larger count.
        column[r] = zero ? 0 : poissonSf(counts[r], lambda)
        if (column[r] === 0) zero = true
      }
      tails[chunk] = column
    }
    return column
  }

  const kernels = cells.map((hist): KernelThresholds => {
    // Trailing empty chunks are dropped; the last chunk is empty or `dots` raised.
    let lastNonEmpty = -1
    for (let x = 0; x < chunks; x++) {
      for (let r = 0; r < rows; r++) {
        if (hist[r * chunks + x] > 0) {
          lastNonEmpty = x
          break
        }
      }
    }
    const width = Math.max(0, Math.min(lastNonEmpty + 1, chunks - 1))
    const thresholds = new Float64Array(width)
    const q = new Float64Array(rows * width)
    for (let x = 0; x < width; x++) {
      // Reverse cumulative counts, then the chunk's total.
      const rcs = new Float64Array(rows)
      let running = 0
      for (let r = rows - 1; r >= 0; r--) {
        running += hist[r * chunks + x]
        rcs[r] = running
      }
      const norm = rows === 0 ? 0 : rcs[0]
      const sf = tail(x)
      let max = Number.NEGATIVE_INFINITY
      let threshold = Number.NaN
      let min = Number.NaN
      for (let r = 0; r < rows; r++) {
        const unit = norm * sf[r]
        const diff = fdr * rcs[r] - unit
        if (diff > max) max = diff
        if (Number.isNaN(threshold) && max >= 0) threshold = counts[r]
        const ratio = unit / rcs[r]
        if (!Number.isNaN(ratio) && !(ratio >= min)) min = ratio
        const value = Number.isNaN(ratio) ? Number.NaN : min
        q[r * width + x] = value > 1 ? 1 : value
      }
      thresholds[x] = Math.trunc(Number.isNaN(threshold) ? high : threshold)
    }
    return {
      thresholds,
      qvalue(count: number, chunk: number): number {
        const r = rowOf.get(count)
        if (r === undefined || chunk >= width) return Number.NaN
        return q[r * width + chunk]
      },
    }
  })
  return { kernels, counts, overflow }
}

/**
 * The least count a pixel in each chunk could pass at, before any threshold is known.
 *
 * A chunk's threshold is a count `c` with `fdr · R(c) ≥ N · sf(c, λ)` at or below
 * it, and `R(c) ≤ N`, so a passing pixel's own tail is at most the FDR. Kept a
 * hair loose (one part in a billion) so the bound can never be the one that
 * rounds a pixel out. The last chunk, which `dots` refuses, admits nothing.
 */
export function candidateFloors(edges: Float64Array, fdr: number): Float64Array {
  const labels = labelEdges(edges)
  const floors = new Float64Array(edges.length + 1).fill(Number.POSITIVE_INFINITY)
  const loose = fdr * (1 + 1e-9)
  for (let x = 0; x < labels.length; x++) {
    let c = 0
    while (poissonSf(c, labels[x]) > loose) c++
    floors[x] = c
  }
  return floors
}

// ---------------------------------------------------------------------------
// Clusters, and the HiCCUPS filter
// ---------------------------------------------------------------------------

/** An enriched pixel: one `dots` would extract, with what it was scored at. */
export interface EnrichedPixel {
  /** Index of its sequence in the run. */
  sequence: number
  /** Bins within the sequence. */
  bin1: number
  bin2: number
  count: number
  /** Locally adjusted expected per kernel, in {@link HICCUPS_KERNELS}' order. */
  laExp: [number, number, number, number]
  /** q-value per kernel, likewise. */
  qval: [number, number, number, number]
}

/** A pixel with its cluster: what `clustering_step` annotates. */
export interface ClusteredPixel extends EnrichedPixel {
  /** BIRCH's label: the nearest subcluster's index within its sequence. */
  cLabel: number
  /** Pixels sharing that label. */
  cSize: number
  /** The subcluster's centroid, in base pairs from the sequence's start. */
  cStart1: number
  cStart2: number
}

/**
 * `clustering_step`: every enriched pixel's cluster, then each cluster's brightest.
 *
 * Sequence by sequence — `dots` clusters within a region and its regions are
 * whole chromosomes — with each pixel at its two starts in base pairs and the
 * pixels in the order they arrive, which is `dots`' (by row, then column). The
 * brightest pixel is the first of the highest count, as `idxmax` picks it.
 */
export function clusterPixels(
  pixels: readonly EnrichedPixel[],
  binsize: number,
  radius: number,
): { pixels: ClusteredPixel[]; centroids: ClusteredPixel[] } {
  const bySequence = new Map<number, EnrichedPixel[]>()
  for (const pixel of pixels) {
    let list = bySequence.get(pixel.sequence)
    if (list === undefined) bySequence.set(pixel.sequence, (list = []))
    list.push(pixel)
  }
  const clustered: ClusteredPixel[] = []
  const centroids: ClusteredPixel[] = []
  for (const [, list] of [...bySequence].sort((a, b) => a[0] - b[0])) {
    const points = new Float64Array(list.length * 2)
    list.forEach((pixel, k) => {
      points[2 * k] = pixel.bin1 * binsize
      points[2 * k + 1] = pixel.bin2 * binsize
    })
    const { labels, centers } = birch(points, radius)
    const sizes = new Map<number, number>()
    for (const label of labels) sizes.set(label, (sizes.get(label) ?? 0) + 1)
    const brightest = new Map<number, ClusteredPixel>()
    list.forEach((pixel, k) => {
      const label = labels[k]
      const entry: ClusteredPixel = {
        ...pixel,
        cLabel: label,
        cSize: sizes.get(label) ?? 0,
        cStart1: centers[2 * label],
        cStart2: centers[2 * label + 1],
      }
      clustered.push(entry)
      const held = brightest.get(label)
      if (held === undefined || entry.count > held.count) brightest.set(label, entry)
    })
    centroids.push(...[...brightest.values()].sort((a, b) => a.cLabel - b.cLabel))
  }
  return { pixels: clustered, centroids }
}

/** `cluster_filtering_hiccups`' defaults, Rao et al.'s numbers. */
export const HICCUPS_FILTER = {
  vh: 1.5,
  dAndLl: 1.75,
  dOrLl: 2.0,
  orphanFdr: 0.02,
} as const

/**
 * `cluster_filtering_hiccups`: whether a cluster's brightest pixel is a loop.
 *
 * Enriched over the donut and the lower-left by 1.75 and over the two bars by
 * 1.5, over one of the first two by 2, and — for a cluster of one pixel — at a
 * q-value of at most 0.02 summed over the four kernels.
 */
export function passesHiccupsFilter(call: ClusteredPixel): boolean {
  const [donut, vertical, horizontal, lowleft] = call.laExp
  const [qDonut, qVertical, qHorizontal, qLowleft] = call.qval
  const count = call.count
  return (
    count > HICCUPS_FILTER.dAndLl * lowleft &&
    count > HICCUPS_FILTER.dAndLl * donut &&
    count > HICCUPS_FILTER.vh * vertical &&
    count > HICCUPS_FILTER.vh * horizontal &&
    (count > HICCUPS_FILTER.dOrLl * lowleft || count > HICCUPS_FILTER.dOrLl * donut) &&
    (call.cSize > 1 || qLowleft + qDonut + qVertical + qHorizontal <= HICCUPS_FILTER.orphanFdr)
  )
}

// ---------------------------------------------------------------------------
// One run, sequence by sequence
// ---------------------------------------------------------------------------

/** What `dots` is asked, in the units a run holds them in. */
export interface DotsSettings {
  shape: KernelShape
  /** `max_loci_separation` in bins: a pixel `(i, j)` is scored where `j − i` is below it. */
  maxSeparation: number
  /** `n_lambda_bins`. */
  lambdaBins: number
  /** `lambda_bin_fdr`. */
  fdr: number
  /** `clustering_radius` in base pairs, or 0 for none — every enriched pixel, unfiltered. */
  clusteringRadius: number
  /** `cluster_filtering`. */
  clusterFiltering: boolean
}

/** Everything one run produced, stage by stage. */
export interface DotsResult {
  /** Pixels scored, over every sequence. */
  scored: number
  /** Pixels past the last λ-chunk's edge: `dots` stops there, and so does a run. */
  overflow: number
  /** Enriched pixels the q-value merge drops, being past the last chunk label it has (see `labelEdges`). */
  unlabelled: number
  /** Per kernel, the count each chunk asks for. */
  thresholds: Float64Array[]
  /** The pixels that reached all four thresholds, in `dots`' order. */
  enriched: EnrichedPixel[]
  /** The same pixels with their clusters, where there was clustering. */
  clustered: ClusteredPixel[]
  /** The calls: each cluster's brightest pixel, filtered — or every enriched pixel, unclustered. */
  calls: ClusteredPixel[]
}

/** A growable column of numbers. */
class Column {
  values: Float64Array
  length = 0

  constructor(capacity = 1024) {
    this.values = new Float64Array(capacity)
  }

  push(value: number): void {
    if (this.length === this.values.length) {
      const next = new Float64Array(this.values.length * 2)
      next.set(this.values)
      this.values = next
    }
    this.values[this.length++] = value
  }
}

/**
 * `dots`, fed one sequence at a time.
 *
 * {@link addSequence} scores a sequence's pixels into the run's histograms and
 * keeps the few that could pass (see {@link candidateFloors}); {@link finish}
 * draws the thresholds over everything added — the multiple-testing correction
 * is over the whole run, as `dots`' is over its whole view, so the sequences are
 * part of the answer — and sorts, clusters and filters what passed.
 */
export class DotCaller {
  readonly edges: Float64Array
  readonly histogram: LambdaHistogram
  private readonly floors: Float64Array
  private scored = 0
  private readonly sequence = new Column()
  private readonly row = new Column()
  private readonly col = new Column()
  private readonly count = new Column()
  private readonly la = [new Column(), new Column(), new Column(), new Column()]

  constructor(readonly settings: DotsSettings) {
    this.edges = lambdaEdges(settings.lambdaBins)
    this.histogram = new LambdaHistogram(this.edges)
    this.floors = candidateFloors(this.edges, settings.fdr)
  }

  /** One sequence's band, weights and expected; resolves to the pixels scored. */
  async addSequence(
    index: number,
    band: RawBand,
    weights: ArrayLike<number>,
    expected: Float64Array,
    pause?: (row: number) => Promise<void> | void,
  ): Promise<number> {
    const { edges, floors, histogram } = this
    const scored = await scoreSequence(
      band,
      weights,
      expected,
      this.settings.shape,
      this.settings.maxSeparation,
      (row, col, count, donut, vertical, horizontal, lowleft) => {
        const c0 = lambdaChunk(donut, edges)
        const c1 = lambdaChunk(vertical, edges)
        const c2 = lambdaChunk(horizontal, edges)
        const c3 = lambdaChunk(lowleft, edges)
        histogram.add(count, c0, c1, c2, c3)
        const floor = Math.floor(count)
        if (floor < floors[c0] || floor < floors[c1] || floor < floors[c2] || floor < floors[c3]) return
        this.sequence.push(index)
        this.row.push(row)
        this.col.push(col)
        this.count.push(count)
        this.la[0].push(donut)
        this.la[1].push(vertical)
        this.la[2].push(horizontal)
        this.la[3].push(lowleft)
      },
      pause,
    )
    this.scored += scored
    return scored
  }

  /** The thresholds, then everything that passed them, clustered and filtered. */
  finish(binsize: number): DotsResult {
    const { kernels, overflow } = determineThresholds(this.histogram, this.settings.fdr)
    const thresholds = kernels.map((kernel) => kernel.thresholds)
    const empty: DotsResult = {
      scored: this.scored,
      overflow,
      unlabelled: 0,
      thresholds,
      enriched: [],
      clustered: [],
      calls: [],
    }
    if (overflow > 0 || this.scored === 0) return empty

    const enriched: EnrichedPixel[] = []
    const labels = labelEdges(this.edges)
    let unlabelled = 0
    for (let p = 0; p < this.count.length; p++) {
      const count = this.count.values[p]
      let passes = true
      for (let k = 0; k < 4 && passes; k++) {
        const threshold = kernels[k].thresholds[lambdaChunk(this.la[k].values[p], this.edges)]
        passes = threshold !== undefined && count >= threshold
      }
      if (!passes) continue
      const laExp: [number, number, number, number] = [
        this.la[0].values[p],
        this.la[1].values[p],
        this.la[2].values[p],
        this.la[3].values[p],
      ]
      // `annotate_pixels_with_qvalues` cuts the pixels again by the chunks'
      // labels and merges on them, so a pixel past the last label it has a
      // column for — a hair above a rounded-down edge — leaves the run there.
      const qval: [number, number, number, number] = [0, 0, 0, 0]
      let labelled = true
      for (let k = 0; k < 4 && labelled; k++) {
        const chunk = lambdaChunk(laExp[k], labels)
        labelled = chunk < kernels[k].thresholds.length
        if (labelled) qval[k] = kernels[k].qvalue(count, chunk)
      }
      if (!labelled) {
        unlabelled++
        continue
      }
      enriched.push({
        sequence: this.sequence.values[p],
        bin1: this.row.values[p],
        bin2: this.col.values[p],
        count,
        laExp,
        qval,
      })
    }

    const radius = this.settings.clusteringRadius
    if (!(radius > 0)) {
      const calls = enriched.map((pixel) => ({
        ...pixel,
        cLabel: -1,
        cSize: 1,
        cStart1: Number.NaN,
        cStart2: Number.NaN,
      }))
      return { ...empty, unlabelled, enriched, clustered: calls, calls }
    }
    const { pixels: clustered, centroids } = clusterPixels(enriched, binsize, radius)
    const calls = this.settings.clusterFiltering ? centroids.filter(passesHiccupsFilter) : centroids
    return { ...empty, unlabelled, enriched, clustered, calls }
  }
}

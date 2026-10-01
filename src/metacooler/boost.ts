/**
 * Boost-HiC (Carron et al., *Bioinformatics* 2019), ported from its Python
 * (`github.com/LeopoldC/Boost-HiC`: `main.py`'s `BoostHiC` and the four
 * `HiCutils` functions it calls) — what a resampled map is **oversampled** with
 * (§6.5).
 *
 * The method reads a contact map as a graph whose edge lengths are contacts
 * turned into distances, `d = 1/cᵅ`, and replaces every length by the shortest
 * path between its two ends. A contact the library was too shallow to see
 * directly is then inferred from the contacts it *did* see around it — the
 * triangle inequality doing what depth would have — and the map comes back with
 * its long-range signal filled in. The paper's use for it is the one this app
 * has: a shallow library made to read like a deep one.
 *
 * Step by step, as `main.py` runs it on one chromosome:
 *
 * 1. `get_outliers` — bins whose coverage is off either end of a kernel density
 *    estimate of the coverage (5 % and 99.5 %, a bandwidth of 2,000 contacts)
 *    are taken out, and so is every bin with none.
 * 2. `SCN` — ten rounds of dividing each column, then each row, by its sum
 *    (when that sum is above one), then the mean with the transpose.
 * 3. `fastFloyd` — Floyd–Warshall on `1/SCNᵅ`, back to contacts with
 *    `d^(−1/α)`.
 * 4. `adjustPdS` — the boosted map's contact probability by distance put back
 *    to the SCN map's, window by window, the windows growing by 1 % a diagonal.
 *
 * `alpha` is **0.2**, the value `main.py` runs with (its comment calls 0.24 "a
 * good and safe compromise"). A resample names another through
 * `ResampleSpec.alpha`; nothing on screen or in the shell offers one.
 *
 * Two things are added, and both are about using the answer rather than
 * computing it. The SCN biases are kept, so the boosted map can be returned **in
 * the file's own counts** — `main.py` stops in SCN units, which have no depth to
 * speak of. And the one piece of `get_outliers` that is not arithmetic, the
 * kernel density on a grid of every integer up to the largest coverage, is
 * evaluated through the normal CDF: the grid is summed exactly as scikit-learn's
 * `score_samples` would sum it, a bandwidth of 2,000 being two thousand grid
 * steps wide, without the billion kernel evaluations the literal form costs on a
 * deep map.
 */

import { FLOYD_WASM_BASE64 } from './wasm/floyd.generated'

/** `main.py`'s `alpha`. */
export const BOOST_ALPHA = 0.2

/**
 * The most bins one sequence may have and be boosted.
 *
 * Floyd–Warshall is cubic in them: yeast's chromosome IV at 1 kb is 1,532 bins
 * and about a second and a half in the WebAssembly kernel (§6.5), so 3,000 is
 * about eleven — and four and thirty where there is no SIMD and the JavaScript
 * loop runs it. Past that the wait is a refusal better said than suffered — a
 * coarser resolution is a fraction of the bins.
 */
export const BOOST_MAX_BINS = 3000

/** `get_outliers`' thresholds and `kde_outliers`' bandwidth, in contacts. */
const OUTLIER_BELOW = 0.05
const OUTLIER_ABOVE = 0.995
const OUTLIER_BANDWIDTH = 2000

/** `SCN`'s `max_iter`. */
const SCN_ROUNDS = 10

/** What {@link boostHiC} returns for one sequence. */
export interface Boosted {
  /**
   * Bins that survived `get_outliers`, in order; the map below is over these.
   */
  kept: Int32Array
  /**
   * The boosted map over the kept bins, `kept.length²`, row-major and symmetric,
   * **in the file's counts**: `adjustPdS`'s output with the SCN scaling taken
   * back out of it, cell by cell.
   */
  counts: Float64Array
}

/** Boost-HiC's steps as `main.py` takes them, before the answer goes back to counts. */
export interface BoostSteps {
  /** Bins that survived `get_outliers`, in order; the maps below are over these. */
  kept: Int32Array
  /** `normmat`: the SCN map, `kept.length²`, row-major, symmetric. */
  scn: Float64Array
  /** `boostedmat`: `adjustPdS(normmat, FFmat)`, in SCN units. */
  boosted: Float64Array
  /** What SCN divided each row and each column by, all rounds together. */
  rows: Float64Array
  cols: Float64Array
}

/**
 * `main.py`'s `BoostHiC` on one sequence, after its `get_outliers`: every step,
 * in SCN units, as its Python leaves them.
 *
 * `matrix` is dense, `n × n`, symmetric, raw counts. `null` where there is
 * nothing to boost — fewer than two bins survive the outlier filter, which is
 * also where `windowssize2` stops being defined.
 */
export function boostSteps(
  matrix: Float64Array,
  n: number,
  alpha: number = BOOST_ALPHA,
  onRound?: (done: number, total: number) => void,
): BoostSteps | null {
  if (n < 2) return null
  const coverage = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const row = i * n
    for (let j = 0; j < n; j++) coverage[j] += matrix[row + j]
  }
  const outlier = kdeOutliers(coverage)
  let size = 0
  for (let i = 0; i < n; i++) if (outlier[i] === 0) size++
  if (size < 2) return null
  const kept = new Int32Array(size)
  for (let i = 0, at = 0; i < n; i++) if (outlier[i] === 0) kept[at++] = i

  // `basemat[np.ix_(~pos_out, ~pos_out)]`.
  const scn = new Float64Array(size * size)
  for (let a = 0; a < size; a++) {
    const from = kept[a] * n
    const to = a * size
    for (let b = 0; b < size; b++) scn[to + b] = matrix[from + kept[b]]
  }
  const { rows, cols } = sequentialComponentNormalise(scn, size)

  // `1/np.power(normmat, alpha)`: a zero is no edge at all.
  const distance = new Float64Array(size * size)
  for (let i = 0; i < distance.length; i++) {
    const value = scn[i]
    distance[i] = value > 0 ? 1 / Math.pow(value, alpha) : Number.POSITIVE_INFINITY
  }
  floydWarshall(distance, size, onRound)
  // `np.power(shortest, -1/alpha)`: an unreachable pair is no contact.
  const inverse = -1 / alpha
  for (let i = 0; i < distance.length; i++) {
    const value = distance[i]
    distance[i] = Number.isFinite(value) ? Math.pow(value, inverse) : 0
  }
  const boosted = adjustContactProbability(scn, distance, size)
  return { kept, scn, boosted, rows, cols }
}

/**
 * Boost one sequence's contact map, and return it in the file's counts.
 *
 * SCN left `normmat[i,j] = raw[i,j] · (rᵢcⱼ + rⱼcᵢ)/2`; a boosted cell divided
 * by the same factor is a count again, with the coverage of the bins it joins.
 */
export function boostHiC(
  matrix: Float64Array,
  n: number,
  alpha: number = BOOST_ALPHA,
  onRound?: (done: number, total: number) => void,
): Boosted | null {
  const steps = boostSteps(matrix, n, alpha, onRound)
  if (steps === null) return null
  const { kept, boosted, rows, cols } = steps
  const size = kept.length
  for (let i = 0; i < size; i++) {
    const row = i * size
    for (let j = 0; j < size; j++) {
      const factor = (rows[i] * cols[j] + rows[j] * cols[i]) / 2
      boosted[row + j] = factor > 0 ? boosted[row + j] / factor : 0
    }
  }
  return { kept, counts: boosted }
}

// ---------------------------------------------------------------------------
// The four steps
// ---------------------------------------------------------------------------

/**
 * `SCN`, in place, returning the product of what each row and each column was
 * divided by.
 *
 * `D /= np.maximum(1, D.sum(axis=0))` then the same by rows, ten times, then
 * `(D + D.T)/2`. The `maximum(1, …)` means a sum already below one is left
 * alone, which is what `HiCutils` does and so what this does.
 */
export function sequentialComponentNormalise(
  matrix: Float64Array,
  n: number,
  rounds: number = SCN_ROUNDS,
): { rows: Float64Array; cols: Float64Array } {
  const rows = new Float64Array(n).fill(1)
  const cols = new Float64Array(n).fill(1)
  const sums = new Float64Array(n)
  for (let round = 0; round < rounds; round++) {
    sums.fill(0)
    for (let i = 0; i < n; i++) {
      const row = i * n
      for (let j = 0; j < n; j++) sums[j] += matrix[row + j]
    }
    for (let j = 0; j < n; j++) {
      const divisor = Math.max(1, sums[j])
      sums[j] = divisor
      cols[j] /= divisor
    }
    for (let i = 0; i < n; i++) {
      const row = i * n
      for (let j = 0; j < n; j++) matrix[row + j] /= sums[j]
    }
    for (let i = 0; i < n; i++) {
      const row = i * n
      let sum = 0
      for (let j = 0; j < n; j++) sum += matrix[row + j]
      const divisor = Math.max(1, sum)
      rows[i] /= divisor
      for (let j = 0; j < n; j++) matrix[row + j] /= divisor
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const mean = (matrix[i * n + j] + matrix[j * n + i]) / 2
      matrix[i * n + j] = mean
      matrix[j * n + i] = mean
    }
  }
  return { rows, cols }
}

/** Which arithmetic runs Floyd–Warshall: the SIMD kernel where it loads, or JavaScript. */
export type FloydEngine = 'wasm' | 'js'

/**
 * `fastFloyd`: every distance replaced by the shortest path, in place.
 *
 * In place is the same answer as numpy's step-by-step copy: at step `k` neither
 * row `k` nor column `k` can shorten, because `d[k][k]` is positive. Run by the
 * WebAssembly kernel (`wasm/floyd.c`) where this engine has SIMD — four times
 * the speed, and the same numbers to the bit — and by the same loop in
 * JavaScript where it has not.
 */
export function floydWarshall(
  distance: Float64Array,
  n: number,
  onRound?: (done: number, total: number) => void,
  engine: FloydEngine | 'auto' = 'auto',
): FloydEngine {
  if (engine !== 'js' && floydInWasm(distance, n, onRound)) return 'wasm'
  for (let k = 0; k < n; k++) {
    const rowK = k * n
    for (let i = 0; i < n; i++) {
      const rowI = i * n
      const viaK = distance[rowI + k]
      if (viaK === Number.POSITIVE_INFINITY) continue
      for (let j = 0; j < n; j++) {
        const path = viaK + distance[rowK + j]
        if (path < distance[rowI + j]) distance[rowI + j] = path
      }
    }
    if (onRound !== undefined && (k & 63) === 63) onRound(k + 1, n)
  }
  onRound?.(n, n)
  return 'js'
}

/** The kernel, compiled once per thread; `null` where this engine cannot run it. */
let floydModule: WebAssembly.Module | null | undefined

/** Where the matrix goes in the kernel's memory: past the 64 KiB its stack may use. */
const FLOYD_DATA_AT = 131072

const WASM_PAGE = 65536

/** Floyd–Warshall steps per call into the kernel, between progress reports. */
const FLOYD_SLICE = 64

function floydKernel(): WebAssembly.Module | null {
  if (floydModule !== undefined) return floydModule
  floydModule = null
  try {
    if (typeof WebAssembly === 'undefined') return null
    const text = atob(FLOYD_WASM_BASE64)
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    // `validate` is false on an engine without SIMD, which is the one way the
    // module can fail to load where WebAssembly exists.
    if (WebAssembly.validate(bytes)) floydModule = new WebAssembly.Module(bytes)
  } catch {
    floydModule = null
  }
  return floydModule
}

/** Whether the SIMD kernel runs here — for the tests. */
export function floydKernelAvailable(): boolean {
  return floydKernel() !== null
}

/**
 * Floyd–Warshall through the kernel, or `false` — no kernel here, or no memory
 * the size of the matrix in one piece — for the JavaScript loop to do it.
 *
 * A memory per call and none kept: a sequence at the limit is seventy
 * megabytes, which a worker should not hold between maps.
 */
function floydInWasm(
  distance: Float64Array,
  n: number,
  onRound?: (done: number, total: number) => void,
): boolean {
  const module = floydKernel()
  if (module === null) return false
  let run: (at: number, n: number, k0: number, k1: number) => void
  let view: Float64Array
  try {
    const memory = new WebAssembly.Memory({
      initial: Math.ceil((FLOYD_DATA_AT + distance.length * 8) / WASM_PAGE),
    })
    const instance = new WebAssembly.Instance(module, { env: { memory } })
    run = instance.exports.floyd as typeof run
    view = new Float64Array(memory.buffer, FLOYD_DATA_AT, distance.length)
  } catch {
    return false
  }
  view.set(distance)
  for (let k0 = 0; k0 < n; k0 += FLOYD_SLICE) {
    const k1 = Math.min(n, k0 + FLOYD_SLICE)
    run(FLOYD_DATA_AT, n, k0, k1)
    onRound?.(k1, n)
  }
  distance.set(view)
  return true
}

/**
 * `windowssize2`: the diagonals each contact-probability window pools.
 *
 * Window `w` holds `floor(1.01^w)` diagonals — seventy windows of one, then
 * twos — until the matrix runs out; the last is trimmed to fit and folded into
 * the one before it. `VdT` maps a diagonal to its window. Ported with its
 * quirks, since the windows are part of what the adjustment *is*.
 */
export function contactWindows(n: number): { window: Int32Array; sizes: number[] } {
  const raw = new Float64Array(n)
  raw[0] = 1
  for (let i = 1; i < n; i++) raw[i] = raw[i - 1] * 1.01
  const sizes: number[] = []
  let covered = 0
  for (let i = 0; i < n && covered < n; i++) {
    const size = Math.floor(raw[i])
    sizes.push(size)
    covered += size
  }
  const last = sizes.length - 1
  sizes[last] -= covered - n
  sizes[last - 1] += sizes[last]
  sizes.length = last
  const window = new Int32Array(n)
  let diagonal = 0
  for (let w = 0; w < sizes.length; w++) {
    for (let j = 0; j < sizes[w]; j++) window[diagonal++] = w
  }
  return { window, sizes }
}

/** `contactprobability`: the mean of every cell on each window's diagonals. */
function contactProbability(matrix: Float64Array, n: number, sizes: readonly number[]): Float64Array {
  const out = new Float64Array(sizes.length)
  let diagonal = 0
  for (let w = 0; w < sizes.length; w++) {
    let sum = 0
    let cells = 0
    for (let j = 0; j < sizes[w]; j++, diagonal++) {
      for (let r = 0; r + diagonal < n; r++) sum += matrix[r * n + r + diagonal]
      cells += n - diagonal
    }
    out[w] = cells > 0 ? sum / cells : 0
  }
  return out
}

/**
 * `adjustPdS`: each diagonal of the boosted map scaled so its window's mean
 * contact probability is the SCN map's again. A new array.
 */
export function adjustContactProbability(
  base: Float64Array,
  boosted: Float64Array,
  n: number,
): Float64Array {
  const { window, sizes } = contactWindows(n)
  const wanted = contactProbability(base, n, sizes)
  const have = contactProbability(boosted, n, sizes)
  const out = new Float64Array(boosted)
  for (let offset = 0; offset < n; offset++) {
    const w = window[offset]
    // Boosting never lowers a contact (a path is at most the direct edge), so
    // a window the boosted map has nothing in is one the SCN map had nothing
    // in either; numpy would write NaN there, and nothing is what it holds.
    const adjust = have[w] > 0 ? wanted[w] / have[w] : 0
    for (let j = offset; j < n; j++) {
      const upper = (j - offset) * n + j
      const lower = j * n + (j - offset)
      out[upper] = boosted[upper] * adjust
      out[lower] = boosted[lower] * adjust
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// get_outliers
// ---------------------------------------------------------------------------

/**
 * `get_outliers` → `kde_outliers`: `1` for every bin to leave out.
 *
 * scikit-learn's Gaussian KDE of the non-zero coverages, evaluated on
 * `linspace(0, max, int(max) + 1)`, normalised over the grid and summed; each
 * limit is the grid point whose running sum is nearest its threshold, and a bin
 * below the lower or above the upper is out — a bin with no coverage always is.
 * The running sum is the normal CDF's difference across each grid step, which is
 * the sum of the kernel over the steps it covers to far below a grid step's
 * worth.
 */
export function kdeOutliers(
  coverage: Float64Array,
  below: number = OUTLIER_BELOW,
  above: number = OUTLIER_ABOVE,
  bandwidth: number = OUTLIER_BANDWIDTH,
): Uint8Array {
  const n = coverage.length
  const out = new Uint8Array(n)
  const cleaned: number[] = []
  let max = 0
  for (let i = 0; i < n; i++) {
    const value = coverage[i]
    if (value > 0) cleaned.push(value)
    if (value > max) max = value
  }
  if (cleaned.length === 0) {
    out.fill(1)
    return out
  }
  const points = Math.floor(max) + 1
  const step = points > 1 ? max / (points - 1) : 0
  // The kernel's mass left of grid point `g`'s cell, summed over every read.
  const massTo = (g: number): number => {
    const edge = g * step + step / 2
    let sum = 0
    for (const read of cleaned) sum += normalCdf((edge - read) / bandwidth)
    return sum
  }
  const start = massTo(-1)
  const whole = massTo(points - 1) - start
  const cumulative = (g: number): number => (whole > 0 ? (massTo(g) - start) / whole : 1)
  const limitFor = (threshold: number): number => {
    // The running sum only grows, so the nearest point is the first at or past
    // the threshold or the one before it; `argmin` keeps the earlier on a tie.
    let lo = 0
    let hi = points - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cumulative(mid) >= threshold) hi = mid
      else lo = mid + 1
    }
    if (lo > 0 && Math.abs(cumulative(lo - 1) - threshold) <= Math.abs(cumulative(lo) - threshold)) {
      return lo - 1
    }
    return lo
  }
  // Compared as `kde_outliers` compares them: the coverage against the grid
  // *index*, which is the grid value itself on the integer grid a map of whole
  // contacts always has.
  const lower = limitFor(below)
  const upper = limitFor(above)
  for (let i = 0; i < n; i++) {
    if (coverage[i] < lower || coverage[i] > upper) out[i] = 1
  }
  return out
}

/** `Φ(x)`, through `erfc` so neither tail cancels. */
function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2)
}

/**
 * `erfc` to a few units in the last place: the positive series below 2, where
 * `1 − erf` would not yet cancel, and the continued fraction past it.
 */
function erfc(x: number): number {
  const z = Math.abs(x)
  let value: number
  if (z < 2) {
    let term = z
    let sum = z
    for (let k = 1; k < 200; k++) {
      term *= (2 * z * z) / (2 * k + 1)
      sum += term
      if (term < Math.abs(sum) * 1e-17) break
    }
    value = 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-z * z) * sum
  } else if (z > 27) {
    value = 0
  } else {
    // Modified Lentz on e^{−z²}/√π · 1/(z + ½/(z + 1/(z + 3/2/(z + …)))).
    const tiny = 1e-300
    let d = 1 / z
    let c = 1e300
    let h = d
    for (let i = 1; i < 300; i++) {
      const a = i / 2
      d = z + a * d
      if (d === 0) d = tiny
      c = z + a / c
      if (c === 0) c = tiny
      d = 1 / d
      const delta = c * d
      h *= delta
      if (Math.abs(delta - 1) < 1e-16) break
    }
    value = (Math.exp(-z * z) / Math.sqrt(Math.PI)) * h
  }
  return x >= 0 ? value : 2 - value
}

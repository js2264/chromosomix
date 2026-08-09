/**
 * The two eigenproblems this app needs, and nothing else.
 *
 * No dependency, and not because one could not be added: because what is
 * actually required here is a handful of leading eigenvectors of a small dense
 * symmetric matrix, which is sixty lines of power iteration, and a linear-algebra
 * library is several hundred kilobytes in an application whose entire claim is
 * that it has none (§1).
 *
 * **Power iteration with deflation**, rather than a full decomposition. A
 * compartment analysis reads the first component and occasionally the second and
 * third; solving for all N of them to look at three is the wasteful shape as well
 * as the slow one. Deflation after each component is exact for a symmetric matrix
 * — subtract `λ v vᵀ` and the next iteration converges on the next eigenpair —
 * and the error it accumulates over three components is far below the error
 * already in a correlation matrix built from counts.
 *
 * Two properties are worth stating because a reader of a compartment track
 * depends on both.
 *
 * **The start vector is seeded, not random.** Power iteration from an arbitrary
 * start converges to the same eigenvector up to sign, and the *sign* is what a
 * compartment track means. A figure has to come out the same twice (§18.4), so
 * the start is deterministic and phasing decides the sign deliberately rather
 * than inheriting it from whatever the generator produced.
 *
 * **Rows that are entirely missing are excluded, not zeroed.** A balanced matrix
 * drops bins (§6.4), and a dropped row zeroed is a row asserting that its bin
 * correlates with nothing — which pulls the eigenvector towards zero there and,
 * worse, contributes to the norm. The caller passes an index of the rows that
 * are real and gets a vector over those; putting the gaps back is its job.
 */

import { makeRandom } from './random'

/** One eigenpair of a symmetric matrix. */
export interface Eigenpair {
  value: number
  /** Unit length. Its sign is arbitrary until something phases it. */
  vector: Float64Array
}

/**
 * The `k` leading eigenpairs of a dense symmetric `n × n` matrix.
 *
 * `values` is row-major and is **modified in place** by the deflation — which is
 * documented rather than avoided, because the alternative is a second copy of a
 * matrix that is already the largest thing in the job, and every caller here
 * builds it for this and discards it after.
 */
export function leadingEigenpairs(
  values: Float64Array,
  n: number,
  k: number,
  options: { iterations?: number; tolerance?: number } = {},
): Eigenpair[] {
  const iterations = options.iterations ?? 512
  const tolerance = options.tolerance ?? 1e-9
  const out: Eigenpair[] = []
  if (n === 0) return out

  for (let component = 0; component < k; component++) {
    const pair = dominant(values, n, iterations, tolerance, component)
    if (pair === null) break
    out.push(pair)
    deflate(values, n, pair)
  }
  return out
}

/** The dominant eigenpair, by repeated multiplication. */
function dominant(
  values: Float64Array,
  n: number,
  iterations: number,
  tolerance: number,
  component: number,
): Eigenpair | null {
  // Seeded, and seeded *differently per component*: a start orthogonal to the
  // eigenvector being sought converges to nothing, and the deflated matrix's
  // leading vector is exactly what the previous start was pulled towards.
  const rng = makeRandom(0x5eed + component)
  let vector = new Float64Array(n)
  for (let i = 0; i < n; i++) vector[i] = rng() * 2 - 1
  if (!normalise(vector)) return null

  let value = 0
  let next = new Float64Array(n)
  for (let step = 0; step < iterations; step++) {
    multiply(values, n, vector, next)
    const norm = Math.hypot(...next)
    if (!(norm > 0) || !Number.isFinite(norm)) return null
    for (let i = 0; i < n; i++) next[i] /= norm
    // Rayleigh quotient against the *previous* iterate, which is the eigenvalue
    // with its sign — the norm above has thrown that away, and a negative
    // eigenvalue is entirely possible for a correlation matrix.
    let rayleigh = 0
    for (let i = 0; i < n; i++) rayleigh += next[i] * vector[i]
    const converged = Math.abs(Math.abs(rayleigh) - 1) < tolerance
    value = norm * Math.sign(rayleigh === 0 ? 1 : rayleigh)
    const swap = vector
    vector = next
    next = swap
    if (converged) break
  }
  return { value, vector }
}

/** `A ← A − λ v vᵀ`, which is exact deflation for a symmetric `A`. */
function deflate(values: Float64Array, n: number, pair: Eigenpair): void {
  const { value, vector } = pair
  for (let r = 0; r < n; r++) {
    const scale = value * vector[r]
    for (let c = 0; c < n; c++) values[r * n + c] -= scale * vector[c]
  }
}

function multiply(values: Float64Array, n: number, vector: Float64Array, out: Float64Array): void {
  for (let r = 0; r < n; r++) {
    let total = 0
    const base = r * n
    for (let c = 0; c < n; c++) total += values[base + c] * vector[c]
    out[r] = total
  }
}

function normalise(vector: Float64Array): boolean {
  let total = 0
  for (const value of vector) total += value * value
  const norm = Math.sqrt(total)
  if (!(norm > 0)) return false
  for (let i = 0; i < vector.length; i++) vector[i] /= norm
  return true
}

/**
 * A two-way spectral split of a symmetric non-negative matrix.
 *
 * The Fiedler vector — the eigenvector of the second-smallest eigenvalue of the
 * graph Laplacian — sign-split. It answers one question: *is this one thing or
 * two?* On a MAG's contig-level matrix that is exactly the split-MAG question
 * (§18.8), and it is the same arithmetic as the compartment eigenvector on a
 * different matrix, which is why it lives beside it rather than in a module of
 * its own.
 *
 * Computed by shifting rather than by inverting: the Laplacian's *smallest*
 * eigenvectors are wanted and power iteration finds the largest, so `σI − L` is
 * iterated instead, whose largest eigenvectors are `L`'s smallest. The constant
 * eigenvector — `L`'s trivial zero — is deflated away first, and what is left is
 * the Fiedler vector.
 */
export function fiedlerSplit(
  weights: Float64Array,
  n: number,
): { side: Int8Array; value: number } | null {
  if (n < 2) return null
  const degree = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    let total = 0
    for (let c = 0; c < n; c++) {
      const value = weights[r * n + c]
      if (Number.isFinite(value)) total += value
    }
    degree[r] = total
  }

  // σ large enough that σI − L is positive semi-definite: the Laplacian's
  // largest eigenvalue is at most twice the largest degree.
  let shift = 0
  for (const value of degree) if (value > shift) shift = value
  shift *= 2
  if (!(shift > 0)) return null

  const matrix = new Float64Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const w = Number.isFinite(weights[r * n + c]) ? weights[r * n + c] : 0
      const laplacian = r === c ? degree[r] - w : -w
      matrix[r * n + c] = (r === c ? shift : 0) - laplacian
    }
  }

  // The constant vector is L's zero eigenvector and therefore σI − L's largest.
  // Deflating it explicitly — rather than taking the *second* result of a
  // two-component run — is both cheaper and exact, since the vector is known.
  const constant = new Float64Array(n).fill(1 / Math.sqrt(n))
  let lambda = 0
  {
    const product = new Float64Array(n)
    multiply(matrix, n, constant, product)
    for (let i = 0; i < n; i++) lambda += constant[i] * product[i]
  }
  deflate(matrix, n, { value: lambda, vector: constant })

  const pair = dominant(matrix, n, 512, 1e-9, 0)
  if (pair === null) return null
  const side = new Int8Array(n)
  for (let i = 0; i < n; i++) side[i] = pair.vector[i] >= 0 ? 1 : -1
  // A split that puts everything on one side is not a split.
  let ones = 0
  for (const value of side) if (value === 1) ones++
  if (ones === 0 || ones === n) return null
  return { side, value: shift - pair.value }
}

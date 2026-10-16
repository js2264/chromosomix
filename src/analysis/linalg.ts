/**
 * The two eigenproblems this app needs, and nothing else.
 *
 * No dependency, and not because one could not be added: because what is
 * actually required here is a handful of leading eigenvectors of a small dense
 * symmetric matrix, which is a hundred lines of Lanczos iteration, and a
 * linear-algebra library is several hundred kilobytes in an application whose
 * entire claim is that it has none (§1).
 *
 * **One dominant eigenpair at a time, with deflation**, rather than a full
 * decomposition. A compartment analysis reads the first component and
 * occasionally the second and third; solving for all N of them to look at three
 * is the wasteful shape as well as the slow one. Deflation after each component
 * is exact for a symmetric matrix — subtract `λ v vᵀ` and the next search finds
 * the next eigenpair — and it is what keeps an eigenvalue that occurs twice from
 * being reported once: a single Krylov space holds one copy of it, the deflated
 * matrix still holds the other.
 *
 * **Each dominant pair by Lanczos iteration** ({@link dominant}), which is what
 * ARPACK runs for cooltools (`scipy.sparse.linalg.eigsh`), and not by power
 * iteration, which is what this module ran until the compartments task was timed
 * against cooltools. Power iteration converges at the ratio of the two largest
 * eigenvalues, step after step: where two are close in size, five hundred
 * multiplications were not enough — chr14's E3, in the validation's mouse map at
 * 100 kb, came out a mixture of two eigenvectors — and the multiplications were
 * seven-tenths of the task's time. Lanczos converges at the gap measured against
 * the width of the whole spectrum: on the same map every component of every
 * chromosome settles in 18 to 72 multiplications, chr14's E3 among them.
 *
 * Two properties are worth stating because a reader of a compartment track
 * depends on both.
 *
 * **The start vector is seeded, not random.** Lanczos from an arbitrary start
 * converges to the same eigenvector up to sign, and the *sign* is what a
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
  const tolerance = options.tolerance ?? 1e-12
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

/**
 * The dominant eigenpair — the eigenvalue largest in size, with its sign — by
 * Lanczos iteration.
 *
 * The Krylov space of the seeded start is built a vector at a time, each one
 * orthogonalised against **every** vector before it, twice: the three-term
 * recurrence alone loses orthogonality as soon as a Ritz value settles, and the
 * copies of it that then appear are the classic way a Lanczos run reports one
 * eigenvalue several times. A few dozen vectors of a few thousand bins make that
 * cheap beside the matrix product each step costs.
 *
 * The answer is the Ritz pair of largest magnitude, and it is converged when
 * its residual `‖A y − θ y‖` — which the recurrence gives without forming it,
 * as `β · |sₘ|` — is within `tolerance` of `|θ|`. That is ARPACK's own test, at
 * a few thousand times its machine-precision default and ample for a track
 * written in single precision. Where the space closes on itself before
 * then (`β` ≈ 0, a matrix of few distinct eigenvalues), its Ritz pairs are exact
 * and the search stops there; where it runs to `steps`, the best pair is
 * returned unconverged, as the power iteration this replaced returned its last
 * iterate.
 */
function dominant(
  values: Float64Array,
  n: number,
  steps: number,
  tolerance: number,
  component: number,
): Eigenpair | null {
  // Seeded, and seeded *differently per component*: a start orthogonal to the
  // eigenvector being sought converges to nothing, and the deflated matrix's
  // leading vector is exactly what the previous start was pulled towards.
  const rng = makeRandom(0x5eed + component)
  const start = new Float64Array(n)
  for (let i = 0; i < n; i++) start[i] = rng() * 2 - 1
  if (!normalise(start)) return null

  const most = Math.max(1, Math.min(n, steps))
  const basis: Float64Array[] = [start]
  const alpha = new Float64Array(most)
  const beta = new Float64Array(most)
  const w = new Float64Array(n)
  let scale = 0
  let ritz: RitzPair | null = null
  for (let j = 0; j < most; j++) {
    multiply(values, n, basis[j], w)
    // Gram–Schmidt against the whole basis, twice ("twice is enough"). The
    // coefficient on the newest vector is the diagonal entry of the tridiagonal
    // matrix; the one on the vector before it is the β already recorded.
    let a = 0
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= j; i++) {
        const q = basis[i]
        let c = 0
        for (let t = 0; t < n; t++) c += q[t] * w[t]
        for (let t = 0; t < n; t++) w[t] -= c * q[t]
        if (i === j) a += c
      }
    }
    let b = 0
    for (let t = 0; t < n; t++) b += w[t] * w[t]
    b = Math.sqrt(b)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null
    alpha[j] = a
    scale = Math.max(scale, Math.abs(a) + b + (j > 0 ? beta[j - 1] : 0))

    const m = j + 1
    // An invariant subspace, to the precision of the arithmetic: nothing new is
    // left to add, and the Ritz pairs are the eigenpairs.
    const closed = !(b > scale * 1e-14)
    const last = closed || m === most
    // The small eigenproblem is solved every step at first and then on a
    // widening stride, so that its cubic cost never rivals the matrix products.
    if (last || m <= 16 || m % Math.ceil(m / 8) === 0) {
      ritz = largestRitz(alpha, beta, m)
      if (ritz === null) return null
      if (last || b * Math.abs(ritz.coefficients[m - 1]) <= tolerance * Math.abs(ritz.value)) break
    }
    beta[j] = b
    const next = new Float64Array(n)
    for (let t = 0; t < n; t++) next[t] = w[t] / b
    basis.push(next)
  }
  if (ritz === null) return null

  // The Ritz vector, `y = Q s`, over the basis vectors the pair was solved on.
  const vector = new Float64Array(n)
  const { coefficients } = ritz
  for (let i = 0; i < coefficients.length; i++) {
    const s = coefficients[i]
    const q = basis[i]
    for (let t = 0; t < n; t++) vector[t] += s * q[t]
  }
  if (!normalise(vector)) return null
  return { value: ritz.value, vector }
}

/** An eigenpair of the Lanczos tridiagonal: its value, and its vector's coefficients. */
interface RitzPair {
  value: number
  coefficients: Float64Array
}

/**
 * The eigenpair of largest magnitude of the `m × m` symmetric tridiagonal matrix
 * with diagonal `alpha` and off-diagonal `beta` (its first `m − 1` entries).
 *
 * The implicit QL algorithm with Wilkinson-type shifts, accumulating the
 * eigenvectors — EISPACK's `tql2`, as JAMA writes it. `null` where an
 * eigenvalue would not settle, which only a non-finite entry can cause.
 */
function largestRitz(alpha: Float64Array, beta: Float64Array, m: number): RitzPair | null {
  const d = alpha.slice(0, m)
  const e = new Float64Array(m)
  for (let i = 0; i + 1 < m; i++) e[i] = beta[i]
  // Column-major: eigenvector `j` is `v[j * m … j * m + m)`.
  const v = new Float64Array(m * m)
  for (let i = 0; i < m; i++) v[i * m + i] = 1

  let f = 0
  let largest = 0
  const eps = 2 ** -52
  for (let l = 0; l < m; l++) {
    largest = Math.max(largest, Math.abs(d[l]) + Math.abs(e[l]))
    let k = l
    while (k < m - 1 && !(Math.abs(e[k]) <= eps * largest)) k++
    if (k > l) {
      let rounds = 0
      do {
        if (++rounds > 64) return null
        // The shift, from the leading 2 × 2 of the unreduced block.
        let g = d[l]
        let p = (d[l + 1] - g) / (2 * e[l])
        let r = Math.hypot(p, 1)
        if (p < 0) r = -r
        d[l] = e[l] / (p + r)
        d[l + 1] = e[l] * (p + r)
        const dl1 = d[l + 1]
        let h = g - d[l]
        for (let i = l + 2; i < m; i++) d[i] -= h
        f += h
        // One implicit QL sweep, from the bottom of the block up.
        p = d[k]
        let c = 1
        let c2 = c
        let c3 = c
        const el1 = e[l + 1]
        let s = 0
        let s2 = 0
        for (let i = k - 1; i >= l; i--) {
          c3 = c2
          c2 = c
          s2 = s
          g = c * e[i]
          h = c * p
          r = Math.hypot(p, e[i])
          e[i + 1] = s * r
          s = e[i] / r
          c = p / r
          p = c * d[i] - s * g
          d[i + 1] = h + s * (c * g + s * d[i])
          const left = i * m
          const right = (i + 1) * m
          for (let t = 0; t < m; t++) {
            h = v[right + t]
            v[right + t] = s * v[left + t] + c * h
            v[left + t] = c * v[left + t] - s * h
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]) / dl1
        e[l] = s * p
        d[l] = c * p
      } while (Math.abs(e[l]) > eps * largest)
    }
    d[l] += f
    e[l] = 0
  }

  let best = 0
  for (let j = 1; j < m; j++) if (Math.abs(d[j]) > Math.abs(d[best])) best = j
  if (!Number.isFinite(d[best])) return null
  return { value: d[best], coefficients: v.slice(best * m, best * m + m) }
}

/** `A ← A − λ v vᵀ`, which is exact deflation for a symmetric `A`. */
function deflate(values: Float64Array, n: number, pair: Eigenpair): void {
  const { value, vector } = pair
  for (let r = 0; r < n; r++) {
    const scale = value * vector[r]
    for (let c = 0; c < n; c++) values[r * n + c] -= scale * vector[c]
  }
}

/**
 * `out = A x` for a symmetric `A`, read from its **upper triangle alone**, four
 * rows at a time.
 *
 * The product is the whole cost of the search, and on a mammalian chromosome
 * at 100 kb the matrix is thirty megabytes of `Float64` that does not fit in a
 * cache: a row-by-row product was bound by reading it, not by the arithmetic.
 * Each cell above the diagonal serves twice here — its row's sum, and its
 * column's through the mirror — so half the matrix is read, and four rows share
 * every pass over a stretch of `x` and `out`. Measured on a 1,912-bin matrix,
 * 3.6 ms a product against 9.3, the same sums to the last few bits.
 */
function multiply(values: Float64Array, n: number, vector: Float64Array, out: Float64Array): void {
  out.fill(0)
  let r = 0
  for (; r + 3 < n; r += 4) {
    const b0 = r * n
    const b1 = b0 + n
    const b2 = b1 + n
    const b3 = b2 + n
    const x0 = vector[r]
    const x1 = vector[r + 1]
    const x2 = vector[r + 2]
    const x3 = vector[r + 3]
    // The 4 × 4 block on the diagonal, its lower half read from its upper.
    const a01 = values[b0 + r + 1]
    const a02 = values[b0 + r + 2]
    const a03 = values[b0 + r + 3]
    const a12 = values[b1 + r + 2]
    const a13 = values[b1 + r + 3]
    const a23 = values[b2 + r + 3]
    let t0 = values[b0 + r] * x0 + a01 * x1 + a02 * x2 + a03 * x3
    let t1 = a01 * x0 + values[b1 + r + 1] * x1 + a12 * x2 + a13 * x3
    let t2 = a02 * x0 + a12 * x1 + values[b2 + r + 2] * x2 + a23 * x3
    let t3 = a03 * x0 + a13 * x1 + a23 * x2 + values[b3 + r + 3] * x3
    for (let c = r + 4; c < n; c++) {
      const a0 = values[b0 + c]
      const a1 = values[b1 + c]
      const a2 = values[b2 + c]
      const a3 = values[b3 + c]
      const xc = vector[c]
      t0 += a0 * xc
      t1 += a1 * xc
      t2 += a2 * xc
      t3 += a3 * xc
      out[c] += a0 * x0 + a1 * x1 + a2 * x2 + a3 * x3
    }
    out[r] += t0
    out[r + 1] += t1
    out[r + 2] += t2
    out[r + 3] += t3
  }
  // The last rows, under four: what lies left of their diagonal was added by
  // the blocks above, through the mirror.
  for (; r < n; r++) {
    const base = r * n
    const xr = vector[r]
    let total = values[base + r] * xr
    for (let c = r + 1; c < n; c++) {
      const a = values[base + c]
      total += a * vector[c]
      out[c] += a * xr
    }
    out[r] += total
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
 * eigenvectors are wanted and Lanczos iteration finds the largest, so `σI − L` is
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

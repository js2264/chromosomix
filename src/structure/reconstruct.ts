/**
 * A model from a map: contacts to distances, distances to places (§25.6).
 *
 * The pipeline is ShRec3D's (Lesne et al., *Nature Methods* 2014) with the
 * refinement every MDS toolkit ends with: a contact count `c` between two bins
 * is read as a distance `d = c^(−1/α)` — the same power law *Model versus map*
 * assumes in the other direction — the pairs the map never counted are filled
 * so the matrix is complete, classical MDS (Torgerson) turns the completed
 * matrix into three coordinates per bead, and SMACOF (de Leeuw's majorisation)
 * moves the beads until the distances the model has match the distances the
 * map implied, over the pairs the map counted and no other — each pair
 * **weighted by how often the map counted it**, so a pair seen ten thousand
 * times holds the beads where it says and a pair seen once barely moves them.
 *
 * That weighting is the point of refining at all. The count sets a pair's
 * target distance, but with every pair weighing the same the stress is
 * dominated by the far, weak, noisy pairs — a zero-count neighbour of a
 * 10,000-count pair is not a pair the model should honour equally — and the
 * near diagonal, where the map is most certain, is the part fitted worst.
 * `weightsFromContacts` turns the counts into weights; `smacofStep` takes
 * them; a pair the map never counted weighs nothing.
 *
 * Three departures from ShRec3D, all deliberate and all named in SPECS §25.6.
 * Its filling is a shortest-path closure over every pair, which is cubic in
 * the bead count and the one step that would not finish in a tab; the filling
 * here is the **mean observed distance at the same separation** for a pair on
 * one sequence and the mean observed trans distance for a pair across two,
 * which is what the closure converges towards on a map that decays with
 * distance and costs a pass over the matrix. And ShRec3D stops at the classical
 * solution; the refinement is what makes the model honour the counted pairs
 * rather than the filled ones, because a filled pair carries **no weight** in
 * it. And the refinement is weighted by the counts, where ShRec3D has no
 * refinement to weight.
 *
 * Everything here is arrays in and arrays out — no worker, no store, no DOM —
 * so the runner can breathe between iterations and the test can hold the
 * arithmetic still: a chain whose contacts were *made* from a known model comes
 * back as that model up to a rigid motion, which is the one golden a
 * reconstruction can honestly have (§18.9).
 */

/** A configuration: one coordinate array per axis, one entry per bead. */
export interface Coordinates {
  x: Float64Array
  y: Float64Array
  z: Float64Array
}

/**
 * The distances a map implies, `n × n`, `NaN` where the map counted nothing.
 *
 * Symmetrised by the mean of the two triangles, because a read block is not
 * guaranteed symmetric to the last bit and a model has one distance per pair.
 * A pair with a zero count is **missing**, not infinitely far: a zero at 1 kb
 * is a pair the experiment did not sample, and `0^(−1/α)` would put the bead
 * at infinity and every other pair at nothing.
 */
export function distancesFromContacts(values: Float32Array, n: number, alpha: number): Float64Array {
  const out = new Float64Array(n * n).fill(Number.NaN)
  const power = -1 / alpha
  for (let i = 0; i < n; i++) {
    out[i * n + i] = 0
    for (let j = i + 1; j < n; j++) {
      const a = values[i * n + j]
      const b = values[j * n + i]
      const okA = Number.isFinite(a) && a > 0
      const okB = Number.isFinite(b) && b > 0
      if (!okA && !okB) continue
      const count = okA && okB ? (a + b) / 2 : okA ? a : b
      const d = Math.pow(count, power)
      out[i * n + j] = d
      out[j * n + i] = d
    }
  }
  return out
}

/**
 * The beads the map said nothing about at all.
 *
 * A bin whose row is entirely missing — a filtered bin under balancing, a gap
 * in the assembly, a centromere — has no place the data can give it, and a
 * bead with no constraint drifts to wherever the initialisation dropped it,
 * which looks exactly like a result. Such beads are dropped **before** solving
 * and the caller says how many; the alternative was a model with beads in it
 * nothing supports.
 */
export function constrainedBeads(distances: Float64Array, n: number): Int32Array {
  const keep: number[] = []
  for (let i = 0; i < n; i++) {
    let any = false
    for (let j = 0; j < n && !any; j++) if (j !== i && !Number.isNaN(distances[i * n + j])) any = true
    if (any) keep.push(i)
  }
  return Int32Array.from(keep)
}

/** The rows and columns of `distances` at `keep`, as a smaller square. */
export function subMatrix(distances: Float64Array, n: number, keep: Int32Array): Float64Array {
  const m = keep.length
  const out = new Float64Array(m * m)
  for (let a = 0; a < m; a++) {
    const row = keep[a] * n
    for (let b = 0; b < m; b++) out[a * m + b] = distances[row + keep[b]]
  }
  return out
}

/**
 * Every pair given a distance, so classical MDS has a full matrix to start from.
 *
 * `group[i]` is the sequence bead `i` lies on and `index[i]` its position along
 * it, so a missing pair is filled from the pairs that *are* there at the same
 * separation on the same sequence — the mean, walking outward to the nearest
 * separation with any observation when this one has none — and a pair across
 * two sequences from the mean of the observed trans pairs, or the largest cis
 * mean when the map counted nothing trans at all. The result is a copy;
 * `distances` keeps its `NaN`s, which the refinement needs to know which pairs
 * were counted.
 */
export function fillDistances(
  distances: Float64Array,
  n: number,
  group: Int32Array,
  index: Int32Array,
): Float64Array {
  const out = Float64Array.from(distances)
  // Mean observed distance per cis separation, and the mean of every trans pair.
  let maxSeparation = 0
  for (let i = 0; i < n; i++) maxSeparation = Math.max(maxSeparation, index[i])
  const cisSum = new Float64Array(maxSeparation + 1)
  const cisCount = new Float64Array(maxSeparation + 1)
  let transSum = 0
  let transCount = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distances[i * n + j]
      if (Number.isNaN(d)) continue
      if (group[i] === group[j]) {
        const s = Math.abs(index[i] - index[j])
        cisSum[s] += d
        cisCount[s] += 1
      } else {
        transSum += d
        transCount += 1
      }
    }
  }
  const cisMean = new Float64Array(maxSeparation + 1).fill(Number.NaN)
  let largestCis = 0
  for (let s = 0; s <= maxSeparation; s++) {
    if (cisCount[s] === 0) continue
    cisMean[s] = cisSum[s] / cisCount[s]
    if (cisMean[s] > largestCis) largestCis = cisMean[s]
  }
  // Nearest observed separation, either way, so a gap in the middle of the
  // decay reads its neighbours rather than nothing.
  const nearest = new Float64Array(maxSeparation + 1)
  for (let s = 0; s <= maxSeparation; s++) {
    if (!Number.isNaN(cisMean[s])) {
      nearest[s] = cisMean[s]
      continue
    }
    let found = Number.NaN
    for (let step = 1; step <= maxSeparation && Number.isNaN(found); step++) {
      const lo = s - step
      const hi = s + step
      if (lo >= 0 && !Number.isNaN(cisMean[lo])) found = cisMean[lo]
      else if (hi <= maxSeparation && !Number.isNaN(cisMean[hi])) found = cisMean[hi]
    }
    nearest[s] = Number.isNaN(found) ? 1 : found
  }
  const trans = transCount > 0 ? transSum / transCount : largestCis > 0 ? largestCis : 1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!Number.isNaN(distances[i * n + j])) continue
      const d = group[i] === group[j] ? nearest[Math.abs(index[i] - index[j])] : trans
      out[i * n + j] = d
      out[j * n + i] = d
    }
  }
  return out
}

/** How a pair's contact count becomes its weight in the fit. */
export type WeightMode = 'contacts' | 'sqrt' | 'equal'

/**
 * A weight per pair from the counts, `0` where the map counted nothing.
 *
 * `contacts` is the count itself — a pair counted a thousand times is a
 * thousand times as sure as a pair counted once, which is what a Poisson
 * count's precision says. `sqrt` is the count's standard deviation's worth,
 * the gentler reading that lets a weak pair still be heard on a deep map.
 * `equal` is one per counted pair: the plain SMACOF of every toolkit, kept
 * so a reader can see what the weighting changes. Symmetrised as the
 * distances are, by the mean of the two triangles.
 */
export function weightsFromContacts(values: Float32Array, n: number, mode: WeightMode): Float64Array {
  const out = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = values[i * n + j]
      const b = values[j * n + i]
      const okA = Number.isFinite(a) && a > 0
      const okB = Number.isFinite(b) && b > 0
      if (!okA && !okB) continue
      const count = okA && okB ? (a + b) / 2 : okA ? a : b
      const w = mode === 'contacts' ? count : mode === 'sqrt' ? Math.sqrt(count) : 1
      out[i * n + j] = w
      out[j * n + i] = w
    }
  }
  return out
}

/**
 * Torgerson's classical scaling: the three leading eigenvectors of the
 * double-centred squared distances, scaled by the roots of their eigenvalues.
 *
 * The eigenvectors come from subspace iteration — three random vectors,
 * multiplied through and re-orthogonalised until they settle — rather than a
 * full decomposition, because three are all that is wanted of a matrix that
 * can be two and a half thousand a side. The result is only an initialisation;
 * the refinement below is what the model is held to.
 */
export function classicalMds(full: Float64Array, n: number, sweeps = 80): Coordinates {
  const b = new Float64Array(n * n)
  // B = −½ J D² J: the squared distances, centred by row, by column and overall.
  const rowMean = new Float64Array(n)
  let grand = 0
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      const d = full[i * n + j]
      const sq = d * d
      b[i * n + j] = sq
      sum += sq
    }
    rowMean[i] = sum / n
    grand += sum
  }
  grand /= n * n
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      b[i * n + j] = -0.5 * (b[i * n + j] - rowMean[i] - rowMean[j] + grand)
    }
  }
  const q = [seeded(n, 1), seeded(n, 2), seeded(n, 3)]
  orthonormalise(q)
  const z = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let k = 0; k < 3; k++) multiply(b, n, q[k], z[k])
    for (let k = 0; k < 3; k++) q[k].set(z[k])
    orthonormalise(q)
  }
  // Rayleigh quotients for the scale of each axis; a negative one — a matrix
  // that is not quite Euclidean, which a filled one never quite is — is an
  // axis the data does not support, drawn flat rather than imaginary.
  const axes = q.map((vector, k) => {
    multiply(b, n, vector, z[k])
    let lambda = 0
    for (let i = 0; i < n; i++) lambda += vector[i] * z[k][i]
    const scale = Math.sqrt(Math.max(0, lambda))
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) out[i] = vector[i] * scale
    return out
  })
  return { x: axes[0], y: axes[1], z: axes[2] }
}

/** A deterministic pseudo-random unit vector, so two runs give one answer. */
function seeded(n: number, seed: number): Float64Array {
  const out = new Float64Array(n)
  let state = 2463534242 + seed * 7919
  for (let i = 0; i < n; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = ((state >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

function multiply(m: Float64Array, n: number, v: Float64Array, out: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let sum = 0
    const row = i * n
    for (let j = 0; j < n; j++) sum += m[row + j] * v[j]
    out[i] = sum
  }
}

/** Gram–Schmidt in place; a vector that collapses is reseeded so three stay three. */
function orthonormalise(vectors: Float64Array[]): void {
  const n = vectors[0].length
  for (let k = 0; k < vectors.length; k++) {
    const v = vectors[k]
    for (let p = 0; p < k; p++) {
      const u = vectors[p]
      let dot = 0
      for (let i = 0; i < n; i++) dot += u[i] * v[i]
      for (let i = 0; i < n; i++) v[i] -= dot * u[i]
    }
    let norm = 0
    for (let i = 0; i < n; i++) norm += v[i] * v[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-12) {
      v.set(seeded(n, 11 + k))
      k--
      continue
    }
    for (let i = 0; i < n; i++) v[i] /= norm
  }
}

/**
 * One SMACOF sweep: every bead moved to where the weighted majorant of the
 * stress puts it, given the others (Gansner, Koren & North's localised
 * stress majorisation, which is de Leeuw's Guttman transform taken one bead
 * at a time).
 *
 * `x_i ← Σ_j w_ij (x_j + δ_ij (x_i − x_j) / d_ij) / Σ_j w_ij`, in place, so a
 * bead moved early in the sweep is where its later neighbours see it — the
 * Gauss–Seidel reading, which converges faster than moving all at once and
 * never raises the stress: each move minimises a function that sits above
 * the stress and touches it where the bead was. Weighted, and the weights are
 * what make this a closed form: the full weighted Guttman transform is a
 * linear solve in the weight Laplacian, which is a pseudo-inverse of a
 * 2,500² matrix or a conjugate-gradient inner loop, and the bead-at-a-time
 * form costs one pass over the pairs like the unweighted one does.
 *
 * `weights` is `null` for one per counted pair. A pair with no target, or a
 * zero weight, contributes nothing. Returns the weighted normalised stress
 * **before** the sweep: `Σ w (δ − d)² / Σ w δ²`, 0 for a perfect fit.
 */
export function smacofStep(
  target: Float64Array,
  n: number,
  coords: Coordinates,
  weights: Float64Array | null = null,
): number {
  const before = stressOf(target, n, coords, weights)
  const { x, y, z } = coords
  for (let i = 0; i < n; i++) {
    let sx = 0
    let sy = 0
    let sz = 0
    let sw = 0
    const row = i * n
    const xi = x[i]
    const yi = y[i]
    const zi = z[i]
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const delta = target[row + j]
      if (Number.isNaN(delta)) continue
      const w = weights === null ? 1 : weights[row + j]
      if (!(w > 0)) continue
      const dx = xi - x[j]
      const dy = yi - y[j]
      const dz = zi - z[j]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      // Two beads on one point with a distance to keep have no direction to
      // keep it along: this term pulls onto the other bead and the next
      // sweep separates them once any other pair has moved one.
      const ratio = d > 1e-12 ? delta / d : 0
      sx += w * (x[j] + ratio * dx)
      sy += w * (y[j] + ratio * dy)
      sz += w * (z[j] + ratio * dz)
      sw += w
    }
    if (sw <= 0) continue
    x[i] = sx / sw
    y[i] = sy / sw
    z[i] = sz / sw
  }
  return before
}

/**
 * The weighted stress of a configuration against its targets, without
 * moving it: `Σ w (δ − d)² / Σ w δ²` over the counted pairs.
 */
export function stressOf(
  target: Float64Array,
  n: number,
  coords: Coordinates,
  weights: Float64Array | null = null,
): number {
  const { x, y, z } = coords
  let raw = 0
  let norm = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = target[i * n + j]
      if (Number.isNaN(delta)) continue
      const w = weights === null ? 1 : weights[i * n + j]
      if (!(w > 0)) continue
      const dx = x[i] - x[j]
      const dy = y[i] - y[j]
      const dz = z[i] - z[j]
      const gap = delta - Math.sqrt(dx * dx + dy * dy + dz * dz)
      raw += w * gap * gap
      norm += w * delta * delta
    }
  }
  return norm > 0 ? raw / norm : 0
}

/**
 * Centre the model and scale it so its root-mean-square radius is one.
 *
 * A map carries no physical unit and `c^(−1/α)` is in none, so the scale the
 * solver lands on is an accident of the counts; one that is the same for every
 * run puts two models of two maps beside each other at the same size, and
 * *model units* under a distance track mean the same thing on both.
 */
export function normaliseCoordinates(coords: Coordinates): void {
  const { x, y, z } = coords
  const n = x.length
  if (n === 0) return
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    cx += x[i]
    cy += y[i]
    cz += z[i]
  }
  cx /= n
  cy /= n
  cz /= n
  let sum = 0
  for (let i = 0; i < n; i++) {
    x[i] -= cx
    y[i] -= cy
    z[i] -= cz
    sum += x[i] * x[i] + y[i] * y[i] + z[i] * z[i]
  }
  const rms = Math.sqrt(sum / n)
  if (rms <= 0) return
  for (let i = 0; i < n; i++) {
    x[i] /= rms
    y[i] /= rms
    z[i] /= rms
  }
}

/** Spearman's ρ between two lists, for the test and the runner's report. */
export function spearman(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length
  if (n < 3) return Number.NaN
  const ra = ranks(a)
  const rb = ranks(b)
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += ra[i]
    mb += rb[i]
  }
  ma /= n
  mb /= n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma
    const db = rb[i] - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : Number.NaN
}

function ranks(values: ArrayLike<number>): Float64Array {
  const n = values.length
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => values[p] - values[q])
  const out = new Float64Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[order[k]] = rank
    i = j + 1
  }
  return out
}

/**
 * The whole road, for callers that do not need to breathe between steps.
 *
 * The runner takes the steps itself so a cancel lands between two of them;
 * the test and anything small takes this. Stops early once a step improves
 * the stress by less than `tolerance` of itself.
 */
export function reconstruct(
  distances: Float64Array,
  n: number,
  group: Int32Array,
  index: Int32Array,
  options: { iterations?: number; tolerance?: number; weights?: Float64Array | null } = {},
): { coords: Coordinates; stress: number; steps: number } {
  const iterations = options.iterations ?? 200
  const tolerance = options.tolerance ?? 1e-6
  const weights = options.weights ?? null
  const coords = classicalMds(fillDistances(distances, n, group, index), n)
  let stress = stressOf(distances, n, coords, weights)
  let steps = 0
  for (; steps < iterations; steps++) {
    const before = smacofStep(distances, n, coords, weights)
    const after = stressOf(distances, n, coords, weights)
    stress = after
    if (before - after < tolerance * before) {
      steps++
      break
    }
  }
  normaliseCoordinates(coords)
  return { coords, stress, steps }
}

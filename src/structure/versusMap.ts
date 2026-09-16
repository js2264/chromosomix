/**
 * The model against the map (§25.6): what a structure says about a contact
 * map, and what a map says about a structure, over arrays.
 *
 * A structure is beads at loci; a map is bins. The two meet at the map's
 * bins: each bin takes the mean position of the beads whose middles fall in
 * it, and everything below is over those points — a distance matrix, the
 * mean distance at each separation, a correlation with the observed contacts
 * — or over the beads themselves, for the three tracks the model yields on
 * its own: how far each bead is from the model's centre, from a chosen
 * locus, and from its own neighbours along the chain.
 *
 * Pure and worker-safe: nothing here reads a store or a file. The analysis
 * runner (`analysis/run/structure.ts`) fetches the square and hands it over.
 */

import type { FeatureSet, StructureModel } from '../annotations/types'
import { spearman } from '../analysis/stats'

/** A model's beads on one sequence, reduced to points per map bin. */
export interface BinnedPoints {
  /** The bins, from the sequence's first; `present[i] === 0` where no bead landed. */
  n: number
  x: Float64Array
  y: Float64Array
  z: Float64Array
  present: Uint8Array
  /** How many beads each bin took, for the reader who asks. */
  beads: Int32Array
}

/** The beads of one sequence and haplotype, as indices into the set. */
export function beadsOf(set: FeatureSet, contig: string, haplotype: number): number[] {
  const c = set.contigs.indexOf(contig)
  if (c < 0) return []
  const model = set.model
  const out: number[] = []
  for (let i = set.contigAt[c]; i < set.contigAt[c + 1]; i++) {
    if (model !== undefined && haplotype >= 0 && model.hap[i] !== haplotype) continue
    out.push(i)
  }
  return out
}

/**
 * The beads of one sequence, binned at the map's spacing: each bin the mean
 * of the beads whose middle falls in it. A bin with no bead is absent rather
 * than interpolated — a distance to a place the model never modelled is not
 * a number the model gave.
 */
export function binBeads(
  set: FeatureSet,
  model: StructureModel,
  beads: readonly number[],
  binsize: number,
  bins: number,
): BinnedPoints {
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  const z = new Float64Array(bins)
  const count = new Int32Array(bins)
  for (const i of beads) {
    if (!Number.isFinite(model.x[i]) || !Number.isFinite(model.y[i]) || !Number.isFinite(model.z[i])) continue
    const bin = Math.floor((set.start[i] + set.end[i]) / 2 / binsize)
    if (bin < 0 || bin >= bins) continue
    x[bin] += model.x[i]
    y[bin] += model.y[i]
    z[bin] += model.z[i]
    count[bin]++
  }
  const present = new Uint8Array(bins)
  for (let b = 0; b < bins; b++) {
    if (count[b] === 0) continue
    x[b] /= count[b]
    y[b] /= count[b]
    z[b] /= count[b]
    present[b] = 1
  }
  return { n: bins, x, y, z, present, beads: count }
}

/** Every pairwise distance between the binned points, `NaN` where either is absent. */
export function distanceMatrix(points: BinnedPoints): Float32Array {
  const n = points.n
  const out = new Float32Array(n * n).fill(Number.NaN)
  for (let r = 0; r < n; r++) {
    if (points.present[r] === 0) continue
    out[r * n + r] = 0
    for (let c = r + 1; c < n; c++) {
      if (points.present[c] === 0) continue
      const d = Math.hypot(points.x[c] - points.x[r], points.y[c] - points.y[r], points.z[c] - points.z[r])
      out[r * n + c] = d
      out[c * n + r] = d
    }
  }
  return out
}

/** `1 / d^alpha` over a distance matrix — the contact map a model predicts, up to scale. */
export function inverseDistances(distances: Float32Array, alpha: number): Float32Array {
  const out = new Float32Array(distances.length).fill(Number.NaN)
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i]
    if (Number.isNaN(d)) continue
    out[i] = d > 0 ? 1 / d ** alpha : Number.NaN
  }
  return out
}

/**
 * The mean distance at each genomic separation, in bins, from 1 to `n - 1`;
 * `NaN` at a separation no pair of present bins reaches. The spatial P(s).
 */
export function distanceBySeparation(distances: Float32Array, n: number): Float64Array {
  const sum = new Float64Array(n)
  const count = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    for (let c = r + 1; c < n; c++) {
      const d = distances[r * n + c]
      if (Number.isNaN(d)) continue
      sum[c - r] += d
      count[c - r]++
    }
  }
  const out = new Float64Array(n).fill(Number.NaN)
  for (let s = 1; s < n; s++) if (count[s] > 0) out[s] = sum[s] / count[s]
  return out
}

/** The same for a square of contacts: the map's own P(s) on these bins. */
export function contactsBySeparation(values: Float32Array, n: number): Float64Array {
  return distanceBySeparation(values, n)
}

/**
 * How well the model's distances rank the map's contacts: Spearman's rho
 * between the observed contacts and `1/d` over every pair of present bins
 * at least `minSeparation` apart. Rank-based, so the exponent does not
 * enter: any `1/d^alpha` ranks the same. Positive is agreement.
 */
export function agreement(
  distances: Float32Array,
  contacts: Float32Array,
  n: number,
  minSeparation = 2,
): { rho: number; pairs: number } {
  const a: number[] = []
  const b: number[] = []
  for (let r = 0; r < n; r++) {
    for (let c = r + minSeparation; c < n; c++) {
      const d = distances[r * n + c]
      const v = contacts[r * n + c]
      if (Number.isNaN(d) || d <= 0 || !Number.isFinite(v)) continue
      a.push(1 / d)
      b.push(v)
    }
  }
  return { rho: a.length < 3 ? Number.NaN : spearman(a, b), pairs: a.length }
}

// ---------------------------------------------------------------------------
// The model as tracks
// ---------------------------------------------------------------------------

/** The model's centre of mass over the given beads. */
export function centroid(model: StructureModel, beads: readonly number[]): [number, number, number] | null {
  let x = 0
  let y = 0
  let z = 0
  let n = 0
  for (const i of beads) {
    if (!Number.isFinite(model.x[i]) || !Number.isFinite(model.y[i]) || !Number.isFinite(model.z[i])) continue
    x += model.x[i]
    y += model.y[i]
    z += model.z[i]
    n++
  }
  return n === 0 ? null : [x / n, y / n, z / n]
}

/** Each bead's distance from a point; `NaN` for a bead with no place. */
export function distanceFrom(
  model: StructureModel,
  beads: readonly number[],
  point: readonly [number, number, number],
): Float64Array {
  const out = new Float64Array(beads.length).fill(Number.NaN)
  beads.forEach((i, at) => {
    if (!Number.isFinite(model.x[i])) return
    out[at] = Math.hypot(model.x[i] - point[0], model.y[i] - point[1], model.z[i] - point[2])
  })
  return out
}

/**
 * Local compaction: each bead's mean distance to its neighbours along the
 * chain within `window` beads either side (the ones that exist). Small is
 * compact; a bead alone on its sequence is `NaN`.
 */
export function localCompaction(
  model: StructureModel,
  beads: readonly number[],
  window: number,
): Float64Array {
  const out = new Float64Array(beads.length).fill(Number.NaN)
  const k = Math.max(1, Math.floor(window))
  for (let at = 0; at < beads.length; at++) {
    const i = beads[at]
    if (!Number.isFinite(model.x[i])) continue
    let sum = 0
    let n = 0
    for (let d = -k; d <= k; d++) {
      if (d === 0) continue
      const other = beads[at + d]
      if (other === undefined || !Number.isFinite(model.x[other])) continue
      sum += Math.hypot(model.x[other] - model.x[i], model.y[other] - model.y[i], model.z[other] - model.z[i])
      n++
    }
    if (n > 0) out[at] = sum / n
  }
  return out
}

/**
 * Bead values onto the map's bins for one sequence: the mean over the beads
 * whose middle falls in each bin, written at `startBin + bin`; `NaN` where
 * none does. What a `ProfileOutput` over the whole map is filled from, one
 * sequence at a time.
 */
export function paintProfile(
  set: FeatureSet,
  beads: readonly number[],
  values: Float64Array,
  binsize: number,
  startBin: number,
  bins: number,
  into: Float32Array,
): void {
  const sum = new Float64Array(bins)
  const count = new Int32Array(bins)
  beads.forEach((i, at) => {
    const v = values[at]
    if (!Number.isFinite(v)) return
    const bin = Math.floor((set.start[i] + set.end[i]) / 2 / binsize)
    if (bin < 0 || bin >= bins) return
    sum[bin] += v
    count[bin]++
  })
  for (let b = 0; b < bins; b++) {
    if (count[b] > 0 && startBin + b < into.length) into[startBin + b] = sum[b] / count[b]
  }
}

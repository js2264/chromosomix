/**
 * Two models of the same sequences, put on top of each other (§25.5).
 *
 * A structure is defined up to a rigid motion and a scale — a map carries no
 * unit and no frame, so two models of one map from two solvers, or a loaded
 * model against a reconstruction, sit in unrelated coordinates. Comparing
 * them is a superposition: the beads the two share, by locus, are matched,
 * the second is rotated, scaled and moved so those beads land as close as
 * they can to the first's, and what is left — the root-mean-square distance
 * between matched beads, and each bead's own displacement — is the
 * difference between the models.
 *
 * The rotation is Horn's closed form (the unit quaternion that is the top
 * eigenvector of a 4 × 4 matrix built from the cross-covariance), the scale
 * is Umeyama's, and the eigenvector comes from a Jacobi sweep — all of it a
 * few hundred flops, and none of it a dependency. Pure over arrays; the test
 * holds it still with a model, a copy of it turned, scaled and shifted, and
 * the copy asked back.
 */

import { beadsAt, type Structure } from './scene'

/** How the second model sits on the first, and how far it is from it. */
export interface Alignment {
  /** The second model's beads, in the first's frame. */
  x: Float32Array
  y: Float32Array
  z: Float32Array
  /** For each bead of the first, the matched bead of the second, or -1. */
  partner: Int32Array
  /** Root-mean-square distance between matched beads after the fit, in the first's units. */
  rmsd: number
  matched: number
  /** The fit's scale, rotation (row-major 3 × 3) and translation, for the record. */
  scale: number
  rotation: number[]
  translation: [number, number, number]
}

/**
 * The beads of `other` at each bead of `structure`'s locus: the same
 * sequence name, the bead whose interval holds the midpoint, and the same
 * haplotype where both have several.
 */
export function matchBeads(structure: Structure, other: Structure): Int32Array {
  const set = structure.set
  const partner = new Int32Array(set.length).fill(-1)
  const phased = structure.haplotypes.length > 1 && other.haplotypes.length > 1
  for (let i = 0; i < set.length; i++) {
    if (structure.present[i] === 0) continue
    const contig = set.contigs[set.contig[i]]
    const at = beadsAt(other, contig, (set.start[i] + set.end[i]) / 2)
    if (at.length === 0) continue
    const hap = structure.haplotypes[structure.model.hap[i]]
    const same = phased ? at.find((b) => other.haplotypes[other.model.hap[b]] === hap) : at[0]
    const chosen = same ?? at[0]
    if (other.present[chosen] === 1) partner[i] = chosen
  }
  return partner
}

/**
 * Fit `other` onto `structure` over their matched beads: similarity
 * transform, least squares (Horn 1987 for the rotation, Umeyama 1991 for the
 * scale). `null` where fewer than four beads match, since three points fix a
 * frame and nothing is left to be wrong about.
 */
export function alignTo(structure: Structure, other: Structure): Alignment | null {
  const partner = matchBeads(structure, other)
  const pairs: number[] = []
  for (let i = 0; i < partner.length; i++) if (partner[i] >= 0) pairs.push(i)
  const n = pairs.length
  if (n < 4) return null
  // Centroids of the matched sets.
  const ca = [0, 0, 0]
  const cb = [0, 0, 0]
  for (const i of pairs) {
    const j = partner[i]
    ca[0] += structure.x[i]
    ca[1] += structure.y[i]
    ca[2] += structure.z[i]
    cb[0] += other.x[j]
    cb[1] += other.y[j]
    cb[2] += other.z[j]
  }
  for (let k = 0; k < 3; k++) {
    ca[k] /= n
    cb[k] /= n
  }
  // The cross-covariance M = Σ b'ᵀ a' (b from the other, a from this).
  const m = new Float64Array(9)
  let bb = 0
  for (const i of pairs) {
    const j = partner[i]
    const a = [structure.x[i] - ca[0], structure.y[i] - ca[1], structure.z[i] - ca[2]]
    const b = [other.x[j] - cb[0], other.y[j] - cb[1], other.z[j] - cb[2]]
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] += b[r] * a[c]
    bb += b[0] * b[0] + b[1] * b[1] + b[2] * b[2]
  }
  // Horn's N, whose top eigenvector is the rotation as a unit quaternion.
  const sxx = m[0], sxy = m[1], sxz = m[2]
  const syx = m[3], syy = m[4], syz = m[5]
  const szx = m[6], szy = m[7], szz = m[8]
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ]
  const q = topEigenvector(N)
  const rotation = rotationOf(q)
  // The scale that best matches the rotated other to this: Σ a'·(R b') / Σ |b'|².
  let dot = 0
  for (const i of pairs) {
    const j = partner[i]
    const b = [other.x[j] - cb[0], other.y[j] - cb[1], other.z[j] - cb[2]]
    const rb = apply(rotation, b)
    dot += rb[0] * (structure.x[i] - ca[0]) + rb[1] * (structure.y[i] - ca[1]) + rb[2] * (structure.z[i] - ca[2])
  }
  const scale = bb > 0 ? dot / bb : 1
  const rc = apply(rotation, cb)
  const translation: [number, number, number] = [ca[0] - scale * rc[0], ca[1] - scale * rc[1], ca[2] - scale * rc[2]]
  // Every bead of the other, moved.
  const count = other.set.length
  const x = new Float32Array(count)
  const y = new Float32Array(count)
  const z = new Float32Array(count)
  for (let j = 0; j < count; j++) {
    const r = apply(rotation, [other.x[j], other.y[j], other.z[j]])
    x[j] = scale * r[0] + translation[0]
    y[j] = scale * r[1] + translation[1]
    z[j] = scale * r[2] + translation[2]
  }
  let sum = 0
  for (const i of pairs) {
    const j = partner[i]
    sum += (x[j] - structure.x[i]) ** 2 + (y[j] - structure.y[i]) ** 2 + (z[j] - structure.z[i]) ** 2
  }
  return { x, y, z, partner, rmsd: Math.sqrt(sum / n), matched: n, scale, rotation, translation }
}

/** Each bead's distance to its partner after the fit, `NaN` where it has none. */
export function displacements(structure: Structure, alignment: Alignment): Float32Array {
  const out = new Float32Array(structure.set.length).fill(Number.NaN)
  for (let i = 0; i < out.length; i++) {
    const j = alignment.partner[i]
    if (j < 0) continue
    out[i] = Math.hypot(alignment.x[j] - structure.x[i], alignment.y[j] - structure.y[i], alignment.z[j] - structure.z[i])
  }
  return out
}

/** The rotation matrix of a unit quaternion `[w, x, y, z]`, row-major. */
function rotationOf(q: number[]): number[] {
  const [w, x, y, z] = q
  return [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ]
}

function apply(r: number[], v: number[]): [number, number, number] {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ]
}

/**
 * The eigenvector of the largest eigenvalue of a small symmetric matrix, by
 * cyclic Jacobi rotations: a 4 × 4 converges in a handful of sweeps, and the
 * answer is a unit vector by construction.
 */
export function topEigenvector(a: number[][]): number[] {
  const n = a.length
  const m = a.map((row) => row.slice())
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p][q] * m[p][q]
    if (off < 1e-22) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(m[p][q]) < 1e-300) continue
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p]
          const mkq = m[k][q]
          m[k][p] = c * mkp - s * mkq
          m[k][q] = s * mkp + c * mkq
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k]
          const mqk = m[q][k]
          m[p][k] = c * mpk - s * mqk
          m[q][k] = s * mpk + c * mqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < n; i++) if (m[i][i] > m[best][best]) best = i
  const out = v.map((row) => row[best])
  const norm = Math.hypot(...out)
  return out.map((value) => value / (norm || 1))
}

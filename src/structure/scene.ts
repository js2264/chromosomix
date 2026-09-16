/**
 * A structure as a scene: the beads, the chains they string, and the bridge
 * between a place on the genome and a bead in space (§25).
 *
 * Pure, and deliberately so. Everything a renderer, a painter, a panel and an
 * analysis task want to know about a model that is a *number* lives here, with
 * no DOM, no canvas and no three.js: which bead holds a locus, where a chain
 * breaks, how far two beads are apart in the file's own units, where the
 * centroid is. The three.js adapter and the vector painter are thin over this,
 * so the picture on screen and the picture on paper cannot disagree about a
 * coordinate, and every one of these answers is tested in node.
 *
 * ## The row is the source of truth
 *
 * A scene is built *from* a `FeatureSet` carrying a `model` (`annotations/g3d.ts`)
 * and never copies its loci: the set's `contig`, `start` and `end` arrays are
 * what every locus question is answered from, and the set is what the lane
 * beside the map, the search box and the analysis tasks already read. What the
 * scene adds is the geometry those arrays do not have — chains, gaps, a
 * normalised copy of the coordinates — and an index from a locus to its beads.
 *
 * ## Two coordinate systems, one factor between them
 *
 * The file's coordinates are kept in the model as written, in whatever units
 * the solver used. The scene holds a **normalised** copy — centroid at the
 * origin, radius of gyration one — because that is the only frame in which a
 * default camera, a bead radius and a fog distance mean the same thing for a
 * model in nanometres and one in solver units. `scale` is the factor back, so a
 * distance printed to the reader is in the units the file had; nothing here
 * claims a nanometre (§25's refusal).
 *
 * ## Chains and gaps
 *
 * A chain is one contig of one haplotype, in genomic order. Two beads are
 * neighbours on it when their starts are exactly one spacing apart; a wider
 * jump is a **gap** — a bin the solver left out — and the tube breaks there
 * rather than bridging it, because a line through the gap would be a path
 * this app invented. A bead the file placed at `NaN` is *not present* and
 * breaks its chain the same way.
 */

import { featureRange } from '../annotations/featureset'
import type { FeatureSet, StructureModel } from '../annotations/types'

/** One contig of one haplotype, as the beads string it. */
export interface Chain {
  /** Index into {@link Structure.contigs}. */
  contig: number
  /** Index into the model's haplotype list. */
  hap: number
  /** The bead indices (rows of the set) in genomic order. */
  beads: Int32Array
  /**
   * The runs of consecutive, present beads: `[from, to)` pairs into
   * {@link beads}, flattened. A tube is drawn per run and never across the
   * boundary between two.
   */
  runs: Int32Array
}

export interface Structure {
  /** The row's own set — every locus is read from here. */
  readonly set: FeatureSet
  readonly model: StructureModel
  /** The set's contig names, in its order. */
  readonly contigs: readonly string[]
  readonly haplotypes: readonly string[]
  /** The bead spacing, in base pairs. */
  readonly width: number
  readonly chains: readonly Chain[]
  /** Bead index → index into {@link chains}. */
  readonly chainOf: Int32Array
  /** Bead index → its position along its chain, `0..beads.length-1`. */
  readonly along: Int32Array
  /** Normalised coordinates: centroid at the origin, radius of gyration one. */
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  /** `1` where the file placed the bead, `0` where it is `NaN`. */
  readonly present: Uint8Array
  /** File units per normalised unit — the radius of gyration, in the file's units. */
  readonly scale: number
  /**
   * The typical distance between neighbouring beads, normalised: the median
   * over every run, floored at a fraction of the model's size. Bead and tube
   * radii are fractions of this, so a radius setting reads the same on every
   * model — and stays visible on a dense one.
   */
  readonly step: number
  /** How many beads the file placed. */
  readonly placed: number
}

/** A bead's locus, for a readout or an echo back onto the map. */
export interface BeadLocus {
  contig: string
  start: number
  end: number
  haplotype: string
  /** Index into the model's haplotype list. */
  hap: number
}

/**
 * Build the scene for a set, or `null` for a set that carries no model.
 *
 * One pass over the set for the chains, one for the centroid, one for the
 * radius of gyration and one to normalise — four passes over a few thousand
 * beads, once per row, which is nothing beside the sort the parser already did.
 */
export function buildStructure(set: FeatureSet): Structure | null {
  const model = set.model
  if (model === undefined) return null
  const n = set.length
  const present = new Uint8Array(n)
  let placed = 0
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(model.x[i]) && Number.isFinite(model.y[i]) && Number.isFinite(model.z[i])) {
      present[i] = 1
      placed++
    }
  }

  // The centroid and the radius of gyration over the placed beads only: a bead
  // the file did not place has no say in where the model is.
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    if (present[i] === 0) continue
    cx += model.x[i]
    cy += model.y[i]
    cz += model.z[i]
  }
  if (placed > 0) {
    cx /= placed
    cy /= placed
    cz /= placed
  }
  let sum = 0
  for (let i = 0; i < n; i++) {
    if (present[i] === 0) continue
    const dx = model.x[i] - cx
    const dy = model.y[i] - cy
    const dz = model.z[i] - cz
    sum += dx * dx + dy * dy + dz * dz
  }
  // A model of one bead, or of beads all at one point, has no size to
  // normalise by; one file unit per normalised unit keeps the arithmetic
  // finite and the picture a dot, which is what such a file is.
  const gyration = placed > 0 ? Math.sqrt(sum / placed) : 0
  const scale = gyration > 0 ? gyration : 1

  const x = new Float32Array(n)
  const y = new Float32Array(n)
  const z = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (present[i] === 0) {
      x[i] = Number.NaN
      y[i] = Number.NaN
      z[i] = Number.NaN
      continue
    }
    x[i] = (model.x[i] - cx) / scale
    y[i] = (model.y[i] - cy) / scale
    z[i] = (model.z[i] - cz) / scale
  }

  const chains = chainsOf(set, model, present)
  const chainOf = new Int32Array(n).fill(-1)
  const along = new Int32Array(n).fill(-1)
  chains.forEach((chain, at) => {
    for (let k = 0; k < chain.beads.length; k++) {
      chainOf[chain.beads[k]] = at
      along[chain.beads[k]] = k
    }
  })

  return {
    set,
    model,
    contigs: set.contigs,
    haplotypes: model.haplotypes,
    width: model.width,
    chains,
    chainOf,
    along,
    x,
    y,
    z,
    present,
    scale,
    step: stepOf(chains, x, y, z),
    placed,
  }
}

/**
 * The chains, one per `(contig, haplotype)` that has a bead, in contig order
 * and then haplotype order.
 *
 * Read off the set's per-contig runs rather than by grouping every row: the
 * sort has already put each contig's beads together and its two homologues at
 * every locus side by side, so a chain is a filter over one run.
 */
function chainsOf(set: FeatureSet, model: StructureModel, present: Uint8Array): Chain[] {
  const chains: Chain[] = []
  for (let c = 0; c < set.contigs.length; c++) {
    const from = set.contigAt[c]
    const to = set.contigAt[c + 1]
    if (to <= from) continue
    for (let hap = 0; hap < model.haplotypes.length; hap++) {
      const beads: number[] = []
      for (let i = from; i < to; i++) if (model.hap[i] === hap) beads.push(i)
      if (beads.length === 0) continue
      const indices = Int32Array.from(beads)
      chains.push({ contig: c, hap, beads: indices, runs: runsOf(set, model.width, indices, present) })
    }
  }
  return chains
}

/**
 * The runs of consecutive present beads along one chain, as `[from, to)`
 * pairs into the chain's bead list.
 *
 * A run ends where the next bead is missing, or where it is more than one
 * spacing on — the two ways a solver leaves a hole. A run of one bead is still
 * a run: it draws as a bead and no tube.
 */
function runsOf(set: FeatureSet, width: number, beads: Int32Array, present: Uint8Array): Int32Array {
  const runs: number[] = []
  let from = -1
  for (let k = 0; k < beads.length; k++) {
    const bead = beads[k]
    if (present[bead] === 0) {
      if (from >= 0) runs.push(from, k)
      from = -1
      continue
    }
    if (from < 0) {
      from = k
      continue
    }
    const previous = beads[k - 1]
    const adjacent = set.start[bead] - set.start[previous] <= width
    if (!adjacent) {
      runs.push(from, k)
      from = k
    }
  }
  if (from >= 0) runs.push(from, beads.length)
  return Int32Array.from(runs)
}

/** The median distance between neighbouring beads, over every run. */
function stepOf(chains: readonly Chain[], x: Float32Array, y: Float32Array, z: Float32Array): number {
  const steps: number[] = []
  for (const chain of chains) {
    for (let r = 0; r < chain.runs.length; r += 2) {
      for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
        const a = chain.beads[k - 1]
        const b = chain.beads[k]
        steps.push(Math.hypot(x[b] - x[a], y[b] - y[a], z[b] - z[a]))
      }
    }
  }
  if (steps.length === 0) return 1
  steps.sort((a, b) => a - b)
  const median = steps[steps.length >> 1]
  // Floored at a fraction of the model's own size (the coordinates are
  // normalised to a radius of gyration of 1): a genome of thousands of 5 kb
  // beads steps a hundredth of its extent, and a tube that thin is a hairline
  // on any screen. The floor is what keeps a bead a bead on a dense model,
  // and it is below the step of any model a reader can tell beads apart on.
  return Math.max(median > 0 ? median : 1, STEP_FLOOR)
}

/** The least a step is taken to be, in units of the radius of gyration. */
const STEP_FLOOR = 0.035

// ---------------------------------------------------------------------------
// The bridge: (contig, bp) ↔ bead
// ---------------------------------------------------------------------------

/**
 * The beads holding `bp` on `contig` — one per haplotype, in haplotype order.
 *
 * Every homologue, because the map beside the model has one axis and one
 * `chr7`, and a locus on it is a locus on both chains. Where no bead's interval
 * holds the base — a gap the solver left, or a position past the last bead —
 * the nearest bead of each haplotype is answered *if it is within one spacing*,
 * and nothing otherwise: a bead lit for a locus it is not at would be the one
 * claim a model beside a map must never make. The same refusal
 * `PanelDeck.echoHover` makes off the end of a shorter block.
 *
 * A binary search over the contig's run, which the sort makes possible: rows
 * are ordered by start, and every bead is one spacing wide, so the candidates
 * are the beads whose start is the last one at or before `bp` and, for the
 * nearest-bead rule, the one after it.
 */
export function beadsAt(structure: Structure, contig: string, bp: number): number[] {
  const set = structure.set
  const c = contigIndex(structure, contig)
  if (c < 0 || !Number.isFinite(bp)) return []
  const from = set.contigAt[c]
  const to = set.contigAt[c + 1]
  if (to <= from) return []
  // Every bead starting before or at `bp`, and every bead starting after: the
  // boundary between them is where the answer is, on both sides of it.
  const first = lowerBound(set.start, from, to, Math.floor(bp) + 1) // first start > bp
  const perHap = new Map<number, { bead: number; away: number }>()
  const consider = (bead: number): void => {
    const start = set.start[bead]
    const end = set.end[bead]
    const away = bp < start ? start - bp : bp >= end ? bp - end + 1 : 0
    if (away > structure.width) return
    const hap = structure.model.hap[bead]
    const held = perHap.get(hap)
    if (held === undefined || away < held.away) perHap.set(hap, { bead, away })
  }
  // The beads at the last start at or before `bp` (all haplotypes share it), and
  // the beads at the first start after it.
  for (let i = first - 1; i >= from && set.start[i] === set.start[first - 1]; i--) consider(i)
  for (let i = first; i < to && set.start[i] === set.start[first]; i++) consider(i)
  // Exact hits win over near misses on every haplotype: a homologue whose bead
  // holds the base must not be answered with its neighbour because the other
  // homologue has a gap there.
  const exact = [...perHap.values()].some((held) => held.away === 0)
  return [...perHap.entries()]
    .filter(([, held]) => !exact || held.away === 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, held]) => held.bead)
}

/**
 * Every bead overlapping `[from, to)` on `contig`, in set order — both
 * haplotypes interleaved, as the set holds them.
 *
 * The same backed-off binary search `featureRange` makes, with the back-off
 * being one spacing since every bead is that wide.
 */
export function beadsIn(structure: Structure, contig: string, from: number, to: number): number[] {
  const set = structure.set
  const c = contigIndex(structure, contig)
  if (c < 0) return []
  const [lo, hi] = featureRange(set, c, from, to)
  const out: number[] = []
  for (let i = lo; i < hi; i++) {
    if (set.end[i] > from && set.start[i] < to) out.push(i)
  }
  return out
}

/** Where a bead is on the genome, and on which homologue. */
export function lociOf(structure: Structure, bead: number): BeadLocus {
  const set = structure.set
  const hap = structure.model.hap[bead]
  return {
    contig: set.contigs[set.contig[bead]],
    start: set.start[bead],
    end: set.end[bead],
    haplotype: structure.haplotypes[hap] ?? '',
    hap,
  }
}

/**
 * The distance between two beads **in the file's own units**, or `NaN` where
 * either is not placed.
 */
export function distanceBetween(structure: Structure, a: number, b: number): number {
  if (structure.present[a] === 0 || structure.present[b] === 0) return Number.NaN
  return (
    Math.hypot(
      structure.x[b] - structure.x[a],
      structure.y[b] - structure.y[a],
      structure.z[b] - structure.z[a],
    ) * structure.scale
  )
}

/** Every bead of a contig, both haplotypes, in set order; `[]` for a name the model lacks. */
export function beadsOf(structure: Structure, contig: string): number[] {
  const c = contigIndex(structure, contig)
  if (c < 0) return []
  const out: number[] = []
  for (let i = structure.set.contigAt[c]; i < structure.set.contigAt[c + 1]; i++) out.push(i)
  return out
}

/** The contig names the model has, in the set's order. */
export function contigsOf(structure: Structure): string[] {
  return [...structure.contigs]
}

function contigIndex(structure: Structure, contig: string): number {
  return structure.contigs.indexOf(contig)
}

/** First index in `[from, to)` whose value is `>= target`, else `to`. */
function lowerBound(values: Int32Array, from: number, to: number, target: number): number {
  let low = from
  let high = to
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid] >= target) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * The centroid of a set of beads, normalised, for framing a camera on them.
 *
 * `null` where none of them is placed.
 */
export function centroidOf(
  structure: Structure,
  beads: Iterable<number>,
): { x: number; y: number; z: number; radius: number } | null {
  let count = 0
  let cx = 0
  let cy = 0
  let cz = 0
  const held: number[] = []
  for (const bead of beads) {
    if (structure.present[bead] === 0) continue
    held.push(bead)
    cx += structure.x[bead]
    cy += structure.y[bead]
    cz += structure.z[bead]
    count++
  }
  if (count === 0) return null
  cx /= count
  cy /= count
  cz /= count
  let radius = 0
  for (const bead of held) {
    const d = Math.hypot(structure.x[bead] - cx, structure.y[bead] - cy, structure.z[bead] - cz)
    if (d > radius) radius = d
  }
  return { x: cx, y: cy, z: cz, radius }
}

/**
 * How much two interval sets have in common.
 *
 * The question that follows every domain call and every loop call — *how many of
 * mine sit on one of yours* — and it is here because the answer people reach for
 * is usually the wrong one. A count of overlapping features depends on which set
 * you count from and is not symmetric; a Jaccard index over *bases* is symmetric
 * and is the number two sets can be compared by. Both are reported, because both
 * are asked for and confusing them is the common mistake.
 *
 * A merge join rather than an interval tree. `FeatureSet` is already sorted by
 * `(contig, start)` and carries a per-contig index (§8.4), so the sets can be
 * walked in step in linear time — and the tree that would be needed if they were
 * not is a data structure this app would have to keep correct for one task.
 */

import type { FeatureSet } from '../annotations/types'

/** What a comparison of two sets yields. */
export interface OverlapResult {
  /** Bases covered by each set, after merging its own overlapping intervals. */
  basesA: number
  basesB: number
  /** Bases in both. */
  intersection: number
  /** Bases in either. */
  union: number
  /** `intersection / union`, on `[0, 1]`. Symmetric. */
  jaccard: number
  /** Features of A that touch any feature of B, and the other way round. */
  featuresAHit: number
  featuresBHit: number
  featuresA: number
  featuresB: number
}

/** One contig's intervals, merged so a set cannot double-count itself. */
function mergedRuns(set: FeatureSet, contig: string, minOverlap: number): Array<[number, number]> {
  const id = set.contigs.indexOf(contig)
  if (id < 0) return []
  const runs: Array<[number, number]> = []
  for (let i = set.contigAt[id]; i < set.contigAt[id + 1]; i++) {
    const start = set.start[i]
    const end = set.end[i]
    if (end <= start) continue
    const last = runs[runs.length - 1]
    // Sorted by start, so a new interval either extends the last run or begins a
    // new one. Merging first is what stops a set that overlaps itself — a GTF
    // with one row per transcript is the usual case — from counting the same
    // base several times and reporting a coverage above the chromosome.
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else runs.push([start, end])
  }
  void minOverlap
  return runs
}

/** Total length of a run list. */
function spanOf(runs: ReadonlyArray<[number, number]>): number {
  let total = 0
  for (const [start, end] of runs) total += end - start
  return total
}

/** Bases in both run lists, by walking them in step. */
function intersectionOf(
  a: ReadonlyArray<[number, number]>,
  b: ReadonlyArray<[number, number]>,
): number {
  let total = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0])
    const hi = Math.min(a[i][1], b[j][1])
    if (hi > lo) total += hi - lo
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return total
}

/** How many features of `set` touch any run of `other`, on one contig. */
function hitsOn(
  set: FeatureSet,
  contig: string,
  other: ReadonlyArray<[number, number]>,
  minFraction: number,
): number {
  const id = set.contigs.indexOf(contig)
  if (id < 0 || other.length === 0) return 0
  let hits = 0
  let j = 0
  for (let i = set.contigAt[id]; i < set.contigAt[id + 1]; i++) {
    const start = set.start[i]
    const end = set.end[i]
    const length = end - start
    if (length <= 0) continue
    while (j < other.length && other[j][1] <= start) j++
    let covered = 0
    for (let k = j; k < other.length && other[k][0] < end; k++) {
      covered += Math.max(0, Math.min(end, other[k][1]) - Math.max(start, other[k][0]))
    }
    if (covered / length >= minFraction && covered > 0) hits++
  }
  return hits
}

/**
 * Compare two sets over the sequences they share.
 *
 * Sequences only one of them mentions contribute their own bases to the union
 * and nothing to the intersection, which is the honest reading: a peak set
 * covering only chromosome I against a genome-wide annotation genuinely overlaps
 * on a small fraction of the genome, and hiding that by restricting to the
 * shared contigs would report a Jaccard that flatters both.
 */
export function compareSets(
  a: FeatureSet,
  b: FeatureSet,
  options: { minFraction: number },
): OverlapResult {
  const contigs = new Set([...a.contigs, ...b.contigs])
  let basesA = 0
  let basesB = 0
  let intersection = 0
  let featuresAHit = 0
  let featuresBHit = 0

  for (const contig of contigs) {
    const runsA = mergedRuns(a, contig, options.minFraction)
    const runsB = mergedRuns(b, contig, options.minFraction)
    basesA += spanOf(runsA)
    basesB += spanOf(runsB)
    intersection += intersectionOf(runsA, runsB)
    featuresAHit += hitsOn(a, contig, runsB, options.minFraction)
    featuresBHit += hitsOn(b, contig, runsA, options.minFraction)
  }

  const union = basesA + basesB - intersection
  return {
    basesA,
    basesB,
    intersection,
    union,
    // Two empty sets have no Jaccard rather than a perfect one: `0/0` is not 1,
    // and reporting agreement between two things that say nothing would be the
    // most flattering possible reading of no data.
    jaccard: union > 0 ? intersection / union : Number.NaN,
    featuresAHit,
    featuresBHit,
    featuresA: a.length,
    featuresB: b.length,
  }
}

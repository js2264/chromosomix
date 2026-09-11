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
import { makeRandom } from './random'

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

// ---------------------------------------------------------------------------
// The null
// ---------------------------------------------------------------------------

/**
 * What a shuffled comparison yields, beside the observed one.
 *
 * Every number above is descriptive, and a descriptive number about two interval
 * sets has no scale of its own: forty per cent of a loop set sitting on a
 * boundary is either the result the run was made for or exactly what any forty
 * per cent of the genome would have given, and nothing in {@link OverlapResult}
 * distinguishes them. This is the distinction, and it is the reason the task
 * exists at all — §18.8 gives *how many of my loops sit on a boundary* as the
 * question that follows every domain call, and that question is not answerable
 * without one.
 *
 * The null is `bedtools shuffle`'s: one set is relocated uniformly at random
 * **within the sequences it already occupies**, preserving its per-sequence
 * count and its length distribution exactly. Preserving both is what makes the
 * comparison about *position* — a set of four hundred 2 kb intervals on
 * chromosome I is compared against four hundred 2 kb intervals on chromosome I,
 * so neither the size of the features nor which chromosomes they are on can
 * carry the signal.
 */
export interface ShuffleResult {
  iterations: number
  /** Statistics of the null, in the same units as the observed ones. */
  jaccard: NullStat
  intersection: NullStat
  featuresHit: NullStat
  /** Sequences whose length was not known and was taken from the data. */
  assumedLengths: string[]
  /** Sequences dropped because neither a length nor an interval end gave one. */
  droppedContigs: string[]
}

/** One statistic's observed value against the distribution of its null. */
export interface NullStat {
  observed: number
  mean: number
  sd: number
  /** `(observed − mean) / sd`, or `NaN` where the null never varied. */
  z: number
  /** `observed / mean`, the fold enrichment. `NaN` against an all-zero null. */
  fold: number
  /** `(#{null ≥ observed} + 1) / (iterations + 1)`. Never zero, by construction. */
  pEnriched: number
  /** The other tail, on the same convention. */
  pDepleted: number
}

/** One sequence's geometry, worked out once so an iteration re-derives nothing. */
interface ShufflePlan {
  contig: string
  /** The span a relocated interval may start in. */
  length: number
  /** Lengths of the shuffled set's intervals here, in file order. */
  lengths: number[]
  /** The fixed set's merged runs here. */
  runs: Array<[number, number]>
}

/**
 * Bases in both, where one side is a raw sorted interval list rather than a set.
 *
 * The same walk as {@link intersectionOf}, over a shuffled draw that has been
 * sorted but deliberately **not** merged — see {@link shuffleNull} for why the
 * merge happens here rather than before.
 */
function scanDraw(
  starts: Float64Array,
  lengths: readonly number[],
  order: Int32Array,
  runs: ReadonlyArray<[number, number]>,
  minFraction: number,
): { intersection: number; covered: number; hits: number } {
  let intersection = 0
  let covered = 0
  let hits = 0
  // Two pointers rather than one, and both advance monotonically because the
  // draw is sorted: `hit` walks the runs for the per-feature test and `merge`
  // walks them for the intersection of the merged draw. One shared pointer
  // cannot do both — the merged run closes *behind* the feature that opened it —
  // and restarting either from zero turns a linear pass into `n × m`, which on a
  // genome-wide set at a thousand iterations is the whole cost of the task.
  let hit = 0
  let merge = 0
  // The merge of the draw's own overlaps, carried as a single open run so that
  // neither `covered` nor `intersection` counts a base twice. A shuffled set
  // overlaps itself about as often as a real one does, and a null that
  // double-counts is a null whose Jaccard denominator is wrong in the direction
  // that flatters the observed value.
  let openFrom = Number.NaN
  let openTo = Number.NaN
  const closeRun = (): void => {
    if (Number.isNaN(openFrom)) return
    covered += openTo - openFrom
    while (merge < runs.length && runs[merge][1] <= openFrom) merge++
    for (let at = merge; at < runs.length && runs[at][0] < openTo; at++) {
      intersection += Math.min(openTo, runs[at][1]) - Math.max(openFrom, runs[at][0])
    }
  }

  for (let i = 0; i < order.length; i++) {
    const which = order[i]
    const start = starts[which]
    const end = start + lengths[which]

    // The per-feature hit test is against the *feature*, not against the merged
    // run it may be part of: a feature counts as hit when `minFraction` of its
    // own length is inside the other set, and merging it with its neighbour
    // first would ask about a longer thing than the reader loaded.
    while (hit < runs.length && runs[hit][1] <= start) hit++
    let inside = 0
    for (let k = hit; k < runs.length && runs[k][0] < end; k++) {
      inside += Math.max(0, Math.min(end, runs[k][1]) - Math.max(start, runs[k][0]))
    }
    const length = end - start
    if (length > 0 && inside > 0 && inside / length >= minFraction) hits++

    if (Number.isNaN(openFrom)) {
      openFrom = start
      openTo = end
    } else if (start <= openTo) {
      openTo = Math.max(openTo, end)
    } else {
      closeRun()
      openFrom = start
      openTo = end
    }
  }
  closeRun()
  return { intersection, covered, hits }
}

/** Mean, sd and the two tails of one statistic's null. */
function summarise(observed: number, draws: Float64Array): NullStat {
  const n = draws.length
  let total = 0
  for (let i = 0; i < n; i++) total += draws[i]
  const mean = n > 0 ? total / n : Number.NaN
  let ss = 0
  for (let i = 0; i < n; i++) ss += (draws[i] - mean) ** 2
  // The sample standard deviation: the draws are a sample of the null and not
  // the null itself, and `n` rather than `n − 1` understates it by a factor that
  // matters at the iteration counts somebody in a hurry will choose.
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : Number.NaN
  let atLeast = 0
  let atMost = 0
  for (let i = 0; i < n; i++) {
    if (draws[i] >= observed) atLeast++
    if (draws[i] <= observed) atMost++
  }
  return {
    observed,
    mean,
    sd,
    z: sd > 0 ? (observed - mean) / sd : Number.NaN,
    fold: mean > 0 ? observed / mean : Number.NaN,
    // The `+1` on both halves is Phipson and Smyth's correction, and it is not
    // decoration: an uncorrected permutation p can come out at exactly zero,
    // which claims a significance the number of iterations cannot support. The
    // floor this gives is `1 / (iterations + 1)`, which is the strongest claim a
    // thousand shuffles are entitled to make.
    pEnriched: (atLeast + 1) / (n + 1),
    pDepleted: (atMost + 1) / (n + 1),
  }
}

/**
 * The observed comparison against `iterations` relocations of one set.
 *
 * `shuffle` is the set that moves and `fixed` is the set it is compared against;
 * which of the reader's two that is, is a parameter, because the per-feature
 * statistic is not symmetric and neither is the question — *are my loops on
 * boundaries* and *are boundaries on my loops* have different nulls.
 *
 * Sequences are handled independently and only the ones the shuffled set already
 * occupies are drawn on. That is the deliberate half of the design: a null that
 * scattered a chromosome I peak set across the whole genome would be testing
 * whether the set is on chromosome I, which is not in doubt, and would report an
 * enrichment of sixteen on a set that is merely local.
 */
export function shuffleNull(
  shuffle: FeatureSet,
  fixed: FeatureSet,
  options: {
    minFraction: number
    iterations: number
    seed: number
    /** A sequence's length, where the caller knows it. */
    lengthOf(contig: string): number | undefined
    /** Polled between iterations; `true` abandons the run. */
    cancelled?(): boolean
    onProgress?(done: number, total: number): void
  },
): ShuffleResult | null {
  const observed = compareSets(shuffle, fixed, { minFraction: options.minFraction })
  const plans: ShufflePlan[] = []
  const assumedLengths: string[] = []
  const droppedContigs: string[] = []

  for (const contig of shuffle.contigs) {
    const id = shuffle.contigs.indexOf(contig)
    const lengths: number[] = []
    let furthest = 0
    for (let i = shuffle.contigAt[id]; i < shuffle.contigAt[id + 1]; i++) {
      const span = shuffle.end[i] - shuffle.start[i]
      if (span <= 0) continue
      lengths.push(span)
      furthest = Math.max(furthest, shuffle.end[i])
    }
    if (lengths.length === 0) continue
    const known = options.lengthOf(contig)
    // The fallback is the furthest end either set reaches here, and it is
    // recorded rather than used silently: a null drawn on a span shorter than
    // the real sequence packs the intervals more tightly than chance would and
    // reports an enrichment that is partly the missing chrom.sizes.
    let length = known
    if (length === undefined || length <= 0) {
      const other = fixed.contigs.indexOf(contig)
      let end = furthest
      if (other >= 0) {
        for (let i = fixed.contigAt[other]; i < fixed.contigAt[other + 1]; i++) {
          end = Math.max(end, fixed.end[i])
        }
      }
      length = end
      assumedLengths.push(contig)
    }
    if (!Number.isFinite(length) || length <= 0) {
      droppedContigs.push(contig)
      continue
    }
    plans.push({
      contig,
      length,
      lengths,
      runs: mergedRuns(fixed, contig, options.minFraction),
    })
  }

  if (plans.length === 0) return null

  const iterations = Math.max(1, Math.trunc(options.iterations))
  const rng = makeRandom(options.seed)
  const jaccard = new Float64Array(iterations)
  const intersection = new Float64Array(iterations)
  const featuresHit = new Float64Array(iterations)

  // Allocated once for the largest sequence and reused, because a thousand
  // iterations over a genome-wide set is a thousand allocations per sequence
  // otherwise, and the garbage that produces is the whole of this loop's cost on
  // a set of any size.
  let widest = 0
  for (const plan of plans) widest = Math.max(widest, plan.lengths.length)
  const starts = new Float64Array(widest)
  const order = new Int32Array(widest)

  for (let iteration = 0; iteration < iterations; iteration++) {
    if (options.cancelled?.() === true) return null
    let drawnIntersection = 0
    let drawnCovered = 0
    let drawnHits = 0
    for (const plan of plans) {
      const n = plan.lengths.length
      for (let i = 0; i < n; i++) {
        // `length − span` and not `length`: an interval whose start is drawn in
        // the last kilobase of a sequence would otherwise hang off the end of
        // it, which both shortens it and moves it somewhere no feature can be.
        const room = Math.max(0, plan.length - plan.lengths[i])
        starts[i] = Math.floor(rng() * (room + 1))
        order[i] = i
      }
      const slice = order.subarray(0, n)
      slice.sort((x, y) => starts[x] - starts[y])
      const scanned = scanDraw(starts, plan.lengths, slice, plan.runs, options.minFraction)
      drawnIntersection += scanned.intersection
      drawnCovered += scanned.covered
      drawnHits += scanned.hits
    }
    intersection[iteration] = drawnIntersection
    featuresHit[iteration] = drawnHits
    // The union is recomputed from the draw rather than reused from the observed
    // comparison: a shuffled set covers slightly fewer bases than the real one
    // wherever the real one overlapped itself, and holding the denominator fixed
    // would put that difference into the Jaccard as signal.
    const union = drawnCovered + observed.basesB - drawnIntersection
    jaccard[iteration] = union > 0 ? drawnIntersection / union : Number.NaN
    options.onProgress?.(iteration + 1, iterations)
  }

  return {
    iterations,
    jaccard: summarise(observed.jaccard, jaccard),
    intersection: summarise(observed.intersection, intersection),
    featuresHit: summarise(observed.featuresAHit, featuresHit),
    assumedLengths,
    droppedContigs,
  }
}

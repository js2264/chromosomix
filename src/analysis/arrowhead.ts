/**
 * Arrowhead — Juicer's contact-domain caller, ported.
 *
 * Rao et al. 2014's *Arrowhead*, as `juicer_tools arrowhead` computes it: the
 * transform that turns a domain into an arrowhead pointing at the diagonal, the
 * corner score read off two triangles of it, and the two passes — a strict one
 * whose blocks are kept, and a lenient one whose blocks are added where they do
 * not collide with them. The source is `juicebox.tools.utils.juicer.arrowhead`
 * in the Juicebox repository, which is what `juicer_tools_1.22.01.jar` was
 * built from and what JuicerTools 2 carries unchanged; every function below
 * names the Java it is.
 *
 * **The port does not get to improve on it** (§18.9), and three places where a
 * first reading takes the Java for an oversight are kept as they are:
 *
 * - the last window of a sequence is *sized* from `limEnd − matrixWidth` and
 *   *read* from `limStart`, so it holds the sequence's tail and then zeros, and
 *   its calls are placed from `limStart` (`BlockBuster.callSubBlockbuster`);
 * - the lenient pass's blocks are taken out of a `HashSet` before the greedy
 *   step that adds those that do not collide, so the order they are tried in is
 *   that set's iteration order — reproduced here, hash for hash, from
 *   `Objects.hash` and `HashMap`'s buckets ({@link javaHashSetOrder});
 * - a domain is reported from `i · resolution` to `j · resolution`, the starts
 *   of its two corner bins, which is what Juicer's BEDPE holds.
 *
 * Every sum is accumulated in the order the Java accumulates it, in doubles, so
 * the scores are the Java's to the last bit on the same input — which matters
 * beyond tidiness, because the set's order above is decided by the bits of the
 * scores.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `BlockBuster`'s six thresholds and `Arrowhead`'s window, with Juicer's defaults. */
export interface ArrowheadSettings {
  /** `-m`: the side of each window along the diagonal, in bins. */
  matrixSize: number
  /** Upper and lower variance summed, above which the strict pass drops a corner. */
  varThreshold: number
  /** The sign agreement the strict pass asks of both triangles. */
  highSignThreshold: number
  /** The lenient pass starts at this sign agreement… */
  maxLowSignThreshold: number
  /** …and lowers it to this one, until a sequence has a block… */
  minLowSignThreshold: number
  /** …by this much at a time. */
  decrementLowSignThreshold: number
  /** A lenient block must be wider than this many bins to be added. */
  minBlockSize: number
}

/** Juicer's own: `Arrowhead.matrixSize` and the statics of `BlockBuster`. */
export const ARROWHEAD_DEFAULTS: Readonly<ArrowheadSettings> = {
  matrixSize: 2000,
  varThreshold: 0.2,
  highSignThreshold: 0.5,
  maxLowSignThreshold: 0.4,
  minLowSignThreshold: 0,
  decrementLowSignThreshold: 0.1,
  minBlockSize: 60,
}

/** `BlockResults`' fixed gap: the transform starts this many bins from the diagonal. */
const GAP = 7

/** One corner: Juicer's `HighScore`. `i < j`, in bins until {@link callDomains} scales them. */
export interface HighScore {
  i: number
  j: number
  score: number
  uVarScore: number
  lVarScore: number
  upSign: number
  loSign: number
}

// ---------------------------------------------------------------------------
// One window
// ---------------------------------------------------------------------------

/** Where `(i, j)`, `j ≥ i`, sits in a packed upper triangle of side `n`. */
function rowStarts(n: number): Float64Array {
  // Float64 rather than Int32: at n = 2001 the triangle holds two million cells,
  // well inside 2³¹, but a reader who asks for a wider window should not meet a
  // wrap-around before they meet the memory.
  const starts = new Float64Array(n)
  for (let i = 0; i < n; i++) starts[i] = i * n - (i * (i - 1)) / 2 - i
  return starts
}

/**
 * The scores a window gives, under each pair of thresholds asked for.
 *
 * `BlockResults`' constructor and the `MatrixTriangles` it builds, run once per
 * window rather than once per threshold: the triangles do not depend on the
 * thresholds, which are only applied afterwards to a copy of the block score —
 * so the six passes Juicer makes over each window (five lenient, one strict)
 * cost one transform here and six component searches.
 *
 * `observed` is the window, `n × n`, row-major and symmetric, as
 * `HiCFileTools.extractLocalBoundedRegion` and `fillLowerLeftTriangle` leave it:
 * a cell Juicer would have dropped (a `NaN` normalised count) is `0`.
 */
export function windowCorners(
  observed: ArrayLike<number>,
  n: number,
  thresholds: ReadonlyArray<{ varThreshold: number; signThreshold: number }>,
): HighScore[][] {
  const start = rowStarts(n)
  const at = (i: number, j: number): number => start[i] + j
  const { score, upVar, loVar, upSignMean, loSignMean } = blockScores(observed, n, start)

  // -- thresholdScoreValues, extractConnectedComponents, calculateResults.
  const labels = new Int32Array(score.length)
  const out: HighScore[][] = []
  for (const { varThreshold, signThreshold } of thresholds) {
    const kept = (cell: number): boolean => {
      // signThresholdInternalValues zeroes where `-upSign < t || loSign < t`;
      // varThresholdInternalValues where the summed variance is above it.
      if (-upSignMean[cell] < signThreshold || loSignMean[cell] < signThreshold) return false
      if (!Number.isNaN(varThreshold) && upVar[cell] + loVar[cell] > varThreshold) return false
      return score[cell] > 0
    }
    out.push(
      components(n, start, kept, labels).map((cells) => {
        // getHighestScoringPoint: the component's highest score. Juicer walks a
        // `HashSet<Point>` and keeps the first of equal highs; two cells of one
        // component with the same score to the bit are not met in practice, and
        // the first in the order the fill met them is kept here.
        let bestI = cells[0]
        let bestJ = cells[1]
        let bestScore = score[at(bestI, bestJ)]
        for (let c = 2; c < cells.length; c += 2) {
          const value = score[at(cells[c], cells[c + 1])]
          if (value > bestScore) {
            bestScore = value
            bestI = cells[c]
            bestJ = cells[c + 1]
          }
        }
        const cell = at(bestI, bestJ)
        return {
          i: bestI,
          j: bestJ,
          score: score[cell],
          uVarScore: upVar[cell],
          lVarScore: loVar[cell],
          upSign: -upSignMean[cell],
          loSign: loSignMean[cell],
        }
      }),
    )
  }
  return out
}

/** The six running sums `MatrixTriangles` reads, over a packed upper triangle. */
interface Sums {
  rSum: Float64Array
  rSign: Int32Array
  rSq: Float64Array
  uSum: Float64Array
  uSign: Int32Array
  uSq: Float64Array
}

/**
 * The transform, and the column and row sums of it, its signs and its squares.
 *
 * `BlockResults.calculateDirectionalityIndexUpstream` with `setNaNs(…, 0)`, then
 * `DynamicProgrammingUtils.right` and `.upper` of the three. The sums of the
 * signs are integers, held as such; the ones' are a count, `j − i + 1`, and are
 * not held at all. Its own function so that the transform is let go once the
 * sums are made.
 */
function triangleSums(observed: ArrayLike<number>, n: number, start: Float64Array): Sums {
  const size = (n * (n + 1)) / 2
  const at = (i: number, j: number): number => start[i] + j

  const d = new Float64Array(size)
  for (let i = 0; i < n; i++) {
    let window = Math.min(n - (i + GAP), i - GAP)
    window = Math.min(window, n)
    if (window < GAP) continue
    const row = i * n
    for (let t = 0; t <= window - GAP; t++) {
      const a = observed[row + i - GAP - t]
      const b = observed[row + i + GAP + t]
      const v = (a - b) / (a + b)
      d[at(i, i + GAP + t)] = Number.isNaN(v) ? 0 : v
    }
  }
  const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0)

  // right: a column summed from the diagonal up, `M(i, j) + R(i + 1, j)`.
  const rSum = new Float64Array(size)
  const rSign = new Int32Array(size)
  const rSq = new Float64Array(size)
  for (let j = 0; j < n; j++) {
    const diag = d[at(j, j)]
    rSum[at(j, j)] = diag
    rSign[at(j, j)] = sign(diag)
    rSq[at(j, j)] = diag * diag
    for (let i = j - 1; i >= 0; i--) {
      const v = d[at(i, j)]
      const below = at(i + 1, j)
      rSum[at(i, j)] = v + rSum[below]
      rSign[at(i, j)] = sign(v) + rSign[below]
      rSq[at(i, j)] = v * v + rSq[below]
    }
  }
  // upper: a row summed from the diagonal out, `M(i, j) + U(i, j − 1)`.
  const uSum = new Float64Array(size)
  const uSign = new Int32Array(size)
  const uSq = new Float64Array(size)
  for (let i = 0; i < n; i++) {
    const diag = d[at(i, i)]
    uSum[at(i, i)] = diag
    uSign[at(i, i)] = sign(diag)
    uSq[at(i, i)] = diag * diag
    for (let j = i + 1; j < n; j++) {
      const v = d[at(i, j)]
      const left = at(i, j - 1)
      uSum[at(i, j)] = v + uSum[left]
      uSign[at(i, j)] = sign(v) + uSign[left]
      uSq[at(i, j)] = v * v + uSq[left]
    }
  }
  return { rSum, rSign, rSq, uSum, uSign, uSq }
}

/**
 * `MatrixTriangles`' constructor and `generateBlockScoreCalculations`, a row at
 * a time: every recurrence of the upper and the lower triangle runs along a row,
 * so nothing of either has to be held but what the score and the thresholds
 * read. The sums are let go when this returns.
 */
function blockScores(
  observed: ArrayLike<number>,
  n: number,
  start: Float64Array,
): {
  score: Float64Array
  upVar: Float64Array
  loVar: Float64Array
  upSignMean: Float64Array
  loSignMean: Float64Array
} {
  const { rSum, rSign, rSq, uSum, uSign, uSq } = triangleSums(observed, n, start)
  const size = (n * (n + 1)) / 2
  const at = (i: number, j: number): number => start[i] + j
  const score = new Float64Array(size)
  const upVar = new Float64Array(size)
  const loVar = new Float64Array(size)
  const upSignMean = new Float64Array(size)
  const loSignMean = new Float64Array(size)
  // `calculateMax` starts from entry (0, 0), which is 0 in all three, and the
  // lower triangle it also walks is 0 throughout.
  let maxDiff = 0
  let maxSign = 0
  let maxVar = 0
  for (let i = 0; i < n; i++) {
    let up = 0
    let upS = 0
    let upQ = 0
    let upC = 0
    let lo = 0
    let loS = 0
    let loQ = 0
    let loC = 0
    for (let j = i + 1; j < n; j++) {
      // Upper: half of column j, from row i down to i + bottom.
      const bottom = Math.floor((j - i + 1) / 2)
      const top = at(i, j)
      const cut = at(i + bottom, j)
      up = up + rSum[top] - rSum[cut]
      upS = upS + rSign[top] - rSign[cut]
      upQ = upQ + rSq[top] - rSq[cut]
      upC = upC + (j - i + 1) - (j - (i + bottom) + 1)
      // Lower: row j out to 2j − i, less the column below the midpoint.
      const endpt = Math.min(2 * j - i, n - 1)
      const across = at(j, endpt)
      const under = at(i + bottom, j)
      loC = loC + (endpt - j + 1) - (j - (i + bottom) + 1)
      lo = lo + uSum[across] - rSum[under]
      loS = loS + uSign[across] - rSign[under]
      loQ = loQ + uSq[across] - rSq[under]

      // replaceValue(count, 0, 1), then elementBasedDivision.
      const uc = upC === 0 ? 1 : upC
      const lc = loC === 0 ? 1 : loC
      const upMean = up / uc
      const upSignM = upS / uc
      const loMean = lo / lc
      const loSignM = loS / lc
      const uv = upQ / uc - upMean * upMean
      const lv = loQ / lc - loMean * loMean

      const cell = at(i, j)
      const dd = loMean - upMean
      const ds = loSignM - upSignM
      const vs = uv + lv
      score[cell] = dd
      upVar[cell] = uv
      loVar[cell] = lv
      upSignMean[cell] = upSignM
      loSignMean[cell] = loSignM
      if (maxDiff < dd) maxDiff = dd
      if (maxSign < ds) maxSign = ds
      if (maxVar < vs) maxVar = vs
    }
  }

  // normalizeByMax is `scalarMultiply(1 / max)`: a product by the reciprocal,
  // not a quotient, and a max of 0 makes every score NaN rather than skipping
  // the window — which then simply has no positive cell.
  const kDiff = 1 / maxDiff
  const kSign = 1 / maxSign
  const kVar = 1 / maxVar
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cell = at(i, j)
      const ds = loSignMean[cell] - upSignMean[cell]
      const vs = upVar[cell] + loVar[cell]
      score[cell] = score[cell] * kDiff + ds * kSign - vs * kVar
    }
  }
  return { score, upVar, loVar, upSignMean, loSignMean }
}

/**
 * The 8-connected components of the kept cells, in the order Juicer lists them.
 *
 * `BinaryConnectedComponents.detection` labels in raster order and lists its
 * components by their lowest label, and the lowest label of a component is the
 * one its first cell in raster order was given — so components come out in the
 * order of their first cell, row by row, which is what a flood fill started in
 * raster order gives. Each component is its cells as `[i, j, i, j, …]`, in the
 * order the fill met them; only the upper triangle can be kept, the diagonal
 * and below being 0.
 */
function components(
  n: number,
  start: Float64Array,
  kept: (cell: number) => boolean,
  labels: Int32Array,
): number[][] {
  labels.fill(0)
  const found: number[][] = []
  const stack: number[] = []
  let next = 1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cell = start[i] + j
      if (labels[cell] !== 0 || !kept(cell)) continue
      const label = next++
      labels[cell] = label
      const cells: number[] = []
      stack.push(i, j)
      while (stack.length > 0) {
        const cj = stack.pop() as number
        const ci = stack.pop() as number
        cells.push(ci, cj)
        for (let di = -1; di <= 1; di++) {
          const ni = ci + di
          if (ni < 0 || ni >= n) continue
          for (let dj = -1; dj <= 1; dj++) {
            const nj = cj + dj
            if (nj <= ni || nj >= n) continue
            const other = start[ni] + nj
            if (labels[other] !== 0 || !kept(other)) continue
            labels[other] = label
            stack.push(ni, nj)
          }
        }
      }
      found.push(cells)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// One sequence
// ---------------------------------------------------------------------------

/** The windows `BlockBuster.callSubBlockbuster` slides along a sequence of `bins` bins. */
export function arrowheadWindows(
  bins: number,
  matrixSize: number,
): Array<{ limStart: number; limEnd: number; n: number }> {
  const increment = Math.trunc(matrixSize / 2)
  const out: Array<{ limStart: number; limEnd: number; n: number }> = []
  if (increment <= 0) return out
  for (let limStart = 0; limStart < bins; limStart += increment) {
    let adjusted = limStart
    const limEnd = Math.min(limStart + matrixSize, bins)
    if (limEnd === bins && bins > increment) adjusted = limEnd - matrixSize
    out.push({ limStart, limEnd, n: limEnd - adjusted + 1 })
  }
  return out
}

/** The sign thresholds of the lenient pass, in the order and to the bits Java steps through them. */
export function lowSignThresholds(settings: ArrowheadSettings): number[] {
  const out: number[] = []
  for (
    let t = settings.maxLowSignThreshold;
    t >= settings.minLowSignThreshold;
    t -= settings.decrementLowSignThreshold
  ) {
    out.push(t)
    // A non-positive step never reaches the floor; Juicer would loop for ever.
    if (!(settings.decrementLowSignThreshold > 0)) break
  }
  return out
}

/**
 * A window's square, as Juicer reads it: `n` rows and columns from `limStart`,
 * the cells past the end of the sequence zero.
 */
export type WindowReader = (from: number, to: number) => Promise<ArrayLike<number>>

/**
 * One sequence's domains: `BlockBuster.run`.
 *
 * `read(from, to)` returns the dense square over the sequence's bins
 * `[from, to)`, row-major, with a dropped cell as `NaN` or `0`. The result is in
 * base pairs, sorted as Juicer writes it — by summed variance, highest first.
 */
export async function callDomains(
  bins: number,
  resolution: number,
  read: WindowReader,
  settings: ArrowheadSettings = ARROWHEAD_DEFAULTS,
  onWindow?: (done: number, total: number) => Promise<void> | void,
): Promise<HighScore[]> {
  const lows = lowSignThresholds(settings)
  const thresholds = [
    ...lows.map((signThreshold) => ({ varThreshold: Number.NaN, signThreshold })),
    { varThreshold: settings.varThreshold, signThreshold: settings.highSignThreshold },
  ]
  const windows = arrowheadWindows(bins, settings.matrixSize)
  // Per threshold, every window's corners in window order: `CumulativeBlockResults`.
  const cumulative: HighScore[][] = thresholds.map(() => [])
  for (let w = 0; w < windows.length; w++) {
    await onWindow?.(w, windows.length)
    const { limStart, n } = windows[w]
    const to = Math.min(limStart + n, bins)
    const held = await read(limStart, to)
    const width = to - limStart
    const square = new Float32Array(n * n)
    for (let r = 0; r < width; r++) {
      for (let c = 0; c < width; c++) {
        const v = held[r * width + c]
        square[r * n + c] = Number.isNaN(v) ? 0 : v
      }
    }
    const perThreshold = windowCorners(square, n, thresholds)
    for (let t = 0; t < thresholds.length; t++) {
      // offsetResultsIndex(limStart) — limStart, not the adjusted start.
      for (const corner of perThreshold[t]) {
        cumulative[t].push({ ...corner, i: corner.i + limStart, j: corner.j + limStart })
      }
    }
  }
  await onWindow?.(windows.length, windows.length)

  // The lenient pass: the first threshold, from the highest, with any block.
  let low: HighScore[] = []
  for (let t = 0; t < lows.length; t++) {
    low = cumulative[t]
    if (low.length > 0) break
  }
  const high = [...cumulative[thresholds.length - 1]]

  const unique = orderedSetDifference(low, high)
  const filtered = unique.filter((score) => Math.abs(score.j - score.i) > settings.minBlockSize)
  appendNonConflictingBlocks(high, filtered)

  const scaled = high.map((score) => ({ ...score, i: score.i * resolution, j: score.j * resolution }))
  if (scaled.length === 0) return []
  let binned = binScoresByDistance(scaled, 5 * resolution)
  binned = binScoresByDistance(binned, 10 * resolution)
  // Collections.reverseOrder(): highest uVarScore + lVarScore first, stably.
  binned.sort((a, b) => javaDoubleCompare(b.uVarScore + b.lVarScore, a.uVarScore + a.lVarScore))
  return binned
}

/** `BlockBuster.orderedSetDifference`: `listA` less `listB`, in `HashSet` order. */
function orderedSetDifference(listA: readonly HighScore[], listB: readonly HighScore[]): HighScore[] {
  const inB = new Set(listB.map(scoreKey))
  return javaHashSetOrder(listA, highScoreHash, scoreKey).filter((score) => !inB.has(scoreKey(score)))
}

/** `BlockBuster.appendNonConflictingBlocks`, which appends to `mainList` in place. */
function appendNonConflictingBlocks(mainList: HighScore[], possibleAdditions: readonly HighScore[]): void {
  const edges = new Set<number>()
  for (const score of mainList) {
    edges.add(score.i)
    edges.add(score.j)
  }
  for (const score of possibleAdditions) {
    let conflicts = false
    for (let k = score.i; k <= score.j; k++) {
      if (edges.has(k)) {
        conflicts = true
        break
      }
    }
    if (conflicts) continue
    mainList.push(score)
    edges.add(score.i)
    edges.add(score.j)
  }
}

/** `BinnedScore`: corners gathered greedily, reported at their furthest corner with their means. */
class BinnedScore {
  private minX: number
  private maxX: number
  private minY: number
  private maxY: number
  private readonly scores: HighScore[] = []

  constructor(score: HighScore) {
    this.minX = score.i
    this.maxX = score.i
    this.minY = score.j
    this.maxY = score.j
    this.scores.push(score)
  }

  isNear(score: HighScore, distance: number): boolean {
    return (
      (Math.abs(this.minX - score.i) < distance || Math.abs(this.maxX - score.i) < distance) &&
      (Math.abs(this.minY - score.j) < distance || Math.abs(this.maxY - score.j) < distance)
    )
  }

  add(score: HighScore): void {
    if (score.i < this.minX) this.minX = score.i
    else if (score.i > this.maxX) this.maxX = score.i
    if (score.j < this.minY) this.minY = score.j
    else if (score.j > this.maxY) this.maxY = score.j
    this.scores.push(score)
  }

  toHighScore(): HighScore {
    const mean = (key: 'score' | 'uVarScore' | 'lVarScore' | 'upSign' | 'loSign'): number => {
      let sum = 0
      for (const score of this.scores) sum += score[key]
      return sum / this.scores.length
    }
    return {
      i: this.maxX,
      j: this.maxY,
      score: mean('score'),
      uVarScore: mean('uVarScore'),
      lVarScore: mean('lVarScore'),
      upSign: mean('upSign'),
      loSign: mean('loSign'),
    }
  }
}

/** `BlockBuster.binScoresByDistance`. */
function binScoresByDistance(scores: readonly HighScore[], distance: number): HighScore[] {
  const bins: BinnedScore[] = []
  for (const score of scores) {
    const near = bins.find((bin) => bin.isNear(score, distance))
    if (near === undefined) bins.push(new BinnedScore(score))
    else near.add(score)
  }
  return bins.map((bin) => bin.toHighScore())
}

// ---------------------------------------------------------------------------
// Java's arithmetic, where the result depends on it
// ---------------------------------------------------------------------------

const scratch = new DataView(new ArrayBuffer(8))

/** `Double.hashCode`: the two words of `doubleToLongBits` XOR-ed, NaN canonical. */
export function javaDoubleHash(value: number): number {
  scratch.setFloat64(0, Number.isNaN(value) ? Number.NaN : value)
  if (Number.isNaN(value)) return 0x7ff80000 | 0
  return (scratch.getInt32(0) ^ scratch.getInt32(4)) | 0
}

/** `Double.compare`: numeric, then by the signed bits — so `-0 < 0`, and NaN is largest. */
export function javaDoubleCompare(a: number, b: number): number {
  if (a < b) return -1
  if (a > b) return 1
  const bits = (x: number): bigint => {
    if (Number.isNaN(x)) return 0x7ff8000000000000n
    scratch.setFloat64(0, x)
    return scratch.getBigInt64(0)
  }
  const x = bits(a)
  const y = bits(b)
  return x === y ? 0 : x < y ? -1 : 1
}

/** `Objects.hash(i, j, score, uVarScore, lVarScore, upSign, loSign)`: `HighScore.hashCode`. */
export function highScoreHash(score: HighScore): number {
  let h = 1
  for (const part of [
    score.i | 0,
    score.j | 0,
    javaDoubleHash(score.score),
    javaDoubleHash(score.uVarScore),
    javaDoubleHash(score.lVarScore),
    javaDoubleHash(score.upSign),
    javaDoubleHash(score.loSign),
  ]) {
    h = (Math.imul(31, h) + part) | 0
  }
  return h
}

let unequal = 0

/**
 * `HighScore.equals` as a `HashMap` asks it, as a key: the same hash, then every
 * field by `==`. Under the same hash a `0` and a `-0` cannot both occur but by
 * coincidence, so the fields are keyed by their exact value; a `NaN` is equal
 * to nothing, not even another `NaN`.
 */
function scoreKey(score: HighScore): string {
  const part = (x: number): string =>
    Number.isNaN(x) ? `NaN#${++unequal}` : Object.is(x, -0) ? '-0' : String(x)
  return [
    highScoreHash(score),
    score.i,
    score.j,
    score.score,
    score.uVarScore,
    score.lVarScore,
    score.upSign,
    score.loSign,
  ]
    .map(part)
    .join(',')
}

/**
 * The iteration order of `new HashSet<>(items)` on a current JDK.
 *
 * Since JDK 19 the copy constructor sizes its map with
 * `HashMap.newHashMap(Math.max(size, 12))` — a table of the power of two at or
 * above `⌈max(size, 12) / 0.75⌉`, never resized while the items go in — and a
 * `HashMap` iterates its buckets in index order, each bucket in the order its
 * entries arrived. A bucket's index is the hash spread by `h ^ (h >>> 16)` and
 * masked by the table. Equal items after the first are not added.
 *
 * Earlier JDKs sized the table from `size / .75f + 1` with a floor of 16, which
 * can be a table twice the size and is a different order: the reference this
 * port is held to is run on a current one. A bucket of eight entries or more is
 * turned into a tree, whose order is not the arrival order; at a load of three
 * quarters that is a chance of about one in ten million a bucket, and is not
 * modelled.
 */
export function javaHashSetOrder<T>(
  items: readonly T[],
  hash: (item: T) => number,
  key: (item: T) => string,
): T[] {
  const capacity = tableSizeFor(Math.ceil(Math.max(items.length, 12) / 0.75))
  const seen = new Set<string>()
  const entries: Array<{ item: T; bucket: number; order: number }> = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    const h = hash(item)
    const spread = (h ^ (h >>> 16)) | 0
    entries.push({ item, bucket: spread & (capacity - 1), order: entries.length })
  }
  entries.sort((a, b) => a.bucket - b.bucket || a.order - b.order)
  return entries.map((entry) => entry.item)
}

/** `HashMap.tableSizeFor`: the power of two at or above `c`, at least 1. */
function tableSizeFor(c: number): number {
  let size = 1
  while (size < c) size *= 2
  return Math.min(size, 2 ** 30)
}

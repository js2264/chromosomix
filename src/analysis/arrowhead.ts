/**
 * Arrowhead — Juicer's contact-domain caller, ported.
 *
 * Rao et al. 2014's *Arrowhead*, as `juicer_tools arrowhead` computes it: the
 * transform that turns a domain into an arrowhead pointing at the diagonal, the
 * corner score read off two triangles of it, and the two passes — a strict one
 * whose blocks are kept, and a lenient one whose blocks are added where they do
 * not collide with them. The source is `juicebox.tools.utils.juicer.arrowhead`
 * in the Juicebox repository, as `juicer_tools_1.22.01.jar` was built from it —
 * where today's source differs from the jar, the jar's bytecode is what is
 * followed ({@link highScoreHash}) — and every function below names the Java
 * it is.
 *
 * **The port does not get to improve on it** (§18.9), and three places where a
 * first reading takes the Java for an oversight are kept as they are:
 *
 * - the last window of a sequence is *sized* from `limEnd − matrixWidth` and
 *   *read* from `limStart`, so it holds the sequence's tail and then zeros, and
 *   its calls are placed from `limStart` (`BlockBuster.callSubBlockbuster`);
 * - the lenient pass's blocks are taken out of a `HashSet` before the greedy
 *   step that adds those that do not collide, so the order they are tried in is
 *   that set's iteration order — reproduced here from the jar's own
 *   `HighScore.hashCode` and `HashMap`'s buckets, the ones crowded enough to
 *   have become red-black trees included ({@link javaHashSetOrder});
 * - a contact in a bin the balancer dropped is `NaN` in Juicer's window, where
 *   an empty cell is 0, and the two give different transforms (see
 *   {@link callDomains});
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
        // getHighestScoringPoint: the component's highest score, and of equal
        // highs the first its `HashSet<Point>` gives — which is no rarity
        // where a balancer dropped bins, since a run of them makes whole
        // stretches of exactly equal scores.
        let bestScore = Number.NEGATIVE_INFINITY
        for (let c = 0; c < cells.length; c += 2) {
          const value = score[at(cells[c], cells[c + 1])]
          if (value > bestScore) bestScore = value
        }
        const tied: Array<[number, number]> = []
        for (let c = 0; c < cells.length; c += 2) {
          if (score[at(cells[c], cells[c + 1])] === bestScore) tied.push([cells[c], cells[c + 1]])
        }
        const [bestI, bestJ] = tied.length === 1 ? tied[0] : firstInPointSet(tied, cells.length / 2)
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
export type WindowReader = (from: number, to: number) => Promise<Float32Array>

/**
 * One sequence's domains: `BlockBuster.run`.
 *
 * `read(from, to)` returns the dense square over the sequence's bins
 * `[from, to)`, row-major, as Juicer reads it: a cell with no contact `0`, and
 * a contact whose normalisation is undefined `NaN` — which Juicer Tools 1.22.01
 * keeps rather than drops (`DatasetReaderV2.readNormalizedBlock` divides and
 * adds the record whatever it came to). The result is in base pairs, sorted as
 * Juicer writes it — by summed variance, highest first.
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
    // Copied as it came, `NaN` included: a contact in a bin the balancer
    // dropped is `NaN` in Juicer's window and its transform is 0, where a cell
    // with no contact is 0 and its transform is −1 beside one that has one.
    const square = new Float32Array(n * n)
    for (let r = 0; r < width; r++) square.set(held.subarray(r * width, (r + 1) * width), r * n)
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
  return javaHashSetOrder(listA, highScoreHash, scoreKey, compareHighScores).filter((score) => !inB.has(scoreKey(score)))
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

/**
 * `HighScore.hashCode` as `juicer_tools_1.22.01.jar` has it — read off its
 * bytecode, since the source in the Juicebox repository has since become an
 * `Objects.hash` of the seven fields: `7 · (i + j) · (int) ⌊score + uVarScore +
 * lVarScore + upSign + loSign⌋`, in int arithmetic. It takes few values, so
 * a `HashSet` of these collides often and its buckets become trees, which is
 * why {@link javaHashSetOrder} models those too.
 */
export function highScoreHash(score: HighScore): number {
  const sum = score.score + score.uVarScore + score.lVarScore + score.upSign + score.loSign
  return Math.imul(Math.imul(7, (score.i + score.j) | 0), javaD2I(Math.floor(sum)))
}

/** Java's `d2i`: truncation, saturating at the int range, and `NaN` as 0. */
function javaD2I(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value >= 2147483647) return 2147483647
  if (value <= -2147483648) return -2147483648
  return Math.trunc(value) | 0
}

/** `HighScore.compareTo`: by the two variances summed, as `Double.compare` orders them. */
export function compareHighScores(a: HighScore, b: HighScore): number {
  return javaDoubleCompare(a.uVarScore + a.lVarScore, b.uVarScore + b.lVarScore)
}

let unequal = 0

/**
 * `HighScore.equals` as a `HashMap` asks it, as a key: every field by `==`. A
 * `0` and a `-0` are one value; a `NaN` is equal to nothing, not even another.
 */
function scoreKey(score: HighScore): string {
  const part = (x: number): string => (Number.isNaN(x) ? `NaN#${++unequal}` : String(x === 0 ? 0 : x))
  return [score.i, score.j, score.score, score.uVarScore, score.lVarScore, score.upSign, score.loSign]
    .map(part)
    .join(',')
}

// ---------------------------------------------------------------------------
// java.util.HashMap, as far as its iteration order goes
// ---------------------------------------------------------------------------

/** A node of a bucket: a link of its list and, once the bucket is a tree, a node of that tree. */
interface Bin<T> {
  hash: number
  key: string
  item: T
  next: Bin<T> | null
  prev: Bin<T> | null
  parent: Bin<T> | null
  left: Bin<T> | null
  right: Bin<T> | null
  red: boolean
  tree: boolean
}

const TREEIFY_THRESHOLD = 8
const UNTREEIFY_THRESHOLD = 6
const MIN_TREEIFY_CAPACITY = 64

/**
 * The parts of `java.util.HashMap` (OpenJDK 21) that decide in which order a
 * `HashSet` gives its elements back: the spread hash and its buckets, the
 * table's growth and the split of each bucket when it doubles, and a bucket of
 * more than eight entries turned into a red-black tree ordered by hash and then
 * by `compareTo` — whose iteration order is its root first and then each entry
 * placed after the node it was hung under, not the order they arrived in.
 *
 * One thing is not modelled, because it cannot be: two entries of one bucket
 * with the same hash and comparing equal are ordered by
 * `System.identityHashCode`, which differs from one run of the JVM to the next.
 * Here the newcomer goes left of the one it ties with.
 */
class JavaHashMap<T> {
  private table: Array<Bin<T> | null> = []
  private size = 0
  private threshold: number

  constructor(
    initialCapacity: number,
    private readonly compare: ((a: T, b: T) => number) | null,
  ) {
    this.threshold = tableSizeFor(initialCapacity)
  }

  put(hash: number, key: string, item: T): void {
    if (this.table.length === 0) this.resize()
    const tab = this.table
    const n = tab.length
    const index = (n - 1) & hash
    const p = tab[index]
    if (p === null) {
      tab[index] = this.node(hash, key, item, null)
    } else if (p.hash === hash && p.key === key) {
      return
    } else if (p.tree) {
      if (!this.putTreeVal(p, hash, key, item)) return
    } else {
      let q = p
      for (let binCount = 0; ; binCount++) {
        if (q.next === null) {
          q.next = this.node(hash, key, item, null)
          if (binCount >= TREEIFY_THRESHOLD - 1) this.treeifyBin(hash)
          break
        }
        const e = q.next
        if (e.hash === hash && e.key === key) return
        q = e
      }
    }
    if (++this.size > this.threshold) this.resize()
  }

  /** Every item, as an iterator over the table gives them. */
  items(): T[] {
    const out: T[] = []
    for (const head of this.table) for (let e = head; e !== null; e = e.next) out.push(e.item)
    return out
  }

  private node(hash: number, key: string, item: T, next: Bin<T> | null): Bin<T> {
    return { hash, key, item, next, prev: null, parent: null, left: null, right: null, red: false, tree: false }
  }

  private resize(): void {
    const old = this.table
    const oldCap = old.length
    let newCap: number
    if (oldCap > 0) {
      newCap = oldCap * 2
      this.threshold = oldCap >= 16 ? this.threshold * 2 : Math.trunc(newCap * 0.75)
    } else if (this.threshold > 0) {
      newCap = this.threshold
      this.threshold = Math.trunc(Math.fround(newCap * Math.fround(0.75)))
    } else {
      newCap = 16
      this.threshold = 12
    }
    const tab: Array<Bin<T> | null> = new Array(newCap).fill(null)
    this.table = tab
    for (let j = 0; j < oldCap; j++) {
      const e = old[j]
      if (e === null) continue
      if (e.next === null) tab[e.hash & (newCap - 1)] = e
      else if (e.tree) this.split(e, j, oldCap)
      else {
        let loHead: Bin<T> | null = null
        let loTail: Bin<T> | null = null
        let hiHead: Bin<T> | null = null
        let hiTail: Bin<T> | null = null
        for (let x: Bin<T> | null = e; x !== null; ) {
          const next: Bin<T> | null = x.next
          if ((x.hash & oldCap) === 0) {
            if (loTail === null) loHead = x
            else loTail.next = x
            loTail = x
          } else {
            if (hiTail === null) hiHead = x
            else hiTail.next = x
            hiTail = x
          }
          x = next
        }
        if (loTail !== null) loTail.next = null
        if (hiTail !== null) hiTail.next = null
        tab[j] = loHead
        tab[j + oldCap] = hiHead
      }
    }
  }

  private treeifyBin(hash: number): void {
    const tab = this.table
    if (tab.length < MIN_TREEIFY_CAPACITY) {
      this.resize()
      return
    }
    const index = (tab.length - 1) & hash
    let prev: Bin<T> | null = null
    for (let e = tab[index]; e !== null; e = e.next) {
      e.tree = true
      e.prev = prev
      prev = e
    }
    const head = tab[index]
    if (head !== null) this.treeify(head)
  }

  /** `TreeNode.treeify`: the bucket's list hung into a tree in list order, the root moved to the front. */
  private treeify(head: Bin<T>): void {
    let root: Bin<T> | null = null
    for (let x: Bin<T> | null = head; x !== null; x = x.next) {
      x.left = null
      x.right = null
      if (root === null) {
        x.parent = null
        x.red = false
        root = x
        continue
      }
      for (let p: Bin<T> = root; ; ) {
        const dir = this.direction(x.hash, x.item, p)
        const xp: Bin<T> = p
        const child: Bin<T> | null = dir <= 0 ? p.left : p.right
        if (child === null) {
          x.parent = xp
          if (dir <= 0) xp.left = x
          else xp.right = x
          root = balanceInsertion(root, x)
          break
        }
        p = child
      }
    }
    if (root !== null) this.moveRootToFront(root)
  }

  /** Left (≤ 0) or right of `p`: by hash, then by `compareTo`, then — unknowably — left. */
  private direction(hash: number, item: T, p: Bin<T>): number {
    if (p.hash > hash) return -1
    if (p.hash < hash) return 1
    const dir = this.compare === null ? 0 : this.compare(item, p.item)
    return dir === 0 ? -1 : dir
  }

  /** `TreeNode.putTreeVal`; `false` where an equal key was already there. */
  private putTreeVal(first: Bin<T>, hash: number, key: string, item: T): boolean {
    let root = first
    while (root.parent !== null) root = root.parent
    let searched = false
    for (let p: Bin<T> = root; ; ) {
      let dir: number
      if (p.hash > hash) dir = -1
      else if (p.hash < hash) dir = 1
      else if (p.key === key) return false
      else {
        dir = this.compare === null ? 0 : this.compare(item, p.item)
        if (dir === 0) {
          if (!searched) {
            searched = true
            if ((p.left !== null && this.find(p.left, hash, key, item) !== null) ||
                (p.right !== null && this.find(p.right, hash, key, item) !== null)) return false
          }
          dir = -1
        }
      }
      const xp: Bin<T> = p
      const child: Bin<T> | null = dir <= 0 ? p.left : p.right
      if (child === null) {
        const xpn = xp.next
        const x = this.node(hash, key, item, xpn)
        x.tree = true
        if (dir <= 0) xp.left = x
        else xp.right = x
        xp.next = x
        x.parent = xp
        x.prev = xp
        if (xpn !== null) xpn.prev = x
        this.moveRootToFront(balanceInsertion(root, x))
        return true
      }
      p = child
    }
  }

  /** `TreeNode.find`. */
  private find(start: Bin<T>, hash: number, key: string, item: T): Bin<T> | null {
    for (let p: Bin<T> | null = start; p !== null; ) {
      const pl: Bin<T> | null = p.left
      const pr: Bin<T> | null = p.right
      if (p.hash > hash) p = pl
      else if (p.hash < hash) p = pr
      else if (p.key === key) return p
      else if (pl === null) p = pr
      else if (pr === null) p = pl
      else {
        const dir: number = this.compare === null ? 0 : this.compare(item, p.item)
        if (dir !== 0) p = dir < 0 ? pl : pr
        else {
          const q = this.find(pr, hash, key, item)
          if (q !== null) return q
          p = pl
        }
      }
    }
    return null
  }

  /** `TreeNode.moveRootToFront`: the root, out of its place in the list, made the bucket's first. */
  private moveRootToFront(root: Bin<T>): void {
    const tab = this.table
    const index = (tab.length - 1) & root.hash
    const first = tab[index]
    if (root === first) return
    tab[index] = root
    const rp = root.prev
    const rn = root.next
    if (rn !== null) rn.prev = rp
    if (rp !== null) rp.next = rn
    if (first !== null) first.prev = root
    root.next = first
    root.prev = null
  }

  /** `TreeNode.split`: a tree bucket's two halves on a doubled table, each a list again if small. */
  private split(head: Bin<T>, index: number, bit: number): void {
    const tab = this.table
    let loHead: Bin<T> | null = null
    let loTail: Bin<T> | null = null
    let hiHead: Bin<T> | null = null
    let hiTail: Bin<T> | null = null
    let lc = 0
    let hc = 0
    for (let e: Bin<T> | null = head; e !== null; ) {
      const next: Bin<T> | null = e.next
      e.next = null
      if ((e.hash & bit) === 0) {
        e.prev = loTail
        if (loTail === null) loHead = e
        else loTail.next = e
        loTail = e
        lc++
      } else {
        e.prev = hiTail
        if (hiTail === null) hiHead = e
        else hiTail.next = e
        hiTail = e
        hc++
      }
      e = next
    }
    const untreeify = (h: Bin<T>): Bin<T> => {
      for (let e: Bin<T> | null = h; e !== null; e = e.next) {
        e.tree = false
        e.parent = e.left = e.right = e.prev = null
      }
      return h
    }
    if (loHead !== null) {
      if (lc <= UNTREEIFY_THRESHOLD) tab[index] = untreeify(loHead)
      else {
        tab[index] = loHead
        if (hiHead !== null) this.treeify(loHead)
      }
    }
    if (hiHead !== null) {
      if (hc <= UNTREEIFY_THRESHOLD) tab[index + bit] = untreeify(hiHead)
      else {
        tab[index + bit] = hiHead
        if (loHead !== null) this.treeify(hiHead)
      }
    }
  }
}

function rotateLeft<T>(root: Bin<T>, p: Bin<T>): Bin<T> {
  const r = p.right
  if (r === null) return root
  const rl = (p.right = r.left)
  if (rl !== null) rl.parent = p
  const pp = (r.parent = p.parent)
  if (pp === null) {
    root = r
    r.red = false
  } else if (pp.left === p) pp.left = r
  else pp.right = r
  r.left = p
  p.parent = r
  return root
}

function rotateRight<T>(root: Bin<T>, p: Bin<T>): Bin<T> {
  const l = p.left
  if (l === null) return root
  const lr = (p.left = l.right)
  if (lr !== null) lr.parent = p
  const pp = (l.parent = p.parent)
  if (pp === null) {
    root = l
    l.red = false
  } else if (pp.right === p) pp.right = l
  else pp.left = l
  l.right = p
  p.parent = l
  return root
}

/** `TreeNode.balanceInsertion`: the red-black repair after `x` is hung in. */
function balanceInsertion<T>(root: Bin<T>, x: Bin<T>): Bin<T> {
  x.red = true
  for (;;) {
    let xp = x.parent
    if (xp === null) {
      x.red = false
      return x
    }
    let xpp = xp.parent
    if (!xp.red || xpp === null) return root
    const xppl = xpp.left
    if (xp === xppl) {
      const xppr = xpp.right
      if (xppr !== null && xppr.red) {
        xppr.red = false
        xp.red = false
        xpp.red = true
        x = xpp
      } else {
        if (x === xp.right) {
          x = xp
          root = rotateLeft(root, x)
          xp = x.parent
          xpp = xp === null ? null : xp.parent
        }
        if (xp !== null) {
          xp.red = false
          if (xpp !== null) {
            xpp.red = true
            root = rotateRight(root, xpp)
          }
        }
      }
    } else {
      if (xppl !== null && xppl.red) {
        xppl.red = false
        xp.red = false
        xpp.red = true
        x = xpp
      } else {
        if (x === xp.left) {
          x = xp
          root = rotateRight(root, x)
          xp = x.parent
          xpp = xp === null ? null : xp.parent
        }
        if (xp !== null) {
          xp.red = false
          if (xpp !== null) {
            xpp.red = true
            root = rotateLeft(root, xpp)
          }
        }
      }
    }
  }
}

/**
 * The iteration order of `new HashSet<>(items)` on a current JDK.
 *
 * Since JDK 19 the copy constructor sizes its map with
 * `HashMap.newHashMap(Math.max(size, 12))` — a table of the power of two at or
 * above `⌈max(size, 12) / 0.75⌉` — and adds the items in order; the rest is
 * {@link JavaHashMap}. Earlier JDKs sized the table from `size / .75f + 1` with
 * a floor of 16, which can be a table twice the size and is a different order:
 * the reference this port is held to is run on a current one.
 */
export function javaHashSetOrder<T>(
  items: readonly T[],
  hash: (item: T) => number,
  key: (item: T) => string,
  compare: ((a: T, b: T) => number) | null = null,
): T[] {
  const map = new JavaHashMap<T>(Math.ceil(Math.max(items.length, 12) / 0.75), compare)
  for (const item of items) {
    const h = hash(item)
    map.put((h ^ (h >>> 16)) | 0, key(item), item)
  }
  return map.items()
}

/**
 * `java.awt.Point.hashCode`, which is `Point2D`'s: the bits of `x` XOR-ed with
 * 31 times the bits of `y`, folded to an int.
 */
export function javaPointHash(x: number, y: number): number {
  const bitsOf = (v: number): bigint => {
    scratch.setFloat64(0, v)
    return scratch.getBigUint64(0)
  }
  const bits = BigInt.asUintN(64, bitsOf(x) ^ BigInt.asUintN(64, bitsOf(y) * 31n))
  const low = Number(BigInt.asIntN(32, bits))
  const high = Number(BigInt.asIntN(32, bits >> 32n))
  return (low ^ high) | 0
}

/**
 * Of a component's cells tied for its highest score, the one Juicer keeps: the
 * first a `HashSet<Point>` of the component's `size` cells iterates.
 *
 * The set is a copy of the first label's cells grown by the others', so it ends
 * at the table a set of `size` sized from a list has — the power of two at or
 * above `⌈max(size, 12) / 0.75⌉` — and iterates bucket by bucket. Within one
 * bucket the order is the order the cells were added, which is the order the
 * labels were met in raster order; two tied cells in one bucket are left in
 * raster order, which is that order but for labels joined late.
 */
function firstInPointSet(tied: ReadonlyArray<[number, number]>, size: number): [number, number] {
  const capacity = tableSizeFor(Math.ceil(Math.max(size, 12) / 0.75))
  let best = tied[0]
  let bestKey = Number.POSITIVE_INFINITY
  for (const cell of tied) {
    const h = javaPointHash(cell[0], cell[1])
    const bucket = (h ^ (h >>> 16)) & (capacity - 1)
    if (bucket < bestKey || (bucket === bestKey && (cell[0] < best[0] || (cell[0] === best[0] && cell[1] < best[1])))) {
      best = cell
      bestKey = bucket
    }
  }
  return best
}

/** `HashMap.tableSizeFor`: the power of two at or above `c`, at least 1. */
function tableSizeFor(c: number): number {
  let size = 1
  while (size < c) size *= 2
  return Math.min(size, 2 ** 30)
}

/**
 * The method that proposes edits (SPECS §27.5): ends, and the one score that
 * decides whether two of them belong together.
 *
 * A reference is a list of adjacencies — every base is next to the one after
 * it — and a contact map tests every one of them, because contacts fall off
 * with distance along the molecule: two stretches that truly meet share the
 * densest contacts there are, two that do not share the background. So every
 * place the reference could be wrong is a pair of **ends** — the sequence just
 * left of a point, read leftwards, or just right of one, read rightwards — and
 * the **junction score** says whether they meet: the evidence, over the window
 * of their first cells, that the contacts there are an adjacency's rather than
 * two strangers'. A junction the reference makes and the map refuses is a
 * **breakpoint**; two ends it does not join and the map would is a **corner**.
 * An edit trades junctions, and `suggest.ts` weighs the trades.
 *
 * Everything here reads the map **through the edit as it stands** — the cells
 * of the picture each cell of the edited axis shows (`grid.ts`) — so the method
 * always speaks of the reference as the reader has made it: a stretch already
 * turned back is no longer a bow-tie, and the junctions a careless move made are
 * refused like any other.
 *
 * Three kinds of number, each where it is needed: the cells nearest the
 * diagonal as they are, where a junction's evidence is; the whole map on a
 * coarse grid, where two far ends meet; and, measured from both once per file,
 * what the map is expected to hold ({@link expectedOf}). Every one of them came
 * from the file (`metacooler/picture.ts`'s gathering), never from the picture's
 * bytes.
 */

import { triangleIndex, type PictureContacts } from '../metacooler/picture'

/**
 * The most cells each end of a junction is read into (§27.5's `W`). A file's
 * own window is set by its contact law ({@link Expected.window}): as far as
 * contacts along the molecule stand well above the background, and no further,
 * since past that a window weighs clustering — telomeres, centromeres — as if it
 * were adjacency.
 */
export const WINDOW = 16

/** The fewest cells a window is read into. */
const LEAST_WINDOW = 4

/** Cells past the diagonal the pass keeps as they are: two windows, and room. */
export const BAND_WIDTH = 64

/** The most coarse cells a side the pass keeps of the whole map. */
export const COARSE_CELLS = 2048

/** The share of each distance's highest values left out of its mean, so what is looked for does not lift what it is judged against. */
const TRIM = 0.01

/** What the map is expected to hold, measured from the map itself (§27.5). */
export interface Expected {
  /**
   * The contact law `P(d)`, `d` in cells from `0` (a cell with itself) to the
   * grid's side: a trimmed mean per distance along every sequence, made
   * non-increasing, and past the longest measured distance the power law of
   * its last decade.
   */
  law: Float64Array
  /** The trans level: what two stretches of different molecules share, trimmed the same way. */
  trans: number
  /** Variance over mean near the diagonal: what one unit of the values is worth as evidence. */
  dispersion: number
  /**
   * Each cell's coverage, as a factor its values are divided by: `1` on a
   * balanced map, which is flat by construction; the marginal over its median
   * on a raw one; `NaN` for a cell with nothing the balancer kept.
   */
  bias: Float64Array
  /**
   * Cells each end of a junction is read into: half the distance at which the
   * law falls to eight times the trans level, between four and {@link WINDOW} —
   * so every cell of a window is one where an adjacency stands well out of the
   * background.
   */
  window: number
  /**
   * The score of two ends that truly meet — a window holding exactly the
   * contact law, against its own level: the unit every gain is counted in, so
   * one adjacency made is worth about one in any file, at any depth, and a clean
   * misjoin taken away about two thirds of one.
   */
  unit: number
}

/** The mean of the lowest `1 − TRIM` of some values, which it sorts. */
function trimmedMean(values: Float64Array): number {
  if (values.length === 0) return Number.NaN
  values.sort()
  const keep = Math.max(1, Math.floor(values.length * (1 - TRIM)))
  let sum = 0
  for (let i = 0; i < keep; i++) sum += values[i]
  return sum / keep
}

/** The median of some values, which it sorts; `NaN` for none. */
function median(values: Float64Array): number {
  if (values.length === 0) return Number.NaN
  values.sort()
  const mid = values.length >> 1
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2
}

/** A growable list of doubles, for the values of one distance. */
class Values {
  private data = new Float64Array(64)
  length = 0
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
  view(): Float64Array {
    return this.data.subarray(0, this.length)
  }
}

/**
 * The expected map of a file (§27.5): its contact law, its trans level, how
 * noisy a value is, and each cell's coverage — once per file, from the contacts
 * the picture's pass kept.
 *
 * @param balanced Whether the values are balanced; a raw map is flattened by
 *   its marginals, the one-step version of what balancing does.
 */
export function expectedOf(contacts: PictureContacts, balanced: boolean): Expected {
  const { n, width, band, coarse, marginal, kept, sequenceOf } = contacts

  // Coverage.
  const bias = new Float64Array(n).fill(1)
  if (!balanced) {
    const positive = new Values()
    for (let a = 0; a < n; a++) if (marginal[a] > 0) positive.push(marginal[a])
    const middle = median(positive.view())
    for (let a = 0; a < n; a++) bias[a] = marginal[a] > 0 && middle > 0 ? marginal[a] / middle : Number.NaN
  }
  for (let a = 0; a < n; a++) if (kept[a] === 0) bias[a] = Number.NaN

  // The law near the diagonal, cell by cell, and how noisy it is.
  const near = new Float64Array(width).fill(Number.NaN)
  const ratios = new Values()
  for (let d = 0; d < width; d++) {
    const values = new Values()
    for (let a = 0; a + d < n; a++) {
      const v = band[a * width + d] / (bias[a] * bias[a + d])
      if (v >= 0) values.push(v)
    }
    if (values.length < 8) continue
    const view = values.view()
    near[d] = trimmedMean(view)
    if (d === 0) continue
    // The same values the mean kept, for their spread: sorted by the mean.
    const keep = Math.max(1, Math.floor(view.length * (1 - TRIM)))
    let sum = 0
    let squares = 0
    for (let i = 0; i < keep; i++) {
      sum += view[i]
      squares += view[i] * view[i]
    }
    const mean = sum / keep
    const variance = Math.max(0, squares / keep - mean * mean)
    if (mean > 0) ratios.push(variance / mean)
  }

  // Far from it, from the coarse whole: a mean per coarse distance along one
  // sequence, and the mean between sequences.
  const f = coarse.factor
  const nc = coarse.n
  const coarseSequence = new Int32Array(nc).fill(-1)
  const coarseBias = new Float64Array(nc)
  const coarseCount = new Float64Array(nc)
  for (let a = 0; a < n; a++) {
    const c = coarse.of[a]
    coarseSequence[c] = sequenceOf[a]
    if (bias[a] > 0) {
      coarseBias[c] += bias[a]
      coarseCount[c]++
    }
  }
  for (let c = 0; c < nc; c++) coarseBias[c] = coarseCount[c] > 0 ? coarseBias[c] / coarseCount[c] : Number.NaN
  const byDistance: Values[] = []
  const trans = new Values()
  for (let a = 0; a < nc; a++) {
    let at = triangleIndex(a, a, nc)
    for (let b = a; b < nc; b++, at++) {
      const v = coarse.values[at] / (coarseBias[a] * coarseBias[b])
      if (!(v >= 0)) continue
      if (coarseSequence[a] === coarseSequence[b]) {
        const d = b - a
        if (d === 0) continue
        ;(byDistance[d] ??= new Values()).push(v)
      } else {
        trans.push(v)
      }
    }
  }
  const far = new Float64Array(byDistance.length).fill(Number.NaN)
  for (let d = 1; d < byDistance.length; d++) {
    const values = byDistance[d]
    if (values !== undefined && values.length >= 4) far[d] = trimmedMean(values.view())
  }

  // The law in cells: as measured near the diagonal; interpolated in log–log
  // between the coarse distances past it; non-increasing; and past the longest
  // distance measured, the power law of its last decade.
  const law = new Float64Array(n + 1).fill(Number.NaN)
  const coarseAt = (d: number): number => {
    const x = d / f
    const lo = Math.floor(x)
    const hi = lo + 1
    const a = far[lo]
    const b = far[hi]
    if (lo >= 1 && a > 0 && b > 0) return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * (x - lo))
    if (lo >= 1 && a > 0) return a
    if (b > 0 && lo < 1) return b
    return Number.NaN
  }
  let longest = 0
  for (let d = 0; d <= n; d++) {
    const v = d < width && near[d] > 0 ? near[d] : d >= 1 ? coarseAt(d) : Number.NaN
    if (v > 0) {
      law[d] = v
      longest = d
    }
  }
  // Holes (a distance nothing measured) take the value before them.
  for (let d = 1; d <= longest; d++) if (!(law[d] > 0)) law[d] = law[d - 1]
  for (let d = 1; d <= longest; d++) if (law[d] > law[d - 1]) law[d] = law[d - 1]
  const slope = tailSlope(law, longest)
  for (let d = longest + 1; d <= n; d++) law[d] = law[longest] * Math.pow(d / Math.max(1, longest), slope)
  if (!(law[0] > 0)) law[0] = law[1] > 0 ? law[1] : 1

  let transLevel = trimmedMean(trans.view())
  // A file of one molecule has no trans: two ends apart are then as far apart
  // as it has anything, half of that.
  if (!(transLevel > 0)) transLevel = 0.5 * law[Math.max(1, longest)]
  transLevel = Math.max(transLevel, law[1] * 1e-9)

  const dispersion = Math.max(median(ratios.view()) || 1, 1e-12)

  let reach = 1
  while (reach < 2 * WINDOW && reach < n && law[reach] >= 8 * transLevel) reach++
  const window = Math.max(LEAST_WINDOW, Math.min(WINDOW, Math.ceil(reach / 2)))

  let mean = 0
  for (let i = 0; i < window; i++) for (let j = 0; j < window; j++) mean += law[Math.min(n, i + j + 1)]
  mean /= window * window
  const level = Math.max(transLevel, mean)
  let unit = 0
  for (let i = 0; i < window; i++) {
    for (let j = 0; j < window; j++) {
      const p = law[Math.min(n, i + j + 1)]
      unit += p * Math.log(p / level) - (p - level)
    }
  }
  unit = Math.max(unit / dispersion, 1e-9)

  return { law, trans: transLevel, dispersion, bias, window, unit }
}

/** The slope of the law's last decade in log–log, between −3 and −0.3. */
function tailSlope(law: Float64Array, longest: number): number {
  const from = Math.max(1, Math.floor(longest / 10))
  let n = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let d = from; d <= longest; d++) {
    if (!(law[d] > 0)) continue
    const x = Math.log(d)
    const y = Math.log(law[d])
    n++
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const denominator = n * sxx - sx * sx
  const slope = n >= 2 && denominator !== 0 ? (n * sxy - sx * sy) / denominator : -1
  return Math.max(-3, Math.min(-0.3, slope))
}

// ---------------------------------------------------------------------------
// The map through the edit
// ---------------------------------------------------------------------------

/**
 * The map as the edit draws it: the value of any two cells of the edited axis,
 * read from the cells of the picture they show, divided by their coverage.
 * `NaN` where either is in a gap or holds nothing the balancer kept — which is
 * no evidence, never evidence of a break (§27.5).
 */
export class EditedMap {
  readonly law: Float64Array
  readonly trans: number
  readonly dispersion: number
  readonly window: number
  readonly unit: number
  /** The law, and its log, for the distances a window spans: `near[d]` is `P(d)`, clamped to the grid. */
  readonly near: Float64Array
  readonly logNear: Float64Array
  private readonly band: Float32Array
  private readonly width: number
  private readonly sequenceOf: Int32Array
  private readonly coarseOf: Int32Array
  private readonly coarseValues: Float32Array
  private readonly coarseN: number
  private readonly bias: Float64Array

  constructor(
    contacts: PictureContacts,
    expected: Expected,
    /** The picture's cell each edited cell shows; `-1` in a gap. */
    readonly cellMap: Int32Array,
  ) {
    this.law = expected.law
    this.trans = expected.trans
    this.dispersion = expected.dispersion
    this.window = expected.window
    this.unit = expected.unit
    this.band = contacts.band
    this.width = contacts.width
    this.sequenceOf = contacts.sequenceOf
    this.coarseOf = contacts.coarse.of
    this.coarseValues = contacts.coarse.values
    this.coarseN = contacts.coarse.n
    this.bias = expected.bias
    this.near = new Float64Array(2 * this.window + 2)
    this.logNear = new Float64Array(this.near.length)
    for (let d = 0; d < this.near.length; d++) {
      this.near[d] = this.law[Math.min(this.law.length - 1, d)]
      this.logNear[d] = Math.log(this.near[d])
    }
  }

  /** Cells on the edited axis. */
  get n(): number {
    return this.cellMap.length
  }

  /** The value at edited cells `(i, j)`. */
  value(i: number, j: number): number {
    const a = this.cellMap[i]
    const b = this.cellMap[j]
    if (a < 0 || b < 0) return Number.NaN
    return this.original(a, b)
  }

  /** The value at cells `(a, b)` of the picture, in the file's own order. */
  original(a: number, b: number): number {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const d = hi - lo
    let v: number
    if (d < this.width && this.sequenceOf[lo] === this.sequenceOf[hi]) {
      v = this.band[lo * this.width + d]
    } else {
      const x = this.coarseOf[lo]
      const y = this.coarseOf[hi]
      v = this.coarseValues[triangleIndex(x, y, this.coarseN)]
    }
    return v / (this.bias[a] * this.bias[b])
  }

  /** What a cell pair `d` cells apart along one molecule is expected to hold. */
  expectedAt(d: number): number {
    return this.law[Math.min(this.law.length - 1, Math.max(0, d))]
  }
}

// ---------------------------------------------------------------------------
// Ends and junctions
// ---------------------------------------------------------------------------

/**
 * An end (§27.5): a cell of the edited axis and the way its sequence runs away
 * from the point — `-1`, the sequence just left of it read leftwards; `+1`, just
 * right of it read rightwards — and the cells a walk from it may use, half-open,
 * which are the stretch it bounds: a walk never crosses another point the
 * method is weighing, since past it the sequence may be somewhere else.
 */
export interface End {
  cell: number
  dir: 1 | -1
  lo: number
  hi: number
}

/** A junction's score, and how much of its window held anything. */
export interface Junction {
  /**
   * The evidence that the two ends meet rather than lie apart: positive, the
   * map would rather they met; negative, it would rather they did not (§27.5).
   */
  score: number
  /** Cells of the window that held a value, of those its two walks reached. */
  seen: number
  reached: number
}

/**
 * What two ends lying apart would hold, the other side of a junction score:
 *
 * - `trans`: the trans level — the question a junction the reference makes
 *   is asked, *does the map refuse it*, and it refuses only contacts down at
 *   what two strangers share;
 * - `local`: the window's own mean, where that is above the trans level — the
 *   question two ends the reference does not join are asked, *do they meet*,
 *   and they meet only where the contacts fall away from the corner as an
 *   adjacency's do. Telomeres and centromeres clustering light a window evenly;
 *   against its own level that is no evidence of meeting at all.
 */
export type Apart = 'trans' | 'local'

/** A window's values, by row, reused from one junction to the next. */
const scratch = new Float64Array(WINDOW * WINDOW)

/**
 * The junction score of two ends (§27.5): over the window of their first
 * cells each, the log-likelihood of their meeting — each cell expected at the
 * contact law's value for the distance it would then span, `i + j + 1` cells —
 * against their lying apart ({@link Apart}), a quasi-Poisson log-likelihood
 * divided by the file's dispersion. A cell with no value is left out of both.
 */
export function junctionScore(map: EditedMap, e: End, f: End, apart: Apart = 'trans'): Junction {
  const law = map.near
  const logLaw = map.logNear
  const trans = map.trans
  const w = map.window
  let seen = 0
  let reached = 0
  let total = 0
  for (let i = 0; i < w; i++) {
    const r = e.cell + e.dir * i
    const inside = r >= e.lo && r < e.hi
    for (let j = 0; j < w; j++) {
      const c = f.cell + f.dir * j
      let v = Number.NaN
      if (inside && c >= f.lo && c < f.hi) {
        reached++
        v = map.value(r, c)
        if (v >= 0) {
          seen++
          total += v
        } else {
          v = Number.NaN
        }
      }
      scratch[i * w + j] = v
    }
  }
  const level = apart === 'local' && seen > 0 ? Math.max(trans, total / seen) : trans
  let score = 0
  const logLevel = Math.log(level)
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < w; j++) {
      const v = scratch[i * w + j]
      if (Number.isNaN(v)) continue
      const d = i + j + 1
      score += v * (logLaw[d] - logLevel) - (law[d] - level)
    }
  }
  return { score: score / map.dispersion, seen, reached }
}

/** A stretch of the edited axis, half-open: an edited sequence's cells. */
export interface AxisStretch {
  from: number
  to: number
}

/**
 * The junction score at every edge of every sequence — the reference's own
 * junctions, each weighed (§27.5's cut score is its negative). `out[x]` is the
 * edge between cells `x − 1` and `x`; `NaN` at a sequence's two ends, which join
 * nothing, and where the window held too little to say.
 */
export function junctionsAlong(map: EditedMap, sequences: readonly AxisStretch[]): { score: Float64Array; seen: Float64Array } {
  const score = new Float64Array(map.n + 1).fill(Number.NaN)
  const seen = new Float64Array(map.n + 1)
  for (const sequence of sequences) {
    for (let x = sequence.from + 1; x < sequence.to; x++) {
      const junction = junctionScore(
        map,
        { cell: x - 1, dir: -1, lo: sequence.from, hi: x },
        { cell: x, dir: 1, lo: x, hi: sequence.to },
      )
      seen[x] = junction.reached === 0 ? 0 : junction.seen / junction.reached
      if (junction.seen >= Math.max(4, junction.reached / 4)) score[x] = junction.score
    }
  }
  return { score, seen }
}

/**
 * The breakpoints along the axis (§27.5): edges where the map refuses the
 * junction the reference makes — a score under `−floor` units — and refuses it
 * more than anywhere within half a window, so a break is one point and not the
 * run of edges around it.
 */
export function breakpointsOf(
  score: Float64Array,
  sequences: readonly AxisStretch[],
  unit: number,
  window: number,
  floor = 0.2,
): number[] {
  const out: number[] = []
  const reach = Math.max(1, window >> 1)
  for (const sequence of sequences) {
    for (let x = sequence.from + 1; x < sequence.to; x++) {
      const here = score[x]
      if (!(here < -floor * unit)) continue
      let lowest = true
      for (let y = Math.max(sequence.from + 1, x - reach); y <= Math.min(sequence.to - 1, x + reach); y++) {
        const there = score[y]
        if (y !== x && there < here) {
          lowest = false
          break
        }
        // The first of a run of equals is the one.
        if (y < x && there === here) {
          lowest = false
          break
        }
      }
      if (lowest) out.push(x)
    }
  }
  return out
}

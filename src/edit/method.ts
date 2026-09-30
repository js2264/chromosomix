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

import { endValue, triangleIndex, type GatherOptions, type PictureContacts, type PictureEnds } from '../metacooler/picture'

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

/**
 * Cells from each end of a sequence whose pairs with every other end the pass
 * keeps as they are: three of the longest meeting window, since a window walks
 * past the cells the balancer emptied at an end — a subtelomere's repeats, the
 * edge of an rDNA array — to find its own.
 */
export const END_DEPTH = 160

/** What the picture's pass gathers for the method (§27.5). */
export const METHOD_GATHER: GatherOptions = { width: BAND_WIDTH, coarseCells: COARSE_CELLS, endDepth: END_DEPTH }

/** The longest window two ends' meeting is weighed over, in valid cells each. */
export const MEETING_REACH = 48

/** The fewest cells a meeting window is read into. */
const LEAST_MEETING = 8

/**
 * The gaps a meeting is tried at, in cells: the sequence an assembly never
 * closed between two ends — a repeat, an rDNA array, a stretch no read spanned —
 * which moves every cell of the window that much further apart along the molecule.
 */
const GAPS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]

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
  /**
   * Cells each end of a **meeting** is read into ({@link meetingScore}): a
   * third of the distance at which the law falls to eight times the trans level,
   * between eight and {@link MEETING_REACH} — longer than a junction's window,
   * since whether two separate ends meet is asked of every contact that can
   * still tell an adjacency from the background.
   */
  reach: number
  /** A meeting window holding exactly the law, gap nought, against the trans level: the unit meetings are counted in. */
  meetUnit: number
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

  let far8 = 1
  while (far8 < 3 * MEETING_REACH && far8 < n && law[far8] >= 8 * transLevel) far8++
  const meetReach = Math.max(LEAST_MEETING, Math.min(MEETING_REACH, Math.ceil(far8 / 3)))
  let meetUnit = 0
  for (let i = 0; i < meetReach; i++) {
    for (let j = 0; j < meetReach; j++) {
      const p = law[Math.min(n, i + j + 1)]
      meetUnit += p * Math.log((p + transLevel) / transLevel) - p
    }
  }
  meetUnit = Math.max(meetUnit / dispersion, 1e-9)

  return { law, trans: transLevel, dispersion, bias, window, unit, reach: meetReach, meetUnit }
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
  readonly reach: number
  readonly meetUnit: number
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
  /** The cells between sequence ends, as they are; `null` where the pass kept none. */
  private readonly ends: PictureEnds | null

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
    this.reach = expected.reach
    this.meetUnit = expected.meetUnit
    this.band = contacts.band
    this.width = contacts.width
    this.sequenceOf = contacts.sequenceOf
    this.coarseOf = contacts.coarse.of
    this.coarseValues = contacts.coarse.values
    this.coarseN = contacts.coarse.n
    this.bias = expected.bias
    this.ends = contacts.ends ?? null
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
      const ends = this.ends
      const zoned = ends !== null && ends.zone[lo] >= 0 && ends.zone[hi] >= 0
      const held = zoned ? endValue(ends, lo, hi) : undefined
      // Listed, it is the value; not listed, it held nothing — unless the
      // budget ran out before its row, and then the coarse grid says.
      if (held !== undefined) v = held
      else if (zoned && ends.complete) v = 0
      else v = this.coarseValues[triangleIndex(this.coarseOf[lo], this.coarseOf[hi], this.coarseN)]
    }
    return v / (this.bias[a] * this.bias[b])
  }

  /** The coarse cell an edited cell is in, or `-1` in a gap. */
  coarseCell(i: number): number {
    const a = this.cellMap[i]
    return a < 0 ? -1 : this.coarseOf[a]
  }

  /** The coarse grid's value between two coarse cells: a mean over their cells, not divided by coverage. */
  coarseValue(x: number, y: number): number {
    return this.coarseValues[x <= y ? triangleIndex(x, y, this.coarseN) : triangleIndex(y, x, this.coarseN)]
  }

  /** Whether an edited cell holds anything the balancer kept: a cell of no gap, with coverage. */
  holds(i: number): boolean {
    const a = this.cellMap[i]
    return a >= 0 && this.bias[a] > 0
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

/** Two ends' meeting (§27.5): the evidence they meet, and the gap and strength it was found at. */
export interface Meeting {
  /** The log-likelihood of their meeting over their lying apart at the trans level, over the dispersion. */
  score: number
  /** The gap the meeting fits best, in cells: what the assembly left out between them. */
  gap: number
  /** How much of the law the window holds at that gap, above the trans level, `0 … 1`. */
  amplitude: number
  /**
   * The window over the law at gap nought, uncapped: above one, brighter than
   * any adjacency — the whole window, so one hot cell at a thinly covered end is
   * not a bright corner, and a repeat both ends carry is.
   */
  brightness: number
  /** The window's mean over the trans level. */
  level: number
  /**
   * The score its own window would have holding exactly the law, gap nought:
   * what a clean adjacency of these two ends would score, so `score / ideal`
   * says how much of one this meeting is, however short the ends.
   */
  ideal: number
  seen: number
  reached: number
}

/** One end's walk into its stretch: the cells it read, and how far from the end each is. */
interface Walk {
  cells: Int32Array
  distance: Int32Array
  length: number
}

/**
 * The cells a meeting reads from an end: its first `reach` that hold
 * anything, walking past those that do not — a subtelomere's repeats, an
 * array's edge — as far as three times `reach`, each kept with its true
 * distance from the end; never more than half the stretch, so that a short
 * sequence's two ends read different cells, which is what tells which way
 * round it goes.
 */
function walk(map: EditedMap, end: End, reach: number): Walk {
  const span = end.hi - end.lo
  const most = Math.max(1, Math.min(reach, Math.floor(span / 2)))
  const cells = new Int32Array(most)
  const distance = new Int32Array(most)
  let length = 0
  for (let k = 0; k < 3 * most && length < most; k++) {
    const cell = end.cell + end.dir * k
    if (cell < end.lo || cell >= end.hi) break
    if (!map.holds(cell)) continue
    cells[length] = cell
    distance[length] = k
    length++
  }
  return { cells, distance, length }
}

/** Whether the coarse cells two walks lie in hold more than twice the trans level between them: worth the fine window. */
function coarselyMeets(map: EditedMap, we: Walk, wf: Walk): boolean {
  const xs = new Set<number>()
  const ys = new Set<number>()
  for (let i = 0; i < we.length; i++) xs.add(map.coarseCell(we.cells[i]))
  for (let j = 0; j < wf.length; j++) ys.add(map.coarseCell(wf.cells[j]))
  let total = 0
  let count = 0
  for (const x of xs) {
    if (x < 0) continue
    for (const y of ys) {
      if (y < 0) continue
      const v = map.coarseValue(x, y)
      if (!(v >= 0)) continue
      total += v
      count++
    }
  }
  return count === 0 || total > 2 * count * map.trans
}

/**
 * Whether two separate ends meet (§27.5): over their walks' windows, the
 * log-likelihood that the contacts are an adjacency's — each cell expected at
 * `A · P(d + g) + T`, `d` the cells it spans across the junction, `g` a gap the
 * assembly left out, `A` how much of the law survived what flanks the gap —
 * over their lying apart at the trans level `T`, a quasi-Poisson likelihood
 * over the file's dispersion. `A` is fitted, not assumed: an assembly breaks in
 * repeats, and the reads that would have mapped beside a break often did not,
 * so a true adjacency is regularly a fraction of the law — and what then tells
 * it from two strangers is that its contacts fall away from the corner as the
 * law does, and which of its ends they fall away from. `g` is the best of a
 * ladder of gaps; the score is the best of those.
 */
export function meetingScore(map: EditedMap, e: End, f: End): Meeting {
  const reach = map.reach
  const we = walk(map, e, reach)
  const wf = walk(map, f, reach)
  const reached = we.length * wf.length
  const empty: Meeting = { score: 0, gap: 0, amplitude: 0, brightness: 0, level: 0, ideal: 0, seen: 0, reached }
  if (reached === 0) return empty
  // First the coarse grid: most pairs of an assembly's ends share no more than
  // strangers do, and a few coarse cells say so without the window's.
  if (!coarselyMeets(map, we, wf)) return empty
  const values = new Float64Array(reached)
  const span = new Int32Array(reached)
  let seen = 0
  let total = 0
  for (let i = 0; i < we.length; i++) {
    for (let j = 0; j < wf.length; j++) {
      const v = map.value(we.cells[i], wf.cells[j])
      if (!(v >= 0)) continue
      values[seen] = v
      span[seen] = we.distance[i] + wf.distance[j] + 1
      total += v
      seen++
    }
  }
  if (seen === 0) return empty
  const trans = map.trans
  // Two ends whose window holds no more than two strangers share meet in no
  // way worth a fit: most pairs of an assembly's ends are these.
  if (total < 1.5 * seen * trans) return { ...empty, level: total / seen / trans, seen }
  let ideal = 0
  let lawTotal = 0
  for (let k = 0; k < seen; k++) {
    const p = map.expectedAt(span[k])
    ideal += p * Math.log((p + trans) / trans) - p
    lawTotal += p
  }
  let best = { score: Number.NEGATIVE_INFINITY, gap: 0, amplitude: 0 }
  for (const gap of GAPS) {
    let expected = 0
    for (let k = 0; k < seen; k++) expected += map.expectedAt(span[k] + gap)
    if (!(expected > 0)) continue
    const amplitude = Math.min(1, Math.max(1e-6, (total - seen * trans) / expected))
    let score = 0
    for (let k = 0; k < seen; k++) {
      const mean = amplitude * map.expectedAt(span[k] + gap) + trans
      score += values[k] * Math.log(mean / trans) - (mean - trans)
    }
    if (score > best.score) best = { score, gap, amplitude }
    // Past the gap where the law has flattened below the window's own level,
    // a longer one explains nothing more.
    if (map.expectedAt(gap) < trans) break
  }
  return {
    score: best.score / map.dispersion,
    gap: best.gap,
    amplitude: best.amplitude,
    brightness: lawTotal > 0 ? Math.max(0, total - seen * trans) / lawTotal : 0,
    level: total / seen / trans,
    ideal: ideal / map.dispersion,
    seen,
    reached,
  }
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

// ---------------------------------------------------------------------------
// Clustering foci
// ---------------------------------------------------------------------------

/** A place of one sequence of the file that the others' own such places cluster with: a centromere, most often. */
export interface Focus {
  /** The sequence of the file it is on. */
  sequence: number
  /** Its cells of the picture, half-open. */
  from: number
  to: number
  /** Of the other sequences asked, the share whose brightest contact with this one is here. */
  agreement: number
}

/** The fewest coarse cells a sequence must have to be asked where its focus is. */
const FOCUS_LEAST_CELLS = 4

/** Coarse cells either side of a vote that count as the same place. */
const FOCUS_REACH = 1

/**
 * The share of the clustering sequences that must name one place for it to be
 * a focus. Asked only of sequences that cluster themselves, a place a stray
 * peak made is named by one or two of them, never by nearly half; the smallest
 * chromosomes, whose telomeres lie near their centromeres, are named by about
 * half — yeast I and III, at 1 kb.
 */
const FOCUS_AGREEMENT = 0.45

/**
 * Where each sequence's contacts with every other sequence peak, where they
 * agree (§27.5): in a genome whose centromeres cluster — yeasts, many fungi,
 * plants in a Rabl configuration — each chromosome's brightest contact with any
 * other chromosome is its centromere with the other's, so each sequence is asked,
 * of every other one, where in it the brightest coarse cell of their block lies,
 * and a place half of them name is its focus. A genome whose centromeres do not
 * cluster answers every question somewhere else, and has none; nor does a
 * sequence too short to have a place of its own. What it is for: a join that
 * would put two foci far apart in one sequence makes a chromosome with two
 * centromeres, which no curator takes.
 */
export function fociOf(contacts: PictureContacts, expected: Expected): Focus[] {
  const { coarse, sequenceOf, n } = contacts
  const nc = coarse.n
  // Each coarse cell's sequence, first cell and coverage. A coarse cell most
  // of whose cells the balancer emptied is not asked: its mean is the few
  // cells left, and a subtelomere's few are its repeats, which shine in trans.
  const coarseSequence = new Int32Array(nc).fill(-1)
  const coarseFirst = new Int32Array(nc + 1).fill(n)
  const coverage = new Float64Array(nc)
  const counted = new Float64Array(nc)
  const cellsIn = new Float64Array(nc)
  for (let a = n - 1; a >= 0; a--) {
    const c = coarse.of[a]
    coarseSequence[c] = sequenceOf[a]
    coarseFirst[c] = a
    cellsIn[c]++
    if (expected.bias[a] > 0) {
      coverage[c] += expected.bias[a]
      counted[c]++
    }
  }
  for (let c = 0; c < nc; c++) coverage[c] = counted[c] >= 0.6 * cellsIn[c] ? coverage[c] / counted[c] : Number.NaN
  // The sequences' coarse ranges.
  const ranges: Array<[number, number]> = []
  for (let c = 0; c < nc; c++) {
    const s = coarseSequence[c]
    if (s < 0) continue
    const range = ranges[s]
    if (range === undefined) ranges[s] = [c, c + 1]
    else range[1] = c + 1
  }
  const asked: number[] = []
  ranges.forEach((range, s) => {
    if (range !== undefined && range[1] - range[0] >= FOCUS_LEAST_CELLS) asked.push(s)
  })
  if (asked.length < 3) return []
  const value = (x: number, y: number): number => {
    const v = coarse.values[x <= y ? triangleIndex(x, y, nc) : triangleIndex(y, x, nc)] / (coverage[x] * coverage[y])
    return v >= 0 ? v : Number.NaN
  }
  // Each pair's brightest place, once: `peaks[i][j]` is where in the `i`th
  // sequence asked its block with the `j`th peaks, or `-1`.
  const peaks: Int32Array[] = asked.map(() => new Int32Array(asked.length).fill(-1))
  for (let i = 0; i < asked.length; i++) {
    const [a0, a1] = ranges[asked[i]]
    for (let j = i + 1; j < asked.length; j++) {
      const [b0, b1] = ranges[asked[j]]
      let best = 0
      let bx = -1
      let by = -1
      for (let x = a0; x < a1; x++) {
        for (let y = b0; y < b1; y++) {
          // A cell and its eight neighbours, so one noisy cell is not a peak.
          let sum = 0
          let count = 0
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const xx = x + dx
              const yy = y + dy
              if (xx < a0 || xx >= a1 || yy < b0 || yy >= b1) continue
              const v = value(xx, yy)
              if (Number.isNaN(v)) continue
              sum += v
              count++
            }
          }
          const mean = count > 0 ? sum / count : 0
          if (mean > best) {
            best = mean
            bx = x
            by = y
          }
        }
      }
      // A peak no brighter than a few times two strangers is no place at all.
      if (bx < 0 || best < 4 * expected.trans) continue
      peaks[i][j] = bx
      peaks[j][i] = by
    }
  }
  /** The place most of `partners` name in the `i`th sequence, and the share that do. */
  const modeOf = (i: number, partners: readonly number[]): { mode: number; agreement: number } => {
    const list: number[] = []
    for (const j of partners) if (j !== i && peaks[i][j] >= 0) list.push(peaks[i][j])
    const asking = partners.filter((j) => j !== i).length
    if (list.length < 3 || asking === 0) return { mode: -1, agreement: 0 }
    let mode = -1
    let most = 0
    for (const candidate of list) {
      let near = 0
      for (const other of list) if (Math.abs(other - candidate) <= FOCUS_REACH) near++
      if (near > most) {
        most = near
        mode = candidate
      }
    }
    return { mode, agreement: most / asking }
  }
  // Twice: first every sequence asked of all the others, and those a third of
  // them agree on kept as the clustering ones; then every sequence asked again
  // of those alone — a stretch with no centromere of its own, a plasmid, a
  // fragment of a chromosome's arm, answers the first question anywhere, and
  // would dilute every other sequence's agreement.
  const everyone = asked.map((_, i) => i)
  const clustering = everyone.filter((i) => modeOf(i, everyone).agreement >= 1 / 3)
  if (clustering.length < 3) return []
  const out: Focus[] = []
  asked.forEach((s, i) => {
    const { mode, agreement } = modeOf(i, clustering)
    if (mode < 0 || agreement < FOCUS_AGREEMENT) return
    const lo = Math.max(ranges[s][0], mode - FOCUS_REACH)
    const hi = Math.min(ranges[s][1], mode + FOCUS_REACH + 1)
    out.push({ sequence: s, from: coarseFirst[lo], to: coarseFirst[hi], agreement })
  })
  return out
}

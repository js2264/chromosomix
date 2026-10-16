/**
 * Averaging a track over a set of places, in the two shapes that are worth
 * asking for.
 *
 * **Reference-point** takes a point on every feature — its start, its end, its
 * centre — and reads a fixed flank either side. It is what you want when the
 * features are points or when their edges are the thing: a TSS, a peak summit, a
 * called boundary.
 *
 * **Scaled-region** resamples every feature's *body* to the same width and puts
 * a flank on each end. It is what you want when the features have extent and
 * that extent varies: genes, domains. A reference-point plot over genes of
 * wildly different lengths averages the middle of a short gene against the start
 * of a long one and produces a shape that belongs to neither.
 *
 * Four decisions in here are the ones that decide whether the answer means
 * anything.
 *
 * **Strand.** A feature on the minus strand is read right to left, or every
 * asymmetric signal cancels against itself and a promoter looks symmetric.
 *
 * **The average, and the band around it.** The mean of a bimodal set is a line
 * that describes nothing, which is why the companion heatmap exists and why the
 * median is offered. The band is a **percentile bootstrap over features**, not a
 * standard error: signal over a feature set is not normal, its variance is not
 * the interesting thing, and a ±2 SEM ribbon on a skewed distribution is a claim
 * about a Gaussian nobody has.
 *
 * **Missing data.** A window that runs off the end of a sequence is clipped, and
 * the slots outside it are `NaN` rather than zero — so a feature near a telomere
 * contributes to the slots it has evidence for and to no others.
 *
 * **Comparing tracks.** Two tracks share a pair of axes only if they share a
 * unit, and a CPM bigWig and a log2 ratio do not. {@link standardiseTrack} is
 * the way out — each track centred and scaled by its *own* spread, which is the
 * one unit they have in common — and its whole difficulty is which population
 * the statistics are taken over. That is answered there, at length, because
 * getting it wrong deletes the ranking the reader split the set to see.
 */

import type { TrackSamples } from '../annotations/types'
import { nanMean, nanMedian, nanTrimmedMean } from './stats'

/** Where on a feature a reference-point window is centred. */
export type Reference = 'start' | 'end' | 'centre'

/** How the per-feature rows are collapsed into a line. */
export type Average = 'mean' | 'median' | 'trimmed'

/** One place to read, already resolved to coordinates and an orientation. */
export interface Window {
  contig: string
  /** Half-open, clamped to the sequence. */
  start: number
  end: number
  /** `-1` reads the window right to left. */
  strand: number
  /**
   * Slots this window fills, and where it starts filling them.
   *
   * A window clipped at a sequence end covers fewer slots than the layout has,
   * and this is which ones — so the row lands in the right columns rather than
   * being stretched across all of them, which would shift a telomeric feature's
   * signal inwards by however much was clipped.
   */
  slotFrom: number
  slotTo: number
  /**
   * The feature's own extent, and the columns it owns — a scaled-region window
   * only.
   *
   * This is what makes *flank, body, flank* mean what it says. Without it
   * {@link windowRow} spreads a window's base pairs evenly over its slots,
   * which is exactly right for a reference-point window — its span is the same
   * length for every feature, so every column is `step` base pairs — and wrong
   * for a scaled one, whose columns are base pairs at the ends and a
   * *proportion* in the middle. Spread evenly, each feature's body would begin
   * wherever its own length happened to put it: column 15 for a 20 kb gene,
   * column 4 for a 100 kb one, against a {@link Layout} that promises column 40
   * for both.
   *
   * Left `undefined` by {@link referenceWindows}, which is what keeps that
   * mapping the single linear one it should be.
   */
  body?: {
    /** The feature itself, clamped into the window. */
    start: number
    end: number
    /** The slots the body fills, in reading order, clamped into the window's. */
    slotFrom: number
    slotTo: number
  }
}

/** The column layout a run produces, and what each column means. */
export interface Layout {
  /** Total columns. */
  slots: number
  /** Column at which the body begins; equals the upstream flank's width. */
  bodyFrom: number
  /** Column one past the body. Equals {@link slots} minus the downstream flank. */
  bodyTo: number
  /** Base pairs per column in the flanks; `null` for a scaled body. */
  flankStep: number
}

/**
 * The windows for a reference-point run.
 *
 * `slotFrom`/`slotTo` carry the clipping, so a feature 300 bp from the start of
 * a chromosome with a 2 kb flank fills the columns it can reach and leaves the
 * rest empty — rather than reading a 300 bp window and having it resampled
 * across the full width, which would silently compress a promoter into a
 * quarter of the plot.
 */
export function referenceWindows(
  features: ReadonlyArray<{ contig: string; start: number; end: number; strand: number }>,
  options: { at: Reference; flank: number; step: number; lengthOf(contig: string): number },
): { windows: Window[]; layout: Layout } {
  const perSide = Math.max(1, Math.round(options.flank / options.step))
  const slots = perSide * 2
  const layout: Layout = { slots, bodyFrom: perSide, bodyTo: perSide, flankStep: options.step }
  const windows: Window[] = []

  for (const feature of features) {
    const anchor =
      options.at === 'start'
        ? feature.strand < 0
          ? feature.end
          : feature.start
        : options.at === 'end'
          ? feature.strand < 0
            ? feature.start
            : feature.end
          : Math.round((feature.start + feature.end) / 2)
    const length = options.lengthOf(feature.contig)
    const wanted = { from: anchor - perSide * options.step, to: anchor + perSide * options.step }
    const start = Math.max(0, wanted.from)
    const end = Math.min(length, wanted.to)
    if (!(end > start)) continue
    // How much was clipped, in slots, on the side that is *upstream in reading
    // order* — which is the far side for a minus-strand feature.
    const lostLow = Math.round((start - wanted.from) / options.step)
    const lostHigh = Math.round((wanted.to - end) / options.step)
    const slotFrom = feature.strand < 0 ? lostHigh : lostLow
    const slotTo = slots - (feature.strand < 0 ? lostLow : lostHigh)
    if (!(slotTo > slotFrom)) continue
    windows.push({ contig: feature.contig, start, end, strand: feature.strand, slotFrom, slotTo })
  }
  return { windows, layout }
}

/**
 * The windows for a scaled-region run: flank, body, flank.
 *
 * The body of every feature is resampled to the same number of columns, so the
 * plot's x axis is *proportion through the feature* in the middle and base pairs
 * at the ends. Features shorter than one column of body are dropped rather than
 * stretched — a 200 bp gene resampled to fifty columns is fifty copies of two
 * numbers, which flattens the average towards it for no evidence.
 */
export function scaledWindows(
  features: ReadonlyArray<{ contig: string; start: number; end: number; strand: number }>,
  options: {
    body: number
    flank: number
    step: number
    lengthOf(contig: string): number
  },
): { windows: Window[]; layout: Layout; dropped: number } {
  const perSide = Math.max(0, Math.round(options.flank / options.step))
  const slots = options.body + perSide * 2
  const layout: Layout = {
    slots,
    bodyFrom: perSide,
    bodyTo: perSide + options.body,
    flankStep: options.step,
  }
  const windows: Window[] = []
  let dropped = 0

  for (const feature of features) {
    if (feature.end - feature.start < options.body) {
      dropped++
      continue
    }
    const length = options.lengthOf(feature.contig)
    const wanted = {
      from: feature.start - perSide * options.step,
      to: feature.end + perSide * options.step,
    }
    const start = Math.max(0, wanted.from)
    const end = Math.min(length, wanted.to)
    if (!(end > start)) {
      dropped++
      continue
    }
    // A clipped flank costs the slots it could not reach, at the flank's own
    // resolution; the body is never clipped because it is inside the feature.
    const lostLow = Math.round((start - wanted.from) / options.step)
    const lostHigh = Math.round((wanted.to - end) / options.step)
    const slotFrom = feature.strand < 0 ? lostHigh : lostLow
    const slotTo = slots - (feature.strand < 0 ? lostLow : lostHigh)
    if (!(slotTo > slotFrom)) {
      dropped++
      continue
    }
    // The body's own columns, which is what lets {@link windowRow} resample it
    // rather than smearing the whole window across the row uniformly. Clipping
    // normally costs flank columns only, as above — but a feature that runs off
    // the end of its own sequence loses body columns too, so both the extent
    // and the columns are clamped into what this window actually reaches.
    const bodyStart = Math.min(Math.max(feature.start, start), end)
    const bodyEnd = Math.min(Math.max(feature.end, bodyStart), end)
    const bodySlotFrom = Math.min(Math.max(layout.bodyFrom, slotFrom), slotTo)
    const bodySlotTo = Math.min(Math.max(layout.bodyTo, bodySlotFrom), slotTo)
    windows.push({
      contig: feature.contig,
      start,
      end,
      strand: feature.strand,
      slotFrom,
      slotTo,
      body: { start: bodyStart, end: bodyEnd, slotFrom: bodySlotFrom, slotTo: bodySlotTo },
    })
  }
  return { windows, layout, dropped }
}

/**
 * One window's samples, area-weighted into its slots.
 *
 * Area-weighted rather than nearest: an interval that straddles two columns
 * belongs partly to each, and taking whichever it starts in makes a coarse
 * summary level jump between columns. It is the same rule `render/tracks.ts`
 * uses to turn samples into pixels, for the same reason — and using a different
 * one here would make a metaplot of a track disagree with the picture of it.
 *
 * A slot no interval reached is `NaN`, so the aggregation below skips it rather
 * than averaging in a zero nothing measured.
 *
 * *Which* slot an interval reaches is {@link positionOf}, which is also where
 * strand is turned round — so everything here reads in the row's own order and
 * a minus-strand feature needs no second thought below.
 */
export function windowRow(
  samples: TrackSamples,
  window: Window,
  slots: number,
): Float64Array {
  const row = new Float64Array(slots).fill(Number.NaN)
  const covered = window.slotTo - window.slotFrom
  if (covered <= 0) return row
  const span = window.end - window.start
  if (span <= 0) return row

  const totals = new Float64Array(covered)
  const weights = new Float64Array(covered)
  const edges = slotEdges(covered)

  // Every interval of every feature passes through here — tens of millions
  // over the RefSeq TSS at base resolution — so what does not change from one
  // to the next is read once: the arrays, the window's ends, its direction. The
  // arithmetic is `positionOf`'s and the slots' own, in the same order, so a
  // row is the same to the last bit.
  const { values, starts, ends } = samples
  const lo = window.start
  const hi = window.end
  const back = window.strand < 0
  const linear = window.body === undefined
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) continue
    const from = Math.max(lo, starts[i])
    const to = Math.min(hi, ends[i])
    if (!(to > from)) continue
    // Where the interval falls, as a fraction of the slots this window covers.
    // Already in reading order, so `a` is the low end of the row's span and `b`
    // the high one whichever way the feature points.
    let a: number
    let b: number
    if (linear) {
      // `positionOf` for a window with no body, written out.
      const one = (from - lo) / (hi - lo)
      const two = (to - lo) / (hi - lo)
      a = back ? 1 - two : one
      b = back ? 1 - one : two
    } else {
      const one = positionOf(window, from)
      const two = positionOf(window, to)
      a = back ? two : one
      b = back ? one : two
    }
    const first = Math.max(0, Math.floor(a * covered))
    const last = Math.min(covered - 1, Math.ceil(b * covered) - 1)
    for (let slot = first; slot <= last; slot++) {
      const overlap = Math.min(b, edges[slot + 1]) - Math.max(a, edges[slot])
      if (!(overlap > 0)) continue
      totals[slot] += value * overlap
      weights[slot] += overlap
    }
  }

  for (let slot = 0; slot < covered; slot++) {
    if (weights[slot] > 0) row[window.slotFrom + slot] = totals[slot] / weights[slot]
  }
  return row
}

/** `slot / covered` for every slot edge, `0 … covered`, by the slot count. */
const EDGES = new Map<number, Float64Array>()

/** The slot edges of a window covering `covered` slots, as fractions of it. */
function slotEdges(covered: number): Float64Array {
  let edges = EDGES.get(covered)
  if (edges === undefined) {
    edges = new Float64Array(covered + 1)
    for (let slot = 0; slot <= covered; slot++) edges[slot] = slot / covered
    EDGES.set(covered, edges)
  }
  return edges
}

/**
 * Where one base pair falls, as a fraction of the slots a window covers, in
 * reading order.
 *
 * A reference-point window is **one** linear map, and has to be: its span is
 * the same length for every feature, so spreading it evenly over the row is
 * what puts every feature's anchor in the same column.
 *
 * A scaled-region window is **three** maps joined end to end — upstream flank,
 * body, downstream flank — because that is the only way the body can be
 * *resampled* to a fixed number of columns while the flanks stay in base pairs.
 * One linear map over the whole of such a window (which is what this was before
 * {@link Window.body} existed) hands each feature a share of the row set by its
 * own length instead: with the shipped defaults a 20 kb gene's body occupied
 * columns 15 to 165 and a 100 kb gene's columns 4 to 176, against a layout
 * promising 40 to 140 for both. Nothing was resampled to a fixed width and no
 * two features were aligned, so the average was the middle of a short gene
 * against the start of a long one — the very failure the mode exists to
 * prevent, and the companion heatmap carried it too.
 *
 * **Reading order, not coordinate order.** A minus-strand feature is read from
 * its high coordinate down, so the base-pair knots reverse. The slot knots do
 * not: `slotFrom`/`slotTo` and `body.slotFrom`/`body.slotTo` are already in
 * reading order.
 */
function positionOf(window: Window, bp: number): number {
  const body = window.body
  if (body === undefined) {
    const through = (bp - window.start) / (window.end - window.start)
    return window.strand < 0 ? 1 - through : through
  }
  const back = window.strand < 0
  const opens = back ? window.end : window.start
  const bodyOpens = back ? body.end : body.start
  const bodyCloses = back ? body.start : body.end
  const closes = back ? window.start : window.end
  // Segment by segment rather than by a search for the one `bp` is in, which
  // is what lets an empty segment fall out rather than being special-cased.
  const slot =
    window.slotFrom +
    progress(bp, opens, bodyOpens) * (body.slotFrom - window.slotFrom) +
    progress(bp, bodyOpens, bodyCloses) * (body.slotTo - body.slotFrom) +
    progress(bp, bodyCloses, closes) * (window.slotTo - body.slotTo)
  return (slot - window.slotFrom) / (window.slotTo - window.slotFrom)
}

/**
 * How far `bp` is through one segment, in `[0, 1]`, whichever way it runs.
 *
 * A segment of no base pairs reads as entirely behind `bp`, so the segments
 * after it still receive the whole coordinate. That is safe because a segment
 * with no base pairs has no columns either — a run with no flank at all, or a
 * flank clipped away down to nothing — so it awards a range of width zero.
 */
function progress(bp: number, from: number, to: number): number {
  if (from === to) return 1
  const through = (bp - from) / (to - from)
  return through < 0 ? 0 : through > 1 ? 1 : through
}

/** A line and the band around it, over a matrix of one row per feature. */
export interface Aggregated {
  mean: Float64Array
  low: Float64Array
  high: Float64Array
  /** Rows that contributed at least one finite value. */
  n: number
}

/**
 * Collapse the per-feature rows into a line.
 *
 * `rows` is row-major, `count × slots`, with `NaN` wherever a feature had no
 * evidence for a column. Every statistic here skips those rather than treating
 * them as zero, so a column's average is over the features that reached it and
 * the count is reported.
 */
export function aggregate(
  rows: Float64Array,
  count: number,
  slots: number,
  options: {
    average: Average
    trim: number
    band: 'none' | 'bootstrap' | 'sd'
    iterations: number
    level: number
    rng(): number
  },
): Aggregated {
  const mean = new Float64Array(slots).fill(Number.NaN)
  const low = new Float64Array(slots).fill(Number.NaN)
  const high = new Float64Array(slots).fill(Number.NaN)
  if (count === 0) return { mean, low, high, n: 0 }

  const column = new Float64Array(count)
  // One block, reused: {@link nanSd} takes a list because the *other* caller has
  // a track's rows spread across one array per group, and allocating a fresh
  // wrapper inside the slot loop would be an allocation per column for nothing.
  const columnBlock: Float64Array[] = [column]
  const collapse = (values: Float64Array): number =>
    options.average === 'median'
      ? nanMedian(values)
      : options.average === 'trimmed'
        ? nanTrimmedMean(values, options.trim)
        : nanMean(values)

  for (let slot = 0; slot < slots; slot++) {
    for (let row = 0; row < count; row++) column[row] = rows[row * slots + slot]
    mean[slot] = collapse(column)
    if (options.band === 'sd') {
      const sd = nanSd(columnBlock, mean[slot])
      if (Number.isFinite(sd)) {
        low[slot] = mean[slot] - sd
        high[slot] = mean[slot] + sd
      }
    }
  }

  if (options.band === 'bootstrap' && count > 1) {
    // Resamples **features**, not columns, and the same resample across every
    // column of one iteration — which is what makes the band a statement about
    // the feature set rather than about each column independently.
    const draws = new Float64Array(options.iterations * slots)
    const pick = new Int32Array(count)
    const scratch = new Float64Array(count)
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      for (let row = 0; row < count; row++) pick[row] = Math.floor(options.rng() * count) % count
      for (let slot = 0; slot < slots; slot++) {
        for (let row = 0; row < count; row++) scratch[row] = rows[pick[row] * slots + slot]
        draws[iteration * slots + slot] = collapse(scratch)
      }
    }
    const alpha = (1 - options.level) / 2
    const sample = new Float64Array(options.iterations)
    for (let slot = 0; slot < slots; slot++) {
      for (let i = 0; i < options.iterations; i++) sample[i] = draws[i * slots + slot]
      const sorted = Array.from(sample).filter(Number.isFinite).sort((a, b) => a - b)
      if (sorted.length === 0) continue
      low[slot] = sorted[Math.floor(alpha * (sorted.length - 1))]
      high[slot] = sorted[Math.ceil((1 - alpha) * (sorted.length - 1))]
    }
  }

  let n = 0
  for (let row = 0; row < count; row++) {
    for (let slot = 0; slot < slots; slot++) {
      if (Number.isFinite(rows[row * slots + slot])) {
        n++
        break
      }
    }
  }
  return { mean, low, high, n }
}

/**
 * Centre and scale one track's rows by that track's own spread, in place.
 *
 * A metaplot of two tracks on one pair of axes is a comparison only if the two
 * are in the same units, and a CPM bigWig and a log2 ratio are not: one runs
 * over tens and the other over ±2, so drawn together the second is a flat line
 * along the bottom of the frame and whatever shape it was loaded for cannot be
 * seen. Standardising each track against itself puts both on an axis whose unit
 * is *this track's own spread*, which is the only unit they have in common. The
 * y axis then names z-scores rather than the raw quantity, and the caller has to
 * say so — `run/metaplot.ts` relabels it.
 *
 * **The population is the track, over every one of its groups.** `blocks` is one
 * array of rows per ranking group and the mean and the standard deviation are
 * taken over all of them together, which is why this takes a list rather than
 * being called once per group. Per group, each group would be re-centred on
 * itself and every one of them would sit on zero — deleting exactly the thing
 * the reader split the feature set to see, that the strongest quartile is
 * *above* the weakest. The ranking would survive in the legend and nowhere in
 * the picture, which is the worst way for a figure to be wrong.
 *
 * Gaps stay gaps. A `NaN` slot is no evidence, it enters neither statistic and
 * it comes back `NaN` — `analysis/stats.ts` opens with the rule, and turning an
 * uncovered slot into a 0 here would plant a value one standard deviation below
 * the track's mean at every position no read reached.
 *
 * **A track with no spread is centred and not scaled.** A constant track, or one
 * with a single covered slot in the whole run, has a standard deviation of zero
 * or none at all; dividing by it would fill the plot with `±Infinity`, which is
 * not a picture of anything and which propagates through the average and the
 * bootstrap alike. Subtracting the mean and stopping there draws the flat line
 * such a track honestly is. `scaled` reports which of the two happened, so a
 * caller that wants to say so out loud can.
 */
export function standardiseTrack(
  blocks: ReadonlyArray<Float64Array>,
): { mean: number; sd: number; scaled: boolean } {
  const mean = nanMeanOf(blocks)
  const sd = nanSd(blocks, mean)
  // Nothing finite anywhere: there is nothing to centre and the rows are already
  // all gaps. Rewriting them would only turn `NaN` into `NaN` more slowly.
  if (!Number.isFinite(mean)) return { mean, sd, scaled: false }
  const scaled = Number.isFinite(sd) && sd > 0
  for (const rows of blocks) {
    for (let i = 0; i < rows.length; i++) {
      const value = rows[i]
      if (!Number.isFinite(value)) continue
      rows[i] = scaled ? (value - mean) / sd : value - mean
    }
  }
  return { mean, sd, scaled }
}

/**
 * The mean of the finite values across several blocks; `NaN` when there are
 * none.
 *
 * `stats.ts`'s `nanMean` over one array at a time would need the counts carried
 * between the calls to weight them, and a mean of per-group means is not the
 * mean of the population unless the groups are the same size — which the top-N
 * and bottom-N subsets are not.
 *
 * Skips everything non-finite rather than only `NaN`, which is where this parts
 * company with `nanMean`: one infinity in one row would otherwise make the mean
 * infinite and take every slot of every group down with it.
 */
function nanMeanOf(blocks: ReadonlyArray<ArrayLike<number>>): number {
  let total = 0
  let seen = 0
  for (const values of blocks) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (!Number.isFinite(value)) continue
      total += value
      seen++
    }
  }
  return seen === 0 ? Number.NaN : total / seen
}

/**
 * Standard deviation about a known mean, skipping gaps.
 *
 * Takes *blocks* because its two callers have their population in different
 * shapes — one column of an aggregation, or a whole track's rows held as one
 * array per ranking group — and they are one population each. The sample
 * denominator (`n - 1`) needs a second observation, and one observation gets
 * `NaN` rather than `0`: no spread measured is not a spread of none.
 */
function nanSd(blocks: ReadonlyArray<ArrayLike<number>>, mean: number): number {
  if (!Number.isFinite(mean)) return Number.NaN
  let total = 0
  let seen = 0
  for (const values of blocks) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (!Number.isFinite(value)) continue
      total += (value - mean) ** 2
      seen++
    }
  }
  return seen > 1 ? Math.sqrt(total / (seen - 1)) : Number.NaN
}

/**
 * The x coordinate of every column, and what it is a coordinate *in*.
 *
 * A reference-point plot has one unit throughout — base pairs from the anchor —
 * and says so. A scaled-region plot does not: its middle is *proportion through
 * a feature* and its ends are base pairs, and there is no honest single number
 * that is both. Rather than invent one, the axis for a scaled plot is the column
 * index and the label says so; the meaning of the three regions belongs on the
 * ticks, which is what every tool that draws this plot does.
 *
 * The alternative — pretending the body is some number of base pairs — puts a
 * scale on the axis that is true of no feature in the set.
 */
export function axisFor(layout: Layout): { x: Float64Array; label: string } {
  const out = new Float64Array(layout.slots)
  const scaled = layout.bodyTo > layout.bodyFrom
  for (let slot = 0; slot < layout.slots; slot++) {
    out[slot] = scaled ? slot : (slot - layout.bodyFrom + 0.5) * layout.flankStep
  }
  return {
    x: out,
    label: scaled ? 'Position (upstream · body · downstream)' : 'Distance from the anchor (bp)',
  }
}

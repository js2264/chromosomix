/**
 * Value tracks: a bigWig, resolved into a line, an area or bars.
 *
 * Two stages, deliberately separate. {@link profileOf} reduces whatever arrived
 * — a thousand summary intervals or a hundred thousand base-resolution ones —
 * to **one value per screen pixel**, and {@link drawTrack} turns that into ink.
 * The split is what makes the second stage cheap: changing a colour, a mode or a
 * clip redraws from a 900-entry profile instead of walking the intervals again,
 * which is the same trade `poolDisplay`/`colorize` make for the matrix.
 *
 * The reduction is span-weighted, not nearest-sample. A pixel covering 13 kb of
 * a whole-genome view holds a hundred intervals of unequal width, and the number
 * that belongs there is the mean over the base pairs, not the mean over the
 * intervals — otherwise a single narrow spike outvotes the coverage around it.
 * The extremes are kept alongside it, so an area track can show the envelope the
 * mean was taken over: that is the honest form of "averaging when zoomed out",
 * because it says what the average hid.
 */

import { valueAcross, laneRect, type LaneFrame } from './lane'
import type { LocusAxis } from './locus'
import { percentileOf } from './scale'
import type { Limits, TrackSampleSet } from '../annotations/types'

/**
 * One value per canvas pixel along the genomic axis.
 *
 * `NaN` means *no data covered this pixel*, which is a different thing from
 * zero: a bigWig has gaps, and drawing a gap at the baseline claims coverage of
 * zero where the file claims nothing at all.
 */
export interface PixelProfile {
  /** Canvas pixel the first slot starts at. */
  from: number
  /** Span-weighted mean per pixel. */
  mean: Float32Array
  /** Smallest value seen in the pixel; `NaN` where the samples carried none. */
  low: Float32Array
  /** Largest value seen in the pixel. */
  high: Float32Array
  /** `true` when `low`/`high` are a genuine envelope rather than copies of the mean. */
  envelope: boolean
  /**
   * What "autoscale to what is in view" resolves to.
   *
   * Neither the means' range nor the envelope's, but a considered compromise
   * between them, because both extremes are wrong in a way that is easy to see
   * on a whole-genome view of a real ATAC track:
   *
   * - **The envelope's maximum** is whatever single base was highest inside a
   *   13 kb pixel. Scaling to it flattens every track in the file onto its own
   *   baseline — the first version did this, and the picture was unreadable.
   * - **The means' maximum** puts the line at full height and leaves the
   *   envelope clipped over the entire lane, so a peaky track paints as one
   *   solid block — the second version did this, which was no better.
   *
   * So the ceiling is the {@link ENVELOPE_PERCENTILE}th percentile of the
   * per-pixel maxima, raised if necessary to fit the largest mean. The drawn
   * line therefore always fits, the envelope fits except for its extreme tail,
   * and a handful of outlier bases cannot decide the scale of the whole track.
   */
  extent: { min: number; max: number } | null
}

/**
 * Where the autoscale's ceiling sits in the per-pixel maxima.
 *
 * High enough that the envelope is genuinely informative rather than clipped
 * flat, low enough that one saturated base in a 12 Mb genome does not set the
 * scale. Same spirit as §7.1's 99th-percentile `vmax` for the matrix, and a
 * little more forgiving because a track's outliers are single bases.
 */
export const ENVELOPE_PERCENTILE = 98

/**
 * Reduce samples to one value per pixel.
 *
 * Every interval is distributed across the pixels it overlaps in proportion to
 * how much of each it covers, so a wide summary interval contributes to all of
 * them and a single-base one contributes to the fraction of a pixel it occupies.
 */
export function profileOf(
  frame: LaneFrame,
  axis: LocusAxis,
  samples: TrackSampleSet | null,
): PixelProfile {
  const from = Math.floor(frame.alongFrom)
  const slots = Math.max(1, Math.ceil(frame.alongTo) - from)
  const mean = new Float32Array(slots).fill(Number.NaN)
  const low = new Float32Array(slots).fill(Number.NaN)
  const high = new Float32Array(slots).fill(Number.NaN)
  const empty: PixelProfile = { from, mean, low, high, envelope: false, extent: null }
  if (samples === null || samples.regions.length === 0) return empty

  const sum = new Float64Array(slots)
  const weight = new Float64Array(slots)
  let envelope = false

  for (const region of samples.regions) {
    const segment = axis.segmentOf(region.contig)
    if (segment === null || !(segment.bpPerUnit > 0)) continue
    const { starts, ends, values } = region
    const hasBand = region.min !== null && region.max !== null
    if (hasBand) envelope = true

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (!Number.isFinite(value)) continue
      // (contig, bp) → matrix coordinate → canvas pixel, through the axis the
      // heatmap itself is drawn in. Inlined rather than routed through
      // `locusToUnit`, because this runs once per interval and the segment has
      // already been resolved.
      const u0 = segment.unitStart + (starts[i] - segment.bpStart) / segment.bpPerUnit
      const u1 = segment.unitStart + (ends[i] - segment.bpStart) / segment.bpPerUnit
      let p0 = frame.toPixel(u0) - from
      let p1 = frame.toPixel(u1) - from
      if (p1 < p0) [p0, p1] = [p1, p0]
      if (p1 <= 0 || p0 >= slots) continue
      if (p0 < 0) p0 = 0
      if (p1 > slots) p1 = slots

      const first = Math.floor(p0)
      const last = Math.min(slots - 1, Math.ceil(p1) - 1)
      const lo = hasBand ? (region.min as Float32Array)[i] : value
      const hi = hasBand ? (region.max as Float32Array)[i] : value
      for (let slot = first; slot <= last; slot++) {
        const covered = Math.min(p1, slot + 1) - Math.max(p0, slot)
        // A sub-pixel interval still owns the pixel it lands in: without a floor
        // its weight is its width in pixels, which for a 1 bp feature at
        // whole-genome zoom is 7e-5 and rounds to nothing beside its neighbours.
        const share = covered > 0 ? covered : 1e-3
        sum[slot] += value * share
        weight[slot] += share
        if (Number.isFinite(lo) && (Number.isNaN(low[slot]) || lo < low[slot])) low[slot] = lo
        if (Number.isFinite(hi) && (Number.isNaN(high[slot]) || hi > high[slot])) high[slot] = hi
      }
    }
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let drawn = 0
  for (let slot = 0; slot < slots; slot++) {
    if (weight[slot] <= 0) continue
    const value = sum[slot] / weight[slot]
    mean[slot] = value
    if (Number.isNaN(low[slot])) low[slot] = value
    if (Number.isNaN(high[slot])) high[slot] = value
    if (value < min) min = value
    if (value > max) max = value
    if (low[slot] < min) min = low[slot]
    drawn++
  }
  if (drawn === 0) return empty

  return {
    from,
    mean,
    low,
    high,
    envelope,
    extent: { min, max: Math.max(max, ceilingOf(high, drawn)) },
  }
}

/**
 * The {@link ENVELOPE_PERCENTILE}th percentile of the per-pixel maxima.
 *
 * Quickselect over a scratch copy, as the matrix's own `vmax` rule does: two
 * order statistics out of a few hundred values is not worth a sort, and this
 * runs once per lane per view change.
 */
function ceilingOf(high: Float32Array, drawn: number): number {
  const kept = new Float32Array(drawn)
  let at = 0
  for (let slot = 0; slot < high.length && at < drawn; slot++) {
    if (Number.isFinite(high[slot])) kept[at++] = high[slot]
  }
  if (at === 0) return Number.NEGATIVE_INFINITY
  return percentileOf(kept.subarray(0, at) as Float32Array, ENVELOPE_PERCENTILE)
}

// ---------------------------------------------------------------------------
// The value axis
// ---------------------------------------------------------------------------

/**
 * The limits actually in force: the manual pair, or the data's own.
 *
 * An auto range is anchored at zero when the data is one-signed, because a
 * coverage track whose floor is its own minimum is a track that never touches
 * its baseline and whose height means nothing. A track that genuinely crosses
 * zero — a log ratio — keeps both ends, and is made symmetric so that "no
 * change" sits in the middle of the lane where the eye expects it.
 */
export function resolveLimits(
  limits: Limits,
  extent: { min: number; max: number } | null,
): { min: number; max: number } {
  if (!limits.auto) {
    return limits.max > limits.min ? { min: limits.min, max: limits.max } : { min: 0, max: 1 }
  }
  if (extent === null) return { min: 0, max: 1 }
  if (extent.min >= 0) return { min: 0, max: extent.max > 0 ? extent.max : 1 }
  if (extent.max <= 0) return { min: extent.min < 0 ? extent.min : -1, max: 0 }
  const reach = Math.max(Math.abs(extent.min), Math.abs(extent.max))
  return { min: -reach, max: reach }
}

/**
 * A value's position in the lane, in `[0, 1]`.
 *
 * Linear, and only linear. A `log2` option lived here for the ratio tracks, on
 * the reasoning that a doubling is the unit a reader of one thinks in — but it
 * was a per-track dropdown whose effect on a lane 44 pixels tall was hard to
 * read and easy to forget having set, and a lane whose value axis is not the one
 * its neighbour uses is the opposite of what the autoscale *group* beside it is
 * for. A ratio that wants log is better made log by the tool that wrote the
 * bigWig, where the axis label can say so.
 */
export function normaliser(limits: { min: number; max: number }): (value: number) => number {
  const span = limits.max - limits.min
  if (!(span > 0)) return () => 0
  return (value) => (value - limits.min) / span
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export interface TrackPaint {
  colour: string
  mode: 'line' | 'area' | 'bar'
  limits: { min: number; max: number }
  /** Grid and axis-label colour; the page's, so it follows the theme. */
  guideColour: string
  haloColour: string
  font: string
  opacity: number
  /**
   * Whether the shaded areas are drawn: the envelope, and an area track's fill.
   *
   * Required rather than defaulted, so that a new caller has to decide. Both
   * fills are *context* for the line — the envelope says what the mean hid, the
   * area says which side of the baseline the signal is on — and context is the
   * first thing to go when several tracks share one lane or a figure is going
   * into a caption. Bars are unaffected: a bar is the mark itself, not a shade
   * under one.
   */
  fills: boolean
}

/**
 * Draw one value track into its lane.
 *
 * The baseline is where **zero** is whenever zero is inside the limits, and the
 * near edge otherwise. That is the line an area fills to and bars grow from, and
 * putting it anywhere else would draw a ChIP log-ratio track as a solid block
 * with its interesting half below the floor.
 */
export function drawTrack(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  profile: PixelProfile,
  paint: TrackPaint,
): void {
  const norm = normaliser(paint.limits)
  const zero = paint.limits.min <= 0 && paint.limits.max >= 0 ? norm(0) : 0
  const baseAcross = valueAcross(frame, zero)
  const slots = profile.mean.length

  ctx.save()
  ctx.globalAlpha = paint.opacity

  // The envelope first, underneath: it is context for the line, not a second
  // series, so it must never be the thing the eye lands on.
  if (profile.envelope && paint.mode !== 'bar' && paint.fills) {
    ctx.globalAlpha = paint.opacity * 0.25
    ctx.fillStyle = paint.colour
    ctx.beginPath()
    let open = false
    for (let slot = 0; slot < slots; slot++) {
      if (Number.isNaN(profile.high[slot])) continue
      const along = profile.from + slot + 0.5
      const top = valueAcross(frame, norm(profile.high[slot]))
      const bottom = valueAcross(frame, norm(profile.low[slot]))
      const [x, y, width, height] = laneRect(frame, along - 0.5, along + 0.5, top, bottom)
      ctx.rect(x, y, width, height)
      open = true
    }
    if (open) ctx.fill()
    ctx.globalAlpha = paint.opacity
  }

  if (paint.mode === 'bar') {
    ctx.fillStyle = paint.colour
    ctx.beginPath()
    for (let slot = 0; slot < slots; slot++) {
      const value = profile.mean[slot]
      if (Number.isNaN(value)) continue
      const along = profile.from + slot
      const across = valueAcross(frame, norm(value))
      const [x, y, width, height] = laneRect(frame, along, along + 1, baseAcross, across)
      ctx.rect(x, y, width, height)
    }
    ctx.fill()
    drawBaseline(ctx, frame, baseAcross, paint)
    ctx.restore()
    return
  }

  // Line and area share their path: an area is the same polyline closed back to
  // the baseline. Runs are broken at every gap, so a region with no data is a
  // hole in the track rather than a straight line drawn across it.
  const runs = pathRuns(profile)
  if (paint.mode === 'area' && paint.fills) {
    ctx.fillStyle = paint.colour
    ctx.globalAlpha = paint.opacity * 0.5
    for (const [start, stop] of runs) {
      ctx.beginPath()
      tracePath(ctx, frame, profile, norm, start, stop)
      const first = profile.from + start
      const last = profile.from + stop
      ctx.lineTo(...pointOf(frame, last, baseAcross))
      ctx.lineTo(...pointOf(frame, first, baseAcross))
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalAlpha = paint.opacity
  }

  ctx.strokeStyle = paint.colour
  ctx.lineWidth = paint.mode === 'line' ? 1.25 : 1
  ctx.lineJoin = 'round'
  for (const [start, stop] of runs) {
    ctx.beginPath()
    tracePath(ctx, frame, profile, norm, start, stop)
    ctx.stroke()
  }

  drawBaseline(ctx, frame, baseAcross, paint)
  ctx.restore()
}

/** The half-open slot ranges that have data, so gaps break the line. */
function pathRuns(profile: PixelProfile): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let start = -1
  for (let slot = 0; slot < profile.mean.length; slot++) {
    const present = !Number.isNaN(profile.mean[slot])
    if (present && start < 0) start = slot
    if (!present && start >= 0) {
      runs.push([start, slot])
      start = -1
    }
  }
  if (start >= 0) runs.push([start, profile.mean.length])
  return runs
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  profile: PixelProfile,
  norm: (value: number) => number,
  start: number,
  stop: number,
): void {
  for (let slot = start; slot < stop; slot++) {
    const across = valueAcross(frame, norm(profile.mean[slot]))
    const point = pointOf(frame, profile.from + slot + 0.5, across)
    if (slot === start) ctx.moveTo(...point)
    else ctx.lineTo(...point)
  }
}

function pointOf(frame: LaneFrame, along: number, across: number): [number, number] {
  return frame.orientation === 'bottom'
    ? [along, frame.acrossFrom + across]
    : [frame.acrossFrom + across, along]
}

/** A hairline where the value axis reads zero, so a signed track has an origin. */
function drawBaseline(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  across: number,
  paint: TrackPaint,
): void {
  ctx.save()
  ctx.globalAlpha = 0.45
  ctx.strokeStyle = paint.guideColour
  ctx.lineWidth = 0.5
  ctx.beginPath()
  const start = pointOf(frame, frame.alongFrom, across)
  const end = pointOf(frame, frame.alongTo, across)
  ctx.moveTo(start[0], start[1])
  ctx.lineTo(end[0], end[1])
  ctx.stroke()
  ctx.restore()
}

/**
 * A limit, written the way a track axis writes one.
 *
 * Three significant figures is what fits in the corner of a 44-pixel lane and
 * what a reader takes from it; the exponent form is for the ratio tracks, whose
 * interesting values are between 0.01 and 100 and whose outliers are not.
 */
export function formatLimit(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(1)
  if (magnitude >= 100) return value.toFixed(0)
  if (magnitude >= 1) return String(Number(value.toFixed(2)))
  return String(Number(value.toPrecision(2)))
}

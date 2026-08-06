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
   * The means' own range, because the means are what is drawn. This used to be
   * a compromise with the *envelope's* maximum — the highest single base inside
   * each pixel — since the envelope was drawn too and a scale that clipped it
   * painted a peaky track as one solid block. The envelope is gone (see
   * {@link TrackPaint.fills}), and with it the reason: scaling a line to
   * anything above the line's own maximum flattens it onto its baseline for a
   * band nobody can see any more.
   *
   * `low`/`high` remain, and are still worth having — they are what the readout
   * can say a pixel hid — they simply no longer decide the axis.
   */
  extent: { min: number; max: number } | null
}

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

  return { from, mean, low, high, envelope, extent: { min, max } }
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
 * Move a track's ceiling by a factor, from wherever its axis is *resolved to*.
 *
 * Resolved rather than stored, and that is the whole of it: an autoscaled track
 * has no stored pair, so a naive multiply would start from a `[0, 1]` nobody
 * chose and the first notch would jump the picture instead of adjusting it. From
 * the range on screen, one notch is one notch.
 *
 * `null` for a step that would produce an axis nobody can read — a non-finite
 * ceiling, or one that has fallen through the floor. Beside `resolveLimits`
 * because it is the same question asked in the other direction, and because two
 * surfaces reach for it: the browser's ⌘-scroll and the map's.
 */
export function nudgedLimits(
  limits: Limits,
  extent: { min: number; max: number } | null,
  factor: number,
): { auto: false; min: number; max: number } | null {
  const resolved = resolveLimits(limits, extent)
  const max = resolved.max * factor
  if (!Number.isFinite(max) || max <= resolved.min) return null
  return { auto: false, min: resolved.min, max }
}

/**
 * How much of a ceiling a drag across the whole lane is worth: three doublings.
 *
 * Exponential rather than proportional, because a value axis is read
 * logarithmically: from a ceiling of 5 the useful next steps are 2.5 and 10, not
 * 4 and 6. Three octaves over a lane's own height is what makes a short flick
 * useful on a ninety-pixel lane and a full sweep enough to go from a saturated
 * track to an empty one without letting go.
 */
const CEILING_OCTAVES = 3

/** No single gesture may move a ceiling further than this, either way. */
const CEILING_REACH = 64

/**
 * What a drag across a lane does to its ceiling.
 *
 * Direct manipulation, in the one sense that survives both edges and the flip:
 * dragging **towards the signal's own growing direction** makes the signal
 * taller, which is the ceiling coming *down*. Which screen direction that is
 * cannot be written down here — it is `valueAcross`'s answer, and it is opposite
 * on the two edges and reversed again by `flip` — so it is asked rather than
 * assumed, exactly as {@link labelEndFor} asks it about the baseline.
 *
 * `from` and `to` are across-offsets inside the lane, in CSS pixels.
 */
export function ceilingFactor(
  frame: LaneFrame,
  from: number,
  to: number,
  flip: boolean,
): number {
  const height = Math.max(1, frame.thickness)
  // Which way across the lane a *larger value* is drawn: negative below the map,
  // where a track grows up from its floor, positive beside it, where it grows
  // outward — and the other way round again on a flipped track.
  const grows = Math.sign(valueAcross(frame, 1) - valueAcross(frame, 0)) * (flip ? -1 : 1)
  const travel = ((to - from) / height) * grows
  const factor = 2 ** (-travel * CEILING_OCTAVES)
  return Math.min(CEILING_REACH, Math.max(1 / CEILING_REACH, factor))
}

/**
 * A track whose ceiling is being dragged: where it was, and where it is going.
 *
 * Two passes rather than one moving picture, and that is the whole design. The
 * first draws the track exactly as it stood when the gesture began, faded — so
 * the area **does not move**, and stays on screen as the record of the range
 * being left behind. The second draws only the line, at the axis the hand is
 * now asking for, solid. What a reader sees is one trace lifting off its own
 * shadow, which says what a number changing in a corner could not.
 *
 * Nothing is written to the store until the drag ends, which is what lets the
 * first pass stand still: a live restyle would repaint the shadow at the new
 * axis on every frame, and there would be nothing to compare against.
 */
export function drawTrackScaling(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  profile: PixelProfile,
  paint: TrackPaint,
  moved: { min: number; max: number },
): void {
  drawTrack(ctx, frame, profile, { ...paint, opacity: paint.opacity * SCALING_GHOST })
  // No fill and no floor on the second pass: the fill is what is standing still,
  // and a rule drawn twice is a rule drawn at double strength.
  drawTrack(ctx, frame, profile, {
    ...paint,
    limits: moved,
    fills: false,
    baseline: false,
  })
}

/**
 * How wide the outline rule is: a hairline, the floor rule's own width.
 *
 * Sub-pixel deliberately. The outline is describing the edge of a shape that is
 * already there rather than adding a mark of its own, and at a full pixel over a
 * saturated area it reads as a border drawn round the track — which is a second
 * thing on the lane, not a clearer view of the first.
 */
const OUTLINE_WIDTH = 0.75

/** How much of itself the standing-still copy keeps while a ceiling is dragged. */
const SCALING_GHOST = 0.28

/** The axis a drag of `factor` is asking for: the floor holds, the ceiling moves. */
export function scaledTo(
  limits: { min: number; max: number },
  factor: number,
): { min: number; max: number } {
  return { min: limits.min, max: limits.min + (limits.max - limits.min) * factor }
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
   * Whether the area under the line is filled.
   *
   * Under it, and only under it. There used to be a second shade here — the
   * *envelope*, the band between the lowest and highest value inside each
   * pixel — drawn to say what a zoomed-out mean had hidden. It was honest and it
   * was unreadable: the band goes above the line as well as below, so a track's
   * ink extended over data it did not describe, and no reader who had not
   * written it could tell what the pale region was. What a coverage track means
   * by shading is the area under its own curve, which is what this is now.
   *
   * Required rather than defaulted, so that a new caller has to decide. Bars are
   * unaffected: a bar is the mark itself, not a shade under one.
   */
  fills: boolean
  /**
   * Stroke the track's own line in the plot's ink rather than in its colour.
   *
   * The boundary between an area's ink and the paper is the only part of it
   * carrying information, and in the area's own colour it is the one edge of the
   * fill that does not stand out from it. Drawn dark it does — which is what
   * turns four stacked areas into four legible shapes.
   *
   * The *colour* is `guideColour`, the same ink every other rule on the lane is
   * drawn in, rather than a literal black: the plot has one ink and this is it.
   */
  outline: boolean
  /** Draw the value axis upside down — see `AnnotationStyle.flip`. */
  flip: boolean
  /**
   * A rule along the lane's own floor.
   *
   * Not the zero line, which is where the *value axis* reads nothing and can sit
   * anywhere in the lane on a signed track. This is the edge of the strip: it is
   * what tells four stacked coverage tracks apart from one tall one, and what a
   * figure needs so a reader can see where a track ends and the white space
   * begins. Off by default would be the wrong default for a figure and the right
   * one for a screen, so it is a preference rather than a constant.
   */
  baseline: boolean
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
  const linear = normaliser(paint.limits)
  // The flip is one negation, here, at the only place a value becomes a
  // position. Everything downstream — the baseline, the area, the bars, the
  // line — is expressed through `norm`, so an inverted track is drawn by the
  // same code rather than by a mirrored copy of it.
  const norm = paint.flip ? (value: number) => 1 - linear(value) : linear
  const zero = paint.limits.min <= 0 && paint.limits.max >= 0 ? norm(0) : paint.flip ? 1 : 0
  const baseAcross = valueAcross(frame, zero)
  const slots = profile.mean.length

  ctx.save()
  ctx.globalAlpha = paint.opacity

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
    if (paint.outline) {
      ctx.strokeStyle = paint.guideColour
      ctx.lineWidth = OUTLINE_WIDTH
      ctx.stroke()
    }
    drawZeroLine(ctx, frame, baseAcross, paint)
    drawFloor(ctx, frame, paint)
    ctx.restore()
    return
  }

  // Line and area share their path: an area is the same polyline closed back to
  // the baseline. Runs are broken at every gap, so a region with no data is a
  // hole in the track rather than a straight line drawn across it.
  const runs = pathRuns(profile)
  if (paint.mode === 'area' && paint.fills) {
    ctx.fillStyle = paint.colour
    // The track's own opacity, and nothing subtracted from it. The fill used to
    // be drawn at half of it so the line stayed visible against its own area —
    // but that made "no transparency" a setting the picture did not honour, and
    // a reader who asks for a solid area is asking for one. Where several tracks
    // share a lane the caller already dims them (that is what overlaying means);
    // this is not the place to decide it for them.
    ctx.globalAlpha = paint.opacity
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

  ctx.strokeStyle = paint.outline ? paint.guideColour : paint.colour
  // A hairline when it is an outline, and the same one the floor rule uses: it
  // is describing the *edge* of a shape rather than being a mark of its own, and
  // anything heavier reads as a border drawn round the track instead of as the
  // boundary the fill already has.
  ctx.lineWidth = paint.outline ? OUTLINE_WIDTH : paint.mode === 'line' ? 1.25 : 1
  ctx.lineJoin = 'round'
  for (const [start, stop] of runs) {
    ctx.beginPath()
    tracePath(ctx, frame, profile, norm, start, stop)
    ctx.stroke()
  }

  drawZeroLine(ctx, frame, baseAcross, paint)
  drawFloor(ctx, frame, paint)
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

/**
 * A rule along the lane's floor — its outer edge, not its origin.
 *
 * Drawn last and in the page's own ink, so it reads as the *edge of the strip*
 * rather than as a feature of the data: four stacked coverage tracks are four
 * bands, and without a floor under each they are one drawing with four skylines
 * in it.
 */
function drawFloor(ctx: CanvasRenderingContext2D, frame: LaneFrame, paint: TrackPaint): void {
  if (!paint.baseline) return
  ctx.save()
  ctx.globalAlpha = 0.75
  ctx.strokeStyle = paint.guideColour
  ctx.lineWidth = 0.75
  ctx.beginPath()
  const across = frame.orientation === 'bottom' ? frame.thickness : 0
  const start = pointOf(frame, frame.alongFrom, across)
  const end = pointOf(frame, frame.alongTo, across)
  ctx.moveTo(start[0], start[1])
  ctx.lineTo(end[0], end[1])
  ctx.stroke()
  ctx.restore()
}

/** A hairline where the value axis reads zero, so a signed track has an origin. */
function drawZeroLine(
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

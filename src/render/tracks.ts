/**
 * Value tracks: a bigWig, resolved into a line, an area, bars or points.
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

import { OUTLINE_WIDTH, valueAcross, laneRect, laneX, laneY, type LaneFrame } from './lane'
import type { LocusAxis, LocusSegment } from './locus'
import {
  onScale,
  type Limits,
  type TrackMode,
  type TrackScale,
  type TrackSampleSet,
} from '../annotations/types'
import { DEFAULT_COLORMAP, colormapCss } from './colormaps'

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
   * The share of {@link mean} that disagrees with a reference, per pixel, or
   * `null` where there was nothing to compare against.
   *
   * Only an alignment lane ever carries this (§8.13). Reduced through the same
   * weights as the mean, so `variant[i] / mean[i]` is the non-reference fraction
   * of that pixel — and `null` and an array of zeros stay different claims all
   * the way to the paint.
   */
  variant: Float32Array | null
  /**
   * Why this profile is empty, when the file could say.
   *
   * Carried through from {@link TrackSampleSet.note} rather than looked up
   * beside it, because by the time a lane is drawn the samples are gone and the
   * profile is all there is — and "no reads here" and "too many reads here to
   * draw" must not paint identically (§8.13). Absent for every other kind,
   * which is every kind that can answer any window it is asked.
   */
  note?: string
  /**
   * What "autoscale to what is in view" resolves to.
   *
   * **The values the file states inside the window, not the means the pixels
   * came out at** — and that is a correction. Taking the extent off the drawn
   * pixels made the value axis a function of the lane's *pixel width*: the same
   * ATAC track over the same 400 kb window read `0 – 111` on a 680 px lane,
   * `0 – 86.9` on a 560 px one and `0 – 36.9` in a deck cell, so the right-hand
   * stack of one map disagreed with the bottom one and two cells of one deck
   * disagreed with each other about the same data (§8.8, §16.2). A reader
   * comparing them concludes the data differ, which is the one conclusion a
   * picture of one file must not invite.
   *
   * So the range is quantised by the *file* — at a summary level a value already
   * is a mean, over bins the file chose — and not by the window's width in
   * pixels. It can sit a little above the highest mean drawn, which is the trade
   * every other browser makes and is why this is the values and not the
   * envelope: `low`/`high` are the highest and lowest single base a pixel hid,
   * they are no longer drawn, and scaling a line to them flattens it onto its
   * baseline for a band nobody can see. They remain because the readout can
   * still say what a pixel hid.
   */
  extent: { min: number; max: number } | null
}

/**
 * Every stretch of one axis that carries a contig, in axis order.
 *
 * One on nearly every axis, and the loop that walks it is written for the one
 * case where there are two: a circular sequence whose window crosses its own
 * junction is the same contig at both ends of the picture (SPECS §8.15).
 * `LocusAxis.segmentOf` deliberately answers with the first, which is right for
 * a caller resolving a *place* and wrong for one placing *data*.
 */
function segmentsOf(axis: LocusAxis, contig: string): LocusSegment[] {
  return axis.segments.filter((segment) => segment.contig === contig)
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
  scale: TrackScale = 'linear',
): PixelProfile {
  const from = Math.floor(frame.alongFrom)
  const slots = Math.max(1, Math.ceil(frame.alongTo) - from)
  const mean = new Float32Array(slots).fill(Number.NaN)
  const low = new Float32Array(slots).fill(Number.NaN)
  const high = new Float32Array(slots).fill(Number.NaN)
  const note = samples?.note
  const empty: PixelProfile = {
    from,
    mean,
    low,
    high,
    envelope: false,
    variant: null,
    extent: null,
    ...(note === undefined ? {} : { note }),
  }
  if (samples === null || samples.regions.length === 0) return empty

  const sum = new Float64Array(slots)
  const weight = new Float64Array(slots)
  // The value axis, gathered from the file's own numbers as they go past. Kept
  // apart from the per-pixel reduction below because it must not depend on how
  // many pixels there are — see {@link PixelProfile.extent}.
  let seen = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  // Filled only if some region carries one, so a stack of bigWigs allocates
  // nothing and the `null` reaches the paint intact.
  let differing: Float64Array | null = null
  let envelope = false

  for (const region of samples.regions) {
    // **Every** stretch of the axis with this name, not the first. An axis holds
    // a contig twice when a circular sequence is panned across its own junction
    // (SPECS §8.15), and the two stretches hold different halves of it — so a
    // region is offered to both and lands on whichever one contains it, the
    // other placing it outside the visible slots, where the clip below drops it.
    // On every other axis this loop runs once and nothing changes.
    for (const segment of segmentsOf(axis, region.contig)) {
      if (!(segment.bpPerUnit > 0)) continue
      const { starts, ends, values } = region
      const hasBand = region.min !== null && region.max !== null
      if (hasBand) envelope = true
      const varied = region.variant
      if (varied !== null && differing === null) differing = new Float64Array(slots)

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

        // Here, where the interval is known to be on screen, and *before* it is
        // spread over pixels: this is the file's own value inside the window, on
        // the axis the lane is drawn on. A value the scale has no answer for —
        // zero or below, under a logarithm — decides nothing, exactly as it
        // draws nothing.
        const scaled = onScale(value, scale)
        if (Number.isFinite(scaled)) {
          seen++
          if (scaled < min) min = scaled
          if (scaled > max) max = scaled
        }

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
          // Through the same weights as the mean, which is what keeps the ratio
          // of the two a fraction rather than two numbers reduced differently.
          if (varied !== null && differing !== null) differing[slot] += varied[i] * share
          if (Number.isFinite(lo) && (Number.isNaN(low[slot]) || lo < low[slot])) low[slot] = lo
          if (Number.isFinite(hi) && (Number.isNaN(high[slot]) || hi > high[slot])) high[slot] = hi
        }
      }
    }
  }

  let drawn = 0
  for (let slot = 0; slot < slots; slot++) {
    if (weight[slot] <= 0) continue
    // **The scale is applied to the pixel, not to the interval.** A log axis
    // draws `log(mean)`; transforming each interval first and then averaging
    // draws the mean of the logs, which is the geometric mean — a different
    // number, and one nobody asked for by picking an axis. The band's two ends
    // go through the same transform for the same reason, so a readout that says
    // what a pixel hid says it in the units the pixel is drawn in.
    const value = onScale(sum[slot] / weight[slot], scale)
    mean[slot] = value
    if (Number.isNaN(low[slot])) low[slot] = value
    else low[slot] = onScale(low[slot], scale)
    if (Number.isNaN(high[slot])) high[slot] = value
    else high[slot] = onScale(high[slot], scale)
    // A value the scale has no answer for — zero or below, under a logarithm —
    // is a gap, and a gap decides nothing about the axis and draws no ink.
    if (!Number.isFinite(value)) continue
    drawn++
  }
  // Nothing drawn and nothing to scale are the same answer: a lane with no ink
  // has no axis, and a range gathered off intervals that all fell outside the
  // visible slots would be an axis for a picture that is not there.
  if (drawn === 0 || seen === 0) return empty

  let variant: Float32Array | null = null
  if (differing !== null) {
    variant = new Float32Array(slots).fill(Number.NaN)
    for (let slot = 0; slot < slots; slot++) {
      if (weight[slot] <= 0) continue
      variant[slot] = differing[slot] / weight[slot]
    }
  }

  return { from, mean, low, high, envelope, variant, extent: { min, max } }
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
  // and a rule drawn twice is a rule drawn at double strength. Nor the variant
  // marks, for the same reason and one more — drawn again at the axis the hand
  // is asking for they would be two sets of columns at two heights, which reads
  // as two claims about the same positions.
  drawTrack(ctx, frame, { ...profile, variant: null }, {
    ...paint,
    limits: moved,
    fills: false,
    baseline: false,
  })
}

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
  mode: TrackMode
  /**
   * The colormap a `heatmap` lane fills with. Ignored by every other mode.
   *
   * Resolved by the caller ({@link colormapOf}) rather than here, because the
   * choice depends on the lane's *limits* — diverging where they straddle zero —
   * and the caller is the one that has resolved those.
   */
  colormap?: string
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
  /**
   * The curve a `ribbon` fills **down to**; ignored by every other mode.
   *
   * The member below this one in the same lane, which the painter of the stack
   * supplies because it is the only side that knows what order the lane is in.
   * Absent means the innermost band of the set, which fills to the lane's own
   * baseline exactly as an area does — so a lane of one ribbon is an area, which
   * is the right thing for it to be.
   *
   * It must be on the **same slots** as `profile`: both are read at the same
   * pixel resolution over the same window by the same pass, so the painter hands
   * over its neighbour's profile unchanged rather than resampling it, and a slot
   * where either is a gap breaks the band there.
   */
  floor?: PixelProfile
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

  // **A colour rather than a position.** The lane's whole thickness is filled
  // per pixel, so the value costs no height at all — which is the point of the
  // mode and the reason a stack of them fits on a screen. There is no baseline,
  // no zero line and no floor rule: all three describe where a *position* would
  // be read from, and there is no position here.
  //
  // `norm` is the same normaliser every other mode uses, so a heatmap lane
  // answers to the same limits, the same group axis, the same ceiling drag and
  // the same flip — a flipped heatmap reverses its colours, which is what
  // flipping an axis means when the axis is a ramp.
  if (paint.mode === 'heatmap') {
    const map = paint.colormap ?? DEFAULT_COLORMAP
    for (let slot = 0; slot < slots; slot++) {
      const value = profile.mean[slot]
      if (!Number.isFinite(value)) continue
      const along = profile.from + slot
      ctx.fillStyle = colormapCss(map, norm(value))
      const [x, y, width, height] = laneRect(frame, along, along + 1, 0, frame.thickness)
      ctx.fillRect(x, y, width, height)
    }
    drawVariants(ctx, frame, profile, norm, baseAcross, paint)
    ctx.restore()
    return
  }

  // **A band between two curves**, and the only mode whose picture depends on a
  // track that is not this one. The path is this profile's polyline forward and
  // the floor's backward, closed — which is the one shape that is right whether
  // the two curves cross, touch, or run far apart, and which needs no assumption
  // that this track is the higher of the two.
  //
  // Only where both curves have a value. A slot where either is a gap has no
  // band, and drawing across it would invent an edge from the last value that
  // was measured to the next one — over a stretch the run deliberately said
  // nothing about.
  if (paint.mode === 'ribbon') {
    const floor = paint.floor
    const runs = floor === undefined ? pathRuns(profile) : sharedRuns(profile, floor)
    ctx.fillStyle = paint.colour
    for (const [start, stop] of runs) {
      ctx.beginPath()
      tracePath(ctx, frame, profile, norm, start, stop)
      if (floor === undefined) {
        // The innermost band: down to the baseline and back, which is an area.
        ctx.lineTo(...pointOf(frame, profile.from + stop - 0.5, baseAcross))
        ctx.lineTo(...pointOf(frame, profile.from + start + 0.5, baseAcross))
      } else {
        traceBack(ctx, frame, floor, norm, start, stop)
      }
      ctx.closePath()
      ctx.fill()
    }
    // The top edge only. A ribbon's own curve is the quantile it stands for and
    // is worth an outline; its lower edge is the *neighbour's* curve and is
    // drawn by the neighbour, so stroking the closed path would draw every
    // interior edge twice and the hairlines would darken where bands meet.
    ctx.strokeStyle = paint.outline ? paint.guideColour : paint.colour
    ctx.lineWidth = paint.outline ? OUTLINE_WIDTH : 1
    ctx.lineJoin = 'round'
    for (const [start, stop] of runs) {
      ctx.beginPath()
      tracePath(ctx, frame, profile, norm, start, stop)
      ctx.stroke()
    }
    drawVariants(ctx, frame, profile, norm, baseAcross, paint)
    drawFloor(ctx, frame, paint)
    ctx.restore()
    return
  }

  // **A dot per value and nothing between them** — a Manhattan plot's picture.
  // What a line claims and a scatter does not is that the ground between two
  // values is the straight run between them; a track of p-values, or of scores
  // over sparse bins, has no such ground, and its outliers are the reading.
  //
  // One dot per *run* of equal values rather than per pixel: zoomed in, one
  // bin spans many pixels that all carry its value, and a dot on each was a
  // dash where the value is one point — at the middle of the run, which is the
  // bin's middle when all of it is in view. Zoomed out, every pixel is its own
  // mean and its own dot. From the mean, as the line, the area and the bars
  // are, so a points lane answers to the same limits, the same group axis and
  // the same autoscale: a dot at each pixel's highest value would stand above
  // the range the axis was scaled to, all of them piled on the lane's edge.
  //
  // `outline` does not apply, as `fills` does not to bars: a ring round each
  // of a thousand overlapping dots is a smear of the page's ink.
  if (paint.mode === 'points') {
    ctx.fillStyle = paint.colour
    ctx.beginPath()
    for (const [start, stop] of valueRuns(profile)) {
      const across = valueAcross(frame, norm(profile.mean[start]))
      const [x, y] = pointOf(frame, profile.from + (start + stop) / 2, across)
      // A subpath per dot: an arc joins the current point with a line on a
      // canvas, and the PDF page starts one of its own, so without the move the
      // screen would fill the polygon between the dots and the figure would not.
      ctx.moveTo(x + POINT_RADIUS, y)
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2)
    }
    ctx.fill()
    drawVariants(ctx, frame, profile, norm, baseAcross, paint)
    drawZeroLine(ctx, frame, baseAcross, paint)
    drawFloor(ctx, frame, paint)
    ctx.restore()
    return
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
    if (paint.outline) {
      ctx.strokeStyle = paint.guideColour
      ctx.lineWidth = OUTLINE_WIDTH
      ctx.stroke()
    }
    drawVariants(ctx, frame, profile, norm, baseAcross, paint)
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

  drawVariants(ctx, frame, profile, norm, baseAcross, paint)
  drawZeroLine(ctx, frame, baseAcross, paint)
  drawFloor(ctx, frame, paint)
  ctx.restore()
}

/**
 * The fraction of a pixel's depth that must disagree before it is coloured.
 *
 * Sequencing error puts a base or two of disagreement under any real pileup, so
 * a mark drawn at the first mismatch is a lane speckled everywhere and a reader
 * who learns to ignore it. A fifth is IGV's own default and is roughly where a
 * position stops looking like noise and starts looking like an allele — well
 * under the half a heterozygous site gives, and well over the one or two per
 * cent a good run's error rate produces.
 */
const VARIANT_LEAST = 0.2

/**
 * The mark for a position the reads disagree with the reference at.
 *
 * One colour and not four. The *pile* beside this lane already colours a
 * mismatch by the base that was seen, at exactly the zooms where this is drawn
 * (§8.13), so painting four here would be the same claim twice — and this row
 * has no room to make it: a pixel is one column. What this says is *where*, and
 * *how much of the depth*, which is the question the curve alone cannot answer.
 *
 * Drawn from the baseline to the disagreeing depth, inside the track's own
 * shape rather than over it: the coloured part is a share of the bar, so a
 * quarter-height mark under a full-height curve reads as a quarter of the
 * reads, which is what it is.
 *
 * **Not a base colour, and that is the whole of why this hue.** It shipped as
 * `#c8483f`, which is byte-identical to `BASE_COLOURS[3]` — T. On a screen
 * holding a BAM's two rows, that put one red in one column under two different
 * claims: *the reads disagree here* on the depth, and *this read has a T here*
 * in the pile. A reader looking at a T>C site would have seen the same ink mean
 * the opposite thing an inch apart.
 *
 * The four letters sit at hues 4 (T), 37 (G), 132 (A) and 211 (C), and the
 * widest gap between them is the 153 degrees from C back round to T. Magenta at
 * 300 is inside it, 64 degrees from its nearest neighbour — so it reads as this
 * application's ink without being any of the letters. `track-variants.test.ts`
 * pins it as a distance rather than as a string, because the fault was never
 * that the constant was wrong: it was that nobody compared it to the palette.
 */
export const VARIANT_COLOUR = '#9b3f9b'

function drawVariants(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  profile: PixelProfile,
  norm: (value: number) => number,
  baseAcross: number,
  paint: TrackPaint,
): void {
  const variant = profile.variant
  if (variant === null) return
  ctx.save()
  ctx.globalAlpha = paint.opacity
  ctx.fillStyle = VARIANT_COLOUR
  ctx.beginPath()
  for (let slot = 0; slot < variant.length; slot++) {
    const differing = variant[slot]
    const depth = profile.mean[slot]
    if (!Number.isFinite(differing) || !Number.isFinite(depth) || depth <= 0) continue
    if (differing / depth < VARIANT_LEAST) continue
    const along = profile.from + slot
    const across = valueAcross(frame, norm(differing))
    const [x, y, width, height] = laneRect(frame, along, along + 1, baseAcross, across)
    ctx.rect(x, y, width, height)
  }
  ctx.fill()
  ctx.restore()
}

/**
 * The half-open slot ranges where **both** profiles have data.
 *
 * A ribbon's band exists where its own curve and the one under it both do; a
 * slot either of them is missing is a hole in the band. Written as its own walk
 * rather than as an intersection of two {@link pathRuns} results, because the
 * merge of two run lists is the kind of thing that is right until the day one
 * of them starts with a gap.
 */
function sharedRuns(a: PixelProfile, b: PixelProfile): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  const slots = Math.min(a.mean.length, b.mean.length)
  let start = -1
  for (let slot = 0; slot < slots; slot++) {
    const present = !Number.isNaN(a.mean[slot]) && !Number.isNaN(b.mean[slot])
    if (present && start < 0) start = slot
    if (!present && start >= 0) {
      runs.push([start, slot])
      start = -1
    }
  }
  if (start >= 0) runs.push([start, slots])
  return runs
}

/** {@link tracePath} in reverse, for the returning half of a closed band. */
function traceBack(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  profile: PixelProfile,
  norm: (value: number) => number,
  start: number,
  stop: number,
): void {
  for (let slot = stop - 1; slot >= start; slot--) {
    const across = valueAcross(frame, norm(profile.mean[slot]))
    ctx.lineTo(...pointOf(frame, profile.from + slot + 0.5, across))
  }
}

/**
 * How big a `points` lane's dot is, in CSS pixels: three across, which reads
 * as a mark at every lane height a track can be given and lets a dot per pixel
 * overlap its neighbours into a band where the values are steady.
 */
export const POINT_RADIUS = 1.5

/**
 * The half-open slot ranges over which the mean holds one value — a dot each.
 *
 * Exact equality, because a run of pixels inside one bin carries the bin's
 * value bit for bit, and two neighbouring pixels that merely round alike are
 * two values. A gap ends a run and starts none.
 */
export function valueRuns(profile: PixelProfile): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  const mean = profile.mean
  let start = -1
  for (let slot = 0; slot < mean.length; slot++) {
    const value = mean[slot]
    if (start >= 0 && value === mean[start]) continue
    if (start >= 0) runs.push([start, slot])
    start = Number.isFinite(value) ? slot : -1
  }
  if (start >= 0) runs.push([start, mean.length])
  return runs
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

/**
 * One point of the trace, in canvas coordinates.
 *
 * Through the shared helpers rather than inlined, which it was: an inlined copy
 * of the axis mapping is a second place for it to be right, and the day a third
 * edge existed the copy drew every profile on it sideways.
 */
function pointOf(frame: LaneFrame, along: number, across: number): [number, number] {
  return [laneX(frame, along, across), laneY(frame, along, across)]
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
  // Where a value of zero lands, which is the edge of the strip the fill grows
  // from — asked of `valueAcross` rather than written out, so the floor rule and
  // the fill cannot come to disagree about which end of the lane that is.
  const across = valueAcross(frame, 0)
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
 *
 * **Three significant figures, whole numbers past a hundred** — and the first
 * half of that used to be the docstring rather than the code, which wrote two
 * *decimal* places below a hundred and so put four figures on a lane (`0 – 86.86`)
 * beside three on the one under it (`0 – 111`). Two decimals on a lane sixteen
 * pixels tall are ink a reader cannot use, and a precision that jumps as the
 * ceiling crosses a hundred reads as two different instruments. Past a hundred
 * the figure is whole, because a ceiling of `1,599` is not a measurement to a
 * tenth.
 */
export function formatLimit(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(1)
  if (magnitude >= 100) return value.toFixed(0)
  return String(Number(value.toPrecision(3)))
}

/**
 * The one note a lane can show, or `null` when it should show its range instead.
 *
 * Only where **every** member is refused. A note is set where a profile drew
 * nothing (§8.13), and a lane holds one profile or an overlay group of them —
 * so reading it off the first member alone would let one refused alignment lane
 * take the value range away from the bigWig overlaid with it, which is drawing
 * fine and is the thing the reader is looking at.
 *
 * The first note rather than a joined list, for the same reason it is kept
 * short: it is drawn in the name column's gutter, and two sentences there widen
 * that column for every lane in the stack.
 */
export function laneNote(
  profiles: ReadonlyArray<{ profile: PixelProfile }>,
): { kind: 'text'; text: string } | null {
  if (profiles.length === 0) return null
  const notes = profiles.map((row) => row.profile.note)
  if (notes.some((note) => note === undefined)) return null
  return { kind: 'text', text: notes[0] as string }
}

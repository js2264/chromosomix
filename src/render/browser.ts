/**
 * The 1D browser's furniture: the ruler, the sequence bands, the hairline.
 *
 * The tracks themselves are drawn by `render/tracks.ts` and `render/features.ts`
 * — the same two modules that draw the lanes beside a heatmap, through the same
 * {@link LaneFrame}. Nothing here is a second renderer; what is here is the part
 * a heatmap does not need, because beside a map the coordinates are already on
 * the map's own axes.
 *
 * The ruler answers two questions and switches between them, because at a
 * genome browser's two extremes they are different questions. Zoomed out across
 * several sequences, *which sequence am I over* is the only one worth answering
 * and base pairs are noise; inside one sequence, the name is a constant and the
 * position is everything. So the ruler draws bands when the view spans more than
 * one sequence and a scale when it does not, and nothing in between tries to do
 * both at once.
 */

import { chooseBpStep, formatBpTick } from './heatmap'
import type { LocusAxis } from './locus'
import type { Scale } from './scale'

/**
 * How tall the ruler is, in CSS pixels: the sequence band, then the coordinates.
 *
 * The band is most of it. It is the one part of a genome browser a hand goes to
 * without being told — to see which chromosome is which, to drag out a region,
 * to click a name and go there — and at sixteen pixels it was a stripe of
 * shading with a caption, too thin to read as a control and too thin to aim at.
 */
export const BAND_HEIGHT = 48

/** The coordinate row under the band: one line of ticks and their labels. */
export const SCALE_ROW = 18

/**
 * How tall the ruler is at a given text scale.
 *
 * The band's height is a *target*: it is sized for a hand rather than for the
 * name in it, and a name that outgrows it is dropped rather than clipped (see
 * below). The scale row is nothing but its own line of text, so it grows with
 * the text or the labels fall out of the bottom of it.
 */
export function rulerHeightFor(scale = 1): number {
  return BAND_HEIGHT + Math.round(SCALE_ROW * scale)
}

export const RULER_HEIGHT = rulerHeightFor(1)

export interface RulerPalette {
  text: string
  faint: string
  line: string
  /** The sequence boundaries carried down through the tracks. */
  divider: string
  band: string
  halo: string
}

export interface RulerFrame {
  /** Left edge of the drawable area, in canvas pixels. */
  x: number
  /** Top edge — the ruler occupies `[y, y + height)`. */
  y: number
  width: number
  /**
   * How tall the ruler is, from {@link rulerHeightFor} at the text scale in
   * force. Absent means the unscaled {@link RULER_HEIGHT}.
   *
   * It is what the clip is taken against, and that is the whole of why it is a
   * field rather than the constant. The scale row grows with the text — that is
   * what {@link rulerHeightFor} is for, and both callers already size their
   * canvas by it — while the clip did not, so at any scale above 1 the ruler was
   * drawn into a box shorter than the one it had been given and the coordinate
   * labels were shaved off along the bottom. The default text scale is 1.35, so
   * this was every reader who had never touched the control.
   */
  height?: number
  /** Genome-wide unit → canvas pixel. */
  toPixel(unit: number): number
  axis: LocusAxis
  domain: readonly [number, number]
  palette: RulerPalette
  dpr: number
  /**
   * The two sizes the ruler writes at, or absent for its own.
   *
   * Passed in rather than chosen here, exactly as `render/laneLabel.ts` takes
   * its style: the app scales every canvas font together and this module has no
   * business reading that preference, but it must be able to be told.
   */
  fonts?: { ruler: string; tick: string }
}

/** One sequence's stretch of the ruler, for hit-testing a click on its name. */
export interface RulerBand {
  contig: string
  from: number
  to: number
  /**
   * The box its name was drawn in, or `null` where there was no room for one.
   *
   * Reported rather than recomputed, because it is the box the *text* was
   * measured into: a second measurement is a second opinion about the same
   * font, and the difference between the two is the pixel a click misses by.
   * A band with no name is still a band — it can be dragged across and clicked
   * on — it simply has no smaller target inside it.
   */
  label: { x0: number; x1: number; y0: number; y1: number } | null
}

/**
 * Draw the ruler, and report the sequence bands it drew.
 *
 * The bands come back because they are click targets: clicking a sequence's name
 * goes to that sequence, which is how a whole-genome view is navigated and the
 * only affordance that does not require typing a name.
 */
export function drawRuler(ctx: CanvasRenderingContext2D, frame: RulerFrame): RulerBand[] {
  const { x, y, width, palette } = frame
  // Kept with their index in the *assembly*, because that is what decides which
  // of them is shaded: parity taken over the visible ones instead inverts every
  // band on screen the moment a sequence leaves the left edge, which during a
  // drag is a flicker with no change in the data behind it.
  const segments = frame.axis.segments
    .map((segment, index) => ({ segment, index }))
    .filter(
      ({ segment }) => segment.unitEnd > frame.domain[0] && segment.unitStart < frame.domain[1],
    )
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, width, frame.height ?? RULER_HEIGHT)
  ctx.clip()

  const bands: RulerBand[] = []
  for (const { segment, index } of segments) {
    const from = frame.toPixel(Math.max(segment.unitStart, frame.domain[0]))
    const to = frame.toPixel(Math.min(segment.unitEnd, frame.domain[1]))
    bands.push({ contig: segment.contig, from, to, label: null })
    // Alternating shading rather than a line between sequences: at whole-genome
    // zoom the lines are three pixels apart on a 4,000-contig metagenome and
    // read as a texture, while alternating blocks stay legible at any density.
    if (index % 2 === 1) {
      ctx.fillStyle = palette.band
      ctx.fillRect(from, y, Math.max(1, to - from), BAND_HEIGHT)
    }
  }

  // The names, where there is room for them. A name that does not fit its own
  // band is dropped rather than clipped or shrunk: a row of half-names is
  // unreadable in a way an empty band is not, and the readout under the pointer
  // answers "which one is this" at any density.
  ctx.font = frame.fonts?.ruler ?? RULER_FONT
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = palette.text
  for (const band of bands) {
    const room = band.to - band.from
    const text = ctx.measureText(band.contig).width
    if (text + 6 > room) continue
    const middle = (band.from + band.to) / 2
    const centre = y + BAND_HEIGHT / 2
    ctx.fillText(band.contig, middle, centre)
    // Padded into a target rather than left as the glyphs' own box: a name is
    // four pixels of ink and the thing being aimed at is a chromosome.
    band.label = {
      x0: middle - text / 2 - 6,
      x1: middle + text / 2 + 6,
      y0: centre - 11,
      y1: centre + 11,
    }
  }

  drawScale(ctx, frame, segments.length === 1)
  ctx.restore()
  return bands
}

export const RULER_FONT = '600 13px system-ui, sans-serif'
export const TICK_FONT = '10px system-ui, sans-serif'

/**
 * The coordinate row.
 *
 * Inside one sequence the ticks are that sequence's own base pairs, chosen by
 * the same rule the heatmap's axes use so the two never disagree about what a
 * round number is. Across several, the only positions that mean anything to a
 * reader are the sequence boundaries, so those are what is drawn — with the
 * cumulative span written at the ends, because "how much genome is on screen" is
 * the question a zoomed-out browser is actually being asked.
 */
function drawScale(ctx: CanvasRenderingContext2D, frame: RulerFrame, single: boolean): void {
  const { x, y, width, palette } = frame
  const top = y + BAND_HEIGHT
  ctx.strokeStyle = palette.line
  ctx.lineWidth = 1 / frame.dpr
  ctx.beginPath()
  ctx.moveTo(x, snap(top, frame.dpr))
  ctx.lineTo(x + width, snap(top, frame.dpr))
  ctx.stroke()

  ctx.font = frame.fonts?.tick ?? TICK_FONT
  ctx.textBaseline = 'top'
  ctx.fillStyle = palette.faint

  if (!single) {
    // Sequence boundaries, as short marks. No labels: the band above already
    // names what each boundary separates, and a base-pair position that resets
    // at every one of them is a column of zeros.
    ctx.textAlign = 'left'
    ctx.beginPath()
    for (const segment of frame.axis.segments) {
      if (segment.unitStart <= frame.domain[0] || segment.unitStart >= frame.domain[1]) continue
      const at = snap(frame.toPixel(segment.unitStart), frame.dpr)
      ctx.moveTo(at, top)
      ctx.lineTo(at, top + 4)
    }
    ctx.stroke()
    const span = frame.domain[1] - frame.domain[0]
    ctx.fillText(`${formatBpTick(0)} — ${formatBpTick(span)} across ${countOf(frame)}`, x + 3, top + 5)
    return
  }

  const segment = frame.axis.segments.find(
    (candidate) => candidate.unitEnd > frame.domain[0] && candidate.unitStart < frame.domain[1],
  )
  if (segment === undefined) return
  const from = Math.max(frame.domain[0], segment.unitStart) - segment.unitStart
  const to = Math.min(frame.domain[1], segment.unitEnd) - segment.unitStart
  const step = chooseBpStep(to - from, MAX_RULER_TICKS)
  if (!(step > 0)) return

  ctx.textAlign = 'center'
  ctx.beginPath()
  for (let bp = Math.ceil(from / step) * step; bp <= to; bp += step) {
    const at = snap(frame.toPixel(segment.unitStart + bp), frame.dpr)
    ctx.moveTo(at, top)
    ctx.lineTo(at, top + 4)
  }
  ctx.stroke()
  for (let bp = Math.ceil(from / step) * step; bp <= to; bp += step) {
    // The step goes with it: two decimals of a megabase is ten kilobases, so
    // without it every tick of a twenty-kilobase window on a 4.6 Mb chromosome
    // read `4.60 Mb` — a row of identical numbers under a picture zoomed in to
    // answer exactly the question they were there to answer.
    ctx.fillText(formatBpTick(bp, step), frame.toPixel(segment.unitStart + bp), top + 5)
  }
}

/** As many ticks as 11 px labels fit without touching at a usual window width. */
const MAX_RULER_TICKS = 10

function countOf(frame: RulerFrame): string {
  const n = frame.axis.segments.filter(
    (segment) => segment.unitEnd > frame.domain[0] && segment.unitStart < frame.domain[1],
  ).length
  return `${n} sequence${n === 1 ? '' : 's'}`
}

/**
 * Put a hairline on the device-pixel grid.
 *
 * The same rule the heatmap's separators and the lanes' hairlines follow: a
 * one-pixel rule on a fractional coordinate is antialiased across two pixels and
 * reads as a real feature twice as wide as it is.
 */
export function snap(value: number, dpr: number): number {
  return (Math.round(value * dpr - 0.5) + 0.5) / dpr
}

/** The vertical line under the pointer, through the ruler and every lane. */
export function drawGuide(
  ctx: CanvasRenderingContext2D,
  at: number,
  top: number,
  bottom: number,
  colour: string,
  dpr: number,
): void {
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = Math.max(1 / dpr, 0.75)
  ctx.globalAlpha = 0.8
  ctx.beginPath()
  const x = snap(at, dpr)
  ctx.moveTo(x, top)
  ctx.lineTo(x, bottom)
  ctx.stroke()
  ctx.restore()
}

/** Tip to base, and half the base, of an {@link drawAnchor} triangle. */
export const ANCHOR_LENGTH = 7
export const ANCHOR_HALF = 4

/**
 * One end of a hand-drawn mark, as a small triangle pointing into the tracks.
 *
 * The 1D twin of the anchor `AnnotationLanes` puts in the band past the last
 * lane beside a map, and deliberately the same glyph at the same size: it is the
 * same statement — *this coordinate*, made by a mark whose other end is
 * somewhere else — and a reader who has met it on one surface has met it on
 * both. What differs is only which way "into the picture" points. Beside a map
 * the tracks are between the reader and the matrix, so the triangle points back
 * at the matrix; here the picture *is* the tracks, so it hangs from the foot of
 * the ruler and points down into them.
 *
 * Drawn without an outline for the reason the lanes' is: it sits in the strip
 * between the coordinates and the data, where there is no track ink to be lost
 * against and none of the picture to take.
 */
export function drawAnchor(
  ctx: CanvasRenderingContext2D,
  at: number,
  top: number,
  colour: string,
): void {
  ctx.save()
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.moveTo(at, top + ANCHOR_LENGTH)
  ctx.lineTo(at - ANCHOR_HALF, top)
  ctx.lineTo(at + ANCHOR_HALF, top)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * What a range being dragged out looks like, in one place.
 *
 * The wash, the two edge hairlines and the three chips — the anchor's
 * coordinate, the moving end's, and the span between them — as drawn over the
 * 1D browser's ruler and, since the Chromosomes table grew the same bar, over
 * that one too. Extracted rather than copied, because the thing being promised
 * is that the two *look the same*: a reader who has learned to aim by the chips
 * in one view has learned it for the other, and two implementations of that
 * would drift on the first change to either.
 *
 * The **text arrives formatted**. Placing a chip is geometry and belongs here;
 * deciding that a coordinate reads `chr1:59,621,870` and a span reads `388.6 kb`
 * is `ui/dom.ts`'s `fmt`, and nothing under `render/` imports from `ui/`. The
 * two callers also differ on the base — the browser writes 1-based inclusive
 * loci because that is what its own box takes — which is exactly the kind of
 * decision a renderer should not be making.
 */
export interface SelectionMarks {
  /** The end that does not move, in CSS pixels across the canvas. */
  anchor: number
  /** The end under the pointer. */
  moving: number
  /** The anchor's position, written out: `chr1:59,621,870`. */
  start: string
  /** The moving end's, the same way. */
  end: string
  /** What lies between them: `388.6 kb`. */
  span: string
  /** Where the two edge hairlines run from and to. */
  top: number
  bottom: number
  /** The first chip row's top edge. The span sits on a second row under it. */
  chipTop: number
  /** The whole canvas, so a chip at an edge folds back inside it. */
  width: number
  dpr: number
  chipHeight: number
  chipPad: number
  font: string
  /** The hairlines, the chip borders and the text: the crosshair colour. */
  colour: string
  /** What a chip is filled with, so what is under it does not show through. */
  halo: string
}

/**
 * Draw it.
 *
 * Each chip goes *outside* its own edge where there is room, so the two numbers
 * never sit on top of the region they are measuring, and folds back inside at
 * the canvas edges — a coordinate written off the side of the canvas is a
 * coordinate nobody can read, and the edges are exactly where a selection is
 * dragged to. The span goes in the middle of what has been drawn, where the eye
 * already is, and is dropped when the band is too narrow to hold it.
 */
export function drawSelection(ctx: CanvasRenderingContext2D, marks: SelectionMarks): void {
  const { anchor, moving, chipHeight, chipPad } = marks
  ctx.save()
  ctx.font = marks.font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  // Both edges as hairlines, so the numbers have something exact to belong to.
  ctx.strokeStyle = marks.colour
  ctx.lineWidth = 1
  for (const x of [anchor, moving]) {
    ctx.beginPath()
    ctx.moveTo(snap(x, marks.dpr), marks.top)
    ctx.lineTo(snap(x, marks.dpr), marks.bottom)
    ctx.stroke()
  }

  const chip = (text: string, x: number, side: 'left' | 'right', top: number): void => {
    const width = ctx.measureText(text).width + chipPad * 2
    let left = side === 'left' ? x - width - 3 : x + 3
    if (left < 0) left = x + 3
    if (left + width > marks.width) left = x - width - 3
    ctx.fillStyle = marks.halo
    ctx.strokeStyle = marks.colour
    ctx.lineWidth = 1
    ctx.beginPath()
    if (ctx.roundRect === undefined) ctx.rect(left, top, width, chipHeight)
    else ctx.roundRect(left, top, width, chipHeight, 3)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = marks.colour
    ctx.fillText(text, left + chipPad, top + chipHeight / 2)
  }

  const backwards = moving < anchor
  chip(marks.start, anchor, backwards ? 'right' : 'left', marks.chipTop)
  chip(marks.end, moving, backwards ? 'left' : 'right', marks.chipTop)
  const middle = (anchor + moving) / 2
  const width = ctx.measureText(marks.span).width + chipPad * 2
  if (Math.abs(moving - anchor) > width + 8) {
    chip(marks.span, middle - width / 2 - 3, 'right', marks.chipTop + chipHeight + 3)
  }
  ctx.restore()
}

/**
 * Sequence boundaries, continued down through the tracks.
 *
 * Without them a whole-genome view is one continuous profile and a reader cannot
 * see where one chromosome ends — which is exactly the mistake that makes a
 * telomere look like a peak.
 */
export function drawBoundaries(
  ctx: CanvasRenderingContext2D,
  frame: RulerFrame,
  top: number,
  bottom: number,
): void {
  const marks: number[] = []
  for (const segment of frame.axis.segments) {
    if (segment.unitStart <= frame.domain[0] || segment.unitStart >= frame.domain[1]) continue
    marks.push(frame.toPixel(segment.unitStart))
  }
  // A boundary every few pixels is a grey wash rather than a set of divisions —
  // the same judgement the heatmap's separators make above their own density
  // limit. Better to draw none than to fill the picture with them.
  if (marks.length === 0 || marks.length > frame.width / 3) return
  ctx.save()
  // Solid, and in the strong border colour. These are the one thing a
  // whole-genome profile cannot be read without: a continuous line across
  // sixteen chromosomes is one chromosome to the eye, and a telomere then looks
  // like a peak.
  ctx.strokeStyle = frame.palette.divider
  ctx.lineWidth = 1 / frame.dpr
  ctx.beginPath()
  for (const at of marks) {
    const x = snap(at, frame.dpr)
    ctx.moveTo(x, top)
    ctx.lineTo(x, bottom)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * Loop calls, as arcs.
 *
 * The picture a 1D browser draws for a pair of loci, and the reason a BEDPE is
 * worth having here at all: an arc joining two anchors says *these two places
 * touch* in one glyph, at any zoom, without needing the second dimension a
 * contact map spends on saying the same thing.
 *
 * Height is the log of the span rather than the span itself, so a 2 kb loop and
 * a 2 Mb one in the same view are both visible — linear height would flatten
 * every short-range call onto the baseline beside one long-range one. Capped at
 * the lane, because an arc taller than its lane is a vertical line.
 *
 * A pair with both ends off screen is skipped; a pair with *one* end off screen
 * is drawn, because the arc leaving the view is exactly the information that
 * something over there is connected to something here.
 */
export function drawArcs(
  ctx: CanvasRenderingContext2D,
  frame: {
    toPixel(unit: number): number
    domain: readonly [number, number]
    alongFrom: number
    alongTo: number
    acrossFrom: number
    thickness: number
  },
  axis: LocusAxis,
  pairs: {
    length: number
    contigs: string[]
    contig1: Int32Array
    start1: Int32Array
    end1: Int32Array
    contig2: Int32Array
    start2: Int32Array
    end2: Int32Array
  },
  paint: { colour: string; opacity: number },
): number {
  ctx.save()
  ctx.strokeStyle = paint.colour
  ctx.globalAlpha = paint.opacity * 0.75
  ctx.lineWidth = 1.25
  const floor = frame.acrossFrom + frame.thickness
  const span = Math.max(1, frame.domain[1] - frame.domain[0])
  let drawn = 0
  for (let i = 0; i < pairs.length; i++) {
    const a = axis.locusToUnit(pairs.contigs[pairs.contig1[i]], (pairs.start1[i] + pairs.end1[i]) / 2)
    const b = axis.locusToUnit(pairs.contigs[pairs.contig2[i]], (pairs.start2[i] + pairs.end2[i]) / 2)
    if (a === null || b === null) continue
    const low = Math.min(a, b)
    const high = Math.max(a, b)
    if (high < frame.domain[0] || low > frame.domain[1]) continue
    const x0 = frame.toPixel(low)
    const x1 = frame.toPixel(high)
    // `log` of the fraction of the view the arc spans, mapped into the lane. A
    // loop spanning the whole view reaches the top; one spanning a thousandth of
    // it still reaches a third of the way.
    const fraction = Math.min(1, (high - low) / span)
    const height = frame.thickness * Math.min(1, 0.2 + 0.8 * (1 + Math.log10(Math.max(1e-4, fraction)) / 4))
    ctx.beginPath()
    ctx.moveTo(x0, floor)
    // A quadratic through a control point at twice the apex: the curve passes
    // through half of it, which puts the top of the arc where `height` says.
    ctx.quadraticCurveTo((x0 + x1) / 2, floor - height * 2, x1, floor)
    ctx.stroke()
    drawn++
  }
  ctx.restore()
  return drawn
}

/**
 * The zoom the browser is at, as bases per pixel.
 *
 * Reported rather than derived twice: the locus bar states it, the tracks are
 * fetched at it, and a picture whose caption disagreed with its data would be
 * the one bug this number exists to prevent.
 */
export function basesPerPixel(scale: Scale): number {
  return scale.unitsPerPixel
}

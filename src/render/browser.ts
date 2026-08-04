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

/** How tall the ruler is, in CSS pixels. Two rows of 12 px text and its ticks. */
export const RULER_HEIGHT = 34

export interface RulerPalette {
  text: string
  faint: string
  line: string
  band: string
  halo: string
}

export interface RulerFrame {
  /** Left edge of the drawable area, in canvas pixels. */
  x: number
  /** Top edge — the ruler occupies `[y, y + RULER_HEIGHT)`. */
  y: number
  width: number
  /** Genome-wide unit → canvas pixel. */
  toPixel(unit: number): number
  axis: LocusAxis
  domain: readonly [number, number]
  palette: RulerPalette
  dpr: number
}

/** One sequence's stretch of the ruler, for hit-testing a click on its name. */
export interface RulerBand {
  contig: string
  from: number
  to: number
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
  const segments = frame.axis.segments.filter(
    (segment) => segment.unitEnd > frame.domain[0] && segment.unitStart < frame.domain[1],
  )
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, width, RULER_HEIGHT)
  ctx.clip()

  const bands: RulerBand[] = []
  let alternate = false
  for (const segment of segments) {
    const from = frame.toPixel(Math.max(segment.unitStart, frame.domain[0]))
    const to = frame.toPixel(Math.min(segment.unitEnd, frame.domain[1]))
    bands.push({ contig: segment.contig, from, to })
    // Alternating shading rather than a line between sequences: at whole-genome
    // zoom the lines are three pixels apart on a 4,000-contig metagenome and
    // read as a texture, while alternating blocks stay legible at any density.
    if (alternate) {
      ctx.fillStyle = palette.band
      ctx.fillRect(from, y, Math.max(1, to - from), BAND_HEIGHT)
    }
    alternate = !alternate
  }

  // The names, where there is room for them. A name that does not fit its own
  // band is dropped rather than clipped or shrunk: a row of half-names is
  // unreadable in a way an empty band is not, and the readout under the pointer
  // answers "which one is this" at any density.
  ctx.font = RULER_FONT
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = palette.text
  for (const band of bands) {
    const room = band.to - band.from
    const text = ctx.measureText(band.contig).width
    if (text + 6 > room) continue
    ctx.fillText(band.contig, (band.from + band.to) / 2, y + BAND_HEIGHT / 2)
  }

  drawScale(ctx, frame, segments.length === 1)
  ctx.restore()
  return bands
}

/** The band row's height; the scale row takes what is left. */
const BAND_HEIGHT = 16
const RULER_FONT = '11px system-ui, sans-serif'
const TICK_FONT = '10px system-ui, sans-serif'

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

  ctx.font = TICK_FONT
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
    ctx.fillText(formatBpTick(bp), frame.toPixel(segment.unitStart + bp), top + 5)
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
  if (marks.length === 0 || marks.length > frame.width / 6) return
  ctx.save()
  ctx.strokeStyle = frame.palette.line
  ctx.globalAlpha = 0.5
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

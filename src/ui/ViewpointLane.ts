/**
 * The 4C lane: a strip above the map, showing what the anchor touches.
 *
 * Its own canvas rather than a band of the heatmap's, for the reason the
 * annotation stacks have theirs: the map's canvas is sized by the picture and
 * this is *beside* the picture, so sharing one would mean the plot rect changing
 * whenever the lane appeared — and a plot rect that moves takes every cached
 * layout, every hit test and the tooltip's arithmetic with it.
 *
 * Aligned by construction and not by arrangement. The canvas is exactly as wide
 * as the map's, and everything in it is placed through the map's own column
 * `Scale` — so a peak sits over the column it came from because the two are the
 * same transform, not because a number was matched in two places (§8.4).
 *
 * The lane draws through {@link drawTrack}, which is what makes it look like the
 * tracks beside it: it is one. The profile is a `PixelProfile` exactly as a
 * bigWig's is, and the fill, the outline, the floor and the value axis are the
 * annotation lanes' own, from the same options store.
 */

import { columnSums, profileFromSums } from '../render/viewpoint'
import { drawTrack } from '../render/tracks'
import type { LaneFrame } from '../render/lane'
import type { Scale } from '../render/scale'
import type { Rect } from '../render/heatmap'
import type { DenseMatrix } from '../types'
import { el, fmt } from './dom'
import { getPlotOptions } from './plotOptions'
import { scaleFont, scaleLength } from './textScale'
import { getViewpoint, viewpointLabel, type Viewpoint } from './viewpoint'

/** How tall the strip is, before the text scale has its say. */
export const VIEWPOINT_HEIGHT = 68

/** The colour the profile is drawn in, when nothing else has been chosen. */
const VIEWPOINT_COLOUR = '#0072b2'

const LANE_FONT = '600 9px system-ui, sans-serif'

/** What the lane needs from the map on the frame it is drawn. */
export interface ViewpointFrame {
  /** The map's plot rectangle — where the *data* starts and stops across. */
  data: Rect
  /** The map's own column scale; the lane is drawn through it, not beside it. */
  colScale: Scale
  /** Canvas width to match, in CSS pixels. */
  cssWidth: number
  /** The block on screen, or `null` while one is being read. */
  matrix: DenseMatrix | null
  /** The anchor as block-local rows, or `null` when it is off this block. */
  rows: [number, number] | null
  palette: { label: string; halo: string; line: string }
}

export class ViewpointLane {
  readonly el: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private dpr = 1
  /** The last profile drawn, so the readout can be asked what is under a pixel. */
  private lastSums: Float64Array | null = null

  constructor() {
    this.el = el('canvas', { class: 'viewpoint-canvas' })
    this.ctx = this.el.getContext('2d')
  }

  /** How tall the strip is right now — it grows with the text on it. */
  get height(): number {
    return scaleLength(VIEWPOINT_HEIGHT)
  }

  /** The sums behind the last paint, for a readout that wants a number. */
  get sums(): Float64Array | null {
    return this.lastSums
  }

  /**
   * Redraw. Cheap enough to call from the map's own frame: the sum is one pass
   * over the anchor's rows of a block that is already in memory, and the anchor
   * is usually a handful of them.
   */
  draw(frame: ViewpointFrame, dpr: number): void {
    const ctx = this.ctx
    if (ctx === null) return
    const height = this.height
    this.resize(frame.cssWidth, height, dpr)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, frame.cssWidth, height)

    const state = getViewpoint()
    if (state.anchor === null || frame.rows === null || frame.matrix === null) {
      this.lastSums = null
      this.drawPrompt(ctx, frame, height, state.anchor)
      return
    }

    const sums = columnSums(frame.matrix, frame.rows)
    this.lastSums = sums
    const lane = this.frameOf(frame, height)
    const profile = profileFromSums(sums, lane)
    const plot = getPlotOptions()
    drawTrack(ctx, lane, profile, {
      colour: VIEWPOINT_COLOUR,
      mode: 'area',
      limits: profile.extent ?? { min: 0, max: 1 },
      opacity: 1,
      fills: plot.fills,
      outline: plot.outline,
      baseline: plot.baseline,
      flip: false,
      guideColour: frame.palette.label,
      haloColour: frame.palette.halo,
      font: scaleFont(LANE_FONT),
    })
    if (plot.text) this.drawLabel(ctx, frame, state.anchor, profile.extent?.max ?? 0)
  }

  /**
   * The lane's geometry, from the map's.
   *
   * `orientation: 'bottom'` although the lane is *above* the map, and that is
   * not a mistake: the word names which way the values grow, and a lane that
   * grows upward from a floor is what this is. Its floor sits against the map,
   * so the profile rises away from the picture it summarises — the same
   * arrangement a coverage track has under a browser.
   */
  private frameOf(frame: ViewpointFrame, height: number): LaneFrame {
    const data = frame.data
    return {
      orientation: 'bottom',
      toPixel: (unit) => data.x + frame.colScale.toPixel(unit),
      toUnit: (pixel) => frame.colScale.toUnit(pixel - data.x),
      domain: frame.colScale.domain,
      alongFrom: data.x,
      alongTo: data.x + data.width,
      acrossFrom: 0,
      thickness: height,
    }
  }

  /**
   * What the lane says before it has anything to draw.
   *
   * The lane is shown *and empty* on purpose: a control that turned on and drew
   * nothing would look broken, and the gesture that fills it is one nobody
   * guesses. So the empty state is where the instruction lives — the only place
   * a reader is certainly looking at the moment they need it.
   *
   * A second message covers the case the first cannot: an anchor exists but is
   * not on this block, because the reader has panned away from it or opened
   * another region. Saying so beats an empty box that looks like the first one
   * and means something else entirely.
   */
  private drawPrompt(
    ctx: CanvasRenderingContext2D,
    frame: ViewpointFrame,
    height: number,
    anchor: Viewpoint | null,
  ): void {
    const data = frame.data
    ctx.save()
    ctx.strokeStyle = frame.palette.line
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(data.x + 0.5, 0.5, Math.max(1, data.width - 1), height - 1)
    ctx.setLineDash([])
    ctx.font = scaleFont(LANE_FONT)
    ctx.fillStyle = frame.palette.label
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      anchor === null
        ? 'Press Shift + drag on the map to define an anchor region'
        : `${viewpointLabel(anchor, fmt.int)} is not in this view`,
      data.x + data.width / 2,
      height / 2,
      Math.max(40, data.width - 12),
    )
    ctx.restore()
  }

  /** The anchor's locus and the line's ceiling, as a lane label. */
  private drawLabel(
    ctx: CanvasRenderingContext2D,
    frame: ViewpointFrame,
    anchor: Viewpoint,
    max: number,
  ): void {
    const pad = scaleLength(3)
    ctx.save()
    ctx.font = scaleFont(LANE_FONT)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const text = `4C · ${viewpointLabel(anchor, fmt.int)}`
    // Haloed rather than boxed, exactly as a lane's own name is: the line can
    // reach the top of the strip, and a label with no halo would be read through.
    ctx.lineWidth = scaleLength(3)
    ctx.strokeStyle = frame.palette.halo
    ctx.strokeText(text, frame.data.x + pad, pad)
    ctx.fillStyle = frame.palette.label
    ctx.fillText(text, frame.data.x + pad, pad)
    const ceiling = `0 – ${fmt.num(max)}`
    ctx.strokeText(ceiling, frame.data.x + pad, pad + scaleLength(11))
    ctx.fillText(ceiling, frame.data.x + pad, pad + scaleLength(11))
    ctx.restore()
  }

  private resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr
    const width = Math.max(1, Math.round(cssWidth * dpr))
    const height = Math.max(1, Math.round(cssHeight * dpr))
    this.el.style.width = `${cssWidth}px`
    this.el.style.height = `${cssHeight}px`
    if (this.el.width === width && this.el.height === height) return
    this.el.width = width
    this.el.height = height
  }
}

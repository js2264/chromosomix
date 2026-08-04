/**
 * The strips of annotation beside the matrix, and everything that keeps them in
 * step with it.
 *
 * One canvas per edge, holding every lane on that edge stacked. Each canvas is
 * exactly as long as the heatmap's own canvas and drawn in the same coordinates,
 * so a column of the map and the pixel under it are the same pixel — not
 * because anything checks, but because both are drawn through the same `Scale`
 * at the same offset (spec §8.4).
 *
 * **Pan and zoom perform no I/O**, which is §2's rule for the matrix and has to
 * be the rule here too, or dragging a whole-genome view would be a burst of
 * range requests per frame. A track fetches a window half again as wide as what
 * is on screen, at a resolution rounded to a power of two, and keeps it; a pan
 * inside that window and a zoom inside that power of two redraw from the cache.
 * When a fetch *is* needed the previous data stays on screen until the new data
 * lands, so a lane never blinks.
 */

import { SampleCache } from '../annotations/samples'
import type { AnnotationClient } from '../annotations/worker/client'
import { featureAt, drawGenes, drawSegments, layoutFeatures, rowsThatFit, type FeatureLayout } from '../render/features'
import { clipLane, laneText, type LaneFrame } from '../render/lane'
import type { LocusAxis } from '../render/locus'
import type { Rect } from '../render/heatmap'
import type { Scale } from '../render/scale'
import { drawTrack, formatLimit, profileOf, resolveLimits, type PixelProfile } from '../render/tracks'
import type { ManualStore } from '../annotations/manual'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry, TrackSampleSet } from '../annotations/types'
import { el, fmt } from './dom'
import { getPlotOptions } from './plotOptions'

/** Which edge a lane stack is on. `bottom` follows columns, `right` follows rows. */
export type LaneEdge = 'bottom' | 'right'

/** Everything the stacks need from the heatmap on the frame they are drawn. */
export interface LaneGeometry {
  plot: Rect
  data: Rect
  colScale: Scale
  rowScale: Scale
  /** The heatmap canvas's CSS size, which the lane canvases match on one axis. */
  cssWidth: number
  cssHeight: number
  /** The cell under the pointer, for the crosshair. */
  hover: { row: number; col: number } | null
  crosshair: boolean
  /**
   * A pointer over one of the lane stacks, in that stack's own canvas pixels
   * along the shared axis.
   *
   * Distinct from {@link hover}, which is a *cell* of the matrix and arrives
   * only while the pointer is on the map. This is the position being pointed at
   * from beside it, and it is what the hairline is drawn through.
   */
  guide: { edge: LaneEdge; along: number } | null
  palette: { guide: string; halo: string; crosshair: string }
}

/**
 * What the pointer over a lane stack resolves to.
 *
 * Every value track on that edge, not only the lane under the pointer: the
 * question a stack of tracks is there to answer is "what do all of these do
 * here", and answering it one lane at a time means moving the pointer between
 * lanes and remembering the numbers.
 */
export interface LaneReadout {
  /** Where this is, phrased as the matrix readout phrases it. */
  position: string
  /** One per value track on this edge, nearest the map first. */
  rows: Array<{
    label: string
    colour: string
    /** The sampled value, already formatted; `—` where the track has no data. */
    value: string
    /** `true` for the one lane the pointer is actually inside. */
    here: boolean
  }>
  /**
   * The feature under the pointer, when it is over a lane that draws them: its
   * name, then its coordinates, score and attributes.
   *
   * A gene model and a peak set have no value at a position — they have a thing
   * or nothing — so they are not rows above. When the pointer is on one, what it
   * is worth saying is everything about that one feature.
   */
  detail: string[]
}

/** Gap between two stacked lanes, in CSS pixels. */
const LANE_GAP = 4

/** A lane's position in its stack, resolved per frame. */
interface Slot {
  entry: AnnotationEntry
  acrossFrom: number
  thickness: number
}

/** One lane, ready to paint: where it goes, and what it is a picture of. */
interface Lane {
  entry: AnnotationEntry
  frame: LaneFrame
  /** Present for a value track; `null` for the feature kinds. */
  profile: PixelProfile | null
}

/**
 * How close to a lane's far border counts as being on it.
 *
 * Four pixels either side. The same number the side panels' drag handle is
 * wide, and for the same reason: a border is a line, and a line is not
 * something a hand can be asked to hit.
 */
const LANE_GRIP = 4

/** Both edges, in the order they are drawn. */
const EDGES: readonly LaneEdge[] = ['bottom', 'right']

export class AnnotationLanes {
  /** The two canvases, mounted by the panel. Hidden when their stack is empty. */
  readonly bottomEl: HTMLCanvasElement
  readonly rightEl: HTMLCanvasElement

  private axes: { rows: LocusAxis | null; cols: LocusAxis | null } = { rows: null, cols: null }
  private readonly cache: SampleCache
  /** Feature layouts from the last draw, for hit testing without a re-layout. */
  private readonly layouts = new Map<string, { frame: LaneFrame; layout: FeatureLayout }>()
  private dpr = 1

  constructor(
    private readonly options: {
      store: AnnotationStore
      /**
       * The reader's own marks. Drawn *into* the lanes as well as onto the map:
       * a line called out on the matrix is a coordinate, and the tracks beside
       * it are what a coordinate is usually being compared against.
       */
      manual: ManualStore
      client: AnnotationClient
      /** Ask for a repaint; the panel coalesces it into its own frame. */
      onChange(): void
    },
  ) {
    this.bottomEl = el('canvas', { class: 'lane-canvas lane-bottom' })
    this.rightEl = el('canvas', { class: 'lane-canvas lane-right' })
    this.cache = new SampleCache(options.client, () => options.onChange())
  }

  /**
   * Point the lanes at a new block.
   *
   * The sample cache is *not* cleared: it is keyed on genomic windows, which
   * mean the same thing in every view, so opening a region inside a
   * whole-genome view reuses what the whole-genome view already fetched.
   */
  setAxes(axes: { rows: LocusAxis | null; cols: LocusAxis | null }): void {
    this.axes = axes
    this.layouts.clear()
  }

  destroy(): void {
    this.cache.destroy()
    this.layouts.clear()
  }

  /** The lanes on one edge, in load order, nearest the map first. */
  private slotsFor(edge: LaneEdge): Slot[] {
    const axis = edge === 'bottom' ? this.axes.cols : this.axes.rows
    if (axis === null) return []
    const out: Slot[] = []
    let across = 0
    for (const entry of this.options.store.drawnOn(edge)) {
      const thickness = Math.max(10, Math.round(entry.style.size))
      out.push({ entry, acrossFrom: across, thickness })
      across += thickness + LANE_GAP
    }
    return out
  }

  /** Total thickness one edge needs, or `0` when it has no lanes. */
  thicknessOf(edge: LaneEdge): number {
    const slots = this.slotsFor(edge)
    if (slots.length === 0) return 0
    const last = slots[slots.length - 1]
    return last.acrossFrom + last.thickness
  }

  /**
   * Draw both stacks onto their own canvases.
   *
   * Two passes over the lanes rather than one: every value profile is built
   * first, then the limits are resolved — which is the only order in which an
   * autoscale *group* can exist, since a group's range is a fact about all its
   * members and not about any one of them.
   */
  draw(geometry: LaneGeometry): void {
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    this.layouts.clear()
    const built = this.build(geometry)

    for (const edge of EDGES) {
      const canvas = edge === 'bottom' ? this.bottomEl : this.rightEl
      const lanes = built[edge]
      canvas.classList.toggle('hidden', lanes.length === 0)
      if (lanes.length === 0) continue

      // The lane canvas matches the heatmap canvas on the shared axis exactly,
      // so the two are drawn in one coordinate system rather than in two that
      // agree by arrangement.
      const total = this.thicknessOf(edge)
      const cssAlong = edge === 'bottom' ? geometry.cssWidth : geometry.cssHeight
      const cssWidth = edge === 'bottom' ? cssAlong : total
      const cssHeight = edge === 'bottom' ? total : cssAlong
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      const wantWidth = Math.max(1, Math.round(cssWidth * this.dpr))
      const wantHeight = Math.max(1, Math.round(cssHeight * this.dpr))
      if (canvas.width !== wantWidth) canvas.width = wantWidth
      if (canvas.height !== wantHeight) canvas.height = wantHeight

      const ctx = canvas.getContext('2d')
      if (ctx === null) continue
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.clearRect(0, 0, cssWidth, cssHeight)
      this.paintEdge(ctx, edge, geometry, lanes, built.groups, this.dpr)
    }
  }

  /**
   * Draw both stacks into somebody else's context — the export path.
   *
   * Placed as the screen places them: the bottom stack below the heatmap's own
   * canvas, the right stack beside it. Redrawn at the export scale rather than
   * scaled up as images, so a 300 dpi figure has 300 dpi track names, which is
   * the same trade `HeatmapView.renderTo` makes.
   */
  renderInto(ctx: CanvasRenderingContext2D, geometry: LaneGeometry, scale: number): void {
    const built = this.build(geometry)
    for (const edge of EDGES) {
      const lanes = built[edge]
      if (lanes.length === 0) continue
      ctx.save()
      if (edge === 'bottom') ctx.setTransform(scale, 0, 0, scale, 0, geometry.cssHeight * scale)
      else ctx.setTransform(scale, 0, 0, scale, geometry.cssWidth * scale, 0)
      this.paintEdge(ctx, edge, geometry, lanes, built.groups, scale)
      ctx.restore()
    }
  }

  // -------------------------------------------------------------------------
  // Pass one: geometry, samples, profiles
  // -------------------------------------------------------------------------

  private build(geometry: LaneGeometry): {
    bottom: Lane[]
    right: Lane[]
    groups: Map<string, { min: number; max: number }>
  } {
    this.cache.prune(new Set(this.options.store.entries.map((entry) => entry.id)))
    const bottom = this.buildEdge('bottom', geometry)
    const right = this.buildEdge('right', geometry)

    // The group ranges, over every lane on both edges: a group is a claim that
    // these tracks are comparable, and comparing them on two different scales
    // because they happen to be on different edges would defeat it.
    const groups = new Map<string, { min: number; max: number }>()
    for (const lane of [...bottom, ...right]) {
      const group = lane.entry.style.group
      if (group === '' || lane.profile === null || lane.profile.extent === null) continue
      const seen = groups.get(group)
      groups.set(
        group,
        seen === undefined
          ? { ...lane.profile.extent }
          : {
              min: Math.min(seen.min, lane.profile.extent.min),
              max: Math.max(seen.max, lane.profile.extent.max),
            },
      )
    }
    return { bottom, right, groups }
  }

  private buildEdge(edge: LaneEdge, geometry: LaneGeometry): Lane[] {
    const axis = edge === 'bottom' ? this.axes.cols : this.axes.rows
    if (axis === null) return []
    return this.slotsFor(edge).map((slot) => {
      const frame = this.frameOf(edge, slot, geometry)
      const profile =
        slot.entry.kind === 'track'
          ? profileOf(frame, axis, this.samplesFor(slot.entry, edge, axis, frame))
          : null
      return { entry: slot.entry, frame, profile }
    })
  }

  private frameOf(edge: LaneEdge, slot: Slot, geometry: LaneGeometry): LaneFrame {
    const { plot, data, colScale, rowScale } = geometry
    if (edge === 'bottom') {
      return {
        orientation: 'bottom',
        toPixel: (unit) => plot.x + colScale.toPixel(unit),
        toUnit: (pixel) => colScale.toUnit(pixel - plot.x),
        domain: colScale.domain,
        alongFrom: data.x,
        alongTo: data.x + data.width,
        acrossFrom: slot.acrossFrom,
        thickness: slot.thickness,
      }
    }
    return {
      orientation: 'right',
      toPixel: (unit) => plot.y + rowScale.toPixel(unit),
      toUnit: (pixel) => rowScale.toUnit(pixel - plot.y),
      domain: rowScale.domain,
      alongFrom: data.y,
      alongTo: data.y + data.height,
      acrossFrom: slot.acrossFrom,
      thickness: slot.thickness,
    }
  }

  /**
   * The samples to draw, and a fetch if the ones in hand will not do.
   *
   * Returns whatever is cached — possibly at the wrong resolution, possibly
   * nothing — and never waits. A lane showing slightly coarse data for one frame
   * is invisible; a lane that blanks while it waits is not.
   */
  private samplesFor(
    entry: AnnotationEntry,
    edge: LaneEdge,
    axis: LocusAxis,
    frame: LaneFrame,
  ): TrackSampleSet | null {
    return this.cache.samplesFor({
      entry: entry.id,
      scope: edge,
      axis,
      domain: frame.domain,
      pixels: Math.abs(frame.alongTo - frame.alongFrom),
    })
  }

  // -------------------------------------------------------------------------
  // Pass two: ink
  // -------------------------------------------------------------------------

  private paintEdge(
    ctx: CanvasRenderingContext2D,
    edge: LaneEdge,
    geometry: LaneGeometry,
    lanes: Lane[],
    groups: Map<string, { min: number; max: number }>,
    dpr: number,
  ): void {
    const axis = edge === 'bottom' ? this.axes.cols : this.axes.rows
    if (axis === null) return
    // One read for the whole stack: every lane asks the same question and the
    // store behind it is a module-level one.
    const { text, fills } = getPlotOptions()

    for (const lane of lanes) {
      const { entry, frame, profile } = lane
      clipLane(ctx, frame)
      if (entry.kind === 'track' && profile !== null) {
        const extent =
          entry.style.group === ''
            ? profile.extent
            : (groups.get(entry.style.group) ?? profile.extent)
        const limits = resolveLimits(entry.style.limits, extent)
        drawTrack(ctx, frame, profile, {
          colour: entry.style.colour,
          mode: entry.style.mode,
          limits,
          guideColour: geometry.palette.guide,
          haloColour: geometry.palette.halo,
          font: LANE_FONT,
          opacity: entry.style.opacity,
          fills,
        })
        if (text) {
          this.labelLane(ctx, frame, geometry, entry.label, `${formatLimit(limits.min)} – ${formatLimit(limits.max)}`)
        }
      } else if (entry.payload?.kind === 'features') {
        const rows = entry.kind === 'gtf' ? rowsThatFit(frame.thickness, 13) : rowsThatFit(frame.thickness)
        const layout = layoutFeatures(frame, axis, entry.payload.data, rows)
        this.layouts.set(`${entry.id}:${edge}`, { frame, layout })
        const paint = {
          colour: entry.style.colour,
          guideColour: geometry.palette.guide,
          haloColour: geometry.palette.halo,
          font: LANE_FONT,
          opacity: entry.style.opacity,
          labels: text,
        }
        if (entry.kind === 'gtf') drawGenes(ctx, frame, entry.payload.data, layout, paint)
        else drawSegments(ctx, frame, entry.payload.data, layout, paint)
        if (text) {
          this.labelLane(
            ctx,
            frame,
            geometry,
            entry.label,
            layout.dense ? `${fmt.int(layout.total)} in view` : '',
          )
        }
      }
      ctx.restore()

      // The map's crosshair, continued into the lane...
      if (geometry.crosshair && geometry.hover !== null) {
        const unit = (edge === 'bottom' ? geometry.hover.col : geometry.hover.row) + 0.5
        hairline(ctx, frame, frame.toPixel(unit), geometry.palette.crosshair, dpr)
      }
      // ...and the reader's own, from pointing at this stack. Not under the
      // crosshair preference: that option is about what the *map* draws while
      // you move over it, and this line is the direct answer to a gesture being
      // made right now. A pointer over a track with no line under it looks like
      // a track that does not respond.
      if (geometry.guide !== null && geometry.guide.edge === edge) {
        hairline(ctx, frame, geometry.guide.along, geometry.palette.crosshair, dpr)
      }

      // The reader's hand-drawn lines, continued off the map. Only the ones
      // this edge measures: a vertical rule is a column and belongs under the
      // map, a horizontal one is a row and belongs beside it. A mark drawn on
      // the axis it does not name would point at the wrong coordinate.
      for (const line of this.options.manual.lines) {
        if (line.axis !== 'both' && line.axis !== (edge === 'bottom' ? 'vertical' : 'horizontal')) {
          continue
        }
        const unit = axis.locusToUnit(line.at.contig, line.at.bp)
        if (unit === null) continue
        hairline(ctx, frame, frame.toPixel(unit), line.colour, dpr)
      }
    }

    // Loop anchors, once per stack rather than once per lane: a triangle on the
    // axis says "this coordinate", and one per track would say it four times.
    // Drawn on the stack's outer edge, pointing back at the map, so it reads as
    // a pointer into the picture rather than as another feature in a track.
    //
    // **Both** anchors on **both** axes. A loop is a statement about two loci,
    // and a reader looking at the tracks under one end of it is asking what is
    // at the other — putting the row anchor only beside the map and the column
    // anchor only under it would answer half of that on each edge, and neither
    // half where the comparison is made. A coordinate is a coordinate: each end
    // is drawn wherever the axis in front of it has room for it.
    const last = lanes[lanes.length - 1]
    if (last !== undefined) {
      for (const mark of this.options.manual.arrowheads) {
        let drawn: number | null = null
        for (const anchor of [mark.a, mark.b]) {
          const unit = axis.locusToUnit(anchor.contig, anchor.bp)
          // An on-diagonal loop names one place twice; drawing the triangle
          // twice would only darken it.
          if (unit === null || unit === drawn) continue
          drawn = unit
          anchorMark(ctx, last.frame, last.frame.toPixel(unit), mark.colour)
        }
      }
    }
  }

  /**
   * The lane's name, and what its value axis spans.
   *
   * Inside the lane rather than in a gutter beside it. The gutters belong to the
   * heatmap's block labels and collapse to six pixels when those are off — which
   * is this app's default — so a name outside would have to reopen a band the
   * reader closed. A halo is what keeps it readable over the track's own ink.
   *
   * The range goes **under** the name, as it does in the 1D browser, whenever
   * the lane is tall enough for two lines. A number at the opposite end of a
   * six-hundred-pixel lane from the name it belongs to has to be paired up by
   * eye every time; on a lane too short for the second line it goes back beside
   * the name, which is the same fallback and the same threshold the browser
   * uses. Two implementations of one layout is the drift §5.8 exists to prevent.
   */
  private labelLane(
    ctx: CanvasRenderingContext2D,
    frame: LaneFrame,
    geometry: LaneGeometry,
    name: string,
    detail: string,
  ): void {
    ctx.save()
    ctx.font = LANE_FONT
    ctx.fillStyle = geometry.palette.guide
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const near = frame.orientation === 'bottom' ? frame.alongFrom + 4 : frame.alongTo - 4
    laneText(ctx, frame, name, near, NAME_ACROSS, { halo: geometry.palette.halo })
    if (detail !== '') {
      const stacked = frame.thickness >= NAME_ACROSS + DETAIL_DROP + 6
      const along = stacked ? near : frame.orientation === 'bottom' ? near + ctx.measureText(name).width + 10 : near - ctx.measureText(name).width - 10
      laneText(ctx, frame, detail, along, stacked ? NAME_ACROSS + DETAIL_DROP : NAME_ACROSS, {
        halo: geometry.palette.halo,
      })
    }
    ctx.restore()
  }

  // -------------------------------------------------------------------------
  // Hover
  // -------------------------------------------------------------------------

  /**
   * Every value track on one edge, read at the position the pointer is at.
   *
   * The coordinates are that edge's own canvas's. Which lane the pointer is
   * *inside* decides only two things — which row is marked `here`, and whose
   * feature is described — because the position along the axis is the same
   * question for every lane in the stack, and reading them all is the whole
   * point of stacking them.
   */
  /**
   * Which lane a point in a stack's canvas is on, and whether it is on the
   * *border* between that lane and the next.
   *
   * The border is what a resize drag grabs, so it is given a few pixels of
   * slack on either side — a one-pixel target is a target nobody hits. Ordering
   * matters: a point in the slack of one lane's far border belongs to that
   * border, not to the lane after it, because the border is what the pointer
   * changed shape for.
   *
   * `null` between lanes and past the last one, so a drag begun in the gap does
   * nothing rather than something arbitrary.
   */
  laneAt(
    edge: LaneEdge,
    x: number,
    y: number,
  ): { entry: AnnotationEntry; index: number; onBorder: boolean } | null {
    const across = edge === 'bottom' ? y : x
    const slots = this.slotsFor(edge)
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]
      const offset = across - slot.acrossFrom
      if (offset < -LANE_GRIP || offset > slot.thickness + LANE_GRIP) continue
      return {
        entry: slot.entry,
        index,
        onBorder: offset > slot.thickness - LANE_GRIP,
      }
    }
    return null
  }

  /** Where each lane on an edge begins, for a drag that is reordering them. */
  boundariesOf(edge: LaneEdge): number[] {
    return this.slotsFor(edge).map((slot) => slot.acrossFrom)
  }

  readout(edge: LaneEdge, x: number, y: number, geometry: LaneGeometry): LaneReadout | null {
    const axis = edge === 'bottom' ? this.axes.cols : this.axes.rows
    if (axis === null) return null
    const slots = this.slotsFor(edge)
    if (slots.length === 0) return null

    const along = edge === 'bottom' ? x : y
    const across = edge === 'bottom' ? y : x
    const rows: LaneReadout['rows'] = []
    let detail: string[] = []
    let onALane = false

    for (const slot of slots) {
      const frame = this.frameOf(edge, slot, geometry)
      const offset = across - frame.acrossFrom
      const here = offset >= 0 && offset <= frame.thickness
      if (here) onALane = true

      if (slot.entry.kind === 'track') {
        const cached = this.cache.peek(slot.entry.id, edge)
        const value = cached === null ? null : valueAtPixel(cached, axis, frame, along)
        rows.push({
          label: slot.entry.label,
          colour: slot.entry.style.colour,
          value: value === null ? '—' : fmt.num(value),
          here,
        })
        continue
      }

      // A feature lane has no value at a position, so it is not a row. When the
      // pointer is on one, the feature itself is what there is to say.
      if (!here) continue
      const cached = this.layouts.get(`${slot.entry.id}:${edge}`)
      const set = slot.entry.payload?.kind === 'features' ? slot.entry.payload.data : null
      if (cached === undefined || set === null) continue
      const hit = featureAt(cached.frame, cached.layout, x, y)
      if (hit === null) continue
      const at = hit.index
      const strand = set.strand[at] === 1 ? ' (+)' : set.strand[at] === -1 ? ' (−)' : ''
      // The feature's name leads its own block. It is not the lane's name — that
      // one the pointer already gives away — so it belongs in the readout rather
      // than in the heading.
      detail = set.name[at] === '' ? [] : [set.name[at]]
      detail.push(
        `${set.contigs[set.contig[at]]}:${fmt.int(set.start[at])}–${fmt.int(set.end[at])}${strand}`,
      )
      if (Number.isFinite(set.score[at])) detail.push(`score ${fmt.num(set.score[at])}`)
      if (set.detail[at] !== '') detail.push(set.detail[at])
    }

    if (rows.length === 0 && detail.length === 0 && !onALane) return null
    return {
      position: describeAt(axis, this.frameOf(edge, slots[0], geometry), along),
      rows,
      detail,
    }
  }
}

/**
 * One hairline across a lane, at a position along its axis.
 *
 * Snapped to a device pixel, or a 0.75-wide line lands between two and is drawn
 * as a two-pixel grey smear — which on a lane 16 pixels tall is a band, not a
 * mark.
 */
/**
 * A loop's anchor, as a small triangle on the stack's outer edge.
 *
 * Pointing *inwards*, towards the map: the mark it belongs to is a pixel over
 * there, and a glyph aimed at it is the difference between "this coordinate" and
 * "something else drawn here". Outlined in nothing — it sits on the canvas's own
 * edge, where there is no track ink to be lost against.
 */
function anchorMark(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  colour: string,
): void {
  if (along < frame.alongFrom || along > frame.alongTo) return
  const outer = frame.acrossFrom + frame.thickness
  const half = ANCHOR_HALF
  ctx.save()
  ctx.fillStyle = colour
  ctx.beginPath()
  if (frame.orientation === 'bottom') {
    ctx.moveTo(along, outer - ANCHOR_LENGTH)
    ctx.lineTo(along - half, outer)
    ctx.lineTo(along + half, outer)
  } else {
    ctx.moveTo(outer - ANCHOR_LENGTH, along)
    ctx.lineTo(outer, along - half)
    ctx.lineTo(outer, along + half)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** Tip to base, and half the base: a glyph, not a shape to be read. */
const ANCHOR_LENGTH = 7
const ANCHOR_HALF = 4

function hairline(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  colour: string,
  dpr: number,
): void {
  if (along < frame.alongFrom || along > frame.alongTo) return
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = Math.max(1 / dpr, 0.75)
  ctx.globalAlpha = 0.8
  ctx.beginPath()
  const snapped = (Math.round(along * dpr - 0.5) + 0.5) / dpr
  if (frame.orientation === 'bottom') {
    ctx.moveTo(snapped, frame.acrossFrom)
    ctx.lineTo(snapped, frame.acrossFrom + frame.thickness)
  } else {
    ctx.moveTo(frame.acrossFrom, snapped)
    ctx.lineTo(frame.acrossFrom + frame.thickness, snapped)
  }
  ctx.stroke()
  ctx.restore()
}

/** 9 px is what fits in a 16-pixel lane and still reads at a normal distance. */
const LANE_FONT = '9px system-ui, sans-serif'

/** Where the name sits in the lane, from its outer edge. */
const NAME_ACROSS = 8

/** How far under the name the range sits, when the lane is tall enough. */
const DETAIL_DROP = 11

/** `I:412,000` — the same phrasing the matrix readout uses. */
function describeAt(axis: LocusAxis, frame: LaneFrame, along: number): string {
  const locus = axis.unitToLocus(frame.toUnit(along))
  return locus === null ? '—' : `${locus.contig}:${fmt.bp(locus.bp)}`
}

/** The sampled value under a pixel, straight from the cache. */
function valueAtPixel(
  samples: TrackSampleSet,
  axis: LocusAxis,
  frame: LaneFrame,
  along: number,
): number | null {
  const locus = axis.unitToLocus(frame.toUnit(along))
  if (locus === null) return null
  for (const region of samples.regions) {
    if (region.contig !== locus.contig) continue
    // Ascending and non-overlapping, so this is a binary search rather than the
    // linear scan a pointer move cannot afford at base resolution.
    let low = 0
    let high = region.starts.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (locus.bp < region.starts[mid]) high = mid - 1
      else if (locus.bp >= region.ends[mid]) low = mid + 1
      else return region.values[mid]
    }
  }
  return null
}

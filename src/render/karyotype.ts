/**
 * The ideogram view (§5.10): every sequence of a genome drawn whole, side by
 * side, with the tracks beside each one.
 *
 * Nothing here draws a track. A chromosome is given a **frame per lane** —
 * `render/lane.ts`'s {@link LaneFrame}, the one shape every lane in this
 * application is drawn into — whose genomic axis is that chromosome's stretch
 * of the browser's own axis, run down the page or across it, and whose
 * thickness runs outward from the chromosome. Handed those frames, the painters
 * that draw a lane beside a map draw it beside a chromosome: `drawTrack` a
 * bigWig in any of its modes, `drawFeatures` a gene model, a peak set or a
 * sashimi plot's arcs, `drawArcs` a loop set's arcs. A lane to the right of a
 * standing chromosome is the right-hand stack beside a map, and a lane above a
 * lying one is the top stack: two of the four edges §8.9 already covers, so a
 * track cannot be drawn one way here and another way there. What this module
 * owns is where those frames go, the chromosome's own body, the curves between
 * two chromosomes, the marks drawn across one, and the hit test.
 *
 * ## Two layouts, one turned from the other
 *
 * **Standing** — the default, and ideogram.js's — the chromosomes are a row of
 * columns, each read from its first base at the top to its last at the bottom,
 * their names over them, and its lanes to its right. **Lying** — the view
 * flipped — they are a column of rows, each read left to right, its name before
 * it and its lanes above it. The second is the first turned a quarter: what is
 * *above* a lying chromosome is *right of* a standing one, which is exactly how
 * ideogram.js turns its own (`rotate(90)`), so a reader who learns which side
 * the tracks are on learns it once.
 *
 * Every chromosome is drawn on **one scale** — base pairs per pixel are the same
 * for all of them, the longest filling the room — because a karyotype whose
 * chromosomes were each stretched to the same length would be a list of
 * sequences, not a picture of a genome.
 */

import type { FeatureSet, PairSet } from '../annotations/types'
import { ANCHOR_HALF, ANCHOR_LENGTH, snap } from './browser'
import type { FeatureLayout, FeaturePaint } from './features'
import { drawIdeogram, traceIdeogramOutline } from './ideogram'
import {
  OUTLINE_WIDTH,
  laneCurve,
  laneLine,
  laneMove,
  laneRect,
  laneX,
  laneY,
  type LaneFrame,
} from './lane'
import type { LocusAxis } from './locus'
import { drawTrack, type PixelProfile, type TrackPaint } from './tracks'

/** Which way the chromosomes run: standing in a row, or lying in a column. */
export type KaryotypeOrientation = 'vertical' | 'horizontal'

/** One sequence to place: its name and its stretch of the browser's axis. */
export interface KaryotypeSequence {
  contig: string
  unitStart: number
  unitEnd: number
}

/** Clear space round the whole picture, in pixels. */
export const KARYOTYPE_PAD = 10

/**
 * The strip on a chromosome's far side from its lanes, where an arrowhead's
 * anchor hangs (§8.1): the triangle's length and a pixel either side of it.
 */
export const KARYOTYPE_GUTTER = ANCHOR_LENGTH + 2

/**
 * The thinnest a lane is drawn when the lanes are fitted to the room.
 *
 * Four pixels: a heatmap lane is still a colour and a profile still a shape.
 * Under it a lane is a hairline that only says a track is there, and the
 * picture is better wider than the room — it scrolls — than drawn in those.
 */
export const KARYOTYPE_LANE_FLOOR = 4

/** The shortest the longest chromosome is drawn, whatever the room. */
const MIN_LENGTH = 40

export interface KaryotypeOptions {
  orientation: KaryotypeOrientation
  /**
   * The room the picture is laid out in: the stage's width, and its height down
   * to the foot of the column. A picture that cannot fit reports its own
   * extent, which is larger, and the stage scrolls.
   */
  width: number
  height: number
  /** Taken off the top for the key over the chromosomes, in pixels. */
  top: number
  /**
   * The names' room: the height of the row of names over standing chromosomes,
   * or the width of the column of them before lying ones.
   */
  names: number
  /** How thick a chromosome is drawn. */
  body: number
  /** Between two chromosomes. */
  gap: number
  /**
   * Between a chromosome and its first lane, and between two lanes — a pixel
   * where the lanes are shrunk to fit.
   */
  laneGap: number
  /**
   * Each lane's height in the browser, the one nearest the chromosome first.
   * A lane of none takes no room, gap and all: a pair set whose every pair is
   * between two chromosomes has nothing to draw beside one.
   */
  lanes: readonly number[]
  /**
   * Shrink every lane by one factor until every chromosome fits the room — and
   * never grow one past its height in the browser, which is the height its
   * reader chose. `false` keeps those heights and lets the picture run past the
   * room.
   */
  fit: boolean
  /** The longest chromosome's length on screen, or `null` for what the room allows. */
  length: number | null
}

/** Where one chromosome went, and the frames everything on it is drawn in. */
export interface ChromosomePlace {
  contig: string
  unitStart: number
  unitEnd: number
  /** Where it runs along its own axis, in canvas pixels: down the page standing, across it lying. */
  along0: number
  along1: number
  /** The chromosome itself, as a lane as thick as the chromosome is drawn. */
  body: LaneFrame
  /** One frame per lane, outward from the chromosome. */
  lanes: LaneFrame[]
  /**
   * The two ends of a rule across it, in canvas pixels on the axis across the
   * chromosome — from the anchors' strip to the far edge of its last lane: what
   * the hairline, a reader's line and a box's wash span.
   */
  across: [number, number]
  /** Everything this chromosome owns on the canvas — its column, or its row — for the hit test. */
  box: { x: number; y: number; width: number; height: number }
  /** Where its name is written. */
  name: { x: number; y: number; align: 'center' | 'right'; width: number }
}

export interface KaryotypeLayout {
  orientation: KaryotypeOrientation
  places: ChromosomePlace[]
  /** Each lane's thickness once fitted, in the order of {@link KaryotypeOptions.lanes}. */
  lanes: number[]
  /** How far the lanes were shrunk to fit: 1 is their heights in the browser. */
  factor: number
  /** Pixels per axis unit — per base pair, on the browser's axis — for every chromosome. */
  perUnit: number
  /** The picture's own extent, past the room where it could not fit. */
  width: number
  height: number
}

/**
 * Place every chromosome, and cut every frame.
 *
 * The lanes are fitted **across** — beside a standing chromosome they take the
 * row's width, above a lying one the column's height — and the chromosomes are
 * fitted **along**: the longest fills the room it runs in, and the rest are
 * drawn to its scale.
 */
export function layoutKaryotype(
  sequences: readonly KaryotypeSequence[],
  options: KaryotypeOptions,
): KaryotypeLayout {
  const vertical = options.orientation === 'vertical'
  const count = Math.max(1, sequences.length)
  const natural = options.lanes.reduce((sum, size) => sum + size, 0)
  const drawn = options.lanes.filter((size) => size > 0).length
  // What one chromosome may take across its axis, gutter and lanes and all.
  const room = vertical ? options.width - 2 * KARYOTYPE_PAD : options.height - options.top - 2 * KARYOTYPE_PAD
  const each = (room + options.gap) / count - options.gap
  const fitted = (laneGap: number): number => {
    const fixed = KARYOTYPE_GUTTER + options.body + laneGap * drawn
    return options.fit && natural > 0 ? Math.max(0, Math.min(1, (each - fixed) / natural)) : 1
  }
  // Squeezed, the lanes keep a pixel between them and not the gap they have
  // at their own heights: a picture short of room spends it on ink, and three
  // pixels of air beside a lane four wide is most of the row.
  const laneGap = fitted(options.laneGap) < 1 ? Math.min(1, options.laneGap) : options.laneGap
  const factor = fitted(laneGap)
  // Whole pixels, so two lanes' shared edge is one edge and not two blurred
  // ones; and never under the floor, past which the picture is better wider.
  const lanes = options.lanes.map((size) =>
    size <= 0 ? 0 : factor >= 1 ? size : Math.max(KARYOTYPE_LANE_FLOOR, Math.floor(size * factor)),
  )
  const extent = KARYOTYPE_GUTTER + options.body + lanes.reduce((sum, size) => sum + (size > 0 ? size + laneGap : 0), 0)

  const longest = sequences.reduce((most, sequence) => Math.max(most, sequence.unitEnd - sequence.unitStart), 0)
  const alongStart = vertical ? options.top + options.names : KARYOTYPE_PAD + options.names
  const alongRoom =
    options.length ??
    (vertical ? options.height - alongStart - KARYOTYPE_PAD : options.width - alongStart - KARYOTYPE_PAD)
  const length = Math.max(MIN_LENGTH, alongRoom)
  const perUnit = length / Math.max(1, longest)
  const crossTotal = count * extent + (count - 1) * options.gap

  const places = sequences.map((sequence, index): ChromosomePlace => {
    const cross = (vertical ? KARYOTYPE_PAD : options.top + KARYOTYPE_PAD) + index * (extent + options.gap)
    const along0 = alongStart
    const along1 = along0 + (sequence.unitEnd - sequence.unitStart) * perUnit
    const frameOf = (acrossFrom: number, thickness: number): LaneFrame => ({
      orientation: vertical ? 'right' : 'top',
      toPixel: (unit) => along0 + (unit - sequence.unitStart) * perUnit,
      toUnit: (pixel) => sequence.unitStart + (pixel - along0) / perUnit,
      domain: [sequence.unitStart, sequence.unitEnd],
      alongFrom: along0,
      alongTo: along1,
      acrossFrom,
      thickness,
    })
    if (vertical) {
      // Standing: the anchors' strip, the chromosome, then each lane to the
      // right of the one before — `acrossFrom` is a lane's edge nearest the
      // chromosome, and across runs rightward from it.
      const near = cross + KARYOTYPE_GUTTER
      const body = frameOf(near, options.body)
      let at = near + options.body
      const frames = lanes.map((thickness) => {
        if (thickness > 0) at += laneGap
        const frame = frameOf(at, thickness)
        at += thickness
        return frame
      })
      return {
        contig: sequence.contig,
        unitStart: sequence.unitStart,
        unitEnd: sequence.unitEnd,
        along0,
        along1,
        body,
        lanes: frames,
        across: [cross, cross + extent],
        box: {
          x: cross - options.gap / 2,
          y: options.top,
          width: extent + options.gap,
          height: options.names + length,
        },
        name: {
          x: near + options.body / 2,
          y: options.top + options.names / 2,
          align: 'center',
          width: extent + options.gap - 2,
        },
      }
    }
    // Lying: the lanes above, the chromosome under them, the anchors' strip
    // under it — `acrossFrom` is a lane's lower edge, and across runs upward.
    const floor = cross + extent - KARYOTYPE_GUTTER
    const body = frameOf(floor, options.body)
    let at = floor - options.body
    const frames = lanes.map((thickness) => {
      if (thickness > 0) at -= laneGap
      const frame = frameOf(at, thickness)
      at -= thickness
      return frame
    })
    return {
      contig: sequence.contig,
      unitStart: sequence.unitStart,
      unitEnd: sequence.unitEnd,
      along0,
      along1,
      body,
      lanes: frames,
      across: [cross, cross + extent],
      box: {
        x: 0,
        y: cross - options.gap / 2,
        width: Math.max(options.width, alongStart + length + KARYOTYPE_PAD),
        height: extent + options.gap,
      },
      name: {
        x: KARYOTYPE_PAD + options.names - NAME_PAD,
        y: floor - options.body / 2,
        align: 'right',
        width: Math.max(0, options.names - NAME_PAD),
      },
    }
  })

  return {
    orientation: options.orientation,
    places,
    lanes,
    factor,
    perUnit,
    width: vertical ? 2 * KARYOTYPE_PAD + crossTotal : alongStart + length + KARYOTYPE_PAD,
    height: vertical ? alongStart + length + KARYOTYPE_PAD : options.top + 2 * KARYOTYPE_PAD + crossTotal,
  }
}

/** Between a lying chromosome's name and the chromosome. */
const NAME_PAD = 8

// ---------------------------------------------------------------------------
// The chromosome itself
// ---------------------------------------------------------------------------

/**
 * Trace a chromosome with no bands to draw it by: a bar rounded at both
 * telomeres, as thick as its frame, as long as its sequence — a pill, and the
 * shape every ideogram draws a sequence its cytoBand does not cover.
 */
export function tracePill(ctx: CanvasRenderingContext2D, frame: LaneFrame): void {
  const half = frame.thickness / 2
  const a0 = frame.alongFrom
  const a1 = frame.alongTo
  // A cap is half the thickness, or half the length where the sequence is
  // shorter than it is thick: a plasmid at genome zoom is a dot, not a knot.
  const cap = Math.max(0, Math.min(half, (a1 - a0) / 2))
  laneMove(ctx, frame, a0 + cap, 0)
  laneLine(ctx, frame, a1 - cap, 0)
  laneCurve(ctx, frame, a1, 0, a1, half)
  laneCurve(ctx, frame, a1, frame.thickness, a1 - cap, frame.thickness)
  laneLine(ctx, frame, a0 + cap, frame.thickness)
  laneCurve(ctx, frame, a0, frame.thickness, a0, half)
  laneCurve(ctx, frame, a0, 0, a0 + cap, 0)
  ctx.closePath()
}

/**
 * What a chromosome is filled with (§5.10).
 *
 * - `bands` — its cytoBand's stains, which is what a karyotype is.
 * - `plain` — one colour.
 * - `track` — a track's value along it, against the track's own limits and in
 *   the colours its lane is drawn in (a heatmap lane's colormap, any other's
 *   colour from white): the track drawn as a heatmap lane the shape of a
 *   chromosome.
 * - `features` — a feature set's features in their own colours, over the plain
 *   colour: compartments, chromatin states, a peak set.
 */
export type BodyFill =
  | { kind: 'bands' }
  | { kind: 'plain' }
  | { kind: 'track'; profile: PixelProfile; paint: TrackPaint }
  | {
      kind: 'features'
      set: FeatureSet
      layout: FeatureLayout
      colour: string
      colourOf?: (index: number, reversed?: boolean) => string
    }

export interface ChromosomePaint {
  fill: BodyFill
  /**
   * The cytoBand's bands on this chromosome, where one is open and covers it:
   * the outline every fill is drawn inside — the waist at the centromere, a
   * stalk's narrowing — and the bands themselves under `bands`.
   */
  bands: { set: FeatureSet; layout: FeatureLayout; paint: FeaturePaint } | null
  /** The chromosome's own colour: a plain body, and the ground under features. */
  colour: string
  /** The ground under a track's colours, where the track has nothing. */
  paper: string
  /** The outline's ink. */
  ink: string
  opacity: number
}

/**
 * Draw one chromosome: its outline, filled.
 *
 * Its cytoBand's where one covers it and the fill is the bands — the same
 * `drawIdeogram` the karyotype lane is drawn by, at the frame's whole
 * thickness. Otherwise the fill is clipped to the outline, the cytoBand's or
 * the pill's, and the outline edged once over it in the plot's ink.
 */
export function drawChromosome(ctx: CanvasRenderingContext2D, frame: LaneFrame, paint: ChromosomePaint): void {
  const bands = paint.bands
  if (paint.fill.kind === 'bands' && bands !== null && bands.layout.placements.length > 0) {
    drawIdeogram(ctx, frame, bands.set, bands.layout, bands.paint, frame.thickness)
    return
  }
  const trace = (): void => {
    ctx.beginPath()
    const traced = bands === null ? 0 : traceIdeogramOutline(ctx, frame, bands.set, bands.layout, frame.thickness)
    if (traced === 0) tracePill(ctx, frame)
  }
  ctx.save()
  ctx.globalAlpha = paint.opacity
  trace()
  ctx.save()
  ctx.clip()
  const [x, y, width, height] = laneRect(frame, frame.alongFrom, frame.alongTo, 0, frame.thickness)
  const fill = paint.fill
  ctx.fillStyle = fill.kind === 'track' ? paint.paper : paint.colour
  ctx.fillRect(x, y, width, height)
  if (fill.kind === 'track') {
    drawTrack(ctx, frame, fill.profile, { ...fill.paint, mode: 'heatmap', opacity: 1 })
  } else if (fill.kind === 'features') {
    // Across the whole body, a block per feature: the body *is* the lane, and
    // its rows are one — a chromosome painted by its states, not a row of boxes
    // on it. In ink order, one fill per colour, as the feature lanes are.
    const byInk = new Map<string, number[]>()
    for (const placement of fill.layout.placements) {
      const ink = fill.colourOf?.(placement.index, placement.reversed) ?? fill.colour
      const at = byInk.get(ink)
      const along = [placement.along0, placement.along1]
      if (at === undefined) byInk.set(ink, along)
      else at.push(...along)
    }
    for (const [ink, alongs] of byInk) {
      ctx.fillStyle = ink
      ctx.beginPath()
      for (let i = 0; i < alongs.length; i += 2) {
        const [bx, by, bw, bh] = laneRect(frame, alongs[i], alongs[i + 1], 0, frame.thickness)
        ctx.rect(bx, by, bw, bh)
      }
      ctx.fill()
    }
  }
  ctx.restore()
  trace()
  ctx.strokeStyle = paint.ink
  ctx.lineWidth = OUTLINE_WIDTH
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Between two chromosomes
// ---------------------------------------------------------------------------

/**
 * The most pairs drawn between chromosomes, the strongest first where a file
 * scores them. The junction lanes' cap (§8.23), for its reason: past a few
 * thousand curves the picture is a fog, and the pairs it hid are a count the
 * caption can say.
 */
export const TRANS_CAP = 4000

/**
 * The pairs of a pair set whose two ends are on two chromosomes in the picture,
 * drawn as curves between them (§5.10).
 *
 * A chromosome's own pairs are its lane's — `drawArcs`, as in the browser — and
 * the pairs between two are these: each leaves its chromosome straight across
 * it, towards the other, and arrives the same way, so two neighbours are joined
 * by a gentle S and two far apart by a long one, and every curve says at both
 * ends exactly where on the chromosome it begins. The two-lines picture of PR
 * #107's circle seats its ribbons the same way. From the chromosome's middle,
 * at half the set's opacity, and drawn first — under every body and lane — so
 * the tracks a curve passes stay readable over it.
 *
 * Returns how many were drawn and how many there were.
 */
export function drawTransArcs(
  ctx: CanvasRenderingContext2D,
  layout: KaryotypeLayout,
  axis: LocusAxis,
  pairs: PairSet,
  paint: { colour: string; opacity: number },
): { drawn: number; total: number } {
  const byContig = new Map(layout.places.map((place) => [place.contig, place]))
  const chosen: number[] = []
  for (let i = 0; i < pairs.length; i++) {
    const one = pairs.contigs[pairs.contig1[i]]
    const two = pairs.contigs[pairs.contig2[i]]
    if (one === two || !byContig.has(one) || !byContig.has(two)) continue
    chosen.push(i)
  }
  const total = chosen.length
  if (total > TRANS_CAP) {
    // The strongest, where the file says which those are: a score of `NaN` is a
    // file with no score column, and there the file's own order is all there is.
    chosen.sort((a, b) => (scoreOf(pairs, b) - scoreOf(pairs, a)) || a - b)
    chosen.length = TRANS_CAP
  }
  const vertical = layout.orientation === 'vertical'
  ctx.save()
  ctx.strokeStyle = paint.colour
  ctx.globalAlpha = paint.opacity * 0.5
  ctx.lineWidth = 1
  let drawn = 0
  ctx.beginPath()
  for (const i of chosen) {
    const a = pointOn(byContig.get(pairs.contigs[pairs.contig1[i]]), axis, pairs.contigs[pairs.contig1[i]], (pairs.start1[i] + pairs.end1[i]) / 2)
    const b = pointOn(byContig.get(pairs.contigs[pairs.contig2[i]]), axis, pairs.contigs[pairs.contig2[i]], (pairs.start2[i] + pairs.end2[i]) / 2)
    if (a === null || b === null) continue
    ctx.moveTo(a.x, a.y)
    if (vertical) {
      const mid = (a.x + b.x) / 2
      ctx.bezierCurveTo(mid, a.y, mid, b.y, b.x, b.y)
    } else {
      const mid = (a.y + b.y) / 2
      ctx.bezierCurveTo(a.x, mid, b.x, mid, b.x, b.y)
    }
    drawn++
  }
  ctx.stroke()
  ctx.restore()
  return { drawn, total }
}

function scoreOf(pairs: PairSet, index: number): number {
  const score = pairs.score[index]
  return Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY
}

/** A base pair of a chromosome as a canvas point on the chromosome's middle line. */
function pointOn(
  place: ChromosomePlace | undefined,
  axis: LocusAxis,
  contig: string,
  bp: number,
): { x: number; y: number } | null {
  if (place === undefined) return null
  const unit = axis.locusToUnit(contig, bp)
  if (unit === null || unit < place.unitStart || unit > place.unitEnd) return null
  const along = place.body.toPixel(unit)
  const middle = place.body.thickness / 2
  return { x: laneX(place.body, along, middle), y: laneY(place.body, along, middle) }
}

// ---------------------------------------------------------------------------
// Marks across a chromosome
// ---------------------------------------------------------------------------

/**
 * A rule across one chromosome and its lanes, at one point along it: the
 * hairline under the hand, another surface's pointer, a reader's line (§8.1).
 *
 * Across the chromosome and no further, because that is the axis the point is
 * on: the next chromosome along has its own base pair at this height, and a
 * rule carried on through it would name a place there nobody pointed at.
 */
export function drawRuleAcross(
  ctx: CanvasRenderingContext2D,
  layout: KaryotypeLayout,
  place: ChromosomePlace,
  along: number,
  colour: string,
  dpr: number,
  alpha = 0.8,
): void {
  const at = snap(along, dpr)
  const [from, to] = place.across
  ctx.save()
  ctx.strokeStyle = colour
  ctx.globalAlpha = alpha
  ctx.lineWidth = Math.max(1 / dpr, 0.75)
  ctx.beginPath()
  if (layout.orientation === 'vertical') {
    ctx.moveTo(from, at)
    ctx.lineTo(to, at)
  } else {
    ctx.moveTo(at, from)
    ctx.lineTo(at, to)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * A wash across one chromosome and its lanes over a stretch of it: a reader's
 * box (§8.1), at the tenth of an ink a box washes the tracks with everywhere
 * (`MARK_WASH`), and the drag that is choosing a stretch to open.
 */
export function drawWashAcross(
  ctx: CanvasRenderingContext2D,
  layout: KaryotypeLayout,
  place: ChromosomePlace,
  along0: number,
  along1: number,
  colour: string,
  alpha: number,
): void {
  const low = Math.min(along0, along1)
  const span = Math.max(1, Math.abs(along1 - along0))
  const [from, to] = place.across
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = colour
  if (layout.orientation === 'vertical') ctx.fillRect(from, low, to - from, span)
  else ctx.fillRect(low, from, span, to - from)
  ctx.restore()
}

/**
 * One end of a reader's arrowhead (§8.1), in the strip on the chromosome's far
 * side from its lanes, pointing into it — the browser's anchor, which hangs
 * from the ruler and points down into the tracks, turned to point at a
 * chromosome and the tracks beyond it. The same triangle at the same size: one
 * glyph for *this coordinate* on every surface.
 */
export function drawBodyAnchor(
  ctx: CanvasRenderingContext2D,
  body: LaneFrame,
  along: number,
  colour: string,
): void {
  ctx.save()
  ctx.fillStyle = colour
  ctx.beginPath()
  laneMove(ctx, body, along, -1)
  laneLine(ctx, body, along - ANCHOR_HALF, -1 - ANCHOR_LENGTH)
  laneLine(ctx, body, along + ANCHOR_HALF, -1 - ANCHOR_LENGTH)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** Every chromosome's name: over it standing, before it lying. */
export function drawChromosomeNames(
  ctx: CanvasRenderingContext2D,
  layout: KaryotypeLayout,
  font: string,
  colour: string,
  /** The one under the hand, set in the accent. */
  lit: string | null = null,
  accent = colour,
): void {
  ctx.save()
  ctx.font = font
  ctx.textBaseline = 'middle'
  for (const place of layout.places) {
    const { x, y, align, width } = place.name
    if (width < 4) continue
    ctx.textAlign = align
    ctx.fillStyle = place.contig === lit ? accent : colour
    ctx.fillText(place.contig, x, y, width)
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// The stretch being dragged out
// ---------------------------------------------------------------------------

export interface KaryotypeSelection {
  place: ChromosomePlace
  /** The end that does not move, and the one under the pointer, along the chromosome. */
  anchor: number
  moving: number
  /** The two ends' positions written out, and the span between them. */
  start: string
  end: string
  span: string
  colour: string
  halo: string
  font: string
  chipHeight: number
  chipPad: number
  dpr: number
}

/**
 * A stretch of one chromosome being dragged out, to the base at both ends.
 *
 * The browser's selection (`drawSelection`) turned to lie across a chromosome:
 * a wash over the stretch, a hairline across each end, and a chip naming each
 * end beside it — written level whichever way the chromosome runs, since a
 * coordinate is read, not followed — with the span between them under the
 * second. Outside the chromosome's lanes where there is room, so the chips are
 * not written over what is being chosen.
 */
export function drawKaryotypeSelection(
  ctx: CanvasRenderingContext2D,
  layout: KaryotypeLayout,
  selection: KaryotypeSelection,
): void {
  const { place, anchor, moving } = selection
  drawWashAcross(ctx, layout, place, anchor, moving, selection.colour, 0.15)
  drawRuleAcross(ctx, layout, place, anchor, selection.colour, selection.dpr, 1)
  drawRuleAcross(ctx, layout, place, moving, selection.colour, selection.dpr, 1)
  ctx.save()
  ctx.font = selection.font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const chip = (text: string, x: number, y: number): void => {
    const width = ctx.measureText(text).width + selection.chipPad * 2
    ctx.fillStyle = selection.halo
    ctx.strokeStyle = selection.colour
    ctx.lineWidth = 1
    ctx.beginPath()
    if (ctx.roundRect === undefined) ctx.rect(x, y, width, selection.chipHeight)
    else ctx.roundRect(x, y, width, selection.chipHeight, 3)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = selection.colour
    ctx.fillText(text, x + selection.chipPad, y + selection.chipHeight / 2)
  }
  const widthOf = (text: string): number => ctx.measureText(text).width + selection.chipPad * 2
  const low = Math.min(anchor, moving)
  const high = Math.max(anchor, moving)
  const [first, last] = anchor <= moving ? [selection.start, selection.end] : [selection.end, selection.start]
  const h = selection.chipHeight
  if (layout.orientation === 'vertical') {
    // Right of the chromosome's last lane, each chip level with its own end:
    // the low end's above its rule, the high end's below its own.
    const x = place.across[1] + 4
    chip(first, x, low - h - 2)
    chip(last, x, high + 2)
    if (high - low > 2 * h + 6) chip(selection.span, x, (low + high) / 2 - h / 2)
  } else {
    // Over the chromosome's lanes, each chip outside its own end.
    const y = place.across[0] - h - 3
    chip(first, low - widthOf(first) - 3, y)
    chip(last, high + 3, y)
    if (high - low > widthOf(selection.span) + 8) chip(selection.span, (low + high) / 2 - widthOf(selection.span) / 2, y - h - 3)
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// The hit test
// ---------------------------------------------------------------------------

/** The chromosome whose column — or row — holds a canvas point, if any. */
export function placeAt(layout: KaryotypeLayout, x: number, y: number): ChromosomePlace | null {
  for (const place of layout.places) {
    const { box } = place
    if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return place
  }
  return null
}

/** How far along its chromosome a canvas point is: its height standing, its x lying. */
export function alongOf(layout: KaryotypeLayout, x: number, y: number): number {
  return layout.orientation === 'vertical' ? y : x
}

/** How far across: its x standing, its y lying. */
export function acrossOf(layout: KaryotypeLayout, x: number, y: number): number {
  return layout.orientation === 'vertical' ? x : y
}

/** Whether a point along a chromosome is on it — between its first base and its last. */
export function onSequence(place: ChromosomePlace, along: number): boolean {
  return along >= place.along0 && along <= place.along1
}

/**
 * Which of a chromosome's lanes a point is in, by its index, or `-1` on the
 * chromosome itself; `null` in a gap, the anchors' strip or past the last lane.
 */
export function laneIndexAt(layout: KaryotypeLayout, place: ChromosomePlace, x: number, y: number): number | null {
  const across = acrossOf(layout, x, y)
  const within = (frame: LaneFrame): boolean => {
    // A lane of no thickness is not there to be pointed at (`KaryotypeOptions.lanes`).
    if (frame.thickness <= 0) return false
    const [rx, ry, width, height] = laneRect(frame, frame.alongFrom, frame.alongTo, 0, frame.thickness)
    return layout.orientation === 'vertical' ? across >= rx && across <= rx + width : across >= ry && across <= ry + height
  }
  if (within(place.body)) return -1
  const index = place.lanes.findIndex(within)
  return index < 0 ? null : index
}

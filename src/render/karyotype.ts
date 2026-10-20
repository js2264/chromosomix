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
 *
 * ## The camera
 *
 * On screen the picture is looked at through a {@link KaryotypeCamera}: magnified
 * about a point and moved under the window. Magnified, it grows **both ways**
 * from one factor — along, every chromosome longer on the one scale; across,
 * every column wider, the chromosome thicker and its lanes with it — so the
 * chromosome under the pointer fills the window while its neighbours leave it
 * on either side. Across stops once one column is the whole room, since a
 * column wider than the window is a lane nobody can see the far side of; along
 * stops at a base a pixel. A point is held under the pointer by its
 * {@link KaryotypePoint}, the picture's own coordinates — base pairs down the
 * chromosomes, and columns across them counted in their parts as they are at
 * rest — which no magnification changes.
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

/**
 * The most a chromosome is thickened by the camera: twice. A body grows with
 * its column to say it is the one being looked at, and is then thick enough to
 * write its bands' names in; past that a chromosome is a slab, and the room is
 * better spent on the lanes beside it, which have something to show at a width.
 */
export const BODY_ZOOM = 2

/** The finest the camera magnifies a chromosome to: a pixel a unit of the axis — a base, unedited. */
export const KARYOTYPE_FINEST = 1

/**
 * A point of the picture in its own terms, which no camera changes: units of
 * the axis down the chromosomes from their first base, and columns across from
 * the first one's edge — a column counted in its parts as they are at rest, so
 * a point on a chromosome's body, or a third of the way into its second lane,
 * is there at any magnification however unevenly the parts grow. The point a
 * camera is held on, or the one under a pointer, stays the same place on the
 * same chromosome whatever the picture is laid out at.
 */
export interface KaryotypePoint {
  along: number
  across: number
}

/**
 * Where the picture is looked at from, on screen (§5.10): how far it is
 * magnified, and the point of it in the middle of the window.
 */
export interface KaryotypeCamera {
  /** One draws every chromosome whole in the room; more magnifies along and across. */
  zoom: number
  /**
   * The point of the picture in the middle of the window, held to what the
   * picture can show there — or `null` for the picture in the window's
   * corner, as it is laid out at rest.
   */
  centre: KaryotypePoint | null
}

/** The camera at rest: the whole picture, from its corner. */
export const REST_CAMERA: KaryotypeCamera = { zoom: 1, centre: null }

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
  /**
   * The window the picture is drawn through, on screen. Absent, the layout is
   * the whole picture in its own pixels — a saved figure. Present, it is in the
   * window's pixels: magnified and moved by the camera, the names held at the
   * window's edge while the chromosomes move under them (the key over them is
   * the caller's, and does not move), and every lane cut to the stretch in
   * view, so nothing is read or drawn for what is not on screen.
   * {@link KaryotypeOptions.width} and {@link KaryotypeOptions.height} are the
   * window's.
   */
  camera?: KaryotypeCamera
}

/** Where one chromosome went, and the frames everything on it is drawn in. */
export interface ChromosomePlace {
  contig: string
  unitStart: number
  unitEnd: number
  /** Where it runs along its own axis, in canvas pixels: down the page standing, across it lying. */
  along0: number
  along1: number
  /**
   * The chromosome itself, as a lane as thick as the chromosome is drawn —
   * through a camera, cut to the stretch in view and a body's thickness
   * either side, so an end just out of the window still rounds into it.
   */
  body: LaneFrame
  /** One frame per lane, outward from the chromosome — through a camera, cut to the stretch in view. */
  lanes: LaneFrame[]
  /** Whether any of it is in the window: always, without a camera. */
  visible: boolean
  /**
   * The two ends of a rule across it, in canvas pixels on the axis across the
   * chromosome — from the anchors' strip to the far edge of its last lane: what
   * the hairline, a reader's line and a box's wash span.
   */
  across: [number, number]
  /** Everything this chromosome owns on the canvas — its column, or its row — for the hit test. */
  box: { x: number; y: number; width: number; height: number }
  /**
   * Where its name is written — and, through a camera, the stretch across the
   * window its column holds, which the name slides along to stay in sight
   * while any of the column is.
   */
  name: { x: number; y: number; align: 'center' | 'right'; width: number; span?: [number, number] }
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
  /** The picture's own extent, past the room where it could not fit — magnified, through a camera. */
  width: number
  height: number
  /** How far it is magnified, along and across: across stops where one column is the room. */
  zoom: number
  across: number
  /** The most it can be magnified: a pixel a unit along ({@link KARYOTYPE_FINEST}). */
  most: number
  /** From one chromosome's column to the next's, across. */
  pitch: number
  /**
   * One column's parts across, in the canvas's order — the half gap before
   * it, the anchors' strip, the chromosome and each lane with the gap before
   * it, and what is left of the column — as drawn, and at rest: what a
   * {@link KaryotypePoint} counts a column in.
   */
  columns: { drawn: number[]; rest: number[] }
  /** Where the picture's own coordinates start, in its pixels: the chromosomes' first base, and the first column's edge. */
  origin: { along: number; across: number }
  /** How far it was moved under the window: the camera's, held to the picture. */
  pan: { x: number; y: number }
  /**
   * Where the chromosomes are seen through a camera — the window less the key
   * over them and the names beside them, which stay put while the chromosomes
   * move — and `null` without one, the whole picture being drawn.
   */
  view: { x: number; y: number; width: number; height: number } | null
}

/**
 * Place every chromosome, and cut every frame.
 *
 * The lanes are fitted **across** — beside a standing chromosome they take the
 * row's width, above a lying one the column's height — and the chromosomes are
 * fitted **along**: the longest fills the room it runs in, and the rest are
 * drawn to its scale. Through a camera, that picture is then magnified both ways
 * and moved under the window ({@link KaryotypeOptions.camera}).
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
  const fitting = options.lanes.map((size) =>
    size <= 0 ? 0 : factor >= 1 ? size : Math.max(KARYOTYPE_LANE_FLOOR, Math.floor(size * factor)),
  )
  const extentOf = (body: number, lanes: readonly number[]): number =>
    KARYOTYPE_GUTTER + body + lanes.reduce((sum, size) => sum + (size > 0 ? size + laneGap : 0), 0)

  const longest = sequences.reduce((most, sequence) => Math.max(most, sequence.unitEnd - sequence.unitStart), 0)
  const alongStart = vertical ? options.top + options.names : KARYOTYPE_PAD + options.names
  const alongRoom =
    options.length ??
    (vertical ? options.height - alongStart - KARYOTYPE_PAD : options.width - alongStart - KARYOTYPE_PAD)
  const resting = Math.max(MIN_LENGTH, alongRoom)

  // The camera's magnification. Along, to a base a pixel. Across, until one
  // column is the whole room: past that a column is wider than the window, and
  // the far side of its last lane is somewhere nobody can see.
  const camera = options.camera
  const most = Math.max(1, (KARYOTYPE_FINEST * Math.max(1, longest)) / resting)
  const zoom = Math.min(most, Math.max(1, camera?.zoom ?? 1))
  const restPitch = extentOf(options.body, fitting) + options.gap
  const across = Math.max(1, Math.min(zoom, (room + options.gap) / restPitch))
  const pitch = restPitch * across
  // The chromosome thickens with its column, to {@link BODY_ZOOM}; the lanes
  // take the rest of the column, each its share of what they had at rest.
  const bodyWidth = across > 1 ? Math.round(options.body * Math.min(across, BODY_ZOOM)) : options.body
  const held = fitting.reduce((sum, size) => sum + size, 0)
  const spare = pitch - options.gap - KARYOTYPE_GUTTER - bodyWidth - laneGap * drawn
  const lanes =
    across > 1 && held > 0
      ? fitting.map((size) => (size <= 0 ? 0 : Math.max(size, Math.floor((size * spare) / held))))
      : fitting
  const extent = extentOf(bodyWidth, lanes)
  const length = resting * zoom
  const perUnit = length / Math.max(1, longest)
  const crossTotal = count * pitch - options.gap
  const width = vertical ? 2 * KARYOTYPE_PAD + crossTotal : alongStart + length + KARYOTYPE_PAD
  const height = vertical ? alongStart + length + KARYOTYPE_PAD : options.top + 2 * KARYOTYPE_PAD + crossTotal

  // The window, through a camera: everything under the key, and the
  // chromosomes in the part of it past their names.
  const under = { x: 0, y: options.top, width: options.width, height: Math.max(0, options.height - options.top) }
  const view =
    camera === undefined
      ? null
      : vertical
        ? { x: 0, y: alongStart, width: options.width, height: Math.max(0, options.height - alongStart) }
        : { x: alongStart, y: options.top, width: Math.max(0, options.width - alongStart), height: under.height }
  const origin = {
    along: alongStart,
    across: (vertical ? KARYOTYPE_PAD : options.top + KARYOTYPE_PAD) - options.gap / 2,
  }
  const partsOf = (body: number, sizes: readonly number[], step: number): number[] => {
    const inner = [KARYOTYPE_GUTTER, body]
    for (const size of sizes) if (size > 0) inner.push(laneGap, size)
    // Lying, the lanes are over the chromosome and the strip under it.
    const ordered = vertical ? inner : inner.reverse()
    const used = options.gap / 2 + ordered.reduce((sum, size) => sum + size, 0)
    return [options.gap / 2, ...ordered, Math.max(0, step - used)]
  }
  const columns = { drawn: partsOf(bodyWidth, lanes, pitch), rest: partsOf(options.body, fitting, restPitch) }
  // The camera's point in the middle of the window, moved no further than the
  // picture goes. Magnified, a picture smaller than the window may also move
  // about inside it, so the point under the pointer stays there; at rest it
  // sits in the window's corner, as it is laid out.
  const centre = camera?.centre ?? null
  const wanted = { x: 0, y: 0 }
  if (view !== null && centre !== null) {
    const along = origin.along + centre.along * perUnit
    const acrossAt = origin.across + acrossPixel(columns, pitch, centre.across)
    wanted.x = (vertical ? acrossAt : along) - (view.x + view.width / 2)
    wanted.y = (vertical ? along : acrossAt) - (view.y + view.height / 2)
  }
  const hold = (pan: number, picture: number, window: number): number =>
    Math.max(zoom > 1 ? Math.min(0, picture - window) : 0, Math.min(Math.max(0, picture - window), pan))
  const pan = { x: hold(wanted.x, width, options.width), y: hold(wanted.y, height, options.height) }
  const panAlong = vertical ? pan.y : pan.x
  const panAcross = vertical ? pan.x : pan.y
  const boxOf = (box: ChromosomePlace['box']): ChromosomePlace['box'] => {
    if (camera === undefined) return box
    const x0 = Math.max(box.x, under.x)
    const y0 = Math.max(box.y, under.y)
    const x1 = Math.min(box.x + box.width, under.x + under.width)
    const y1 = Math.min(box.y + box.height, under.y + under.height)
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
  }

  // A column's stretch of the window, which its name keeps to.
  const spanOf = (from: number, low: number, high: number): [number, number] => [
    Math.max(from, low),
    Math.max(Math.max(from, low), Math.min(from + pitch, high)),
  ]

  const places = sequences.map((sequence, index): ChromosomePlace => {
    const cross = (vertical ? KARYOTYPE_PAD : options.top + KARYOTYPE_PAD) + index * pitch - panAcross
    const along0 = alongStart - panAlong
    const along1 = along0 + (sequence.unitEnd - sequence.unitStart) * perUnit
    // What of it the window shows, along — the lanes are cut to it, and the
    // body to it and its own thickness either side — and whether it shows any.
    const seen0 = view === null ? along0 : Math.max(along0, vertical ? view.y : view.x)
    const seen1 =
      view === null
        ? along1
        : Math.max(seen0, Math.min(along1, vertical ? view.y + view.height : view.x + view.width))
    const reach = view === null ? 0 : bodyWidth
    const body0 = Math.max(along0, Math.min(seen0, along1) - reach)
    const body1 = Math.max(body0, Math.min(along1, seen1 + reach))
    const visible =
      view === null ||
      (seen1 > seen0 &&
        (vertical
          ? cross + extent > view.x && cross < view.x + view.width
          : cross + extent > view.y && cross < view.y + view.height))
    const toPixel = (unit: number): number => along0 + (unit - sequence.unitStart) * perUnit
    const toUnit = (pixel: number): number => sequence.unitStart + (pixel - along0) / perUnit
    // A frame's ends exactly, where it runs to the chromosome's.
    const unitAt = (pixel: number): number =>
      pixel <= along0 ? sequence.unitStart : pixel >= along1 ? sequence.unitEnd : toUnit(pixel)
    const frameOf = (acrossFrom: number, thickness: number, from: number, to: number): LaneFrame => ({
      orientation: vertical ? 'right' : 'top',
      toPixel,
      toUnit,
      domain: [unitAt(from), unitAt(to)],
      alongFrom: from,
      alongTo: to,
      acrossFrom,
      thickness,
    })
    if (vertical) {
      // Standing: the anchors' strip, the chromosome, then each lane to the
      // right of the one before — `acrossFrom` is a lane's edge nearest the
      // chromosome, and across runs rightward from it.
      const near = cross + KARYOTYPE_GUTTER
      const body = frameOf(near, bodyWidth, body0, body1)
      let at = near + bodyWidth
      const frames = lanes.map((thickness) => {
        if (thickness > 0) at += laneGap
        const frame = frameOf(at, thickness, seen0, seen1)
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
        visible,
        across: [cross, cross + extent],
        box: boxOf({
          x: cross - options.gap / 2,
          y: options.top,
          width: pitch,
          height: options.names + length - panAlong,
        }),
        // Over its column, and held there — at the window's top — while the
        // chromosomes move under it.
        name: {
          x: near + bodyWidth / 2,
          y: options.top + options.names / 2,
          align: 'center',
          width: pitch - 2,
          ...(view === null ? {} : { span: spanOf(cross - options.gap / 2, view.x, view.x + view.width) }),
        },
      }
    }
    // Lying: the lanes above, the chromosome under them, the anchors' strip
    // under it — `acrossFrom` is a lane's lower edge, and across runs upward.
    const floor = cross + extent - KARYOTYPE_GUTTER
    const body = frameOf(floor, bodyWidth, body0, body1)
    let at = floor - bodyWidth
    const frames = lanes.map((thickness) => {
      if (thickness > 0) at -= laneGap
      const frame = frameOf(at, thickness, seen0, seen1)
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
      visible,
      across: [cross, cross + extent],
      box: boxOf({
        x: 0,
        y: cross - options.gap / 2,
        width: Math.max(options.width, alongStart + length - panAlong + KARYOTYPE_PAD),
        height: pitch,
      }),
      // Before its row, and held there — at the window's left — while the
      // chromosomes move under it.
      name: {
        x: KARYOTYPE_PAD + options.names - NAME_PAD,
        y: floor - bodyWidth / 2,
        align: 'right',
        width: Math.max(0, options.names - NAME_PAD),
        ...(view === null ? {} : { span: spanOf(cross - options.gap / 2, view.y, view.y + view.height) }),
      },
    }
  })

  return {
    orientation: options.orientation,
    places,
    lanes,
    factor,
    perUnit,
    width,
    height,
    zoom,
    across,
    most,
    pitch,
    columns,
    origin,
    pan,
    view,
  }
}

/**
 * A point within one column carried from one set of its parts to another: as
 * far into the same part, in proportion. The last part takes whatever is past
 * the rest.
 */
function remap(from: readonly number[], to: readonly number[], offset: number): number {
  let a = 0
  let b = 0
  for (let i = 0; i < from.length; i++) {
    const size = from[i]
    if (offset < a + size || i === from.length - 1) return b + (size > 0 ? ((offset - a) / size) * to[i] : 0)
    a += size
    b += to[i]
  }
  return b
}

/** How far across a column count is drawn, from the first column's edge. */
function acrossPixel(columns: KaryotypeLayout['columns'], pitch: number, across: number): number {
  const column = Math.floor(across)
  const rest = columns.rest.reduce((sum, size) => sum + size, 0)
  return column * pitch + remap(columns.rest, columns.drawn, (across - column) * rest)
}

/** …and the column count a distance across is, from the first column's edge. */
function acrossCount(columns: KaryotypeLayout['columns'], pitch: number, pixel: number): number {
  const column = Math.floor(pixel / pitch)
  const rest = columns.rest.reduce((sum, size) => sum + size, 0)
  return column + remap(columns.drawn, columns.rest, pixel - column * pitch) / Math.max(1e-9, rest)
}

/** Between a lying chromosome's name and the chromosome. */
const NAME_PAD = 8

// ---------------------------------------------------------------------------
// The chromosome itself
// ---------------------------------------------------------------------------

/**
 * Trace a chromosome with no bands to draw it by: a bar rounded at both
 * telomeres, as thick as its frame, as long as its sequence — a pill, and the
 * shape every ideogram draws a sequence its cytoBand does not cover. An end the
 * frame was cut short of (`ends`) is left square, out of the window, where the
 * chromosome carries on.
 */
export function tracePill(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  ends: { start: boolean; end: boolean } = { start: true, end: true },
): void {
  const half = frame.thickness / 2
  const a0 = frame.alongFrom
  const a1 = frame.alongTo
  // A cap is half the thickness, or half the length where the sequence is
  // shorter than it is thick: a plasmid at genome zoom is a dot, not a knot.
  const cap = Math.max(0, Math.min(half, (a1 - a0) / 2))
  const c0 = ends.start ? cap : 0
  const c1 = ends.end ? cap : 0
  laneMove(ctx, frame, a0 + c0, 0)
  laneLine(ctx, frame, a1 - c1, 0)
  if (c1 > 0) {
    laneCurve(ctx, frame, a1, 0, a1, half)
    laneCurve(ctx, frame, a1, frame.thickness, a1 - c1, frame.thickness)
  } else {
    laneLine(ctx, frame, a1, frame.thickness)
  }
  laneLine(ctx, frame, a0 + c0, frame.thickness)
  if (c0 > 0) {
    laneCurve(ctx, frame, a0, frame.thickness, a0, half)
    laneCurve(ctx, frame, a0, 0, a0 + c0, 0)
  } else {
    laneLine(ctx, frame, a0, 0)
  }
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
 * the pill's, and the outline edged once over it in the plot's ink. In its
 * body's frame, which a camera cuts to the window: an end cut off is out of
 * view, and is not rounded.
 */
export function drawChromosome(ctx: CanvasRenderingContext2D, place: ChromosomePlace, paint: ChromosomePaint): void {
  const frame = place.body
  const bands = paint.bands
  if (paint.fill.kind === 'bands' && bands !== null && bands.layout.placements.length > 0) {
    drawIdeogram(ctx, frame, bands.set, bands.layout, bands.paint, frame.thickness)
    return
  }
  const ends = { start: frame.alongFrom <= place.along0, end: frame.alongTo >= place.along1 }
  const trace = (): void => {
    ctx.beginPath()
    const traced = bands === null ? 0 : traceIdeogramOutline(ctx, frame, bands.set, bands.layout, frame.thickness)
    if (traced === 0) tracePill(ctx, frame, ends)
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
        // To the frame, which a feature as long as a chromosome arm runs far
        // past at a high magnification.
        const from = Math.max(alongs[i], frame.alongFrom)
        const to = Math.min(alongs[i + 1], frame.alongTo)
        if (!(to >= from)) continue
        const [bx, by, bw, bh] = laneRect(frame, from, to, 0, frame.thickness)
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
  // Through a camera, a curve that cannot cross the window is not drawn: its
  // control points share their ends' coordinates, so it stays inside the box
  // its two ends span, and a box that misses the window is a curve that does.
  const view = layout.view
  const misses = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    view !== null &&
    (Math.max(a.x, b.x) < view.x ||
      Math.min(a.x, b.x) > view.x + view.width ||
      Math.max(a.y, b.y) < view.y ||
      Math.min(a.y, b.y) > view.y + view.height)
  ctx.save()
  ctx.strokeStyle = paint.colour
  ctx.globalAlpha = paint.opacity * 0.5
  ctx.lineWidth = 1
  let drawn = 0
  ctx.beginPath()
  for (const i of chosen) {
    const a = pointOn(byContig.get(pairs.contigs[pairs.contig1[i]]), axis, pairs.contigs[pairs.contig1[i]], (pairs.start1[i] + pairs.end1[i]) / 2)
    const b = pointOn(byContig.get(pairs.contigs[pairs.contig2[i]]), axis, pairs.contigs[pairs.contig2[i]], (pairs.start2[i] + pairs.end2[i]) / 2)
    if (a === null || b === null || misses(a, b)) continue
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
  // Half a line, for a lying chromosome's name kept inside its row.
  const half = (Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '11') * 0.6)
  for (const place of layout.places) {
    const { align, width, span } = place.name
    let { x, y } = place.name
    if (width < 4) continue
    // Through a camera, slid along its column's stretch of the window to stay
    // in sight while any of the column is: the lanes still say whose they are
    // once the chromosome itself has gone past the edge. A chromosome nothing
    // of which is in the window — a short one ended above it — is not named
    // over the paper it left.
    if (span !== undefined) {
      if (!place.visible) continue
      const reach = layout.orientation === 'vertical' ? Math.min(ctx.measureText(place.contig).width, width) / 2 : half
      if (span[1] - span[0] < 2 * reach) continue
      if (layout.orientation === 'vertical') x = Math.max(span[0] + reach, Math.min(span[1] - reach, x))
      else y = Math.max(span[0] + reach, Math.min(span[1] - reach, y))
    }
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
  // Through a camera, inside the window: a magnified column runs past its
  // edges, and a chip written where the column ends is written nowhere.
  const view = layout.view
  const inX = (x: number, width: number): number =>
    view === null ? x : Math.max(view.x + 2, Math.min(view.x + view.width - width - 2, x))
  const inY = (y: number): number => (view === null ? y : Math.max(view.y + 2, Math.min(view.y + view.height - h - 2, y)))
  if (layout.orientation === 'vertical') {
    // Right of the chromosome's last lane, each chip level with its own end:
    // the low end's above its rule, the high end's below its own.
    const widest = Math.max(widthOf(first), widthOf(last), widthOf(selection.span))
    const x = inX(place.across[1] + 4, widest)
    chip(first, x, inY(low - h - 2))
    chip(last, x, inY(high + 2))
    if (high - low > 2 * h + 6) chip(selection.span, x, inY((low + high) / 2 - h / 2))
  } else {
    // Over the chromosome's lanes, each chip outside its own end.
    const y = inY(place.across[0] - h - 3)
    chip(first, inX(low - widthOf(first) - 3, widthOf(first)), y)
    chip(last, inX(high + 3, widthOf(last)), y)
    if (high - low > widthOf(selection.span) + 8) {
      chip(selection.span, inX((low + high) / 2 - widthOf(selection.span) / 2, widthOf(selection.span)), inY(y - h - 3))
    }
  }
  ctx.restore()
}

/**
 * Where the window is over a picture larger than it, on screen: a thin bar
 * along the window's foot for the picture's width, and one down its right edge
 * for its height — a scrollbar's thumb, drawn, which says there is more of the
 * picture than the window shows and which part of it is shown. Nothing where
 * the picture fits, and nothing without a camera.
 */
export function drawWindowPlace(
  ctx: CanvasRenderingContext2D,
  layout: KaryotypeLayout,
  window: { width: number; height: number },
  colour: string,
): void {
  const view = layout.view
  if (view === null) return
  const bar = 3
  const inset = 2
  ctx.save()
  ctx.fillStyle = colour
  ctx.globalAlpha = 0.35
  const thumb = (x: number, y: number, width: number, height: number): void => {
    ctx.beginPath()
    if (ctx.roundRect === undefined) ctx.rect(x, y, width, height)
    else ctx.roundRect(x, y, width, height, bar / 2)
    ctx.fill()
  }
  if (layout.width > window.width + 0.5) {
    const span = view.width - 2 * inset
    const from = (Math.max(0, layout.pan.x) / layout.width) * span
    const to = (Math.min(layout.width, layout.pan.x + window.width) / layout.width) * span
    thumb(view.x + inset + from, view.y + view.height - bar - inset, Math.max(bar, to - from), bar)
  }
  if (layout.height > window.height + 0.5) {
    const span = view.height - 2 * inset
    const from = (Math.max(0, layout.pan.y) / layout.height) * span
    const to = (Math.min(layout.height, layout.pan.y + window.height) / layout.height) * span
    thumb(view.x + view.width - bar - inset, view.y + inset + from, bar, Math.max(bar, to - from))
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

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/** The point of the picture at a point of the window (or of the picture, laid out without a camera). */
export function pointAt(layout: KaryotypeLayout, x: number, y: number): KaryotypePoint {
  const vertical = layout.orientation === 'vertical'
  const along = (vertical ? y + layout.pan.y : x + layout.pan.x) - layout.origin.along
  const across = (vertical ? x + layout.pan.x : y + layout.pan.y) - layout.origin.across
  return { along: along / layout.perUnit, across: acrossCount(layout.columns, layout.pitch, across) }
}

/** Where a point of the picture is drawn: in the window (or in the picture, laid out without a camera). */
export function pixelOf(layout: KaryotypeLayout, point: KaryotypePoint): { x: number; y: number } {
  const along = layout.origin.along + point.along * layout.perUnit
  const across = layout.origin.across + acrossPixel(layout.columns, layout.pitch, point.across)
  return layout.orientation === 'vertical'
    ? { x: across - layout.pan.x, y: along - layout.pan.y }
    : { x: along - layout.pan.x, y: across - layout.pan.y }
}

/** The middle of the window the chromosomes are seen in — of the whole picture, laid out without a camera. */
export function middleOf(layout: KaryotypeLayout): { x: number; y: number } {
  const view = layout.view ?? { x: 0, y: 0, width: layout.width, height: layout.height }
  return { x: view.x + view.width / 2, y: view.y + view.height / 2 }
}

/** The camera a layout was drawn through, its point in the middle as the picture held it. */
export function cameraOf(layout: KaryotypeLayout): KaryotypeCamera {
  const middle = middleOf(layout)
  return { zoom: layout.zoom, centre: pointAt(layout, middle.x, middle.y) }
}

/**
 * The camera that magnifies the picture to `zoom` about a point of the window,
 * what is under that point staying there (§5.10). `layout` is the picture on
 * screen, and `relayout` lays the same picture out at another magnification.
 * The zoom is held to what the picture allows — one at the least, a base a
 * pixel at the most — and the point in the middle to what it can show there
 * when it is laid out.
 */
export function zoomAbout(
  layout: KaryotypeLayout,
  x: number,
  y: number,
  zoom: number,
  relayout: (zoom: number) => KaryotypeLayout,
): KaryotypeCamera {
  const point = pointAt(layout, x, y)
  const next = Math.min(layout.most, Math.max(1, zoom))
  // Magnified from its corner, the point is somewhere in the picture: moved
  // so it is back under the pointer, the window's middle is over the point
  // the camera is to be held on.
  const magnified = relayout(next)
  const at = pixelOf(magnified, point)
  const moved = { ...magnified, pan: { x: magnified.pan.x + at.x - x, y: magnified.pan.y + at.y - y } }
  const middle = middleOf(moved)
  return { zoom: next, centre: pointAt(moved, middle.x, middle.y) }
}

/**
 * The camera moved by a drag of `(dx, dy)` pixels, or a scroll: the picture
 * follows the hand, so the point now in the middle is the one that was that
 * far the other way.
 */
export function panBy(layout: KaryotypeLayout, dx: number, dy: number): KaryotypeCamera {
  const middle = middleOf(layout)
  return { zoom: layout.zoom, centre: pointAt(layout, middle.x - dx, middle.y - dy) }
}

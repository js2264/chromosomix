/**
 * Splice junctions, drawn as a sashimi plot's arcs (§8.23).
 *
 * An arc from the end of one exon to the start of the next — the intron a read
 * was seen to skip — as tall as its read count against the lane's ceiling, and
 * labelled with that count at its apex. That is the picture every reader of
 * RNA-seq has learnt alternative splicing from: two arcs leaving one exon are
 * two isoforms, and the counts over them say which is used how much.
 *
 * ## Where the arcs stand
 *
 * On one baseline, growing the way every value in this application grows
 * (`laneGrowsInward`): up the page on a horizontal lane, across it on a
 * vertical one. A file with junctions on **both** strands splits the lane, as
 * IGV's junction track does: the baseline moves to the middle, forward arcs
 * rise from it and reverse arcs hang from it, so the two strands of a
 * bidirectional locus read as two families rather than one tangle. A junction
 * with no strand — a non-canonical intron in an unstranded library — stands
 * with the forward ones, in the grey that means *no answer* (§8.16).
 *
 * ## The axis
 *
 * An arc's height is its count against the lane's **limits** (§8.17's third
 * reading): zero to the largest count in view until the reader types a pair
 * ({@link junctionLimits} says why in view), and then that pair, which is the
 * only way two samples' lanes are drawn against one scale. The floor is also a
 * filter, which is what a sashimi plot's minimum junction coverage is: a
 * junction under it is not drawn at all. Over the ceiling it draws full height
 * rather than out of the lane. Every drawn arc is at least an eighth of the
 * height, because a one-read arc against a ceiling of three hundred is
 * otherwise a line along the baseline, indistinguishable from it — the floor
 * twelve-pixel-high density strips keep for the same reason.
 *
 * ## Too narrow to be an arc
 *
 * An intron narrower than two pixels is drawn as a **spike** of the same height
 * at its middle. At chromosome zoom that turns the lane into a map of where
 * splicing is and how much of it, which is the one reading left at that scale
 * — rather than a fringe of sub-pixel humps along the baseline.
 */

import type { FeatureSet } from '../annotations/types'
import type { FeatureLayout, FeaturePaint, FeaturePlacement } from './features'
import {
  OUTLINE_WIDTH,
  canvasToAcross,
  laneCurve,
  laneIsHorizontal,
  laneLine,
  laneMove,
  laneText,
  valueAcross,
  type LaneFrame,
} from './lane'

/** One drawn arc, kept on the layout so the hit test finds exactly what was drawn. */
export interface JunctionArc {
  /** Index into the set. */
  index: number
  /** The intron's two ends, in canvas pixels along the lane. */
  along0: number
  along1: number
  /** The baseline it stands on, and the across-offset of its apex. */
  base: number
  apex: number
}

/** The shortest drawn arc, as a share of the height its side has. */
const LEAST_HEIGHT = 1 / 8

/** Narrower than this and an intron is a spike rather than an arc, in pixels. */
const SPIKE_BELOW = 2

/** The thinnest and thickest an arc is stroked, in pixels. */
const THIN = 1
const THICK = 3.5

/**
 * How many arcs a lane draws before it stops, strongest first.
 *
 * A whole human chromosome is a few hundred thousand junctions in a deep file,
 * and past a few thousand strokes the lane is a solid wash that no more strokes
 * can change — so the strongest are drawn and the caption says how many were.
 */
export const ARC_CAP = 4000

/** Where a lane's arcs stand, and which way each strand grows. */
interface Sides {
  /** The baseline, in across-coordinates. */
  base: number
  /** How far an arc may rise on each side, in pixels, after its label. */
  room: number
  /** `+1` or `-1`: which way across a forward arc grows. */
  up: number
  /** Whether reverse arcs hang the other way from the same baseline. */
  split: boolean
}

function sidesOf(frame: LaneFrame, split: boolean, label: number, flip: boolean): Sides {
  // A flipped lane grows the other way, from the other edge — which is how a
  // coverage lane read downwards carries its arcs with it (§8.13, §8.23).
  const up = (Math.sign(valueAcross(frame, 1) - valueAcross(frame, 0)) || -1) * (flip ? -1 : 1)
  if (split) {
    const base = frame.thickness / 2
    return { base, room: Math.max(2, frame.thickness / 2 - label - 1), up, split }
  }
  const base = valueAcross(frame, flip ? 1 : 0)
  return { base, room: Math.max(2, frame.thickness - label - 2), up, split }
}

/**
 * How a lane of arcs stands, where its caller decides rather than its file.
 *
 * `split` is a junction file's own question — both strands in it — and a
 * coverage lane's arcs answer it `false`, since the depth under them has one
 * baseline and a reverse arc hanging below it would hang out of the lane.
 */
export interface ArcOptions {
  split?: boolean
  flip?: boolean
}

/** Whether a set has junctions on both strands, which is what splits the lane. */
export function hasBothStrands(set: FeatureSet): boolean {
  let forward = false
  let reverse = false
  for (let i = 0; i < set.length; i++) {
    if (set.strand[i] > 0) forward = true
    else if (set.strand[i] < 0) reverse = true
    if (forward && reverse) return true
  }
  return false
}

/**
 * How tall a count stands, as a share of its side: `NaN` for a junction the
 * floor filters out.
 */
function heightOf(count: number, limits: { min: number; max: number }): number {
  if (!Number.isFinite(count) || count < limits.min) return Number.NaN
  const span = limits.max - limits.min
  const t = span > 0 ? (count - limits.min) / span : 1
  return LEAST_HEIGHT + (1 - LEAST_HEIGHT) * Math.max(0, Math.min(1, t))
}

/**
 * The junctions in view that clear the floor, strongest first, capped at
 * {@link ARC_CAP} — and how many cleared it.
 */
function chosen(
  set: FeatureSet,
  layout: FeatureLayout,
  limits: { min: number; max: number },
): { drawn: FeaturePlacement[]; passed: number } {
  const passed = layout.placements.filter((placement) => {
    const count = set.score[placement.index]
    return Number.isFinite(count) && count >= limits.min
  })
  // Weakest first, so the strongest are painted last and sit on top.
  passed.sort((a, b) => set.score[a.index] - set.score[b.index])
  return { drawn: passed.slice(Math.max(0, passed.length - ARC_CAP)), passed: passed.length }
}

/**
 * The axis a junction lane is drawn against: the reader's, or — under `auto` —
 * zero to the largest count **in view**.
 *
 * In view rather than in the file, and this is the one feature lane that says
 * so (§8.17 fits a barChart to the file). Junction counts are heavier-tailed
 * than expression: in the GBR sample's chrX, TMSB4X's second intron carries
 * 2,800 reads, 23 junctions of 2,967 reach a hundred and half have two or
 * fewer, so against the file every gene but a handful is a row of flat humps.
 * What makes the window safe here, where it is not for a chart, is the reason
 * a track's autoscale is safe: every arc is labelled with its count, and the
 * caption restates the ceiling on every frame. A reader comparing two samples
 * types one pair of limits, which holds across windows and lanes both. With no
 * layout, the file's largest count.
 */
export function junctionLimits(
  set: FeatureSet,
  fixed: { min: number; max: number } | undefined,
  layout?: FeatureLayout,
): { min: number; max: number } {
  if (fixed !== undefined) return fixed
  let top = 0
  if (layout === undefined) {
    for (let i = 0; i < set.length; i++) {
      const value = set.score[i]
      if (Number.isFinite(value) && value > top) top = value
    }
  } else {
    for (const placement of layout.placements) {
      const value = set.score[placement.index]
      if (Number.isFinite(value) && value > top) top = value
    }
  }
  return { min: 0, max: top > 0 ? top : 1 }
}

/**
 * Draw a lane of junctions as arcs (§8.23).
 *
 * The arcs drawn are written onto the layout ({@link JunctionArc}), so a click
 * is tested against the curves on screen rather than against boxes the size of
 * each intron — nested arcs share their span, and a box test would name the
 * last of them whichever one the pointer was on.
 */
export function drawJunctions(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  options: ArcOptions = {},
): void {
  const limits = junctionLimits(set, paint.axisLimits, layout)
  const labelRoom = paint.labels ? (paint.labelBand ?? 11) : 0
  const sides = sidesOf(frame, options.split ?? hasBothStrands(set), labelRoom, options.flip === true)
  const { drawn } = chosen(set, layout, limits)
  const arcs: JunctionArc[] = []
  layout.arcs = arcs

  ctx.save()
  // The baseline, faint: what the arcs stand on, and — on a split lane — the
  // line the two strands are read either side of.
  ctx.globalAlpha = paint.opacity * 0.45
  ctx.strokeStyle = paint.guideColour
  ctx.lineWidth = OUTLINE_WIDTH
  ctx.beginPath()
  laneMove(ctx, frame, frame.alongFrom, sides.base)
  laneLine(ctx, frame, frame.alongTo, sides.base)
  ctx.stroke()

  // Grouped by ink and by stroke width, so a lane of four thousand arcs is a
  // few dozen strokes rather than four thousand.
  const groups = new Map<string, JunctionArc[]>()
  for (const placement of drawn) {
    const index = placement.index
    const height = heightOf(set.score[index], limits)
    if (!Number.isFinite(height)) continue
    const direction = sides.split && set.strand[index] < 0 ? -sides.up : sides.up
    const apex = sides.base + direction * height * sides.room
    const arc: JunctionArc = { index, along0: placement.along0, along1: placement.along1, base: sides.base, apex }
    arcs.push(arc)
    const width = Math.round((THIN + (THICK - THIN) * Math.sqrt(Math.max(0, (height - LEAST_HEIGHT) / (1 - LEAST_HEIGHT)))) * 2) / 2
    const ink = paint.colourOf === undefined ? paint.colour : paint.colourOf(index)
    const key = `${ink}|${width}`
    const held = groups.get(key)
    if (held === undefined) groups.set(key, [arc])
    else held.push(arc)
  }
  ctx.globalAlpha = paint.opacity * 0.9
  ctx.lineCap = 'round'
  for (const [key, members] of groups) {
    const [ink, width] = key.split('|')
    ctx.strokeStyle = ink
    ctx.lineWidth = Number(width)
    ctx.beginPath()
    for (const arc of members) arcPath(ctx, frame, arc)
    ctx.stroke()
  }
  ctx.globalAlpha = paint.opacity
  if (paint.labels) labelArcs(ctx, frame, set, arcs, paint)
  ctx.restore()
}

/** One arc's curve, or its spike where it is too narrow to be one. */
function arcPath(ctx: CanvasRenderingContext2D, frame: LaneFrame, arc: JunctionArc): void {
  const middle = (arc.along0 + arc.along1) / 2
  if (arc.along1 - arc.along0 < SPIKE_BELOW) {
    laneMove(ctx, frame, middle, arc.base)
    laneLine(ctx, frame, middle, arc.apex)
    return
  }
  // A quadratic whose control point is twice the apex's height, at the middle:
  // the curve peaks exactly at the apex, and its position along the lane is
  // linear in its parameter — which is what lets the hit test invert it.
  laneMove(ctx, frame, arc.along0, arc.base)
  laneCurve(ctx, frame, middle, arc.base + 2 * (arc.apex - arc.base), arc.along1, arc.base)
}

/**
 * Whether another drawn arc's line runs through a box, in lane coordinates.
 *
 * An arc's curve is concave, so over a stretch of its span its across-values
 * lie between those at the stretch's two ends and, where the stretch holds the
 * middle, the apex; a spike is its one vertical line. The line crosses the box
 * where that range meets the box's.
 */
function crossedBy(
  arcs: readonly JunctionArc[],
  self: JunctionArc,
  from: number,
  to: number,
  low: number,
  high: number,
): boolean {
  for (const other of arcs) {
    if (other === self || other.along1 < from || other.along0 > to) continue
    const middle = (other.along0 + other.along1) / 2
    const span = other.along1 - other.along0
    let near: number
    let far: number
    if (span < SPIKE_BELOW) {
      if (middle < from || middle > to) continue
      near = Math.min(other.base, other.apex)
      far = Math.max(other.base, other.apex)
    } else {
      const at = (along: number): number => {
        const t = (along - other.along0) / span
        return other.base + 4 * (other.apex - other.base) * t * (1 - t)
      }
      const a = at(Math.max(from, other.along0))
      const b = at(Math.min(to, other.along1))
      near = Math.min(a, b)
      far = Math.max(a, b)
      if (middle > from && middle < to) {
        near = Math.min(near, other.apex)
        far = Math.max(far, other.apex)
      }
    }
    if (far >= low && near <= high) return true
  }
  return false
}

/**
 * Each arc's count at its apex, where it fits: the strongest first, and none
 * over another already written or over another arc's line — a count that sits
 * on two arcs is a count for neither.
 */
function labelArcs(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  arcs: readonly JunctionArc[],
  paint: FeaturePaint,
): void {
  ctx.save()
  ctx.font = paint.font
  ctx.fillStyle = paint.guideColour
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lo = Math.min(frame.alongFrom, frame.alongTo) + 1
  const hi = Math.max(frame.alongFrom, frame.alongTo) - 1
  const tall = paint.labelBand ?? 11
  const taken: Array<[number, number, number]> = []
  const byCount = [...arcs].sort((a, b) => set.score[b.index] - set.score[a.index])
  for (const arc of byCount) {
    const text = formatCount(set.score[arc.index])
    const width = ctx.measureText(text).width
    const middle = (arc.along0 + arc.along1) / 2
    if (middle - width / 2 < lo || middle + width / 2 > hi) continue
    // A count may be wider than its arc — EFB1's 659 over a 366-base intron is,
    // beside a map — and it is still that arc's: written at its apex, strongest
    // first, and never beside another count, which is what would make it read
    // as a neighbour's.
    const beyond = Math.sign(arc.apex - arc.base) || 1
    const across = arc.apex + beyond * (tall / 2 + 1)
    // A gap of a digit's width at least: `13` beside `1` three pixels away is
    // read as `131`, a count no junction here has.
    const gap = 8
    const clash = taken.some(
      ([from, to, at]) =>
        middle + width / 2 + gap > from && middle - width / 2 - gap < to && Math.abs(at - across) < tall,
    )
    if (clash) continue
    // …nor where another arc's line runs through it: DDX3X's acceptors three
    // bases apart are three arcs on one span, and the one-read arc's `1` landed
    // on the six-read arc's line and was read as its count. The box is a pixel
    // inside the label's band, so a curve grazing the band's edge does not count.
    const half = tall / 2 - 1
    if (crossedBy(arcs, arc, middle - width / 2, middle + width / 2, across - half, across + half)) continue
    taken.push([middle - width / 2, middle + width / 2, across])
    laneText(ctx, frame, text, middle, across, { halo: paint.haloColour })
  }
  ctx.restore()
}

/** A count as a label: whole numbers as they are, anything else to one place. */
function formatCount(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US')
  return value.toFixed(1)
}

/**
 * The drawn arc under a canvas point, or `null`: the nearest curve within a few
 * pixels, the stronger of two equally near.
 */
export function junctionAt(
  frame: LaneFrame,
  layout: FeatureLayout,
  x: number,
  y: number,
): FeaturePlacement | null {
  const arcs = layout.arcs
  if (arcs === undefined) return null
  const along = laneIsHorizontal(frame.orientation) ? x : y
  const across = canvasToAcross(frame, laneIsHorizontal(frame.orientation) ? y : x)
  if (across < 0 || across > frame.thickness) return null
  const reach = 4
  let best: JunctionArc | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let bestHeight = 0
  for (const arc of arcs) {
    const span = arc.along1 - arc.along0
    let distance: number
    if (span < SPIKE_BELOW) {
      const middle = (arc.along0 + arc.along1) / 2
      const lowest = Math.min(arc.base, arc.apex)
      const highest = Math.max(arc.base, arc.apex)
      if (Math.abs(along - middle) > reach || across < lowest - reach || across > highest + reach) continue
      distance = Math.abs(along - middle)
    } else {
      if (along < arc.along0 - reach || along > arc.along1 + reach) continue
      const t = Math.max(0, Math.min(1, (along - arc.along0) / span))
      // The curve's across at that parameter: base + 4·(apex − base)·t·(1 − t).
      const curve = arc.base + 4 * (arc.apex - arc.base) * t * (1 - t)
      distance = Math.abs(across - curve)
    }
    if (distance > reach) continue
    // The nearest curve; between two within half a pixel of each other — two
    // arcs crossing under the pointer — the taller, which is the stronger.
    const height = Math.abs(arc.apex - arc.base)
    if (distance < bestDistance - 0.5 || (distance <= bestDistance + 0.5 && height > bestHeight)) {
      best = arc
      bestDistance = distance
      bestHeight = height
    }
  }
  if (best === null) return null
  const index = best.index
  return layout.placements.find((placement) => placement.index === index) ?? null
}

/**
 * The line under a junction lane's name: how many arcs are drawn and what the
 * top of the lane means — the one fact the arcs, which carry no axis, cannot
 * say for themselves (§8.17's argument for a barChart's caption).
 */
export function junctionCaption(
  set: FeatureSet,
  layout: FeatureLayout,
  fixed: { min: number; max: number } | undefined,
  int: (value: number) => string,
): string {
  const inView = layout.placements.length
  if (inView === 0) return 'no junctions in view'
  const limits = junctionLimits(set, fixed, layout)
  const { drawn, passed } = chosen(set, layout, limits)
  // Short, because it is written in the name's column: the count, the ceiling,
  // and the floor where one was typed — `66 of 68 · 1–400 reads`.
  const count =
    drawn.length < passed
      ? `strongest ${int(drawn.length)} of ${int(inView)}`
      : passed === inView
        ? `${int(inView)} junction${inView === 1 ? '' : 's'}`
        : `${int(passed)} of ${int(inView)}`
  const axis = fixed === undefined ? `to ${int(limits.max)} reads` : `${int(limits.min)}–${int(limits.max)} reads`
  return `${count} · ${axis}`
}

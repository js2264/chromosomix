/**
 * A karyotype, drawn along its lane (§8.22).
 *
 * The chromosome is **one shape**, and the bands are colours inside it. That is
 * the whole difference from every other feature lane, where each row of the
 * file is a box of its own: here the rows tile one outline, and the outline is
 * what says *chromosome* — rounded at a telomere, pinched to a waist at the
 * centromere, narrowed along a stalk. So each sequence in view is traced once,
 * as a polygon along its top edge and back along its bottom, the bands are
 * filled inside it as plain rectangles clipped to it, and it is edged once in
 * the plot's ink. A centromere's triangles are not drawn as triangles: they are
 * what the rectangles of two `acen` bands look like inside a waist.
 *
 * ## The stains
 *
 * Physical, and the same in both themes. A Giemsa band is dark or light on a
 * metaphase spread, and a reader who knows ideograms reads `gpos100` as black:
 * turning the ramp over for a dark page would draw every G-light band dark.
 * `gposN` is N % of the way from the unstained colour to the darkest one — how
 * UCSC and IGV read the number — the centromere is the red every ideogram gives
 * it, `gvar` is hatched because it is *variable* rather than a darkness, and a
 * stalk is a paler, narrower stretch of the outline.
 *
 * ## One axis
 *
 * The bands are drawn where they are, on the lane's own axis (§8.4) — this is
 * not IGV's whole-chromosome thumbnail with the window boxed in red, which
 * would be a second coordinate system beside the one every other lane shares.
 * Zoomed out, the lane is the ideogram; zoomed in, it is the bands under the
 * window, named, which is what the caption under the lane's name says too.
 */

import { iscnName, stainOf } from '../annotations/cytoband'
import type { FeatureSet } from '../annotations/types'
import type { FeatureLayout, FeaturePaint, FeaturePlacement } from './features'
import {
  OUTLINE_WIDTH,
  laneCurve,
  laneLine,
  laneMove,
  laneRect,
  laneText,
  type LaneFrame,
} from './lane'

/** The unstained colour, `gneg` — and the light end of the `gposN` ramp. */
const UNSTAINED: readonly [number, number, number] = [247, 247, 245]

/** The darkest stain, `gpos100`. Not quite black, so an outline still shows on it. */
const DARKEST: readonly [number, number, number] = [26, 26, 28]

/** The centromere's red. */
export const ACEN_COLOUR = '#b3322b'

/** Variable heterochromatin's ground, and the hatching over it. */
export const GVAR_COLOUR = '#cfd6e3'
const GVAR_HATCH = '#76819a'

/** A stalk's grey: paler than a stain, because a stalk is where there is little to stain. */
export const STALK_COLOUR = '#b7bbc2'

/**
 * How much of the body's half-height a stalk keeps, and how much the
 * centromere's waist does.
 *
 * A half for the stalk, which is how much narrower an acrocentric's stalk is
 * drawn in every ideogram. A fifth at the waist rather than nothing: pinched to
 * a point the outline is two shapes touching, and its edge crosses itself there.
 */
const STALK_WAIST = 0.5
const CENTROMERE_WAIST = 0.2

/**
 * The narrowest a centromere is drawn, in pixels.
 *
 * A human centromere is megabases and draws itself. A yeast CEN is 118 bases —
 * a hairline at any zoom where the chromosome is on screen — so it is widened
 * to this, centred on itself, for the reason a variant is widened to three
 * pixels (§8.14): a mark too narrow to see is not a mark. The bands either side
 * are drawn under it where it overlaps them.
 */
const CENTROMERE_MIN_PX = 6

/** The tallest the body is drawn, however thick the lane. */
const MAX_BODY = 22

/** The colour a stain is drawn in. */
export function stainColour(stain: string): string {
  if (stain === 'acen') return ACEN_COLOUR
  if (stain === 'gvar') return GVAR_COLOUR
  if (stain === 'stalk') return STALK_COLOUR
  let darkness = 0
  if (stain.startsWith('gpos')) {
    const rest = stain.slice(4)
    const value = rest === '' ? 100 : Number(rest)
    darkness = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : 1
  }
  const mix = (at: number): number => Math.round(UNSTAINED[at] + (DARKEST[at] - UNSTAINED[at]) * darkness)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

/** Whether text on a band of this stain should be light rather than dark. */
function darkBand(stain: string): boolean {
  if (stain === 'acen') return true
  if (!stain.startsWith('gpos')) return false
  const rest = stain.slice(4)
  const value = rest === '' ? 100 : Number(rest)
  return !Number.isFinite(value) || value >= 50
}

/** The stains a key lists, in the order UCSC's own legend gives them. */
export const STAIN_ORDER: readonly string[] = [
  'gneg',
  'gpos25',
  'gpos33',
  'gpos50',
  'gpos66',
  'gpos75',
  'gpos100',
  'gpos',
  'acen',
  'gvar',
  'stalk',
]

/** What a key calls a stain: the file's word, with what it means. */
export function stainLabel(stain: string): string {
  if (stain === 'gneg') return 'gneg · unstained'
  if (stain === 'acen') return 'acen · centromere'
  if (stain === 'gvar') return 'gvar · variable'
  if (stain === 'stalk') return 'stalk'
  if (stain === 'gpos') return 'gpos · stained'
  return stain
}

/**
 * One sequence's run of placed bands, and what the outline needs to know about
 * where the chromosome itself begins and ends.
 */
interface Run {
  placements: FeaturePlacement[]
  /** Whether the chromosome's first base, and its last, are among the bands in view. */
  startsHere: boolean
  endsHere: boolean
}

/**
 * The placements, cut into one run per sequence.
 *
 * A layout lists every window's features in axis order, one window after the
 * next, so a new sequence is a placement whose band belongs to another contig
 * than the one before it — or the same contig drawn again, as a circle across
 * its junction is, which begins again at an along before the last one's end.
 */
function runsOf(set: FeatureSet, layout: FeatureLayout): Run[] {
  const runs: Run[] = []
  let current: FeaturePlacement[] = []
  let contig = -1
  let lastAlong = Number.NEGATIVE_INFINITY
  const close = (): void => {
    if (current.length === 0) return
    const first = current[0].index
    const last = current[current.length - 1].index
    const c = set.contig[first]
    runs.push({
      placements: current,
      // The file's first band of the sequence, starting at its first base; and
      // its last band, which ends where the sequence does if anything does.
      startsHere: first === set.contigAt[c] && set.start[first] === 0,
      endsHere: last === set.contigAt[c + 1] - 1,
    })
    current = []
  }
  for (const placement of layout.placements) {
    const c = set.contig[placement.index]
    if (c !== contig || placement.along0 < lastAlong - 0.5) {
      close()
      contig = c
    }
    current.push(placement)
    lastAlong = placement.along1
  }
  close()
  return runs
}

/** One vertex of a run's outline: where along, and how far from the midline. */
interface Vertex {
  along: number
  half: number
}

/**
 * A run's top edge, left to right, as vertices of the half-height.
 *
 * Every band contributes its two ends at the body's half-height, a stalk its
 * two ends at the stalk's, and a run of `acen` bands a waist: full at the run's
 * ends, pinched at the centromere — where the first band whose name is on the q
 * arm begins, or the middle of the run where the names do not say.
 */
function edgeOf(
  set: FeatureSet,
  run: Run,
  half: number,
): { edge: Vertex[]; centromeres: Array<{ from: number; to: number; index: number }> } {
  const out: Vertex[] = []
  const centromeres: Array<{ from: number; to: number; index: number }> = []
  const bands = run.placements
  for (let k = 0; k < bands.length; k++) {
    const placement = bands[k]
    const stain = stainOf(set.detail[placement.index])
    if (stain === 'acen') {
      // The whole run of centromeric bands, handled at once.
      let end = k
      while (end + 1 < bands.length && stainOf(set.detail[bands[end + 1].index]) === 'acen') end++
      let from = placement.along0
      let to = bands[end].along1
      let pinch = (from + to) / 2
      for (let j = k; j <= end; j++) {
        if (set.name[bands[j].index].startsWith('q')) {
          pinch = bands[j].along0
          break
        }
      }
      // Widened to be seen, and centred on itself (see CENTROMERE_MIN_PX) —
      // taking back whatever of the edge before it the widened waist now
      // covers, so the waist is as wide on the p side as on the q side.
      if (to - from < CENTROMERE_MIN_PX) {
        from = pinch - CENTROMERE_MIN_PX / 2
        to = pinch + CENTROMERE_MIN_PX / 2
        while (out.length > 0 && out[out.length - 1].along > from) out.pop()
      }
      out.push({ along: from, half }, { along: pinch, half: half * CENTROMERE_WAIST }, { along: to, half })
      centromeres.push({ from, to, index: placement.index })
      k = end
      continue
    }
    const at = stain === 'stalk' ? half * STALK_WAIST : half
    out.push({ along: placement.along0, half: at }, { along: placement.along1, half: at })
  }
  // In order, and never backwards: a centromere widened past its neighbours
  // would otherwise fold the edge over itself.
  let furthest = Number.NEGATIVE_INFINITY
  const kept: Vertex[] = []
  for (const vertex of out) {
    if (vertex.along < furthest) continue
    kept.push(vertex)
    furthest = vertex.along
  }
  return { edge: kept, centromeres }
}

/**
 * Trace one run's outline: along the top from the near end, round the far
 * telomere if it is in view, back along the bottom, round the near one.
 *
 * `centre` is the midline, in across-coordinates, and the telomeres are the
 * body's own half-height round — capped by half the run's length, so a
 * chromosome a few pixels long at genome zoom is a pill rather than a knot.
 */
function tracePath(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  edge: Vertex[],
  centre: number,
  run: Run,
): void {
  if (edge.length === 0) return
  const first = edge[0]
  const last = edge[edge.length - 1]
  const length = last.along - first.along
  const capOf = (vertex: Vertex, here: boolean): number =>
    here ? Math.max(0, Math.min(vertex.half, length / 2)) : 0
  const nearCap = capOf(first, run.startsHere)
  const farCap = capOf(last, run.endsHere)
  // The top edge, left to right, with each cap's straight part removed from
  // the vertices it would otherwise run through.
  laneMove(ctx, frame, first.along + nearCap, centre - first.half)
  for (const vertex of edge) {
    const along = Math.min(Math.max(vertex.along, first.along + nearCap), last.along - farCap)
    laneLine(ctx, frame, along, centre - vertex.half)
  }
  if (farCap > 0) {
    laneCurve(ctx, frame, last.along, centre - last.half, last.along, centre)
    laneCurve(ctx, frame, last.along, centre + last.half, last.along - farCap, centre + last.half)
  } else {
    laneLine(ctx, frame, last.along, centre - last.half)
    laneLine(ctx, frame, last.along, centre + last.half)
  }
  for (let k = edge.length - 1; k >= 0; k--) {
    const vertex = edge[k]
    const along = Math.min(Math.max(vertex.along, first.along + nearCap), last.along - farCap)
    laneLine(ctx, frame, along, centre + vertex.half)
  }
  if (nearCap > 0) {
    laneCurve(ctx, frame, first.along, centre + first.half, first.along, centre)
    laneCurve(ctx, frame, first.along, centre - first.half, first.along + nearCap, centre - first.half)
  } else {
    laneLine(ctx, frame, first.along, centre + first.half)
    laneLine(ctx, frame, first.along, centre - first.half)
  }
  ctx.closePath()
}

/** How tall the chromosome is drawn in a lane this thick, in pixels. */
export function ideogramBody(thickness: number): number {
  return Math.max(4, Math.min(MAX_BODY, thickness - 6))
}

/**
 * Trace each chromosome's outline into the current path, and fill and stroke
 * nothing: one closed subpath a run, the shape {@link drawIdeogram} fills its
 * bands inside. What the ideogram view clips a chromosome's own colouring to
 * (§5.10), so a body coloured by a track still pinches at its centromere and
 * rounds at its telomeres. Returns how many runs it traced — none where the
 * file has no band on the sequences in view.
 */
export function traceIdeogramOutline(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  body = ideogramBody(frame.thickness),
): number {
  let traced = 0
  for (const run of runsOf(set, layout)) {
    const { edge } = edgeOf(set, run, body / 2)
    if (edge.length === 0) continue
    tracePath(ctx, frame, edge, frame.thickness / 2, run)
    traced++
  }
  return traced
}

/**
 * Draw an ideogram's bands (§8.22).
 *
 * Every placement is drawn, whatever `layout.dense` says: the collapse to a
 * density is for features that overlap, and bands tile — a genome's worth of
 * them at a pixel apiece is still the karyotype, which is what a reader zoomed
 * out that far is looking at.
 *
 * `body` is how thick the chromosome is drawn: the lane's own rule by default,
 * which keeps room round it for the lane's label, and the frame's whole
 * thickness in the ideogram view, where the frame *is* the chromosome and its
 * width is the reader's to set (§5.10).
 */
export function drawIdeogram(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  body = ideogramBody(frame.thickness),
): void {
  if (layout.placements.length === 0) return
  const half = body / 2
  const centre = frame.thickness / 2
  const colourOf = (index: number): string =>
    paint.colourOf === undefined ? stainColour(stainOf(set.detail[index])) : paint.colourOf(index)

  ctx.save()
  ctx.globalAlpha = paint.opacity
  const runs = runsOf(set, layout)
  for (const run of runs) {
    const { edge, centromeres } = edgeOf(set, run, half)
    if (edge.length === 0) continue

    // The bands, inside the outline.
    ctx.save()
    ctx.beginPath()
    tracePath(ctx, frame, edge, centre, run)
    ctx.clip()
    const byInk = new Map<string, FeaturePlacement[]>()
    for (const placement of run.placements) {
      const ink = colourOf(placement.index)
      const held = byInk.get(ink)
      if (held === undefined) byInk.set(ink, [placement])
      else held.push(placement)
    }
    for (const [ink, placements] of byInk) {
      ctx.fillStyle = ink
      ctx.beginPath()
      for (const placement of placements) {
        const [x, y, w, h] = laneRect(frame, placement.along0, placement.along1, centre - half, centre + half)
        ctx.rect(x, y, w, h)
      }
      ctx.fill()
    }
    // A centromere across the width it is drawn at, which for a yeast CEN is
    // wider than its bands: the waist has to be red where it is a waist.
    for (const centromere of centromeres) {
      ctx.fillStyle = colourOf(centromere.index)
      const [x, y, w, h] = laneRect(frame, centromere.from, centromere.to, centre - half, centre + half)
      ctx.fillRect(x, y, w, h)
    }
    hatch(ctx, frame, set, run, centre, half)
    ctx.restore()

    // …and the outline over them, in the plot's ink.
    ctx.beginPath()
    tracePath(ctx, frame, edge, centre, run)
    ctx.strokeStyle = paint.guideColour
    ctx.lineWidth = OUTLINE_WIDTH
    ctx.lineJoin = 'round'
    ctx.stroke()
  }
  if (paint.labels) labelBands(ctx, frame, set, layout, paint, centre, body)
  ctx.restore()
}

/**
 * Hatch the `gvar` bands of a run: strokes at 45°, since a pattern fill is the
 * one thing a vector export cannot carry (`ui/vector.ts`).
 */
function hatch(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  run: Run,
  centre: number,
  half: number,
): void {
  const step = 4
  ctx.beginPath()
  let any = false
  for (const placement of run.placements) {
    if (stainOf(set.detail[placement.index]) !== 'gvar') continue
    any = true
    const bottom = centre + half
    for (let along = placement.along0 - 2 * half; along < placement.along1; along += step) {
      const from = Math.max(along, placement.along0)
      const to = Math.min(along + 2 * half, placement.along1)
      if (!(to > from)) continue
      // A 45° stroke from the bottom edge to the top, cut to the band's ends.
      laneMove(ctx, frame, from, bottom - (from - along))
      laneLine(ctx, frame, to, bottom - (to - along))
    }
  }
  if (!any) return
  ctx.strokeStyle = GVAR_HATCH
  ctx.lineWidth = 0.75
  ctx.stroke()
}

/**
 * Each band's name, inside it, where it fits and the band is not a
 * centromere's — in the stain's contrasting ink, so it is read on the band
 * rather than over it.
 */
function labelBands(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  set: FeatureSet,
  layout: FeatureLayout,
  paint: FeaturePaint,
  centre: number,
  body: number,
): void {
  if (body < 9) return
  ctx.save()
  ctx.font = paint.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lo = Math.min(frame.alongFrom, frame.alongTo) + 1
  const hi = Math.max(frame.alongFrom, frame.alongTo) - 1
  for (const placement of layout.placements) {
    const name = set.name[placement.index]
    if (name === '') continue
    const stain = stainOf(set.detail[placement.index])
    if (stain === 'acen') continue
    // The part of the band on screen, since that is where its name can be read.
    const from = Math.max(placement.along0, lo)
    const to = Math.min(placement.along1, hi)
    const width = ctx.measureText(name).width
    if (to - from < width + 6) continue
    ctx.fillStyle = darkBand(stain) ? '#ffffff' : '#1c1c1e'
    laneText(ctx, frame, name, (from + to) / 2, centre)
  }
  ctx.restore()
}

/**
 * The bands the window shows, in ISCN: `Xq28`, or `Xq27.3 – q28` across two.
 *
 * What a reader zoomed in most wants from an ideogram lane, and the one fact
 * the picture cannot carry once a band is wider than the screen. Across two
 * sequences the second is named whole, since `q28` alone would be read as the
 * first one's.
 */
export function ideogramCaption(set: FeatureSet, layout: FeatureLayout): string | null {
  const placements = layout.placements.filter((placement) => set.name[placement.index] !== '')
  if (placements.length === 0) return null
  const first = placements[0].index
  const last = placements[placements.length - 1].index
  const firstName = iscnName(set.contigs[set.contig[first]], set.name[first])
  if (first === last) return firstName
  const sameContig = set.contig[first] === set.contig[last]
  const lastName = sameContig ? set.name[last] : iscnName(set.contigs[set.contig[last]], set.name[last])
  return `${firstName} – ${lastName}`
}

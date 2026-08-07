/**
 * The geometry every lane is drawn in.
 *
 * A lane is a strip beside the matrix — under it, over it, or down either side
 * — where one of the map's two axes is the genomic one and the strip's own
 * thickness is the other. Everything else about the four is identical, so
 * rather than four renderers there is one, written in terms of *along* (the
 * genomic direction) and *across* (the value or stacking direction), and this
 * module is the only place that knows which is x, which way each of them
 * points, and where zero is.
 *
 * **Across always runs outward, away from the map.** `acrossFrom` is the canvas
 * pixel of the lane's edge *nearest the matrix* and `across` counts from there
 * towards the reader, which on a top or left stack is the direction the canvas
 * coordinate runs *backwards* in. That one convention is what lets every hit
 * test, every label and every clip in this application say "the far border" and
 * mean the same border on all four edges: the alternative — canvas offsets —
 * puts the resize border at `thickness` on two edges and at `0` on the other
 * two, and every caller has to know which.
 *
 * `toPixel` comes from the heatmap's own `Scale` (spec §8.4). Nothing here
 * computes a coordinate mapping; it is handed one, and that is what makes a
 * track and the matrix column above it structurally incapable of drifting.
 */

import type { LaneEdge } from '../annotations/types'

/** Where a lane is, and how its two directions map to the canvas. */
export interface LaneFrame {
  /** Which edge of the map this lane is on. */
  orientation: LaneEdge
  /** Canvas pixel for a matrix coordinate, along the genomic axis. */
  toPixel(unit: number): number
  /** Matrix coordinate for a canvas pixel, along the genomic axis. */
  toUnit(pixel: number): number
  /** The visible matrix domain, as the shared `Scale` holds it. */
  domain: readonly [number, number]
  /** Pixel extent of the *data* along the genomic axis — the heatmap's dataRect. */
  alongFrom: number
  alongTo: number
  /**
   * Canvas pixel of the lane's edge nearest the map; `across` counts *outward*
   * from it. On a bottom or right stack that is the smaller canvas coordinate
   * and the two run together; on a top or left stack it is the larger, and the
   * across direction is the canvas direction reversed.
   */
  acrossFrom: number
  /** How thick the lane is, in canvas pixels. */
  thickness: number
}

/** Whether this edge's genomic axis runs across the page rather than down it. */
export function laneIsHorizontal(edge: LaneEdge): boolean {
  return edge === 'top' || edge === 'bottom'
}

/**
 * Which way the canvas coordinate moves as `across` grows — outward, away from
 * the map.
 *
 * `+1` below and beside the map, where outward is down and right; `-1` above it
 * and to its left, where outward is up and back.
 */
export function laneOutward(edge: LaneEdge): 1 | -1 {
  return edge === 'top' || edge === 'left' ? -1 : 1
}

/**
 * Whether an unflipped lane on this edge grows *towards* the matrix.
 *
 * The rule underneath is one rule and it is the conventional orientation of a
 * plot: a horizontal lane's values grow **up** the page and a vertical lane's
 * grow **right** across it, whichever side of the map the lane happens to be
 * on. Which of those points at the matrix then depends on the side — up is
 * towards a map that is above and away from one that is below — and this is
 * that question answered once.
 *
 * It is what the whole application phrases the flip in terms of: a lane added
 * to any edge grows towards the map, because two stacks meeting at a corner
 * must agree about which way is more, and moving a lane from one edge to
 * another turns its axis exactly when the answer here changes
 * (`AnnotationStore.place`).
 */
export function laneGrowsInward(edge: LaneEdge): boolean {
  return edge === 'bottom' || edge === 'left'
}

/** Canvas coordinate of an across-offset, on the axis the lane is thick in. */
export function acrossToCanvas(frame: LaneFrame, across: number): number {
  return frame.acrossFrom + laneOutward(frame.orientation) * across
}

/** The inverse: how far outward a canvas coordinate is, in lane coordinates. */
export function canvasToAcross(frame: LaneFrame, canvas: number): number {
  return laneOutward(frame.orientation) * (canvas - frame.acrossFrom)
}

/**
 * The across-offset a normalised value sits at.
 *
 * A lane grows towards the map or away from it, and {@link laneGrowsInward} is
 * what decides — `across` already points outward, so the whole difference
 * between the four edges is which end of `[0, thickness]` a value of 1 lands
 * on. Both readings put the baseline against one edge of the strip and the
 * ceiling against the other; neither depends on which axis is x.
 */
export function valueAcross(frame: LaneFrame, normalised: number): number {
  const clamped = normalised < 0 ? 0 : normalised > 1 ? 1 : normalised
  return laneGrowsInward(frame.orientation)
    ? frame.thickness * (1 - clamped)
    : frame.thickness * clamped
}

/** Canvas x for a point given in lane coordinates. */
export function laneX(frame: LaneFrame, along: number, across: number): number {
  return laneIsHorizontal(frame.orientation) ? along : acrossToCanvas(frame, across)
}

/** Canvas y for a point given in lane coordinates. */
export function laneY(frame: LaneFrame, along: number, across: number): number {
  return laneIsHorizontal(frame.orientation) ? acrossToCanvas(frame, across) : along
}

/** `ctx.moveTo` in lane coordinates. */
export function laneMove(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  across: number,
): void {
  ctx.moveTo(laneX(frame, along, across), laneY(frame, along, across))
}

/** `ctx.lineTo` in lane coordinates. */
export function laneLine(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  across: number,
): void {
  ctx.lineTo(laneX(frame, along, across), laneY(frame, along, across))
}

/**
 * A rectangle spanning `[alongFrom, alongTo)` and `[acrossFrom, acrossTo)`, in
 * lane coordinates.
 *
 * Widths are floored to one pixel: a peak 40 bp wide on a whole-genome view is a
 * fifth of a pixel, and a `fillRect` of width 0.2 is an antialiased smear that
 * reads as absent. One crisp pixel is the honest answer — the feature is there
 * and it is smaller than the picture can resolve.
 */
export function laneRect(
  frame: LaneFrame,
  along0: number,
  along1: number,
  across0: number,
  across1: number,
): [number, number, number, number] {
  const alongLow = Math.min(along0, along1)
  const alongSpan = Math.max(1, Math.abs(along1 - along0))
  // Through the canvas conversion rather than a bare `min`, because on a top or
  // left stack the larger across-offset is the *smaller* canvas coordinate, and
  // a rectangle is always given by its low corner and a positive span.
  const canvas0 = acrossToCanvas(frame, across0)
  const canvas1 = acrossToCanvas(frame, across1)
  const acrossLow = Math.min(canvas0, canvas1)
  const acrossSpan = Math.max(1, Math.abs(canvas1 - canvas0))
  return laneIsHorizontal(frame.orientation)
    ? [alongLow, acrossLow, alongSpan, acrossSpan]
    : [acrossLow, alongLow, acrossSpan, alongSpan]
}

/**
 * Put a hairline on the device-pixel grid.
 *
 * The same rule the heatmap's separators follow, and for the same reason: a
 * one-pixel rule on a fractional coordinate is antialiased across two pixels and
 * reads as a real feature twice as wide as it is.
 */
export function snapTo(value: number, dpr: number): number {
  return (Math.round(value * dpr - 0.5) + 0.5) / dpr
}

/** Restrict drawing to one lane's rectangle. The caller must `ctx.restore()`. */
export function clipLane(ctx: CanvasRenderingContext2D, frame: LaneFrame): void {
  ctx.save()
  ctx.beginPath()
  const [x, y, width, height] = laneRect(frame, frame.alongFrom, frame.alongTo, 0, frame.thickness)
  ctx.rect(x, y, width, height)
  ctx.clip()
}

/**
 * The handle a lane is dragged by, in lane coordinates.
 *
 * Two columns of three dots — the same glyph the Tracks card puts at the head of
 * every row, because it is the same gesture on the same thing, and a reader who
 * has learned one should not have to discover the other. It is drawn *on the
 * canvas* rather than laid over it as a control, for the reason every other
 * affordance here is: the cursor is an arrowhead pointing at a base pair, and a
 * handle that lived in the cursor would not exist until the pointer was already
 * on it.
 *
 * It hangs **outside** the lane, in the margin before the data starts — which is
 * what lets every lane show one at all times without a single track name moving
 * to make room. A handle inside the lane had to be paid for twice: a slot taken
 * off the front of the label, and a glyph that could only appear on hover
 * because a permanent one would sit on the signal.
 *
 * Six pixels along and ten across: a target, not a decoration.
 */
export const GRIP_ALONG = 6
export const GRIP_ACROSS = 10

/**
 * Clear space between the handle and the edge of the data it belongs to.
 *
 * Four, not two. Two was enough for the handle to be *outside* the track and
 * not enough for it to look outside it: beside the map's bottom stack the plot's
 * own left margin adds a few pixels of air and the handle read as separate,
 * while the right-hand stack — where the space is measured from the data itself
 * — came out with the dots against the signal.
 */
export const GRIP_GAP = 4

/** What a lane must leave before its data for a handle to hang in it. */
export const GRIP_ROOM = GRIP_ALONG + GRIP_GAP

/**
 * Where along the axis the handle hangs: immediately before the track's name.
 *
 * Which end of the lane that is depends on which way the lane *reads*, which is
 * a fact about the axis rather than about the side: a horizontal lane runs left
 * to right and its name starts at the left, so the handle goes off the left,
 * above the map and below it alike. A vertical lane turns a quarter turn and
 * reads *upward*: its name starts at the bottom, so the handle goes below it —
 * the end the label begins at, not the end the axis does. A handle at the far
 * end of the track from its own name is a handle belonging to nothing in
 * particular.
 *
 * It never overlaps the data, in either direction, and that is the one thing it
 * must not do — a handle sitting on the signal is both illegible and a target
 * you cannot tell from the picture. Before a horizontal lane it is clamped at
 * the canvas edge, because the space there is the plot's own left margin and
 * there is nothing a stack can do to make more of it. *After* a vertical lane
 * the space is the stack's own canvas, so the caller sizes that canvas to fit
 * (`AnnotationLanes.tailFor`) rather than the handle backing into the track.
 */
export function gripFrom(frame: LaneFrame): number {
  return laneIsHorizontal(frame.orientation)
    ? Math.max(0, frame.alongFrom - GRIP_GAP - GRIP_ALONG)
    : frame.alongTo + GRIP_GAP
}

/**
 * The box a lane's handle occupies, in canvas coordinates.
 *
 * Both orientations from one pair of numbers: `laneRect` is what knows which of
 * them is x, which is the whole reason this module exists (§8.4).
 */
export function gripBox(frame: LaneFrame, across: number): [number, number, number, number] {
  const from = gripFrom(frame)
  return laneRect(frame, from, from + GRIP_ALONG, across, across + GRIP_ACROSS)
}

/**
 * Where the handle sits across its lane: on the same line as the track's name.
 *
 * `labelAcross` is the middle of that name, which is where every view already
 * draws it, so the two line up by construction rather than by two constants
 * that agree today. A lane can be dragged down to a line, so the result is
 * clamped inside it — level with the name where there is room, and as close as
 * the lane allows where there is not.
 */
export function gripAcross(frame: LaneFrame, labelAcross: number): number {
  const room = Math.max(0, frame.thickness - GRIP_ACROSS)
  return Math.max(0, Math.min(labelAcross - GRIP_ACROSS / 2, room))
}

/** Whether a point is on a handle, with a few pixels of slack around it. */
export function withinGrip(box: [number, number, number, number], x: number, y: number): boolean {
  const [bx, by, width, height] = box
  return x >= bx - GRIP_PAD && x <= bx + width + GRIP_PAD && y >= by - GRIP_PAD && y <= by + height + GRIP_PAD
}

/** Slack around the drawn glyph. A six-pixel target is one nobody hits. */
const GRIP_PAD = 4

/**
 * Paint the handle.
 *
 * No backing: it hangs in the margin, where there is nothing to be lost
 * against. `alpha` is the one piece of feedback it gives — every lane shows its
 * handle, and the one under the pointer shows it at full strength.
 */
export function drawGrip(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  across: number,
  colour: string,
  alpha: number,
): void {
  const from = gripFrom(frame)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = colour
  for (const column of [0, 4]) {
    for (const row of [0, 4, 8]) {
      const [x, y, width, height] = laneRect(
        frame,
        from + column,
        from + column + 2,
        across + row,
        across + row + 2,
      )
      ctx.fillRect(x, y, width, height)
    }
  }
  ctx.restore()
}

/** How wide the bar marking a run of grouped lanes is, in CSS pixels. */
export const GROUP_BAR = 3
export const GROUP_FONT = '600 9px system-ui, sans-serif'

/** A run of adjacent lanes that share one value axis. */
export interface GroupRun {
  group: string
  colour: string
  /**
   * The run's two ends on the stacking axis, in **canvas** pixels and in
   * ascending order.
   *
   * Canvas rather than lane coordinates because a bar is a fact about a run of
   * lanes rather than about any one of them, so there is no `across` for it to
   * be measured in — and because the caller that lays a stack out is the one
   * that knows which way its slots run.
   */
  from: number
  to: number
}

/**
 * Coalesce a stack's lanes into the runs a group bar is drawn for.
 *
 * Adjacent members only: two lanes of one group with a third track between them
 * are two runs, because a single bar spanning all three would say the middle one
 * shares their axis, which is false. `gap` is the stack's own lane gap, plus a
 * pixel of tolerance for the rounding a fractional height leaves behind.
 */
export function groupRuns(
  lanes: ReadonlyArray<{ group: string; colour: string; acrossFrom: number; thickness: number }>,
  gap: number,
): GroupRun[] {
  const runs: GroupRun[] = []
  for (const lane of lanes) {
    if (lane.group === '') continue
    const top = lane.acrossFrom
    const bottom = top + lane.thickness
    const open = runs[runs.length - 1]
    if (open !== undefined && open.group === lane.group && Math.abs(open.to - top) <= gap + 1) {
      open.to = bottom
      continue
    }
    runs.push({ group: lane.group, colour: lane.colour, from: top, to: bottom })
  }
  return runs
}

/**
 * The bar that says which lanes share a value axis, and its name beside it.
 *
 * A group is honoured *numerically* the moment it is made — its members resolve
 * to one pair of limits — and until this is drawn that is a fact with no
 * picture: two tracks on the same axis and two tracks that happen to agree look
 * identical, on screen and in the exported figure. The bar is the claim made
 * visible.
 *
 * `along` is where the bar sits on the genomic axis; the caller decides, because
 * the two surfaces have different room. The browser keeps a margin at the start
 * of every lane; a stack beside a map has none at the start — that margin
 * belongs to the heatmap's own block labels — so its bar goes past the last
 * lane, where the loop anchors already live.
 */
export function drawGroupBars(
  ctx: CanvasRenderingContext2D,
  runs: readonly GroupRun[],
  options: {
    /** Whether the lanes' genomic axis runs across the page rather than down it. */
    horizontal: boolean
    along: number
    /**
     * Where the group's *name* goes, when it is not simply beside its bar.
     *
     * The browser puts it past the whole handle margin rather than two pixels
     * from the rule: with no name column those nine pixels are exactly where the
     * handles hang, and a word written through a column of grips is a word
     * nobody reads.
     */
    labelAlong?: number
    text: boolean
    /** The size a group's name is written at, or absent for this module's own. */
    font?: string
  },
): void {
  if (runs.length === 0) return
  const bottom = options.horizontal
  ctx.save()
  for (const run of runs) {
    // The bar spans the lanes it groups, so it is long *across* the stack and
    // thin *along* it — the opposite way round from everything else in this
    // module, which is why it is written out rather than put through `laneRect`.
    const room = run.to - run.from
    const x = bottom ? options.along : run.from
    const y = bottom ? run.from : options.along
    const width = bottom ? GROUP_BAR : room
    const height = bottom ? room : GROUP_BAR
    ctx.fillStyle = run.colour
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    // `roundRect` where the context has it, a plain rectangle where it does not:
    // the export replays this through `VectorPage`, whose op list has no rounded
    // rectangle, and a bar that vanished from the PDF would be worse than a
    // square-cornered one.
    if (ctx.roundRect === undefined) ctx.rect(x, y, width, height)
    else ctx.roundRect(x, y, width, height, GROUP_BAR / 2)
    ctx.fill()

    // The name runs *with* the bar — the only orientation that fits a word
    // beside a three-pixel rule. Dropped rather than clipped when the run is too
    // short to hold it: half a group's name is a different group's name.
    if (!options.text || room < 34) continue
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.font = options.font ?? GROUP_FONT
    ctx.fillStyle = run.colour
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const mid = (run.from + run.to) / 2
    const past = options.labelAlong ?? options.along + GROUP_BAR + 2
    ctx.translate(bottom ? past : mid, bottom ? mid : past)
    if (bottom) ctx.rotate(-Math.PI / 2)
    if (ctx.measureText(run.group).width <= room - 6) ctx.fillText(run.group, 0, 0)
    ctx.restore()
  }
  ctx.restore()
}

/**
 * Draw `text` so it reads correctly on any edge.
 *
 * A vertical lane runs top to bottom, so its labels turn a quarter turn
 * anticlockwise — the same rotation the heatmap gives its column labels, and for
 * the same reason: a name needs the length of the axis it belongs to, not the
 * width of the strip. Which side of the map the lane is on makes no difference:
 * a name above the map reads the same way up as one below it.
 */
export function laneText(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  text: string,
  along: number,
  across: number,
  options: { halo?: string; maxWidth?: number } = {},
): void {
  const x = laneX(frame, along, across)
  const y = laneY(frame, along, across)
  ctx.save()
  ctx.translate(x, y)
  if (!laneIsHorizontal(frame.orientation)) ctx.rotate(-Math.PI / 2)
  // Given to the canvas rather than measured against, so a phrase too long for
  // its lane is condensed rather than run off the end of it. Absent for every
  // caller that has already fitted its own text.
  const width = options.maxWidth
  if (options.halo !== undefined) {
    ctx.strokeStyle = options.halo
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    if (width === undefined) ctx.strokeText(text, 0, 0)
    else ctx.strokeText(text, 0, 0, width)
  }
  if (width === undefined) ctx.fillText(text, 0, 0)
  else ctx.fillText(text, 0, 0, width)
  ctx.restore()
}

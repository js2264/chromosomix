/**
 * The geometry every lane is drawn in.
 *
 * A lane is a strip beside the matrix: under it, where the genomic axis runs
 * left to right and shares the heatmap's column scale, or beside it, where the
 * same axis runs top to bottom and shares the row scale. Everything else about
 * the two is identical, so rather than two renderers there is one, written in
 * terms of *along* (the genomic direction) and *across* (the value or stacking
 * direction), and this module is the only place that knows which is x.
 *
 * `toPixel` comes from the heatmap's own `Scale` (spec §8.4). Nothing here
 * computes a coordinate mapping; it is handed one, and that is what makes a
 * track and the matrix column above it structurally incapable of drifting.
 */

/** Where a lane is, and how its two directions map to the canvas. */
export interface LaneFrame {
  /** Which edge this lane is on: the bottom of the map, or its right. */
  orientation: 'bottom' | 'right'
  /** Canvas pixel for a matrix coordinate, along the genomic axis. */
  toPixel(unit: number): number
  /** Matrix coordinate for a canvas pixel, along the genomic axis. */
  toUnit(pixel: number): number
  /** The visible matrix domain, as the shared `Scale` holds it. */
  domain: readonly [number, number]
  /** Pixel extent of the *data* along the genomic axis — the heatmap's dataRect. */
  alongFrom: number
  alongTo: number
  /** Where this lane starts across, in canvas pixels. */
  acrossFrom: number
  /** How thick the lane is, in canvas pixels. */
  thickness: number
}

/**
 * The across-offset a normalised value sits at.
 *
 * A bottom lane grows **upward** from its own floor and a right lane grows
 * **rightward** from its own left edge, which is the conventional orientation
 * for each side and the reason this is a branch rather than one formula. Both
 * put the baseline against the edge nearest the reader's entry into the lane.
 */
export function valueAcross(frame: LaneFrame, normalised: number): number {
  const clamped = normalised < 0 ? 0 : normalised > 1 ? 1 : normalised
  return frame.orientation === 'bottom' ? frame.thickness * (1 - clamped) : frame.thickness * clamped
}

/** Canvas x for a point given in lane coordinates. */
export function laneX(frame: LaneFrame, along: number, across: number): number {
  return frame.orientation === 'bottom' ? along : frame.acrossFrom + across
}

/** Canvas y for a point given in lane coordinates. */
export function laneY(frame: LaneFrame, along: number, across: number): number {
  return frame.orientation === 'bottom' ? frame.acrossFrom + across : along
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
  const acrossLow = Math.min(across0, across1)
  const acrossSpan = Math.max(1, Math.abs(across1 - across0))
  return frame.orientation === 'bottom'
    ? [alongLow, frame.acrossFrom + acrossLow, alongSpan, acrossSpan]
    : [frame.acrossFrom + acrossLow, alongLow, acrossSpan, alongSpan]
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
 * Which end of the lane that is depends on which way the lane reads. A bottom
 * lane runs left to right and its name starts at the left, so the handle goes
 * off the left. A right-hand lane turns a quarter turn and reads *upward*: its
 * name starts at the bottom, so the handle goes below it — the end the label
 * begins at, not the end the axis does. A handle at the far end of the track
 * from its own name is a handle belonging to nothing in particular.
 *
 * It never overlaps the data, in either direction, and that is the one thing it
 * must not do — a handle sitting on the signal is both illegible and a target
 * you cannot tell from the picture. Before a bottom lane it is clamped at the
 * canvas edge, because the space there is the plot's own left margin and there
 * is nothing a stack can do to make more of it. *After* a right-hand lane the
 * space is the stack's own canvas, so the caller sizes that canvas to fit
 * (`AnnotationLanes.tailFor`) rather than the handle backing into the track.
 */
export function gripFrom(frame: LaneFrame): number {
  return frame.orientation === 'bottom'
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
const GROUP_FONT = '600 9px system-ui, sans-serif'

/** A run of adjacent lanes that share one value axis. */
export interface GroupRun {
  group: string
  colour: string
  /** Across-offsets of the run's two ends, in the stack's own coordinates. */
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
    orientation: 'bottom' | 'right'
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
  },
): void {
  if (runs.length === 0) return
  const bottom = options.orientation === 'bottom'
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
    ctx.font = GROUP_FONT
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
 * Draw `text` so it reads correctly on either edge.
 *
 * A right-hand lane runs top to bottom, so its labels turn a quarter turn
 * anticlockwise — the same rotation the heatmap gives its column labels, and for
 * the same reason: a name needs the length of the axis it belongs to, not the
 * width of the strip.
 */
export function laneText(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  text: string,
  along: number,
  across: number,
  options: { halo?: string } = {},
): void {
  const x = laneX(frame, along, across)
  const y = laneY(frame, along, across)
  ctx.save()
  ctx.translate(x, y)
  if (frame.orientation === 'right') ctx.rotate(-Math.PI / 2)
  if (options.halo !== undefined) {
    ctx.strokeStyle = options.halo
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.strokeText(text, 0, 0)
  }
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

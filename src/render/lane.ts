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

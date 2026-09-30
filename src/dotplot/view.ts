/**
 * The dot plot's view of its own (SPECS §28.2), as arithmetic: a window over
 * the two sets' concatenated axes, in bases, at one scale on both — so a
 * collinear stretch is a line at 45° whatever the two sets' sizes — zoomed
 * about the pointer and moved by the hand; where a pixel is, in bases and as a
 * locus of each set; and the streak the pointer is on.
 *
 * Tested without a canvas; `ui/dotplotFigure.ts` draws it, and the reference
 * editor's corner plot (§27.3) draws the same streaks through an edit.
 */

/** A set's sequences along one axis, in order: their names and their lengths in bases. */
export interface DotplotAxis {
  names: readonly string[]
  lengths: readonly number[]
}

/** The streaks of a dot plot, one entry each: extents on each axis, half-open, in bases along the concatenated axes. */
export interface DotplotLines {
  x0: ArrayLike<number>
  x1: ArrayLike<number>
  y0: ArrayLike<number>
  y1: ArrayLike<number>
  /** `1` the same way round, `-1` the other. */
  strand: ArrayLike<number>
}

/** The window on screen, in bases along each axis: `x` left to right, `y` top to bottom. */
export interface DotplotView {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** Where the plot is drawn on the canvas, in CSS pixels. */
export interface PlotRect {
  x: number
  y: number
  width: number
  height: number
}

/** The fewest bases a pixel shows, zoomed in all the way: a base is as fine as a streak has anything to say. */
export const LEAST_BASES_A_PIXEL = 1

/** Where each of an axis's sequences starts along it, and its total last. */
export function offsetsOf(axis: DotplotAxis): number[] {
  const out = [0]
  for (const length of axis.lengths) out.push(out[out.length - 1] + length)
  return out
}

/** Bases a pixel, the same on both axes. */
export function scaleOf(view: DotplotView, rect: PlotRect): number {
  return (view.x1 - view.x0) / Math.max(1, rect.width)
}

/**
 * The whole of both sets at one scale, centred in the plot: the longer of the
 * two fills its side, and the other is centred along its own with room either
 * side.
 */
export function fitView(xTotal: number, yTotal: number, rect: PlotRect): DotplotView {
  const scale = Math.max(xTotal / Math.max(1, rect.width), yTotal / Math.max(1, rect.height), LEAST_BASES_A_PIXEL)
  const width = rect.width * scale
  const height = rect.height * scale
  const cx = xTotal / 2
  const cy = yTotal / 2
  return { x0: cx - width / 2, x1: cx + width / 2, y0: cy - height / 2, y1: cy + height / 2 }
}

/**
 * A view kept over the data: never wider than the fitted whole, never finer
 * than {@link LEAST_BASES_A_PIXEL}, and never moved so far that the data
 * leaves the plot — its centre over both axes. Only its centre: a view held to
 * the data's edges would shift under the pointer zooming into the last
 * sequence of either set, which is where a fused chromosome, written last,
 * usually is. An axis the view is wider than is centred on it.
 */
export function clampView(view: DotplotView, xTotal: number, yTotal: number, rect: PlotRect): DotplotView {
  const whole = fitView(xTotal, yTotal, rect)
  const most = scaleOf(whole, rect)
  const scale = Math.min(most, Math.max(LEAST_BASES_A_PIXEL, scaleOf(view, rect)))
  const width = rect.width * scale
  const height = rect.height * scale
  const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))
  const cx = width >= xTotal ? xTotal / 2 : clamp((view.x0 + view.x1) / 2, 0, xTotal)
  const cy = height >= yTotal ? yTotal / 2 : clamp((view.y0 + view.y1) / 2, 0, yTotal)
  return { x0: cx - width / 2, x1: cx + width / 2, y0: cy - height / 2, y1: cy + height / 2 }
}

/** A pixel of the plot, in bases along each axis. */
export function toBases(view: DotplotView, rect: PlotRect, px: number, py: number): { x: number; y: number } {
  const scale = scaleOf(view, rect)
  return { x: view.x0 + (px - rect.x) * scale, y: view.y0 + (py - rect.y) * scale }
}

/** A place in bases, as a pixel of the plot. */
export function toPixels(view: DotplotView, rect: PlotRect, x: number, y: number): { px: number; py: number } {
  const scale = scaleOf(view, rect)
  return { px: rect.x + (x - view.x0) / scale, py: rect.y + (y - view.y0) / scale }
}

/** Zoomed by `factor` — above one, in — about the pixel `(px, py)`, which stays over the same bases. */
export function zoomView(view: DotplotView, rect: PlotRect, px: number, py: number, factor: number): DotplotView {
  const at = toBases(view, rect, px, py)
  const scale = scaleOf(view, rect) / factor
  const left = at.x - (px - rect.x) * scale
  const top = at.y - (py - rect.y) * scale
  return { x0: left, x1: left + rect.width * scale, y0: top, y1: top + rect.height * scale }
}

/** Moved by `(dx, dy)` pixels: the picture follows the hand. */
export function panView(view: DotplotView, rect: PlotRect, dx: number, dy: number): DotplotView {
  const scale = scaleOf(view, rect)
  return { x0: view.x0 - dx * scale, x1: view.x1 - dx * scale, y0: view.y0 - dy * scale, y1: view.y1 - dy * scale }
}

/** A streak's two ends, in bases: from its start on x, down its diagonal — or up it, the other way round. */
export function streakEnds(lines: DotplotLines, i: number): [number, number, number, number] {
  return lines.strand[i] === -1 ? [lines.x0[i], lines.y1[i], lines.x1[i], lines.y0[i]] : [lines.x0[i], lines.y0[i], lines.x1[i], lines.y1[i]]
}

/**
 * The streak nearest the pixel `(px, py)` within `reach` pixels of it, measured
 * to the line it is drawn as; `-1` for none.
 */
export function streakAt(lines: DotplotLines, view: DotplotView, rect: PlotRect, px: number, py: number, reach: number): number {
  const scale = scaleOf(view, rect)
  const at = toBases(view, rect, px, py)
  const room = reach * scale
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  const count = lines.x0.length
  for (let i = 0; i < count; i++) {
    // Outside its box, grown by the reach, it cannot be within reach.
    if (at.x < lines.x0[i] - room || at.x > lines.x1[i] + room || at.y < lines.y0[i] - room || at.y > lines.y1[i] + room) continue
    const [ax, ay, bx, by] = streakEnds(lines, i)
    const dx = bx - ax
    const dy = by - ay
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - ax) * dx + (at.y - ay) * dy) / length))
    const distance = Math.hypot(at.x - (ax + t * dx), at.y - (ay + t * dy)) / scale
    if (distance <= reach && distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/** A position along an axis as the sequence it is in and the base in it, 0-based; `null` off the axis. */
export function locusOf(axis: DotplotAxis, offsets: readonly number[], position: number): { name: string; at: number } | null {
  if (!(position >= 0) || position >= offsets[offsets.length - 1]) return null
  let low = 0
  let high = axis.names.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid] <= position) low = mid
    else high = mid - 1
  }
  return { name: axis.names[low], at: Math.floor(position - offsets[low]) }
}

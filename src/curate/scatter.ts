/**
 * The arithmetic of the curation stage's contig scatter (SPECS §33.3): every
 * contig a dot, its GC content across, its coverage up (on a log scale), its
 * area its length — so an organism is one cloud, and a contig binned into the
 * wrong one stands out of its genome's colour. The stage draws; this file
 * places, measures, finds what is under the pointer and what a lasso holds,
 * on plain arrays, so every rule is tested without a canvas.
 */

/** The scatter's frame: the data each axis spans (coverage as `log10`). */
export interface ScatterFrame {
  gc0: number
  gc1: number
  /** `log10` of the coverage at the bottom and the top. */
  log0: number
  log1: number
  /** The coverage drawn at the bottom for a contig with none: half the least there is. */
  floor: number
}

/** A margin around the dots, as a share of each axis's span. */
const PAD = 0.04

/**
 * The frame that holds every contig given: GC from the least to the most, the
 * coverage from the least above nought to the most, each padded a little; a
 * contig without coverage sits at the bottom, at half the least there is.
 */
export function scatterFrame(gc: ArrayLike<number>, coverage: ArrayLike<number>, contigs?: Iterable<number>): ScatterFrame {
  let gc0 = Number.POSITIVE_INFINITY
  let gc1 = Number.NEGATIVE_INFINITY
  let least = Number.POSITIVE_INFINITY
  let most = 0
  const each = contigs ?? range(gc.length)
  for (const c of each) {
    const g = gc[c]
    if (Number.isFinite(g)) {
      if (g < gc0) gc0 = g
      if (g > gc1) gc1 = g
    }
    const v = coverage[c]
    if (Number.isFinite(v) && v > 0) {
      if (v < least) least = v
      if (v > most) most = v
    }
  }
  if (!Number.isFinite(gc0)) {
    gc0 = 0
    gc1 = 100
  }
  if (!(most > 0)) {
    least = 1
    most = 1
  }
  const floor = least / 2
  let log0 = Math.log10(floor)
  let log1 = Math.log10(most)
  if (gc1 - gc0 < 1) {
    gc0 -= 0.5
    gc1 += 0.5
  }
  if (log1 - log0 < 0.5) {
    log0 -= 0.25
    log1 += 0.25
  }
  const gcPad = (gc1 - gc0) * PAD
  const logPad = (log1 - log0) * PAD
  return { gc0: gc0 - gcPad, gc1: gc1 + gcPad, log0: log0 - logPad, log1: log1 + logPad, floor }
}

function* range(n: number): Generator<number> {
  for (let k = 0; k < n; k++) yield k
}

/** Every contig's place in pixels on a plot `width` × `height`; `NaN` for a contig without a GC content. */
export interface ScatterPlaces {
  x: Float32Array
  y: Float32Array
}

/** Every contig's place, the top-left of the plot at `(0, 0)`. */
export function scatterPlaces(frame: ScatterFrame, gc: ArrayLike<number>, coverage: ArrayLike<number>, width: number, height: number): ScatterPlaces {
  const n = gc.length
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  const sx = width / (frame.gc1 - frame.gc0)
  const sy = height / (frame.log1 - frame.log0)
  for (let c = 0; c < n; c++) {
    const g = gc[c]
    if (!Number.isFinite(g)) {
      x[c] = Number.NaN
      y[c] = Number.NaN
      continue
    }
    const v = coverage[c]
    const log = Math.log10(Number.isFinite(v) && v > 0 ? Math.max(v, frame.floor) : frame.floor)
    x[c] = (g - frame.gc0) * sx
    y[c] = height - (log - frame.log0) * sy
  }
  return { x, y }
}

/** A dot's radius in pixels: its area grows with the contig's length, from 1 px at 1 kb to 7 px. */
export function dotRadius(length: number, scale = 1): number {
  const r = Math.sqrt(Math.max(length, 0) / 1000) * 0.9
  return Math.min(7, Math.max(1, r)) * scale
}

/**
 * The order dots are drawn in: the smallest first, so a long contig is never
 * hidden under the short ones around it; ties in the contigs' order.
 */
export function drawOrder(lengths: ArrayLike<number>, contigs: readonly number[]): Int32Array {
  const out = Int32Array.from(contigs)
  out.sort((a, b) => lengths[a] - lengths[b] || a - b)
  return out
}

/**
 * A grid over the plot for finding the dot under the pointer: each cell lists
 * the dots whose centre is in it, so a look touches the nine cells around the
 * pointer, not every dot.
 */
export class DotGrid {
  private readonly cells: Map<number, number[]> = new Map()
  private readonly columns: number

  constructor(
    private readonly places: ScatterPlaces,
    contigs: Iterable<number>,
    private readonly cell = 16,
    width = 4096,
  ) {
    this.columns = Math.ceil(width / cell) + 2
    for (const c of contigs) {
      const x = places.x[c]
      const y = places.y[c]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const key = this.key(Math.floor(x / cell), Math.floor(y / cell))
      const list = this.cells.get(key)
      if (list === undefined) this.cells.set(key, [c])
      else list.push(c)
    }
  }

  private key(i: number, j: number): number {
    return (j + 1) * this.columns + (i + 1)
  }

  /**
   * The dot under `(x, y)`: of the dots whose disc holds the point (or is
   * within `slack` pixels of it), the one drawn last — the one on top — else
   * `-1`.
   *
   * @param radius Each dot's radius in pixels.
   * @param rank Each dot's place in the drawing order: higher is on top.
   */
  at(x: number, y: number, radius: (c: number) => number, rank: (c: number) => number, slack = 2): number {
    const i0 = Math.floor(x / this.cell)
    const j0 = Math.floor(y / this.cell)
    let best = -1
    let bestRank = Number.NEGATIVE_INFINITY
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        const list = this.cells.get(this.key(i, j))
        if (list === undefined) continue
        for (const c of list) {
          const dx = this.places.x[c] - x
          const dy = this.places.y[c] - y
          const reach = radius(c) + slack
          if (dx * dx + dy * dy > reach * reach) continue
          const r = rank(c)
          if (r > bestRank) {
            bestRank = r
            best = c
          }
        }
      }
    }
    return best
  }
}

/**
 * Whether `(x, y)` is inside a polygon, by the even-odd rule.
 *
 * @param polygon The vertices as `x0, y0, x1, y1, …`; the last joins the first.
 */
export function insidePolygon(x: number, y: number, polygon: ArrayLike<number>): boolean {
  let inside = false
  const n = polygon.length >> 1
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[2 * i]
    const yi = polygon[2 * i + 1]
    const xj = polygon[2 * j]
    const yj = polygon[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The contigs whose dot's centre a lasso holds, in the contigs' order. */
export function lassoContigs(places: ScatterPlaces, polygon: ArrayLike<number>, contigs: Iterable<number>): number[] {
  if (polygon.length < 6) return []
  // A bounding box first: most dots are outside it.
  let x0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let k = 0; k < polygon.length; k += 2) {
    x0 = Math.min(x0, polygon[k])
    x1 = Math.max(x1, polygon[k])
    y0 = Math.min(y0, polygon[k + 1])
    y1 = Math.max(y1, polygon[k + 1])
  }
  const out: number[] = []
  for (const c of contigs) {
    const x = places.x[c]
    const y = places.y[c]
    if (!(x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue
    if (insidePolygon(x, y, polygon)) out.push(c)
  }
  return out.sort((a, b) => a - b)
}

/**
 * The ticks of the coverage axis: the powers of ten in the frame, and their
 * halves where there are fewer than three.
 */
export function coverageTicks(frame: ScatterFrame): number[] {
  const out: number[] = []
  for (let p = Math.ceil(frame.log0); p <= Math.floor(frame.log1); p++) out.push(10 ** p)
  if (out.length < 3) {
    for (let p = Math.floor(frame.log0); p <= Math.ceil(frame.log1); p++) {
      const half = 5 * 10 ** (p - 1)
      const log = Math.log10(half)
      if (log >= frame.log0 && log <= frame.log1) out.push(half)
    }
    out.sort((a, b) => a - b)
  }
  return out
}

/** The ticks of the GC axis: every 5 or 10 %, as the span allows. */
export function gcTicks(frame: ScatterFrame): number[] {
  const span = frame.gc1 - frame.gc0
  const step = span > 40 ? 10 : span > 12 ? 5 : span > 5 ? 2 : 1
  const out: number[] = []
  for (let v = Math.ceil(frame.gc0 / step) * step; v <= frame.gc1; v += step) out.push(v)
  return out
}

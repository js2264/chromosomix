/**
 * One track made out of two: a ratio or a difference.
 *
 * The map got the same thing at the same time (`render/compare.ts`) and for the
 * same reason, which is worth saying once here rather than twice: two coverage
 * profiles drawn as two lanes are read by eye, one against the other, and the
 * eye is bad at it. Small consistent differences are invisible under the large
 * shared shape, and a reader comparing a treatment against its control ends up
 * measuring with a finger on the screen. Drawing the comparison *itself* makes
 * the difference the only thing in the lane.
 *
 * **The common refinement, not a resampling.** Both operands are piecewise
 * constant — a bigWig is intervals with values — and two files' intervals do not
 * line up: different zoom levels, different bin sizes, different base-resolution
 * runs. The temptation is to lay down a uniform grid and evaluate both onto it,
 * which is one line and wrong in a way nobody would see: every boundary that
 * falls inside a grid cell is smeared across it, so a sharp edge in a control
 * track becomes a ramp, and the ratio against it develops a spike at exactly the
 * position that mattered. Cutting at *every* boundary of *either* input instead
 * is exact — the combination of two step functions is a step function whose
 * breakpoints are the union of theirs — and it costs at most `|a| + |b|`
 * intervals, which is the same order the inputs already are.
 *
 * Nothing here fetches. Both operands arrive as ordinary sampled tracks, cached
 * and windowed by `annotations/samples.ts` exactly as any other lane's are, so a
 * derived track costs no reads of its own and inherits the pan-and-zoom-free
 * rule (§8.4) from the two it is made of.
 */

import type { TrackSampleSet, TrackSamples } from './types'

/**
 * What two tracks are reduced to.
 *
 * **There were three, and the third was a scale wearing an operation's clothes.**
 * `log2ratio` computed the ratio and then took its logarithm, which put the same
 * finding in two rows and left only one of them exportable as the quantity it
 * measured: a bigWig of log₂ ratios is a file of a *picture*, and anything
 * downstream that wanted the ratio had to undo it. The reason it existed is
 * real — a ratio on a linear axis puts "half" in the bottom half-unit and
 * "double" a whole unit above the middle, the same finding at two very different
 * sizes, with depletion squashed into a sliver against the floor — and it is now
 * answered where it belongs, on the lane's own axis (`AnnotationStyle.scale`).
 * One row, one quantity, and log₂ a dropdown beside the drawing style.
 */
export type TrackOp = 'ratio' | 'difference'

/** Every operation, in the order the picker offers them. */
export const TRACK_OPS: readonly TrackOp[] = ['ratio', 'difference']

export function isTrackOp(value: string): value is TrackOp {
  return (TRACK_OPS as readonly string[]).includes(value)
}

/** What each is called on screen, and in the label of the lane it makes. */
export const TRACK_OP_LABELS: Record<TrackOp, string> = {
  ratio: 'ratio',
  difference: 'difference',
}

/** How a derived lane names itself, before the reader renames it. */
export function derivedTrackLabel(a: string, b: string, op: TrackOp): string {
  return op === 'difference' ? `${a} − ${b}` : `${a} / ${b}`
}

/** Which value the lane sits around — the line a reader reads departures from. */
export function neutralOf(op: TrackOp): number {
  return op === 'ratio' ? 1 : 0
}

/**
 * Combine two sampled tracks, region by region.
 *
 * Regions are matched by contig and by the window they cover, because that is
 * what they are: both operands were asked for the same windows at the same
 * resolution by the same cache, so a region of one has exactly one counterpart.
 * A region with no counterpart is dropped rather than passed through — half a
 * comparison drawn as though it were a whole one is the failure this is for.
 *
 * `null` when either operand has not arrived. The lane then draws whatever it
 * had, which is `samples.ts`'s rule for every track: a lane that blanks while it
 * waits is worse than a lane one frame behind.
 */
export function combineSamples(
  a: TrackSampleSet | null,
  b: TrackSampleSet | null,
  op: TrackOp,
): TrackSampleSet | null {
  if (a === null || b === null) return null
  const regions: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const left of a.regions) {
    const right = b.regions.find(
      (other) => other.contig === left.contig && other.start === left.start && other.end === left.end,
    )
    if (right === undefined) continue
    const merged = refine(left, right, op)
    if (merged.starts.length === 0) continue
    for (const value of merged.values) {
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    regions.push(merged)
  }

  // A lane whose every reading is an infinity has no measured scale to pin them
  // to — one track covers a region the other does not, anywhere the two overlap
  // at all. A unit span about the operation's own neutral is the same fallback
  // `render/scale.ts` uses for a constant block, and for the same reason: the
  // picture is "all of it, in one direction", and that needs an axis to be drawn
  // against even though the data chose none.
  const measured = min <= max
  const extent = measured
    ? { min, max }
    : hasInfinity(regions)
      ? { min: neutralOf(op) - 1, max: neutralOf(op) + 1 }
      : null
  if (extent !== null) for (const merged of regions) clampInfinities(merged.values, extent)
  return { basesPerPixel: a.basesPerPixel, regions, extent }
}

/** Whether any reading ran off the end in either direction. */
function hasInfinity(regions: readonly TrackSamples[]): boolean {
  for (const region of regions) {
    for (const value of region.values) {
      if (!Number.isFinite(value) && !Number.isNaN(value)) return true
    }
  }
  return false
}

/**
 * Bring `±Infinity` back onto the axis, at the far end of what was measured.
 *
 * An interval where the numerator is empty and the denominator is not is a real
 * and often important finding — "none of this here" — and under `log2` it is
 * `-Infinity`, which no lane can draw and no autoscale can bound. Dropping those
 * intervals would delete the finding; giving them a constant floor would invent
 * a number whose size depends on units nobody declared.
 *
 * So they are pinned to the most extreme value the same lane actually reached,
 * which says exactly what is true — this is off the end in that direction — in
 * the units the lane is already drawn in, and moves the axis not at all. The
 * extent was measured over the finite values alone, so this cannot widen it.
 */
function clampInfinities(values: Float32Array, extent: { min: number; max: number }): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (Number.isFinite(value) || Number.isNaN(value)) continue
    values[i] = value > 0 ? extent.max : extent.min
  }
}

/**
 * Two step functions over one window, cut at every breakpoint of either.
 *
 * The two cursors only ever move forward, so this is one pass over each input
 * however many boundaries interleave. A cell no interval of one side covers gets
 * `NaN` from that side, which the arithmetic below carries through to mean "no
 * comparison here" — the same thing a `NaN` means everywhere else in this
 * viewer, and drawn as a gap rather than as a zero.
 */
function refine(left: TrackSamples, right: TrackSamples, op: TrackOp): TrackSamples {
  const edges = boundaries(left, right)
  const count = Math.max(0, edges.length - 1)
  const starts = new Int32Array(count)
  const ends = new Int32Array(count)
  const values = new Float32Array(count)

  let ai = 0
  let bi = 0
  let kept = 0
  for (let i = 0; i < count; i++) {
    const start = edges[i]
    const end = edges[i + 1]
    if (end <= start) continue
    while (ai < left.ends.length && left.ends[ai] <= start) ai++
    while (bi < right.ends.length && right.ends[bi] <= start) bi++
    const lv = ai < left.starts.length && left.starts[ai] <= start ? left.values[ai] : Number.NaN
    const rv = bi < right.starts.length && right.starts[bi] <= start ? right.values[bi] : Number.NaN
    // Both absent is not a reading, and emitting it would draw a flat run of
    // NaN across every gap the two tracks share.
    if (Number.isNaN(lv) && Number.isNaN(rv)) continue
    starts[kept] = start
    ends[kept] = end
    values[kept] = apply(lv, rv, op)
    kept++
  }

  return {
    contig: left.contig,
    start: left.start,
    end: left.end,
    starts: starts.subarray(0, kept),
    ends: ends.subarray(0, kept),
    values: values.subarray(0, kept),
    // A min/max band does not compose: the ratio of two maxima is not the
    // maximum of the ratios, and drawing it as though it were would put a
    // confidence band around a number it is not a band for. A derived lane is
    // its line and nothing else.
    min: null,
    max: null,
    variant: null,
    summary: left.summary || right.summary,
  }
}

/** Every interval boundary of either input, ascending, without duplicates. */
function boundaries(left: TrackSamples, right: TrackSamples): Int32Array {
  const all = new Int32Array(
    left.starts.length + left.ends.length + right.starts.length + right.ends.length,
  )
  let at = 0
  for (const value of left.starts) all[at++] = value
  for (const value of left.ends) all[at++] = value
  for (const value of right.starts) all[at++] = value
  for (const value of right.ends) all[at++] = value
  all.sort()
  const unique = new Int32Array(at)
  let kept = 0
  for (let i = 0; i < at; i++) {
    if (kept === 0 || all[i] !== unique[kept - 1]) unique[kept++] = all[i]
  }
  return unique.subarray(0, kept)
}

/**
 * The arithmetic, with the same three readings `render/compare.ts` relies on:
 * `x / 0` is `Infinity` — present in one and absent in the other — `0 / 0` is
 * `NaN`, and a `NaN` from either side carries through.
 *
 * An infinity produced here is brought back onto the axis by
 * {@link clampInfinities}, once the lane's extent is known — which is why this
 * function is free to produce one rather than having to invent a floor without
 * knowing what the lane's numbers look like.
 */
function apply(left: number, right: number, op: TrackOp): number {
  return op === 'difference' ? left - right : left / right
}

/**
 * The same arithmetic over two per-bin vectors, for a file rather than a lane.
 *
 * One difference, and it is the difference between drawing and writing. A lane
 * brings an infinity back onto its own axis ({@link clampInfinities}) because a
 * pixel has to go somewhere; a file says **no value**, because an infinity
 * cannot be written to a bigWig, would take the range of whatever read it back,
 * and is not a measurement — `x / 0` says the denominator had nothing there,
 * which is exactly what a gap says.
 */
export function combineVectors(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  op: TrackOp,
): Float32Array {
  const out = new Float32Array(Math.min(a.length, b.length))
  for (let i = 0; i < out.length; i++) {
    const value = apply(a[i], b[i], op)
    out[i] = Number.isFinite(value) ? value : Number.NaN
  }
  return out
}

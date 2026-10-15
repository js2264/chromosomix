/**
 * The rings of a circle (§7.6): every track drawn round, as a lane is drawn
 * along a map.
 *
 * A ring is a lane bent into a circle. It is cut into angular **bins**, each
 * inside one section, so a bin is a stretch of that section's sequences laid end
 * to end — a genome's contigs, or one contig — and whatever a track holds over
 * those base pairs is reduced into it: a signal's mean, weighted by how many
 * bases each value covers; a file column's value per contig or per genome,
 * broadcast down (§8.12's level rule, in the other direction it is allowed to
 * go); a category by its most common member. Features are not binned at all:
 * each is an arc of its own, at its own coordinates.
 *
 * Everything here is arithmetic and drawing, keyed on names, so the samples
 * come from the same worker and the same cache a lane beside the map reads
 * through (`ui/CircleView.ts` asks), and the painting goes into a canvas or a
 * vector page alike.
 */

import type { FeatureSet, TrackMode, TrackSampleSet } from '../annotations/types'
import type { MetaCells } from '../annotations/metadata'
import { colormapCss } from './colormaps'
import { categoryColour } from './meta'
import { annulusPath, arcCurve, type CircleGeometry, type CircleModel } from './circle'

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

/** A ring's cells: angular stretches, each inside one section. */
export interface CircleBins {
  count: number
  /** The section each bin is in. */
  unit: Int32Array
  /** The bin's start and end in the section's own base pairs (its sequences end to end). */
  from: Float64Array
  to: Float64Array
  /** The bin's angles, canvas radians. */
  a0: Float64Array
  a1: Float64Array
  /** The first bin of each section, and one past its last: `first[u] .. first[u + 1]`. */
  first: Int32Array
}

/**
 * Where each sequence starts inside its section, by name.
 *
 * The first section to claim a name keeps it, which is the reader's own rule
 * for a repeated contig name (`contigIds`): two MAGs may each have assembled a
 * `contig_1`, and a track keyed on that name cannot say which it meant.
 */
export interface SequenceIndex {
  get(name: string): { unit: number; offset: number; length: number } | undefined
}

export function sequenceIndex(model: CircleModel): SequenceIndex {
  const at = new Map<string, { unit: number; offset: number; length: number }>()
  model.units.forEach((unit, u) => {
    let offset = 0
    for (const sequence of unit.sequences) {
      if (!at.has(sequence.name)) at.set(sequence.name, { unit: u, offset, length: sequence.length })
      offset += Math.max(0, sequence.length)
    }
  })
  return at
}

/**
 * Cut the circle into about `count` bins, each section its share by angle.
 *
 * At least one bin a section, however short, so no section is left without a
 * value; and bins of one section are equal in base pairs, so a bin is a
 * stretch of genome and its value is what that stretch holds.
 */
export function circleBins(model: CircleModel, geometry: CircleGeometry, count: number): CircleBins {
  const n = model.units.length
  let total = 0
  for (let u = 0; u < n; u++) total += Math.max(0, geometry.arcs[2 * u + 1] - geometry.arcs[2 * u])
  const per = new Int32Array(n)
  let sum = 0
  for (let u = 0; u < n; u++) {
    const span = Math.max(0, geometry.arcs[2 * u + 1] - geometry.arcs[2 * u])
    per[u] = Math.max(1, Math.round(total > 0 ? (count * span) / total : count / n))
    sum += per[u]
  }
  const first = new Int32Array(n + 1)
  for (let u = 0; u < n; u++) first[u + 1] = first[u] + per[u]
  const unit = new Int32Array(sum)
  const from = new Float64Array(sum)
  const to = new Float64Array(sum)
  const a0 = new Float64Array(sum)
  const a1 = new Float64Array(sum)
  for (let u = 0; u < n; u++) {
    const bp = Math.max(1, model.units[u].bp)
    const start = geometry.arcs[2 * u]
    const span = geometry.arcs[2 * u + 1] - start
    for (let k = 0; k < per[u]; k++) {
      const at = first[u] + k
      unit[at] = u
      from[at] = (bp * k) / per[u]
      to[at] = (bp * (k + 1)) / per[u]
      a0[at] = start + (span * k) / per[u]
      a1[at] = start + (span * (k + 1)) / per[u]
    }
  }
  return { count: sum, unit, from, to, a0, a1, first }
}

/** The angle a base pair of a section is drawn at. */
export function angleOf(geometry: CircleGeometry, model: CircleModel, unit: number, bp: number): number {
  const a0 = geometry.arcs[2 * unit]
  const a1 = geometry.arcs[2 * unit + 1]
  const length = Math.max(1, model.units[unit].bp)
  return a0 + ((a1 - a0) * Math.max(0, Math.min(length, bp))) / length
}

/** The section-local base pair an angle of a section stands for. */
export function bpAtAngle(geometry: CircleGeometry, model: CircleModel, unit: number, angle: number): number {
  const a0 = geometry.arcs[2 * unit]
  const a1 = geometry.arcs[2 * unit + 1]
  const span = a1 - a0
  if (!(span > 0)) return 0
  let a = angle
  while (a < a0 - Math.PI) a += Math.PI * 2
  while (a > a1 + Math.PI) a -= Math.PI * 2
  return (Math.max(0, Math.min(1, (a - a0) / span))) * Math.max(0, model.units[unit].bp)
}

/** The sequence and position a section-local base pair is, or `null` past its end. */
export function sequenceAt(
  model: CircleModel,
  unit: number,
  bp: number,
): { name: string; position: number; length: number } | null {
  let offset = 0
  for (const sequence of model.units[unit]?.sequences ?? []) {
    const length = Math.max(0, sequence.length)
    if (bp < offset + length) return { name: sequence.name, position: bp - offset, length }
    offset += length
  }
  return null
}

// ---------------------------------------------------------------------------
// Values into bins
// ---------------------------------------------------------------------------

/** One ring's numbers, a value per bin. */
export interface BinnedValues {
  kind: 'quantitative'
  /** The base-weighted mean in each bin; `NaN` where the track has nothing. */
  values: Float32Array
  /** Over the bins, skipping the gaps; `null` where every bin is one. */
  extent: { min: number; max: number } | null
}

/** One ring's categories, a code per bin. */
export interface BinnedClasses {
  kind: 'qualitative'
  /** The most common category in each bin by base pairs; `-1` where none. */
  codes: Int32Array
  levels: readonly string[]
}

/**
 * A signal's samples, reduced into the bins: the mean of every value over the
 * bases it covers, so a bin half covered by one interval and half by another is
 * the average of the two and not whichever came first.
 */
export function binSamples(samples: TrackSampleSet, bins: CircleBins, index: SequenceIndex): BinnedValues {
  const sum = new Float64Array(bins.count)
  const weight = new Float64Array(bins.count)
  for (const region of samples.regions) {
    const at = index.get(region.contig)
    if (at === undefined) continue
    const firstBin = bins.first[at.unit]
    const lastBin = bins.first[at.unit + 1]
    const binCount = lastBin - firstBin
    if (binCount <= 0) continue
    const unitBp = bins.to[lastBin - 1]
    if (!(unitBp > 0)) continue
    const binBp = unitBp / binCount
    for (let i = 0; i < region.values.length; i++) {
      const value = region.values[i]
      if (!Number.isFinite(value)) continue
      const start = at.offset + Math.max(0, region.starts[i])
      const end = at.offset + Math.min(at.length, region.ends[i])
      if (!(end > start)) continue
      let k = Math.max(0, Math.floor(start / binBp))
      const kEnd = Math.min(binCount, Math.ceil(end / binBp))
      for (; k < kEnd; k++) {
        const lo = Math.max(start, k * binBp)
        const hi = Math.min(end, (k + 1) * binBp)
        if (hi <= lo) continue
        sum[firstBin + k] += value * (hi - lo)
        weight[firstBin + k] += hi - lo
      }
    }
  }
  return meanOf(sum, weight)
}

/**
 * A file column, one value per sequence of the circle, reduced into the bins.
 *
 * `cells` is the column resolved onto the circle's sequences in order — the
 * shape `MetadataIndex.cellsFor` answers for a contig-level block, which is how
 * a genome's value reaches every contig of it and a contig's its own.
 */
export function binCells(
  cells: MetaCells,
  model: CircleModel,
  bins: CircleBins,
): BinnedValues | BinnedClasses {
  // The sequences in the order the cells are, with their section and offset.
  const spans: Array<{ unit: number; offset: number; length: number }> = []
  model.units.forEach((unit, u) => {
    let offset = 0
    for (const sequence of unit.sequences) {
      spans.push({ unit: u, offset, length: Math.max(0, sequence.length) })
      offset += Math.max(0, sequence.length)
    }
  })
  if (cells.kind === 'quantitative') {
    const sum = new Float64Array(bins.count)
    const weight = new Float64Array(bins.count)
    spans.forEach((span, cell) => {
      const value = cells.values[cell]
      if (!Number.isFinite(value)) return
      overlapBins(bins, span, (bin, bases) => {
        sum[bin] += value * bases
        weight[bin] += bases
      })
    })
    return meanOf(sum, weight)
  }
  // A category per bin: the one covering the most of it.
  const levels = cells.levels
  const tally = new Float64Array(bins.count * Math.max(1, levels.length))
  spans.forEach((span, cell) => {
    const code = cells.codes[cell]
    if (code < 0 || code >= levels.length) return
    overlapBins(bins, span, (bin, bases) => {
      tally[bin * levels.length + code] += bases
    })
  })
  const codes = new Int32Array(bins.count).fill(-1)
  for (let bin = 0; bin < bins.count; bin++) {
    let best = -1
    let most = 0
    for (let code = 0; code < levels.length; code++) {
      const seen = tally[bin * levels.length + code]
      if (seen > most) {
        most = seen
        best = code
      }
    }
    codes[bin] = best
  }
  return { kind: 'qualitative', codes, levels }
}

/** Every bin a stretch of one section overlaps, with how many bases of it. */
function overlapBins(
  bins: CircleBins,
  span: { unit: number; offset: number; length: number },
  visit: (bin: number, bases: number) => void,
): void {
  const firstBin = bins.first[span.unit]
  const lastBin = bins.first[span.unit + 1]
  const binCount = lastBin - firstBin
  if (binCount <= 0 || !(span.length > 0)) return
  const unitBp = bins.to[lastBin - 1]
  if (!(unitBp > 0)) return
  const binBp = unitBp / binCount
  const start = span.offset
  const end = span.offset + span.length
  const kEnd = Math.min(binCount, Math.ceil(end / binBp))
  for (let k = Math.max(0, Math.floor(start / binBp)); k < kEnd; k++) {
    const lo = Math.max(start, k * binBp)
    const hi = Math.min(end, (k + 1) * binBp)
    if (hi > lo) visit(firstBin + k, hi - lo)
  }
}

function meanOf(sum: Float64Array, weight: Float64Array): BinnedValues {
  const values = new Float32Array(sum.length)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < sum.length; i++) {
    if (!(weight[i] > 0)) {
      values[i] = Number.NaN
      continue
    }
    const value = sum[i] / weight[i]
    values[i] = value
    if (value < min) min = value
    if (value > max) max = value
  }
  return { kind: 'quantitative', values, extent: min > max ? null : { min, max } }
}

/** A feature as an arc: the angles it spans, and which feature it is. */
export interface FeatureArc {
  a0: number
  a1: number
  index: number
}

/**
 * Every feature on the circle's sequences, as arcs at their own coordinates.
 *
 * Not binned: a gene is a place, and the reader hovering it wants its name.
 * Capped, because a genome-wide gene model is a million arcs the width of a
 * hair — past the cap every feature is still accounted for by the ones drawn
 * over it at this size.
 */
export function featureArcs(
  set: FeatureSet,
  model: CircleModel,
  geometry: CircleGeometry,
  index: SequenceIndex,
  cap = 200_000,
): FeatureArc[] {
  const out: FeatureArc[] = []
  for (let c = 0; c < set.contigs.length && out.length < cap; c++) {
    const at = index.get(set.contigs[c])
    if (at === undefined) continue
    const a0 = geometry.arcs[2 * at.unit]
    const a1 = geometry.arcs[2 * at.unit + 1]
    const bp = Math.max(1, model.units[at.unit].bp)
    const per = (a1 - a0) / bp
    for (let i = set.contigAt[c]; i < set.contigAt[c + 1] && out.length < cap; i++) {
      const start = at.offset + Math.max(0, set.start[i])
      const end = at.offset + Math.min(at.length, set.end[i])
      if (!(end > start)) continue
      out.push({ a0: a0 + start * per, a1: a0 + end * per, index: i })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** One ring, ready to draw. */
export type RingContent =
  | {
      kind: 'values'
      values: BinnedValues
      limits: { min: number; max: number }
      mode: TrackMode
      /** The ramp a heatmap ring is drawn in. */
      colormap: string
      flip: boolean
    }
  | { kind: 'classes'; classes: BinnedClasses }
  | { kind: 'features'; arcs: FeatureArc[] }
  /** Nothing to draw yet, or here: a band, and the reason in the tooltip. */
  | { kind: 'empty'; note: string }

export interface RingPaint {
  id: string
  label: string
  colour: string
  opacity: number
  content: RingContent
}

/**
 * A ring: its band, then its values.
 *
 * The band is the lane's background — a wash over each section's arc, so a ring
 * with nothing in one genome shows the genome empty rather than missing. The
 * values are drawn in the track's own colour and mode, as its lane draws them:
 * bars and areas rise from the inside edge (from the outside, flipped), a line
 * is a line, a heatmap fills the band with its ramp. Categories are runs of
 * their palette's colours, the same colours their lane uses beside the map.
 */
export function paintRing(
  ctx: CanvasRenderingContext2D,
  ring: RingPaint,
  band: { inner: number; outer: number },
  geometry: CircleGeometry,
  bins: CircleBins,
  wash: string,
  dim = false,
): void {
  const { cx, cy } = geometry
  const n = geometry.arcs.length / 2
  ctx.globalAlpha = 1
  ctx.fillStyle = wash
  for (let u = 0; u < n; u++) {
    ctx.beginPath()
    annulusPath(ctx, cx, cy, band.inner, band.outer, geometry.arcs[2 * u], geometry.arcs[2 * u + 1])
    ctx.fill()
  }
  const alpha = Math.max(0.05, Math.min(1, ring.opacity)) * (dim ? 0.3 : 1)
  ctx.globalAlpha = alpha
  const content = ring.content
  const thick = band.outer - band.inner
  if (content.kind === 'values') {
    const { values, limits, mode, flip } = content
    const span = limits.max - limits.min
    const norm = (value: number): number =>
      span > 0 ? Math.max(0, Math.min(1, (value - limits.min) / span)) : 0
    // Where zero is on this axis, for a bar that grows from it.
    const zero = norm(Math.max(limits.min, Math.min(limits.max, 0)))
    const radiusOf = (t: number): number => (flip ? band.outer - t * thick : band.inner + t * thick)
    if (mode === 'heatmap') {
      for (let bin = 0; bin < bins.count; bin++) {
        const value = values.values[bin]
        if (!Number.isFinite(value)) continue
        ctx.fillStyle = colormapCss(content.colormap, norm(value))
        ctx.beginPath()
        wedge(ctx, cx, cy, band.inner, band.outer, bins.a0[bin], bins.a1[bin])
        ctx.fill()
      }
    } else if (mode === 'line') {
      ctx.strokeStyle = ring.colour
      ctx.lineWidth = 1.25
      ctx.lineJoin = 'round'
      forEachRun(bins, values.values, (from, to) => {
        ctx.beginPath()
        for (let bin = from; bin < to; bin++) {
          const r = radiusOf(norm(values.values[bin]))
          const a = (bins.a0[bin] + bins.a1[bin]) / 2
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (bin === from) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      })
    } else if (mode === 'points') {
      ctx.fillStyle = ring.colour
      for (let bin = 0; bin < bins.count; bin++) {
        const value = values.values[bin]
        if (!Number.isFinite(value)) continue
        const r = radiusOf(norm(value))
        const a = (bins.a0[bin] + bins.a1[bin]) / 2
        ctx.beginPath()
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
    } else if (mode === 'bar') {
      ctx.fillStyle = ring.colour
      for (let bin = 0; bin < bins.count; bin++) {
        const value = values.values[bin]
        if (!Number.isFinite(value)) continue
        const t = norm(value)
        const r0 = radiusOf(Math.min(zero, t))
        const r1 = radiusOf(Math.max(zero, t))
        if (Math.abs(r1 - r0) < 0.25) continue
        ctx.beginPath()
        wedge(ctx, cx, cy, Math.min(r0, r1), Math.max(r0, r1), bins.a0[bin], bins.a1[bin])
        ctx.fill()
      }
    } else {
      // `area`, and a `ribbon` drawn alone, which is an area.
      ctx.fillStyle = ring.colour
      forEachRun(bins, values.values, (from, to) => {
        ctx.beginPath()
        const base = radiusOf(zero)
        ctx.moveTo(cx + Math.cos(bins.a0[from]) * base, cy + Math.sin(bins.a0[from]) * base)
        for (let bin = from; bin < to; bin++) {
          const r = radiusOf(norm(values.values[bin]))
          ctx.lineTo(cx + Math.cos(bins.a0[bin]) * r, cy + Math.sin(bins.a0[bin]) * r)
          ctx.lineTo(cx + Math.cos(bins.a1[bin]) * r, cy + Math.sin(bins.a1[bin]) * r)
        }
        ctx.lineTo(cx + Math.cos(bins.a1[to - 1]) * base, cy + Math.sin(bins.a1[to - 1]) * base)
        arcCurve(ctx, cx, cy, base, bins.a1[to - 1], bins.a0[from])
        ctx.closePath()
        ctx.fill()
      })
    }
  } else if (content.kind === 'classes') {
    const { codes } = content.classes
    // One shape per run of a category inside a section, rather than one per
    // bin: the same picture, a tenth of the paths in the figure.
    let bin = 0
    while (bin < bins.count) {
      const code = codes[bin]
      let end = bin + 1
      while (end < bins.count && codes[end] === code && bins.unit[end] === bins.unit[bin]) end++
      if (code >= 0) {
        ctx.fillStyle = categoryColour(code)
        ctx.beginPath()
        annulusPath(ctx, cx, cy, band.inner, band.outer, bins.a0[bin], bins.a1[end - 1])
        ctx.fill()
      }
      bin = end
    }
  } else if (content.kind === 'features') {
    ctx.fillStyle = ring.colour
    const inset = thick * 0.15
    // At least a hair wide, so a gene a fraction of a pixel long is seen.
    const least = 0.6 / Math.max(1, band.outer)
    for (const arc of content.arcs) {
      const a1 = Math.max(arc.a1, arc.a0 + least)
      ctx.beginPath()
      wedge(ctx, cx, cy, band.inner + inset, band.outer - inset, arc.a0, a1)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

/**
 * A thin wedge, its two arcs drawn as chords of the circle.
 *
 * A bin is a degree or less, where the arc and its chord are the same pixel;
 * drawing it straight is four points rather than two curves, and a ring is a few
 * thousand of them.
 */
function wedge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  a0: number,
  a1: number,
): void {
  if (a1 - a0 > 0.05) {
    annulusPath(ctx, cx, cy, inner, outer, a0, a1)
    return
  }
  ctx.moveTo(cx + Math.cos(a0) * inner, cy + Math.sin(a0) * inner)
  ctx.lineTo(cx + Math.cos(a0) * outer, cy + Math.sin(a0) * outer)
  ctx.lineTo(cx + Math.cos(a1) * outer, cy + Math.sin(a1) * outer)
  ctx.lineTo(cx + Math.cos(a1) * inner, cy + Math.sin(a1) * inner)
  ctx.closePath()
}

/** Runs of consecutive bins with a value, inside one section each. */
function forEachRun(bins: CircleBins, values: Float32Array, visit: (from: number, to: number) => void): void {
  let bin = 0
  while (bin < bins.count) {
    if (!Number.isFinite(values[bin])) {
      bin++
      continue
    }
    let end = bin + 1
    while (end < bins.count && Number.isFinite(values[end]) && bins.unit[end] === bins.unit[bin]) end++
    visit(bin, end)
    bin = end
  }
}

/** The bin an angle of a section falls in, or `-1`. */
export function binAt(bins: CircleBins, unit: number, angle: number): number {
  const from = bins.first[unit]
  const to = bins.first[unit + 1]
  // Into the turn the bins are laid out in, which starts just past twelve.
  let a = angle
  if (bins.count > 0) {
    while (a < bins.a0[0]) a += Math.PI * 2
    while (a >= bins.a0[0] + Math.PI * 2) a -= Math.PI * 2
  }
  for (let bin = from; bin < to; bin++) {
    if (a >= bins.a0[bin] && a <= bins.a1[bin]) return bin
  }
  if (to > from) return a < bins.a0[from] ? from : to - 1
  return -1
}

/**
 * Metadata lanes: a column of the file's own tables, resolved into ink (§8.12).
 *
 * Two pictures, because a metadata column is one of two things and drawing both
 * the same way would misrepresent one of them.
 *
 * A **quantitative** column — completeness, contamination, coverage, a bin
 * weight — is a value per unit, and this module contributes only
 * {@link profileFromCells}: it turns one value per axis *cell* into the same
 * one-value-per-pixel {@link PixelProfile} a bigWig is reduced to, and from
 * there `drawTrack` draws it. That is deliberate and it is most of the reason
 * this feature is small: the limits, the autoscale group, the ceiling drag, the
 * flip, the four edges, the figure export and the readout are the ones tracks
 * already have, because it is the same profile going through the same painter.
 *
 * A **qualitative** column — an MGE class, a taxon, a cluster id, a quality
 * call — is not a value at all, and {@link drawCategories} is its own painter.
 * A barplot of a category is a picture of the numbering: it says `plasmid` is
 * twice `phage` because one was written second. So it is drawn as what it is —
 * a run of colour per category, with the name written in the runs wide enough
 * to hold it — and the axis, the limits and the ceiling drag are simply not
 * offered, because there is no value axis to offer them for.
 *
 * The category colours come from a fixed palette rather than from the lane's
 * own colour, and that is the one place these lanes differ from every other
 * annotation in the app. A categorical lane's colours belong to the
 * *categories*: they have to mean the same thing in the lane above the map and
 * the lane down its left-hand side, and a single-colour picker has nothing to
 * say about six of them.
 */

import { laneLine, laneMove, laneRect, laneText, type LaneFrame } from './lane'
import {
  IDENTITY_CELLS,
  unitOfCell,
  type CellScale,
  type MetaCells,
} from '../annotations/metadata'
import type { PixelProfile } from './tracks'

/**
 * The categories' colours, in code order.
 *
 * Okabe–Ito first — the same eight `ANNOTATION_PALETTE` uses, and for the same
 * reason: they stay distinguishable under every common form of colour vision,
 * and a categorical lane is the one place in this app where the colour *is* the
 * data. The four after them are darker variants, reached only by a column with
 * more than eight categories, where nothing is going to be perfectly
 * distinguishable and the goal is that neighbours differ.
 */
export const CATEGORY_PALETTE = [
  '#0072b2', // blue
  '#d55e00', // vermillion
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#e69f00', // orange
  '#56b4e9', // sky blue
  '#f0e442', // yellow
  '#7a7a7a', // grey
  '#004c73',
  '#8c3d00',
  '#00614a',
  '#7d3f66',
] as const

/** The colour of one category, cycled past the end of the palette. */
export function categoryColour(code: number): string {
  if (code < 0) return 'transparent'
  return CATEGORY_PALETTE[code % CATEGORY_PALETTE.length]
}

/**
 * One value per axis cell, reduced to one value per canvas pixel.
 *
 * The same output {@link PixelProfile} `profileOf` produces from bigWig
 * samples, and reduced the same way — span-weighted, so a pixel covering
 * eleven MAGs holds the mean over those eleven and not whichever one happened
 * to be sampled. What is *not* the same is the input: a cell is a unit of the
 * picture rather than an interval of a genome, so there is no contig to resolve
 * and no bp-per-unit to divide by. A cell is the half-open unit interval
 * `[i, i + 1)` in matrix coordinates, which is exactly what the map's own
 * columns are, and that identity is what puts a MAG's contamination bar over
 * the MAG's own column of the matrix.
 *
 * `NaN` cells are gaps and are left as gaps: a genome the table has no row for,
 * a filtered bin whose weight is `NaN`, a run of the axis that is
 * `__unbinned__`. Drawing them at zero would claim a measurement of nothing.
 */
export function profileFromCells(
  frame: LaneFrame,
  cells: Float64Array,
  scale: CellScale = IDENTITY_CELLS,
): PixelProfile {
  const from = Math.floor(frame.alongFrom)
  const slots = Math.max(1, Math.ceil(frame.alongTo) - from)
  const mean = new Float32Array(slots).fill(Number.NaN)
  const low = new Float32Array(slots).fill(Number.NaN)
  const high = new Float32Array(slots).fill(Number.NaN)
  const empty: PixelProfile = { from, mean, low, high, envelope: false, extent: null }
  if (cells.length === 0) return empty

  const sum = new Float64Array(slots)
  const weight = new Float64Array(slots)
  for (let cell = 0; cell < cells.length; cell++) {
    const value = cells[cell]
    if (!Number.isFinite(value)) continue
    let p0 = frame.toPixel(unitOfCell(scale, cell)) - from
    let p1 = frame.toPixel(unitOfCell(scale, cell + 1)) - from
    if (p1 < p0) [p0, p1] = [p1, p0]
    if (p1 <= 0 || p0 >= slots) continue
    if (p0 < 0) p0 = 0
    if (p1 > slots) p1 = slots
    const first = Math.floor(p0)
    const last = Math.min(slots - 1, Math.ceil(p1) - 1)
    for (let slot = first; slot <= last; slot++) {
      const covered = Math.min(p1, slot + 1) - Math.max(p0, slot)
      // A cell narrower than a pixel still owns the pixel it lands in, exactly
      // as a sub-pixel bigWig interval does: at whole-metagenome zoom every
      // cell is a fraction of a pixel, and a weight of its true width would
      // round every one of them to nothing.
      const share = covered > 0 ? covered : 1e-3
      sum[slot] += value * share
      weight[slot] += share
      if (Number.isNaN(low[slot]) || value < low[slot]) low[slot] = value
      if (Number.isNaN(high[slot]) || value > high[slot]) high[slot] = value
    }
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let slot = 0; slot < slots; slot++) {
    if (!(weight[slot] > 0)) continue
    const value = sum[slot] / weight[slot]
    mean[slot] = value
    if (value < min) min = value
    if (value > max) max = value
  }
  return {
    from,
    mean,
    low,
    high,
    // The extremes are the cells' own values rather than a summary of something
    // coarser, so there is no envelope to claim: a band between them would be
    // the same information the means already are wherever a pixel holds one
    // cell, which is most of the time.
    envelope: false,
    extent: min > max ? null : { min, max },
  }
}

export interface CategoryPaint {
  /** Every category's name, indexed by code; the palette is keyed on the same. */
  levels: readonly string[]
  opacity: number
  /** Write the category names into the runs wide enough to hold them. */
  labels: boolean
  font: string
  haloColour: string
  guideColour: string
  /** Draw a rule along the lane's own floor, as a value track does. */
  baseline: boolean
}

/** A run of consecutive cells sharing one category. */
export interface CategoryRun {
  code: number
  /** Half-open, in cells. */
  from: number
  to: number
}

/**
 * The runs of one categorical column, as they will be drawn.
 *
 * Runs rather than cells, and it is not only an optimisation: a run is what the
 * *reader* sees — six contigs in a row called `plasmid` are one plasmid block —
 * and it is the unit a name can be written in. Gaps (`-1`) end a run and are
 * not runs themselves, so a column with no value for a stretch of the axis has
 * nothing drawn there rather than a category called nothing.
 */
export function categoryRuns(codes: Int32Array): CategoryRun[] {
  const runs: CategoryRun[] = []
  let start = -1
  let code = -1
  for (let cell = 0; cell <= codes.length; cell++) {
    const here = cell < codes.length ? codes[cell] : -1
    if (here === code) continue
    if (code >= 0 && start >= 0) runs.push({ code, from: start, to: cell })
    code = here
    start = here >= 0 ? cell : -1
  }
  return runs
}

/**
 * Draw a qualitative column into its lane.
 *
 * The whole thickness of the lane, edge to edge, because a category has no
 * magnitude: a bar of half the height would be read as half of something. The
 * runs butt against each other with no gap, so the boundary between two
 * categories is where the data says it is rather than a pixel to either side of
 * it — which matters at whole-file zoom, where a run is often one pixel wide
 * and a separator would erase it.
 */
export function drawCategories(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  cells: Extract<MetaCells, { kind: 'qualitative' }>,
  paint: CategoryPaint,
  scale: CellScale = IDENTITY_CELLS,
): CategoryRun[] {
  const runs = categoryRuns(cells.codes)
  ctx.save()
  ctx.globalAlpha = paint.opacity
  const drawn: Array<{ run: CategoryRun; from: number; to: number }> = []
  for (const run of runs) {
    let p0 = frame.toPixel(unitOfCell(scale, run.from))
    let p1 = frame.toPixel(unitOfCell(scale, run.to))
    if (p1 < p0) [p0, p1] = [p1, p0]
    if (p1 < frame.alongFrom || p0 > frame.alongTo) continue
    const from = Math.max(p0, frame.alongFrom)
    const to = Math.min(p1, frame.alongTo)
    ctx.fillStyle = categoryColour(run.code)
    const [x, y, width, height] = laneRect(frame, from, to, 0, frame.thickness)
    ctx.fillRect(x, y, width, height)
    drawn.push({ run, from, to })
  }

  if (paint.labels) {
    ctx.font = paint.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = paint.guideColour
    for (const { run, from, to } of drawn) {
      const name = paint.levels[run.code] ?? ''
      if (name === '') continue
      const width = to - from
      // Measured against the run itself: a name that does not fit is left out
      // rather than clipped or condensed to three letters, because a lane of
      // half-written category names is harder to read than a lane of colour
      // with a legend under the pointer.
      const text = ctx.measureText(name).width
      if (text + LABEL_PAD > width) continue
      laneText(ctx, frame, name, (from + to) / 2, frame.thickness / 2, {
        halo: paint.haloColour,
      })
    }
  }

  // The strip's own edge, as a value track draws its floor and under the same
  // preference: it is what tells one lane from the next in a figure, and a
  // categorical strip needs it more than a profile does — a run of pale yellow
  // against the paper has no other edge at all.
  if (paint.baseline) {
    ctx.globalAlpha = 0.75
    ctx.strokeStyle = paint.guideColour
    ctx.lineWidth = 0.75
    ctx.beginPath()
    laneMove(ctx, frame, frame.alongFrom, 0)
    laneLine(ctx, frame, frame.alongTo, 0)
    ctx.stroke()
  }
  ctx.restore()
  return runs
}

/** Room a category name needs beyond its own width, in CSS pixels. */
const LABEL_PAD = 8

/**
 * The category under a point along the lane, for the readout.
 *
 * Takes the runs the paint pass produced rather than recomputing them, exactly
 * as the feature layouts are kept for hit testing (§8.4): the answer a reader
 * gets must come from the thing that was drawn.
 */
export function categoryAt(
  runs: readonly CategoryRun[],
  cell: number,
): CategoryRun | null {
  for (const run of runs) {
    if (cell >= run.from && cell < run.to) return run
  }
  return null
}

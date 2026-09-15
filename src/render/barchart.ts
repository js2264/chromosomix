/**
 * The ink and the proportions of a barChart's glyph (§8.17).
 *
 * The drawing itself is in `render/features.ts`, beside the layout it shares
 * with every other feature lane — this module is the part that is *about*
 * barCharts, which is the same division `render/variants.ts` makes and for the
 * same reason: what is worth reading twice is the rule, not the path-building.
 *
 * ## One colour per category
 *
 * A bar's **position** in the glyph is its identity: the third bar is the third
 * category in every feature on the lane, and that is what a reader follows when
 * they scan a row of charts for the one tissue that is high. Colour is
 * redundancy on top of it, and it is worth having because position alone is
 * hard to hold across the width of a screen.
 *
 * Where the file names its colours (`barChartColors`) those are used and
 * nothing here applies: the file has said what its categories look like, and a
 * GTEx track whose tissue colours are the ones every other GTEx picture uses is
 * worth more than any palette this could impose.
 *
 * Otherwise there are two cases and the line between them is the palette's own
 * length. Up to twelve categories take `CATEGORY_PALETTE` — §8.12's twelve,
 * Okabe–Ito, colour-vision-safe, and the same twelve a metadata strip and a
 * categorical feature colouring use, so one swatch means one thing everywhere
 * in the app. Past twelve they take a `viridis` ramp across their positions
 * instead of the palette cycled, and the reason is that a cycle **invents a
 * pattern**: fifty-four tissues through twelve colours is a repeating rhythm
 * across every glyph on the lane, which reads as structure in the data and is
 * structure in the palette. A ramp says only *where in the list*, which is the
 * one thing that is actually true of a category with no name.
 */

import type { BarScale } from '../annotations/fields'
import type { BarChartBars } from '../annotations/types'
import { DEFAULT_HEATMAP_LANE_COLORMAP } from '../annotations/types'
import { colormapCss } from './colormaps'
import { CATEGORY_PALETTE } from './meta'

/**
 * The shortest row that is still a chart, in pixels.
 *
 * Below this a bar's height is not a reading: at eight pixels a value at a
 * tenth of the ceiling and a value at a fifth are the same one pixel of ink, so
 * the glyph claims a precision the picture cannot carry. A lane too short for
 * one row of this height still draws — see {@link barChartRows} — because
 * "nothing at all" is worse than "a rough chart", but it is never given two.
 */
export const BAR_MIN_ROW = 18

/**
 * The narrowest one bar is drawn, in pixels, before the glyph gives up on bars.
 *
 * Under one pixel a bar is not narrow, it is *absent* — the canvas rounds it
 * away or antialiases it into its neighbour — and a chart missing half its
 * categories is a different chart. At that point the glyph becomes a single
 * box instead, which is a claim the picture can keep.
 */
export const BAR_MIN_WIDTH = 1

/** Space between two bars, in pixels, wherever there is room for it. */
export const BAR_GAP = 1

/**
 * How many rows of charts a lane of this thickness can hold.
 *
 * Its own rule rather than `rowsThatFit`, which measures the height a row needs
 * to carry a **name under a feature** — the right question for a gene track and
 * the wrong one here, where the row's height *is* the data's axis. A lane that
 * packed a chart into eleven pixels to fit more of them on screen would have
 * spent the measurement to buy the arrangement.
 *
 * Always at least one: a lane the reader has dragged down to sixteen pixels
 * gets a rough chart rather than an empty lane, and the way to a better one is
 * the drag they already know.
 */
export function barChartRows(thickness: number, maxRows: number): number {
  return Math.max(1, Math.min(maxRows, Math.floor(thickness / BAR_MIN_ROW)))
}

/**
 * A colour per category, in column order.
 *
 * Computed once per draw rather than per bar: a lane of four hundred glyphs
 * over fifty-four categories asks this twenty-one thousand times a frame, and
 * `colormapCss` builds a string.
 */
export function barColours(bars: BarChartBars): string[] {
  const width = bars.labels.length
  if (bars.colours.length === width) return bars.colours
  if (width <= CATEGORY_PALETTE.length) {
    return Array.from({ length: width }, (_, at) => CATEGORY_PALETTE[at])
  }
  return Array.from({ length: width }, (_, at) =>
    colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, at / (width - 1)),
  )
}

/**
 * The line under a barChart lane's label: what the top of a bar means.
 *
 * The one thing a reader cannot get from the picture. Every chart on the lane
 * is drawn against the same ceiling, so stating it once under the label is not
 * a compromise for want of room — it is where the fact belongs, and it is why
 * the glyphs carry no axis of their own (§8.17).
 *
 * `num` is passed in because this module is free of the DOM and of the
 * formatting settings that live there, and the caller already holds `fmt`.
 */
export function barChartCaption(
  bars: BarChartBars,
  num: (value: number) => string,
  scale: BarScale = 'file',
): string {
  // Per feature there is no one number to print, and printing the file's would
  // be a caption for a picture that is not on screen.
  if (scale === 'feature') return 'bars to each feature’s own top'
  const unit = bars.unit === '' ? '' : ` ${bars.unit}`
  return `bars to ${num(bars.max)}${unit}`
}

/**
 * Which category feature `index`'s tallest bar belongs to, or `-1` for a row
 * that carries no chart.
 *
 * What the glyph collapses *to* when there is no room to draw bars, and the
 * same reading UCSC's own renderer makes at that zoom: one box in the colour of
 * the category that dominates the row. A row with no values at all has no
 * dominant category and must not be given one — it draws in the lane's own
 * colour, which everywhere in this application means *no answer*.
 */
export function dominantOf(bars: BarChartBars, index: number): number {
  const width = bars.labels.length
  const from = index * width
  let best = -1
  let peak = Number.NEGATIVE_INFINITY
  for (let at = 0; at < width; at++) {
    const value = bars.values[from + at]
    if (!Number.isFinite(value) || value <= peak) continue
    peak = value
    best = at
  }
  return best
}

/**
 * The tallest value on feature `index`, or `NaN` where it carries no chart.
 *
 * The height the collapsed box is drawn at, so that a lane zoomed out to
 * single-pixel features still says *how much* as well as *which* — the two
 * facts a chart carries, kept as long as there are pixels for either.
 */
export function peakOf(bars: BarChartBars, index: number): number {
  const at = dominantOf(bars, index)
  return at < 0 ? Number.NaN : bars.values[index * bars.labels.length + at]
}

/**
 * The words a runner puts on a lane.
 *
 * Four tasks name their output after a distance — `Insulation · 10 kb`,
 * `DI · 2 Mb`, `HiC score · 200 kb`, the scalogram's quantiles — and a reader
 * comparing two lanes in one stack reads those labels as numbers, so two that
 * disagree about whether 1,500,000 bp is `1.5 Mb` or `1500 kb` are two lanes
 * that look like they were computed by different tools.
 *
 * Which is why the spelling is not here either. `src/units.ts` holds one
 * formatter per quantity and imports nothing, so a worker prints what a card
 * prints (§26.2) — a window of *n* bins at the file's bin size is a round number
 * by construction, which is exactly what `resolutionLabel` is for, and this
 * module had its own copy of that arithmetic.
 *
 * Not `src/format.ts`, which is the Python-repr module the CLI command builder
 * uses, and not `ui/labels.ts`, which is main-thread and names the DOM.
 */

import type { ScaledAxis } from '../types'
import { fmt, resolutionLabel } from '../../units'

/** `2 Mb`, `10 kb`, `500 bp` — a distance, as a lane is labelled with one. */
export function formatBp(bp: number): string {
  return resolutionLabel(bp)
}

/**
 * `-21 kb`, `0`, `+10.5 kb` — a **signed** distance, as a pileup's axis is
 * labelled.
 *
 * The sign is written out on both ends rather than left to the minus, because
 * the thing the label says is *which side of the anchor*, and a bare `21 kb`
 * opposite a `-21 kb` reads as a magnitude rather than as a position.
 */
export function formatOffset(bp: number): string {
  const rounded = Math.round(bp)
  if (rounded === 0) return '0'
  return `${rounded < 0 ? '-' : '+'}${formatBp(Math.abs(rounded))}`
}

/**
 * Five labels along a pileup's axis, as distances from its middle.
 *
 * **Base pairs, never bins.** A pileup is a picture of a window of the genome
 * and the reader's question of it is *how far from the anchor is that* — which
 * a count of bins answers only for somebody holding the resolution in their
 * head, and differently at every resolution. `± 21 kb` is the same statement
 * on a 1 kb map and on a 5 kb one.
 *
 * Positions **along the axis**, evenly spaced, with the ends at the ends: that
 * is what a `MatrixOutput`'s tick list means where it is shorter than the axis
 * (`figures/matrixOption.spreadTicks`, `ui/analysisPlots.tickFractions`), and
 * taking the labelled *cells'* offsets instead would round the quarter points
 * to whole bins and put `-10 kb` opposite `+11 kb` on a symmetric window.
 */
export function offsetTicks(cells: number, binsize: number): string[] {
  if (!(cells > 0) || !(binsize > 0)) return []
  const half = ((cells - 1) / 2) * binsize
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => formatOffset(-half + fraction * 2 * half))
}


/**
 * A position along a scaled-region abscissa, as its ticks and its pointer
 * spell it: `Start` and `End` at the body's edges, the share of the way
 * through the body between them — `50%` — and outside them a signed distance
 * **from the nearer of the two**, `-1 kb` before the start and `+1 kb` after
 * the end, as deepTools labels the same plot.
 *
 * From the edge rather than from the window's end because that is the question
 * a reader asks of a flank — *how far upstream of the gene is that dip* — and
 * the start and the end are the only two points every feature in the set has.
 * A whole share is printed without places and any other with one, so the ticks
 * read `25%` and the pointer `37.4%`.
 */
export function scaledLabel(axis: ScaledAxis, x: number): string {
  if (!Number.isFinite(x)) return ''
  const near = 1e-9 * Math.max(1, Math.abs(axis.to - axis.from))
  if (Math.abs(x - axis.start) <= near) return 'Start'
  if (Math.abs(x - axis.end) <= near) return 'End'
  if (x < axis.start) return formatOffset((x - axis.start) * axis.flankStep)
  if (x > axis.end) return formatOffset((x - axis.end) * axis.flankStep)
  const share = (x - axis.start) / (axis.end - axis.start)
  const per = share * 100
  return fmt.pct(share, Math.abs(per - Math.round(per)) < 1e-6 ? 0 : 1)
}

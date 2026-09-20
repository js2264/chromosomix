/**
 * The words a runner puts on a lane.
 *
 * One function, and it is here rather than repeated because four tasks name
 * their output after a distance — `Insulation · 10 kb`, `DI · 2 Mb`,
 * `HiC score · 200 kb`, the scalogram's quantiles — and four copies of the same
 * three lines is four chances for one of them to round differently from the
 * others. A reader comparing two lanes in the same stack reads the labels as
 * numbers, and two labels that disagree about whether 1,500,000 bp is `1.5 Mb`
 * or `1500 kb` are two lanes that look like they were computed by different
 * tools.
 *
 * Not `src/format.ts`, which is the Python-repr module the CLI command builder
 * uses, and not `ui/labels.ts`, which is main-thread and names the DOM.
 */

/** `2 Mb`, `10 kb`, `500 bp` — a distance, as a lane is labelled with one. */
export function formatBp(bp: number): string {
  if (bp >= 1e6) return `${trim(bp / 1e6)} Mb`
  if (bp >= 1e3) return `${trim(bp / 1e3)} kb`
  return `${Math.round(bp)} bp`
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

/** Two decimals at most, and no trailing zeros: `1.5`, not `1.50`. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)))
}

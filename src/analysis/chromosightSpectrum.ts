/**
 * How a chromosight pileup is drawn, written once.
 *
 * `plotting.pileup_plot` is four arguments long and every one of them is part of
 * the result: `cmap="seismic"`, `vmin=0.0`, `vmax=2.0`, `interpolation="none"`.
 * The first three are here; the fourth is what `render/heatmap.ts` does anyway,
 * because a pileup cell is a cell and smoothing between them is inventing data.
 *
 * The **fixed** range is the part that matters and the part an autoscaling
 * viewer gets wrong. These are enrichments over a distance-detrended map, so 1
 * is "as expected" and the scale is symmetric about it by construction rather
 * than by fitting: a pileup running from 0.98 to 1.02 and one running from 0 to
 * 4 would otherwise be the same picture in the same colours, and the difference
 * between them is the entire result. Two runs on two files are comparable
 * because the scale did not move.
 *
 * Shared by the detector's own pileup and by the APA task's chromosight mode, so
 * the two produce the same picture from the same numbers — which is the point of
 * having both.
 */

/** Bottom of the scale: `pileup_plot`'s `vmin`. */
export const CHROMOSIGHT_VMIN = 0

/** Top of the scale: `pileup_plot`'s `vmax`. Twice the expected contact. */
export const CHROMOSIGHT_VMAX = 2

/** The colour scale and the range, spread into a `MatrixOutput`. */
export const CHROMOSIGHT_SPECTRUM: {
  colormap: string
  centre: number
  range: [number, number]
} = {
  colormap: 'seismic',
  centre: 1,
  range: [CHROMOSIGHT_VMIN, CHROMOSIGHT_VMAX],
}

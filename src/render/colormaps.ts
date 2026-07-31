/**
 * Colormaps, mirroring matplotlib's lookup semantics exactly.
 *
 * Spec §7.1: the same file must produce the same picture in the CLI and the
 * browser. Two things have to match for that, and both live here:
 *
 * 1. the *table* — {@link ./luts} holds matplotlib's own 256-entry RGB arrays,
 *    dumped rather than approximated;
 * 2. the *indexing* — `matplotlib.colors.Colormap.__call__` is `floor(t * N)`
 *    with `t == 1` folded down to `N - 1`, out-of-range values clamped to the
 *    end colours (`set_under`/`set_over` default to the extremes), and
 *    non-finite values sent to the "bad" colour, which is transparent by
 *    default. {@link colormapIndex} reproduces that arithmetic; a naive
 *    `Math.round(t * 255)` disagrees with matplotlib on roughly half of all
 *    inputs and shifts the whole image by half a colour step.
 */

import { AFMHOT_R_RGB, AFMHOT_RGB, CIVIDIS_RGB, MAGMA_RGB, VIRIDIS_RGB } from './luts'

/** Entries in every table. matplotlib's default `N` for all five colormaps. */
export const COLORMAP_SIZE = 256

/** The `metacooler show` default (`ops/show.py`, `cmap: str = "afmhot_r"`). */
export const DEFAULT_COLORMAP = 'afmhot_r'

/**
 * Flat RGB triples, keyed by matplotlib name. Insertion order is the order the
 * UI offers them in, so the default comes first and the two colour-vision-safe
 * options are not buried at the bottom.
 */
const RGB_TABLES: Record<string, readonly number[]> = {
  afmhot_r: AFMHOT_R_RGB,
  afmhot: AFMHOT_RGB,
  cividis: CIVIDIS_RGB,
  viridis: VIRIDIS_RGB,
  magma: MAGMA_RGB,
}

/** Every colormap the viewer offers, in the order the picker should list them. */
export const COLORMAP_NAMES: string[] = Object.keys(RGB_TABLES)

/**
 * Colormaps that stay monotonic in perceived lightness for the common forms of
 * colour-vision deficiency (spec §7.2). `cividis` is the one designed for it;
 * `viridis` and `magma` are perceptually uniform and survive deuteranopia and
 * protanopia, so they are listed too. `afmhot`/`afmhot_r` are *not* — they are
 * offered because they are the CLI default, not because they are safe.
 */
export const COLOR_VISION_SAFE_COLORMAPS: string[] = ['cividis', 'viridis', 'magma']

/**
 * Expanded RGBA tables, built once per name. The expansion is 1 KB per
 * colormap, but `rasterize` runs it over every cell of the matrix, so the
 * allocation must not sit inside that loop.
 */
const RGBA_CACHE = new Map<string, Uint8ClampedArray>()

/** `true` if `name` is a colormap this build knows about. */
export function isColormap(name: string): boolean {
  return Object.hasOwn(RGB_TABLES, name)
}

/**
 * The 256-entry RGBA lookup table for `name`, as 1024 `Uint8ClampedArray`
 * bytes in `r, g, b, a` order — the layout `ImageData` wants, so the raster
 * loop is four copies with no arithmetic.
 *
 * The returned array is cached and shared. Treat it as read-only; mutating it
 * corrupts every subsequent render.
 *
 * @throws RangeError if `name` is not one of {@link COLORMAP_NAMES}.
 */
export function applyColormap(name: string): Uint8ClampedArray {
  const cached = RGBA_CACHE.get(name)
  if (cached !== undefined) return cached

  const rgb = RGB_TABLES[name]
  if (rgb === undefined) {
    throw new RangeError(
      `Unknown colormap: '${name}'. Available: ${COLORMAP_NAMES.join(', ')}.`
    )
  }

  const rgba = new Uint8ClampedArray(COLORMAP_SIZE * 4)
  for (let i = 0; i < COLORMAP_SIZE; i++) {
    rgba[i * 4] = rgb[i * 3]
    rgba[i * 4 + 1] = rgb[i * 3 + 1]
    rgba[i * 4 + 2] = rgb[i * 3 + 2]
    // Uniform 255 in all five matplotlib tables; verified when luts.ts was
    // generated, which is why the literals carry only RGB.
    rgba[i * 4 + 3] = 255
  }
  RGBA_CACHE.set(name, rgba)
  return rgba
}

/**
 * Table index for a value already normalised to `[0, 1]` by
 * `(v - vmin) / (vmax - vmin)`.
 *
 * Verbatim `Colormap.__call__`: multiply by `N`, truncate, fold `N` back to
 * `N - 1` so an exactly-`vmax` cell lands on the last colour rather than off
 * the end, and clamp the out-of-range tails onto the end colours (matplotlib's
 * `_i_under`/`_i_over` default to `lut[0]` and `lut[N - 1]`).
 *
 * @returns `-1` for a non-finite value — matplotlib's "bad" colour, which is
 * fully transparent by default. NaN reaching here is not a bug: it is an
 * unbalanced row, and rendering it blank is the correct, diagnostic result
 * (spec §6.4).
 */
export function colormapIndex(t: number): number {
  if (!Number.isFinite(t)) return -1
  const i = Math.floor(t * COLORMAP_SIZE)
  if (i < 0) return 0
  if (i >= COLORMAP_SIZE) return COLORMAP_SIZE - 1
  return i
}

/**
 * The RGBA colour at normalised position `t`, as four 0–255 components.
 * Convenience for swatches and legends; the raster path indexes the table
 * directly instead.
 *
 * A non-finite `t` yields a fully transparent colour, matching
 * {@link colormapIndex}.
 */
export function colormapColor(name: string, t: number): [number, number, number, number] {
  const lut = applyColormap(name)
  const i = colormapIndex(t)
  if (i < 0) return [0, 0, 0, 0]
  return [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2], lut[i * 4 + 3]]
}

/** The colour at normalised position `t` as a CSS `rgb()` string, for DOM swatches. */
export function colormapCss(name: string, t: number): string {
  const [r, g, b, a] = colormapColor(name, t)
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a / 255})`
}

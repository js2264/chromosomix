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

/** Entries in every table. matplotlib's default `N`, and the viewer's own. */
export const COLORMAP_SIZE = 256

/** The `metacooler show` default (`ops/show.py`, `cmap: str = "afmhot_r"`). */
export const DEFAULT_COLORMAP = 'afmhot_r'

/**
 * What the viewer opens with, which is deliberately not the CLI's.
 *
 * The same split as `DEFAULT_UI_PLOT_OPTIONS` beside `DEFAULT_PLOT_OPTIONS`:
 * `afmhot_r` is right for a figure that has to match `metacooler show` byte for
 * byte and is still one item away in the picker, unchanged; `default` is the
 * ramp a Hi-C map is usually read in. Nothing about parity moves — the choice
 * is carried in the hash like any other, and asking for `afmhot_r` produces the
 * identical image it always did.
 */
export const DEFAULT_UI_COLORMAP = 'default'

/**
 * The viewer's own ramp: near-white through yellow, orange and red to
 * near-black, from thirteen stops interpolated to 256 entries.
 *
 * Not a matplotlib map, so unlike the tables in {@link ./luts} it is built here
 * rather than dumped — there is nothing upstream to copy. The interpolation is
 * `LinearSegmentedColormap.from_list`'s: the stops are spaced evenly over
 * `[0, 1]` and each channel is linear between them, so the same list handed to
 * matplotlib reproduces this table to within a rounding step.
 *
 * Its relative luminance falls monotonically across all thirteen stops (0.99 →
 * 0.005), which is what makes it read as a sequential ramp rather than as a set
 * of hues; it is not in {@link COLOR_VISION_SAFE_COLORMAPS} because it was not
 * designed against a deficiency model, only measured for lightness.
 */
const DEFAULT_STOPS = [
  '#FFFEF9', '#FCF9CE', '#FFF2A9', '#FDE188', '#FFCA67', '#FAAA4B', '#F78E40',
  '#F15C34', '#ED3024', '#D42027', '#B01F29', '#7A1128', '#1A0A10',
]

/**
 * `Reds`: **paper white**, then ColorBrewer's sequential red to a dark maroon.
 *
 * The eight stops after the first are ColorBrewer's nine-class red — the
 * control-point list matplotlib holds for this name — minus its lowest, which is
 * `#FFF5F0`: a pale pink, not white. On a contact map that is the wrong colour
 * for the commonest value in the picture. Most of a Hi-C matrix is empty, so a
 * map drawn on matplotlib's ramp is a sheet of faint pink with the data on it,
 * and the eye reads the tint as signal until it works out that it is everywhere.
 * An empty cell should be the paper.
 *
 * So the bottom of the ramp is `#FFFFFF` and the rest is the classic one. This
 * is therefore the viewer's ramp under matplotlib's name, and the difference is
 * worth stating: `metacooler show --cmap Reds` draws the same map with a
 * slightly warmer floor. It is a floor rather than a hue — the two agree from a
 * ninth of the way up — but §7.1's parity claim covers the tables dumped in
 * {@link ./luts}, and this is not one of them.
 */
const REDS_STOPS = [
  '#FFFFFF', '#FFF5F0', '#FEE0D2', '#FCBBA1', '#FC9272', '#FB6A4A', '#EF3B2C',
  '#CB181D', '#A50F15', '#67000D',
]

/**
 * `RdBu_r`: ColorBrewer's eleven-class red–blue, reversed, for the values that
 * have a **middle** rather than a floor.
 *
 * Every other ramp in this file is sequential, because every value the viewer
 * could draw until now was a count and a count has a bottom. A ratio does not:
 * it has a neutral point, and twice and half are the same size of departure in
 * opposite directions. Drawn on a sequential ramp, "the two files agree" is some
 * arbitrary mid-tone with no edge to it, and the eye — which finds a hue
 * boundary instantly and a lightness step slowly — has nothing to find.
 *
 * Reversed, so **red is more and blue is less**. That is the direction every
 * Hi-C tool draws a log ratio in, and getting it backwards would be the kind of
 * error that never announces itself.
 *
 * The centre stop is `#F7F7F7` rather than `#FFFFFF`: unlike `Reds`, the middle
 * of a diverging map is not the empty background but a real reading — "measured,
 * and equal" — and it has to be distinguishable from the paper a `NaN` leaves
 * behind. `render/derive.ts` produces `NaN` for exactly the cells where no
 * comparison could be made, and those two must not look the same.
 *
 * Not in {@link COLOR_VISION_SAFE_COLORMAPS}, and not because it is unsafe: that
 * list's criterion is monotonic lightness, which a diverging map is built to
 * violate — its lightness peaks in the middle by design. Red against blue is the
 * one hue pair that survives the common deficiencies, which is why ColorBrewer
 * marks this scheme colour-blind safe, and the lightness ramp within each arm
 * carries the magnitude even where the hue does not.
 */
const RDBU_R_STOPS = [
  '#053061', '#2166AC', '#4393C3', '#92C5DE', '#D1E5F0', '#F7F7F7', '#FDDBC7',
  '#F4A582', '#D6604D', '#B2182B', '#67001F',
]

/** Interpolate hex stops to a flat `size * 3` RGB table, as the tables are. */
function rampFromStops(stops: readonly string[], size: number): number[] {
  const points = stops.map((hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ])
  const last = points.length - 1
  const out: number[] = new Array<number>(size * 3)
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * last
    const lo = Math.min(Math.floor(t), last - 1)
    const frac = t - lo
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(points[lo][c] + (points[lo + 1][c] - points[lo][c]) * frac)
    }
  }
  return out
}

/**
 * Flat RGB triples, keyed by name. Insertion order is the order the UI offers
 * them in, so the default comes first and the colour-vision-safe options are
 * not buried at the bottom.
 */
const RGB_TABLES: Record<string, readonly number[]> = {
  default: rampFromStops(DEFAULT_STOPS, COLORMAP_SIZE),
  afmhot_r: AFMHOT_R_RGB,
  afmhot: AFMHOT_RGB,
  Reds: rampFromStops(REDS_STOPS, COLORMAP_SIZE),
  cividis: CIVIDIS_RGB,
  viridis: VIRIDIS_RGB,
  magma: MAGMA_RGB,
  RdBu_r: rampFromStops(RDBU_R_STOPS, COLORMAP_SIZE),
}

/** Every colormap the viewer offers, in the order the picker should list them. */
export const COLORMAP_NAMES: string[] = Object.keys(RGB_TABLES)

/**
 * The ramps built for a value with a neutral middle, and the one a derived map
 * opens on.
 *
 * A list rather than a single name because the set is what the *picker* needs:
 * choosing a sequential ramp for a ratio is a legitimate thing to want — it is
 * how you read the magnitude of a departure without its direction — so nothing
 * here forbids it. What the panel does with this is pick the opening colormap
 * when a derivation is switched on, and put it back when it is switched off, so
 * that a reader who never touches the control is never shown a ratio on a ramp
 * that cannot express one.
 */
export const DIVERGING_COLORMAPS: string[] = ['RdBu_r']

/** What a derived map with a neutral value opens on. */
export const DEFAULT_DIVERGING_COLORMAP = 'RdBu_r'

/** Whether `name` is one of the ramps built around a middle. */
export function isDivergingColormap(name: string): boolean {
  return DIVERGING_COLORMAPS.includes(name)
}

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
    // Uniform 255 in every matplotlib table; verified when luts.ts was
    // generated, which is why the literals carry only RGB. The viewer's own
    // ramp is opaque for the same reason: transparency here would be read as
    // "no data", which is what the NaN path already means.
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
